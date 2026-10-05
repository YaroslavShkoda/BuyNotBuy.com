import { appConfig } from '../../config/app.config.js';
import { getPool } from '../../db/pool.js';
import { PostgresRateLimiter } from './rate-limit.js';

/**
 * The limiter production uses, built here rather than by the caller.
 *
 * **This file carries the `.repository.ts` name for the same reason every
 * other database-touching file outside `db/` does.** The limiter's class is
 * database-free — it takes whatever can run the upsert — but something has to
 * hand it the pool, and a middleware was not the place to reach for it. The
 * layering audit declares the seam a repository; a fixed-window counter kept
 * in the database is a store of counters, which is what the word means here.
 */
export const rateLimiter = new PostgresRateLimiter({
    max: appConfig.rateLimitMax,
    windowMs: appConfig.rateLimitWindowMs,

    // The counter lives where every instance of this service already meets:
    // the database. In process memory the budget was the limit times the
    // number of instances; here it is one budget, whoever answers.
    database: getPool(),
});
