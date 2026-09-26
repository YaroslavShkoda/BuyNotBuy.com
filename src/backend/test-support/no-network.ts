import { beforeEach } from 'vitest';
import { connect as connectNet } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';

/**
 * Refuses to let a test reach the network.
 *
 * A test that talks to the real exchange is not a test: it passes on a good
 * morning, fails on a bad one, and can be slow enough that a CI job is killed
 * by a timeout that has nothing to do with the code under test. Worse, the
 * failure it produces is a confusing timeout in the wrong place rather than a
 * named assertion. The provider modules already have fixtures for this; the
 * guard exists so that a test which forgets to use one fails immediately and
 * says so.
 *
 * What it actually covers: `globalThis.fetch`, and therefore everything in this
 * repository that opens an outbound connection to a third party — the Binance
 * transport is the only such path, and it calls `fetch`.
 *
 * The one exception is the database. PostgreSQL is not "the network" here, it
 * is a local dependency the repositories cannot be tested without, so the host
 * and port named in `DATABASE_URL` are allowed through — and only those. A test
 * that reaches for any other address still fails immediately, which is the
 * property that matters.
 *
 * The `node:` builtins are patched as well, but that half is best-effort and
 * the tests do not claim otherwise. A named ESM import is bound when its module
 * is linked, so replacing `require('node:http').request` afterwards does not
 * change a binding another module already holds. Only `fetch` is a global
 * lookup made at call time, which is what makes it dependable.
 *
 * Everything is restored before each test rather than once at import, because a
 * test that installs its own `fetch` stub must not be able to poison the next
 * one.
 */

class NetworkAccessError extends Error {
    constructor(target: string) {
        super(
            `A test tried to open a network connection to ${target}. ` +
                'Replace it with a fixture or a stub; a test must not depend on ' +
                'an external service being up.',
        );
        this.name = 'NetworkAccessError';
    }
}

const originalFetch = globalThis.fetch;
const originalNetConnect = connectNet;
const originalTlsConnect = connectTls;
const originalHttpRequest = httpRequest;
const originalHttpsRequest = httpsRequest;
const originalLookup = dnsLookup;

function describeTarget(args: unknown[]): string {
    const first = args[0];

    if (typeof first === 'string') {
        return first;
    }

    if (first instanceof URL) {
        return first.href;
    }

    // Request exposes `url` and URL exposes `href`. Testing for only one of
    // them means the other is described as `{}` and the message names no
    // target — and the message matters most exactly when it would say nothing.
    if (typeof first === 'object' && first !== null) {
        const candidate = first as { url?: unknown; href?: unknown };

        if (typeof candidate.url === 'string') {
            return candidate.url;
        }

        if (typeof candidate.href === 'string') {
            return candidate.href;
        }

        return JSON.stringify(first);
    }

    return String(first);
}

function refuse(args: unknown[]): never {
    throw new NetworkAccessError(describeTarget(args));
}

/**
 * The one address a test may connect to: the database named by `DATABASE_URL`.
 *
 * Read at call time rather than at import, because the test setup rewrites
 * `DATABASE_URL` to point at this file's own schema.
 *
 * Exported so the rule itself can be tested. The patching it feeds is
 * best-effort at the ESM level — a module that already bound `connect` at link
 * time keeps the original — so a test that calls `net.connect` through a named
 * import proves nothing about what the guard does. It can, however, be asked
 * directly whether it would wave an address through, and that decision is what
 * must not quietly widen.
 */
export function isDatabaseAddress(args: unknown[]): boolean {
    const url = process.env.DATABASE_URL;

    if (url === undefined || url === '') {
        return false;
    }

    const options = args[0];

    if (typeof options !== 'object' || options === null) {
        return false;
    }

    const { host, port } = options as { host?: unknown; port?: unknown };

    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        return false;
    }

    return host === parsed.hostname && String(port) === parsed.port;
}

/** Runs the real `connect` for the database, and refuses everything else. */
function guardedConnect(
    original: (...args: never[]) => unknown,
): (...args: unknown[]) => unknown {
    return (...args: unknown[]): unknown =>
        isDatabaseAddress(args) ? original(...(args as never[])) : refuse(args);
}

function replaceGlobally<T extends object>(target: T, key: keyof T, value: unknown): void {
    Object.defineProperty(target, key, {
        value,
        configurable: true,
        writable: true,
    });
}

beforeEach(() => {
    globalThis.fetch = (async (input: unknown) => refuse([input])) as typeof fetch;

    replaceGlobally(connectNet, 'connect' as never, guardedConnect(originalNetConnect));
    replaceGlobally(connectTls, 'connect' as never, guardedConnect(originalTlsConnect));
    replaceGlobally(httpRequest, 'request' as never, (args: unknown[]) => refuse(args));
    replaceGlobally(httpsRequest, 'request' as never, (args: unknown[]) => refuse(args));
    replaceGlobally(dnsLookup, 'lookup' as never, (args: unknown[]) => refuse(args));
});

export { NetworkAccessError };

/** Restores the real implementations. Used by the guard's own test. */
export function restoreNetworkAccess(): void {
    globalThis.fetch = originalFetch;
    replaceGlobally(connectNet, 'connect' as never, originalNetConnect);
    replaceGlobally(connectTls, 'connect' as never, originalTlsConnect);
    replaceGlobally(httpRequest, 'request' as never, originalHttpRequest);
    replaceGlobally(httpsRequest, 'request' as never, originalHttpsRequest);
    replaceGlobally(dnsLookup, 'lookup' as never, originalLookup);
}
