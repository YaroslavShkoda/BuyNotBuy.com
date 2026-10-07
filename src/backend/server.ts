import { createApp } from './app.js';
import { createRuntime } from './bootstrap/runtime.js';

/**
 * The composition root, and nothing else.
 *
 * Everything this file used to do inline — the schema check, the spool
 * replay, the evidence gate, the registry seed, the poller, the ingestion
 * schedulers, the lease, retention, the shutdown order — is a step of
 * bringing a runtime up or down, not a fact about serving HTTP. Those steps
 * live in `bootstrap/`, in the order this file shows when read top to
 * bottom: build the app, build the runtime around it, start.
 */
const app = createApp();
const runtime = await createRuntime(app);

await runtime.start();
