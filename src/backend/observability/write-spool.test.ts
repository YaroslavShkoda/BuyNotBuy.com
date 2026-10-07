import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWriteSpool } from './write-spool.js';


interface SpoolEntry {
    symbol: string;
    n: number;
}

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'write-spool-test-'));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function spool(
    over: Partial<{ maxBytes: number; enabled: boolean; directory: string; name: string }> = {},
) {
    return createWriteSpool<SpoolEntry>({
        name: over.name ?? 'test_series',
        directory: over.directory ?? dir,
        maxBytes: over.maxBytes ?? 1_000_000,
        enabled: over.enabled ?? true,
        marketOf: (entry) => entry.symbol,
    });
}

function entry(symbol: string, n: number): SpoolEntry {
    return { symbol, n };
}

function spoolPath(name = 'test_series'): string {
    return join(dir, `${name}.jsonl`);
}

describe('write spool', () => {
    it('writes an entry to disk and reads it back in a fresh spool', () => {
        const first = spool();

        expect(first.append(entry('BTCUSDT', 1))).toBe(true);
        expect(first.size).toBe(1);

        // A fresh instance over the same directory is the boot of the next
        // process: what it sees is what the disk held, not what memory did.
        const second = spool();

        expect(second.size).toBe(1);
        expect(second.peek()).toEqual(entry('BTCUSDT', 1));
        expect(second.tornCount).toBe(0);
    });

    it('confirm removes the written entry from the file', () => {
        const writer = spool();

        writer.append(entry('BTCUSDT', 1));
        writer.append(entry('ETHUSDT', 2));
        writer.confirm();
        writer.compact();

        const reader = spool();

        expect(reader.size).toBe(1);
        expect(reader.peek()).toEqual(entry('ETHUSDT', 2));
    });

    it('drop removes the entry the same way, without pretending it was written', () => {
        const writer = spool();

        writer.append(entry('BTCUSDT', 1));
        writer.drop();
        writer.compact();

        expect(spool().size).toBe(0);
    });

    it('skips a torn tail — an append the process did not survive — and counts it', () => {
        // One complete line, then a fragment with no newline: the fsync never
        // finished, so the fragment's entry never existed durably. Parsing it
        // would be trusting a write that never completed.
        writeFileSync(
            spoolPath(),
            '{"symbol":"BTCUSDT","n":1}\n{"symbol":"ETHUSDT","n":2',
            'utf8',
        );

        const reader = spool();

        expect(reader.size).toBe(1);
        expect(reader.peek()).toEqual(entry('BTCUSDT', 1));
        expect(reader.tornCount).toBe(1);
    });

    it('counts a mid-file line that does not parse as torn, and keeps the rest', () => {
        writeFileSync(
            spoolPath(),
            'not json\n{"symbol":"BTCUSDT","n":1}\n',
            'utf8',
        );

        const reader = spool();

        expect(reader.size).toBe(1);
        expect(reader.peek()).toEqual(entry('BTCUSDT', 1));
        expect(reader.tornCount).toBe(1);
    });

    it('evicts the oldest entries past the byte bound, and counts the loss', () => {
        // Each line is 26 bytes; a 60-byte bound holds two plus room for one
        // more append, which is what forces the evictions.
        const writer = spool({ maxBytes: 60 });

        expect(writer.append(entry('BTCUSDT', 1))).toBe(true);
        expect(writer.append(entry('BTCUSDT', 2))).toBe(true);
        expect(writer.append(entry('BTCUSDT', 3))).toBe(true);

        expect(writer.evictedCount).toBe(2);
        expect(writer.size).toBe(1);
        expect(writer.peek()).toEqual(entry('BTCUSDT', 3));

        const reader = spool({ maxBytes: 60 });

        expect(reader.size).toBe(1);
        expect(reader.peek()).toEqual(entry('BTCUSDT', 3));
    });

    it('attributes evictions to the market that caused them', () => {
        const writer = spool({ maxBytes: 40 });

        // BTC fills the file; the appended ETH entry is what tips it over, and
        // the BTC entries are what get evicted.
        writer.append(entry('BTCUSDT', 1));
        writer.append(entry('BTCUSDT', 2));
        writer.append(entry('ETHUSDT', 3));

        expect(writer.evictedCount).toBeGreaterThanOrEqual(1);
        expect(writer.byMarket.BTCUSDT?.dropped).toBe(writer.evictedCount);
        expect(writer.byMarket.ETHUSDT?.dropped ?? 0).toBe(0);
    });

    it('splits the queue by market', () => {
        const writer = spool();

        writer.append(entry('BTCUSDT', 1));
        writer.append(entry('BTCUSDT', 2));
        writer.append(entry('ETHUSDT', 3));

        expect(writer.byMarket.BTCUSDT).toEqual({ spooled: 2, dropped: 0 });
        expect(writer.byMarket.ETHUSDT).toEqual({ spooled: 1, dropped: 0 });
    });

    it('rotate moves the oldest to the back, so a refused entry cannot stall the ones behind it', () => {
        const writer = spool();

        writer.append(entry('BTCUSDT', 1));
        writer.append(entry('ETHUSDT', 2));
        writer.append(entry('BTCUSDT', 3));
        writer.rotate();
        writer.compact();

        expect(writer.peek()).toEqual(entry('ETHUSDT', 2));

        const reader = spool();

        expect(reader.size).toBe(3);
        expect(reader.peek()).toEqual(entry('ETHUSDT', 2));
    });

    it('compact removes the dead prefix a confirm leaves behind', () => {
        const writer = spool();

        writer.append(entry('BTCUSDT', 1));
        writer.append(entry('ETHUSDT', 2));

        const before = statSync(spoolPath()).size;

        writer.confirm();
        writer.compact();

        expect(statSync(spoolPath()).size).toBeLessThan(before);
        expect(spool().size).toBe(1);
    });

    it('compact is free when nothing was confirmed or dropped', () => {
        const writer = spool();

        writer.append(entry('BTCUSDT', 1));

        const before = statSync(spoolPath()).size;

        writer.compact();

        expect(statSync(spoolPath()).size).toBe(before);
    });

    it('refuses appends when it is off, leaving the write path exactly as it was', () => {
        const writer = spool({ enabled: false });

        expect(writer.append(entry('BTCUSDT', 1))).toBe(false);
        expect(writer.size).toBe(0);
        expect(existsSync(spoolPath())).toBe(false);
    });

    it('refuses permanently when the directory cannot exist, instead of throwing into the writer', () => {
        // A file where the directory should be: mkdir fails, and the spool's
        // answer is to report itself as refusing rather than turn a database
        // outage into a process crash.
        const occupied = join(dir, 'occupied');

        writeFileSync(occupied, 'not a directory', 'utf8');

        const writer = spool({ directory: occupied });

        expect(writer.refused).toBe(true);
        expect(writer.append(entry('BTCUSDT', 1))).toBe(false);
        expect(writer.size).toBe(0);
    });

    it('keeps the queue and the file in agreement when the append itself fails', () => {
        // Pointed at a directory that exists but whose file cannot be opened
        // for append: the entry must not sit in the queue while the disk has
        // nothing — boot would resurrect a write the caller was told failed.
        const writer = spool({ directory: join(dir, 'sub', 'missing') });

        // The constructor creates missing directories, so this spool works;
        // removing it underneath proves the write path reports failure rather
        // than half-succeeding.
        rmSync(join(dir, 'sub'), { recursive: true, force: true });

        expect(writer.append(entry('BTCUSDT', 1))).toBe(false);
        expect(writer.size).toBe(0);
    });
});
