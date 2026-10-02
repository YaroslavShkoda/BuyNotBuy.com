import { fingerprintStrategy, hashValue } from '../config/strategy-fingerprint.js';
import { signalConfigFor } from '../config/indicator.config.js';
import { query } from '../db/pool.js';

import type { PoolClient } from 'pg';

export interface StrategyVersion {
    id: number;
    name: string;
    description: string;
    configHash: string;
    createdAt: number;
}

/**
 * **A version has no approval state, and saying so is the point.**
 *
 * This table used to carry `status: 'draft' | 'approved' | 'retired'` with a
 * CHECK that accepted all three. Nothing ever wrote anything but `draft`,
 * nothing ever tested it — `resolveActive` selects by `config_hash` alone and
 * never looks at the status — and the ladder whose names it borrowed
 * (`candidate → backtest → walk-forward → shadow → approval → production`,
 * with `canTransition` refusing a jump) lives on `strategy_rule`, which this
 * table has no foreign key to.
 *
 * A version identifies a *configuration* by its hash. Whether that
 * configuration is allowed to run for real money is a question about a rule and
 * the evidence behind it, and the rule table is the one that holds the
 * evidence. Carrying a second, unguarded copy of that vocabulary here meant one
 * `UPDATE` could mark a configuration approved that had never been
 * walk-forwarded — so the column is gone rather than guarded, and guarding it
 * would have meant either a second vocabulary to keep in step or a reference to
 * a stage record that does not exist for a configuration first seen at runtime.
 */

export interface StrategyVersionRepository {
    /**
     * The version this market's running configuration belongs to, creating it
     * the first time that configuration is seen.
     *
     * The market is a parameter, not an absence, because the thresholds it runs
     * are: `signalConfigFor` resolves what the market has been taught, and a
     * market with no override of its own resolves to the shipped configuration
     * and therefore to the same version as every other such market. A market
     * with its own thresholds gets its own version — which is what
     * `fingerprintStrategy` takes its argument for, and what calling it without
     * one silently threw away.
     */
    resolveActive(instrument: string): Promise<StrategyVersion>;
    byId(id: number): Promise<StrategyVersion | null>;
}

interface StrategyVersionRow {
    id: number;
    name: string;
    description: string;
    config_hash: string;
    created_at: number;
}

function toVersion(row: StrategyVersionRow): StrategyVersion {
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        configHash: row.config_hash,
        createdAt: row.created_at,
    };
}

const SELECT_COLUMNS = 'id, name, description, config_hash, created_at';

/**
 * The version a market's running configuration belongs to, created on first
 * sight.
 *
 * There is deliberately no pre-version row. A placeholder would have been the
 * tidy answer — give every existing measurement a version to point at — but
 * there is nothing to point at: `signal_snapshot` is created empty by the same
 * migration, so a `pre-v1` row would describe a configuration that no
 * snapshot was ever produced under, and a reader would reasonably take it for
 * one that was.
 */
export function createStrategyVersionRepository(): StrategyVersionRepository {
    return {
        async resolveActive(instrument: string): Promise<StrategyVersion> {
            const fingerprint = fingerprintStrategy(
                instrument,
                signalConfigFor(instrument),
            );

            const existing = await query<StrategyVersionRow>(
                `SELECT ${SELECT_COLUMNS} FROM strategy_version WHERE config_hash = $1`,
                [fingerprint.hash],
            );

            const found = existing.rows[0];

            if (found !== undefined) {
                return toVersion(found);
            }

            // `ON CONFLICT DO NOTHING` rather than a check-then-insert: two
            // instances booting together both find nothing, and without it one
            // of them would fail on the unique index and take the whole
            // analysis path down over a bookkeeping row.
            const inserted = await query<StrategyVersionRow>(
                `INSERT INTO strategy_version
                     (created_at, name, description, config, config_hash)
                 VALUES ($1, $2, $3, $4::jsonb, $5)
                 ON CONFLICT (config_hash) DO NOTHING
                 RETURNING ${SELECT_COLUMNS}`,
                [
                    Date.now(),
                    `auto-${fingerprint.hash.slice(0, 8)}`,
                    'Recorded automatically from the running configuration.',
                    JSON.stringify(fingerprint.config),
                    fingerprint.hash,
                ],
            );

            const created = inserted.rows[0];

            if (created !== undefined) {
                return toVersion(created);
            }

            // Lost the race. Re-read rather than fail: the winner's row is the
            // correct answer, and it describes the same configuration.
            const raced = await query<StrategyVersionRow>(
                `SELECT ${SELECT_COLUMNS} FROM strategy_version WHERE config_hash = $1`,
                [fingerprint.hash],
            );

            const winner = raced.rows[0];

            if (winner === undefined) {
                throw new Error(
                    `Could not resolve a strategy version for configuration ` +
                        `${fingerprint.hash}`,
                );
            }

            return toVersion(winner);
        },

        async byId(id: number): Promise<StrategyVersion | null> {
            const result = await query<StrategyVersionRow>(
                `SELECT ${SELECT_COLUMNS} FROM strategy_version WHERE id = $1`,
                [id],
            );

            const row = result.rows[0];

            return row === undefined ? null : toVersion(row);
        },
    };
}

let shared: StrategyVersionRepository | null = null;

export function getStrategyVersionRepository(): StrategyVersionRepository {
    shared ??= createStrategyVersionRepository();

    return shared;
}

/** Test seam: the singleton exists so production shares one, not so tests share rows. */
export function resetStrategyVersionRepository(): void {
    shared = null;
}

/** Exported for the snapshot repository, which needs the same hash function. */
export { hashValue };

export type { PoolClient };
