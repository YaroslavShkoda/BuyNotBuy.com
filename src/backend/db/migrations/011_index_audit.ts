import type { Migration } from './types.js';

export const migration011_index_audit: Migration = {
        version: 11,
        name: 'index_audit',
        sql: `
            -- What each table is actually read for.
            --
            -- Declared rather than discovered, and the difference matters. An
            -- index that exists because a query needed it is evidence; one that
            -- exists because somebody guessed is a cost with no justification
            -- attached. A system that hunts for unused indexes on its own will
            -- eventually drop the one that was never counted as used, because
            -- production traffic is small and that is not evidence of anything.
            CREATE TABLE IF NOT EXISTS index_audit (
                table_name TEXT NOT NULL,
                index_name TEXT NOT NULL,
                -- The query shape the index exists for, in words.
                purpose TEXT NOT NULL,
                -- Which repository method needs it. A named caller can be
                -- checked; "something" cannot.
                required_by TEXT NOT NULL,
                created_at BIGINT NOT NULL,
                PRIMARY KEY (table_name, index_name)
            );
        `,
    };
