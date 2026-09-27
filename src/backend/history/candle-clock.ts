/**
 * When a bar is finished, in one place.
 *
 * A bar is labelled by the moment it opened, so "is this bar closed" is not a
 * question about its data at all — it is a question about the clock and the
 * interval. Answering it anywhere else is how the same bar ends up closed in
 * one place and forming in another, and every downstream consumer inherits
 * whichever one it happened to ask.
 *
 * The distinction matters because a forming bar is not a bar. Its close moves
 * until the hour is over, so a signal computed on it cannot be reproduced: the
 * same input URL returns a different answer every second, and a result
 * measured against it is measured against something that no longer exists.
 */

export interface CandleClock {
    /** The interval in milliseconds. */
    readonly intervalMs: number;
}

/**
 * When the bar opened at `timestamp`.
 *
 * For a well-formed series this is `timestamp` itself, and it is kept as a
 * function because the venue labels bars its own way and the question is worth
 * one name rather than a subtraction repeated at each call site.
 */
export function candleOpenTime(candle: CandleClock, timestamp: number): number {
    return timestamp;
}

/** When the bar at `timestamp` is finished. */
export function candleCloseTime(candle: CandleClock, timestamp: number): number {
    return candleOpenTime(candle, timestamp) + candle.intervalMs;
}

/**
 * Whether the bar at `timestamp` is finished.
 *
 * Exactly at the closing instant the bar is done: `[open, close)`. One second
 * earlier it is still forming. The boundary is a real boundary, and rounding
 * it either way puts a bar that moved for the last hour into the measured
 * history a second early or a second late.
 */
export function isCandleClosed(
    candle: CandleClock,
    timestamp: number,
    now: number,
): boolean {
    return now >= candleCloseTime(candle, timestamp);
}

/** Milliseconds elapsed inside the bar that contains `now`. */
function elapsedInBar(candle: CandleClock, now: number): number {
    return (
        ((now % candle.intervalMs) + candle.intervalMs) % candle.intervalMs
    );
}

/**
 * The opening time of the bar that is forming right now.
 *
 * Returns null when `now` sits exactly on a boundary and therefore inside no
 * bar at all — an instant that lasts one millisecond and is the reason a naive
 * `floor` occasionally produces a timestamp the venue has no bar for.
 */
export function formingCandleTime(
    candle: CandleClock,
    now: number,
): number | null {
    const elapsed = elapsedInBar(candle, now);

    return elapsed === 0 ? null : now - elapsed;
}

/**
 * The opening time of the newest bar that is finished.
 *
 * The bar before the one in progress, whichever side of the boundary `now`
 * falls on. Deriving it from `now + interval` instead — the obvious "close the
 * bar that is open and step back" — returns `now` itself, which is the bar
 * still moving, and would quietly hand every reader the forming bar under a
 * name that promises it is not one.
 */
export function lastClosedCandleTime(
    candle: CandleClock,
    now: number,
): number {
    const elapsed = elapsedInBar(candle, now);

    return now - elapsed - candle.intervalMs;
}

/**
 * How long until the bar forming now is finished.
 *
 * Rounded up, because a schedule that fires at `close - 0` fires on the wrong
 * side of the boundary: the last millisecond of the old bar, with the new
 * price not yet published. Rounding down is the same mistake in the other
 * direction and is much harder to notice, because it is simply early.
 */
export function msUntilNextClose(candle: CandleClock, now: number): number {
    return candle.intervalMs - (now % candle.intervalMs);
}

/**
 * How often to look, given how long a bar takes.
 *
 * A bar is only worth looking for after it closes, so a period longer than the
 * interval would be looking for a bar that cannot exist. A period that is a
 * fraction of the interval, though, is what turns a missed tick into a delayed
 * one rather than a lost bar: a single slow provider call costs one cycle, not
 * an hour of history.
 *
 * The cap exists because a sub-minute interval would otherwise produce a poll
 * measured in milliseconds, and a poll that fast is a request loop.
 */
export function ingestionPeriodMs(
    intervalMs: number,
    capMs: number,
): number {
    const fraction = Math.max(1, Math.floor(intervalMs / 8));

    return Math.max(1_000, Math.min(intervalMs, fraction, capMs));
}
