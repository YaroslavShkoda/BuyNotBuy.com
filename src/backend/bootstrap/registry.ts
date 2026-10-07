import type { FastifyInstance } from 'fastify';
import { knownAssets } from '../config/asset.registry.js';
import { marketConfig } from '../config/market.config.js';
import { getAssetRepository } from '../instruments/asset.repository.js';
import { seedConfiguredRegistry } from '../instruments/seed-registry.js';
import { createEvidenceGate } from '../services/promotion-gate.js';
import { getStrategyRuleRepository } from '../strategies/candidate.repository.js';

type Log = FastifyInstance['log'];

/**
 * The registry the process serves, written down before anything is served.
 *
 * Split out of `server.ts` for the same reason the schema check moved: the
 * gate and the seed are conditions on serving, not the act of serving, and a
 * startup that reads top to bottom should show them as two statements rather
 * than as two thirds of a hundred-line function.
 */
export async function prepareRegistry(log: Log): Promise<void> {
    // The evidence gate, attached before anything can promote a rule. Every
    // other entry point — the two research CLIs — reaches the same shared
    // repository and therefore the same gate, because the gate is attached
    // to the singleton rather than to one caller. Attaching it later, or
    // letting a later caller ask for an ungated one, would leave the ladder
    // open on every path that had not been thought about.
    getStrategyRuleRepository(createEvidenceGate());

    // The registry moves into the database, and the configuration stays on
    // top of it: the config is the declaration, this writes it down, and
    // `ON CONFLICT DO NOTHING` means a row a person suspended or a
    // classification learned from data is never quietly reset to the value
    // somebody typed. It runs before the socket opens for the same reason
    // the schema check does — a database that cannot answer "is this asset
    // tradable" should be found at boot, not on the first order.
    //
    // The instrument is written by the same call as the assets on purpose.
    // Seeding only the assets was the live bug: nothing else in the running
    // service wrote `instrument`, so the registry route answered empty beside
    // a correct asset list, and the correctness of that list is what made the
    // emptiness look like an answer.
    const seeded = await seedConfiguredRegistry(
        getAssetRepository(),
        knownAssets,
        marketConfig.symbol,
        marketConfig.symbols,
    );

    log.info(
        {
            event: 'registry_seeded',
            assetsInserted: seeded.assetsInserted,
            instrument: seeded.instrument,
            instrumentInserted: seeded.instrumentInserted,
            // Every market written, so the line says what the process is
            // actually about rather than only what it was configured around.
            instruments: seeded.instruments,
        },
        'registry_seeded',
    );
}
