# Database migrations during deployment

Build one backend image and use that same image for both the migration job and
the application rollout. The image contains the compiled migration runner at
`dist/backend/db/migrate.cli.js`; it does not need `tsx` at runtime.

## Deployment order

1. Build and publish the application image.
2. Run one migration job with the production `DATABASE_URL` and wait for exit
   code 0. The job command is `npm run db:migrate`.
3. Deploy the application instances from the same image only after the
   migration job succeeds.

The application checks the schema version before opening its HTTP socket. If
the database is not at the version this build expects, startup fails with an
instruction to run the migration job. Application instances never apply schema
changes themselves.

The migration runner serializes concurrent invocations with a PostgreSQL
advisory lock and commits each migration with its ledger entry in one
transaction. A job can be retried after an uncertain result: already-applied
migrations are skipped.

## Rolling deploy compatibility

During a rolling deployment, old application instances may continue serving
while the migration job and new instances run. Make schema changes compatible
with both versions:

1. Add new nullable columns, tables, or indexes while old code still works.
2. Deploy code that can read the old and new representation, and begin writing
   the new form.
3. Backfill existing rows in a separately controlled operation when needed.
4. Remove old columns or constraints only in a later release, after no old
   application instance uses them.

Avoid bundling an incompatible rename, drop, or required-column change into the
same release that first deploys code expecting it. The migration lock prevents
two migration jobs from applying DDL concurrently; it does not make an
incompatible schema change safe for a rolling application rollout.

For local development, run `npm run db:migrate:dev` before starting the backend.
CI runs the compiled migration job against its PostgreSQL service before the
application verification job.
