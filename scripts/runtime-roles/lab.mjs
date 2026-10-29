import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dir = resolve("data/next-gates/roles89"),
	pgBin = "C:/Program Files/PostgreSQL/18/bin";
const helpers = fileURLToPath(new URL(".", import.meta.url));
mkdirSync(dir, { recursive: true });
const cluster = join(dir, "cluster"),
	database = "yar89_disposable",
	owner = "yar89_migrator",
	role = "yar89_runtime";
if (existsSync(cluster)) {
	throw Error(
		"Refusing existing cluster; preserve evidence and dispose the verified own lab first",
	);
}
const evidence = {
	issue: "YAR-89",
	started: new Date().toISOString(),
	commands: [],
	checks: [],
};
const save = () =>
	writeFileSync(join(dir, "results.json"), JSON.stringify(evidence, null, 2));
process.on("exit", (code) => {
	evidence.commandExit = code;
	save();
});
function command(exe, args, env = {}) {
	const log = join(dir, `command-${evidence.commands.length}.log`),
		fd = openSync(log, "w");
	const r = spawnSync(exe, args, {
		encoding: "utf8",
		windowsHide: true,
		stdio: ["ignore", fd, fd],
		env: { ...process.env, ...env },
	});
	closeSync(fd);
	const stdout = readFileSync(log, "utf8");
	evidence.commands.push({ exe, args, exit: r.status, stdout });
	save();
	assert.equal(r.status, 0, stdout);
	return stdout;
}
const connection = (user, db = database) =>
	`postgresql://${user}@127.0.0.1:55489/${db}`;
