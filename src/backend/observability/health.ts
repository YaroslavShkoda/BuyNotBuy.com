import { z } from 'zod';

/**
 * Whether the system is working, and what to say about it.
 *
 * A health check that returns "ok" is a claim somebody has to trust, and the
 * only thing that makes it worth anything is the reason attached to it. So a
 * component reports its own state and, when it is degraded, says which of a
 * small set of named states it is in — a dashboard served from a cached
 * snapshot and one whose market feed is entirely dead are both "degraded" and
 * are different incidents with different fixes.
 *
 * The states are fixed on purpose. A health endpoint whose vocabulary grows with
 * the number of things that can go wrong is an endpoint nobody can alert on,
 * because the alert has to be written per state.
 */

export const HealthStateSchema = z.enum([
    'ok',
    /** Working, on a fallback path. The answer is still right. */
    'degraded',
    /** Not producing an answer. */
    'failing',
    /** Deliberately not checked, with a reason. */
    'skipped',
]);

export type HealthState = z.infer<typeof HealthStateSchema>;

export const HealthComponentSchema = z.object({
    name: z.string().min(1),
    state: HealthStateSchema,
    /** Human sentence. A check with no reason is a status light. */
    detail: z.string().min(1),
    /** How long the check itself took, not the thing it checked. */
    checkedInMs: z.coerce.number().nonnegative().optional(),
    /** Age of the data behind the answer, when the data has an age. */
    dataAgeMs: z.coerce.number().int().nonnegative().optional(),
    observedAt: z.coerce.number().int(),
});

export type HealthComponent = z.infer<typeof HealthComponentSchema>;

/**
 * The worst state present, and the order that is "worst".
 *
 * Degrading is not the same as failing and must never be reported as such: a
 * page fired for a degraded-but-working dashboard trains people to ignore
 * pages, and the next one is the page that mattered.
 */
const SEVERITY: Record<HealthState, number> = {
    ok: 0,
    skipped: 1,
    degraded: 2,
    failing: 3,
};

export interface HealthReport {
    readonly state: HealthState;
    readonly components: readonly HealthComponent[];
    readonly checkedAt: number;
    /** Names of the components that are not ok, worst first. */
    readonly problems: readonly string[];
    /**
     * True when every component is ok or skipped.
     *
     * Separate from `state` so a caller can ask "can I serve traffic" without
     * having to know the severity order.
     */
    readonly healthy: boolean;
}

export function summarize(
    components: readonly HealthComponent[],
    checkedAt: number,
): HealthReport {
    const sorted = [...components].sort(
        (left, right) => SEVERITY[right.state] - SEVERITY[left.state],
    );
    const state = sorted[0]?.state ?? 'ok';
    const problems = sorted
        .filter((component) => component.state !== 'ok')
        .map((component) => `${component.name}: ${component.detail}`);

    return {
        state,
        components: sorted,
        checkedAt,
        problems,
        healthy: sorted.every(
            (component) => component.state === 'ok' || component.state === 'skipped',
        ),
    };
}

export const IncidentEventSchema = z.object({
    at: z.coerce.number().int(),
    component: z.string().min(1),
    kind: z.enum([
        'degraded',
        'recovered',
        'failing',
        'open',
        'closed',
    ]),
    detail: z.string().min(1),
});

export type IncidentEvent = z.infer<typeof IncidentEventSchema>;

export interface Incident {
    readonly id: string;
    readonly component: string;
    readonly openedAt: number;
    /** The worst state seen while the incident is open. */
    readonly severity: HealthState;
    readonly events: readonly IncidentEvent[];
    readonly closedAt: number | null;
    readonly durationMs: number | null;
}

export interface IncidentState {
    readonly incidents: readonly Incident[];
    readonly open: readonly Incident[];
    readonly resolved: readonly Incident[];
}

/**
 * A running log of what was wrong, and for how long.
 *
 * The part that matters is the pairing. A failure with no matching recovery
 * leaves the system looking broken forever, and a recovery with no failure
 * erases the fact that it happened — which is the half anybody needs when
 * asking why the numbers look the way they do. So `recovered` closes the open
 * incident and is recorded against it, and the duration between the two is
 * part of the answer rather than something a reader has to subtract.
 *
 * Pure and clock-injected. A health log that calls Date.now() itself cannot be
 * tested, and an incident timeline that cannot be tested is a story.
 */
