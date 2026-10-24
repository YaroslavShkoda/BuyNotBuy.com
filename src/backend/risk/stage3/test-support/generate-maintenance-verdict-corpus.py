"""Standalone S3-08 Fraction oracle. No production or prior generator imports.
Exact comparison, H resource policy, publication prerequisites and public verdict
are distinct. Rounding is certified by exact distances to neighboring binary64.
"""
import argparse
import json
import math
import random
import struct
from collections import Counter
from fractions import Fraction as F
from pathlib import Path

SEED = 308
MAX = 0x7fefffffffffffff
ONE = 0x3ff0000000000000


def number(raw):
    return struct.unpack('>d', struct.pack('>Q', raw))[0]


def bits(value):
    return struct.pack('>d', value).hex()


def pair(value):
    return [str(value.numerator), str(value.denominator)]


def fits(value):
    return max(abs(value.numerator).bit_length(), value.denominator.bit_length()) <= 4096


def publication(value):
    if not value:
        return {'status': 'valid', 'bits': '0000000000000000', 'reasons': []}
    magnitude = abs(value)
    if magnitude >= F.from_float(number(MAX)) + F(2)**970:
        return {'status': 'calculation_error', 'bits': None, 'reasons': ['NUMERIC_OVERFLOW']}
    try:
        estimate = float(magnitude)
    except OverflowError:
        estimate = number(MAX)
    center = MAX if math.isinf(estimate) else int(bits(estimate), 16)
    low, high = max(0, center-1), min(MAX, center+1)
    candidates = [(raw, F.from_float(number(raw))) for raw in range(low, high+1)]
    assert candidates[0][1] <= magnitude
    assert magnitude <= candidates[-1][1] or high == MAX
    raw, _ = min(candidates, key=lambda item: (abs(item[1]-magnitude), item[0] & 1))
    if raw == 0:
        return {'status': 'calculation_error', 'bits': None, 'reasons': ['NUMERIC_UNDERFLOW']}
    if value < 0:
        raw |= 1 << 63
    return {'status': 'valid', 'bits': f'{raw:016x}', 'reasons': []}


def source(value):
    if not fits(value):
        return {'exact': {'status': 'calculation_error', 'reasons': ['NUMERIC_RESOURCE_LIMIT'], 'mathematical': pair(value)},
                'published': {'status': 'calculation_error', 'bits': None, 'reasons': ['NUMERIC_RESOURCE_LIMIT']}}
    return {'exact': {'status': 'valid', 'parts': pair(value), 'reasons': []}, 'published': publication(value)}


