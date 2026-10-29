import { marketConfig } from '../config/market.config.js';
import type { VenueCapability } from '../market/capability.js';
import { readHistoricalInventory } from './candle.repository.js';
import type { IntegrityWindow } from './historical-integrity.js';
import { evaluateHistoricalIntegrity, supportedHistoricalSeries } from './historical-integrity.js';

export { HISTORICAL_INVENTORY_SQL } from './candle.repository.js';

/** Compose activation evidence from a repository-owned read-only snapshot. */
export async function inventoryHistoricalIntegrity(window: IntegrityWindow, capabilities: readonly VenueCapability[] = marketConfig.venueCapabilities) {
    const expected = supportedHistoricalSeries(capabilities);
    // Validate before opening the database transaction, including an empty inventory.
    for (const key of expected) evaluateHistoricalIntegrity(key, undefined, window);
    const rows = await readHistoricalInventory();
    const reports = expected.map((key) => evaluateHistoricalIntegrity(key, rows.find((row) => row.provider === key.provider && row.symbol === key.symbol && row.interval === key.interval), window));
    const undeclared = rows.filter((row) => !expected.some((key) => key.provider === row.provider && key.symbol === row.symbol && key.interval === row.interval));
    return { observedAt: window.now, window, provenance: 'stored-attribution-only' as const,
        independentSourceVerification: 'NOT_TESTED' as const,
        activationAllowed: reports.length > 0 && reports.every((report) => report.activationAllowed) && undeclared.length === 0,
        series: reports, undeclared };
}
