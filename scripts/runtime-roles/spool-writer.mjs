import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const base = resolve("data/next-gates/roles89/dist");
const service = await import(
	pathToFileURL(base + "/history/signal-history.service.js")
);
const pool = await import(pathToFileURL(base + "/db/pool.js"));
if (process.argv.includes("--seed")) {
	const { prepareRegistry } = await import(
		pathToFileURL(base + "/bootstrap/registry.js")
	);
	await prepareRegistry({ info() {}, warn() {}, error() {} });
	await pool.closePool();
	process.exit(0);
}
await service.recordSignalHistory({
	timestamp: Math.floor(Date.now() / 3600000) * 3600000 - 7200000,
	symbol: "BTCUSDT",
	provider: "mock",
	interval: "1h",
	signal: "NEUTRAL",
	consensus: 0.5,
	price: 65000,
});
const backlog = service.signalHistoryBacklog();
assert.equal(backlog.spooled, 1);
assert.equal(backlog.dropped, 0);
process.stdout.write(
	JSON.stringify({ restrictedRuntimeSpool: backlog }) + "\n",
);
await pool.closePool();
