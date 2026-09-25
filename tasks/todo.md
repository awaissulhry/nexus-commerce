# Architecture remediation tasks

Status is evidence-based: checked means implemented AND verified locally;
production completion is tracked separately. See [plan.md](plan.md).

## A. Release lifecycle (no dependencies)
- [ ] Move all API startup migration calls to Railway pre-deploy; preserve direct
  endpoint and applied-history validation. Test migration selection and start config.
- [ ] Separate `MIGRATION_DATABASE_URL` from runtime `DATABASE_URL`; safely parse
  hostnames without modifying passwords/query values. Verify malformed/missing URLs.
- [ ] Make API deployment wait for CI on the exact deployment SHA; promote existing
  architecture/security guards. Verify workflow parsing and failure paths.

## B. Tenant login and Prisma (after A)
- [ ] Audit runtime login privileges/ownership/memberships with a read-only checker.
  Add a two-role real-Postgres fixture covering raw queries, rollback, pool reuse,
  cross-tenant read/write and deliberate service doors.
- [ ] Upgrade commerce Prisma to stable 7 with matched packages and CLI config;
  validate schema, generate, build and pass real tenant/concurrency tests.

## C. Runtime roles (after A)
- [ ] Extract scheduler startup and worker startup into explicit entry points; HTTP
  still receives cross-process SSE events. Verify no background consumer runs in API mode.
- [ ] Implement bounded graceful shutdown/readiness; define separate Railway service
  configs and ordered cutover/rollback. Verify worker failure/retry and Redis outage behavior.
- [ ] Remove fail-open cron behavior from split deployment; preserve scoped lease
  execution and document durable-scheduler migration boundaries. Test competing runners.

## D. Inbox (after B for new schema)
- [ ] Reproduce stranded arrivals and concurrent inline/retry processing.
- [ ] Add atomic claims, fencing and recovery scheduling; preserve verification,
  workspace/account ownership, archive state and attempt budget. Test crash, expired
  owner, duplicate delivery and recovery race with a real database.
- [ ] Retain bounded exact bytes and safe verification metadata under documented
  retention; verify no credentials or untrusted replay bypass are introduced.

## E. Events and commands (existing outbox)
- [ ] Validate known event type/version/payload at consumers; malformed events cannot
  execute domain logic. Test supported, unknown and malformed envelopes.
- [ ] Make stockout state/event writes atomic; make watchdog dedupe atomic.
  Verify rollback and concurrent duplicate behavior.
- [ ] Propagate request/change correlation into events and record actual ordering
  guarantees. Verify correlation survives HTTP/worker/event boundaries.
- [ ] Replace memory-only command idempotency where nonrepeatable mutations rely on
  it; verify concurrent same-key, restart, payload conflict and uncertain outcomes.

## F. Clients and boundaries
- [ ] Tighten TS floor and exact AG Grid version consistency; verify lockfile checks.
- [ ] Align React/DOM/types across runtime resolution; build/typecheck both apps and
  browser-smoke auth/profile/OAuth/grid flows.
- [ ] Enforce browser/server shared-module boundary; verify no browser crypto import.
- [ ] Document N/N−1 compatibility, auth layers, media authority/deletion, secrets,
  Factory ownership and intentional separate identity/DS parity.

## G. Final evidence and rollout
- [ ] Focused suites, relevant builds, migration guards, security/contracts and real PG
  gates pass; no new suppression/skips; unrelated failures named rather than hidden.
- [ ] Independent review findings reconciled and source-linked evidence recorded.
- [ ] Production configuration verified: dedicated login, migration credential,
  service roles, CI protection, deployed health/build SHA and business-flow smoke.

Repository implementation and production rollout remain separate until evidence
exists for both. Deferred product choices (Factory sync/SSO, removing GraphQL,
relocating all media) are intentionally not fake implementation checkboxes.