def corpus(random_pairs):
    rng = random.Random(SEED)
    u, maximum, next_one = number(1), number(MAX), number(ONE+1)
    scale = 2.**-1000
    fixed = [
        ('above', 2., 8., 8., 6., .25, .125),
        ('equal', 2., 8., 8., 2., .25, .125),
        ('below', 2., 8., 8., 1., .25, .125),
        ('zero-equity', 2., 9., 8., 2., .25, .125),
        ('negative-equity', 2., 9., 8., 1., .25, .125),
        ('zero-cash', 1., 1., 1., 0., .5, .25),
        ('positive-H-underflow-equal-publications', .5, 3*u, 3*u, u, 1., .5),
        ('negative-H-underflow-equal-publications', .5, 5*u, 5*u, u, 1., .5),
        ('positive-subnormal-H', 1., .5, 1., u, .75, .5),
        ('negative-subnormal-H', 1., 1., 1., u, 3*u, 2*u),
        ('H-overflow-publishable-prerequisites', 2., maximum, maximum/2, 0., 1., .5),
        ('E-underflow-MM-finite', next_one, 2*scale, next_one*scale, scale, 1., .5),
        ('E-overflow-MM-finite', 2., u, maximum, maximum, 1., .125),
        ('MM-overflow-E-finite', 2., maximum, maximum, maximum, 1., .75),
        ('E-MM-overflow', 4., u, maximum, 0., 1., .75),
        ('MM-underflow-E-finite', u, u, u, 1., 1., .5),
        ('E-MM-underflow', .5, 2*u, u, u, 1., .5),
        ('PnL-overflow-E-finite', 2., maximum, 1., maximum, .5, .25),
        ('IM-overflow-equality', 2., maximum, maximum, maximum, 1., .5),
        ('H-resource-limit', u, u, u, maximum, 2*u, u),
        ('H-4095-bits', u, u, u, 2.**873, 2*u, u),
        ('H-4096-bits', u, u, u, 2.**874, 2*u, u),
        ('H-4097-bits', u, u, u, 2.**875, 2*u, u),
        ('equal-rounded-different-exact-negative', next_one, next_one, next_one, .5+2**-52, 1., .5),
        ('native-difference-rounded', 1., 1., 1., 1., .2, .1),
        ('decimal-binary64', .1, .2, .3, .4, .2, .1),
        ('signed-zero-cash', 1., 1., 1., -0., 1., .5),
        ('adjacent-one-rate', 1., 1., 1., 1., 1., number(ONE-1)),
    ]
    rows = []

    def append(name, q, e, p, cash, i, m):
        fq, fe, fp, fc, fi, fm = map(F.from_float, [q, e, p, cash, i, m])
        assert fq > 0 and fe > 0 and fp > 0 and fc >= 0 and 0 < fm < fi <= 1
        for side in ['LONG', 'SHORT']:
            equity = fc + fq*(fp-fe)*(1 if side == 'LONG' else -1)
            mm = fm*fq*fp
            h = equity-mm
            assert fits(equity) and fits(mm)
            sources = {key: source(value) for key, value in [('E', equity), ('MM', mm), ('H', h)]}
            sign = (h > 0)-(h < 0)
            assert sign == ((equity > mm)-(equity < mm))
            verdicts = {}
            for mode in ['lt', 'lte']:
                exact = {'status': 'valid', 'value': {
                    'exactRelation': {-1: 'negative', 0: 'zero', 1: 'positive'}[sign],
                    'comparison': mode,
                    'state': {-1: 'below_threshold', 0: 'at_threshold', 1: 'above_threshold'}[sign],
                    'detected': sign < 0 if mode == 'lt' else sign <= 0}, 'reasons': []}
                reasons = list(dict.fromkeys(sources[key]['published']['reasons'][0]
                                            for key in ['E', 'MM'] if sources[key]['published']['reasons']))
                public = {'status': 'calculation_error', 'value': None, 'reasons': reasons} if reasons else exact
                verdicts[mode] = {'exact': exact, 'public': public}
            assert not verdicts['lt']['exact']['value']['detected'] or verdicts['lte']['exact']['value']['detected']
            rows.append({'name': name+'-'+side, 'side': side,
                         'inputs': {key: bits(value) for key, value in zip(['q', 'e', 'p', 'cash', 'i', 'm'], [q, e, p, cash, i, m])},
                         'sources': sources, 'verdicts': verdicts})

    for row in fixed:
        append(*row)
    for j in range(random_pairs):
        q, e, p, cash = (number(rng.randrange(1, MAX+1)) for _ in range(4))
        m, i = map(number, sorted(rng.sample(range(1, ONE+1), 2)))
        if j % 5 == 0:
            p = e
        if j % 5 == 1:
            p = number(max(1, min(MAX, int(bits(e), 16)+rng.choice([-1, 1]))))
        if j % 5 == 2:
            cash = 0.
        if j % 5 == 3:
            q, e, p, cash = 1., 1., 1., m  # Exact E=MM, both sides.
        if j % 7 == 0:
            i, m = 2*u, u
        append(f'random-{j}', q, e, p, cash, i, m)
    return {'version': 'python-fraction-maintenance-verdict/1', 'seed': SEED, 'randomPairs': random_pairs, 'cases': rows}


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
    print(json.dumps({'seed': SEED, 'cases': len(data['cases']),
                      'relations': dict(Counter(r['verdicts']['lt']['exact']['value']['exactRelation'] for r in data['cases'])),
                      'public': dict(Counter(r['verdicts']['lt']['public']['status'] for r in data['cases'])),
                      'H_resource': sum(r['sources']['H']['exact']['status'] != 'valid' for r in data['cases'])}))


if __name__ == '__main__':
    main()
