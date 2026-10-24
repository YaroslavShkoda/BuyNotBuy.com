import { marketConfig } from '../config/market.config.js';
import { intervalMs } from '../config/market.env.js';
import { closePool } from '../db/pool.js';
import { createCandleRepository } from '../history/candle.repository.js';
import { configuredSeries } from '../history/ingestion.service.js';
import { SUPPORTED_CANDLE_INTERVALS } from '../types/candle-interval.js';
import {
    auditCandleHistory,
    DEFAULT_OUTLIER_THRESHOLD,
    describeIntegrityReport,
} from './history-integrity.js';

/**
 * The stored-history audit, as a command.
 *
 * Reads one series from the candles table, runs the integrity battery over it,
 * and prints the findings. It writes nothing — the repository below is opened
 * for its read methods only, and the module it reports through has no repair
 * path by construction. A run that finds nothing changes nothing; a run that
 * finds something still changes nothing, because the decision about what to do
 * with a hole belongs to a person, not to the tool that noticed it.
 *
 * Exits non-zero when the series has a structural issue or a bar off the UTC
 * grid, so it can gate a pipeline. Outliers are informational: a large move is
 * a finding to look at, not a fault to refuse on.
 */

function optionalNumber(name: string): number | undefined {
    const raw = process.env[name];

    if (raw === undefined || raw.trim() === '') {
        return undefined;
    }

    const value = Number(raw);

    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} должен быть положительным числом, а не «${raw}»`);
    }

    return value;
}

async function main(): Promise<void> {
    const market = (process.env['INTEGRITY_MARKET'] ?? marketConfig.symbol)
        .trim()
        .toUpperCase();
    const intervalRaw = process.env['INTEGRITY_INTERVAL'] ?? marketConfig.candleInterval;
    const interval = SUPPORTED_CANDLE_INTERVALS.find((step) => step === intervalRaw);

    if (interval === undefined) {
        throw new Error(
            `INTEGRITY_INTERVAL=${intervalRaw} не поддерживается. ` +
                `Поддерживаются: ${SUPPORTED_CANDLE_INTERVALS.join(', ')}.`,
        );
    }

    const threshold = optionalNumber('INTEGRITY_OUTLIER_THRESHOLD') ??
        DEFAULT_OUTLIER_THRESHOLD;
    const from = optionalNumber('INTEGRITY_FROM') ?? 0;
    const to = optionalNumber('INTEGRITY_TO') ?? Date.now();

        const key = configuredSeries(market, interval);
        const repository = createCandleRepository();

        try {
            const candles = await repository.getRange(key, from, to, { closedOnly: true });
            const report = auditCandleHistory(candles, intervalMs(interval), threshold);

        console.log(`серия ${key.provider}:${key.symbol}:${key.interval}`);
        for (const line of describeIntegrityReport(report)) {
            console.log(line);
        }

        process.exitCode =
            report.structuralIssue === null && report.misaligned.length === 0 ? 0 : 1;
    } finally {
        await closePool();
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
