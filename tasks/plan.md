# Architecture reliability remediation — 2026-09-25

## Scope and evidence

Audit the user's 27-point study against the repository, correct mistaken premises,
and implement confirmed reliability defects incrementally. Preserve the modular
monolith, existing business rules, tenant sharing doors, and independent Factory.
This is a repository implementation plan; production rollout is a separate,
observable completion condition, never implied by a passing local test.

Baseline: `2459bf52f`, original branch `pes/phase-0`; implementation branch
`chore/architecture-reliability`. Pre-existing dirty/untracked work is unrelated
and must not be staged or overwritten. Existing graph queried, then claims checked
against source. Independent read-only reviews covered tenancy, durability and
application boundaries before implementation.

## Disposition of the entire study

| # | Topic | Evidence and decision |
|---|---|---|
| 1 | Migrations | Confirmed: root/API start scripts and `railway.toml` migrate on boot. Move the existing direct-endpoint runner, including its applied-but-missing gate, into Railway pre-deploy. |
| 2 | RLS | Already has 421 workspace models, FORCE RLS, restricted role, transaction-local context and sharing doors. `workspace-adapter.ts`, `scripts/workspace-policies.mjs`. Gap: login uses same credential as migrations; add separate credential support, role audit and a two-role real-Postgres test. Never blanket-remove deliberate SECURITY DEFINER doors. |
| 3 | Process separation | Confirmed: `apps/api/src/index.ts` starts HTTP, BullMQ, polling workers and >100 crons. Extract runtime startup with distinct HTTP/worker/scheduler entry points and graceful teardown. Preserve browser event intake on API replicas. |
| 4 | Scheduling | `lib/cron/clustered.ts` already coordinates jobs; workspace leases fail closed, legacy locks fail open. Keep proven job bodies; prevent split deployment from using fail-open scheduling, and make ownership/rollout explicit. Replacing every schedule with BullMQ at once changes retry/timing semantics unnecessarily. |
| 5 | Outbox | Already exists: `EventOutbox`, `lib/events/publish.ts`, relay. Audit coverage; stockout transitions publish outside their state transaction and need repair. Do not add another outbox. |
| 6 | Idempotency | Outbound CAS claims and operation-specific gateway retry policy already exist. Inbox inline/retry paths lack execution claims; API idempotency cache is memory-only. Address durable claims and payload-conflict/restart cases; unknown provider outcomes require reconciliation. |
| 7 | Prisma | Commerce 6.19.3, Factory 7.8.0. Upgrade commerce to a verified stable 7.x, never `latest`/8 RC. Preserve custom WorkspacePg adapter behavior and generated-client consumers; validate real RLS transactions before rollout. |
| 8 | React | Root resolves 19.2.6, Web/Factory resolve nested 18.3.1; types are 18. No documented compatibility blocker identified. Align each app's React/DOM/types and verify build/browser behavior. |
| 9 | AG Grid/TS | All Grid packages resolve 36.1.0, installed TS 5.9.3 already passes requirement. Raise manifest floors and enforce matching versions; don't claim an installed TS defect. |
| 10 | Gateway | Existing centralized adapters, ledger, rate/retry/gate/trace checks and ratchets. Preserve and run contract guards; idempotency key logging alone is not execution deduplication. |
| 11 | Channel models | Existing provider-specific adapters/contracts are intentional. Keep canonical domain plus provider-specific schemas; no giant universal product abstraction. |
| 12 | Shared packages | Explicit subpath exports already exist. Default shared entry imports Node crypto (`vault.ts`); enforce a server/browser boundary before considering package churn. |
| 13 | Event versioning | Strict schemas and versions already exist in `packages/events`. Consumer helper currently forwards unchecked payload/version; validate there too. Ordering comments exceed guarantees of concurrent SKIP LOCKED relay and stream consumers: document at-least-once unordered delivery and require current-state/version checks. |
| 14 | Inbox | Parsed payload, digest, verification, workspace/account, retry/dead-letter metadata exist. Exact raw bytes are not stored. More urgent: verified pending rows can be stranded after crash; add leased processing and recoverable scheduling. Retain bounded raw bytes/verification metadata under existing retention policy if needed for forensic replay, never secrets or unverified execution. |
| 15 | Release compatibility | No explicit N/N−1 policy; deploy workflow also runs independently of CI. Gate deployment on successful checks for the same SHA and document additive API/schema evolution with critical prior-client fixtures. |
| 16 | Proxy | Deliberate security BFF: `web/src/lib/workspaces/api-proxy.ts` validates paths, strips spoofed routing metadata, preserves cookies/CSRF/workspace and OAuth paths. Existing 7 proxy tests pass. Keep this boundary; don't bypass it for speculative latency savings. |
| 17 | Media ownership | Cloudinary owns application media; `flat-file/artifact-store.ts` uses S3/R2/local for import/export artifacts. Legacy S3 image singleton appears unused. Document current ownership/deletion/retention, preserve existing media identifiers and URLs. No blanket move to S3. |
| 18 | Secrets | Existing encrypted credential and rotation implementation; audit exact metadata and infrastructure/user-secret separation. Keep deployment secrets outside DB credential payloads. No unrequested key rotation. |
| 19 | Auth | Authentication, membership, RBAC, sessions and service boundaries exist. Promote security/graph/proxy/tenant checks into authoritative CI; document all layers rather than treating RLS as auth. |
| 20 | Factory sharing | Separate SQLite/local app and copied DS with parity are deliberate (`F0-DECISIONS`, FD12). Keep business separation and enforce parity; don't introduce commerce runtime imports. |
| 21 | Factory orders | Factory currently serves Gmail→quote→production→shipping, not copied Commerce orders. No broken sync exists. Document sales/production ownership and requirements for a future opt-in versioned exchange; do not invent automatic transfer/conflict semantics. |
| 22 | Factory identity | Separate login/offline operation is intentional. Keep documented owner bootstrap/RBAC enforcement; SSO is a product decision, not a reliability fix. |
| 23 | CI | Existing CI covers drift, schema, API build and selected grid suites, but deploy doesn't depend on it. Promote critical auth/tenant/event/gateway/proxy tests and real PG checks; fail closed when required infrastructure is unavailable. Keep local hooks as convenience. |
| 24 | Provider contracts | Gateway/provider tests and fixtures exist. Extend only for concrete uncovered behavior; run existing contract ratchets and fixture suites. Never run live marketplace mutations as tests. |
| 25 | Observability | Gateway/request traces, outbox stats and cron metrics exist. Bridge existing request/change identity into event correlation; expose claim/recovery failures through current logging/metrics. Fix watchdog check-then-publish dedupe atomically. |
| 26 | GraphQL | Authenticated read-only API with per-request loaders, depth cap, 43-field permission guard and tests. No web caller does not establish no external users. Retain; deprecation requires consumer evidence. Shopify GraphQL is unrelated. |
| 27 | Migration history | Preserve history. Baseline/provisioning work already exists and records replay ordering problems. Verify new migrations independently; do not squash/delete history as part of this repair. |

