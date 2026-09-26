import { Buffer } from 'node:buffer';

const HOUR_MS = 3_600_000;

/**
 * Opaque history cursor.
 *
 * Encoded rather than exposed as a bare timestamp so that clients cannot come
 * to depend on the shape. Changing how the boundary is represented later must
 * not break anyone who stored a cursor, and a page boundary that is
 * understood is a boundary that gets hand-built.
 *
 * The bucket is embedded in a short signature so a corrupted or hand-edited
 * cursor is rejected as a bad request instead of silently paging from
 * somewhere arbitrary.
 */
const CURSOR_VERSION = 'h1';

const SECRET_MARKER = 'hs';

function sign(bucket: number): string {
    // Not a security boundary: a cursor is a convenience, and a client that
    // can read the database can do worse than page through it. This only has
    // to catch truncation and typos.
    let hash = 0x811c9dc5;

    for (const character of `${CURSOR_VERSION}:${SECRET_MARKER}:${bucket}`) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return hash.toString(36);
}

export function encodeCursor(bucket: number): string {
    return Buffer.from(`${CURSOR_VERSION}.${SECRET_MARKER}.${bucket}.${sign(bucket)}`)
        .toString('base64url');
}

export function decodeCursor(cursor: string): number | null {
    let decoded: string;

    try {
        decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    } catch {
        return null;
    }

    const parts = decoded.split('.');

    if (parts.length !== 4) {
        return null;
    }

    const [version, marker, rawBucket, signature] = parts as [
        string,
        string,
        string,
        string,
    ];

    if (version !== CURSOR_VERSION || marker !== SECRET_MARKER) {
        return null;
    }

    const bucket = Number(rawBucket);

    if (!Number.isSafeInteger(bucket) || bucket < 0) {
        return null;
    }

    // A cursor that fails its own signature is not a cursor this service
    // produced, so it is a client error rather than a page from nowhere.
    if (sign(bucket) !== signature) {
        return null;
    }

    return bucket;
}

export function bucketOf(timestamp: number): number {
    return Math.floor(timestamp / HOUR_MS);
}
