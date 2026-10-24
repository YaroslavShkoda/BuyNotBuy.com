"""Standalone S3-09 Fraction oracle. No production or prior generator imports.
Computes the exact liquidation boundary root, verifies H(p*)=0 and the exact
sign of H on each side of the root with symbolic deltas, and publishes the root
with an independent integer round-half-even implementation. Boundary verdicts
follow the approved BoundaryValue contract kinds only.
"""
import argparse
import json
import math
import random
import struct
from collections import Counter
from fractions import Fraction as F
from pathlib import Path

SEED = 309
MAX = 0x7FEFFFFFFFFFFFFF
MINR = 0x0010000000000000
ONE = 0x3FF0000000000000
PROOF = 'flat-linear-long-cash-ge-entry-notional@1'


def number(raw):
    return struct.unpack('>d', struct.pack('>Q', raw))[0]


def bits(value):
    return struct.pack('>d', value).hex()


def fits(value):
    return max(abs(value.numerator).bit_length(), value.denominator.bit_length()) <= 4096


def publication(value):
    """Independent round-half-even to binary64. Returns {'status','bits','reasons'}."""
    if value == 0:
        return {'status': 'valid', 'bits': '0000000000000000', 'reasons': []}
    sign = 1 if value < 0 else 0
    mag = -value if sign else value
    n, d = mag.numerator, mag.denominator
    e0 = n.bit_length() - d.bit_length()
    if e0 >= 0:
        if n < (d << e0):
            e0 -= 1
    else:
        if (n << -e0) < d:
            e0 -= 1
    if e0 > 1023:
        return {'status': 'calculation_error', 'bits': None, 'reasons': ['NUMERIC_OVERFLOW']}
    if e0 < -1075:
        return {'status': 'calculation_error', 'bits': None, 'reasons': ['NUMERIC_UNDERFLOW']}
    qt = max(e0 - 52, -1074)
    if qt < 0:
        nn, dd = (n << -qt), d
    else:
        nn, dd = n, (d << qt)
    s, rem = divmod(nn, dd)
    twice = rem * 2
    if twice > dd or (twice == dd and (s & 1) == 1):
        s += 1
    if s == 0:
        return {'status': 'calculation_error', 'bits': None, 'reasons': ['NUMERIC_UNDERFLOW']}
    if s == (1 << 53) and qt == 971:
        return {'status': 'calculation_error', 'bits': None, 'reasons': ['NUMERIC_OVERFLOW']}
    if s == (1 << 53):
        e0 += 1
        s = 1 << 52
    if e0 >= -1022:
        exp_field = e0 + 1023
        mant = s - (1 << 52)
    else:
        exp_field = 0
        mant = s
    raw = (sign << 63) | (exp_field << 52) | mant
    return {'status': 'valid', 'bits': f'{raw:016x}', 'reasons': []}


def root_of(side, q, e, cash, m):
    qe = q * e
    if side == 'LONG':
        numerator = qe - cash
        denominator = q * (1 - m)
        if numerator <= 0:
            return None
    else:
        numerator = qe + cash
        denominator = q * (1 + m)
    assert denominator > 0
    assert numerator > 0
    return numerator / denominator


def h_at(side, q, e, cash, m, price):
    if side == 'LONG':
        return cash - q * e + q * (1 - m) * price
    return cash + q * e - q * (1 + m) * price


def sign(value):
    return (value > 0) - (value < 0)


def probe_bits(root):
    pub = publication(root)
    if pub['status'] != 'valid':
        return None
    raw = int(pub['bits'], 16)
    if F.from_float(number(raw)) != root:
        return None
    up = raw + 1
    down = raw - 1
    return {'up': f'{up:016x}' if up <= MAX else None,
            'down': f'{down:016x}' if down >= MINR else None}


def selftest(runs=2000):
    rng = random.Random(777)
    for _ in range(runs):
        v = F(rng.getrandbits(rng.randrange(1, 400)) or 1, rng.getrandbits(rng.randrange(1, 400)) or 1)
        got = publication(v)
        try:
            fv = float(v)
        except OverflowError:
            fv = float('inf') if v > 0 else float('-inf')
        if fv == 0.0:
            assert got == {'status': 'calculation_error', 'bits': None, 'reasons': ['NUMERIC_UNDERFLOW']}
        elif fv in (float('inf'), float('-inf')):
            assert got == {'status': 'calculation_error', 'bits': None, 'reasons': ['NUMERIC_OVERFLOW']}
        else:
            assert got == {'status': 'valid', 'bits': bits(fv), 'reasons': []}


