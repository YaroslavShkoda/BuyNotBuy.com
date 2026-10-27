# Dependency security and limiter degradation (YAR-83)

Reviewed against `18e0034a407c0e6b7281efd0549e8dd09f3eb46d`, 25 October 2026.
This extends [YAR-64](https://linear.app/yaroslavshkoda/issue/YAR-64) and
[YAR-76](https://linear.app/yaroslavshkoda/issue/YAR-76); their completed dependency
remediation and threat model are not repeated.

## Threat and decision

An expensive public analysis route can consume resources during a limiter-store
failure. Rotating an untrusted forwarding header must not grant a fresh budget.
The existing PostgreSQL counter deliberately **fails open**: turning a store
outage into a site-wide denial of service would multiply the outage. YAR-76 T14
records that accepted availability decision. This change preserves it, adds
visibility, and does not introduce a local fallback or change proxy trust.

`APP_TRUST_PROXY=false` remains the safe default. Enabling the current boolean
trust setting requires an ingress that overwrites forwarding headers and a
firewall preventing direct backend access. The test proves the default socket
boundary; it cannot prove the deployed proxy topology. Do not enable trust solely
because the service is behind some proxy.

## CI policy

The independent `dependency-security` job installs the lockfile with lifecycle
scripts disabled and collects both `npm audit --omit=dev --json` and the complete
`npm audit --json`. Exit 1 from npm means findings and is evaluated by the policy;
transport errors, invalid JSON, unknown report formats, incomplete references and
invalid exceptions fail closed. The gate returns:

| Exit | Meaning |
| --- | --- |
| 0 | No unexcepted runtime high/critical finding and no expired exception |
| 1 | Runtime high/critical finding or expired exception requires action |
| 2 | Evidence/exception validation failed; no clean result is claimed |

Moderate/low runtime and development findings remain visible in the retained raw
reports. Full-report high/critical findings are also included in gate JSON for
triage, without imposing a blanket failure on development dependencies. The full
report never suppresses a runtime finding. Each blocking row includes package,
advisory URL/source ID, vulnerable range, installed paths and npm's fix evidence.
An advisory URL identifies the upstream GHSA record, including its CVE mapping
when available; never invent a CVE for an audit row. Review a genuine finding by
component and reachability and either remediate the lockfile or record an owner
reviewed blocker/exception. A zero audit is evidence about the registry response,
not proof that a dependency is vulnerability-free.

`security/audit-exceptions.json` is initially empty. An exception is an exact
package/advisory pair, with these required fields:

```json
{
  "package": "affected-package",
  "advisory": "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
  "owner": "accountable owner",
  "reason": "Reachability/mitigation evidence and upgrade rationale",
  "issue": "https://linear.app/your-workspace/issue/SEC-123",
  "expires": "2026-11-01"
}
```

This is an illustrative record, not an accepted advisory. Add records only after
owner review in a normal code review. Expiry is exclusive at **00:00 UTC** on the
specified date; an expired exception fails even if its finding disappeared, so
stale approvals must be removed. Fields are strict, dates must exist, wildcards
are not interpreted, and an exception cannot cover another package transitively.

Raw runtime/full reports and gate JSON are uploaded even on failure, retained
for 14 days. Advisory collection failure may leave no gate JSON; the failed step
and raw report/stderr are the evidence. Gate output is data, never shell code.
Repository branch protection must require `dependency-security` to make the
check a merge prerequisite; this workflow does not configure branch protection.

Safe proof requires no vulnerable package installation:

```powershell
# DATABASE_URL must point to a disposable test database (per-file schemas).
npx vitest run scripts/security src/backend/api/middleware/rate-limit-degradation.db.test.ts
# Evaluate reports collected from the intended lockfile:
node --import=tsx scripts/security/audit-gate.cli.ts runtime.json full.json security/audit-exceptions.json
```

Unit cases cover severity, exact exceptions, UTC expiry, malformed records and
transitive advisory references. Executable tests pass synthetic JSON through the
real CLI and assert exit codes 0/1/2, actionable findings and development-only
reporting. No packages are downgraded and no exploit or traffic flood is used.

## Degradation evidence and alert handoff

The database integration test renames only `rate_limit_window` in its private
test schema, makes two bounded in-process requests, and restores the table in
`finally`. It verifies admission with no misleading rate-limit or Retry-After
headers, error-level `rate_limit_store_failed` events, an exempt `/metrics`, and
the original budget after store recovery. Another case rotates both forwarding
header forms and verifies that PostgreSQL contains only the socket-IP bucket.
The existing concurrency/429/probe suites remain in CI through `npm test`.

`buynotbuy_rate_limit_store_failures_total` is a process counter, always exposed
through the registry. It increments once per failed consume and has **no labels**:
IPs, raw paths and error messages cannot create cardinality growth. It does not
reset when the store recovers; process restarts reset it normally. A failed
limiter does not mean the endpoint itself returned a 5xx, so the ordinary HTTP
failure counter is insufficient.

Suggested Prometheus rule for the operator's monitoring repository:

```yaml
groups:
  - name: buynotbuy-abuse-controls
    rules:
      - alert: BuyNotBuyRateLimitStoreDegraded
        expr: sum(increase(buynotbuy_rate_limit_store_failures_total[5m])) > 0
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "PostgreSQL rate limiter is failing open"
          description: "Check DB errors, ingress limits and backend load; restore the store without globally blocking users."
```

Scope the rule to the deployment's Prometheus job/environment before activation.
Keep the scrape target `up` alert too: an unavailable metrics endpoint must not
look like recovery. A log-based alert on `event=rate_limit_store_failed` is useful
for failures before two scrapes or immediately after a process restart. Check
the DB cause, error logs, traffic and CPU; restore access, then confirm that the
counter stops increasing and rate-limit headers return. Never reset the counter
to silence the alert. The integration test demonstrates the emitted event and
scraped counter; **Prometheus/Alertmanager routing and notification delivery are
not deployed or tested here**. Operator activation and a staging notification
drill remain an operational acceptance step, not a claim of a live alert.

An ingress limit is preferable for store outages: it protects before application
CPU work and is independent of PostgreSQL. Choose deployment-specific per-client
and aggregate concurrency budgets, preserve probes, and account for NAT/shared
clients. A local fallback needs an explicit decision covering a bounded key
cache, expiry, eviction under churn and per-instance multiplied limits; a global
process bucket risks blocking all clients behind one shared proxy. Neither
alternative is activated by this change.

## Supply chain and credentials

Action refs were resolved directly from the upstream repositories with
`git ls-remote <repository> refs/tags/<tag> refs/tags/<tag>^{}` on 25 October 2026:

| Upstream tag | Pinned commit |
| --- | --- |
| [actions/checkout v7](https://github.com/actions/checkout/tree/3d3c42e5aac5ba805825da76410c181273ba90b1) | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| [actions/setup-node v7](https://github.com/actions/setup-node/tree/949feb2413d6458794dcd2491c4babbbce0c15c1) | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| [actions/upload-artifact v4](https://github.com/actions/upload-artifact/tree/ea165f8d65b6e75b540449e92b4886f43607fa02) | `ea165f8d65b6e75b540449e92b4886f43607fa02` |

All jobs keep `contents: read`; checkout does not persist credentials. There is
no `pull_request_target`, production credential, OIDC token permission, publishing
step or secret interpolation into shell commands. The PostgreSQL password in CI
belongs solely to an ephemeral test service. Builds/test jobs still need their
existing installation behavior; the advisory-only job disables lifecycle scripts.
`npm ci` plus lockfile integrity provides reproducible package selection, while
the action SHA identifies the exact action source. Neither is a build provenance
attestation. Signed release provenance/registry-signature verification is not
claimed by this workflow. `postgres:18` and the hosted runner image remain mutable
within their selected release lines; digest pinning/update automation is a
separate maintenance decision. No dependency manifest/lockfile is changed by
YAR-83.

Primary references: [GitHub secure use](https://docs.github.com/en/actions/reference/security/secure-use),
[npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/),
[Prometheus increase](https://prometheus.io/docs/prometheus/latest/querying/functions/#increase).

## Local verification snapshot

On 25 October 2026 both audit commands exited 0 with all severity counts zero;
the gate over those reports exited 0. The examined lockfile SHA-256 was
`cdc49453f07a79cf9190f43afb26089b0acc3f9e3f6beb149a75db8f4e63bac2`.
Actual resolved versions were zod **4.6.7**, vitest **5.0.5**, fastify **5.12.7**,
fast-uri **4.2.3**, next **16.4.2** and playwright **1.64.1**. In particular `^4.6.5` in package.json is
not the installed zod version. This agrees with the YAR-64 remediation versions.
Re-run the audit when the lockfile changes. The final audit captured the same
lockfile fingerprint before and after both commands and includes the browser
test dependency addition.

The targeted run of scripts/security, degradation integration, rate-limit DB,
HTTP hardening and observability passed **11 files / 161 tests**, exit 0. Script
type checking (`npx --no-install tsc -p scripts/security/tsconfig.json`, TypeScript
7 with explicit Node types) and scoped Biome checks passed.
The pre-instrumentation integration run failed specifically because the new
failure counter was absent. Local checks do not establish that a remote GitHub
Actions run has executed; its run URL and branch protection remain external
release evidence. Final full-suite evidence belongs to the combined Stage 6
verification after concurrent changes settle. No production environment or live
provider was contacted, and no remote scanning was performed.
