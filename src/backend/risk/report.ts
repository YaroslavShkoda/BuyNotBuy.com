import {
    type DataQualitySection,
    type DistancesSection,
    INVALIDATION_ATR_PRICE_BASIS,
    INVERSE_PNL_QUOTE_VALUATION,
    LINEAR_ISOLATED_FORMULA_ID,
    type LiquidationConsequencesSection,
    type MachineWarning,
    type MarginViolationSection,
    type MetricBlock,
    POSITION_MATH_VERSION,
    type PortfolioRiskSection,
    type PositionRiskSection,
    REPORT_BUILDER_VERSION,
    RISK_ASSUMPTIONS_VERSION,
    RISK_REPORT_SCHEMA_VERSION,
    type RiskReport,
    type StressSection,
} from '../types/risk.js';
import { canonicalInputHash } from './canonical-input.js';
import { exactAdd, exactDivide, exactMultiply, exactNumber, exactSubtract, roundExact } from './exact-rational.js';
import { finiteProduct } from './finite-product.js';
import { fundingAvailability } from './funding-rules.js';
import { inversePnlExact } from './inverse-pnl.js';
import { linearPnlExact } from './linear-pnl.js';
import {
    assessLiquidation,
    atrDistanceToLiquidation,
    percentDistanceToLiquidation,
} from './liquidation-contract.js';
import { marginRulesReadiness } from './margin-rules.js';
import {
    absoluteExposureBaseUnits,
    absoluteNotionalQuote,
    directedExposureQuote,
    estimatedRoundTripCost,
    invalidationAtrDistance,
    invalidationDistance,
    potentialPnl,
} from './position-math.js';
import type { RiskInput } from './schema.js';
import { RiskInputSchema } from './schema.js';
import { metric, sectionReason, worstStatus } from './status.js';

/**
 * Builds the shadow risk report from one validated input.
 *
 * Pure: candles in, report out, nothing written anywhere, nothing fetched,
 * nothing mutated. Every number carries its unit, every non-`valid` status
 * carries a reason from the closed set, and the report's own status is the
 * worst of its parts — a report never claims `valid` because computing it
 * happened not to throw.
 *
 * The stage-1 boundary is explicit in the output itself: portfolio risk says
 * `not_applicable` rather than masquerading as position risk, scenario
 * sections carry references rather than results, and a liquidation estimate
 * exists only for the one formula this stage can defend.
 */

