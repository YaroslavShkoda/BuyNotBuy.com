/**
 * The three paths that answer no matter what.
 *
 * **This list was written twice, and the two copies had no reason to agree.**
 * It stood here in `routes/health.ts`, exported and read by nobody, while
 * `middleware/rate-limit.plugin.ts` kept its own private `EXEMPT_PATHS` literal
 * with the same three strings. They matched on the day both were written. Nothing
 * in the codebase made that true the next time somebody added a fourth probe —
 * and the way to add one is to add it here, because that is where the reasoning
 * is written down. Following the documented convention would then have
 * introduced precisely the failure the note warns about: a load balancer polling
 * a rate-limited `/healthz` takes every instance out of rotation, and the probe
 * traffic alone is what did it.
 *
 * So the list lives where neither the routes nor the middleware own it, both
 * read it, and a test below asserts that it still matches the routes actually
 * registered. A duplicate literal is only harmless while both sides are edited
 * in the same commit by the same person; this makes the agreement a property of
 * the build instead.
 *
 * It is in `lib/` rather than imported from `routes/health.ts` because that
 * module reaches into the indicator repository, the signal history repository,
 * the migrations and the venue registry. A rate limiter that imported it would
 * carry that whole chain to answer a question about three strings.
 */
export const HEALTH_PATHS = ['/healthz', '/readyz', '/metrics'] as const;

export type HealthPath = (typeof HEALTH_PATHS)[number];

/** Built once. The rate limiter consults it on every request that arrives. */
export const EXEMPT_PATHS: ReadonlySet<string> = new Set<string>(HEALTH_PATHS);