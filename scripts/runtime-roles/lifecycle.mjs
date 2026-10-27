import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const dir = resolve("data/next-gates/roles89");
const file = process.argv.includes("--baseline")
	? "lease-before.js"
	: "lease.js";
process.env.DATABASE_URL =
	"postgresql://yar89_runtime@127.0.0.1:55489/yar89_disposable";
const { createLease } = await import(pathToFileURL(join(dir, "dist/db", file)));
const connectionString =
	"postgresql://yar89_runtime@127.0.0.1:55489/yar89_disposable";
const a = new pg.Pool({ connectionString, max: 1 }),
	b = new pg.Pool({ connectionString, max: 1 });
const log = { info() {}, warn() {}, error() {} };
const holder = createLease({
	key: "distinct-runtime-handoff",
	logger: log,
	connect: () => a.connect(),
});
const contender = createLease({
	key: "distinct-runtime-handoff",
	logger: log,
	connect: () => b.connect(),
});
const result = { module: file };
try {
	result.holder = (
		await a.query("SELECT pg_backend_pid() pid,current_user role")
	).rows[0];
	result.contender = (
		await b.query("SELECT pg_backend_pid() pid,current_user role")
	).rows[0];
	assert.notEqual(result.holder.pid, result.contender.pid);
	for (let n = 0; n < 20; n++) assert.equal(await holder.ensureHeld(), true);
	assert.equal(await contender.ensureHeld(), false);
	await holder.release();
	result.handoff = await contender.ensureHeld();
	assert.equal(
		result.handoff,
		true,
		"distinct session must lead after one release",
	);
	result.status = "PASS";
} catch (error) {
	result.status = "FAIL";
	result.message = error.message;
	throw error;
} finally {
	await holder.release();
	await contender.release();
	await a.end();
	await b.end();
	writeFileSync(
		join(
			dir,
			process.argv.includes("--baseline")
				? "red-handoff.json"
				: "green-handoff.json",
		),
		JSON.stringify(result, null, 2),
	);
}
