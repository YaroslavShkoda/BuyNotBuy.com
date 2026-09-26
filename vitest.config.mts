import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Order matters. The database has to be redirected before any module
        // reads HISTORY_DB_PATH at import time, and the network guard has to be
        // in place before a test replaces fetch with its own stub — a stub
        // installed over the guard would quietly reopen the network.
        setupFiles: [
            './src/backend/test-support/test-database.ts',
            './src/backend/test-support/no-network.ts',
        ],
    },
});
