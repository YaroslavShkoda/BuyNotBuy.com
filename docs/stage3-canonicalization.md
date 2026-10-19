# Stage 3 canonicalization and provenance — S3-03

This is a separate foundation for `generic-linear-isolated@1`. It does not
change `risk-report/1`, `canonicalInputHash`, any numeric helper, or calculate
margin, liquidation, or assessment metrics.

## External boundary

External inputs are JSON **text**, never arbitrary JavaScript objects. The
boundary does not coerce boxed strings, execute getters, call `toJSON`, inspect
Proxy properties, convert prototypes, or use a JSON reviver.

`prepareMarginInputJson(text)` parses the text, checks the JSON resource/number
limits, and calls the existing Stage 3 validator. Invalid/unsupported inputs
receive no handle. For supported inputs it serializes only the validator's
successful data copy and stores immutable canonical strings and provenance
fields behind an opaque, module-issued handle. Hashing performs WeakMap identity
lookups, not property reads on caller-supplied handles. Forged, wrapped, cloned,
wrong-kind, and revoked-Proxy handles are refused without executing their traps.

`prepareIdentityContextJson(text)` independently validates explicit engine and
arithmetic versions and an explicit requested capability set. Versions are
nonblank, unpadded strings of 1–128 UTF-16 code units. No version defaults exist.
Capabilities are unique members of `margin_metrics`, `maintenance_comparison`,
and `liquidation_boundary`; an explicit empty set is allowed. They describe a
request, not an assertion that a mathematical engine has been implemented.

The JSON text limit is 16,384 UTF-8 bytes; the parsed tree limit is 4,096 values
and depth 32 (root depth zero). Source bytes are checked before parsing; tree
limits are checked before serialization. Generic canonicalization additionally
checks the canonical output's UTF-8 byte length before returning it: exactly
16,384 bytes is allowed, 16,385 or more returns `JSON_LIMIT_EXCEEDED` without a
canonical value. Escaping and binary64 formatting can expand short source text;
there is no truncation or rounding to fit. Serialization preserves tree depth
and value count, so every successful generic output satisfies all three limits
and canonicalizes again to the identical bytes. No unbounded recursive traversal
of an arbitrary JavaScript object occurs. The byte limit bounds parsing itself.

`JSON.parse` defines parsing semantics: duplicate object names use their last
value, and number tokens are converted to binary64 before validation. The
identity covers those parsed, validated values, not the original spelling of
decimal tokens or duplicate names. In particular this is not an exact-decimal
parser. Overflow to a non-finite number is rejected anywhere in the parsed tree.

The S3-02 validator remains unchanged and retains its documented restriction
when called directly with non-JSON JavaScript objects. This new boundary avoids
that unsupported path. Handles are process-local, not durable storage artifacts;
replay requires the source snapshot, policy, context, and recorded versions.

## `margin-canonical-json/1`

Canonical documents are ASCII JSON, encoded as UTF-8 bytes for SHA-256:

1. Object keys are sorted lexicographically by their original UTF-16 code units
   at every level. Key ordering does not use locale or JS integer-key enumeration.
2. Arrays preserve element order. No values or fields are omitted or defaulted.
3. Strings and keys are quoted with `"`. Quote and backslash use `\"` and `\\`.
   Every UTF-16 code unit outside U+0020–U+007E uses lowercase `\uXXXX`, including
   controls, surrogate pairs, and isolated surrogates. Other ASCII units remain
   literal. There are no short control escapes and no Unicode normalization.
4. Finite numbers use ECMAScript `Number.prototype.toString()` radix 10: its
   shortest round-tripping representation and standard fixed/exponent thresholds.
   Every finite binary64 value survives reparsing exactly, except that `-0` is
   intentionally equivalent to `0` and serializes as `0`.
5. Booleans and null use `true`, `false`, and `null`. Objects and arrays use normal
   JSON delimiters and commas, with no insignificant whitespace.
6. NaN, infinities, BigInt, undefined, functions, symbols, accessors and arbitrary
   JS object graphs are not accepted external values. BigInt has no JSON syntax.