const REPORT_ASSUMPTIONS: readonly string[] = [
    'Linear/spot PnL и linear ROM вычисляются точно; quote, percent и ROM округляются независимо nearest/ties-to-even. Linear equity и maintenance сравниваются точно до округления публикуемых сумм (строгое equity < maintenance); при непредставимой сумме detected остаётся null с calculation_error.',
    'Реализованная формула ликвидации — алгебраическое следствие определения изолированной маржи для линейного контракта; это не подтверждённое правило конкретной биржи.',
    'Триггер ликвидации не учитывает комиссии, финансирование и резерв на исполнение.',
    'Расчётная цена ликвидации не является гарантированной ценой исполнения.',
    'PnL inverse-контракта выражен в базовой валюте через договорный размер контракта и переведён в валюту котировки по текущей цене.',
    'Cross-маржа не оценивается: для неё нужен капитал всего портфеля, которого во входе нет.',
    'Диапазон неопределённости строится только из явно заданных сценариев; на этапе 1 сценарные расчёты не выполняются.',
    'Отсутствующий funding не считается нулевым: зависимые метрики получают degraded с диагностикой.',
    'Потенциальный PnL считается только при явно заданной цене выхода; отсутствие цены — not_applicable, а не ноль.',
    'Процентные метрики PnL — это процент PnL от номинала позиции (entryNotionalQuote: qty × entryPrice для spot и linear, qty × contractSizeUsd для inverse); это не доходность на маржу и не доходность на капитал.',
    'Для inverse-контракта PnL в валюте котировки — это base-PnL между ценами входа и выхода, переоценённый по текущей цене: рыночная оценка на момент снимка, а не стоимость на момент закрытия (conventions.inversePnlQuoteValuation).',
    'PnL в базовых единицах публикуется только для inverse-контракта с marginCurrency = base: при marginCurrency = quote расчёт ведётся в валюте котировки, и base-фигура не является валютой расчёта (INVERSE_SETTLEMENT_NOT_BASE).',
    'Дистанция до инвалидации измеряется от цены входа в неблагоприятную для позиции сторону; уровень на выгодной стороне даёт insufficient_data, а не отрицательную дистанцию.',
    'ATR входит в контракт как доля цены, поэтому ATR-дистанция до инвалидации делит расстояние на atr × цена входа (conventions.invalidationAtrPriceBasis); нормировка дистанции до ликвидации — отдельная конвенция этапа 1.',
    'spreadRate трактуется как полный относительный спред: на каждую сторону приходится половина, на полный round-trip — весь spreadRate.',
    'Оценка издержек round-trip: по обеим ногам taker-комиссия, половина спреда, slippage и резерв исполнения; обе ноги оцениваются по номиналу позиции на входе — номинал ноги выхода по цене выхода сознательно не используется, чтобы оценки были сопоставимы между позициями с заданной и незаданной ценой выхода.',
    'Funding не входит в оценку издержек: для него нужен период удержания, которого во входе нет; стоимость удержания — отдельная метрика.',
    'Inverse-контракты поддерживаются только с quoteCurrency = USD: contractSizeUsd — USD на контракт; USD не приравнивается к стейблкоинам или другим валютам.',
    'Funding за интервал: sideSign × ставка × текущая цена × base-количество для linear; sideSign × ставка × contractSizeUsd × число контрактов для inverse. Положительная стоимость означает выплату, отрицательная — получение.',
    'Funding публикуется в quote-валюте, для inverse это USD. При marginCurrency = base расчётный эквивалент в базовой валюте равен USD funding / currentPrice; отдельная base-метрика funding не публикуется.',
    'Inverse номинал, base-экспозиция, inverse PnL и inverse ROM вычисляются точно над binary64-входами; каждая метрика округляется независимо, nearest/ties-to-even. Знаменатель PnL percent — опубликованный entryNotionalQuote; ROM — фактический collateralQuote.',
    'Linear/spot номинал, round-trip издержки и существующая linear isolated liquidation формула вычисляются точно над binary64-входами, с округлением каждой публикуемой величины nearest/ties-to-even. Ненулевой результат, округляющийся до нуля, получает calculation_error / CALCULATION_OVERFLOW. Liquidation geometry сравнивает точный entry × qty с collateral, без промежуточного округления номинала.',
    'Переполненный или нечисловой результат расчёта получает calculation_error с причиной CALCULATION_OVERFLOW и никогда не публикуется как valid. Для точных inverse номинала, экспозиции, PnL/ROM и finiteProduct эта же ошибка обозначает ненулевой результат, округляющийся до нуля.',
];

const LIQUIDATION_LIMITATIONS: readonly string[] = [
    'Расчётная цена ликвидации — оценка модели, а не гарантированная цена исполнения.',
    'Потеря при ликвидации указана без вычета комиссий и финансирования.',
    'Диапазон неопределённости не построен: на этапе 1 нет подтверждённых сценарных расчётов.',
];

