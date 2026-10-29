import { notFound } from 'next/navigation';
import { AutoRefresh } from '../../components/auto-refresh';
import { Hero } from '../../components/hero';
import { IntervalSwitcher } from '../../components/interval-switcher';
import { MarketDetails } from '../../components/market-details';
import { ResearchContext } from '../../components/research-context';
import { RetryButton } from '../../components/retry-button';
import { Topbar } from '../../components/topbar';
import { getAnalysis } from '../../lib/analysis';
import { getSignalHistory } from '../../lib/history';
import { getInstruments } from '../../lib/instruments';
import {
    intervalHref,
    intervalLabel,
    isInsufficientHistoryError,
    isMarketUnavailableError,
    normalizeInterval,
} from '../../lib/interval';
import { getMarket } from '../../lib/market';

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settle<T>(request: Promise<T>): Promise<Outcome<T>> {
    try {
        return { ok: true, value: await request };
    } catch (error) {
        return { ok: false, error };
    }
}

export default async function MarketPage({
    params,
    searchParams,
}: {
    params: Promise<{ symbol: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { symbol } = await params;
    const { interval: rawInterval } = await searchParams;
    const instrument = symbol.trim().toUpperCase();
    const interval = normalizeInterval(rawInterval);

    // The registry decides membership before any data request: a typo in the
    // URL must answer 404, not the provider's 502 for a market nobody serves.
    // A failed registry read degrades to "no verdict" and lets the data
    // requests decide, the same way the history request already degrades.
    const instruments = await getInstruments().catch(() => null);

    if (instruments !== null && !instruments.some((row) => row.ticker === instrument)) {
        notFound();
    }

    const marketLinks = (instruments ?? [])
        .filter((row) => row.status === 'active')
        .map((row) => ({
            ticker: row.ticker,
            // The registry's name travels with the link, so the switcher
            // searches "Solana" without keeping its own symbol-to-name list.
            name: row.name ?? undefined,
            href: intervalHref(row.ticker, interval),
            active: row.ticker === instrument,
        }));

    // Signal history is a non-critical request: if it fails, the dashboard
    // must still render and the history block shows an unavailable state.
    const [analysisOutcome, marketOutcome, history] = await Promise.all([
        settle(getAnalysis(instrument, interval)),
        settle(getMarket(instrument, interval)),
        getSignalHistory(instrument, interval).catch(() => null),
    ]);

    const insufficientHistory =
        (!analysisOutcome.ok && isInsufficientHistoryError(analysisOutcome.error)) ||
        (!marketOutcome.ok && isInsufficientHistoryError(marketOutcome.error));

    if (insufficientHistory) {
        return (
            <main className="app-shell">
                <AutoRefresh />

                <Topbar updatedAt={0} markets={marketLinks} />

                <div className="content-stack">
                    <section className="state-card depth-surface">
                        <span className="eyebrow">INSUFFICIENT HISTORY</span>

                        <h1>Недостаточно исторических данных</h1>

                        <p>
                            Таймфрейм {intervalLabel(interval)} для {instrument} пока
                            недоступен: история торгов короче окна, которое требует
                            анализ. Выберите другой таймфрейм.
                        </p>

                        <IntervalSwitcher symbol={instrument} interval={interval} />
                    </section>
                </div>
            </main>
        );
    }

    // A temporary outage from one request must not hide a broken contract or
    // internal failure from the other. The insufficient-history state above
    // retains its existing priority.
    if (!analysisOutcome.ok && !isMarketUnavailableError(analysisOutcome.error)) throw analysisOutcome.error;
    if (!marketOutcome.ok && !isMarketUnavailableError(marketOutcome.error)) throw marketOutcome.error;

    const marketUnavailable =
        (!analysisOutcome.ok && isMarketUnavailableError(analysisOutcome.error))
        || (!marketOutcome.ok && isMarketUnavailableError(marketOutcome.error));

    if (marketUnavailable) {
        return (
            <main className="app-shell">
                <AutoRefresh />
                <Topbar updatedAt={0} markets={marketLinks} />
                <div className="content-stack">
                    <section className="state-card depth-surface" role="alert">
                        <span className="eyebrow">ДАННЫЕ ВРЕМЕННО НЕДОСТУПНЫ</span>
                        <h1>Данные рынка временно недоступны</h1>
                        <p>
                            Источник котировок не ответил по {instrument} на таймфрейме{' '}
                            {intervalLabel(interval)}. Запрос повторится автоматически,
                            реальные данные не подменяются заглушками.
                        </p>
                        <IntervalSwitcher symbol={instrument} interval={interval} />
                        <RetryButton />
                    </section>
                </div>
            </main>
        );
    }

    if (!analysisOutcome.ok) throw analysisOutcome.error;
    if (!marketOutcome.ok) throw marketOutcome.error;

    const analysis = analysisOutcome.value;
    const market = marketOutcome.value;

    if (analysis.interval !== interval || market.interval !== interval) {
        throw new Error(
            `Backend answered ${analysis.interval}/${market.interval} for an interval=${interval} request`,
        );
    }

    return (
        <main className="app-shell">
            {/* The page is server-rendered, so without this the price on screen
                is whatever it was at the moment the tab was opened, and stays
                there. */}
            <AutoRefresh />

            <Topbar
                updatedAt={analysis.timestamp}
                markets={marketLinks}
            />

            <div className="content-stack">
                <Hero
                    analysis={analysis}
                    history={history}
                    candles={market.candles}
                    symbol={market.price.symbol}
                    instrument={market.instrument}
                    ema300={analysis.indicators.ema300}
                    interval={interval}
                    marketSnapshot={market.snapshot}
                />
                <MarketDetails
                    candles={market.candles}
                    analysis={analysis}
                    symbol={market.price.symbol}
                    quote={market.instrument?.quote ?? null}
                />
                <ResearchContext interval={analysis.interval} timestamp={analysis.timestamp} lastBar={undefined} snapshot={analysis.snapshot} explanation={analysis.explanation} direction={analysis.signal.signal} />
                <ResearchContext label="График" interval={market.interval} timestamp={Date.now()} lastBar={market.candles.at(-1)?.timestamp} snapshot={market.snapshot} />
            </div>
        </main>
    );
}