export function createIncidentLog() {
    let counter = 0;
    const incidents: Incident[] = [];

    return {
        record(
            component: string,
            kind: IncidentEvent['kind'],
            detail: string,
            at: number,
        ): Incident[] {
            const openForComponent = incidents.find(
                (incident) =>
                    incident.component === component && incident.closedAt === null,
            );

            if (kind === 'degraded' || kind === 'failing' || kind === 'open') {
                if (openForComponent !== undefined) {
                    // Escalation: an incident that worsens stays one incident.
                    // Splitting it would make "how long has this been broken"
                    // return the age of the worst moment rather than its
                    // length, which is the number people actually ask for.
                    if (SEVERITY[kind === 'open' ? 'degraded' : kind] > SEVERITY[openForComponent.severity]) {
                        incidents[incidents.indexOf(openForComponent)] = {
                            ...openForComponent,
                            severity: kind === 'failing' ? 'failing' : openForComponent.severity,
                            events: [
                                ...openForComponent.events,
                                { at, component, kind, detail },
                            ],
                        };
                    }

                    return incidents;
                }

                counter += 1;
                incidents.push({
                    id: `incident-${counter}`,
                    component,
                    openedAt: at,
                    severity: kind === 'failing' ? 'failing' : 'degraded',
                    events: [{ at, component, kind, detail }],
                    closedAt: null,
                    durationMs: null,
                });

                return incidents;
            }

            if (openForComponent === undefined) {
                // A recovery for something that was never reported as broken.
                // Recorded rather than dropped, because a system that was fine
                // and says it recovered has something to say, and swallowing
                // it hides a component whose reporting is not working.
                counter += 1;
                incidents.push({
                    id: `incident-${counter}`,
                    component,
                    openedAt: at,
                    severity: 'degraded',
                    events: [{ at, component, kind, detail }],
                    closedAt: at,
                    durationMs: 0,
                });

                return incidents;
            }

            const closed: Incident = {
                ...openForComponent,
                closedAt: at,
                durationMs: at - openForComponent.openedAt,
                events: [...openForComponent.events, { at, component, kind, detail }],
            };

            incidents[incidents.indexOf(openForComponent)] = closed;

            return incidents;
        },

        state(): IncidentState {
            return {
                incidents: [...incidents],
                open: incidents.filter((incident) => incident.closedAt === null),
                resolved: incidents.filter((incident) => incident.closedAt !== null),
            };
        },

        /** The longest outage per component, which is what a review asks for. */
        longest(component: string): Incident | null {
            const closed = incidents
                .filter(
                    (incident) =>
                        incident.component === component && incident.durationMs !== null,
                )
                .sort((left, right) => (right.durationMs ?? 0) - (left.durationMs ?? 0));

            return closed[0] ?? null;
        },
    };
}

export type IncidentLog = ReturnType<typeof createIncidentLog>;

/**
 * The components this build knows how to check.
 *
 * Declared here rather than assembled by each caller, because a health
 * endpoint whose contents depend on who is looking answers a different
 * question for every request. One of these is missing from a system that looks
 * healthy, and a missing component is indistinguishable from a working one.
 *
 * This list is the set the registry actually produces, and a test holds the two
 * together. An earlier version of it also named `indicators` and
 * `signal-pipeline`, which the registry has no way to check — a component
 * claimed here and never measured is precisely the gap the paragraph above is
 * about, so the claim was removed rather than the test relaxed.
 */
export type ComponentName =
    | 'database'
    | 'market-provider'
    | 'market-freshness'
    | 'retention';

const KNOWN: readonly ComponentName[] = [
    'database',
    'market-provider',
    'market-freshness',
    'retention',
];

export function isKnownComponent(name: string): name is ComponentName {
    return (KNOWN as readonly string[]).includes(name);
}

export const KNOWN_COMPONENTS: readonly ComponentName[] = KNOWN;

export function unknownComponent(name: string): HealthComponent {
    // Reported rather than omitted. A check that discovers a name it has never
    // heard of is exactly what somebody needs to be told about, and silently
    // returning ok for it is how a component disappears from a dashboard
    // without anyone removing it.
    return HealthComponentSchema.parse({
        name,
        state: 'failing',
        detail: `компонент "${name}" не описан: неизвестно, что с ним не так`,
        observedAt: 0,
    });
}
