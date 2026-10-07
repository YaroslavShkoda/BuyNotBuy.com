import type { Migration } from './types.js';

export const migration018_snapshot_remembers_the_venue: Migration = {
        version: 18,
        name: 'snapshot_remembers_the_venue',
        sql: `
            -- Where the bars came from, which is the one thing a research object
            -- has to say about its own inputs.
            --
            -- signal_snapshot had symbol, a strategy version, two hashes and
            -- timestamps. It did not have the venue, and the identity that
            -- decides whether a new snapshot is a new record or a duplicate --
            -- hashValue({symbol, price, strategyVersionId, candlesHash}) -- did
            -- not have it either. So two venues serving byte-identical candles
            -- produced the same input_hash, the unique index on
            -- (symbol, input_hash) matched, ON CONFLICT DO NOTHING dropped the
            -- second, and the row that survived was attributed to whichever venue
            -- happened to arrive first, with nothing on it saying so.
            --
            -- This is invariant 9, and its own note is why it is not cosmetic:
            -- second-source.ts measured the provider moving the numbers by
            -- +5.74% against +0.45% on one identical rule. Losing which venue
            -- produced a measurement loses the ability to explain it.
            --
            -- interval travels with it for the same reason and with the same
            -- argument: it is part of which series this is.
            --
            -- **Both nullable, and nullable on purpose.** A row written before
            -- this migration genuinely does not know its venue, and the only
            -- honest thing to say about it is nothing. A default of 'unknown'
            -- would have been a tidier column and a fabricated provenance: a
            -- reader could not tell a venue called "unknown" from a venue that
            -- was never recorded. No row is rewritten.
            --
            -- The unique index is left as it is. New hashes cover the provider,
            -- so a venue switch is a genuinely different record, and old rows
            -- keep the hashes they were written with.
            ALTER TABLE signal_snapshot
                ADD COLUMN IF NOT EXISTS provider TEXT;
            ALTER TABLE signal_snapshot
                ADD COLUMN IF NOT EXISTS interval TEXT;
        `,
    };
