import { MarketDataError } from '../errors/market-data.error.js';

import type { MarketDataProvider } from './providers/market-data.provider.js';

import type {
    AssetPrice,
    Candle,
} from '../types/market.js';

/**
 * Two venues, one answer.
 *
 * A backup that is only consulted after the primary has finished failing is
 * not a backup — by then the visitor has already waited through the primary's
 * timeouts and retries. So the switch is immediate: the first call that throws
 * hands over to the next venue for that same request.
 *
 * Once the backup has answered, it stays first for a while. The market poller
 * runs every minute, and retrying a venue that is refusing connections on every
 * one of those adds a timeout to each request for as long as the outage lasts.
 *
 * The cost of that is that the primary is not probed while the backup is
 * healthy, so the primary is not reclaimed until the backup itself fails. That
 * is the right trade for a venue blocked by region, where the primary may never
 * come back at all and every probe would be a timeout: the answer is a working
 * price now, and the primary gets another turn the moment the current venue
 * cannot answer. After a run of primary successes the site moves back.
 */

export interface FailoverProviderOptions {
    /**
     * Consecutive successes on a backup before the primary is tried again.
     *
     * One is not enough: a single lucky request would flip back and flap
     * between venues, and the signal would jump as each venue's own last
     * trade became the last candle. Three is long enough that a venue which
     * answered three times in a row is probably reachable.
     */
    recoverySuccesses?: number;
    /** Test hook: which venue is currently first. */
    onSwitch?: (to: string, reason: string) => void;
}

interface Venue {
    name: string;
    provider: MarketDataProvider;
}

export class FailoverProvider implements MarketDataProvider {
    private readonly primary: Venue;
    private readonly backups: Venue[];
    private readonly recoverySuccesses: number;
    private readonly onSwitch: (to: string, reason: string) => void;

    /** Index into `[primary, ...backups]`; moved to the venue that answered. */
    private preferred = 0;
    private consecutiveBackupSuccesses = 0;

    constructor(
        primary: Venue,
        backups: Venue[],
        options: FailoverProviderOptions = {},
    ) {
        this.primary = primary;
        this.backups = backups;
        this.recoverySuccesses = options.recoverySuccesses ?? 3;
        this.onSwitch = options.onSwitch ?? (() => {});
    }

    /** The venue currently answering. Exposed for the health endpoint. */
    get activeVenue(): string {
        return this.ordered()[this.preferred]?.name ?? this.primary.name;
    }

    async getPrice(): Promise<AssetPrice> {
        return this.run(
            'price',
            (provider) => provider.getPrice(),
        );
    }

    async getCandles(limit?: number): Promise<Candle[]> {
        return this.run(
            'candles',
            (provider) => provider.getCandles(limit),
        );
    }

    async getHistoricalCandles(limit: number): Promise<Candle[]> {
        return this.run(
            'historical candles',
            (provider) => provider.getHistoricalCandles(limit),
        );
    }

    private ordered(): Venue[] {
        return [this.primary, ...this.backups];
    }

    private async run<T>(
        operation: string,
        call: (provider: MarketDataProvider) => Promise<T>,
    ): Promise<T> {
        const venues = this.ordered();
        const failures: Array<{ venue: string; reason: string }> = [];

        // Start at the venue that last worked, and wrap around, so a healthy
        // backup is never made to wait behind a primary that is known to be down.
        for (let step = 0; step < venues.length; step += 1) {
            const index = (this.preferred + step) % venues.length;
            const venue = venues[index];

            if (venue === undefined) {
                continue;
            }

            try {
                const result = await call(venue.provider);

                this.recordSuccess(index, venue.name);

                return result;
            } catch (error) {
                failures.push({
                    venue: venue.name,
                    reason: toReason(error),
                });

                // Only a failure of the primary breaks the recovery run. The
                // backup failing is what starts the run in the first place, so
                // resetting on it would cap the count at one and the site could
                // never be handed back.
                if (index === 0) {
                    this.consecutiveBackupSuccesses = 0;
                }
            }
        }

        throw new MarketDataError(
            `No market data provider could answer for ${operation}`,
            {
                code: 'MARKET_DATA_UNAVAILABLE',
                cause: {
                    operation,
                    attempted: failures,
                },
            },
        );
    }

    private recordSuccess(index: number, venueName: string): void {
        if (index === this.preferred) {
            return;
        }

        if (this.preferred === 0) {
            // The primary could not answer, and something else did.
            this.preferred = index;
            this.consecutiveBackupSuccesses = 0;
            this.onSwitch(venueName, 'primary unavailable');

            return;
        }

        // A backup was in use and the primary has now answered. One success is
        // not enough to move the whole site back: a venue that fails on every
        // other call would otherwise be retried on every poll for the length of
        // the outage, each attempt costing a full timeout before the backup.
        this.consecutiveBackupSuccesses += 1;

        if (this.consecutiveBackupSuccesses >= this.recoverySuccesses) {
            this.preferred = 0;
            this.consecutiveBackupSuccesses = 0;
            this.onSwitch(this.primary.name, 'recovered');
        }
    }
}

function toReason(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }

    return String(error);
}
