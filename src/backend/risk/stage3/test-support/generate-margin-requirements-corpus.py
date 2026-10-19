"""Independent S3-06 Fraction oracle, never importing Node/production helpers.
Expected mathematical fractions, resource-policy results and publications are
separate. N has no public contract field and is recorded as exact-only.
Regeneration is explicit; all inputs are binary64 bit patterns. Seed 306.
"""
import argparse
import json
import random
import struct
from collections import Counter
from fractions import Fraction as F
from pathlib import Path

SEED = 306
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
    try:
        rounded = float(value)
    except OverflowError:
        return {'error': 'NUMERIC_OVERFLOW'}
    if value and rounded == 0:
        return {'error': 'NUMERIC_UNDERFLOW'}
    return {'bits': bits(rounded if rounded else 0.0)}


def corpus(random_pairs):
    rng = random.Random(SEED)
    minimum, maximum, next_one = number(1), number(MAX), number(ONE+1)
    # q,e,p,C,i,m. Every row is evaluated for BOTH LONG and SHORT.
    fixed = [
        ('positive-buffer-surplus', 2., 8., 8., 6., .25, .125),
        ('zero-collateral', 2., 8., 8., 0., .25, .125),
        ('equity-equals-MM', 2., 8., 8., 2., .25, .125),
        ('equity-equals-IM', 2., 8., 8., 4., .25, .125),
        ('zero-equity', 2., 9., 8., 2., .25, .125),
        ('negative-equity', 2., 9., 8., 1., .25, .125),
        ('rates-near-one', 1., 1., 1., 1., 1., number(ONE-1)),
        ('rates-near-zero', 1., 1., 1., 1., 2*minimum, minimum),
        ('rates-adjacent', 1., 1., 1., .5, number(0x3fe0000000000001), .5),
        ('notional-native-underflow', minimum, minimum, minimum, 0., .5, .25),
        ('notional-native-overflow-margins-finite', maximum, 2., 2., maximum, .25, .125),
        ('unpublishable-margins-finite-buffers', 2., maximum, maximum, maximum, 1., .75),
        ('overflowing-IM-zero-buffer', 2., maximum, maximum, maximum, 1., .5),
        ('published-equity-loses-surplus', 1., minimum, 1., 0., 1., .5),
        ('published-equity-loses-buffer', 1., .5, 1., minimum, .75, .5),
        ('published-IM-loses-surplus', next_one, next_one, next_one, 1+2**-51, 1., .5),
        ('published-MM-loses-buffer', next_one, next_one, next_one, .5+2**-52, 1., .5),
        ('pnl-overflow-equity-finite', 2., maximum, 1., maximum, .5, .25),
        ('pnl-underflow-equity-finite', .5, minimum, 2*minimum, minimum, .5, .25),
        ('zero-equity-cancellation-small', next_one, 2., next_one, 1., 2**-104, 2**-105),
        ('real-resource-both-differences', minimum, minimum, minimum, maximum, 2*minimum, minimum),
        ('real-resource-buffer-only', minimum, minimum, minimum, maximum, 1., minimum),
        ('resource-boundary-4095', minimum, minimum, minimum, 2.**873, 2*minimum, minimum),
        ('resource-boundary-4096', minimum, minimum, minimum, 2.**874, 2*minimum, minimum),
        ('resource-boundary-4097', minimum, minimum, minimum, 2.**875, 2*minimum, minimum),
        ('resource-boundary-4098', minimum, minimum, minimum, 2.**876, 2*minimum, minimum),
        ('decimal-binary64', .1, .2, .3, .4, .2, .1),
        ('signed-zero-cash', 1., 1., 1., -0., 1., .5),
    ]
    rows = []

    def append(name, q, e, p, cash, i, m):
        fq, fe, fp, fc, fi, fm = map(F.from_float, [q, e, p, cash, i, m])
        assert fq > 0 and fe > 0 and fp > 0 and fc >= 0 and 0 < fm < fi <= 1
        for side in ['LONG', 'SHORT']:
            pnl = fq*(fp-fe)*(1 if side == 'LONG' else -1)
            equity = fc+pnl
            assert fits(pnl) and fits(equity)  # S3-05 policy for these inputs.
            n = fq*fp
            im, mm = fi*n, fm*n
            h, a = equity-mm, equity-im
            values = dict(N=n, IM=im, MM=mm, H=h, A=a)
            errors = {key: not fits(value) for key, value in values.items()}
            errors['IM'] |= errors['N']
            errors['MM'] |= errors['N']
            errors['H'] |= errors['MM']
            errors['A'] |= errors['IM']
            metrics = {}
            for key, value in values.items():
                exact = {'error': 'NUMERIC_RESOURCE_LIMIT', 'mathematical': pair(value)} if errors[key] else {'parts': pair(value)}
                metrics[key] = {'exact': exact}
                if key != 'N':
                    metrics[key]['published'] = {'error': 'NUMERIC_RESOURCE_LIMIT'} if errors[key] else publication(value)
            assert 0 < mm < im and a == h-(im-mm)
            rows.append(dict(name=name+'-'+side, side=side,
                             inputs={key: bits(value) for key, value in zip(['q', 'e', 'p', 'cash', 'i', 'm'], [q, e, p, cash, i, m])},
                             equity=pair(equity), metrics=metrics))

    for row in fixed:
        append(*row)
    for index in range(random_pairs):
        q, e, p = (number(rng.randint(1, MAX)) for _ in range(3))
        cash = number(rng.randint(1, MAX)) if index % 3 else 0.
        if index % 4 == 0:
            p = e
        if index % 4 == 1:
            p = number(min(MAX, int(bits(e), 16)+1))
        rates = sorted(rng.sample(range(1, ONE+1), 2))
        m, i = map(number, rates)
        if index % 6 == 0:
            i, m = 2*minimum, minimum
        if index % 6 == 1:
            i, m = 1., number(ONE-1)
        if index % 4 == 2:
            loss = abs(F.from_float(q)*(F.from_float(p)-F.from_float(e)))
            published = publication(loss)
            if 'bits' in published:
                cash = number(int(published['bits'], 16))
        append(f'random-{index}', q, e, p, cash, i, m)
    return dict(version='python-fraction-margin-requirements/1', seed=SEED, randomPairs=random_pairs, cases=rows)


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
    outcomes = {key: dict(Counter(row['metrics'][key]['published'].get('error', 'finite') for row in data['cases']))
                for key in ['IM', 'MM', 'H', 'A']}
    print(json.dumps(dict(seed=SEED, cases=len(data['cases']), outcomes=outcomes)))


if __name__ == '__main__':
    main()
