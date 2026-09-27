import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ProviderError, statusForKind } from './provider.error.js';

import type { ProviderFailureKind } from './provider.error.js';

/**
 * Why this file exists at all.
 *
 * Every provider failure used to be a `MarketDataError` carrying a `code` and a
 * `cause` bag, which meant a caller who needed to know *which* failure it was
 * had two options: compare the code, or read the English. The tests did both,
 * and reading the English is the one that works until a runtime rewords the
 * message or a venue renames an endpoint.
 *
 * A rule that is only written down gets broken the first time it is annoying.
 * This is the rule made executable: the shapes below are the only ways to ask
 * "what kind of failure was this", and the scan proves that no production file
 * has found a fourth.
 */

const BACKEND_ROOT = join(import.meta.dirname, '..');

const KINDS: ProviderFailureKind[] = [
    'unavailable',
    'timeout',
    'rate_limited',
    'invalid_response',
    'circuit_open',
    'insufficient_history',
];

/** Files that legitimately do the parsing, because they are the ones doing it. */
const ALLOWED = new Set(['errors/provider.error.ts', 'errors/provider.error.test.ts']);

function sourceFiles(dir: string): string[] {
    const found: string[] = [];

    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);

        if (statSync(full).isDirectory()) {
            found.push(...sourceFiles(full));
            continue;
        }

        if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
            found.push(full);
        }
    }

    return found;
}

describe('provider failures are classified, not read', () => {
    it('no production file inspects a message to decide what happened', () => {
        const offenders: string[] = [];

        for (const file of sourceFiles(BACKEND_ROOT)) {
            const relative = file.slice(BACKEND_ROOT.length + 1).replace(/\\/g, '/');

            if (ALLOWED.has(relative) || relative.endsWith('.test.ts')) {
                continue;
            }

            const text = readFileSync(file, 'utf8');

            for (const [index, line] of text.split('\n').entries()) {
                const code = line
                    .replaceAll('//.*', '')
                    .replaceAll(/\/\*.*?\*\//g, '');

                // The only sanctioned ways to ask a question about a message.
                if (
                    /\b(error|err|failure|cause|exception)\w*\.message\.(?:includes|startsWith|endsWith|match|search|test|indexOf)\s*\(/.test(
                        code,
                    )
                    || /\b(error|err|failure|cause|exception)\w*\.message\.toLowerCase\s*\(/.test(
                        code,
                    )
                    || /\bregexp?\b.*\.test\s*\(\s*(error|err|failure|cause|exception)\w*\.message/i.test(
                        code,
                    )
                ) {
                    offenders.push(`${relative}:${index + 1}  ${line.trim()}`);
                }
            }
        }

        expect(offenders).toEqual([]);
    });

    it('no production file compares a market error code to branch on a failure', () => {
        // The code is the wire contract and is for the client. Inside the
        // application the `kind` is the fact, because two incidents can share a
        // code and a client-visible string is a poor thing to build logic on.
        const offenders: string[] = [];
        const codes = [
            'MARKET_DATA_UNAVAILABLE',
            'MARKET_PROVIDER_ERROR',
            'MARKET_RATE_LIMITED',
            'MARKET_PROVIDER_TIMEOUT',
            'MARKET_INSUFFICIENT_HISTORY',
        ];

        for (const file of sourceFiles(BACKEND_ROOT)) {
            const relative = file.slice(BACKEND_ROOT.length + 1).replace(/\\/g, '/');

            if (
                relative.startsWith('errors/')
                || relative.startsWith('api/')
                || relative.endsWith('.test.ts')
            ) {
                continue;
            }

            const text = readFileSync(file, 'utf8');

            for (const [index, line] of text.split('\n').entries()) {
                if (
                    /(===|!==|==|!=)\s*['"]MARKET_/.test(line)
                    || /['"]MARKET_[A-Z_]+['"]\s*(===|!==|==|!=)/.test(line)
                ) {
                    offenders.push(
                        `${relative}:${index + 1}  ${line.trim()}  [${codes.join(', ')}]`,
                    );
                }
            }
        }

        expect(offenders).toEqual([]);
    });

    it('every kind has a status, a retry answer and a code', () => {
        // The three questions any caller can ask, answered for all six kinds at
        // once. A kind added without one of them is a kind somebody will
        // discover at 3am and handle with a `default` branch.
        for (const kind of KINDS) {
            const error = new ProviderError(kind, 'x', {
                context: { provider: 'binance' },
            });

            expect(statusForKind(kind)).toBeGreaterThanOrEqual(400);
            expect(error.code.length).toBeGreaterThan(0);
            expect(typeof error.retryable).toBe('boolean');
            expect(error.provider).toBe('binance');
        }
    });
});
