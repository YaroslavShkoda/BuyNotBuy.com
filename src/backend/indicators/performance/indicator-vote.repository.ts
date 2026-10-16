import { historyConfig } from '../../config/history.config.js';
import { marketConfig } from '../../config/market.config.js';
import { query, resolveInstrumentId, withTransaction } from '../../db/pool.js';
import type { CandleInterval } from '../../types/candle-interval.js';
import type {
	ForwardHorizon,
	IndicatorVote,
	SettleUpdate,
	UnsettledVote,
} from './indicator-performance.types.js';
import { FORWARD_HORIZON_NAMES } from './indicator-performance.types.js';

const HOUR_MS = 3_600_000;

/**
 * A vote is stored per hour, matching the signal history it came from. The
 * forward return is what needs a longer horizon, and it is filled in later
 * from the candles rather than guessed now.
 */
const INDICATOR_TABLE = "indicator_vote";

interface IndicatorVoteRepositoryOptions {
	maxEntries: number;
}

/**
 * The interval a vote belongs to, defaulted the way the history repository
 * defaults its series.
 *
 * A vote is a statement about one series at one bar length, and every key this
 * table enforces says so. Defaulting rather than requiring keeps the callsites
 * that only know the configured market unchanged; the analysis path names the
 * interval explicitly, because that is the one caller that can name a second
 * one.
 */
function voteInterval(interval?: CandleInterval): CandleInterval {
	return interval ?? marketConfig.candleInterval;
}

export interface IndicatorVoteRepository {
	record(votes: IndicatorVote[], interval?: CandleInterval): Promise<void>;
	list(symbol: string, limit: number, interval?: CandleInterval): Promise<IndicatorVote[]>;
	/** Votes with at least one horizon still waiting to be filled in. */
	listUnsettled(symbol: string, limit: number, interval?: CandleInterval): Promise<UnsettledVote[]>;
	/** Applies forward returns to stored votes, matched by series, hour and indicator. */
	settle(symbol: string, updates: SettleUpdate[], interval?: CandleInterval): Promise<void>;
	count(symbol: string, interval?: CandleInterval): Promise<number>;
	/**
	 * Whether the store can be read at all, naming no market.
	 *
	 * The readiness check wants to know whether the table exists and is
	 * queryable. It used to ask for `count('BTCUSDT')`, which made the one
	 * question that has no market in it require naming one — and a readiness
	 * probe that hardcodes a market cannot ask about a second one. An empty
	 * table answers this question correctly; `count` answers a different one,
	 * which is how many rows one market has.
	 */
	isReadable(): Promise<boolean>;
}

interface VoteRow {
	timestamp: number;
	symbol: string;
	indicator: string;
	signal: string;
	weight: number;
	price: number;
	fwd_return_1h: number | null;
	fwd_return_4h: number | null;
	fwd_return_24h: number | null;
}

const UPSERT_SQL = `
    INSERT INTO ${INDICATOR_TABLE} (
        symbol, interval, vote_bucket, timestamp, indicator, signal, weight, price,
        fwd_return_1h, fwd_return_4h, fwd_return_24h
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (instrument_id, interval, vote_bucket, indicator) DO UPDATE SET
        timestamp = EXCLUDED.timestamp,
        signal = EXCLUDED.signal,
        weight = EXCLUDED.weight,
        price = EXCLUDED.price
    WHERE EXCLUDED.timestamp > ${INDICATOR_TABLE}.timestamp
`;

/**
 * Keeps the newest `limit` buckets for one series and deletes the rest.
 *
 * Scoped by `symbol` on purpose, and not because the table has one market in it
 * today. An unscoped trim keeps the newest buckets across *every* symbol, so
 * the first vote recorded for one asset silently deletes the other asset's
 * history — no error, no log, and a hit-rate table that quietly loses the asset
 * nobody was looking at. Every other statement in this file already scopes by
 * symbol; this one not doing so was an omission, not a decision.
 *
 * And by `interval`, for the same reason one step down: without it, the first
 * 15m vote of an hour would trim the 1h series' own newest buckets as if they
 * were its own — two series sharing one retention budget, each silently cutting
 * the other.
 */
