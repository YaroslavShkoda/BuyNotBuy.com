import { z } from 'zod';

/**
 * PostgreSQL connection settings, read from the environment at import time.
 *
 * One connection string rather than five separate variables: host, port, user,
 * password and database name travel together, and a half-filled set — a
 * password without a database, a port left at the default for a server that
 * listens elsewhere — is the kind of mistake that only surfaces once a query
 * runs, at a point where the cause is no longer near the cause.
 */
const DatabaseConfigSchema = z.object({
    connectionString: z
        .string()
        .min(1)
        .refine(
            (value) =>
                value.startsWith('postgres://') ||
                value.startsWith('postgresql://'),
            {
                message:
                    'DATABASE_URL must be a postgres:// connection string',
            },
        ),

    /**
     * Connections kept open.
     *
     * The service is one poller plus page loads, so a large pool is never
     * used — and an oversized pool is not free: every connection is a backend
     * process on the PostgreSQL side, and a pool bigger than `max_connections`
     * turns a busy moment into a refused connection.
     */
    poolMax: z.coerce.number().int().positive().max(100),

    /**
     * How long a connection may sit unused before it is closed.
     *
     * Short enough that a database restart is survived by a fresh connection
     * rather than by a pool full of dead sockets.
     */
    idleTimeoutMs: z.coerce.number().int().positive(),

    /**
     * How long establishing one connection may take before it is abandoned.
     *
     * Without it, an unreachable database leaves the first request hanging
     * until the operating system gives up, which is far longer than any client
     * is willing to wait.
     */
    connectionTimeoutMs: z.coerce.number().int().positive(),

    /**
     * Ceiling on one statement, sent to the server as `statement_timeout`.
     *
     * This is what stops a query blocked behind a lock from pinning a pooled
     * connection forever. A client-side timeout would only stop the *waiter*:
     * the server would keep running the statement, and the pool would keep
     * losing a connection to every abandoned one.
     */
    statementTimeoutMs: z.coerce.number().int().positive(),

    /**
     * Ceiling on waiting for a lock, sent to the server as `lock_timeout`.
     *
     * Separate from the statement timeout because the two failures are
     * different: this one means somebody else is mid-write and the answer is
     * "try again shortly", which the write buffer can retry, while the
     * statement timeout means the statement itself is too slow.
     */
    lockTimeoutMs: z.coerce.number().int().positive(),

    /**
     * Reported to PostgreSQL as the client's application name, so a slow
     * query is attributable in `pg_stat_activity` instead of appearing as an
     * anonymous client.
     */
    applicationName: z.string().min(1),
});

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

export const databaseConfig: DatabaseConfig = DatabaseConfigSchema.parse({
    // No default: a service that silently picks a database is a service that
    // will happily write somebody else's history.
    connectionString: process.env.DATABASE_URL ?? '',

    poolMax:
        process.env.DB_POOL_MAX ??
        '10',

    idleTimeoutMs:
        process.env.DB_IDLE_TIMEOUT_MS ??
        '30000',

    connectionTimeoutMs:
        process.env.DB_CONNECT_TIMEOUT_MS ??
        '5000',

    // Comfortably above the slowest query this service runs — an indexed read
    // of a few hundred rows, or a trim of a table that holds thirty days of
    // hourly records — and well below the client timeout, so the server gives
    // up first and says why.
    statementTimeoutMs:
        process.env.DB_STATEMENT_TIMEOUT_MS ??
        '10000',

    lockTimeoutMs:
        process.env.DB_LOCK_TIMEOUT_MS ??
        '5000',

    applicationName:
        process.env.DB_APPLICATION_NAME ??
        'buynotbuy',
});
