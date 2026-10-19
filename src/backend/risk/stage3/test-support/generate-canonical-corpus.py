"""Independent fixed vectors. No Node, production imports or production hashes.

The selected binary64 vectors use CPython's shortest repr, reformatted to the
ECMAScript fixed/scientific thresholds. This is a fixed-corpus oracle, not a
claim that CPython and ECMAScript choose identical digits for every binary64.
Run explicitly with --output; tests only read the committed JSON corpus.
"""
import argparse
import copy
import hashlib
import json
import math
from pathlib import Path


def quote(text):
    units = text.encode('utf-16-be', errors='surrogatepass')
    result = '"'
    for offset in range(0, len(units), 2):
        unit = int.from_bytes(units[offset:offset + 2], 'big')
        if unit in (34, 92):
            result += '\\' + chr(unit)
        elif unit < 32 or unit > 126:
            result += '\\u%04x' % unit
        else:
            result += chr(unit)
    return result + '"'


def number(value):
    if not math.isfinite(value):
        raise ValueError('finite numbers only')
    if value == 0:
        return '0'
    if isinstance(value, int):
        assert abs(value) <= 9007199254740991
        return str(value)
    sign = '-' if value < 0 else ''
    coefficient, _, exp = repr(abs(value)).lower().partition('e')
    integer, _, fraction = coefficient.partition('.')
    digits = (integer + fraction).rstrip('0')
    point = len(integer) + (int(exp) if exp else 0)
    while digits.startswith('0'):
        digits = digits[1:]
        point -= 1
    exponent = point - 1
    if -6 <= exponent < 21:
        if point <= 0:
            return sign + '0.' + '0' * (-point) + digits
        if point >= len(digits):
            return sign + digits + '0' * (point - len(digits))
        return sign + digits[:point] + '.' + digits[point:]
    mantissa = digits[0] + ('.' + digits[1:] if len(digits) > 1 else '')
    return sign + mantissa + 'e' + ('+' if exponent >= 0 else '-') + str(abs(exponent))


def canonical(value):
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, (int, float)):
        return number(value)
    if isinstance(value, str):
        return quote(value)
    if isinstance(value, list):
        return '[' + ','.join(map(canonical, value)) + ']'
    keys = sorted(value, key=lambda key: key.encode('utf-16-be', errors='surrogatepass'))
    return '{' + ','.join(quote(key) + ':' + canonical(value[key]) for key in keys) + '}'


def digest(domain, text):
    prefix = ('BuyNotBuy\0margin-canonical-json/1\0' + domain + '\0').encode('ascii')
    return hashlib.sha256(prefix + text.encode('ascii')).hexdigest()


def base():
    return {
        'snapshot': {
            'schemaVersion': 'margin-model-snapshot/1',
            'source': {'kind': 'manual', 'reference': 'corpus-record'},
            'snapshotId': 'snapshot-1', 'positionId': 'position-1', 'asOf': 1700000000000,
            'instrument': {'instrumentId': 'linear-model', 'contractKind': 'linear_perp',
                           'baseCurrency': 'BASE', 'quoteCurrency': 'QUOTE', 'settlementCurrency': 'QUOTE'},
            'marginMode': 'isolated', 'side': 'LONG', 'qtyBase': 0.5,
            'entryPriceQuotePerBase': 40000, 'netCashQuote': 0,
            'cashSemantics': 'settled_net_cash_excluding_unrealized_pnl',
            'valuation': {'priceQuotePerBase': 41000, 'basis': 'manual',
                          'sourceReference': 'corpus-price', 'asOf': 1700000000000},
        },
        'policy': {
            'schemaVersion': 'margin-model-policy/1', 'modelId': 'generic-linear-isolated',
            'modelVersion': '1', 'source': 'manual', 'configVersion': 'corpus-1',
            'initialMarginRate': 0.2, 'maintenanceMarginRate': 0.01,
            'initialMarginBasis': 'valuation_notional', 'maintenanceBasis': 'valuation_notional',
            'comparison': 'lt', 'chargesPolicy': 'settled_cash_only',
            'prospectiveCosts': 'excluded', 'tiersPolicy': 'flat_only',
        },
    }


