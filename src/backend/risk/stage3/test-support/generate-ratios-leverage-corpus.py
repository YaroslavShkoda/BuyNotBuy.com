"""Independent Fraction oracle for S3-07, with explicit denominator domains.
No production helpers or prior generators. Actual binary64 input bit patterns,
exact fractions, domain refusals, resource policy and publications are separate.
All scripts/regeneration are explicit. Fixed seed 307.
"""
import argparse
import json
import random
import struct
from collections import Counter
from fractions import Fraction as F
from pathlib import Path

MAX = 0x7fefffffffffffff
ONE = 0x3ff0000000000000
SEED = 307


def number(raw):
    return struct.unpack('>d', struct.pack('>Q', raw))[0]


def bits(value):
    return struct.pack('>d', value).hex()


def pair(value):
    return [str(value.numerator), str(value.denominator)]


def fits(value):
    return max(abs(value.numerator).bit_length(), value.denominator.bit_length()) <= 4096


def unavailable(status, reason):
    return {'status': status, 'bits': None, 'reasons': [reason]}


def publication(value):
    try:
        rounded = float(value)
    except OverflowError:
        return unavailable('calculation_error', 'NUMERIC_OVERFLOW')
    if value and rounded == 0:
        return unavailable('calculation_error', 'NUMERIC_UNDERFLOW')
    return {'status': 'valid', 'bits': bits(rounded if rounded else 0.), 'reasons': []}


def division(numerator, denominator, reason):
    if denominator <= 0:
        return {'exact': {'status': 'not_applicable', 'reasons': [reason]},
                'published': unavailable('not_applicable', reason)}
    value = numerator/denominator
    if not fits(value):
        return {'exact': {'status': 'calculation_error', 'reasons': ['NUMERIC_RESOURCE_LIMIT']},
                'mathematical': pair(value), 'published': unavailable('calculation_error', 'NUMERIC_RESOURCE_LIMIT')}
    return {'exact': {'status': 'valid', 'parts': pair(value), 'reasons': []}, 'published': publication(value)}


