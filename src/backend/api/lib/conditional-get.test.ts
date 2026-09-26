import { describe, expect, it } from 'vitest';

import { computeEtag, ifNoneMatchSatisfied } from './conditional-get.js';

const PAYLOAD = { signal: 'LONG', confidence: 61, indicators: [] };

describe('ETag', () => {
    it('gives the same tag to the same body', () => {
        expect(computeEtag(PAYLOAD)).toBe(computeEtag({ ...PAYLOAD }));
    });

    it('gives a different tag to a different body', () => {
        // A tag that did not change with the price would make every reload a
        // 304, which is worse than not having one at all.
        expect(computeEtag(PAYLOAD)).not.toBe(computeEtag({ ...PAYLOAD, confidence: 62 }));
    });

    it('is quoted, so it cannot be confused with a weak tag', () => {
        expect(computeEtag(PAYLOAD).startsWith('"')).toBe(true);
        expect(computeEtag(PAYLOAD).endsWith('"')).toBe(true);
    });

    it('does not let two different payloads collide by key order alone', () => {
        // Property order changes the bytes, and the bytes are the claim the
        // tag is making, so a reordered body is a different resource.
        expect(computeEtag({ a: 1, b: 2 })).not.toBe(computeEtag({ b: 2, a: 1 }));
    });
});

describe('volatile fields', () => {
    it('ignores a field that changes on every read', () => {
        const first = computeEtag({ price: 100, timestamp: 1 }, { volatileFields: ['timestamp'] });
        const second = computeEtag({ price: 100, timestamp: 2 }, { volatileFields: ['timestamp'] });

        // Otherwise the tag is new on every request and the client never
        // receives a 304: a header that costs a hash and delivers nothing.
        expect(first).toBe(second);
    });

    it('still notices a real change in what is left', () => {
        const first = computeEtag({ price: 100, timestamp: 1 }, { volatileFields: ['timestamp'] });
        const second = computeEtag({ price: 101, timestamp: 1 }, { volatileFields: ['timestamp'] });

        expect(first).not.toBe(second);
    });

    it('marks the tag weak, because the bytes are not identical', () => {
        const tag = computeEtag({ price: 100, timestamp: 1 }, { volatileFields: ['timestamp'] });

        // The body really did change — only its meaning did not. A strong tag
        // would promise byte equality that does not hold, and a cache that
        // believed it would pin the client to the old timestamp forever.
        expect(tag.startsWith('W/"')).toBe(true);
    });

    it('leaves a fully compared payload strong', () => {
        expect(computeEtag(PAYLOAD).startsWith('W/')).toBe(false);
    });

    it('survives a payload that is not an object', () => {
        expect(() => computeEtag(42, { volatileFields: ['timestamp'] })).not.toThrow();
        expect(() => computeEtag(null, { volatileFields: ['timestamp'] })).not.toThrow();
    });
});

describe('If-None-Match handling', () => {
    const etag = computeEtag(PAYLOAD);

    it('does nothing without the header', () => {
        expect(ifNoneMatchSatisfied(undefined, etag)).toBe(false);
    });

    it('matches an exact tag', () => {
        expect(ifNoneMatchSatisfied(etag, etag)).toBe(true);
    });

    it('matches the same tag among several', () => {
        expect(ifNoneMatchSatisfied(`"other", ${etag}`, etag)).toBe(true);
    });

    it('matches a weak tag against the same body', () => {
        // The weakness qualifier describes the transfer, not the value, so a
        // client holding W/"x" is holding the same bytes we would send.
        expect(ifNoneMatchSatisfied(`W/${etag}`, etag)).toBe(true);
    });

    it('matches the wildcard', () => {
        expect(ifNoneMatchSatisfied('*', etag)).toBe(true);
    });

    it('does not match a different tag', () => {
        expect(ifNoneMatchSatisfied('"something-else"', etag)).toBe(false);
    });

    it('does not match a tag that merely shares a prefix', () => {
        expect(ifNoneMatchSatisfied(etag.slice(0, -1), etag)).toBe(false);
    });

    it('does not match an empty candidate in a list', () => {
        expect(ifNoneMatchSatisfied(`${etag}, `, etag)).toBe(true);
        expect(ifNoneMatchSatisfied(',,', etag)).toBe(false);
    });
});
