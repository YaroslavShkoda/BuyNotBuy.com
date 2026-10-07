import type { Migration } from './types.js';

export const migration014_holdout_verdict: Migration = {
        version: 14,
        name: 'holdout_verdict',
        sql: `
            -- The held-out window, read once.
            --
            -- holdout.ts says that reading a number leaves no trace, and
            -- that is true: nobody can be stopped from loading the bars twice, and
            -- any design promising otherwise is promising something it cannot
            -- deliver. So the one-read rule is not enforced on the data. It is
            -- enforced on the question.
            --
            -- What actually goes wrong is not the re-read. It is reading, finding
            -- the return was ugly, and then choosing which statistic to report —
            -- profit factor this time, hit rate the next. The number was never the
            -- problem; choosing it afterwards was.
            --
            -- So the protocol is stored with the verdict: which statistics were
            -- going to be reported, fixed and fingerprinted while the window was
            -- still empty. The metric list is a closed union in code, so a new
            -- statistic cannot be invented at reporting time at all. The verdict
            -- carries every declared metric for every registered rule, so
            -- selecting a favourable subset of one's own output is not available.
            --
            -- And this table can hold exactly one row, ever. Not by convention:
            -- CHECK (id = 1) makes a second INSERT
            -- fail in the database. That is the most a piece of schema can do about
            -- a rule about reading, and it is worth doing anyway — it turns a
            -- silent re-read into a loud one, which is the difference between a
            -- discipline and a habit.
            --
            -- What it does not stop: opening the fixture again, or writing a new
            -- module with a different purpose. This is a lock on the verdict, not
            -- on the curiosity.
            CREATE TABLE IF NOT EXISTS holdout_verdict (
                id INTEGER PRIMARY KEY,

                created_at BIGINT NOT NULL,

                -- The protocol as it stood before the window filled. Compared
                -- against the live one so that a reshuffled question is visible
                -- rather than invisible.
                protocol_fingerprint TEXT NOT NULL,
                protocol_metrics TEXT NOT NULL,
                protocol_note TEXT NOT NULL,

                -- Complete output: every declared metric for every registered
                -- rule, as JSON. A partial write would be the loophole, so the
                -- shape is checked rather than trusted.
                readings JSONB NOT NULL,

                -- The rules that were registered, and their fingerprints at
                -- registration. A rule adjusted after registering is reported as
                -- changed, which is a different sentence from failing.
                candidates JSONB NOT NULL,

                first_bar_at BIGINT NOT NULL,
                last_bar_at BIGINT NOT NULL,
                bar_count INTEGER NOT NULL,

                CONSTRAINT holdout_verdict_singleton CHECK (id = 1),
                CONSTRAINT holdout_verdict_has_bars CHECK (bar_count > 0),
                CONSTRAINT holdout_verdict_readings_shape
                    CHECK (jsonb_typeof(readings) = 'array'),
                CONSTRAINT holdout_verdict_candidates_shape
                    CHECK (jsonb_typeof(candidates) = 'array')
            );
        `,
    };