const TRIM_SQL = `
    DELETE FROM ${INDICATOR_TABLE}
    WHERE instrument_id = $1
      AND interval = $3
      AND vote_bucket NOT IN (
        SELECT DISTINCT vote_bucket
        FROM ${INDICATOR_TABLE}
        WHERE instrument_id = $1
          AND interval = $3
        ORDER BY vote_bucket DESC
        LIMIT $2
    )
`;

const SELECT_SQL = `
    SELECT timestamp, symbol, indicator, signal, weight, price,
           fwd_return_1h, fwd_return_4h, fwd_return_24h
    FROM ${INDICATOR_TABLE}
    WHERE instrument_id = $1
      AND interval = $3
    ORDER BY vote_bucket DESC, indicator
    LIMIT $2
`;

const UNSETTLED_SQL = `
    SELECT timestamp, symbol, indicator, signal, price,
           fwd_return_1h, fwd_return_4h, fwd_return_24h
    FROM ${INDICATOR_TABLE}
    WHERE instrument_id = $1
      AND interval = $3
      AND (fwd_return_1h IS NULL
        OR fwd_return_4h IS NULL
        OR fwd_return_24h IS NULL)
    ORDER BY timestamp DESC, indicator
    LIMIT $2
`;

/**
 * One statement per horizon, because a partial update must never overwrite a
 * horizon that has already been settled with a null, and that cannot be
 * expressed with a single generic SET.
 */
function settleSql(horizon: ForwardHorizon): string {
	return `
        UPDATE ${INDICATOR_TABLE}
        SET fwd_return_${horizon} = $1
        WHERE instrument_id = $2
          AND interval = $5
          AND vote_bucket = $3
          AND indicator = $4
          AND fwd_return_${horizon} IS NULL
    `;
}

