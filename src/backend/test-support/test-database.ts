import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Keeps every test run out of the real database.
 *
 * Several suites drive the real `analyzeMarket`, which records signal history
 * and indicator votes through process-wide singletons. Without this they write
 * fabricated readings — a mock price of 100 next to a mock close of 100000 —
 * into `data/signal-history.db`, where they survive as rows that later look
 * exactly like measurements. A test must never leave evidence behind that a
 * later run has to tell apart from reality.
 *
 * Set explicitly to override; `??=` leaves an intentional choice alone.
 */
const directory = process.env.HISTORY_DB_PATH
    ? null
    : mkdtempSync(join(tmpdir(), 'buynotbuy-test-'));

if (directory !== null) {
    process.env.HISTORY_DB_PATH = join(directory, 'signal-history.db');
}

afterAll(() => {
    if (directory === null) {
        return;
    }

    try {
        rmSync(directory, { recursive: true, force: true });
    } catch {
        // A suite that left the SQLite handle open keeps its temporary
        // directory. Losing a temp directory is harmless; failing a test
        // because cleanup could not run is not.
    }
});
