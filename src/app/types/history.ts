import { z } from 'zod';

import { SignalHistoryResponseSchema } from '../../backend/api/schemas';

// Derived from the schema the backend parses with, for the same reason every
// other wire type is: a mirror drifts silently, a derivation cannot.

export type SignalHistoryResponse = z.infer<typeof SignalHistoryResponseSchema>;

export type SignalHistoryEntry = SignalHistoryResponse['entries'][number];

// Stability context derived from the available sample of hourly snapshots.
// Durations are elapsed hours measured from timestamps, not a record count;
// the bounded flags mark runs that may extend beyond the sample ("at least N
// hours"). `changes24h` really is restricted to the last 24 hours, and
// `sampleHours` is the elapsed span.
export type HistorySummary = SignalHistoryResponse['summary'];

export type SignalHistoryLastTransition = NonNullable<
    HistorySummary['lastTransition']
>;
