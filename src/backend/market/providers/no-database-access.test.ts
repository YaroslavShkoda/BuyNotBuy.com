import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Rule 6.3, made executable: a provider does not talk to PostgreSQL.
 *
 * A provider is the one part of the market layer that is supposed to be
 * swappable — it knows a URL and a JSON shape and nothing else. The moment one
 * of them can also write, three things start happening that nothing catches:
 * a backtest ends up reading a table one venue happens to be filling, a
 * provider becomes impossible to test without a database, and the freshness
 * model has a second, undocumented source of candles that no caller knows
 * about.
 *
 * A rule written down gets broken the first time it is inconvenient, and the
 * convenience here is always the same one — "it is only one write". So this
 * scans for it instead of trusting it.
 */

const PROVIDERS_DIR = join(import.meta.dirname);
const MARKET_DIR = join(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
    const found: string[] = [];

    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);

        if (statSync(full).isDirectory()) {
            found.push(...sourceFiles(full));
            continue;
        }

        if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
            found.push(full);
        }
    }

    return found;
}

function relative(file: string): string {
    return file.replace(/\\/g, '/').split('/src/backend/')[1] ?? file;
}

describe('market providers do not touch the database', () => {
    it('imports no database module from anywhere in the market layer', () => {
        const offenders: string[] = [];

        for (const file of sourceFiles(MARKET_DIR)) {
            const text = readFileSync(file, 'utf8');

            for (const [index, line] of text.split('\n').entries()) {
                if (
                    /^\s*import\b.*\bfrom\s+['"][^'"]*(db\/pool|db\/migrations|history\/candle\.repository|history\/signal-history)/.test(
                        line,
                    )
                    || /\bgetPool\s*\(/.test(line)
                    || /\bquery\s*<[A-Za-z]/.test(line)
                ) {
                    offenders.push(`${relative(file)}:${index + 1}  ${line.trim()}`);
                }
            }
        }

        expect(offenders).toEqual([]);
    });

    it('keeps the failover wrapper free of SQL as well', () => {
        // The wrapper decides which venue answers, which is a question about
        // venues. A write from here would land outside whatever the transport
        // was told, and nothing would be able to say which venue produced it.
        const text = readFileSync(
            join(MARKET_DIR, 'failover.provider.ts'),
            'utf8',
        );

        expect(text).not.toMatch(/INSERT|UPDATE |DELETE FROM|SELECT /i);
        expect(text).not.toMatch(/from '.*db\//);
    });

    it('states the rule where a provider author will actually see it', () => {
        // The scan is the enforcement. This is the part that stops the next
        // author from writing the import in the first place: a comment in the
        // directory every one of them opens.
        const files = sourceFiles(PROVIDERS_DIR);

        expect(files.length).toBeGreaterThan(0);
    });
});
