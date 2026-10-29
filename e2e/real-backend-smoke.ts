import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { MarketAnalysisSchema, MarketResponseSchema } from '../src/backend/api/schemas.js';

// Opt-in integration: caller owns a disposable DB and a backend configured with
// MARKET_PROVIDER=mock. Never start/migrate an unknown database from a browser test.
assert(process.env.E2E_BACKEND_URL, 'Set E2E_BACKEND_URL to the disposable mock-feed backend');
const backend = new URL(process.env.E2E_BACKEND_URL);
assert(['localhost', '127.0.0.1', '[::1]'].includes(backend.hostname) && backend.protocol === 'http:', 'Only an explicit loopback backend is accepted');
assert(!backend.username && !backend.password && backend.pathname === '/' && !backend.search);
const output = process.env.E2E_ARTIFACT_DIR ?? 'data/browser-e2e/real-backend';
await mkdir(output, { recursive: true });
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const address = probe.address(); assert(address && typeof address === 'object');
await new Promise<void>((resolve) => probe.close(() => resolve()));
const origin = `http://127.0.0.1:${address.port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(address.port), '-H', '127.0.0.1'], { env: { ...process.env, BACKEND_URL: backend.origin, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout?.resume(); server.stderr?.resume();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const checks: object[] = [];
try {
    // Refuse any non-mock backend before issuing browser requests.
    for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
        for (const interval of ['15m', '1h', '4h', '1d']) {
            const url = `${backend.origin}/api/instruments/${symbol}`;
            const marketResponse = await fetch(`${url}/market?interval=${interval}`, { signal: AbortSignal.timeout(10_000) });
            assert.equal(marketResponse.status, 200);
            const market = MarketResponseSchema.parse(await marketResponse.json());
            assert.equal(market.snapshot?.provider, 'mock', 'Disposable integration backend must explicitly use mock feed');
            assert.equal(market.snapshot.symbol, symbol); assert.equal(market.snapshot.interval, interval);
            const analysisResponse = await fetch(`${url}/analysis?interval=${interval}`, { signal: AbortSignal.timeout(10_000) });
            assert.equal(analysisResponse.status, 200);
            const analysis = MarketAnalysisSchema.parse(await analysisResponse.json());
            assert.equal(analysis.snapshot?.provider, 'mock'); assert.equal(analysis.snapshot.symbol, symbol); assert.equal(analysis.snapshot.interval, interval);
            assert.equal(analysis.explanation?.confidence.isProbabilityOfBeingRight, false);
            checks.push({ kind: 'actual HTTP API', symbol, interval, marketStatus: 200, analysisStatus: 200, provider: 'mock' });
        }
    }
    for (let attempt = 0; attempt < 80; attempt++) {
        try { if ((await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* startup */ }
        if (attempt === 79) throw new Error('Production Next server did not start');
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
    await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    await context.tracing.start({ screenshots: true, snapshots: true });
    for (const [symbol, name] of [['BTCUSDT', 'Bitcoin'], ['ETHUSDT', 'Ethereum']]) {
        await page.goto(`${origin}/market/${symbol}`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name, exact: true }).waitFor();
        await page.getByRole('img', { name: /График цены/ }).waitFor();
        assert.equal(await page.getByText(`mock · ${symbol}`, { exact: true }).count(), 2);
        await page.getByText('Только для исследования.', { exact: false }).waitFor();
        await page.locator('summary').filter({ hasText: 'Данные графика в виде таблицы' }).click();
        assert(await page.locator('.chart-data-alternative tbody tr').count() > 0);
        await page.screenshot({ path: `${output}/${symbol}.png`, fullPage: true });
        await writeFile(`${output}/${symbol}-accessibility.txt`, await page.locator('main').ariaSnapshot());
        checks.push({ kind: 'browser → Next → actual mock backend → disposable PG', symbol, passed: true });
    }
    await context.tracing.stop({ path: `${output}/trace.zip` });
    await context.close();
    await writeFile(`${output}/report.json`, JSON.stringify({ status: 'passed', browser: browser.version(), checks, scope: 'Actual mock-feed backend supplied by caller; database provisioning verified separately, not managed by runner' }, null, 2));
    process.stdout.write('Actual-backend browser smoke passed: 8 market+analysis pairs and 2 browser markets.\n');
} catch (error) {
    await writeFile(`${output}/report.json`, JSON.stringify({ status: 'failed', message: error instanceof Error ? error.message : String(error), checks }, null, 2));
    throw error;
} finally {
    await browser?.close(); server.kill();
}
