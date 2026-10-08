import { z } from 'zod';
import type { MetricConfig } from './metrics.js';
import {
    DEFAULT_METRIC_CONFIG,
    METRIC_COUNTERS,
    METRIC_DISTRIBUTIONS,
    METRIC_GAUGES,
    metricKind,
    Reservoir,
} from './metrics.js';

/**
 * The metrics the roadmap named, kept apart by kind, and rendered.
 *
 * Three kinds because they mean different things and collapsing them loses
 * that. A counter answers "how many times", a gauge answers "how much right
 * now", a distribution answers "how bad, and how often that bad". The
 * distinction is not bookkeeping: `provider_circuit_open` as a counter is a
 * number that climbs every time a breaker opens, and a reader who treats it as
 * a counter learns that the circuit is "17 open" when in fact it is either open
 * or it is not.
 *
 * Labels are rendered in a fixed order, sorted, so two scrapes of an unchanged
 * system produce byte-identical output. Prometheus treats a time series as a
 * different series when its label set differs in order, and a registry that
 * renders labels in whatever order a `Map` happened to iterate would invent a
 * new series on every process start.
 */

const LABEL_VALUE_PATTERN = /^[a-zA-Z0-9_.:\-/]{0,64}$/;

/**
 * A label value that would break the exposition.
 *
 * A quote, a backslash or a newline in a label value can inject arbitrary
 * lines into a Prometheus scrape, which is how a symbol name or a provider
 * string becomes somebody else's metric. Rejected rather than escaped: nothing
 * in this system legitimately needs those characters in a label, and a
 * legitimate value that gets rejected is visible, while a hostile one that gets
 * escaped is a line you have to notice.
 */
export function labelValue(name: string, value: string): string {
    if (value === '' || LABEL_VALUE_PATTERN.test(value)) {
        return value;
    }

    throw new Error(
        `Метка "${name}" содержит недопустимое значение: значение метрики попадает в текст экспозиции, поэтому оно ограничено алфавитом, цифрами и "_.:-/".`,
    );
}

export interface SeriesKey {
    readonly name: string;
    /** Sorted, so the rendered order never depends on insertion order. */
    readonly labels: Readonly<Record<string, string>>;
}

export function seriesKey(name: string, labels: Record<string, string> = {}): string {
    const entries = Object.entries(labels)
        .map(([key, value]) => [key, labelValue(key, value)] as const)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    if (entries.length === 0) {
        return name;
    }

    const rendered = entries
        .map(([key, value]) => `${key}="${value}"`)
        .join(',');

    return `${name}{${rendered}}`;
}

/** The inverse of `seriesKey`, used to re-render a series with more labels. */
function splitKey(key: string): { name: string; labels: Record<string, string> } {
    const open = key.indexOf('{');

    if (open === -1) {
        return { name: key, labels: {} };
    }

    const labels: Record<string, string> = {};
    const body = key.slice(open + 1, key.length - 1);

    for (const pair of body.split(',')) {
        const equals = pair.indexOf('=');

        if (equals === -1) {
            continue;
        }

        const name = pair.slice(0, equals).trim();
        const value = pair.slice(equals + 1).trim().replace(/^"|"$/g, '');

        labels[name] = value;
    }

    return { name: key.slice(0, open), labels };
}

/**
 * Renders a name with a suffix and one merged label group.
 *
 * One group, always. `m{x="1"}{quantile="0.5"}` is not a series a scraper can
 * read, and a scraper that cannot read one line rejects the document.
 */
function renderWith(
    name: string,
    labels: Record<string, string>,
    suffix = '',
): string {
    const entries = Object.entries(labels).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
    );

    if (entries.length === 0) {
        return `${name}${suffix}`;
    }

    const rendered = entries
        .map(([key, value]) => `${key}="${value}"`)
        .join(',');

    return `${name}${suffix}{${rendered}}`;
}

interface ExpositionOptions {
    /** A prefix for every metric, so two services can share a database. */
    namespace?: string;
    now?: number;
}

