import { createHash } from 'node:crypto';

import type { RiskInput } from './schema.js';

/**
 * Canonical serialization and the input hash.
 *
 * Two runs on the same market state must produce the same report, which means
 * the hash must not depend on JSON key order, on absent-versus-`undefined`
 * fields, or on `-0`. The canonical form sorts object keys recursively, keeps
 * array order (a candle series is ordered data), normalizes `-0` to `0`, and
 * lets numbers serialize through their own deterministic `toString`.
 *
 * The input carries no secrets by contract: positions, prices and margin
 * configs are market data. Nothing is read from the environment to hash.
 */
export function canonicalize(value: unknown): string {
    return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
    if (typeof value === 'number') {
        return Object.is(value, -0) ? 0 : value;
    }

    if (Array.isArray(value)) {
        return value.map(canonicalValue);
    }

    if (isPlainObject(value)) {
        const entries = Object.entries(value)
            .filter(([, entryValue]) => entryValue !== undefined)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

        return Object.fromEntries(
            entries.map(([key, entryValue]) => [key, canonicalValue(entryValue)]),
        );
    }

    return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        value.constructor === Object
    );
}

/** SHA-256 of the canonical input, hex. Deterministic for identical inputs. */
export function canonicalInputHash(input: RiskInput): string {
    return createHash('sha256').update(canonicalize(input)).digest('hex');
}