`canonicalizeMarginJson(text)` is the generic format utility. Prototype-related
JSON names (`__proto__`, `constructor`, `prototype`) are ordinary keys in that
utility: no assignment to a prototype is performed. The strict model/context
schemas reject such extra fields when preparing identity handles.

S3-03.1 closes an implementation gap in the generic utility's existing byte
budget. Previously accepted source texts whose canonical output exceeds 16,384
bytes now return `JSON_LIMIT_EXCEEDED`. This includes 745 copies of `1e20` in an
array (3,726 source bytes, 16,391 canonical bytes), a string of 2,731 `é` units
(5,464 source bytes, 16,388 canonical bytes), and combinations of expanded number
literals, escaped string values or escaped object keys crossing the same limit.
A string of 2,730 `é` units remains accepted (16,382 canonical bytes). Remaining
successful outputs have identical bytes and hashes. Identity handle preparation,
hash domain prefixes, assessment identity and provenance semantics are unchanged.

Changing these rules, parsing semantics, limits, or equivalence classes requires
a new canonicalization version and review of its hash domains. Array order is
preserved in general; only the specifically declared capability **set** is sorted
before constructing an assessment-identity document. Duplicates in this set are
rejected instead of silently removed.

## Hash domains

All digests are SHA-256 lowercase hex strings (64 ASCII characters). The preimage
is the UTF-8 encoding of the following fixed prefix followed by one complete
canonical JSON document; `NUL` means a single byte `00`:

```text
BuyNotBuy NUL margin-canonical-json/1 NUL <domain> NUL <canonical JSON>
```

Domains and documents:

| Identity | Domain | Entire document |
|---|---|---|
| policyHash | `policy` | Validated ModelPolicy |
| inputHash | `input` | Validated `{ snapshot, policy }` |
| assessmentId | `assessment` | `{ inputHash, engineVersion, arithmeticVersion, requestedCapabilities }` |

The domains are fixed literals. No caller-controlled text is inserted into the
prefix. Fields are encoded as one structured JSON document, not concatenated
without boundaries. Context strings containing NUL are escaped inside that
document. Policy and input hashes do not depend on engine versions; assessment
identity does. No wall-clock time, randomness, environment, registry, or IO is used.

Tests check particular distinct examples and independent golden vectors; they
do **not** establish cryptographic collision freedom.

## Provenance

`createMarginIdentity(inputHandle, contextHandle)` returns only `assessmentId`
and `AssessmentProvenance`, not a risk assessment. Schema/model versions, source
kind/reference, and timestamps come from validated input; engine/arithmetic
versions come from the explicitly validated context. Signed-zero timestamps are
normalized to positive zero consistently with the hash. The canonicalization
version is fixed by this module. Hashes are calculated from the cached canonical
documents. No fictitious version or timestamp is synthesized.

Missing/invalid context returns `INVALID_CONTEXT`; non-text/syntax/resource/
non-finite failures have distinct controlled codes. Invalid handles return
`UNTRUSTED_INPUT` or `UNTRUSTED_CONTEXT`. Cached validated canonical input records,
identity/provenance records, context records and capability arrays are frozen.
Outer public result wrappers are not guaranteed to be frozen: freezing the
internal records does not make the public result wrapper immutable. There is no
assessment builder or public report integration.

## Independent corpus

`src/backend/risk/stage3/test-support/canonical-corpus.json` is committed test data.
Its generator is a standalone Python program in the same directory. It uses its
own UTF-16 serializer and `hashlib.sha256`, with no imports/calls to production or
Node. Selected binary64 number vectors use CPython shortest repr converted to the
specified ECMAScript notation thresholds; this is a fixed-corpus oracle, not an
alternative general implementation of ECMAScript number formatting.

The corpus pins generic canonical strings, full policy/input/assessment documents,
all three domain-separated hashes, and the unchanged legacy fixture hash.
Regeneration is explicit via `--output`; tests only read the corpus. Property
tests separately verify binary64 round trips and canonicalization idempotence.
