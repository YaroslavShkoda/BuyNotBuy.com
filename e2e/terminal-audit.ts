import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import type { Browser } from 'playwright';

export async function auditTerminal(browser: Browser, baseURL: string, output: string) {
    const results: object[] = [];
    for (const width of [360, 390, 768, 1024, 1440, 1920, 720]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'ru-RU', reducedMotion: 'reduce', hasTouch: width <= 768 });
        await context.route('**/*', (route) => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
        try {
            const page = await context.newPage();
            await page.goto(`${baseURL}/market/BTCUSDT`, { waitUntil: 'networkidle' });
            await page.getByRole('heading', { name: 'Bitcoin', exact: true }).waitFor();
            const toggle = page.getByRole('button', { name: 'BTCUSDT' });
            await toggle.focus();
            await page.keyboard.press('Enter');
            await page.getByRole('textbox', { name: 'Поиск рынка' }).waitFor();
            await page.keyboard.press('Escape');
            assert.equal(await toggle.evaluate((element) => element === document.activeElement), true, 'Escape restores focus');
            const summary = page.locator('.chart-data-alternative > summary');
            await summary.focus();
            await page.keyboard.press('Enter');
            const region = page.getByRole('region', { name: 'Таблица значений графика' });
            assert.equal(await region.count(), 1, 'Chart data needs a named keyboard-scrollable region');
            await region.focus();
            await page.keyboard.press('End');
            const geometry = await page.evaluate(() => {
                const main = document.querySelector('.hero-main')?.getBoundingClientRect();
                const side = document.querySelector('.hero-side')?.getBoundingClientRect();
                const scroll = document.querySelector<HTMLElement>('.chart-table-scroll');
                const marker = document.querySelector('.chart-marker');
                const clipped = [...document.querySelectorAll<HTMLElement>('.volume-stat-label, .volume-stat strong, .chart-change, .interval-option, .indicator-row, .candle-table td, .topbar-name')].flatMap((element) => {
                    const parent = element.closest('.volume-stat, .detail-card, .chart-card, .topbar');
                    if (!parent || element.getClientRects().length === 0) return [];
                    const boundary = parent.getBoundingClientRect();
                    const range = document.createRange(); range.selectNodeContents(element);
                    return [...range.getClientRects()].some((rect) => rect.width > 0 && (rect.left < boundary.left - 1 || rect.right > boundary.right + 1)) ? [element.textContent] : [];
                });
                return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, zoom: getComputedStyle(document.querySelector('.app-shell')!).zoom,
                    chartFirst: main !== undefined && side !== undefined && main.top < side.top,
                    clipped, regionWidth: scroll?.clientWidth, regionScrollWidth: scroll?.scrollWidth,
                    animation: marker ? getComputedStyle(marker, '::before').animationName : null,
                    focusOutline: getComputedStyle(document.activeElement!).outlineStyle };
            });
            assert(geometry.scrollWidth <= width, `Page overflow at ${width}: ${JSON.stringify(geometry)}`);
            assert.equal(geometry.zoom, '1', 'Native browser zoom must not combine with CSS zoom');
            if (width <= 1100) assert(geometry.chartFirst, 'Market/chart precedes signal in narrow layout');
            assert.deepEqual(geometry.clipped, [], `Clipped content at ${width}`);
            assert.equal(geometry.animation, 'none', 'Reduced motion disables the infinite marker pulse');
            assert.notEqual(geometry.focusOutline, 'none', 'Scrollable table keeps a visible keyboard focus');
            for (const target of [toggle, summary, page.getByRole('navigation', { name: 'Таймфрейм графика' }).getByRole('link').first()]) {
                const bounds = await target.boundingBox();
                assert(bounds && bounds.width >= 44 && bounds.height >= 44, `44px controls at ${width}`);
            }
            await summary.focus(); await page.keyboard.press('Enter');
            const details = page.locator('.signal-context-details > summary');
            await details.focus(); await page.keyboard.press('Enter');
            await page.keyboard.press('Enter');
            await page.getByRole('link', { name: 'Изучить причины и ограничения' }).click();
            assert(new URL(page.url()).hash === '#research-analysis');
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.mouse.move(0, 0);
            await page.screenshot({ path: `${output}/terminal-${width}.png`, fullPage: true });
            await page.screenshot({ path: `${output}/terminal-${width}-viewport.png` });
            await writeFile(`${output}/terminal-${width}-accessibility.txt`, await page.locator('main').ariaSnapshot());
            results.push({ width, passed: true, ...geometry, note: width === 720 ? '720 CSS px reflow proxy for 1440 at 200%; not actual browser zoom' : 'browser viewport; not physical hardware' });
        } finally { await context.close(); }
    }
    await writeFile(`${output}/terminal-audit.json`, JSON.stringify({ results, realAT: 'NOT_TESTED', hardwareTouch: 'NOT_TESTED' }, null, 2));
    return results.length;
}
