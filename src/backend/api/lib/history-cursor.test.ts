import { describe, expect, it } from 'vitest';

import { bucketOf, decodeCursor, encodeCursor } from './history-cursor.js';

const HOUR_MS = 3_600_000;

describe('history cursor', () => {
    it('round-trips a bucket', () => {
        expect(decodeCursor(encodeCursor(482_913))).toBe(482_913);
    });

    it('round-trips zero', () => {
        // A falsy bucket is the one that gets lost to a `||` by mistake, and
        // a cursor that fails to decode there becomes a silent 400 for the
        // oldest possible page.
        expect(decodeCursor(encodeCursor(0))).toBe(0);
    });

    it('does not leak the boundary as a plain number', () => {
        const cursor = encodeCursor(482_913);

        expect(cursor).not.toContain('482913');
        expect(cursor).not.toMatch(/^\d+$/);
    });

    it('rejects a truncated cursor', () => {
        expect(decodeCursor(encodeCursor(482_913).slice(0, 8))).toBeNull();
    });

    it('rejects a cursor with an edited boundary', () => {
        const cursor = encodeCursor(482_913);
        const tampered = Buffer.from(
            Buffer.from(cursor, 'base64url').toString('utf8').replace('482913', '482914'),
            'utf8',
        ).toString('base64url');

        // A hand-built cursor that validates would let a client page from
        // anywhere; a rejected one is a 400, which is the honest answer.
        expect(decodeCursor(tampered)).toBeNull();
    });

    it('rejects text that is not a cursor at all', () => {
        expect(decodeCursor('not-a-cursor')).toBeNull();
        expect(decodeCursor('')).toBeNull();
        expect(decodeCursor('!!!not base64!!!')).toBeNull();
    });

    it('rejects a cursor from a format this build does not speak', () => {
        const foreign = Buffer.from('h2.hs.100.deadbeef', 'utf8').toString('base64url');

        expect(decodeCursor(foreign)).toBeNull();
    });

    it('rejects a negative or fractional bucket', () => {
        for (const raw of ['-1', '1.5', 'NaN']) {
            const forged = Buffer.from(`h1.hs.${raw}.x`, 'utf8').toString('base64url');

            expect(decodeCursor(forged)).toBeNull();
        }
    });

    it('maps a timestamp to the bucket a row is stored under', () => {
        expect(bucketOf(HOUR_MS * 10 + 12_345)).toBe(10);
        expect(bucketOf(0)).toBe(0);
    });
});
