import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const dir = resolve("data/next-gates/roles89");
const admin = new pg.Client({
	connectionString: "postgresql://yar89_admin@127.0.0.1:55489/yar89_disposable",
});
await admin.connect();
const rows = async (sql, args) => (await admin.query(sql, args)).rows;
const result = {
	time: new Date().toISOString(),
	acl: await rows(
		`SELECT c.relname,c.relkind,c.relacl::text,pg_get_userbyid(c.relowner) owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','S') ORDER BY 1`,
	),
	functionAcl: await rows(
		`SELECT proname,proacl::text,prosecdef FROM pg_proc WHERE pronamespace='public'::regnamespace`,
	),
	defaultAcl: await rows(
		"SELECT pg_get_userbyid(defaclrole) role,defaclnamespace::regnamespace::text namespace,defaclobjtype,defaclacl::text FROM pg_default_acl",
	),
	memberships: await rows(
		`SELECT pg_get_userbyid(roleid) role,pg_get_userbyid(member) member FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ('yar89_runtime','yar89_migrator'))`,
	),
	database: await rows(
		`SELECT datname,datacl::text FROM pg_database WHERE datname='yar89_disposable'`,
	),
	schema: await rows(
		`SELECT nspname,nspacl::text FROM pg_namespace WHERE nspname='public'`,
	),
};
process.env.DATABASE_URL =
	"postgresql://yar89_runtime@127.0.0.1:55489/yar89_disposable";
process.env.DB_STATEMENT_TIMEOUT_MS = "5000";
process.env.DB_LOCK_TIMEOUT_MS = "500";
process.env.DB_APPLICATION_NAME = "yar89_runtime_probe";
const { getPool, closePool, withTransaction } = await import(
	pathToFileURL(join(dir, "dist/db/pool.js"))
);
const pool = getPool();
result.effectivePoolSettings = (
	await pool.query(
		"SELECT current_user,current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout",
	)
).rows;
const c = await pool.connect();
const started = performance.now();
const sleeper = c.query("SELECT pg_sleep(10)").then(
	() => ({ unexpected: true }),
	(e) => ({
		sqlstate: e.code,
		message: e.message,
		durationMs: performance.now() - started,
	}),
);
await new Promise((r) => setTimeout(r, 200));
result.activeCancellation = await rows(
	"SELECT usename,application_name,state,wait_event_type,wait_event FROM pg_stat_activity WHERE application_name='yar89_runtime_probe'",
);
result.statementCancellation = await sleeper;
assert.equal(result.statementCancellation.sqlstate, "57014");
result.sameConnectionAfter = (
	await c.query("SELECT 1 AS ok,pg_backend_pid() pid")
).rows;
const { createSignalHistoryRepository } = await import(
	pathToFileURL(join(dir, "dist/history/signal-history.repository.js"))
);
const { createRetentionStore } = await import(
	pathToFileURL(join(dir, "dist/db/retention.store.js"))
);
const { cutoffFor } = await import(
	pathToFileURL(join(dir, "dist/db/retention.js"))
);
const retentionDatabase = { query: (text, values) => c.query(text, values) };
const retentionStore = createRetentionStore(retentionDatabase);
const policy = (await retentionStore.listPolicies()).find(
	(row) => row.table === "signal_history",
);
assert.equal(policy.timeColumn, "timestamp");
const retentionNow = Date.now(),
	cutoff = cutoffFor(policy, retentionNow);
const fixtures = [
	{ provider: "yar90_fresh", timestamp: retentionNow },
	{ provider: "yar90_expired", timestamp: cutoff - 1 },
	{ provider: "yar90_boundary", timestamp: cutoff },
	{ provider: "yar90_after_boundary", timestamp: cutoff + 1 },
];
const history = createSignalHistoryRepository({ maxEntries: 720 });
for (const fixture of fixtures)
	await history.record({
		...fixture,
		symbol: "BTCUSDT",
		interval: "1h",
		signal: "NEUTRAL",
		consensus: 50,
		price: 65090,
	});
await c.query("BEGIN");
try {
	const before = (
		await c.query(
			"SELECT provider,timestamp,hour_bucket FROM signal_history WHERE provider=ANY($1)",
			[fixtures.map((row) => row.provider)],
		)
	).rows;
	const report = await retentionStore.prune(retentionNow, [policy]);
	const after = (
		await c.query(
			"SELECT provider FROM signal_history WHERE provider=ANY($1) ORDER BY provider",
			[fixtures.map((row) => row.provider)],
		)
	).rows;
	assert.deepEqual(
		after.map((row) => row.provider),
		["yar90_after_boundary", "yar90_boundary", "yar90_fresh"],
	);
	assert(
		before.every(
			(row) => row.hour_bucket === Math.floor(row.timestamp / 3600000),
		),
	);
	result.retentionCorrectness = {
		status: "PASS",
		role: (await c.query("SELECT current_user role")).rows[0].role,
		policy,
		now: retentionNow,
		cutoff,
		before,
		report,
		after,
		rolledBack: true,
	};
} finally {
	await c.query("ROLLBACK");
}
c.release();
const transactionStarted = performance.now();
result.transactionLoss = await withTransaction(async (transaction) => {
	const pid = (await transaction.query("SELECT pg_backend_pid() pid")).rows[0]
		.pid;
	await admin.query(
		"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND usename=$3",
		[pid, "yar89_disposable", "yar89_runtime"],
	);
	await new Promise((done) => setTimeout(done, 200));
	return "callback returned after session termination";
}).then(
	(value) => ({ unexpected: value }),
	(error) => ({
		sqlstate: error.code,
		durationMs: performance.now() - transactionStarted,
	}),
);
assert.equal(result.transactionLoss.sqlstate, "57P01");
result.afterTransactionLoss = (await pool.query("SELECT 1 ok")).rows;
assert.equal(result.afterTransactionLoss[0].ok, 1);
result.migratorLongQuery = await rows(
	"SELECT rolname,rolconfig FROM pg_roles WHERE rolname='yar89_migrator'",
);
const migrationConnection = new pg.Client({
	connectionString:
		"postgresql://yar89_migrator@127.0.0.1:55489/yar89_disposable",
});
await migrationConnection.connect();
const migrationStarted = performance.now();
await migrationConnection.query("SELECT pg_sleep(5.2)");
result.migratorLongQuery = {
	roleSettings: result.migratorLongQuery,
	completedSleepMs: performance.now() - migrationStarted,
	settings: (
		await migrationConnection.query(
			"SELECT current_user,current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout",
		)
	).rows,
};
await migrationConnection.end();
function tree(path) {
	return readdirSync(path, { withFileTypes: true }).flatMap((x) =>
		x.isDirectory() ? tree(join(path, x.name)) : [join(path, x.name)],
	);
}
result.sourceHashes = Object.fromEntries(
	tree(resolve("src/backend"))
		.filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))
		.sort()
		.map((x) => [
			x,
			createHash("sha256").update(readFileSync(x)).digest("hex"),
		]),
);
result.compiledHashes = Object.fromEntries(
	tree(join(dir, "dist"))
		.filter((x) => x.endsWith(".js"))
		.sort()
		.map((x) => [
			x,
			createHash("sha256").update(readFileSync(x)).digest("hex"),
		]),
);
writeFileSync(
	join(dir, "effective-audit.json"),
	JSON.stringify(result, null, 2),
);
await closePool();
await admin.end();
process.stdout.write(
	"effective ACL, actual pool cancellation, settings and source/compiled hashes saved",
);
