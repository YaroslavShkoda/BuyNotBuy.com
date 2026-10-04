import { hashValue } from '../config/strategy-fingerprint.js';
import { createDonchian } from '../strategies/donchian.js';
import { createDonchianCalmGated } from '../strategies/donchian-calm-gated.js';
import { createVolatilityTrend } from '../strategies/volatility-trend.js';
import { HOLDOUT_COMMITTED_AT, registerForEvaluation } from './holdout.js';
import type { Strategy } from './strategies.js';
import { fromModule } from './strategies.js';

/**
 * The rules that are on the window, and the rules that will be judged on it.
 *
 * **One list, in one file, because the two must not be able to drift.** The
 * registration is the commitment — which rule, at which parameters, frozen before
 * the window exists — and the thing the verdict eventually reports is built from
 * the strategies beside it. Two lists would differ the moment somebody added a
 * rule to one of them, and the difference would be invisible: the verdict would
 * quietly be about a different rule than the one that was promised, which is
 * disqualifying rather than unlucky.
 *
 * Both were in `validation.cli.ts` before round 110. That file printed them; this
 * one seals them.
 *
 * The fingerprint is of the **parameters, not the name**, which is the whole
 * mechanism `holdout.ts` describes: a rule adjusted after registration no longer
 * matches its entry and is reported as *changed* rather than as *failed*. Those
 * are different sentences and collapsing them would make "we looked again and
 * adjusted" indistinguishable from "we predicted and were wrong".
 */
export interface RegisteredRule {
    readonly key: string;
    readonly note: string;
    /** Frozen at registration. Read back to detect a rule edited since. */
    readonly fingerprint: string;
    /** The strategy as it will be judged — built from the same parameters. */
    readonly strategy: Strategy;
}

export const REGISTERED_RULES: readonly RegisteredRule[] = [
    {
        key: 'donchian-20',
        fingerprint: hashValue({ channelPeriod: 20 }),
        note: 'Плато параметра 14-24, перелом по комиссии между 0.10% и 0.20% за сторону.',
        strategy: fromModule(
            'donchian-20',
            createDonchian({ channelPeriod: 20 }),
        ),
    },
    {
        key: 'donchian-18',
        fingerprint: hashValue({ channelPeriod: 18 }),
        note: 'Лучшая точка плато по результату на всей истории, а не по подбору.',
        strategy: fromModule(
            'donchian-18',
            createDonchian({ channelPeriod: 18 }),
        ),
    },
    {
        key: 'donchian-trend-gated',
        fingerprint: hashValue({ channel: 20, atr: [14, 40] }),
        note: 'Убыточен на всей истории: -13.31%, профит-фактор 0.965.',
        strategy: fromModule(
            'donchian-trend-gated',
            createDonchian({ channelPeriod: 20 }),
        ),
    },
    {
        key: 'donchian-calm-gated',
        fingerprint: hashValue({ channel: 20, atr: [14, 40], gate: 'low' }),
        note: 'Инверсия фильтра: основание оказалось ошибкой источника данных. ' +
            'На Binance +2.13% против +9.28% у оригинала — гипотеза опровергнута, ' +
            'не «подтверждена наоборот».',
        strategy: fromModule(
            'donchian-calm-gated',
            createDonchianCalmGated({
                channelPeriod: 20,
                atrPeriod: 14,
                atrBaselinePeriod: 40,
            }),
        ),
    },
    {
        key: 'volatility-trend',
        fingerprint: hashValue({ atr: [14, 40] }),
        note: 'Вариант D абляции: только фильтр волатильности, без пробоя. ' +
            '+222.99%, PF 1.994, 67 сделок против 9.28% у полного правила. ' +
            'Найдено разбором чужого правила — самый ненадёжный способ найти ' +
            'правило, поэтому сначала на окно, а не в бой.',
        strategy: fromModule(
            'volatility-trend',
            createVolatilityTrend({ atrPeriod: 14, baselinePeriod: 40 }),
        ),
    },
];

/**
 * The same rules as `registerForEvaluation` entries.
 *
 * `registeredAt` is the commit instant rather than `Date.now()`, and that is the
 * point of the argument: a registration written at the moment of the read is not a
 * registration, it is a description of whatever the rule had become by then.
 */
export function registrationOf(
    rule: RegisteredRule,
): ReturnType<typeof registerForEvaluation> {
    return registerForEvaluation(
        rule.key,
        rule.fingerprint,
        rule.note,
        HOLDOUT_COMMITTED_AT,
    );
}