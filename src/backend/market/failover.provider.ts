import { MarketDataError } from '../errors/market-data.error.js';
import { ProviderError, statusForKind } from '../errors/provider.error.js';

import type { MarketDataProvider, ProviderCandles } from './providers/market-data.provider.js';
import type { ProviderFailureKind } from '../errors/provider.error.js';

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
    /**
     * The chain itself.
     *
     * Named after what it is rather than after the configured primary: this
     * object *is* "the market data provider" from every caller's point of view,
     * and a `name` of `binance` on a wrapper whose backup is currently answering
     * would be a lie that gets stored alongside a signal.
     */
    readonly name = 'failover';

    /**
     * The symbol the chain was asked for.
     *
     * The primary's, deliberately. The backup may be configured with a different
     * ticker, and the envelope reports the requested symbol so a mismatch is
     * visible as a mismatch rather than silently relabelling one asset's price as
     * another's.
     */
    readonly symbol: string;

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
        this.symbol = primary.provider.symbol;
    }

    /** The venue currently answering. Exposed for the health endpoint. */
    get activeVenue(): string {
        return this.ordered()[this.preferred]?.name ?? this.primary.name;
    }

    /**
     * Whether a switch happened at all — which is what tells a caller whether
     * the price came from where it was asked for.
     *
     * Null when there is nothing to switch, so a caller cannot report a "venue"
     * that was never a choice. Separate from `activeVenue` because "binance" is
     * the right answer both when the chain asked binance and when it asked
     * bitget and got it, and those two are the whole question.
     */
    get switched(): boolean {
        return this.preferred !== 0;
    }

    /** Every venue in the chain, primary first. */
    get venues(): readonly string[] {
        return this.ordered().map((venue) => venue.name);
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

    /**
     * Attribution survives the switch, which is the entire reason it exists.
     *
     * `getCandles` cannot carry it — its callers are the backtest and the price
     * path — but the snapshot path has to know which venue's last trade became
     * the chart, or a failover is indistinguishable from a market move. So the
     * venue travels with the candles instead of being read back off `preferred`
     * afterwards, which would attribute a snapshot to whichever request happened
     * to move the index last.
     */
    async getAttributedCandles(limit?: number): Promise<ProviderCandles> {
        const { venue, value } = await this.runAttributed(
            'candles',
            (provider) => provider.getAttributedCandles(limit),
        );

        // A venue that already reports its own name is trusted; the wrapper's
        // name is only a fallback for a provider that does not implement the
        // attributed method. Trusting it over the real one would relabel a
        // Bitget snapshot as "failover" and lose exactly the attribution this
        // method exists to keep.
        return { ...value, venue: value.venue === '' ? venue : value.venue };
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
        const { value } = await this.runAttributed(operation, call);

        return value;
    }

    /**
     * The chain, returning who answered.
     *
     * The venue comes out of the loop rather than being read from `preferred`
     * afterwards. Those two disagree the moment two requests overlap — the
     * snapshot path is single-flighted, but the price path is not, and a
     * `getPrice` that switches the index between the candles arriving and the
     * caller asking would attribute a Binance snapshot to Bitget. The loop is
     * the only place where the answer to "which venue" and the answer to "what
     * did it return" are still the same fact.
     */
    private async runAttributed<T>(
        operation: string,
        call: (provider: MarketDataProvider) => Promise<T>,
    ): Promise<{ venue: string; value: T }> {
        const venues = this.ordered();
        const failures: VenueFailure[] = [];

        // Start at the venue that last worked, and wrap around, so a healthy
        // backup is never made to wait behind a primary that is known to be down.
        for (let step = 0; step < venues.length; step += 1) {
            const index = (this.preferred + step) % venues.length;
            const venue = venues[index];

            if (venue === undefined) {
                continue;
            }

            try {
                const value = await call(venue.provider);

                this.recordSuccess(index, venue.name);

                return { venue: venue.name, value };
            } catch (error) {
                failures.push(toVenueFailure(venue.name, error));

                // Only a failure of the primary breaks the recovery run. The
                // backup failing is what starts the run in the first place, so
                // resetting on it would cap the count at one and the site could
                // never be handed back.
                if (index === 0) {
                    this.consecutiveBackupSuccesses = 0;
                }
            }
        }

        // The chain's own failure is typed too, and it is the venue's failure
        // rather than a new one: the caller asked a wrapper, the wrapper asked
        // everyone, and the honest answer describes the answers it got.
        //
        // Which of those answers matters. "Every venue throttled" and "every
        // venue unreachable" both reach a client as 503, and they call for
        // opposite responses — the first will clear on its own, the second is a
        // network or a deploy. Carrying each venue's `kind` and status is what
        // separates them without anyone reading an English sentence about it.
        const kind = aggregateKind(failures);

        throw new ProviderError(
            kind,
            `No market data provider could answer for ${operation}`,
            {
                statusCode: aggregateStatus(failures, kind),
                context: {
                    provider: this.name,
                    details: {
                        operation,
                        // The venue list travels with the failure so a log line
                        // says "binance 429, bitget timeout" rather than "no
                        // provider could answer" — the difference between
                        // knowing which one to fix and having to reproduce it.
                        venues: venues.map((entry) => entry.name),
                        attempted: failures,
                    },
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

/**
 * One venue's answer to one call.
 *
 * `reason` is for a human reading a log. `kind` and `code` are for a program,
 * and they are the reason this object exists rather than a bare string: a chain
 * that fails on two venues has to be able to say what kind of failure each one
 * produced without a reader reconstructing it from prose.
 */
interface VenueFailure {
    venue: string;
    reason: string;
    kind: ProviderFailureKind | null;
    code: string | null;
    httpStatus: number | null;
}

function toVenueFailure(venue: string, error: unknown): VenueFailure {
    return {
        venue,
        reason: toReason(error),
        kind: error instanceof ProviderError ? error.kind : null,
        code: error instanceof MarketDataError ? error.code : null,
        httpStatus: error instanceof ProviderError ? error.httpStatus ?? null : null,
    };
}

/**
 * The kind that describes the chain as a whole.
 *
 * A throttle wins over an outage, and it is the more urgent answer: if every
 * venue is rate limited the cause is a caller of ours, and saying "unavailable"
 * would point an operator at the network instead of at the request rate that
 * provoked it. A single unclassified failure leaves the chain looking like a
 * timeout rather than like the impossible thing — an error this code has never
 * seen — because "we do not know" should not read as "we know it was slow".
 */
function aggregateKind(failures: readonly VenueFailure[]): ProviderFailureKind {
    const kinds = new Set(failures.map((entry) => entry.kind));

    if (kinds.has('rate_limited')) {
        return 'rate_limited';
    }

    if (kinds.has('timeout') && kinds.has('unavailable')) {
        return 'unavailable';
    }

    if (kinds.has('timeout')) {
        return 'timeout';
    }

    return 'unavailable';
}

/**
 * The status a client sees.
 *
 * 504 only when every venue said so. A timeout on the primary and a refusal on
 * the backup is not a gateway timeout — there is nothing to wait for, and
 * telling a client to retry in a second while the backup is still refusing is
 * how a rate limit gets earned.
 */
function aggregateStatus(
    failures: readonly VenueFailure[],
    kind: ProviderFailureKind,
): number {
    if (kind === 'timeout' && failures.length > 0 && failures.every((entry) => entry.kind === 'timeout')) {
        return statusForKind('timeout');
    }

    return statusForKind(kind);
}

function toReason(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }

    return String(error);
}
