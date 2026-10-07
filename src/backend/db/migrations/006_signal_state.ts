import type { Migration } from './types.js';

export const migration006_signal_state: Migration = {
        version: 6,
        name: 'signal_state',
        sql: `
            CREATE TABLE IF NOT EXISTS signal_state (
                id BIGSERIAL PRIMARY KEY,
                symbol TEXT NOT NULL,
                provider TEXT NOT NULL,
                interval TEXT NOT NULL,

                -- The direction this signal is currently in, not every direction
                -- it has passed through. A signal that flipped LONG to SHORT and
                -- back is a new signal; pretending it is the old one makes the
                -- outcome engine measure a trade nobody held.
                direction TEXT NOT NULL,
                status TEXT NOT NULL,

                -- The snapshot this state was last written from. A foreign key
                -- would be better and cannot be: snapshots are pruned, and a
                -- pruned snapshot must not take the history of every signal
                -- that referenced it with it.
                snapshot_id BIGINT,

                price DOUBLE PRECISION NOT NULL,
                confidence DOUBLE PRECISION NOT NULL,

                -- The bar the signal was published on. The clock for the
                -- cooldown is measured in closed bars, not in wall time, so a
                -- backend that was down for four hours does not come back
                -- believing it is ready to publish.
                published_at BIGINT NOT NULL,
                candle_timestamp BIGINT NOT NULL,

                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,

                CONSTRAINT signal_state_direction_known CHECK (
                    direction IN ('LONG', 'SHORT')
                ),
                CONSTRAINT signal_state_status_known CHECK (
                    status IN (
                        'GENERATED',
                        'ACTIVE',
                        'UPDATED',
                        'INVALIDATED',
                        'EXPIRED',
                        'CLOSED'
                    )
                ),
                CONSTRAINT signal_state_price_positive CHECK (price > 0),
                CONSTRAINT signal_state_confidence_bounded CHECK (
                    confidence >= 0 AND confidence <= 100
                ),

                -- One live signal per series. This is what makes dedup a
                -- database guarantee rather than a check somebody has to
                -- remember to run before writing.
                UNIQUE (symbol, provider, interval)
            );

            -- Every read is "the live signal for this series", and the unique
            -- constraint above already carries that prefix.
            CREATE INDEX IF NOT EXISTS idx_signal_state_status
            ON signal_state (status, updated_at DESC);
        `,
    };