export class MetricRegistry {
    readonly #counters = new Map<string, number>();
    readonly #gauges = new Map<string, number>();
    readonly #distributions = new Map<string, Reservoir>();
    readonly #config: MetricConfig;
    readonly #namespace: string;

    constructor(
        config: MetricConfig = DEFAULT_METRIC_CONFIG,
        namespace = '',
    ) {
        this.#config = config;
        this.#namespace = namespace;
    }

    /**
     * Adds to a counter.
     *
     * Refuses a negative amount. A counter that can go down has lost the one
     * property that makes it a counter: `rate()` over the result is what every
     * dashboard does, and a counter that has gone backwards produces a
     * negative rate that looks like a bug in the dashboard and is a bug here.
     */
    counter(name: string, amount = 1, labels: Record<string, string> = {}): void {
        if (metricKind(name) !== 'counter') {
            throw new Error(`"${name}" не счётчик`);
        }

        if (amount < 0) {
            throw new Error(
                `Счётчик "${name}" не может уменьшаться: уменьшение ломает rate(), который по нему считают`,
            );
        }

        const key = seriesKey(name, labels);

        this.#counters.set(key, (this.#counters.get(key) ?? 0) + amount);
    }

    /** Sets a gauge, up or down. */
    gauge(name: string, value: number, labels: Record<string, string> = {}): void {
        if (metricKind(name) !== 'gauge') {
            throw new Error(`"${name}" не измеритель`);
        }

        this.#gauges.set(seriesKey(name, labels), value);
    }

    observe(name: string, value: number, labels: Record<string, string> = {}): void {
        if (metricKind(name) !== 'distribution') {
            throw new Error(`"${name}" не распределение`);
        }

        const key = seriesKey(name, labels);
        let reservoir = this.#distributions.get(key);

        if (reservoir === undefined) {
            reservoir = new Reservoir(this.#config);
            this.#distributions.set(key, reservoir);
        }

        reservoir.record(value);
    }

    /**
     * The current value, or 0 for a declared metric that has no series yet.
     *
     * Zero rather than null on purpose. Every one of the thirteen is declared,
     * so "no series" and "a value of zero" are the same state, and the
     * exposition already renders the second one. A getter that answered null
     * where the exposition answered 0 would have two versions of the truth,
     * and the caller that took the null to mean "nothing happened" would be
     * right by accident rather than by design.
     */
    value(name: string, labels: Record<string, string> = {}): number | null {
        const key = seriesKey(name, labels);
        const direct = this.#counters.get(key) ?? this.#gauges.get(key);

        if (direct !== undefined) {
            return direct;
        }

        if (metricKind(name) === 'distribution') {
            return null;
        }

        return 0;
    }

    /** Every declared metric, reported even at zero, sorted. */
    render(options: ExpositionOptions = {}): string {
        const prefix = options.namespace ?? this.#namespace;
        const lines: string[] = [];

        // The prefix goes on the sample lines as well as on the TYPE comment.
        // A namespace that only reached the comment declares a series nobody
        // ever emits, and the metric silently scrapes as untyped.
        const qualified = (key: string): string =>
            key.split('{')[0]?.startsWith(prefix) === true
                ? key
                : `${prefix}${key}`;

        for (const name of METRIC_COUNTERS) {
            lines.push(`# TYPE ${prefix}${name} counter`);

            const series = this.#matching(name, this.#counters);

            // Reported at zero from the start. A metric that appears only after
            // the first event cannot answer "has this ever happened", and
            // "the counter is missing" and "the counter is zero" are different
            // answers to that.
            for (const entry of series) {
                lines.push(`${qualified(entry.key)} ${entry.value}`);
            }

            if (series.length === 0) {
                lines.push(`${prefix}${name} 0`);
            }
        }

        for (const name of METRIC_GAUGES) {
            lines.push(`# TYPE ${prefix}${name} gauge`);

            const series = this.#matching(name, this.#gauges);

            if (series.length === 0) {
                lines.push(`${prefix}${name} 0`);
                continue;
            }

            for (const entry of series) {
                lines.push(`${qualified(entry.key)} ${entry.value}`);
            }
        }

        for (const name of METRIC_DISTRIBUTIONS) {
            lines.push(`# TYPE ${prefix}${name} summary`);

            const series = this.#matching(name, this.#distributions);

            if (series.length === 0) {
                lines.push(`${prefix}${name}_count 0`);
                continue;
            }

            for (const entry of series) {
                const reservoir = this.#distributions.get(entry.key);

                if (reservoir === undefined) {
                    continue;
                }

                const { name: base, labels } = splitKey(entry.key);

                lines.push(
                    `${prefix}${renderWith(base, labels, '_sum')} ${reservoir.sum}`,
                );
                lines.push(
                    `${prefix}${renderWith(base, labels, '_count')} ${reservoir.seen}`,
                );

                // Nearest-rank percentiles, reported as the value a request
                // actually took rather than interpolated between two. The
                // quantile goes inside the existing brace group: two groups is
                // not a valid exposition, and a scraper rejects the whole
                // document rather than the one line.
                for (const quantile of [0.5, 0.95, 0.99]) {
                    lines.push(
                        `${prefix}${renderWith(base, { ...labels, quantile: String(quantile) })} ${reservoir.percentile(quantile)}`,
                    );
                }

                lines.push(
                    `${prefix}${renderWith(base, { ...labels, quantile: '1' })} ${reservoir.max}`,
                );
            }
        }

        return `${lines.join('\n')}\n`;
    }

    #matching(name: string, source: Map<string, unknown>): { key: string; value: number | string }[] {
        const entries: { key: string; value: number | string }[] = [];

        for (const [key, value] of source) {
            const bare = key.split('{')[0] ?? key;

            if (bare === name) {
                entries.push({ key, value: value as number | string });
            }
        }

        return entries.sort((left, right) => (left.key < right.key ? -1 : 1));
    }
}