async function client(user, db = database) {
	const c = new pg.Client({ connectionString: connection(user, db) });
	await c.connect();
	return c;
}
const check = (name, detail) => {
	evidence.checks.push({ name, status: "PASS", detail });
	save();
};
async function denied(c, name, sql, codes = ["42501"]) {
	try {
		await c.query(sql);
		assert.fail(`unexpectedly allowed: ${name}`);
	} catch (e) {
		assert(codes.includes(e.code), `${name}: ${e.code} ${e.message}`);
		check(name, { sql, sqlstate: e.code });
	}
}
let admin, runtime, migrator, backend;
try {
	mkdirSync(cluster, { recursive: true });
	command(join(pgBin, "initdb.exe"), [
		"-D",
		cluster,
		"-U",
		"yar89_admin",
		"--auth=trust",
		"--encoding=UTF8",
		"--locale=C",
	]);
	writeFileSync(
		join(cluster, "pg_hba.conf"),
		"host all all 127.0.0.1/32 trust\n",
	);
	command(join(pgBin, "pg_ctl.exe"), [
		"-D",
		cluster,
		"-l",
		join(dir, "postgres.log"),
		"-o",
		"-p 55489 -h 127.0.0.1",
		"-w",
		"start",
	]);
	admin = await client("yar89_admin", "postgres");
	await admin.query(
		`CREATE ROLE ${owner} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS; CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
	);
	await admin.query(`CREATE DATABASE ${database} OWNER ${owner}`);
	await admin.end();
	admin = await client("yar89_admin");
	await admin.query(
		`REVOKE ALL ON DATABASE ${database} FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${role}; REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO ${owner}; ALTER ROLE ${role} IN DATABASE ${database} SET statement_timeout='5s'; ALTER ROLE ${role} IN DATABASE ${database} SET lock_timeout='500ms'`,
	);
	const env = {
		DATABASE_URL: connection(owner),
		DB_STATEMENT_TIMEOUT_MS: "120000",
		DB_LOCK_TIMEOUT_MS: "30000",
		MARKET_PROVIDER: "mock",
		MARKET_ALLOW_MOCK: "1",
		MARKET_FALLBACK_PROVIDERS: "",
		MARKET_SYMBOLS: "",
		WRITE_SPOOL_DIR: join(dir, "spool"),
		MARKET_POLL_ENABLED: "true",
		MARKET_POLL_INTERVAL_MS: "1000",
		PORT: "30489",
		HOST: "127.0.0.1",
	};
	command(process.execPath, [join(dir, "dist/db/migrate.cli.js")], env);
	migrator = await client(owner);
	await migrator.query(
		`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${role}`,
	);
	// Reviewed application SQL surface. Future tables get no ambient runtime rights.
	const grants = {
		schema_migrations: ["SELECT"],
		asset: ["SELECT", "INSERT", "UPDATE"],
		instrument: ["SELECT", "INSERT", "UPDATE"],
		market_candles: ["SELECT", "INSERT", "UPDATE"],
		signal_history: ["SELECT", "INSERT", "UPDATE", "DELETE"],
		indicator_vote: ["SELECT", "INSERT", "UPDATE", "DELETE"],
		strategy_version: ["SELECT", "INSERT", "UPDATE"],
		signal_snapshot: ["SELECT", "INSERT", "UPDATE"],
		signal_state: ["SELECT", "INSERT", "UPDATE"],
		signal_transition: ["SELECT", "INSERT", "UPDATE", "DELETE"],
		signal_outcome: ["SELECT", "INSERT", "UPDATE"],
		retention_policy: ["SELECT"],
		retention_run: ["SELECT", "INSERT"],
		index_audit: ["SELECT"],
		signal_strategy_version: ["SELECT", "INSERT", "UPDATE"],
		strategy_decision_log: ["SELECT", "INSERT", "UPDATE"],
		holdout_verdict: ["SELECT"],
		rate_limit_window: ["SELECT", "INSERT", "UPDATE", "DELETE"],
	};
	for (const [table, rights] of Object.entries(grants))
		await migrator.query(
			`GRANT ${rights.join(",")} ON TABLE public.${table} TO ${role}`,
		);
	const insertSequences = new Set(
		Object.entries(grants)
			.filter(([, rights]) => rights.includes("INSERT"))
			.map(([table]) => `${table}_id_seq`),
	);
	const sequences = (
		await migrator.query(
			`SELECT sequencename FROM pg_sequences WHERE schemaname='public'`,
		)
	).rows
		.map((x) => x.sequencename)
		.filter((name) => insertSequences.has(name));
	for (const name of sequences)
		await migrator.query(`GRANT USAGE ON SEQUENCE public.${name} TO ${role}`);
	await migrator.query(
		`GRANT EXECUTE ON FUNCTION public.set_market_row_instrument_id() TO ${role}`,
	);
	writeFileSync(
		join(dir, "grants.json"),
		JSON.stringify(
			{
				grants,
				sequences,
				function: "set_market_row_instrument_id()",
				defaultPrivileges:
					"No future tables/sequences automatically granted; no public function execute",
			},
			null,
			2,
		),
	);
	runtime = await client(role);
	evidence.version = (await runtime.query("SELECT version()")).rows;
	evidence.roles = (
		await admin.query(
			`SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname IN ('${owner}','${role}')`,
		)
	).rows;
	evidence.roleSettings = (
		await runtime.query(
			`SELECT current_user,current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout`,
		)
	).rows;
	evidence.migratorSettings = (
		await migrator.query(
			`SELECT current_user,current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout`,
		)
	).rows;
	evidence.owners = (
		await admin.query(
			`SELECT c.relname,pg_get_userbyid(c.relowner) owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','S') ORDER BY 1`,
		)
	).rows;
	assert(evidence.owners.every((x) => x.owner === owner));
	check("runtime owns no application relations", evidence.owners.length);
	for (const [name, sql] of Object.entries({
		create: "CREATE TABLE public.forbidden(id int)",
		schema: "CREATE SCHEMA forbidden",
		temporary: "CREATE TEMP TABLE forbidden(id int)",
		alter: "ALTER TABLE signal_history ADD forbidden int",
		drop: "DROP TABLE signal_history",
		ledgerInsert: "INSERT INTO schema_migrations VALUES(999,'forbidden',0)",
		ledgerUpdate: "UPDATE schema_migrations SET name=name",
		ledgerDelete: "DELETE FROM schema_migrations",
		ledgerTruncate: "TRUNCATE schema_migrations",
		setRole: `SET ROLE ${owner}`,
		setAdmin: "SET ROLE yar89_admin",
		createRole: "CREATE ROLE forbidden",
		grantRole: `GRANT ${owner} TO ${role}`,
		sequenceSet: "SELECT setval('market_candles_id_seq',999)",
	}))
		await denied(runtime, name, sql);
	const times = [];
	for (let n = 0; n < 100; n++) {
		const t = performance.now();
		await runtime.query(
			"SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
		);
		times.push(performance.now() - t);
	}
	times.sort((a, b) => a - b);
	check("normal indexed query latency", {
		count: times.length,
		p50: times[50],
		p95: times[95],
		max: times[99],
	});
	let t = performance.now();
	await denied(runtime, "statement timeout", "SELECT pg_sleep(10)", ["57014"]);
	check("statement cancellation timing", performance.now() - t);
	assert.equal((await runtime.query("SELECT 1 ok")).rows[0].ok, 1);
	check("query succeeds after statement cancellation");
	await migrator.query(
		"BEGIN; LOCK TABLE signal_history IN ACCESS EXCLUSIVE MODE",
	);
	t = performance.now();
	await denied(
		runtime,
		"lock timeout",
		"SELECT * FROM signal_history LIMIT 1",
		["55P03"],
	);
	check("lock cancellation timing", performance.now() - t);
	await migrator.query("ROLLBACK");
	assert.equal((await runtime.query("SELECT 1 ok")).rows[0].ok, 1);
	check("query succeeds after lock cancellation");
	// Synthetic future DDL is separate from the compiled application's ledger.
	await migrator.query(
		"CREATE TABLE public.yar89_future_probe(id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, note text); CREATE FUNCTION public.yar89_future_function() RETURNS int LANGUAGE SQL AS $$ SELECT 1 $$",
	);
	await denied(
		runtime,
		"future object has no ambient SELECT",
		"SELECT * FROM yar89_future_probe",
	);
	await denied(
		runtime,
		"future function has no ambient EXECUTE",
		"SELECT yar89_future_function()",
	);
	await migrator.query(
		`GRANT SELECT,INSERT ON yar89_future_probe TO ${role}; GRANT USAGE ON SEQUENCE yar89_future_probe_id_seq TO ${role}`,
	);
	await runtime.query(
		"INSERT INTO yar89_future_probe(note) VALUES('synthetic lab') RETURNING id",
	);
	assert.equal(
		(await runtime.query("SELECT count(*)::int n FROM yar89_future_probe"))
			.rows[0].n,
		1,
	);
	await denied(
		runtime,
		"future object UPDATE remains denied",
		"UPDATE yar89_future_probe SET note='forbidden'",
	);
	await denied(
		runtime,
		"future object DDL remains denied",
		"ALTER TABLE yar89_future_probe ADD forbidden int",
	);
	check(
		"reviewed future object grants, application ledger snapshot",
		(
			await runtime.query(
				"SELECT max(version) max,count(*)::int count FROM schema_migrations",
			)
		).rows,
	);
	const appEnv = {
		...env,
		DATABASE_URL: connection(role),
		DB_STATEMENT_TIMEOUT_MS: "5000",
		DB_LOCK_TIMEOUT_MS: "500",
		DB_APPLICATION_NAME: "yar89_backend",
	};
	evidence.applicationEnv = { ...appEnv };
	command(
		process.execPath,
		[join(helpers, "spool-writer.mjs"), "--seed"],
		appEnv,
	);
	await migrator.query(
		"BEGIN; LOCK TABLE signal_history IN ACCESS EXCLUSIVE MODE",
	);
	command(process.execPath, [join(helpers, "spool-writer.mjs")], appEnv);
	await migrator.query("ROLLBACK");
	assert(
		readFileSync(join(dir, "spool/signal_history.jsonl"), "utf8").length > 0,
	);
	check("actual restricted write failure durably spooled before process exit");
	const out = await import("node:fs").then((m) =>
		m.openSync(join(dir, "backend.log"), "w"),
	);
	backend = spawn(process.execPath, [join(dir, "dist/server.js")], {
		env: { ...process.env, ...appEnv },
		stdio: ["ignore", out, out],
		windowsHide: true,
	});
	closeSync(out);
	evidence.backendPid = backend.pid;
	save();
	let ready = false;
	for (let n = 0; n < 100; n++) {
		try {
			const r = await fetch("http://127.0.0.1:30489/readyz");
			if (r.ok) {
				ready = true;
				break;
			}
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
	assert(ready, readFileSync(join(dir, "backend.log"), "utf8"));
	check("actual compiled backend boots as restricted runtime");
	assert.equal(
		readFileSync(join(dir, "spool/signal_history.jsonl"), "utf8"),
		"",
	);
	assert(
		readFileSync(join(dir, "backend.log"), "utf8").includes(
			'"historyWritten":1',
		),
	);
	check(
		"fresh compiled backend boot replays failed restricted write exactly once",
	);
	for (const path of [
		"/healthz",
		"/readyz",
		"/api/market",
		"/api/instruments",
	]) {
		const r = await fetch("http://127.0.0.1:30489" + path);
		const body = await r.text();
		assert.equal(r.status, 200, body);
		check(`HTTP ${path}`, { status: r.status, body: body.slice(0, 800) });
	}
	await new Promise((r) => setTimeout(r, 2500));
	for (const table of [
		"asset",
		"instrument",
		"market_candles",
		"signal_history",
		"signal_snapshot",
		"indicator_vote",
		"strategy_decision_log",
		"retention_run",
		"rate_limit_window",
	]) {
		const rows = (await runtime.query(`SELECT count(*)::int n FROM ${table}`))
			.rows;
		assert(rows[0].n > 0, `${table} empty`);
		check(`actual app ${table} rows`, rows);
	}
	assert.equal(
		(
			await runtime.query(
				"SELECT count(*)::int n FROM signal_history WHERE price=65000",
			)
		).rows[0].n,
		1,
	);
	check("real boot replay history survives the actual default retention cycle");
	evidence.appConnections = (
		await admin.query(
			"SELECT usename,application_name,state FROM pg_stat_activity WHERE application_name='yar89_backend'",
		)
	).rows;
	assert(evidence.appConnections.every((x) => x.usename === role));
	check(
		"actual app queries/lease/retention executed",
		readFileSync(join(dir, "backend.log"), "utf8")
			.split("\n")
			.filter((x) => /lease_acquired|registry_seeded|retention_run/.test(x)),
	);
	// Kill only own lab app connections; application pool must establish replacements.
	await admin.query(
		"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND application_name='yar89_backend'",
		[database],
	);
	await new Promise((r) => setTimeout(r, 1800));
	const recovery = await fetch("http://127.0.0.1:30489/readyz");
	assert.equal(recovery.status, 200);
	check("actual backend connection recovery", { status: recovery.status });
	assert.equal(backend.exitCode, null);
	assert(
		readFileSync(join(dir, "backend.log"), "utf8").split(
			'"event":"lease_acquired"',
		).length >= 3,
	);
	check("same backend PID survives, lease reacquired after connection loss", {
		pid: backend.pid,
	});
	command(process.execPath, [join(helpers, "lifecycle.mjs")], appEnv);
	check(
		"distinct restricted sessions hand leadership over after repeated checks and one release",
	);
	evidence.status = "PASS";
	evidence.finished = new Date().toISOString();
	save();
	process.stdout.write(
		JSON.stringify({
			status: "PASS",
			directory: dir,
			checks: evidence.checks.length,
		}) + "\n",
	);
} finally {
	backend?.kill();
	await Promise.allSettled([runtime?.end(), migrator?.end(), admin?.end()]);
}
