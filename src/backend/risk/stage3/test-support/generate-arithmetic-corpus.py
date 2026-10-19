"""Independent S3-04 oracle: only CPython Fraction/float/struct, never Node.

Regenerate with --output PATH; --check PATH verifies fixed golden bytes.
No environment, clock, network or production arithmetic is consulted.
Float(Fraction) supplies CPython's correctly rounded binary64 conversion;
zero/overflow are classified separately according to the publication contract.
Resource limits are checked on raw inputs and reduced Fraction components.
"""
import argparse
import json
import random
import struct
from fractions import Fraction
from pathlib import Path

BITS = 4096


def pair(value):
    return [str(value.numerator), str(value.denominator)]


def bits(value):
    return struct.pack('>d', value).hex()


def number(encoded):
    return struct.unpack('>d', bytes.fromhex(encoded))[0]


def fits(value):
    return abs(value.numerator).bit_length() <= BITS and value.denominator.bit_length() <= BITS


def publication(value):
    if not fits(value):
        return 'NUMERIC_RESOURCE_LIMIT'
    try:
        rounded = float(value)
    except OverflowError:
        return 'NUMERIC_OVERFLOW'
    if rounded == 0 and value:
        return 'NUMERIC_UNDERFLOW'
    return bits(rounded if rounded else 0.0)


def corpus():
    rng = random.Random(304)
    encoded = ['0000000000000000', '8000000000000000', '0000000000000001',
               '8000000000000001', '000fffffffffffff', '0010000000000000',
               '7fefffffffffffff', 'ffefffffffffffff', '3fb999999999999a',
               bits(float(2**53-1)), bits(float(-(2**53-1)))]
    while len(encoded) < 91:
        raw = rng.getrandbits(64)
        if raw >> 52 & 2047 != 2047:
            encoded.append(f'{raw:016x}')
    decodes = [{'bits': raw, 'exact': pair(Fraction.from_float(number(raw)))} for raw in encoded]
    operations = []
    for _ in range(160):
        a = Fraction.from_float(number(rng.choice(encoded)))
        b = Fraction.from_float(number(rng.choice(encoded)))
        for op in ['add', 'subtract', 'multiply', 'divide']:
            if op == 'divide' and not b:
                result = None
                error = 'division_by_zero'
            else:
                result = {'add': lambda: a+b, 'subtract': lambda: a-b,
                          'multiply': lambda: a*b, 'divide': lambda: a/b}[op]()
                error = None if fits(result) else 'resource_limit'
            operations.append({'op': op, 'a': pair(a), 'b': pair(b),
                               'exact': pair(result) if result is not None and error is None else None,
                               'error': error, 'order': (a > b) - (a < b),
                               'published': publication(result) if result is not None and error is None else None})
    # Normal/subnormal ties in both signs; normal carry, normal/subnormal seam,
    # underflow midpoint, overflow midpoint and their immediately adjacent rationals.
    fractions = [Fraction(0), Fraction(1, 3), Fraction(-1, 3)]
    for lower in ['0000000000000000', '0000000000000001', '0000000000000002',
                  '000fffffffffffff', '0010000000000000', '3fefffffffffffff',
                  '3ff0000000000000', '3ff0000000000001', '7feffffffffffffe']:
        low = Fraction.from_float(number(lower))
        high = Fraction.from_float(number(f'{int(lower, 16)+1:016x}'))
        midpoint = (low+high)/2
        delta = (high-low)/2**60
        for value in [midpoint-delta, midpoint, midpoint+delta, low, high]:
            fractions.extend([value, -value])
    max_value = Fraction.from_float(number('7fefffffffffffff'))
    midpoint = max_value + 2**970
    fractions.extend([max_value, midpoint-1, midpoint, midpoint+1,
                      -midpoint, Fraction(1, 2**1076), Fraction(1, 2**1075),
                      Fraction(3, 2**1076), Fraction(2**1024), Fraction(2**4095),
                      Fraction(1, 2**4095)])
    for _ in range(180):
        n = rng.getrandbits(rng.randint(1, 4096)) * rng.choice([-1, 1])
        d = rng.getrandbits(rng.randint(1, 4096)) or 1
        fractions.append(Fraction(n, d))
    publications = [{'exact': pair(value), 'published': publication(value)} for value in fractions]
    raw_pairs = [(0, 1), (0, -12), (6, -8), (-6, -8), (1, 0), (0, 0),
                 (2**4096-1, 1), (2**4096, 1), (1, 2**4096-1),
                 (1, 2**4096), (2**4096, 2**4096), (0, 2**4096)]
    constructors = []
    for n, d in raw_pairs:
        error = 'resource_limit' if max(abs(n).bit_length(), abs(d).bit_length()) > BITS else (
            'division_by_zero' if d == 0 else None)
        constructors.append({'raw': [str(n), str(d)], 'exact': None if error else pair(Fraction(n, d)), 'error': error})
    # Large coprime inputs: result limits and large scratch products that cancel.
    large = Fraction(2**4095-1, 2**4095-2)
    for a, b, op in [(large, large, 'multiply'), (large, large, 'divide'),
                     (large, -large, 'add'), (large, -large, 'subtract')]:
        result = {'multiply': lambda: a*b, 'divide': lambda: a/b,
                  'add': lambda: a+b, 'subtract': lambda: a-b}[op]()
        error = None if fits(result) else 'resource_limit'
        operations.append({'op': op, 'a': pair(a), 'b': pair(b), 'exact': None if error else pair(result),
                           'error': error, 'order': (a>b)-(a<b), 'published': None if error else publication(result)})
    return {'version': 'python-fraction-s3-04/1', 'seed': 304, 'decodes': decodes,
            'operations': operations, 'publications': publications, 'constructors': constructors}


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--output', type=Path)
    group.add_argument('--check', type=Path)
    args = parser.parse_args()
    data = corpus()
    rendered = json.dumps(data, ensure_ascii=True, indent=2) + '\n'
    if args.output:
        args.output.write_text(rendered, encoding='utf-8', newline='\n')
    else:
        assert args.check.read_text(encoding='utf-8') == rendered, 'Golden corpus differs'
    print('PASS', {key: len(data[key]) for key in ['decodes', 'operations', 'publications', 'constructors']})


if __name__ == '__main__':
    main()