export function createIndicatorVoteRepository(
	options: IndicatorVoteRepositoryOptions,
): IndicatorVoteRepository {
	const settleStatements = new Map<ForwardHorizon, string>(
		FORWARD_HORIZON_NAMES.map((horizon) => [horizon, settleSql(horizon)]),
	);

	return {
		async record(votes: IndicatorVote[], interval?: CandleInterval): Promise<void> {
			if (votes.length === 0) {
				return;
			}

			const resolvedInterval = voteInterval(interval);

			// Resolved outside the transaction: the resolver takes its own
			// connection from the pool, and a second connection grabbed while
			// this one is held deadlocks the pool under concurrent batches.
			const instrumentIds = new Map<string, number | null>();
			for (const symbol of [...new Set(votes.map((vote) => vote.symbol))]) {
				instrumentIds.set(symbol, await resolveInstrumentId(symbol));
			}

			// One transaction for the batch: a half-written reading is a
			// reading whose indicators disagree with each other, and the
			// settlement scan would then price horizons off the wrong price.
			await withTransaction(async (client) => {
				for (const vote of votes) {
					await client.query(UPSERT_SQL, [
						vote.symbol,
						vote.interval ?? resolvedInterval,
						Math.floor(vote.timestamp / HOUR_MS),
						vote.timestamp,
						vote.indicator,
						vote.signal,
						Math.round(vote.weight * 100),
						vote.price,
						vote.fwdReturns["1h"] ?? null,
						vote.fwdReturns["4h"] ?? null,
						vote.fwdReturns["24h"] ?? null,
					]);
				}

				// Once per symbol in the batch, not once for the batch. A
				// batch is allowed to carry more than one symbol, and a single
				// pass would trim one market's history against another's. And
				// once per series the batch actually carries: a replayed
				// backlog batch travels with the interval it was recorded
				// under, so the trim cannot cut the configured series with
				// another one's budget.
				const batchIntervals = [
					...new Set(votes.map((vote) => vote.interval ?? resolvedInterval)),
				];

				for (const instrumentId of instrumentIds.values()) {
					if (instrumentId === null) {
						continue;
					}

					for (const trimInterval of batchIntervals) {
						await client.query(TRIM_SQL, [instrumentId, options.maxEntries, trimInterval]);
					}
				}
			});
		},

		async list(symbol: string, limit: number, interval?: CandleInterval): Promise<IndicatorVote[]> {
			const instrumentId = await resolveInstrumentId(symbol);

			if (instrumentId === null) {
				return [];
			}

			const result = await query<VoteRow>(SELECT_SQL, [instrumentId, limit, voteInterval(interval)]);

			return result.rows.map((row) => ({
				timestamp: row.timestamp,
				symbol: row.symbol,
				indicator: row.indicator,
				signal: row.signal as IndicatorVote["signal"],
				weight: row.weight / 100,
				price: row.price,
				fwdReturns: {
					...(row.fwd_return_1h === null ? {} : { "1h": row.fwd_return_1h }),
					...(row.fwd_return_4h === null ? {} : { "4h": row.fwd_return_4h }),
					...(row.fwd_return_24h === null ? {} : { "24h": row.fwd_return_24h }),
				},
			}));
		},

		async listUnsettled(
			symbol: string,
			limit: number,
			interval?: CandleInterval,
		): Promise<UnsettledVote[]> {
			const instrumentId = await resolveInstrumentId(symbol);

			if (instrumentId === null) {
				return [];
			}

			const result = await query<VoteRow>(UNSETTLED_SQL, [instrumentId, limit, voteInterval(interval)]);

			// One entry per vote, not per hour. The three indicators of a
			// reading share a price but not a verdict, and collapsing them
			// here would let the first one decide for all three.
			return result.rows.flatMap((row) => {
				// A column that is missing from the row entirely counts as
				// pending, not as settled: a horizon nobody read back is a
				// horizon nobody filled in, and treating it as done would
				// drop it from every later attempt.
				const pending = FORWARD_HORIZON_NAMES.filter((horizon) => {
					const value = row[`fwd_return_${horizon}` as keyof VoteRow];

					return value === null || value === undefined;
				});

				if (pending.length === 0) {
					return [];
				}

				return [
					{
						symbol: row.symbol,
						timestamp: row.timestamp,
						indicator: row.indicator,
						price: row.price,
						signal: row.signal as UnsettledVote["signal"],
						pending,
					},
				];
			});
		},

		async settle(symbol: string, updates: SettleUpdate[], interval?: CandleInterval): Promise<void> {
			if (updates.length === 0) {
				return;
			}

			const resolvedInterval = voteInterval(interval);
			const instrumentId = await resolveInstrumentId(symbol);

			if (instrumentId === null) {
				return;
			}

			await withTransaction(async (client) => {
				for (const update of updates) {
					const bucket = Math.floor(update.timestamp / HOUR_MS);

					for (const [horizon, value] of Object.entries(update.returns) as [
						ForwardHorizon,
						number,
					][]) {
						if (!Number.isFinite(value)) {
							continue;
						}

						const statement = settleStatements.get(horizon);

						if (statement === undefined) {
							continue;
						}

						// Guarded on the horizon still being null, so a second
						// pass can never rewrite a return that already exists.
						await client.query(statement, [
							value,
							instrumentId,
							bucket,
							update.indicator,
							resolvedInterval,
						]);
					}
				}
			});
		},

		async count(symbol: string, interval?: CandleInterval): Promise<number> {
			const instrumentId = await resolveInstrumentId(symbol);

			if (instrumentId === null) {
				return 0;
			}

			const result = await query<{ total: number }>(
				`SELECT COUNT(*) AS total FROM ${INDICATOR_TABLE}
                 WHERE instrument_id = $1
                   AND interval = $2`,
				[instrumentId, voteInterval(interval)],
			);

			return result.rows[0]?.total ?? 0;
		},

		async isReadable(): Promise<boolean> {
			// LIMIT 1 rather than COUNT(*): a full count on a table that grows
			// forever is work a readiness probe should not do on every call, and
			// the probe does not want a number.
			const result = await query<{ present: number }>(
				`SELECT 1 AS present FROM ${INDICATOR_TABLE} LIMIT 1`,
			);

			return result.rowCount !== null;
		},
	};
}

let repositoryInstance: IndicatorVoteRepository | null = null;

export function getIndicatorVoteRepository(): IndicatorVoteRepository {
	repositoryInstance ??= createIndicatorVoteRepository({
		maxEntries: historyConfig.maxEntries,
	});

	return repositoryInstance;
}
