import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";

const dir = resolve("data/next-gates/roles89"),
	cluster = join(dir, "cluster");
// This command has no host/database override, no .env loading and no filesystem deletion.
const client = new pg.Client({
	connectionString: "postgresql://yar89_admin@127.0.0.1:55489/postgres",
});
await client.connect();
const settings = (
	await client.query(
		"SELECT current_setting('data_directory') dir,current_setting('port') port",
	)
).rows[0];
assert.equal(resolve(settings.dir).toLowerCase(), cluster.toLowerCase());
assert.equal(settings.port, "55489");
assert.equal(
	(
		await client.query(
			"SELECT pg_get_userbyid(datdba) owner FROM pg_database WHERE datname='yar89_disposable'",
		)
	).rows[0]?.owner,
	"yar89_migrator",
);
await client.query(
	"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='yar89_disposable' AND pid<>pg_backend_pid()",
);
await client.query("DROP DATABASE yar89_disposable");
await client.end();
const r = spawnSync(
	"C:/Program Files/PostgreSQL/18/bin/pg_ctl.exe",
	["-D", cluster, "-m", "fast", "-w", "stop"],
	{ encoding: "utf8", windowsHide: true },
);
writeFileSync(
	join(dir, "disposal.json"),
	JSON.stringify(
		{
			database: "yar89_disposable",
			verifiedCluster: settings,
			exit: r.status,
			output: r.stdout + r.stderr,
			time: new Date().toISOString(),
		},
		null,
		2,
	),
);
assert.equal(r.status, 0);
process.stdout.write(
	"Only own yar89_disposable database dropped; own cluster stopped. Evidence files retained.",
);