const observabilityMetricSchema = z.object({
    name: z.string().min(1),
    kind: z.enum(['counter', 'gauge', 'distribution']),
    description: z.string().min(1),
});

type ObservabilityMetric = z.infer<typeof observabilityMetricSchema>;

/**
 * What each metric is for, in one place.
 *
 * A name is a promise and a description is the contract behind it. Without the
 * second, `market_stale_served` is a number nobody can interpret — was it
 * counted per request or per candle, and is one stale hour a problem or ten?
 */
export const METRIC_CATALOGUE: readonly ObservabilityMetric[] = z
    .array(observabilityMetricSchema)
    .parse([
        {
            name: 'provider_requests_total',
            kind: 'counter',
            description: 'Обращения к рыночному провайдеру, по каждому имени площадки.',
        },
        {
            name: 'provider_errors_total',
            kind: 'counter',
            description: 'Ошибки провайдера, помеченные кодом в логе.',
        },
        {
            name: 'provider_rate_limits',
            kind: 'counter',
            description: 'Ответы 429: провайдер ограничил темп.',
        },
        {
            name: 'provider_circuit_open',
            kind: 'gauge',
            description: '1, если автомат провайдера разомкнут, иначе 0. Счётчиком быть не может.',
        },
        {
            name: 'provider_latency',
            kind: 'distribution',
            description: 'Время ответа провайдера. Среднее здесь бесполезно — нужен хвост.',
        },
        {
            name: 'provider_retries',
            kind: 'counter',
            // Declared because it was already being published, from outside the
            // registry. A name in the exposition that the catalogue does not
            // mention is the same bypass in the other direction: nothing promised
            // it, so nothing could notice it disappear.
            description: 'Повторов одного и того же запроса провайдеру.',
        },
        {
            name: 'provider_error_rate',
            kind: 'gauge',
            // A gauge and not a derived expression on the far side, because the
            // far side would have to divide two counters of different label sets
            // and get the label join right — the mistake this project has
            // already made once with a labelled counter.
            description: 'Доля неудавшихся вызовов провайдера, в [0, 1].',
        },
        {
            name: 'provider_health',
            kind: 'gauge',
            description: '1, если площадку можно спросить по этому рынку, иначе 0.',
        },
        {
            name: 'provider_consecutive_failures',
            kind: 'gauge',
            // A gauge because it goes back down: a success resets it, and a counter
            // that reset would make `rate()` produce a negative slope.
            description: 'Сбоев подряд с последнего успеха.',
        },
        {
            name: 'metric_series_limit',
            kind: 'gauge',
            // The only hand-written line in this exposition, and now it is not:
            // a statement about the exposition itself, published so a reader can
            // see whether it has outgrown what the endpoint keeps.
            description: 'Предел различных серий на группу метрик.',
        },
        {
            name: 'market_cache_hits',
            kind: 'counter',
            description: 'Ответов из кэша без обращения к провайдеру.',
        },
        {
            name: 'market_cache_misses',
            kind: 'counter',
            description: 'Обращений, которым кэш не помог и которые дошли до провайдера.',
        },
        {
            name: 'market_stale_served',
            kind: 'counter',
            description: 'Ответов просроченным кэшем. Растёт при аварии — это её признак.',
        },
        {
            name: 'indicator_calculation_duration',
            kind: 'distribution',
            description: 'Время расчёта индикаторов на одном окне свечей.',
        },
        {
            name: 'signal_generation_total',
            kind: 'counter',
            description: 'Сгенерированных сигналов, включая «бездействующий».',
        },
        {
            name: 'signal_changes_total',
            kind: 'counter',
            description: 'Случаев, когда сигнал сменился, — то, что действительно интересно.',
        },
        {
            name: 'market_cycle_failures',
            kind: 'counter',
            // Labelled by market, and the label is the point: the other
            // failure counter on this list is deliberately not fatal, while this
            // one means a market stopped being observed — silently, if the only
            // record were a log line nobody scrapes. A rising series here is a
            // market that has produced no signals, no snapshots and no settled
            // returns, and the process still reports itself healthy.
            description:
                'Циклов наблюдения, сорвавшихся по рынку. Метка `market` ' +
                'обязательна: без неё нельзя отличить один умерший рынок от ' +
                'двух, чередующихся сбоев.',
        },
        {
            // Declared in round 107, and late: these four were hand-written in
            // `api/lib/metrics.ts` and had never been in the catalogue at all,
            // which is the same omission round 99 removed for the provider
            // metrics. Nothing checked them because the check only asks about
            // names the catalogue mentions.
            name: 'write_backlog_signal_history_buffered',
            kind: 'gauge',
            description:
                'Снимков сигнала, ждущих повторной записи. Без метки `market` — ' +
                'итог по процессу; с меткой — по рынку.',
        },
        {
            name: 'write_backlog_signal_history_dropped_total',
            kind: 'counter',
            description:
                'Снимков сигнала, потерянных из-за переполненного буфера. Число ' +
                'растёт только вверх: это потерянные записи, а не текущий ' +
                'очередь.',
        },
        {
            name: 'write_backlog_signal_history_spooled',
            kind: 'gauge',
            description:
                'Снимков сигнала, удерживаемых на диске в spool-файле после ' +
                'отказа записи. Переживают перезапуск процесса; в ' +
                '`write_backlog_signal_history_buffered` не входят. Без метки ' +
                '`market` — итог по процессу; с меткой — по рынку.',
        },
        {
            name: 'write_backlog_indicator_vote_buffered',
            kind: 'gauge',
            description:
                'Пакетов голосов индикаторов, ждущих повторной записи. Без ' +
                'метки `market` — итог по процессу; с меткой — по рынку.',
        },
        {
            name: 'write_backlog_indicator_vote_dropped_total',
            kind: 'counter',
            description:
                'Пакетов голосов индикаторов, потерянных из-за переполненного ' +
                'буфера.',
        },
        {
            name: 'write_backlog_indicator_vote_spooled',
            kind: 'gauge',
            description:
                'Пакетов голосов индикаторов, удерживаемых на диске в ' +
                'spool-файле после отказа записи. Переживают перезапуск ' +
                'процесса; в `write_backlog_indicator_vote_buffered` не входят. ' +
                'Без метки `market` — итог по процессу; с меткой — по рынку.',
        },
        {
            name: 'write_backlog_strategy_decision_buffered',
            kind: 'gauge',
            description:
                'Строк журнала решений, ждущих повторной записи. Без метки ' +
                '`market` — итог по процессу; с меткой — по рынку.',
        },
        {
            name: 'write_backlog_strategy_decision_dropped_total',
            kind: 'counter',
            description:
                'Строк журнала решений, потерянных из-за переполненного буфера. ' +
                'Число растёт только вверх: это потерянные записи, а не текущая ' +
                'очередь.',
        },
        {
            name: 'write_backlog_strategy_decision_spooled',
            kind: 'gauge',
            description:
                'Строк журнала решений, удерживаемых на диске в spool-файле ' +
                'после отказа записи. Переживают перезапуск процесса; в ' +
                '`write_backlog_strategy_decision_buffered` не входят. Без метки ' +
                '`market` — итог по процессу; с меткой — по рынку.',
        },
        {
            name: 'strategy_decision_write_failures',
            kind: 'counter',
            // Worth stating plainly in the catalogue, because the failure is
            // swallowed on purpose: the analysis answers correctly even when this
            // write fails. The write no longer loses the row — the row is
            // buffered and retried — so a rising counter is the "database is
            // refusing writes" signal, while what the counter used to name lives
            // in write_backlog_strategy_decision_dropped_total and in the
            // `strategy_decision_entry_given_up` log lines.
            description:
                'Отказов записи в журнал решений. Строка при отказе буферизуется ' +
                'и попробует снова, так что рост счётчика — сигнал «база не ' +
                'принимает записи», а не «строка потеряна». Потери видны в ' +
                '`write_backlog_strategy_decision_dropped_total`. Метка `market` ' +
                'обязательна: отказ — не частота, а факт о конкретной серии, и ' +
                'итог по процессу не скажет, какая серия его недополучила.',
        },
        {
            name: 'database_query_duration',
            kind: 'distribution',
            description: 'Время каждого запроса к базе, по имени операции.',
        },
        {
            name: 'backtest_duration',
            kind: 'distribution',
            description: 'Длительность прогона бэктеста.',
        },
    ]);

