import { describe, expect, it } from 'vitest';

import { applyCorsHeadersFor } from './cors.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

type Headers = Record<string, string>;

function fakeRequest(origin?: string): FastifyRequest {
    return {
        headers: origin === undefined ? {} : { origin },
    } as unknown as FastifyRequest;
}

function fakeReply(): { reply: FastifyReply; headers: Headers } {
    const headers: Headers = {};

    return {
        headers,
        reply: {
            header(name: string, value: string) {
                headers[name.toLowerCase()] = value;

                return this;
            },
        } as unknown as FastifyReply,
    };
}

function run(origin: string | undefined, allowedOrigins: string[]): Headers {
    const { reply, headers } = fakeReply();

    applyCorsHeadersFor(fakeRequest(origin), reply, allowedOrigins);

    return headers;
}

describe('applyCorsHeadersFor', () => {
    it('allows a listed origin', () => {
        const headers = run('https://dashboard.example', [
            'https://dashboard.example',
        ]);

        expect(headers['access-control-allow-origin']).toBe(
            'https://dashboard.example',
        );
        expect(headers['access-control-allow-methods']).toBe('GET, HEAD, OPTIONS');
    });

    it('never answers with a wildcard', () => {
        const headers = run('https://dashboard.example', [
            'https://dashboard.example',
        ]);

        // A wildcard would let every page a user visits read the API.
        expect(headers['access-control-allow-origin']).not.toBe('*');
    });

    it('refuses an unlisted origin', () => {
        const headers = run('https://evil.example', [
            'https://dashboard.example',
        ]);

        expect(headers['access-control-allow-origin']).toBeUndefined();
    });

    it('refuses a look-alike host', () => {
        // A suffix check would wave this through, and the attacker's page would
        // then read the user's market view.
        const headers = run('https://evil-dashboard.example', [
            'https://dashboard.example',
        ]);

        expect(headers['access-control-allow-origin']).toBeUndefined();
    });

    it('refuses a subdomain that is not listed', () => {
        const headers = run('https://a.dashboard.example', [
            'https://dashboard.example',
        ]);

        expect(headers['access-control-allow-origin']).toBeUndefined();
    });

    it('refuses the same host over a different scheme', () => {
        const headers = run('http://dashboard.example', [
            'https://dashboard.example',
        ]);

        expect(headers['access-control-allow-origin']).toBeUndefined();
    });

    it('refuses an origin carrying a port the list does not name', () => {
        const headers = run('https://dashboard.example:8443', [
            'https://dashboard.example',
        ]);

        expect(headers['access-control-allow-origin']).toBeUndefined();
    });

    it('refuses everything when the list is empty', () => {
        const headers = run('https://dashboard.example', []);

        expect(headers['access-control-allow-origin']).toBeUndefined();
    });

    it('does nothing for a same-origin request that sends no Origin header', () => {
        const headers = run(undefined, ['https://dashboard.example']);

        // Server-to-server calls carry no Origin, and adding CORS headers to
        // them would only mislead a cache.
        expect(headers['access-control-allow-origin']).toBeUndefined();
        expect(headers['vary']).toBe('Origin');
    });

    it('varies on Origin even when refusing, so caches cannot mix decisions', () => {
        const headers = run('https://evil.example', [
            'https://dashboard.example',
        ]);

        expect(headers['vary']).toBe('Origin');
    });
});
