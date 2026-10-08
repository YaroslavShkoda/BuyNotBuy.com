import { z } from 'zod';
import { booleanEnv } from './env.boolean.js';

const WriteSpoolConfigSchema = z.object({
    /**
     * Whether failed database writes are mirrored to a local append-only file.
     * Off, the write paths fall back to their bounded memory buffers alone —
     * the exact behaviour that loses the oldest entries during a long outage.
     */
    enabled: z.boolean(),
    /**
     * Where the per-writer spool files live. Next to the process rather than in
     * a temp directory: the spool's whole job is to outlive the process, and a
     * cleaner script or a reboot that sweeps temp storage would undo it.
     */
    directory: z.string().min(1),
    /**
     * Hard ceiling on one writer's spool file, in bytes. Past it, the oldest
     * entries are evicted and counted as dropped — a ceiling, not a promise of
     * losslessness, so a bound nobody heard of cannot eat the disk.
     */
    maxBytesPerWriter: z.coerce.number().int().positive(),
});

type WriteSpoolConfig = z.infer<typeof WriteSpoolConfigSchema>;

export const writeSpoolConfig: WriteSpoolConfig = WriteSpoolConfigSchema.parse({
    // The spool is the answer to "what happens to the write backlogs when the
    // database is down longer than their bounds" — the answer only works if it
    // is the default, so on it is until someone says otherwise.
    enabled: booleanEnv('WRITE_SPOOL_ENABLED', true),

    directory:
        process.env.WRITE_SPOOL_DIR ??
        './data/spool',

    // Sized from the heaviest series, not the average: a vote batch lands per
    // poll cycle, a few kilobytes apiece, which is a few megabytes a day and
    // roughly a week inside 32 MiB. History and decisions are strictly lighter
    // at the same cadence, so one number serves all three without anyone
    // tuning three.
    maxBytesPerWriter:
        process.env.WRITE_SPOOL_MAX_BYTES ??
        (32 * 1024 * 1024).toString(),
});
