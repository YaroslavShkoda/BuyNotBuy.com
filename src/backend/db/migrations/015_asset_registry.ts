import type { Migration } from './types.js';

export const migration015_asset_registry: Migration = {
        version: 15,
        name: 'asset_registry',
        sql: `
            -- The two halves of a market, as rows.
            --
            -- Until now a market was a single string, and every consumer re-derived
            -- which part was being traded and which part it was traded for. Three
            -- places did it by slicing a constant. This table is the answer to
            -- that, and it is deliberately two tables rather than one: a coin is
            -- not a pair, BTCUSDT is not BTC, and the difference is the whole
            -- reason PHASE 1 exists.
            --
            -- The constraint that earns its place is on the instrument, not the
            -- asset. An instrument whose base or quote does not exist is not a
            -- market with missing data, it is a market that cannot be read at
            -- all, and the two are enforced apart by the foreign keys — but a
            -- pair that names itself is still checkable, and that is the check
            -- that catches a ticker assembled by a parser that guessed.
            CREATE TABLE IF NOT EXISTS asset (
                symbol TEXT PRIMARY KEY,

                -- A coin is either a cryptocurrency or a currency, and the
                -- difference decides whether a signal priced in it is measured
                -- against another coin that moves or against a fixed unit. That
                -- is a real difference in what a number means, so it is a column
                -- and not a comment.
                category TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',

                -- How the category was arrived at, and when.
                --
                -- 'configured' is a person typing it. 'learned' is PHASE 14, and
                -- it is the only value that may overwrite a previous guess. The
                -- column exists from the start because retrofitting provenance
                -- onto rows that already have opinions is not possible, and the
                -- first version of this table would have had opinions.
                source TEXT NOT NULL DEFAULT 'configured',
                decided_at BIGINT NOT NULL,

                CONSTRAINT asset_category_known
                    CHECK (category IN ('crypto', 'fiat')),
                CONSTRAINT asset_status_known
                    CHECK (status IN ('active', 'inactive', 'unknown')),
                CONSTRAINT asset_source_known
                    CHECK (source IN ('configured', 'learned')),
                CONSTRAINT asset_symbol_shaped
                    CHECK (symbol ~ '^[A-Z0-9]{2,12}$')
            );

            CREATE TABLE IF NOT EXISTS instrument (
                -- As a venue writes it, because that is the only spelling that
                -- can be sent to one.
                ticker TEXT PRIMARY KEY,

                base_asset TEXT NOT NULL REFERENCES asset (symbol),
                quote_asset TEXT NOT NULL REFERENCES asset (symbol),

                -- 'unknown' is a value, not a gap. An unregistered quote used to
                -- be assumed to be crypto, which made BTCBRL a crypto pair. The
                -- database is the last place that can refuse to answer, and a
                -- market whose kind is not known is not the same as a crypto
                -- market.
                market_kind TEXT NOT NULL,

                status TEXT NOT NULL DEFAULT 'active',

                CONSTRAINT instrument_market_kind_known
                    CHECK (market_kind IN ('crypto', 'fiat', 'mixed', 'unknown')),
                CONSTRAINT instrument_status_known
                    CHECK (status IN ('active', 'inactive')),
                CONSTRAINT instrument_ticker_shaped
                    CHECK (ticker ~ '^[A-Z0-9]{3,32}$'),

                -- A pair is two different assets, and the only way to write one
                -- where they are the same is to name it twice. BTCBTC is not a
                -- market.
                CONSTRAINT instrument_halves_differ CHECK (base_asset <> quote_asset),

                -- The ticker must actually be the two halves written together.
                --
                -- This is the constraint that is worth the migration. Without it
                -- the table accepts ticker = 'BTCUSDT' with base = ETH, and
                -- every reader that trusts the ticker is then wrong in a way no
                -- column disagrees with. The parser already guarantees this, and
                -- a guarantee that exists only in the code that writes the rows
                -- is a guarantee that lasts until the first other writer.
                CONSTRAINT instrument_ticker_is_its_halves
                    CHECK (ticker = base_asset || quote_asset),

                -- And the halves must not be a reordering of each other, so
                -- BTCUSDT and USDTBTC cannot both exist as the same market
                -- written two ways.
                CONSTRAINT instrument_ticker_starts_with_base
                    CHECK (left(ticker, length(base_asset)) = base_asset)
            );

            CREATE INDEX IF NOT EXISTS instrument_base_idx
                ON instrument (base_asset);
            CREATE INDEX IF NOT EXISTS instrument_quote_idx
                ON instrument (quote_asset);
        `,
    };
