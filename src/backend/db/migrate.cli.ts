import { applyMigrations, LATEST_SCHEMA_VERSION } from './migrations.js';
import { closePool } from './pool.js';

try {
    const version = await applyMigrations();
    console.info(`Database schema is at version ${version} (latest: ${LATEST_SCHEMA_VERSION}).`);
} catch (error) {
    console.error('Database migrations failed:', error);
    process.exitCode = 1;
} finally {
    await closePool();
}
