"""S3-05 independent Fraction oracle; no production or Node imports.

All q/e/p/C inputs are actual binary64 values, encoded as exact 16-digit hex
bit patterns. Exact rational results and their independent publications are
recorded separately. Regeneration is explicit; tests only read the corpus.
"""
import argparse
import json
import random
import struct
from collections import Counter
from fractions import Fraction
from pathlib import Path

SEED = 305


def bits(value):
    return struct.pack('>d', value).hex()


def number(raw):
    return struct.unpack('>d', bytes.fromhex(raw))[0]


def pair(value):
    return [str(value.numerator), str(value.denominator)]


def publish(value):
    try:
        rounded = float(value)
    except OverflowError:
        return {'error': 'NUMERIC_OVERFLOW'}
    if value and rounded == 0:
        return {'error': 'NUMERIC_UNDERFLOW'}
    return {'bits': bits(rounded if rounded else 0.0)}


def corpus(random_pairs):
    rng = random.Random(SEED)
    rows = []
    minimum = number('0000000000000001')
    maximum = number('7fefffffffffffff')
    next_one = number('3ff0000000000001')
    fixed = [
        ('profit', 3.0, 100.0, 125.0, 10.0),
        ('loss', 3.0, 125.0, 100.0, 10.0),
        ('break-even', maximum, minimum, minimum, 0.0),
        ('zero-cash', 2.0, 10.0, 11.0, 0.0),
        ('equity-zero', 2.0, 3.0, 1.0, 4.0),
        ('negative-equity', 2.0, 3.0, 1.0, 1.0),
        ('min-quantity', minimum, 1.0, 2.0, 0.0),
        ('pnl-underflow', minimum, minimum, 2*minimum, 0.0),
        ('pnl-half-min-equity-subnormal-tie', 0.5, minimum, 2*minimum, minimum),
        ('pnl-underflow-equity-normal', minimum, minimum, 2*minimum, 1.0),
        ('pnl-overflow-equity-finite', 2.0, maximum, 1.0, maximum),
        ('pnl-positive-overflow', maximum, 1.0, maximum, 0.0),
        ('pnl-max-equity-overflow', maximum, 1.0, 2.0, maximum),
        ('max-equity-cancellation', maximum, 2.0, 1.0, maximum),
        ('rounded-pnl-destroys-equity', next_one, 2.0, next_one, 1.0),
        ('decimal-binary64', 0.1, 0.2, 0.3, 0.4),
        ('safe-integer', float(2**53-1), 1.0, next_one, float(2**53-1)),
        ('signed-zero-cash', 1.0, 1.0, 1.0, -0.0),
        ('normal-subnormal-seam', 0.5, number('000fffffffffffff'), number('0010000000000000'), minimum),
        ('close-large-prices', minimum, number('7feffffffffffffe'), maximum, 1.0),
    ]

    def add(name, q, e, p, cash):
        fq, fe, fp, fc = map(Fraction.from_float, [q, e, p, cash])
        assert fq > 0 and fe > 0 and fp > 0 and fc >= 0
        for side in ['LONG', 'SHORT']:
            pnl = fq*(fp-fe) * (1 if side == 'LONG' else -1)
            equity = fc+pnl
            # Explicitly check every exact step against the unchanged kernel's
            # documented component policy, rather than assuming publishability.
            for value in [fq, fe, fp, fc, fp-fe, pnl, equity]:
                assert max(abs(value.numerator).bit_length(), value.denominator.bit_length()) <= 4096
            rows.append({'name': name+'-'+side, 'side': side,
                         'input': {key: bits(value) for key, value in zip(['q', 'e', 'p', 'cash'], [q, e, p, cash])},
                         'pnl': {'exact': pair(pnl), 'published': publish(pnl)},
                         'equity': {'exact': pair(equity), 'published': publish(equity)}})

    for row in fixed:
        add(*row)

    def positive():
        while True:
            raw = rng.getrandbits(63)
            if 0 < raw < 0x7ff0000000000000:
                return number(f'{raw:016x}')

    for index in range(random_pairs):
        q, e, p, cash = positive(), positive(), positive(), positive()
        if index % 5 == 0:
            p = e
        if index % 5 == 1:
            raw = int(bits(e), 16)
            p = number(f'{min(raw+1, 0x7fefffffffffffff):016x}')
        if index % 5 == 2:
            cash = 0.0
        if index % 5 == 3:
            # Cancellation of exact, unpublished PnL with finite collateral.
            pnl = Fraction.from_float(q)*(Fraction.from_float(p)-Fraction.from_float(e))
            if pnl < 0 and 'bits' in publish(-pnl):
                cash = number(publish(-pnl)['bits'])
        add(f'random-{index}', q, e, p, cash)
    return {'version': 'python-fraction-pnl-equity/1', 'seed': SEED, 'randomPairs': random_pairs, 'cases': rows}


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--output', type=Path)
    group.add_argument('--check', type=Path)
    parser.add_argument('--random-pairs', type=int, default=160)
    args = parser.parse_args()
    assert args.random_pairs >= 0
    data = corpus(args.random_pairs)
    rendered = json.dumps(data, ensure_ascii=True, indent=2)+'\n'
    if args.output:
        args.output.write_text(rendered, encoding='utf-8', newline='\n')
    else:
        assert args.check.read_text(encoding='utf8') == rendered, 'Golden corpus differs'
    counts = {metric: dict(Counter(row[metric]['published'].get('error', 'finite') for row in data['cases']))
              for metric in ['pnl', 'equity']}
    print(json.dumps({'seed': SEED, 'cases': len(data['cases']), 'outcomes': counts}))


if __name__ == '__main__':
    main()
