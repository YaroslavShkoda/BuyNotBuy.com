import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { type BrowserContext, chromium, type Page } from 'playwright';
import { InstrumentsResponseSchema, MarketAnalysisSchema, MarketResponseSchema } from '../src/backend/api/schemas.js';
import { auditTerminal } from './terminal-audit.js';

// Real browser + real Next SSR HTTP requests, deterministic market network.
// This fixture intentionally has no DB access: actual backend/PG integration
// belongs to the existing disposable-schema Vitest suite.
const output = process.env.E2E_ARTIFACT_DIR ?? 'data/browser-e2e';
await mkdir(output, { recursive: true });
let scenario: string = 'fresh';
let ethActive = true;
const requests: string[] = [];
const intervals = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const asset = (symbol: string) => ({ symbol, category: 'crypto', status: 'active', source: 'configured' });
const registry = () => InstrumentsResponseSchema.parse({ instruments: ['BTC', 'ETH'].map((base) => ({
    ticker: `${base}USDT`, name: base === 'BTC' ? 'Bitcoin' : 'Ethereum', base: asset(base), quote: asset('USDT'), market: 'crypto', status: base === 'ETH' && !ethActive ? 'inactive' : 'active', tradable: base !== 'ETH' || ethActive, reason: base === 'ETH' && !ethActive ? 'instrument_inactive' : null,
})) });
function fixture(symbol: string, interval: keyof typeof intervals) {
    const step = intervals[interval];
    const closedAt = Math.floor(Date.now() / step) * step - (scenario === 'stale' ? step * 6 : 0);
    const price = symbol === 'ETHUSDT' ? 2500 : 80000;
    const candles = Array.from({ length: 320 }, (_, index) => ({ timestamp: closedAt - (320 - index) * step, open: price + index, high: price + index + 4, low: price + index - 4, close: price + index + 1, volume: 100000 + index }));
    const snapshot = { provider: symbol === 'ETHUSDT' ? 'bitget' : 'binance', symbol, interval, lastBarClosedAt: closedAt, stale: scenario === 'stale', ageMs: scenario === 'stale' ? step * 6 : 100, freshness: scenario === 'stale' ? 'stale' : 'fresh' };
    const base = symbol === 'ETHUSDT' ? 'ETH' : 'BTC';
    const market = MarketResponseSchema.parse({ price: { symbol, price }, candles, interval, snapshot, instrument: { ticker: symbol, base, quote: 'USDT', name: base === 'BTC' ? 'Bitcoin' : 'Ethereum', displaySymbol: `${base}/USDT` } });
    const analysis = MarketAnalysisSchema.parse({ interval, snapshot, timestamp: Date.now(), price,
        explanation: { confidence: { model: 'share', meaning: 'Доля веса голосов за направление.', isProbabilityOfBeingRight: false }, quality: scenario === 'stale' ? { score: 0.2, usable: false, worst: 'stale', blockedBy: ['stale'] } : null },
        indicators: { ema300: price - 20, stochastic: 40, momentum: 1.2, atr: 0.001, rsi: 50, macd: { macd: 2, signal: 1, histogram: 1 } },
        signal: { signal: 'LONG', confidence: 67, reason: 'EMA и Momentum поддерживают LONG', indicators: [ { key: 'ema', name: 'EMA 300', signal: 'LONG', reason: 'Цена выше EMA', weight: 1 }, { key: 'momentum', name: 'Momentum 100', signal: 'LONG', reason: 'Импульс положительный', weight: 1 }, { key: 'stochastic', name: 'Стохастик', signal: 'NEUTRAL', reason: 'Нейтральная зона', weight: 0 } ] },
        momentum: { period: 100, current: 1.2, series: candles.map(() => 1.2) }, divergence: { bullish: null, bearish: null }, periods: { ema: 300, stochastic: 100, momentum: 100, atr: 14, rsi: 14, macdFast: 12, macdSlow: 26, macdSignal: 9 },
    });
    return { market, analysis };
}
const mock = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(url.pathname + url.search);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/instruments') return res.end(JSON.stringify(registry()));
    const interval = (url.searchParams.get('interval') ?? '1h') as keyof typeof intervals;
    const symbol = url.pathname.includes('ETHUSDT') ? 'ETHUSDT' : 'BTCUSDT';
    if (url.pathname.includes('signal-history')) {
        return res.end(JSON.stringify({ entries: [], summary: { currentSignal: null, currentDurationHours: null, currentDurationBounded: true, changes24h: 0, lastTransition: null, previousDurationHours: null, previousDurationBounded: true, sampleHours: 0 }, nextCursor: null }));
    }
    if (/^error-/.test(scenario) || scenario === 'nohistory') {
        res.statusCode = scenario === 'nohistory' ? 503 : Number(scenario.slice(6));
        return res.end(JSON.stringify({ error: { code: scenario === 'nohistory' ? 'MARKET_INSUFFICIENT_HISTORY' : 'MARKET_UNAVAILABLE', message: 'Deterministic browser fixture' } }));
    }
    const values = fixture(symbol, interval);
    res.end(JSON.stringify(url.pathname.endsWith('/analysis') ? values.analysis : values.market));
});
mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
const address = mock.address();
assert(address && typeof address === 'object');
const portProbe = createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const appAddress = portProbe.address();
assert(appAddress && typeof appAddress === 'object');
await new Promise<void>((resolve) => portProbe.close(() => resolve()));
const baseURL = `http://127.0.0.1:${appAddress.port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(appAddress.port), '-H', '127.0.0.1'], { env: { ...process.env, BACKEND_URL: `http://127.0.0.1:${address.port}`, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
// Do not write server environment or raw response data to artifacts.
server.stdout?.resume();
server.stderr?.resume();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results: object[] = [];
const metrics: object[] = [];
let activePage: Page | undefined;
let activeContext: BrowserContext | undefined;
async function check(name: string, run: () => Promise<void>) {
    await run();
    results.push({ name, passed: true });
}
async function visible(page: Page, text: string) {
    await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible' });
}
try {
    for (let attempt = 0; attempt < 120; attempt++) {
        try { if ((await fetch(baseURL, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* startup */ }
        if (attempt === 119) throw new Error('Next production server did not start; run next build first');
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    browser = await chromium.launch({ headless: true });
    for (const device of [{ name: 'desktop', viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false }, { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]) {
        const { name, ...options } = device;
        const context = await browser.newContext({ ...options, locale: 'ru-RU', reducedMotion: 'reduce' });
        activeContext = context;
        // Prevent any client request reaching an unmocked external service.
        await context.route('**/*', (route) => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
        await context.tracing.start({ screenshots: true, snapshots: true });
        await context.addInitScript(() => {
            const state = { lcp: null as number | null, cls: 0, inp: null as number | null, interactions: 0, supported: PerformanceObserver.supportedEntryTypes };
            Object.assign(window, { __labVitals: state });
            if (state.supported.includes('largest-contentful-paint')) new PerformanceObserver((list) => { for (const entry of list.getEntries()) state.lcp = entry.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
            let sessionStart = 0; let lastShift = 0; let sessionValue = 0;
            if (state.supported.includes('layout-shift')) new PerformanceObserver((list) => {
                for (const raw of list.getEntries()) {
                    const entry = raw as PerformanceEntry & { hadRecentInput: boolean; value: number };
                    if (entry.hadRecentInput) continue;
                    if (entry.startTime - lastShift > 1000 || entry.startTime - sessionStart > 5000) { sessionValue = 0; sessionStart = entry.startTime; }
                    sessionValue += entry.value; lastShift = entry.startTime; state.cls = Math.max(state.cls, sessionValue);
                }
            }).observe({ type: 'layout-shift', buffered: true });
            const interactions = new Map<number, number>();
            if (state.supported.includes('event')) new PerformanceObserver((list) => {
                for (const raw of list.getEntries()) {
                    const entry = raw as PerformanceEntry & { interactionId: number };
                    if (entry.interactionId) interactions.set(entry.interactionId, Math.max(interactions.get(entry.interactionId) ?? 0, entry.duration));
                }
                state.interactions = interactions.size;
                state.inp = [...interactions.values()].sort((a, b) => b - a)[Math.floor(interactions.size / 50)] ?? null;
            }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
        });
        const page = await context.newPage(); activePage = page;
        scenario = 'fresh'; ethActive = true;
        for (const cache of ['cold-context', 'warm-reload']) {
            await check(`${name}/${cache}: home, chart, keyboard/touch, vitals`, async () => {
                if (cache === 'cold-context') await page.goto(baseURL, { waitUntil: 'networkidle' });
                else await page.reload({ waitUntil: 'networkidle' });
                assert.match(page.url(), /market\/BTCUSDT/);
                await visible(page, 'Bitcoin');
                const hydrationToggle = page.getByRole('button', { name: 'BTCUSDT' });
                await hydrationToggle.click();
                await page.getByRole('textbox', { name: 'Поиск рынка' }).waitFor();
                const interactiveReadyMs = await page.evaluate(() => performance.now());
                await hydrationToggle.click();
                assert(interactiveReadyMs <= 4000, `Interactive readiness budget: ${interactiveReadyMs}`);
                await page.getByRole('img', { name: /График цены/ }).waitFor();
                const clippedChartContent = await page.evaluate(() => {
                    const selectors = ['.volume-stat-label', '.volume-stat strong', '.interval-option', '.chart-change'];
                    return selectors.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)].flatMap((element) => {
                        const boundary = element.closest(selector.startsWith('.volume') ? '.volume-stat' : '.chart-card');
                        if (!boundary) return [];
                        const limit = boundary.getBoundingClientRect();
                        const range = document.createRange();
                        range.selectNodeContents(element);
                        const clipped = [...range.getClientRects()].some((rect) => rect.width > 0 && (rect.left < limit.left - 1 || rect.right > limit.right + 1));
                        return clipped ? [`${selector}: ${element.textContent}`] : [];
                    }));
                });
                assert.deepEqual(clippedChartContent, [], 'Chart controls, numeric readings and volume labels must fit their containers');
                const chartHeights = await page.evaluate(() => ({
                    plot: document.querySelector('.chart-plot')?.getBoundingClientRect().height ?? 0,
                    svg: document.querySelector('.chart-plot-surface svg')?.getBoundingClientRect().height ?? 0,
                }));
                assert(chartHeights.plot >= 150 && Math.abs(chartHeights.plot - chartHeights.svg) < 1,
                    `Chart SVG and axis coordinate area must share a definite height: ${JSON.stringify(chartHeights)}`);
                const summary = page.locator('summary').filter({ hasText: 'Данные графика в виде таблицы' });
                if (options.hasTouch) {
                    for (const target of [summary, page.getByRole('button', { name: 'BTCUSDT' }), page.getByRole('navigation', { name: 'Таймфрейм графика' }).getByRole('link').first()]) {
                        const bounds = await target.boundingBox();
                        assert(bounds && bounds.height >= 44 && bounds.width >= 44, 'Primary touch controls must offer a 44px target');
                    }
                }
                if (options.hasTouch) await summary.tap(); else { await summary.focus(); await page.keyboard.press('Enter'); }
                assert.equal(await page.locator('.chart-data-alternative').getAttribute('open'), '');
                assert(await page.locator('.chart-data-alternative tbody tr').count() > 0);
                await visible(page, 'не вероятность прибыли');
                assert.equal(await page.locator('html').getAttribute('lang'), 'ru');
                assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= options.viewport.width, 'Page must fit the configured CSS viewport, including on mobile');
                await page.waitForTimeout(500);
                const values = await page.evaluate(() => (window as unknown as { __labVitals: { lcp: number | null; cls: number; inp: number | null; interactions: number; supported: string[] } }).__labVitals);
                assert(values.lcp !== null && values.lcp <= 4000, `${name} LCP budget: ${values.lcp}`);
                assert(values.cls <= 0.1, `${name} CLS budget: ${values.cls}`);
                assert(values.inp === null || values.inp <= 500, `${name} observed interaction budget: ${values.inp}`);
                const resourceTiming = await page.evaluate(() => ({
                    scriptEncodedBytes: performance.getEntriesByType('resource').filter((entry) => (entry as PerformanceResourceTiming).initiatorType === 'script').reduce((total, entry) => total + (entry as PerformanceResourceTiming).encodedBodySize, 0),
                    scriptDecodedBytes: performance.getEntriesByType('resource').filter((entry) => (entry as PerformanceResourceTiming).initiatorType === 'script').reduce((total, entry) => total + (entry as PerformanceResourceTiming).decodedBodySize, 0),
                    domContentLoadedMs: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).domContentLoadedEventEnd,
                }));
                assert(resourceTiming.scriptDecodedBytes <= 1_000_000, 'Route script decoded budget: 1MB');
                metrics.push({ device: name, viewport: options.viewport, cache, ...values, ...resourceTiming, interactiveReadyMs, hydrationLimitation: 'Navigation-to-first-working-React-control upper bound including networkidle; not isolated React hydration duration', kind: 'lab; no throttling; not RUM', inpLimitation: values.inp === null ? 'No Event Timing entry >=16ms; INP unavailable, not zero' : 'Candidate from short scripted interaction sample; not field INP' });
                await page.screenshot({ path: `${output}/${name}-${cache}.png`, fullPage: true });
                await page.evaluate(() => window.scrollTo(0, 0));
                await page.screenshot({ path: `${output}/${name}-${cache}-viewport.png` });
                await writeFile(`${output}/${name}-${cache}-accessibility.txt`, await page.locator('main').ariaSnapshot());
            });
        }
        await check(`${name}: BTC/ETH activation and interval navigation`, async () => {
            const toggle = page.getByRole('button', { name: 'BTCUSDT' });
            if (options.hasTouch) await toggle.tap(); else { await toggle.focus(); await page.keyboard.press('Enter'); }
            await page.getByRole('textbox', { name: 'Поиск рынка' }).fill('Ethereum');
            const eth = page.getByRole('option', { name: /ETHUSDT/ });
            if (options.hasTouch) await eth.tap(); else { await eth.focus(); await page.keyboard.press('Enter'); }
            await page.waitForURL(/market\/ETHUSDT/);
            await visible(page, 'Ethereum');
            for (const [value, label] of [['15m', '15м'], ['4h', '4ч'], ['1d', '1д'], ['1h', '1ч']]) {
                await page.getByRole('navigation', { name: 'Таймфрейм графика' }).getByRole('link', { name: label, exact: true }).click();
                await page.waitForURL(new RegExp(`interval=${value}`));
                await visible(page, 'Ethereum');
            }
            ethActive = false;
            await page.goto(`${baseURL}/market/BTCUSDT`);
            await page.getByRole('button', { name: 'BTCUSDT' }).click();
            assert.equal(await page.getByRole('option', { name: /ETHUSDT/ }).count(), 0);
            ethActive = true;
        });
        await check(`${name}: stale and diagnostic quality alongside LONG`, async () => {
            scenario = 'stale'; await page.goto(`${baseURL}/market/BTCUSDT`);
            await visible(page, 'Опубликованное направление: LONG'); await visible(page, 'Причины непригодности: stale');
            await visible(page, 'не блокирует публикацию направления автоматически');
            await visible(page, 'повтор после сбоя (stale): да');
            await page.screenshot({ path: `${output}/${name}-stale.png`, fullPage: true });
        });
        await check(`${name}: insufficient history recovery`, async () => {
            scenario = 'nohistory'; await page.goto(`${baseURL}/market/BTCUSDT?interval=1d`);
            await page.getByRole('heading', { name: 'Недостаточно исторических данных' }).waitFor();
            await page.screenshot({ path: `${output}/${name}-insufficient.png` });
            scenario = 'fresh'; await page.getByRole('link', { name: '1ч', exact: true }).click();
            await page.getByRole('heading', { name: 'Bitcoin', exact: true }).waitFor();
        });
        for (const code of [429, 502, 503, 504]) await check(`${name}: HTTP ${code} and retry`, async () => {
            scenario = `error-${code}`; await page.goto(`${baseURL}/market/BTCUSDT`);
            await page.getByRole('alert').filter({ hasText: 'MARKET DATA UNAVAILABLE' }).waitFor();
            await page.screenshot({ path: `${output}/${name}-error-${code}.png` });
            scenario = 'fresh'; await page.getByRole('button', { name: 'Попробовать снова' }).click();
            await page.getByRole('heading', { name: 'Bitcoin', exact: true }).waitFor();
        });
        await context.tracing.stop({ path: `${output}/${name}-trace.zip` });
        await context.close(); activeContext = undefined; activePage = undefined;
    }
    if (process.env.TERMINAL_AUDIT === '1') {
        scenario = 'fresh'; ethActive = true;
        const count = await auditTerminal(browser, baseURL, output);
        results.push({ name: 'terminal responsive and accessibility matrix', passed: true, viewports: count });
    }
    assert(requests.some((url) => url.includes('ETHUSDT/analysis?interval=4h')));
    await writeFile(`${output}/report.json`, JSON.stringify({ status: 'passed', browser: browser.version(), results, metrics, requestCount: requests.length, isolation: 'HTTP API fixture, no database or market network' }, null, 2));
    process.stdout.write(`${results.length} browser checks passed. Artifacts: ${output}\n`);
    if (process.env.E2E_PREVIEW === '1') {
        scenario = 'fresh'; ethActive = true;
        await writeFile(`${output}/preview.json`, JSON.stringify({ url: baseURL, fixture: true, runnerPid: process.pid, serverPid: server.pid }));
        process.stdout.write(`Fixture preview: ${baseURL}\n`);
        await new Promise<void>((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    }
} catch (error) {
    await activePage?.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => undefined);
    await activeContext?.tracing.stop({ path: `${output}/failure-trace.zip` }).catch(() => undefined);
    await writeFile(`${output}/report.json`, JSON.stringify({ status: 'failed', message: error instanceof Error ? error.message : String(error), results, metrics }, null, 2));
    throw error;
} finally {
    await browser?.close(); server.kill();
    await new Promise<void>((resolve) => mock.close(() => resolve()));
}
