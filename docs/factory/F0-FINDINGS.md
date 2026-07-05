# Factory OS findings (F0)

F0 deliverable 6 of 6 — everything discovered during research that changes scope, risk, or assumptions in the master prompt. Ranked by consequence. Each item names its mitigation and where it is now encoded (architecture/decision/IA). Nothing here was silently fixed — this is the flag-don't-fix record.

## 1. Gmail's 7-day trap is real — and the legal escape is documented (risk class: platform-critical)

For an External OAuth app in **Testing** mode, refresh tokens expire every 7 days (verified in Google's current docs) — a naive setup bricks the front door weekly. The verified path: **publish to Production, deliberately unverified**, which Google's own personal-use exemption permits for <100 users (including restricted scopes; lifetime cap of 100 restricted-scope grants per project). Residual policy risk: Google has tightened adjacent policies repeatedly (LSA basic-auth killed 2025, POP retirement 2026) — so the architecture hedges three-deep (the specific Google documentation URLs backing every claim in this item are listed in F0-ARCHITECTURE §Gmail "Policy sources"): transport-agnostic `MailStore`, IMAP/app-password fallback verified alive (with lossless `X-GM-THRID`/`X-GM-MSGID` id mapping), and Workspace Internal (~$7/mo) as the terminal escape hatch. Silent refresh-token death triggers are documented (password change with Gmail scopes among them) → token watchdog + one-click re-consent. **Encoded in:** F0-ARCHITECTURE §Gmail, FD10.

## 2. Drive is NOT the bulk-media store — a scope correction to the master prompt (Part III §3)

The free 15 GB quota is shared across Gmail + Drive + Photos — the mailbox itself eats it, and production/fit-check videos would exhaust it quickly. Amendment: bulky media lives on **local disk** as the default asset store; Drive holds customer-shared files (quotes, photos chosen for sending) in per-party/per-order folders; an in-app quota meter reads `about.get`; `thumbnailLink` is hours-lived and must be cached locally, never hot-linked. €1.99/mo for 100 GB exists if the Owner ever wants cloud media anyway (an Owner decision — it has a price tag). **Encoded in:** FD4, F0-ARCHITECTURE §Drive.

## 3. Sendcloud API access is plan-gated — a $0 caveat on FD6

API access starts at **Lite (€28/mo + €0.10/label)**; the "Tracking API" pricing row starts at Growth and the exact Lite boundary is unverified. Xavia already operates Sendcloud, so the marginal cost is likely zero — but **verify the plan tier during the F1 spike** before treating the label engine as free. The free `sendcloud:letter` method exercises the full create→label→track flow without spending anything. Aggregator repricing risk is real (EasyPost restructured overnight in Feb 2026) — the `CarrierAdapter` interface is the isolation layer. **Encoded in:** FD6, F0-ARCHITECTURE §Carrier.

## 4. `packages/database` cannot be shared — factory needs its own Prisma world

The repo's Prisma home is hard-wired to Postgres/Neon (`provider = "postgresql"`, `@prisma/adapter-pg`, Neon-tuned pool, `DATABASE_URL`). Prisma schemas are single-provider, so the factory's SQLite schema is necessarily separate — with a **custom client `output` path** (two default-output clients would collide in the hoisted `node_modules/@prisma/client`) and its **own env var** (`FACTORY_DATABASE_URL`; `DATABASE_URL` is claimed). Good news from the same research: enums and Json ARE supported on SQLite since Prisma 6.2 — the master prompt's era of "strings + app-level unions" is over (enforcement is runtime-only; zod at boundaries + weekly integrity sweep). **Encoded in:** F0-ARCHITECTURE §Stack + §Data model.

## 5. React version hoisting trap in the monorepo

Root `package.json` declares react **^19.2.5** (hoisted install currently 19.2.6) while `apps/web` declares **^18.2.0** (resolving nested to 18.3.1 — a caret range, not a true pin). A new app that forgets to declare its own react/react-dom silently inherits 19.x. `apps/factory` must declare **exact-pinned** react/react-dom — something apps/web itself does not do — and decide 18-vs-19 consciously at F1 against the copied DS components' expectations. **Encoded in:** F0-ARCHITECTURE repo tree note; F1 checklist.

## 6. Design-system token drift — the generated file is the truth

11 `--h10-rail-*` variables exist only in the **generated** `styles/tokens.css` (added directly by commit `99746dbe`) and in scoped `ads.css` blocks — `tokens/css-vars.ts` does not list them. Copying css-vars.ts alone would lose the rail palette. Also upstream: a pending `.h10-*` → `.nx-*` class rename (DS Phase 9) will eventually land — the parity script treats it as a re-sync event. **Encoded in:** F0-DESIGN-BRIDGE copy table + parity checklist, FD12.

## 7. Comments/@mentions: Nexus has the bones, not the system — build-new is validated

Two entity-scoped pockets exist (`PoComment` with a `mentions` array; `WorkflowComment` without mentions) and **neither delivers a notification** — no inbox item, no unread state, no autocomplete (the "@-picker" named in a schema comment was never built). This validates the master prompt's F1 primitive: ONE polymorphic `Comment` table + mention → notification fan-out + real autocomplete, instead of adopting a fragmented precedent. Worth stealing from the pockets: the `mentions` array shape, the (scopeId, createdAt) compound-index shape — `PoComment`'s `@@index([purchaseOrderId, createdAt])`, generalized to `@@index([entityType, entityId, createdAt])` on the polymorphic table — the ⌘+Enter composer, and publish-on-create to the event bus. **Encoded in:** F0-ARCHITECTURE §Primitives.

## 8. RBAC field-gating has documented escape hatches — factory closes them at birth

The Nexus S-series field filter is `preSerialization`-based and its own docs record the gaps: CSV/XLSX exporters and SSE payloads bypass it (the direct-call follow-up never landed), the client-side financial `<Can>` sweep never happened (exactly one `usePermission` call site in all of apps/web), and the financial-only-route list is declared but unwired. Factory OS inherits the pattern with the gaps closed by design: naming discipline (`*Cents`/`*MarginPct`) so name-stripping is sufficient, the strip function called explicitly by every exporter/PDF/email renderer (a Worker-visible work-order PDF must not embed prices), financial-only routes mapped in the manifest, and grid columns carrying `permission?:` keys. **Encoded in:** F0-ARCHITECTURE §RBAC.

## 9. EN 17092 / EU PPE compliance is an unserved differentiator (scope addition — Owner approval requested)

None of the apparel verticals (ApparelMagic, WFX, BlueCherry) treats certificates/test reports as first-class data; they model US CPSIA-style docs at best. This factory ships CE-classed motorcycle garments under EU PPE Regulation 2016/425 / EN 17092 — a certificate registry (class AAA–C, cert number, notified body, expiry, covered styles/sizes) + a QC gate (PACKING blocked when the cert is missing/expired) + DoC auto-attach on shipment is cheap to build and impossible to retrofit into any competitor. Proposed as FD14 (Rec: include). **Encoded in:** FD14, F0-IA Products/Production, F0-ARCHITECTURE data model (`Certificate`).

## 10. MeasurementProfile is a first-class entity the domain model was missing

The made-to-measure teardown (Tailornova, MTM suites, race-suit programs) converges on **named, versioned measurement sets decoupled from any order** — with fit/posture/injury notes and photos, referenced by many orders, plus the self-measure-kit-by-email pattern and a specialist review gate before confirming a submitted configuration. Added to Part IV's model as `Party → MeasurementProfile[]` (append-only versions). Deposit gating (30%/50% observed) rides with it as FD13. **Encoded in:** F0-ARCHITECTURE data model, F0-IA Contacts/Quotes, FD13.

## 11. The wedge is confirmed — including by the closest living relative

Fulcrum is philosophically adjacent (quote-centric, live cost breakdowns, capable-to-promise dates, anti-per-user pricing) and still treats email as **send-only**. Front/Missive own the thread but have no domain behind it (a linked "order" is a stateless URL chip). Katana/MRPeasy/SAP/Odoo all start at a typed form. No platform surveyed — 25+ — owns sender-matched, thread-born, price-list-scoped quoting. The moment the order is born remains unowned; that is the product. **Encoded in:** F0-TEARDOWN synthesis (the one-sentence result).

## 12. Concurrent-session churn is an operational constraint on the copy plan

Multiple agent sessions commit to main continuously; `_shared/grid-lens/` and `_shared/bulk-edit/` (both on the vendored-spine list) were modified at session start and committed by parallel sessions mid-recon; `ebay/ebay.css` changed mid-inventory. Consequence: the F1 copy is taken from committed HEAD at copy time, drift is *measured* (parity script) rather than assumed away, and factory commits use `git commit --only` on factory paths. **Encoded in:** F0-DESIGN-BRIDGE §No-touch #5, FD12.

## 13. ERPNext is the free-forever benchmark — and the answer is written down

The only credible $0-license full ERP (v16: work-order stock reservation, job cards, MPS). Why it is not the base: the golden flow is absent (no Gmail-born quoting, Item Variants ≠ live-margin configurator, doctype-forms floor UX), and self-hosting is a stack (MariaDB + 3×Redis + Python/Node workers + wkhtmltopdf) with real sysadmin burden vs one SQLite file. What we take anyway: docstatus immutability discipline and WO material reservation. Kept as the honesty benchmark for every FP-cycle spec. **Encoded in:** F0-TEARDOWN (sweep + gems).

## 14. Small stack traps, pinned so F1 doesn't rediscover them

- Prisma 7 requires driver adapters + `prisma.config.ts`; env vars no longer auto-load; seed doesn't auto-run — pin 7.8.0 + pinned better-sqlite3 (7.3.0 had to dodge an upstream SQLite bug).
- WAL is not enabled by Prisma — pragmas at the client factory; `BEGIN IMMEDIATE` for read-then-write; never put the live DB in a cloud-synced folder (snapshots/replicas only).
- FTS5 shadow tables trip `migrate dev` drift detection (prisma#8106, open) — register in `tables.external`.
- Next `instrumentation.ts` evaluates multiple times in dev (#51450) — the reason the poller is a sidecar (FD11).
- Litestream 0.5.0 shipped restore regressions (fixed by 0.5.2; current 0.5.13) — pin ≥0.5.13 and run scheduled restore drills; backup that can't restore isn't backup.
- Gmail send cap: 500 recipients/rolling-24h on personal accounts — review-request batches queue against a daily budget.
- i18n: the repo's catalog parity gate scans `apps/web/src` only; factory UI is English-only per the standing operator-language policy, so factory opts out of the catalog system in v1 (a `useT`-shaped shim keeps the door open).

## 15. Session-limit interruption during F0 (process note)

The first research fan-out hit the session usage cap and 18 sub-investigations died mid-flight (three had already written complete outputs and were salvaged; the rest re-ran cleanly after reset). No data loss, no repo impact — noted because multi-agent research bursts consume quota quickly and future F-phase fan-outs should be sized with that in mind.
