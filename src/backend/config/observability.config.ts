import { z } from 'zod';

const ObservabilityConfigSchema = z.object({
    /**
     * Where a request id may be taken from when the client supplies one.
     *
     * Accepted only from this header, never from a query string: a query
     * parameter ends up in access logs and proxy logs everywhere the request
     * goes, so a client-supplied id there is a value we would be publishing.
     */
    requestIdHeader: z.string().min(1).regex(/^[A-Za-z0-9-]+$/),

    /**
     * A client id that is not a sane length and not printable is not an id,
     * it is an attempt to write whatever into every log line. Over-long ids
     * are dropped rather than truncated: a cut-off id matches nothing when
     * someone goes looking for it.
     */
    requestIdMaxLength: z.coerce.number().int().min(8).max(512),

    /**
     * How many distinct label values a metric keeps per series.
     *
     * Unbounded label cardinality is how a metrics endpoint takes the process
     * down: every new symbol or request path would add a permanent series.
     */
    metricLabelLimit: z.coerce.number().int().min(4).max(64),
});

export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;

export const observabilityConfig: ObservabilityConfig = ObservabilityConfigSchema.parse({
    requestIdHeader:
        process.env.OBSERVABILITY_REQUEST_ID_HEADER ??
        'x-request-id',

    requestIdMaxLength:
        process.env.OBSERVABILITY_REQUEST_ID_MAX_LENGTH ??
        '128',

    metricLabelLimit:
        process.env.OBSERVABILITY_METRIC_LABEL_LIMIT ??
        '32',
});