def corpus(random_pairs):
    rng = random.Random(SEED)
    u, maximum, next_one = number(1), number(MAX), number(ONE+1)
    fixed = [
        ('positive-domain', 2., 8., 8., 4., .25, .125),
        ('zero-equity-zero-cash', 1., 1., 1., 0., .5, .25),
        ('zero-equity-positive-cash', 2., 3., 1., 4., .5, .25),
        ('negative-equity-positive-cash', 2., 3., 1., 1., .5, .25),
        ('zero-cash-positive-equity', 2., 1., 2., 0., .5, .25),
        ('positive-equity-unpublished-underflow', .5, 2*u, u, u, 1., .5),
        ('positive-equity-unpublished-overflow', 2., u, maximum, maximum, 1., .75),
        ('all-publications-overflow', maximum, maximum, maximum, u, 1., .5),
        ('tiny-numerators-big-equity', u, u, u, maximum, 1., .5),
        ('real-ratio-resource-limit', u, u, u, maximum, 2*u, u),
        ('entry-native-product-overflow', maximum, maximum, maximum, maximum, 1., .5),
        ('entry-native-product-underflow', u, u, u, u, 1., .5),
        ('ratio-underflow-other-metrics-valid', 1., 1., 1., 3., 2*u, u),
        ('one-third', 1., 1., 1., 3., .5, .25),
        ('cancelled-equity-2^-104', next_one, 2., next_one, 1., .5, .25),
        ('equity-rounds-but-exact-domain-positive', 1., .5, 1., u, .75, .5),
        ('normal-tie-odd-lower', next_one, 1.5, 1.5, 1., 1., .5),
        ('normal-tie-even-lower', number(ONE+3), 1.5, 1.5, 1., 1., .5),
        ('subnormal-tie-odd-lower', .5, 3*u, 3*u, 1., 1., .5),
        ('subnormal-tie-even-lower', .5, 5*u, 5*u, 1., 1., .5),
        ('signed-zero-cash', 1., 1., 1., -0., 1., .5),
        ('decimal-binary64', .1, .2, .3, .4, .2, .1),
        ('near-unit-rate', 1., 1., 1., 1., 1., number(ONE-1)),
        ('rates-adjacent-small', 2., 3., 4., 1., 3*u, 2*u),
    ]
    rows = []

    def append(name, q, e, p, cash, i, m):
        fq, fe, fp, fc, fi, fm = map(F.from_float, [q, e, p, cash, i, m])
        assert fq > 0 and fe > 0 and fp > 0 and fc >= 0 and 0 < fm < fi <= 1
        for side in ['LONG', 'SHORT']:
            equity = fc + fq*(fp-fe)*(1 if side == 'LONG' else -1)
            n, mm, entry = fq*fp, fm*fq*fp, fq*fe
            assert all(fits(value) for value in [equity, n, mm, entry])
            metrics = {'R': division(mm, equity, 'NON_POSITIVE_EQUITY'),
                       'L': division(n, equity, 'NON_POSITIVE_EQUITY'),
                       'LE': division(entry, fc, 'ZERO_COLLATERAL')}
            if equity > 0:
                assert mm/equity > 0 and n/equity > 0 and (mm/equity)/(n/equity) == fm
            witnesses = []
            if equity > 0 and publication(equity)['status'] == 'valid':
                eq_rounded = F.from_float(number(int(publication(equity)['bits'], 16)))
                for key, numerator in [('R', mm), ('L', n)]:
                    pub = publication(numerator)
                    expected = metrics[key]['published']
                    if pub['status'] == 'valid' and expected['status'] == 'valid':
                        from_published = F.from_float(number(int(pub['bits'], 16)))/eq_rounded
                        if publication(from_published) != expected:
                            witnesses.append(key)
            rows.append({'name': name+'-'+side, 'side': side,
                         'inputs': {key: bits(value) for key, value in zip(['q', 'e', 'p', 'cash', 'i', 'm'], [q, e, p, cash, i, m])},
                         'entryNotional': pair(entry), 'equity': {'parts': pair(equity), 'published': publication(equity)},
                         'metrics': metrics, 'doubleRoundingWitnesses': witnesses})

    for row in fixed:
        append(*row)
    for index in range(random_pairs):
        q, e, p = (number(rng.randint(1, MAX)) for _ in range(3))
        cash = 0. if index % 5 == 0 else number(rng.randint(1, MAX))
        m, i = map(number, sorted(rng.sample(range(1, ONE+1), 2)))
        if index % 5 == 1:
            p = e
        if index % 5 == 2:
            p = number(max(1, min(MAX, int(bits(e), 16)+rng.choice([-1, 1]))))
        if index % 6 == 0:
            i, m = 2*u, u
        if index % 5 == 3:
            loss = abs(F.from_float(q)*(F.from_float(p)-F.from_float(e)))
            pub = publication(loss)
            if pub['status'] == 'valid':
                cash = number(max(0, min(MAX, int(pub['bits'], 16)+rng.choice([-1, 0, 1]))))
        append(f'random-{index}', q, e, p, cash, i, m)
    return {'version': 'python-fraction-ratios-leverage/1', 'seed': SEED, 'randomPairs': random_pairs, 'cases': rows}


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--output', type=Path)
    group.add_argument('--check', type=Path)
    parser.add_argument('--random-pairs', type=int, default=64)
    args = parser.parse_args()
    assert args.random_pairs >= 0
    data = corpus(args.random_pairs)
    rendered = json.dumps(data, ensure_ascii=True, indent=2)+'\n'
    if args.output:
        args.output.write_text(rendered, encoding='utf8', newline='\n')
    else:
        assert args.check.read_text(encoding='utf8') == rendered, 'Golden corpus differs'
    outcomes = {key: dict(Counter(row['metrics'][key]['published']['reasons'][0] if row['metrics'][key]['published']['reasons'] else 'finite'
                                  for row in data['cases'])) for key in ['R', 'L', 'LE']}
    print(json.dumps({'seed': SEED, 'cases': len(data['cases']), 'outcomes': outcomes,
                      'doubleRoundingWitnesses': sum(bool(row['doubleRoundingWitnesses']) for row in data['cases'])}))


if __name__ == '__main__':
    main()