export function buildRiskReport(rawInput: RiskInput): RiskReport {
    const input = RiskInputSchema.parse(rawInput);
    const warnings: MachineWarning[] = [];

    const warn = (
        code: MachineWarning['code'],
        scope: MachineWarning['scope'],
        sectionKey: string | null,
        metricKey: string | null,
        message: string,
    ): void => {
        warnings.push({ code, scope, sectionKey, metricKey, message });
    };

    const sideSign = input.side === 'LONG' ? 1 : -1;
    const isSpot = input.contractKind === 'spot';
    const rules = input.margin.rules;

    // The position notional is the kind-aware figure every percent and the
    // cost estimate build on: qty x entry for spot and linear, qty x
    // contractSizeUsd for the inverse. Computed once, from the one function
    // the notional metric publishes, so there is never a second definition.
    const positionSpec = {
        contractKind: input.contractKind,
        side: input.side,
        qtyBase: input.qtyBase,
        entryPrice: input.entryPrice,
        contractSizeUsd: input.contractSizeUsd,
        marginCurrency: input.marginCurrency,
    } as const;
    const positionNotional = absoluteNotionalQuote(positionSpec);

    // --- position risk -----------------------------------------------------

    // Unrealized PnL is the same question as a hypothetical exit at current
    // price. Reuse its checked arithmetic, including dependency statuses.
    const unrealized = potentialPnl({
        ...positionSpec,
        currentPrice: input.currentPrice,
        exitPrice: input.currentPrice,
    });
    const pnlQuote = unrealized.quote.value;
    const linearUnrealized = input.contractKind === 'inverse_perp'
        ? null
        : linearPnlExact({ ...positionSpec, exitPrice: input.currentPrice });

    const positionMetrics: MetricBlock[] = [
        metric(
            'unrealizedPnlQuote',
            'quote_currency',
            pnlQuote,
            unrealized.quote.status,
            unrealized.quote.reasonCode,
        ),
        metric(
            'unrealizedPnlPercentOfEntryNotional',
            'percent',
            unrealized.percent.value,
            unrealized.percent.status,
            unrealized.percent.reasonCode,
        ),
    ];

    if (
        !isSpot && input.collateralQuote !== null &&
        (pnlQuote !== null || unrealized.quote.status === 'calculation_error')
    ) {
        const returnOnMargin = input.contractKind === 'inverse_perp' &&
            input.contractSizeUsd !== null && input.marginCurrency !== null
            ? roundExact(exactDivide(
                exactMultiply(inversePnlExact({
                    ...positionSpec, contractSizeUsd: input.contractSizeUsd,
                    currentPrice: input.currentPrice, exitPrice: input.currentPrice,
                }).quote, exactNumber(100)),
                exactNumber(input.collateralQuote),
            ))
            : linearUnrealized !== null
            ? roundExact(exactDivide(
                exactMultiply(linearUnrealized, exactNumber(100)),
                exactNumber(input.collateralQuote),
            ))
            : {
                value: pnlQuote === null ? null : (pnlQuote / input.collateralQuote) * 100,
                status: unrealized.quote.status,
                reasonCode: unrealized.quote.reasonCode,
            };
        positionMetrics.push(
            metric(
                'returnOnMarginPercent',
                'percent',
                returnOnMargin.value,
                returnOnMargin.status,
                returnOnMargin.reasonCode,
            ),
        );
    }

    // --- stage-2 position mathematics ---------------------------------------

    positionMetrics.push(
        metric(
            'entryNotionalQuote',
            'quote_currency',
            positionNotional.value,
            positionNotional.status,
            positionNotional.reasonCode,
        ),
    );

    const baseExposureMath = absoluteExposureBaseUnits(positionSpec);

    positionMetrics.push(
        metric(
            'absoluteExposureBaseUnits',
            'base_units',
            baseExposureMath.value,
            baseExposureMath.status,
            baseExposureMath.reasonCode,
        ),
    );

    const directedExposureMath = directedExposureQuote(positionSpec);

    positionMetrics.push(
        metric(
            'directedExposureQuote',
            'quote_currency',
            directedExposureMath.value,
            directedExposureMath.status,
            directedExposureMath.reasonCode,
        ),
    );

    const potential = potentialPnl({
        ...positionSpec,
        currentPrice: input.currentPrice,
        exitPrice: input.exitPriceQuote,
    });

    positionMetrics.push(
        metric(
            'potentialPnlQuote',
            'quote_currency',
            potential.quote.value,
            potential.quote.status,
            potential.quote.reasonCode,
        ),
    );

    positionMetrics.push(
        metric(
            'potentialPnlPercentOfEntryNotional',
            'percent',
            potential.percent.value,
            potential.percent.status,
            potential.percent.reasonCode,
        ),
    );

    if (potential.base !== null) {
        positionMetrics.push(
            metric(
                'potentialPnlBaseUnits',
                'base_units',
                potential.base.value,
                potential.base.status,
                potential.base.reasonCode,
            ),
        );
    }

    // The cost basis is the position notional itself: rates are fractions of
    // what is traded, and for the inverse that is the confirmed USD notional.
    // Without it the basis is unknown, so the estimate is insufficient data
    // rather than a fraction of a quantity the contract rejects.
    const roundTripCost =
        positionNotional.value === null
            ? null
            : estimatedRoundTripCost(positionNotional.value, input.costs);

    positionMetrics.push(
        metric(
            'estimatedRoundTripCostQuote',
            'quote_currency',
            roundTripCost === null ? null : roundTripCost.quote.value,
            roundTripCost === null
                ? positionNotional.status
                : roundTripCost.quote.status,
            roundTripCost === null
                ? positionNotional.reasonCode
                : roundTripCost.quote.reasonCode,
        ),
    );

    positionMetrics.push(
        metric(
            'estimatedRoundTripCostPercentOfEntryNotional',
            'percent',
            roundTripCost === null ? null : roundTripCost.percent.value,
            roundTripCost === null
                ? positionNotional.status
                : roundTripCost.percent.status,
            roundTripCost === null
                ? positionNotional.reasonCode
                : roundTripCost.percent.reasonCode,
        ),
    );

    const invalidationArgs = {
        side: input.side,
        entryPrice: input.entryPrice,
        levelQuote: input.invalidationLevelQuote,
    } as const;
    const invalidation = invalidationDistance(invalidationArgs);

    positionMetrics.push(
        metric(
            'invalidationDistanceQuote',
            'quote_currency',
            invalidation.absolute.value,
            invalidation.absolute.status,
            invalidation.absolute.reasonCode,
        ),
    );

    positionMetrics.push(
        metric(
            'invalidationDistancePercent',
            'percent',
            invalidation.percent.value,
            invalidation.percent.status,
            invalidation.percent.reasonCode,
        ),
    );

    const invalidationAtr = invalidationAtrDistance({
        ...invalidationArgs,
        atrValue: input.atr.value,
    });

    positionMetrics.push(
        metric(
            'invalidationDistanceAtr',
            'atr_units',
            invalidationAtr.value,
            invalidationAtr.status,
            invalidationAtr.reasonCode,
        ),
    );

    if (
        invalidation.absolute.reasonCode === 'INVALIDATION_LEVEL_CONTRADICTS_SIDE'
    ) {
        warn(
            'INVALIDATION_LEVEL_CONTRADICTS_SIDE',
            'section',
            'positionRisk',
            null,
            'Уровень инвалидации находится на выгодной для позиции стороне: дистанция до него не вычисляется, пока уровень не согласован с направлением позиции.',
        );
    }

    if (invalidationAtr.reasonCode === 'ATR_UNUSABLE') {
        warn(
            'ATR_UNUSABLE',
            'metric',
            'positionRisk',
            'invalidationDistanceAtr',
            'ATR равен нулю или некорректен: дистанция до инвалидации в ATR не вычисляется и не считается нулевой.',
        );
    }

    const funding = fundingAvailability(
        input.contractKind,
        input.costs.fundingRatePerInterval,
    );

    if (funding.status === 'valid') {
        const inverse = input.contractKind === 'inverse_perp';
        // Keep the factors: forming a notional first could lose a representable
        // funding result. An unconfirmed size cannot be replaced by an unchecked
        // caller-supplied notional, even when a zero funding rate was provided.
        const fundingBasis = inverse ? input.contractSizeUsd : input.currentPrice;
        const holdingCost = fundingBasis === null
            ? { value: null, status: 'insufficient_data' as const, reasonCode: 'MISSING_INVERSE_CONTRACT_PARAMS' as const }
            : finiteProduct(
                sideSign * (input.costs.fundingRatePerInterval ?? 0),
                fundingBasis,
                input.qtyBase,
            );
        positionMetrics.push(
            metric(
                'holdingCostPerIntervalQuote',
                'quote_currency',
                holdingCost.value,
                holdingCost.status,
                holdingCost.reasonCode,
            ),
        );
    } else {
        positionMetrics.push(
            metric(
                'holdingCostPerIntervalQuote',
                'quote_currency',
                null,
                funding.status,
                funding.reasonCode,
            ),
        );

        if (funding.status === 'degraded') {
            warn(
                'UNKNOWN_FUNDING',
                'metric',
                'positionRisk',
                'holdingCostPerIntervalQuote',
                'Funding применим, но значение не предоставлено; стоимость поддержания позиции неизвестна и не считается нулевой.',
            );
        }
    }

    const positionRisk: PositionRiskSection = {
        status: worstStatus(positionMetrics.map((entry) => entry.status)),
        reasonCode: sectionReason(positionMetrics),
        metrics: positionMetrics,
    };

    // --- margin violation --------------------------------------------------

    let marginViolation: MarginViolationSection;

    if (isSpot) {
        marginViolation = {
            detected: null,
            atBar: null,
            marginMode: null,
            rulesVersion: null,
            equityQuote: null,
            maintenanceRequirementQuote: null,
            status: 'not_applicable',
            reasonCode: 'MARGIN_NOT_APPLICABLE',
        };
    } else if (rules === null) {
        marginViolation = {
            detected: null,
            atBar: null,
            marginMode: input.margin.mode,
            rulesVersion: null,
            equityQuote: null,
            maintenanceRequirementQuote: null,
            status: 'insufficient_data',
            reasonCode: 'MARGIN_RULES_MISSING',
        };

        warn(
            'MARGIN_RULES_MISSING',
            'section',
            'marginViolation',
            null,
            'Правила маржи не предоставлены: нарушение маржинальных требований оценить нельзя; рыночные метрики это не блокирует.',
        );
    } else if (input.margin.mode === 'cross') {
        marginViolation = {
            detected: null,
            atBar: null,
            marginMode: 'cross',
            rulesVersion: rules.version,
            equityQuote: null,
            maintenanceRequirementQuote: null,
            status: 'insufficient_data',
            reasonCode: 'CROSS_MARGIN_NOT_ASSESSABLE',
        };

        warn(
            'CROSS_MARGIN_NOT_ASSESSABLE',
            'section',
            'marginViolation',
            null,
            'Cross-маржа требует капитала всего портфеля; по одной позиции нарушение оценить нельзя.',
        );
    } else {
        const readiness = marginRulesReadiness(rules, input.quoteCurrency);

        if (readiness.status === 'incomplete') {
            marginViolation = {
                detected: null,
                atBar: null,
                marginMode: input.margin.mode,
                rulesVersion: rules.version,
                equityQuote: null,
                maintenanceRequirementQuote: null,
                status: 'insufficient_data',
                reasonCode: readiness.reasonCode,
            };

            warn(
                readiness.reasonCode as MachineWarning['code'],
                'section',
                'marginViolation',
                null,
                readiness.detail,
            );
        } else {
            // Readiness above blocks inverse arithmetic. Build equity from
            // exact PnL, never from its independently rounded public metric.
            const exactEquity = linearUnrealized === null || input.collateralQuote === null
                ? null
                : exactAdd(exactNumber(input.collateralQuote), linearUnrealized);
            const equity = exactEquity === null ? null : roundExact(exactEquity);
            const exactMaintenance = exactMultiply(
                exactNumber(rules.maintenanceMarginRate),
                exactMultiply(exactNumber(input.currentPrice), exactNumber(input.qtyBase)),
            );
            const maintenance = roundExact(exactMaintenance);
            const requirement = maintenance.value;
            const arithmeticValid = equity?.status === 'valid' && maintenance.status === 'valid';
            // Keep the existing unavailable-sum error gate, but decide the
            // strict threshold from exact inputs, independently of rounding.
            const detected = arithmeticValid && exactEquity !== null
                ? exactSubtract(exactEquity, exactMaintenance).numerator < 0n
                : null;

            marginViolation = {
                detected,
                atBar: detected ? input.market.lastClosedBarTime : null,
                marginMode: input.margin.mode,
                rulesVersion: rules.version,
                equityQuote: equity?.value ?? null,
                maintenanceRequirementQuote: requirement,
                status: !arithmeticValid ? 'calculation_error'
                    : readiness.status === 'draft' ? 'degraded' : 'valid',
                reasonCode: !arithmeticValid ? 'CALCULATION_OVERFLOW'
                    : readiness.status === 'draft' ? 'MARGIN_RULES_DRAFT' : null,
            };

            if (readiness.status === 'draft') {
                warn(
                    'MARGIN_RULES_DRAFT',
                    'section',
                    'marginViolation',
                    null,
                    readiness.detail,
                );
            }
        }
    }

    // --- liquidation consequences ------------------------------------------

    const liquidationEstimate = assessLiquidation({
        contractKind: input.contractKind,
        marginMode: input.margin.mode,
        rules,
        quoteCurrency: input.quoteCurrency,
        side: input.side,
        qtyBase: input.qtyBase,
        entryPrice: input.entryPrice,
        collateralQuote: input.collateralQuote,
    });

    const liquidationConsequences: LiquidationConsequencesSection = {
        point: {
            liquidationPriceQuote: liquidationEstimate.liquidationPriceQuote,
            projectedLossQuote: liquidationEstimate.projectedLossQuote,
        },
        range: {
            low: null,
            high: null,
            basisScenarioIds: [],
        },
        widthDrivers:
            liquidationEstimate.reasonCode === 'MARGIN_RULES_DRAFT'
                ? ['MARGIN_RULES_DRAFT']
                : [],
        executionAssumptions: {
            feeRate: input.costs.takerFeeRate,
            slippageRate: input.costs.slippageRate,
            spreadRate: input.costs.spreadRate,
            fundingRatePerInterval: input.costs.fundingRatePerInterval,
        },
        limitations: [
            ...(rules?.limitations ?? []),
            ...LIQUIDATION_LIMITATIONS,
        ],
        status: liquidationEstimate.status,
        reasonCode: liquidationEstimate.reasonCode,
    };

    // --- distances ---------------------------------------------------------

    const liquidationPrice = liquidationEstimate.liquidationPriceQuote;
    const atrUsable = input.atr.value > 0;

    const percentDistance: MetricBlock =
        liquidationPrice === null
            ? metric(
                  'percentDistance',
                  'percent',
                  null,
                  liquidationEstimate.status,
                  liquidationEstimate.reasonCode,
              )
            : metric(
                  'percentDistance',
                  'percent',
                  percentDistanceToLiquidation(
                      input.side,
                      input.currentPrice,
                      liquidationPrice,
                  ),
                  'valid',
              );

    const atrDistance: MetricBlock =
        liquidationPrice === null
            ? metric(
                  'atrDistance',
                  'atr_units',
                  null,
                  liquidationEstimate.status,
                  liquidationEstimate.reasonCode,
              )
            : atrUsable
              ? metric(
                    'atrDistance',
                    'atr_units',
                    atrDistanceToLiquidation(
                        input.currentPrice,
                        liquidationPrice,
                        input.atr.value,
                    ),
                    'valid',
                )
              : metric('atrDistance', 'atr_units', null, 'insufficient_data', 'ATR_UNUSABLE');

    const distances: DistancesSection = {
        percentDistance,
        atrDistance,
        atr: input.atr,
    };

    if (liquidationPrice !== null && !atrUsable) {
        warn(
            'ATR_UNUSABLE',
            'metric',
            'distances',
            'atrDistance',
            'ATR равен нулю или некорректен: дистанция в ATR не вычисляется и не считается нулевой.',
        );
    }

    // --- portfolio, stress, data quality -----------------------------------

    const portfolioRisk: PortfolioRiskSection = {
        status: 'not_applicable',
        reasonCode: 'PORTFOLIO_NOT_IMPLEMENTED',
        metrics: [],
    };

    warn(
        'PORTFOLIO_NOT_IMPLEMENTED',
        'section',
        'portfolioRisk',
        null,
        'Вход содержит одну позицию; портфельная агрегация на этапе 1 не реализована. Позиционный риск не выдаётся за портфельный.',
    );

    const historical = input.scenarios.filter(
        (scenario) => scenario.kind === 'historical',
    );
    const synthetic = input.scenarios.filter(
        (scenario) => scenario.kind === 'synthetic',
    );

    const stress: StressSection = {
        status:
            historical.length + synthetic.length > 0
                ? 'degraded'
                : 'not_applicable',
        reasonCode:
            historical.length + synthetic.length > 0
                ? 'STRESS_RESULTS_NOT_COMPUTED'
                : 'STRESS_ENGINE_NOT_IMPLEMENTED',
        historical,
        synthetic,
    };

    if (stress.status === 'degraded') {
        warn(
            'STRESS_RESULTS_NOT_COMPUTED',
            'section',
            'stress',
            null,
            'Сценарии переданы как ссылки; стресс-движок на этапе 1 не реализован, результаты не вычислялись.',
        );
    }

    const dataQuality: DataQualitySection = {
        ...input.dataQuality,
        status: input.dataQuality.usable ? 'valid' : 'degraded',
        reasonCode: input.dataQuality.usable ? null : 'DATA_QUALITY_LOW',
    };

    if (!input.dataQuality.usable) {
        warn(
            'DATA_QUALITY_LOW',
            'section',
            'dataQuality',
            null,
            `Качество рыночных данных помечено как непригодное (worst: ${input.dataQuality.worst ?? 'неизвестно'}); все метрики отчёта следует читать как ограниченные.`,
        );
    }

    // --- report ------------------------------------------------------------

    const inputHash = canonicalInputHash(input);

    const report: RiskReport = {
        reportId: `risk-${inputHash.slice(0, 16)}`,
        inputHash,
        schemaVersion: RISK_REPORT_SCHEMA_VERSION,
        modelVersions: {
            reportBuilder: REPORT_BUILDER_VERSION,
            liquidationLinearIsolated: LINEAR_ISOLATED_FORMULA_ID,
            assumptions: RISK_ASSUMPTIONS_VERSION,
            positionMath: POSITION_MATH_VERSION,
        },
        conventions: {
            inversePnlQuoteValuation: INVERSE_PNL_QUOTE_VALUATION,
            invalidationAtrPriceBasis: INVALIDATION_ATR_PRICE_BASIS,
        },
        computedAt: input.now,
        marketAsOf: input.market.lastClosedBarTime,
        inputs: {
            positionId: input.positionId,
            ticker: input.ticker,
            venue: input.venue,
            contractKind: input.contractKind,
            interval: input.interval,
            provider: input.market.provider,
            candleCount: input.market.candles.length,
            firstBarTime: input.market.candles[0]?.timestamp ?? 0,
            lastClosedBarTime: input.market.lastClosedBarTime,
            positionSource: input.source,
        },
        assumptions: REPORT_ASSUMPTIONS,
        positionRisk,
        portfolioRisk,
        stress,
        marginViolation,
        liquidationConsequences,
        distances,
        dataQuality,
        warnings,
        reportStatus: worstStatus([
            positionRisk.status,
            portfolioRisk.status,
            stress.status,
            marginViolation.status,
            liquidationConsequences.status,
            percentDistance.status,
            atrDistance.status,
            dataQuality.status,
        ]),
    };

    return report;
}