export const CATALOGUE_BY_NAME: ReadonlyMap<string, ObservabilityMetric> = new Map(
    METRIC_CATALOGUE.map((entry) => [entry.name, entry]),
);

export function declareMetric(name: string): ObservabilityMetric {
    const found = CATALOGUE_BY_NAME.get(name);

    if (found === undefined) {
        throw new Error(
            `Метрика "${name}" не объявлена ни в METRIC_NAMES, ни в каталоге. Новая метрика объявляется явно: иначе её нельзя отличить от опечатки.`,
        );
    }

    return found;
}

/**
 * The one registry the running process records into.
 *
 * A module-level singleton, like the connection pool and the market cache, and
 * for the same reason: the counter has to be the same object in the market
 * service, the indicator service and the backtest CLI, or the exposition is a
 * set of private tallies that sum to nothing.
 *
 * The label guard is installed on every write rather than left to each call
 * site. A call site is written once and copied; the guard is written once and
 * applies to every copy.
 */
let processRegistry: MetricRegistry | null = null;

export function registry(): MetricRegistry {
    processRegistry ??= new MetricRegistry(DEFAULT_METRIC_CONFIG);

    return processRegistry;
}

/** Test hook: a registry the tests can read, or null to fall back. */
let override: MetricRegistry | null = null;

export function useRegistry(replacement: MetricRegistry | null): void {
    override = replacement;
}

export function currentRegistry(): MetricRegistry {
    return override ?? registry();
}