def build():
    values = [
        ('objects-and-arrays', {'z': [None, True, False, 'x'], 'a': {'2': 2, '10': 10}}),
        ('unicode', {'\ue000': '\u0000\n\t"\\', '😀': 'é/e\u0301/Я/\u200b/\ud800/\udfff'}),
        ('number-boundaries', [-0.0, 5e-324, 1e-323, 2.2250738585072014e-308,
                               1.7976931348623157e308, 1e-7, 1e-6, 1e20, 1e21, 0.1]),
        ('prototype-keys', {'__proto__': {'polluted': True}, 'constructor': 1, 'prototype': 2}),
        ('composed', 'é'), ('decomposed', 'e\u0301'), ('array-12', [1, 2]), ('array-21', [2, 1]),
    ]
    generic = [{'name': name, 'json': json.dumps(value, ensure_ascii=True, allow_nan=False),
                'canonical': canonical(value)} for name, value in values]
    context = {'engineVersion': 'test-engine@1', 'arithmeticVersion': 'test-arithmetic@1',
               'requestedCapabilities': ['maintenance_comparison', 'margin_metrics']}
    variants = [('baseline', base())]
    short = base()
    short['snapshot']['side'] = 'SHORT'
    short['policy']['comparison'] = 'lte'
    variants.append(('short-lte', short))
    extreme = base()
    extreme['snapshot']['qtyBase'] = 5e-324
    extreme['snapshot']['entryPriceQuotePerBase'] = 1.7976931348623157e308
    extreme['snapshot']['valuation']['priceQuotePerBase'] = 1e-323
    extreme['snapshot']['netCashQuote'] = 5e-324
    extreme['policy']['initialMarginRate'] = 1
    extreme['policy']['maintenanceMarginRate'] = 5e-324
    extreme['snapshot']['asOf'] = extreme['snapshot']['valuation']['asOf'] = 9007199254740991
    variants.append(('extreme-binary64', extreme))
    unicode = base()
    unicode['snapshot']['source'] = {'kind': 'test', 'reference': 'é/e\u0301/😀/\ud800/\u0000/end'}
    unicode['snapshot']['valuation']['sourceReference'] = 'a\nb\u200bc'
    variants.append(('unicode-identifiers', unicode))
    zero = base()
    zero['snapshot']['netCashQuote'] = -0.0
    variants.append(('negative-zero', zero))
    identities = []
    for name, value in variants:
        policy_text, input_text = canonical(value['policy']), canonical(value)
        policy_hash, input_hash = digest('policy', policy_text), digest('input', input_text)
        payload = dict(copy.deepcopy(context), inputHash=input_hash)
        payload['requestedCapabilities'].sort()
        assessment_text = canonical(payload)
        identities.append({
            'name': name, 'inputJson': json.dumps(value, ensure_ascii=True, allow_nan=False),
            'contextJson': json.dumps(context), 'policyCanonical': policy_text,
            'inputCanonical': input_text, 'assessmentCanonical': assessment_text,
            'policyHash': policy_hash, 'inputHash': input_hash,
            'assessmentId': digest('assessment', assessment_text),
        })
    fixture = Path(__file__).resolve().parents[2] / 'fixtures' / 'linear-perp-manual.json'
    legacy = json.loads(fixture.read_text(encoding='utf-8'))
    # This fixture is ASCII and has no exotic string escapes: the independently
    # computed canonical bytes coincide with the OLD JSON.stringify convention.
    legacy_hash = hashlib.sha256(canonical(legacy).encode('ascii')).hexdigest()
    return {'format': 'margin-canonical-json/1', 'oracle': 'CPython independent serializer + hashlib.sha256',
            'generic': generic, 'identities': identities, 'legacyFixtureHash': legacy_hash}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    Path(args.output).write_text(json.dumps(build(), ensure_ascii=True, indent=2) + '\n', encoding='utf-8', newline='\n')