## Ordered delivery

1. Release safety: pre-deploy migration lifecycle, explicit migration credential,
   fail-closed release gate and migration URL tests.
2. Tenant safety: login-role audit and a separate restricted-login test fixture;
   preserve all owner-backed sharing doors. Then upgrade Prisma with this gate.
3. Runtime separation: extract scheduling/consumption from HTTP; retain SSE
   intake, add shutdown/readiness, split deployment definitions and cutover runbook.
4. Inbox reliability: first reproduce crash/parallel delivery defects; add claim,
   fencing, bounded recovery and trusted raw metadata in additive migrations.
5. Event correctness: validate consumers, repair transactional producer gaps,
   dedupe watchdog output atomically and propagate existing correlation.
6. Client/boundary consistency: TS/Grid constraints, React/types alignment,
   shared server boundary, documentation of assets/Factory/auth/compatibility.
7. Verification and release evidence: focused tests per slice, builds, real PG,
   browser smoke for client changes, final independent review; report deployment
   and external configuration conditions explicitly.

Tasks and acceptance criteria are tracked in [todo.md](todo.md). Each implementation
slice must leave working code and evidence, with additive migrations and compatible
defaults until the coordinated operational cutover is performed.

## Invariants and rollout risks

- Old and new API/Web may coexist. Expand first; never remove/rename a persisted
  field or event version in the release that begins using its replacement.
- A stopped worker leaves durable work retryable. A second worker cannot obtain
  the same current claim. Business effects still need domain-specific idempotency.
- API replicas must retain event subscriptions even after the relay moves out.
- Production login credentials must be provisioned separately from schema-owner
  credentials; local role tests cannot prove deployed Railway/Neon configuration.
- Lease expiry cannot cancel an external API request already in flight. Fence local
  completion, reconcile uncertain outcomes and use provider keys where supported.
- Factory DS parity and its no-commerce-import boundary stay enforced.
- No live marketplace mutations, credential rotation, service creation, data
  backfill, or production deploy is implied by preparing repository changes.

## Official sources checked

- [Railway pre-deploy](https://docs.railway.com/deployments/pre-deploy-command):
  runs between build and deployment; failure prevents deployment.
- [Railway config reference](https://docs.railway.com/config-as-code/reference):
  `deploy.preDeployCommand` supports an array of commands.
- [PostgreSQL 17 RLS](https://www.postgresql.org/docs/17/ddl-rowsecurity.html):
  FORCE RLS does not constrain superusers/BYPASSRLS roles.
- [Prisma release status](https://www.prisma.io/docs/orm/release-status):
  Prisma 6 security support ends November 19, 2026; 8 is RC; use stable 7.
- [Prisma 7 upgrade](https://docs.prisma.io/docs/guides/upgrade-prisma-orm/v7):
  driver adapter/config changes require runtime validation, not just package bumps.
- [AG Grid compatibility](https://www.ag-grid.com/react-data-grid/compatibility/):
  Grid 36 requires TypeScript >=5.8.3.
- [BullMQ schedulers](https://docs.bullmq.io/guide/job-schedulers/),
  [idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs): scheduler
  identity does not replace business idempotency.