def case_rows(name, q, e, p, cash, i, m):
    fq, fe, fp, fc, fi, fm = map(F.from_float, [q, e, p, cash, i, m])
    assert fq > 0 and fe > 0 and fp > 0 and fc >= 0 and 0 < fm < fi <= 1
    root = root_of('LONG', fq, fe, fc, fm)
    root_short = root_of('SHORT', fq, fe, fc, fm)
    rows = []
    for side, exact_root in (('LONG', root), ('SHORT', root_short)):
        h_current = h_at(side, fq, fe, fc, fm, fp)
        equity = fc + fq * (fp - fe) * (1 if side == 'LONG' else -1)
        maintenance = fm * fq * fp
        relation = sign(equity - maintenance)
        assert relation == sign(h_current)
        state = {-1: 'below_threshold', 0: 'at_threshold', 1: 'above_threshold'}[relation]
        if exact_root is None:
            assert side == 'LONG' and fq * fe - fc <= 0
            assert relation == 1
            exact = {'kind': 'none', 'proofId': PROOF}
            pub = None
        else:
            assert h_at(side, fq, fe, fc, fm, exact_root) == 0
            for delta in (F(1), F(1, 3), F(1, 2) ** 300, exact_root / 2):
                low = exact_root - delta
                if low > 0:
                    expected_low = -1 if side == 'LONG' else 1
                    assert sign(h_at(side, fq, fe, fc, fm, low)) == expected_low
                expected_high = 1 if side == 'LONG' else -1
                assert sign(h_at(side, fq, fe, fc, fm, exact_root + delta)) == expected_high
            assert fits(exact_root)
            pub = publication(exact_root)
            exact = {'kind': 'root', 'parts': [str(exact_root.numerator), str(exact_root.denominator)],
                     'probe': probe_bits(exact_root)}
        verdicts = {}
        for mode in ('lt', 'lte'):
            detected = relation < 0 if mode == 'lt' else relation <= 0
            if detected:
                boundary = {'status': 'valid', 'value': {'kind': 'already_breached'}}
            elif exact_root is None:
                boundary = {'status': 'valid', 'value': {'kind': 'unreachable', 'path': 'long_price_decrease',
                                                         'domain': 'positive_real_prices', 'proofId': PROOF}}
            elif pub['status'] == 'valid':
                boundary = {'status': 'valid', 'kind': 'boundary', 'bits': pub['bits'],
                            'triggers': mode == 'lte',
                            'path': 'long_price_decrease' if side == 'LONG' else 'short_price_increase'}
            else:
                boundary = {'status': 'calculation_error', 'reasons': pub['reasons']}
            verdicts[mode] = {'detected': detected, 'boundary': boundary}
        rows.append({'name': f'{name}-{side}', 'side': side, 'relation': relation, 'state': state,
                     'inputs': {key: bits(value) for key, value in zip(['q', 'e', 'p', 'cash', 'i', 'm'],
                                                                      [q, e, p, cash, i, m])},
                     'exact': exact, 'verdicts': verdicts})
    return rows


def corpus(random_pairs):
    rng = random.Random(SEED)
    u = number(1)
    maximum = number(MAX)
    fixed = [
        ('long-below-root', 2., 8., 10., 0., .5, .25),
        ('long-above-root', 2., 8., 12., 0., .5, .25),
        ('zero-root-flat', 3., 5., 7., 15., .75, .5),
        ('over-flat', 2., 8., 11., 20., .5, .25),
        ('short-safe', 2., 8., 7., 2., .5, .25),
        ('threshold-tie-up', 4., 8., 13.5, 5., .75, .5),
        ('threshold-tie-down', 4., 8., 13., 7., .75, .5),
        ('native-difference', 1., 1., 1., 1., .2, .1),
        ('decimal-binary64', .1, .2, .3, .4, .2, .1),
        ('adjacent-one-rate', 1., 1., 1., 1., 1., number(ONE - 1)),
    ]
    entry_notional = F.from_float(maximum) * F.from_float(u)
    underflow_cash = float(entry_notional - (F(1, 2) ** 102))
    assert F.from_float(underflow_cash) == entry_notional - (F(1, 2) ** 102)
    fixed.append(('root-underflow', maximum, u, u, underflow_cash, 1., u))
    fixed.append(('root-overflow', u, maximum, maximum, 0., 1., u))
    fixed.append(('pin-a', 2., 8., 9., 3., .75, .5))
    fixed.append(('pin-b', 2., 8., 40., 3., .75, .5))
    rows = []
    for row in fixed:
        rows.extend(case_rows(*row))
    for j in range(random_pairs):
        q, e, p = (number(rng.randrange(1, MAX + 1)) for _ in range(3))
        cash = [0., u, number(rng.randrange(0, MAX + 1))][j % 3]
        m, i = map(number, sorted(rng.sample(range(1, ONE + 1), 2)))
        if j % 5 == 0:
            p = e
        if j % 7 == 3:
            q, e, p = number(rng.randrange(1, MINR + 64)), number(rng.randrange(1, MINR + 64)), u
        if j % 11 == 5:
            i = 1.
        rows.extend(case_rows(f'random-{j}', q, e, p, cash, i, m))
    return {'version': 'python-fraction-liquidation-boundary/1', 'seed': SEED,
            'randomPairs': random_pairs, 'cases': rows}


def main():
    parser = argparse.ArgumentParser()
    selftest()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--output', type=Path)
    group.add_argument('--check', type=Path)
    parser.add_argument('--random-pairs', type=int, default=64)
    args = parser.parse_args()
    assert args.random_pairs >= 0
    data = corpus(args.random_pairs)
    rendered = json.dumps(data, ensure_ascii=True, indent=2) + '\n'
    if args.output:
        args.output.write_text(rendered, encoding='utf8', newline='\n')
    else:
        assert args.check.read_text(encoding='utf8') == rendered, 'Golden corpus differs'
    kinds = Counter()
    for row in data['cases']:
        for mode in ('lt', 'lte'):
            boundary = row['verdicts'][mode]['boundary']
            key = boundary.get('value', {}).get('kind') if boundary['status'] == 'valid' else boundary['reasons'][0]
            kinds[key] += 1
    print(json.dumps({'seed': SEED, 'cases': len(data['cases']), 'relations': dict(
        Counter(row['relation'] for row in data['cases'])), 'boundaryKinds': dict(kinds)}))


if __name__ == '__main__':
    main()
