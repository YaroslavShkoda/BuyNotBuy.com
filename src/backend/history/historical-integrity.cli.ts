import { closePool } from '../db/pool.js';
import { inventoryHistoricalIntegrity } from './historical-inventory.js';

try {
    const [from, to] = process.argv.slice(2).map(Number);
    if (from === undefined || to === undefined) throw new Error('Usage: historical-integrity.cli.ts <from-ms> <to-ms>');
    const report = await inventoryHistoricalIntegrity({ now: Date.now(), from, to });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.activationAllowed ? 0 : 1;
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
} finally { await closePool(); }
