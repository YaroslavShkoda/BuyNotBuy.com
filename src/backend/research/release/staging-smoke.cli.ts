// Read-only HTTP probes restricted to a loopback lab. No deployment or cutover.
const base = new URL(process.env.LAB_BACKEND_URL ?? 'http://127.0.0.1:3301');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) {
    throw new Error('LAB_BACKEND_URL must be an unauthenticated loopback URL');
}
const evidence: Array<Record<string, unknown>> = [];
const paths = [
    '/healthz', '/readyz', '/api/instruments', '/api/market', '/api/analysis',
    '/api/instruments/BTCUSDT/market', '/api/instruments/ETHUSDT/market',
    '/api/instruments/ETHUSDT/analysis', '/api/instruments/UNKNOWN/market',
];
for (const path of paths) {
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(15_000) });
    const body = await response.json() as Record<string, unknown>;
    const expected = path.includes('UNKNOWN') ? 404 : 200;
    if (response.status !== expected) throw new Error(`${path}: expected ${expected}, received ${response.status}`);
    const snapshot = body.snapshot as { symbol?: string; provider?: string; interval?: string } | undefined;
    if (snapshot !== undefined) {
        const expectedSymbol = path.includes('ETHUSDT') ? 'ETHUSDT' : 'BTCUSDT';
        if (snapshot.symbol !== expectedSymbol || snapshot.provider !== 'mock' || snapshot.interval !== '1h') {
            throw new Error(`${path}: unexpected lab snapshot identity`);
        }
    }
    evidence.push({ path, status: response.status, snapshot: snapshot ?? null,
        ...(path === '/healthz' || path === '/readyz' ? { body } : {}) });
}
const metrics = await fetch(new URL('/metrics', base), { signal: AbortSignal.timeout(15_000) });
const metricText = await metrics.text();
if (metrics.status !== 200 || !metricText.includes('# HELP')) throw new Error('metrics not exposed');
evidence.push({ path: '/metrics', status: metrics.status, prometheusExposition: true });
console.info(JSON.stringify({
    format: 'staging-lab-smoke/1', checkedAt: new Date().toISOString(),
    environment: 'loopback-synthetic', productionOrRemoteStaging: 'NOT_TESTED',
    artifact: 'base commit plus uncommitted changes; health deploySha alone is not a dirty-tree fingerprint',
    evidence,
}, null, 2));
