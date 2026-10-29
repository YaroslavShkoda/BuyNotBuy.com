-- Compare restored DDL independently of the migration ledger; omit catalog OIDs.
SET search_path = public, pg_catalog;
WITH definitions AS (
    SELECT 'column' AS kind, table_name || '.' || column_name AS name,
           (to_jsonb(c) - ARRAY['table_catalog', 'udt_catalog', 'domain_catalog',
             'scope_catalog', 'collation_catalog', 'character_set_catalog'])::text AS definition
    FROM information_schema.columns c WHERE table_schema = 'public'
    UNION ALL
    SELECT 'constraint', c.conrelid::regclass::text || '.' || c.conname,
           pg_get_constraintdef(c.oid)
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public'
    UNION ALL
    SELECT 'index', tablename || '.' || indexname, indexdef
    FROM pg_indexes WHERE schemaname = 'public'
    UNION ALL
    SELECT 'trigger', t.tgrelid::regclass::text || '.' || t.tgname,
           pg_get_triggerdef(t.oid) || ':enabled=' || t.tgenabled::text
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
    UNION ALL
    SELECT 'function', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
)
SELECT kind, name, md5(definition) FROM definitions
ORDER BY kind COLLATE "C", name COLLATE "C";
