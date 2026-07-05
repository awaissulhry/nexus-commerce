# NEXUS FACTORY OS — THE PLAYBOOK (canonical handoff & operating manual)

Last updated 2026-07-05 (after: F0 · F1 · FP1 Inbox · FP2 Products & Pricing · FP3 Quotes · FP4 Orders · FP5 Contacts · FP6 Production · FP7 Materials · FP8 Shipping all shipped — **the golden flow is CLOSED end to end**: Gmail thread → quote → order → production (stages + material ledger + EN 17092 gate) → materials (four-column fold + shortage→PO) → **shipping (buy-and-print label → tracking into the thread → SHIPPED→DELIVERED, built behind a FakeCarrier so it's proven at $0; real Sendcloud on connect)**. Owner ran Q-1→ORD-1→IN_PRODUCTION live. FP9 Financials next on approval — order-level money truth, NOT accounting). **This file is the single entry point for ANY model session working on Factory OS.** Read it top to bottom before touching anything. It tells you what this product is, what exists, what is approved, how to build every remaining page, the design law, and every trap already paid for. Deeper canon lives in the sibling docs — this file tells you when to open which.

**The document set (all in `docs/factory/`):**

| File | What it is | Open it when |
|---|---|---|
| `PLAYBOOK.md` | This file — the map + operating manual | Always, first |
| `F0-IA.md` | Approved information architecture: 11 pages, purposes, cycle order | Starting any page cycle |
| `F0-ARCHITECTURE.md` | Stack, ERD, Gmail/Drive/carrier designs, RBAC recipe | Touching schema, integrations, auth |
| `F0-TEARDOWN.md` | 25+ competitor teardowns with ADOPT/ADAPT/BEAT/IGNORE verdicts | Writing any FP spec (verdicts are citable law) |
| `F0-DECISIONS.md` | FD1–FD14 decision register (all approved as recommended) | Before re-litigating anything — don't |
| `F0-DESIGN-BRIDGE.md` | Design-system copy plan, rail spec, parity checklist, no-touch rule | Any UI work |
| `F0-FINDINGS.md` | Risk register (Gmail policy, Drive quota, plan gates…) | Integration work |
| `F1-REPORT.md` | What the foundation actually is + deviations + gate fixes | Understanding existing code |
| `FP1-SPEC.md` | The approved Inbox spec (gate 1 passed 2026-07-05) | Building FP1 — it is binding |

---

## 1. Mission (what you are building and why it wins)

A **local-first platform that runs a small Italian leather/motorcycle-apparel factory end-to-end**. The owner also runs "Xavia" (moto gear on Amazon IT) on the commerce side of this monorepo — the factory platform is a SEPARATE app with a SEPARATE database.

**The product IS this golden flow:** email arrives in Gmail → sender auto-matched to a Brand/Customer → configurator opens pre-scoped to that party's price list → options picked (leather, lining, armor, perforation, sizing, branding) → price composes live **with margin visible** → quote sent from the same Gmail thread → approval turns it into an Order → Order explodes into a Work Order (CUTTING → STITCHING → ASSEMBLY → QC → PACKING) with material reservations → carrier label in two clicks → tracking auto-shared in the thread → delivered → review requested. Everything commented (@mentions), audited, bulk-operable, import/export-friendly.

**Why it beats everything (verified across 25+ products in F0-TEARDOWN):** nobody owns the moment an order is born. ERPs (SAP, Odoo, Katana, MRPeasy, Fulcrum) start at a typed form; inbox tools (Front, Missive) stop at the conversation. We own the email → everything chain. Constraints that are law: **$0 infrastructure** (SQLite on the owner's machine, free API tiers), **zero-training UI**, tiny team (Owner + a few workers), depth-not-breadth.

## 2. Non-negotiable rules (violating any of these is a failed session)

1. **NO-TOUCH:** never modify `apps/web`, `apps/api`, or anything outside `apps/factory/` + `docs/factory/` (root `package-lock.json` changes from installs are the accepted exception). Enforced by `npm run check:no-touch -w @nexus/factory`. Patterns are COPIED in, never imported across.
2. **Double gate per page cycle:** (1) write `FPn-SPEC.md` → Owner approves → (2) build → click-through verification → Owner approves. **Never build ahead of an approved spec. Never widen scope mid-build** — new ideas go to §12 backlog or the spec of a later cycle.
3. **No time estimates. Ever.** Not in docs, not in messages.
4. **Never print secrets** (tokens, keys, `FACTORY_ENCRYPTION_KEY`, password values). Env templates carry names only.
5. **No fake data presented as real.** Seeds create config (roles, price list, stages), never demo entities. Test rows created during verification are removed afterwards (the append-only AuditLog keeps the honest record).
6. **Append-only stays append-only:** `MovementLedger` and `AuditLog` rows are never updated or deleted. Corrections are compensating entries.
7. **Commit style:** conventional prefix + `(factory)`, body explains why, footer `Co-Authored-By: Claude <model> <noreply@anthropic.com>`. Commit **scoped**: `git add apps/factory docs/factory && git commit --only apps/factory --only docs/factory/<file>` — parallel sessions commit to main constantly; never `git add -A`. Push after each verified unit; if push is rejected with "cannot lock ref … is at <YOUR sha>", a concurrent session already pushed your commit — `git fetch` and verify, don't panic.
8. **File headers:** every non-trivial factory file opens with a comment tagged by phase code (`F1 —`, `FP1.3 —`) explaining what it is. Docs use the house style (H1 + preamble + phase-coded H2s, tables over prose, ❌→✅ anti-pattern pairs where useful).
9. **Verify before declaring done:** unit tests green (`npm test -w @nexus/factory`), `check:rbac` + `check:no-touch` + `check:ds-parity` green, `next build` green, and a **runtime smoke** (see §10 for how to do this WITHOUT breaking the Owner's running server — we broke it once; never again).
10. **Report honestly at gates:** eng trans (plain English for a business owner), files changed, click-through script, findings/deviations, rollback notes. Defects discovered out of scope are FLAGGED (Findings), not silently fixed.

## 3. Current state ledger (2026-07-05)

| Milestone | Status | Commit(s) |
|---|---|---|
| F0 research gate (6 docs) | ✅ approved by Owner ("proceed however you recommend") | `3e60bdff` |
| F1 foundation (workspace, schema 43 models, RBAC, shell, primitives, Gmail/Drive/Sendcloud integrations, worker) | ✅ shipped + Owner click-through in progress | `817747dd` |
| Gate fixes: rail parity overrides (344px spec), OAuth form UX + validation | ✅ shipped | `b3498681` |
| Gate fixes: changeable Gmail label scope, dev-build isolation (`.next-dev`) | ✅ shipped | `9df4ccf0` |
| FP1 Inbox spec | ✅ approved by Owner ("Approved. Please proceed.") | `d267b058` |
| FP1 Inbox build | ✅ **SHIPPED + verified** (backend core / API surface / three-pane UI / fixes) — gate report `FP1-REPORT.md`; ⏳ awaiting Owner click-through (live reply send is the Owner's step) | FP1.1–FP1.4, ends `c39ee15f` |
| FP2 Products & Pricing | ✅ **SHIPPED + verified** (engine/templates/materials/certs/price-lists/preview/imports) — gate report `FP2-REPORT.md`; ⏳ awaiting Owner click-through | FP2.1–FP2.5, ends `5a0a9923` |
| FP3 Quotes | ✅ **SHIPPED + verified** (CRUD-on-engine / pipeline+configurator / PDF+send+Inbox wiring / public-accept+convert+recall+export / golden-flow verify) — binding spec `FP3-SPEC.md`, gate report `FP3-REPORT.md`; ⏳ awaiting Owner click-through (live send is the Owner's step). Golden flow's first half closed: Inbox → quote → send → accept → **ORD-1**. Built on Opus 4.8. | FP3.1–FP3.5, ends `86276d87` |
| FP4 Orders | ✅ **SHIPPED + verified** (lifecycle core / board + one-timeline / start-production + deposit gate + payments / kanban + size-run + export) — binding spec `FP4-SPEC.md`, gate report `FP4-REPORT.md`; ⏳ awaiting Owner click-through. Golden flow now unbroken: thread → quote → order → **start production → deposit gate → unblock** → lifecycle → CLOSED. Additive migration `WorkOrder.label`; @dnd-kit already present. Built on Opus 4.8. | FP4.1–FP4.4, ends `17c28e06` |
| FP5 Contacts | ✅ **SHIPPED + verified** (CRUD + Overview / versioned measurements / history tabs / compare-pricing + export) — binding spec `FP5-SPEC.md`, gate report `FP5-REPORT.md`; ⏳ awaiting Owner click-through. The CRM spine: identity + emails(matchDomain) + price list, Tailornova versioned measurements, linked-history tabs, and the Owner's side-by-side price comparison. Migration-free. Built on Opus 4.8. | FP5.1–FP5.4, ends `6a8c9994` |
| FP6 Production | ✅ **SHIPPED + verified** (stage engine / board+drawer / reservations+coverage+consume / QC+cert-gate+scrap+cost / Worker kiosk+order-READY) — binding spec `FP6-SPEC.md`, gate report `FP6-REPORT.md`; ⏳ awaiting Owner click-through. The floor: 5-stage board w/ timers, material ledger (RESERVE/coverage/priority-realloc/consume), EN 17092 cert gate (FD14), cost-blind Worker kiosk. Migration fp6_production (WorkOrder.orderLineId + WorkOrderStage.pausedAt). Built on Opus 4.8. | FP6.1–FP6.5, ends `3d3c62c0` |
| FP7 Materials | ✅ **SHIPPED + verified** (four-column stock fold / adjust / detail movements+lots / Purchase Orders DRAFT→SENT→PARTIAL→RECEIVED / receive→lot→IN / "+ Buy" from shortage / reprice-ripple + where-used / ledger export) — binding spec `FP7-SPEC.md`, gate report `FP7-REPORT.md`; ⏳ awaiting Owner click-through. The ledger's face: In stock/Committed/Expected/Available per material, shortage→PO handoff (FP6's red lights become real POs), cost-blind Worker (test-pinned). Migration-free. Built on Opus 4.8. Deferred: opening-stock CSV import + lot→WO traceability view. | FP7.1–FP7.4, ends `a25e6662` |
| FP8 Shipping | ✅ **SHIPPED + verified** (CarrierAdapter alive: Fake + Sendcloud + resolve / two-click buy-and-print / READY→SHIPPED / worker tracking poll → SHIPPED→DELIVERED / Share-tracking into the thread / void / day-sheet / bulk-buy / shipments CSV) — binding spec `FP8-SPEC.md`, gate report `FP8-REPORT.md`; ⏳ awaiting Owner click-through (connect Sendcloud + one €0 unstamped label = the live step). Built behind FakeCarrierAdapter so the whole flow is proven headless at $0; real Sendcloud runs on connect. Additive migration `fp8_shipping` (Shipment shipTo/parcel/labelFormat + Party.addressJson). Built on Opus 4.8. Deferred: real pickup-API booking, auto-send tracking, true multicollo, returns. | FP8.1–FP8.4, ends `<FP8.4>` |
| FP9 Financials | **NEXT on FP8 approval** — spec first; order-level money truth (quoted/invoiced/paid/balance + est-vs-actual margin + deposits outstanding + period export for the commercialista) — explicitly NOT accounting (§11 FP9 seed) | — |
| FP10…FP11 | Not started; spec-first, in the §11 order | — |

**Owner's live instance state:** Google connected (`xaviaracing.it@gmail.com`), scope = whole `INBOX` (Owner defers a dedicated "Factory" label — re-scope any time via the Change button in Settings › Integrations), ~50 conversations / 86 messages synced incl. real orders ("AWA ORDER 652/2026 BARTOCCETTI"), worker healthy, **Drive folder created ✓**, Sendcloud NOT connected yet (Owner defers; blocks nothing until FP8), **0 parties imported** (so all senders show unmatched — FP1's party-create flow and/or a contacts import will light this up). Owner password was rotated by the Owner (never in `.env`; sessions server-side).

## 4. Repo map & runbook

```text
apps/factory/                     ← the ONLY code home
  package.json                    @nexus/factory · react 18.3.1 EXACT-pinned (root hoists 19.x — the trap is real)
  next.config.js                  distDir = FACTORY_BUILD_DIR || ".next"  ← dev isolation, see traps
  prisma.config.ts                Prisma 7: engine "classic" + datasource.url HERE (not in schema); excluded from tsconfig
  prisma/schema.prisma            43 models; SQLite; enums OK (runtime-enforced only)
  prisma/migrations/              committed; additive-only while the Owner's server runs
  src/generated/prisma/           generated client (gitignored) — import from "@/generated/prisma/client"
  src/design-system/              VERBATIM copy of apps/web DS (97 files, byte-identical) — see PROVENANCE.md; NEVER edit; overrides go in globals.css
  src/app/globals.css             fonts glue + H10 rail parity overrides + page-level css
  src/app/(app)/…                 11 pages (10 = ComingSoon empty states, settings/* live)
  src/app/api/**/route.ts         EVERY route exports `permission` + wraps handlers in guarded() — coverage-checked
  src/lib/                        db (WAL) · auth/* (registry, sessions, guard, strip, guardrails) · audit · ledger ·
                                  comments · notifications · events (SSE bus) · csv + imports/parties · ttl-cache · vault ·
                                  google/{oauth,gmail-sync} · carriers/{types,sendcloud} · nav (page registry) · api-client
  src/components/                 FactoryShell (rail) · ComingSoon · NotificationBell · CommandPalette · Providers
  worker/index.ts                 sidecar: heartbeat 30s · Gmail history poll 10s · nightly VACUUM snapshot (rotate 14)
  scripts/                        setup · seed · reset (guarded) · bootstrap-owner · set-password · db-smoke ·
                                  check-rbac-coverage · no-touch-check · ds-parity-check
docs/factory/                     the canon (see table at top)
```

**Commands (always from repo root, or `cd apps/factory` explicitly — see traps about cwd):**

```bash
npm run dev -w @nexus/factory          # Owner's runtime: web :3100 (.next-dev) + worker, one command
npm test -w @nexus/factory             # vitest (38+ tests)
npm run check:rbac -w @nexus/factory   # every route mapped or fail
npm run check:no-touch -w @nexus/factory
npm run check:ds-parity -w @nexus/factory
npm run db:migrate -w @nexus/factory   # prisma migrate dev (CWD must be apps/factory)
```

**Env (`apps/factory/.env`, gitignored):** `FACTORY_DATABASE_URL` (empty ⇒ defaults to `apps/factory/data/factory.db`), `FACTORY_ENCRYPTION_KEY` (64-hex, generated by `setup`), `FACTORY_RBAC_MODE` (shadow now; **enforce before any second user gets a login**), `FACTORY_OWNER_EMAIL`. All resolvers treat empty string as unset (`||`, never `??`).

**Auth model:** server-side sessions (opaque token, sha256'd), cookies `factory_session` (HttpOnly) + `factory_csrf` (double-submit; mutations need `x-factory-csrf` header — `src/lib/api-client.ts` does this). Roles: OWNER (implicit-all) + WORKER (production/materials only, ZERO financial grains). Field-strip: any `*Cents`/`*MarginPct`-style key is deleted from responses for callers without the grain (`src/lib/auth/strip-financials.ts`) — **exporters/PDF/email renderers must call it explicitly** (serialization hooks don't cover them).

## 5. Architecture essentials (what you must know before writing code)

- **One Next.js 16 App Router app** (UI + API route handlers, port 3100) + **sidecar worker process**. They share ONE SQLite file under WAL (`src/lib/db.ts` sets pragmas; keep write transactions short).
- **Prisma 7.8.0 pinned** + `@prisma/adapter-better-sqlite3`. Schema has NO datasource url (Prisma 7 moved it to `prisma.config.ts`). Custom client output. Enums/Json work on SQLite but are runtime-enforced only — zod-validate at boundaries.
- **Events/real-time:** in-process bus + SSE at `GET /api/events` (25s heartbeat, `?since=` ring replay) + client hook `useFactoryEvents([types], cb)` (debounced). **KNOWN GAP + APPROVED FIX (build it in FP1.1):** the worker is a separate process — its `publishEvent()` never reaches web SSE clients. Fix: `FactoryEventOutbox` table (id autoincrement, type, payload Json, createdAt); worker writes durable events there; the SSE route handler polls the outbox every ~3s per connection (cheap at this scale) and forwards rows with id > last-seen; worker prunes rows older than ~10 min. Without this, "new mail appears live" does not work.
- **Gmail:** `src/lib/google/oauth.ts` (Desktop client, loopback = our own `/api/integrations/google/callback`, PKCE, refresh token Vault-encrypted; consent screen MUST be External + **published to Production** — Testing mode expires tokens every 7 days) and `gmail-sync.ts` (label-scoped backfill ≤50 threads + `history.list` incremental; 404 ⇒ full resync). Sync currently stores headers + snippet only — FP1 adds bodies.
- **Sending email (FP1 builds this):** `messages.send` with raw MIME; correct threading needs ALL THREE: `threadId` param + `In-Reply-To`/`References` headers (store `rfcMessageId` per message) + matching `Subject` (`Re: …`). Practical attachment limit ~15–18 MB MIME total.
- **Drive:** root folder "Nexus Factory" exists (id on the GoogleConnection row). `drive.file` scope = we only see files we created. Per-party folders: create lazily, cache ids (AppSetting `drive.folders` map). Never hot-link `thumbnailLink` (hours-lived).
- **Sendcloud:** connector + capability probe exist (`src/lib/carriers/`); label purchase/tracking/pickup land in FP8 behind the `CarrierAdapter` interface in `types.ts`. Owner has a subscription; NOT yet connected in-app.
- **Search:** `GET /api/search` (LIKE-based, permission-filtered per entity) + ⌘K palette. FTS5 upgrade is backlog, not now.

## 6. Design law (how every page must look and feel)

- **Build ONLY from `src/design-system/`** (the copied H10 system: 19 primitives, 24 components, 11 patterns — `Button, Input, Pill, Tag, Listbox, Combobox, DateField, Tabs, Card, Banner, EmptyState, Modal, Drawer, Menu, DataGrid, Toast(useToast → `toast(msg, tone)`, NO `.success()` shorthands), Skeleton, SegmentedControl, FileDropzone, Stepper, Pagination, MetricStrip, PageHeader, BulkActionBar, GridToolbar, FilterBar, PreferencesModal, Builder…`). **NEVER edit the DS copy** — factory-specific CSS goes in `globals.css` scoped under `.factory-frame`; a DS gap = compose locally on tokens (`var(--h10-*)`, `var(--text-*)`, `var(--surface-*)`).
- **Tokens you'll reach for:** primary `#1f6fde` = `--h10-primary`; canvas `--h10-bg`; card `--h10-surface`; borders `--h10-border/-subtle`; text `--h10-text/-2/-3`; washes `--h10-wash-primary`; radii `--h10-radius-lg/xl/2xl` (8/10/12); type is 13px base / 12.5px secondary / 11.5px meta; money via `src/design-system/lib/format.ts` (`eur(cents)`) ONLY.
- **The rail is sacred** (Owner's favorite): 66→344px hover-expand (overlay, content never shifts), 46px rows, 15px/600 labels, 50px icon zone w/ 20px lucide glyphs, active = blue fill + white (same weight), badge at left:29/top:6, chevron balance rule (17px margin-right). Parity overrides live in `globals.css` — don't undo them.
- **Quality bar on every page:** skeletons never spinners; zero layout shift; every monetary value formatted + grain-gated; integration-backed panels show a freshness line ("mail synced 8s ago"); destructive/money actions state consequences; empty states carry a purpose line + next action; no dead links; keyboard access for the core loop; English UI (Italian is for customer-facing CONTENT only).
- **Escalation ladder for risky actions:** cheap action → confirm with consequence bullets; bulk/irreversible → **dry-run diff → apply-valid-rows** (the CSV import in Settings › Import/Export is the reference implementation — reuse its shape: parse-pure / diff / apply, one endpoint with `dryRun`, per-row `from/to/note/error`).
- **Page skeleton convention:** `src/app/(app)/<page>/page.tsx` (thin) → `_components/<Page>Client.tsx` (state container) → siblings per pane. Register/adjust the page in `src/lib/nav.ts` (it drives the rail, permissions, and the ComingSoon copy — when a page goes live, its page.tsx stops rendering `ComingSoon`; nav.ts needs no change unless the page's identity changes).
- **Content-width convention (2026-07-05, `globals.css`):** the shell `<main>` fills the width, so a bare capped-and-LEFT-aligned page container strands whitespace on the right — never do that. Instead, per archetype: **list / board / workspace** pages FILL with `className="factory-page"` — add `factory-grid-grow-N` on the same root to let the primary NAME column absorb the slack (N = its 1-based column index: Products col1=Template, Quotes col2=Party), so few-column grids read "name … data cluster" not a hollow spread; **editor / detail** pages CENTER at 1180 via `className="factory-page--centered"` (comfortable working width, symmetric margins); **forms / empty-state / ComingSoon** pages use `.factory-coming` (centered). `grow-N` is column-INDEX coupled — reorder columns ⇒ update N. Verify new pages headlessly at 1512/1728/1920 (fill=100%+symmetric or centered-symmetric; DS `Modal` grids portal to body, so import-diff grids are unaffected).

## 7. Domain model (invariants a takeover session must not break)

Schema: `apps/factory/prisma/schema.prisma` — read it; it is the ERD from `F0-ARCHITECTURE.md` §Data model. The invariants:

- **Money = Int CENTS, `*Cents` suffix; percentages `*Pct` Float.** The field-strip works BY NAME — a money field without the suffix is a security bug.
- **MovementLedger** (types IN/OUT/ADJUST/RESERVE/RELEASE): append-only; ADJUST alone may be signed and REQUIRES a reason; consumption of reserved material = OUT + RELEASE pair; stock/committed/available are FOLDS (`src/lib/ledger.ts::foldMovements`) — never stored.
- **Docstatus discipline:** sent quotes freeze (`QuoteVersion.sentSnapshot`); edits create v2. Confirmed orders never silently editable — amendments are audited revisions. State machines are forward-only with named backward edges (`cancel`, `reopen`), every transition audited + event-published.
- **Shared identity:** Order `ORD-214` → WorkOrders `ORD-214/1..n`. Priority lives on the WO, drag-reprioritize reallocates reservations by priority (FP6).
- **Party** owns emails (Inbox matching keys — FP1 adds `matchDomain`), price list assignment, deposit default, measurement profiles (append-only versions). **PriceList** = sparse overrides over the DEFAULT list ("Listino base", seeded) per FD7.
- **Pricing engine (FP2 builds it):** `price(config, party) = list.base ?? template.base + Σ option deltas (list override ?? option default) ± quote-level adjustment`; costs roll up in parallel (global, never per-party); margin = net − cost, rendered live, Owner-gated. Deltas are ABSOLUTE (cents) or PERCENT (basis points) — `DeltaMode`.
- **Certificates (FD14):** `Certificate` ↔ `CertificateCoverage` ↔ templates; QC stage blocks PACKING when the garment's cert is missing/expired (enforced in FP6).
- **Deposit gating (FD13):** quote `depositPct` (party default → override); when set, the WO is created at confirmation but `BLOCKED` ("awaiting deposit") until a DEPOSIT payment is recorded.

## 8. RBAC recipe for new work (repeat on every route/page)

1. Route file: `export const permission = <registry constant or PUBLIC>` + every exported method wrapped in `guarded(permission, handler)`. `scripts/check-rbac-coverage.ts` fails otherwise.
2. Registry (`src/lib/auth/permissions.ts`) already has: 11 `pages.*`, ~27 feature actions, `financials.*` grains. Add new FEATURES there and ONLY there; WORKER's list is minimal by design.
3. UI gating: `usePermission(p)` / `<Can permission=…>`; grid/rail columns carrying money need the grain check; a page the role lacks simply doesn't render in the rail (automatic via nav.ts permissions).
4. Any exporter, PDF, or email renderer calls `stripFinancials(payload, resolved)` explicitly.
5. Financial-only endpoints map to a `financials.*` permission outright.

## 9. Integrations state & keys (never guess — probe)

- Google OAuth client config: AppSetting `google.oauthClient` (id + encrypted secret). Connection: `GoogleConnection` row (encrypted refresh token, historyId, labelId/labelName, driveRootFolderId, lastSyncAt/lastError). The Settings › Integrations card handles connect/label-change/drive/disconnect — reuse its endpoints, don't duplicate.
- Sendcloud: `CarrierAccount` rows (Vault-encrypted keys + probed caps incl. `supportsPollingTracking`). FP8 must re-check caps at build time — the Lite-vs-Growth tracking boundary is empirical, not documented.
- The Vault (`src/lib/vault.ts`): AES-256-GCM, `FACTORY_ENCRYPTION_KEY`. Anything secret at rest goes through it.

## 10. Verification without casualties (how we test — learned the hard way)

- **The Owner's dev server may be RUNNING on :3100 with `.next-dev`.** Your `next build` writes `.next` — already isolated. For a runtime smoke, build + start your OWN prod server on **:3199** with an ISOLATED build dir, then kill it:
  ```bash
  cd /Users/awais/nexus-commerce/apps/factory   # ALWAYS cd explicitly — shell cwd drifts between calls
  FACTORY_BUILD_DIR=.next-verify npx next build
  FACTORY_BUILD_DIR=.next-verify npx next start -p 3199 &   # verify against 3199, NEVER 3100
  # … curl / headless checks … then kill it. .next-verify is gitignored via .next*? no — add to .gitignore if you create it (currently ignored patterns: .next-dev/, data/, *.db)
  ```
- **Headless UI verification:** Playwright is installed for `apps/web` — use it read-only:
  ```js
  import { createRequire } from "node:module";
  const require = createRequire("/Users/awais/nexus-commerce/apps/web/package.json");
  const { chromium } = require("@playwright/test");
  ```
  Log in PROGRAMMATICALLY (GET `/api/auth/csrf` → POST `/api/auth/login` via `page.request` — shares the cookie jar; UI login races hydration on busy dev servers). Screenshot + measure (`getBoundingClientRect`) — numeric checks over eyeballing.
- **Never let automated tests send real email or buy labels.** Send paths get unit tests (MIME builder) + the Owner exercises live sends in the gate click-through. Gmail READS (messages.get) are fine.
- **DB checks:** `npx tsx scripts/db-smoke.ts`, or ad-hoc tsx scripts via the shared `src/lib/db` singleton (safe alongside the running app — WAL). Clean up any rows you create; AuditLog stays.
- Unit tests live in `src/lib/__tests__/*.test.ts` (vitest, `@` alias configured). Every cycle adds tests for its pure cores.

## 11. THE PAGE PLAYBOOK — every page, in build order

> Protocol per cycle: write `FPn-SPEC.md` (template: Purpose · Scope IN/OUT · Layout sketch · Component reuse table · Data & API (schema deltas + route table with permissions) · Interactions · States · RBAC · Bulk/import-export · Teardown verdicts applied (cite `F0-TEARDOWN.md` rows) · Acceptance targets · Build plan) → **Owner approval** → build in committed sub-phases → verify (§10) → gate message (eng trans, files, click-through, findings, rollback) → **Owner approval** → next cycle. `F0-IA.md` per-page sections are the seed for every spec — do not contradict them without a re-gate.

### FP1 — Inbox `/inbox` — **BUILT (see `FP1-REPORT.md`). The notes below are now as-built documentation.**

Everything below was the settled design and matches what shipped; two verified additions: `stripFinancials` treats `Date`/`Buffer` as leaf values (the Invalid-Date regression, tested), and focus-param URL state uses shallow `history.replaceState` (Next interop) because `router.replace` to a bare pathname no-ops on fresh document loads.

- **State:** shipped FP1.1–FP1.4 (`c39ee15f`); awaiting Owner click-through.
- **Migration `fp1_inbox`:** `Message.bodyHtml String?`, `Message.bodyText String?`, `Message.rfcMessageId String?`, `PartyEmail.matchDomain Boolean @default(false)`, `Conversation.followUpAt DateTime?`, `Attachment.gmailAttachmentId String?`, **new model `FactoryEventOutbox`** (§5). Additive only (Owner's server runs).
- **Sanitizer (`src/lib/sanitize-email.ts`):** sanitize-html at INGEST (stored sanitized): allow formatting/links/images/tables/blockquotes; strip script/iframe/form/on*; links transformed to `target="_blank" rel="noopener noreferrer"`; inline `style` allowed with a safe property allowlist (color, background-color, font-*, text-*, margin*, padding*, border*, width, height, line-height, display, vertical-align) — NO url() values. Unit-test: script/onerror/javascript: URLs stripped, formatting survives.
- **Rendering (`MessageBubble`):** sanitized HTML into `<iframe srcdoc sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox">` (no `allow-scripts` — same-origin is safe because nothing can execute) + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src <'none' | https: data:>">` — images blocked by default, per-conversation "Load images" toggle swaps the CSP. Parent measures `contentDocument.body.scrollHeight` to size the frame. `cid:` inline images may render broken — acceptable, attachments list sits below (note in gate findings).
- **Body fetch:** on `GET /api/inbox/:id`, for messages missing bodies: `messages.get format=full`, walk MIME parts (prefer text/html, fallback text/plain → escape + `<br>`), store sanitized html + text + `rfcMessageId` + upsert `Attachment` rows (filename, mime, size, `gmailAttachmentId`). Sequential fetch is fine (~10 msgs).
- **Reply (`src/lib/google/mime.ts` + `POST /api/inbox/:id/reply`):** build RFC 2822 MIME (text/plain v1; multipart when files attached — accept ≤15MB total via formData), headers `To` = reply-to/from of last INBOUND, `Subject` = `Re: <orig>` (idempotent), `In-Reply-To`/`References` = last inbound `rfcMessageId`; send with `threadId`; insert OUTBOUND message optimistically. Unit-test the builder (headers present, subject logic, base64url encoding).
- **Matcher upgrade (`gmail-sync.ts`):** extract a pure `matchParty(from, exactRows, domainRows)` — exact `PartyEmail` first, then rows with `matchDomain=true` compared by domain. Unit-test. Also in the sync path: INBOUND on CLOSED conversation ⇒ state OPEN (keep assignee) + clear `snoozeUntil`/`followUpAt` + notify assignee (via OUTBOX, not the in-process bus — worker context!).
- **Routes** (all in FP1-SPEC's table with permissions — implement exactly): list (filters state/mine/unmatched + LIKE search + cursor pagination + `lastSyncAt` for the freshness line) · thread (messages + comments + conversation-scoped AuditLog entries merged client-side into one timeline) · reply · PATCH (assign/state/snooze/followUp — audited; assignment notifies) · link-party (link existing OR create {name, kind, matchDomain} + back-match all unmatched conversations from that email/domain) · bulk (per-row results) · attachment download (Gmail fetch → cache `data/attachments/<attId>/<filename>` → stream) · save-to-drive (party folder under the existing root; folder-id cache in AppSetting `drive.folders`) · `GET /api/users-lite` (id, displayName, email; permission `comments.create`) for assignee picker + @mention autocomplete.
- **UI:** three panes (list ~360px · thread flex · rail 300px) per the spec's ASCII layout; components per its reuse table; composer = SegmentedControl Reply|Internal comment (comments amber with "Internal" tag → the F1 `POST /api/comments` with entityType `conversation`); keyboard `j/k/Enter/e/s/r/⌘Enter/Esc`; `?focus=<id>` deep-link (palette already emits it); bulk bar; skeletons; EmptyStates per spec §States.
- **Worker ticks:** minute pass — `snoozeUntil <= now` ⇒ OPEN + notify; `followUpAt <= now` ⇒ notify + clear. Both through the outbox.
- **Definition of done:** spec's Acceptance targets + §12 checklist + the click-through delivered to the Owner (send test = Owner's step, not automated).

### FP2 — Products & Pricing `/products`

- **Purpose:** the pricing model's home — everything the FP3 configurator consumes. THE data-model cycle; UI is master-detail admin, not a board.
- **Entities/API:** ProductTemplate CRUD; OptionGroup/Option CRUD (sortable, min/maxSelect; costDelta/priceDelta + DeltaMode); OptionConstraint editor (REQUIRES/EXCLUDES + BLOCK/WARN + human message); BomLine + per-option `materialDraws` (needs Materials to exist as records — a minimal material CRUD or CSV import ships HERE if FP7 hasn't run; add `materials.manage` usage); Certificate + CertificateCoverage registry; PriceList + sparse PriceListEntry editor (per FD7: a party list starts EMPTY = inherits Listino base; only overrides are rows); **pricing engine** `src/lib/pricing.ts` — pure `compose(templateId, selections, priceListId) → {costCents, listCents, netCents, marginCents, marginPct, lines[], constraintViolations[]}` with exhaustive unit tests (deltas ABS/PCT, list overrides, constraint REQUIRES/EXCLUDES, goal-seek inverse) — **this function is the product; test it like it**.
- **Key screens:** template list (DataGrid) → template detail with tabs: Options (groups + options grid, inline edit), Constraints (sentence-rendered rules), BOM & draws, Certificates, **Preview-as-configurator** (dry-run panel: pick a party → toggle options → watch price/margin/constraints live — this de-risks FP3 and demos the whole model).
- **Verdicts to apply:** CPQ bundle→groups→options ADOPT; ONE constraint table (BEAT Salesforce's two engines); Craftybase cost-roll-up + reprice ripple (material `costCents` edit → flag affected templates/quotes count); SAP "Price Source" line (every price shows WHY: base/list/override); tech-pack-lite = render, don't author.
- **RBAC:** `pages.products`, `products.manage`, `pricelists.manage`; ALL cost fields behind grains. **Bulk/import:** options + price-list entries CSV with dry-run (reuse the framework); template export.

### FP3 — Quotes `/quotes` (the golden flow's first half closes here) — ✅ SHIPPED (FP3.1–FP3.5, ends `86276d87`; report `FP3-REPORT.md`)

> Built to this seed. Delivered: quote/line CRUD on the engine, `/quotes` pipeline (3 counters + tabs + search + grid), `QuoteEditor` configurator with live waterfall + constraint banners + adjustment(+reason) + deposit + validity, Italian PDF (cost-free by construction, unit-proven), send-into-thread with QuoteVersion freeze + margin-floor speed bump, PUBLIC tokenized accept/reject link (`/q/[token]`, CSRF-handshake fix), manual accept/reject in `ConvertBar`, convert→Order (ORD-n), similar-quote recall, lead-time promise date, CSV export, and Inbox context-rail New-quote wiring. **Verified 96/96 tests, golden flow end to end on :3199 (no live email).** Deviation flagged: public accept link needs the app reachable (manual accept covers localhost). Goal-seek two-way field deferred (engine has `goalSeekByNet`/`goalSeekByMargin`; not yet wired to a UI control). Below is the original seed for reference.

- **Purpose:** configurator + RFQ pipeline; born from an Inbox thread ("Reply with quote" button appears in FP1's thread pane WHEN this ships) or standalone.
- **Entities/API:** Quote/QuoteLine CRUD on the FP2 engine; `QuoteVersion` snapshot-on-send (freeze options+costs+prices+rendered PDF); quote PDF (server-rendered, bilingual-ready EN/IT layout, NO cost/margin columns ever in customer output — call stripFinancials with a customer-shaped resolved); send via the FP1 reply pipeline into the SAME thread (attachment + inline summary); accept/reject: v1 = Owner marks manually from the thread + a tokenized public accept link (`PUBLIC` route with signed token, like Nexus `/api/po/ack/:token`) is stretch — spec it explicitly either way; won/lost with reason; convert → Order (+ deposit request per FD13); goal-seek field (target price ⇄ margin, two-way); similar-quote recall panel (this party + this template, won/lost + prices); capable-to-promise date = naive v1 (open WO count × configurable per-stage days from AppSetting — label it an estimate; honest until FP6 gives real load).
- **Configurator UI:** left = option groups (RadioCard/Checkbox per min/max), right rail = live waterfall (Cost → List → Adjustment(+reason) → Net, margin € + % — Owner-gated), constraint messages inline (BLOCK disables + explains, WARN badges), measurement profile picker (+ "send self-measure form" = templated email via reply pipeline, stretch), deposit % field.
- **Verdicts:** 4-line waterfall ADAPT; margin-floor speed bump (AppSetting `pricing.defaults.marginFloorPct`, red badge + explicit confirm below it); quotes never reserve stock (Katana ADAPT); JobBOSS² similar-quote ADOPT; Fulcrum live cost breakdown ADOPT.
- **RBAC:** `quotes.create/send/convert`; waterfall visible only with grains. **Import/export:** quotes CSV export; no import.

### FP4 — Orders `/orders` — ✅ SHIPPED (FP4.1–FP4.4, ends `17c28e06`; report `FP4-REPORT.md`)

> Built to this seed. Delivered: the board (grid + kanban with @dnd-kit validated-drag), three counters (In production · Awaiting deposit · Overdue), the `canTransition` state-machine authority, the signature ONE-TIMELINE, one-click Start production (WO-per-line + size-run explosion + stage rows from AppSetting `production.stages`), the FD13 deposit gate (WO BLOCKED→READY on deposit), payments recording, promise-date edit, cancel+reason with WO cascade, orders CSV export, and the size-run matrix editor. **Verified: the full golden flow FP3→FP4 end to end (convert→ORD→start→gate→pay→unblock→lifecycle→CLOSED), 119 tests, a REAL kanban drag.** Deviations flagged (see report): batch-select + historical CSV import deferred; IN_PRODUCTION→READY and →SHIPPED are manual stopgaps until FP6/FP8. Below is the original seed for reference.

- **Purpose:** the operational board — every confirmed job's truth.
- **Entities/API:** Order lifecycle (CONFIRMED→IN_PRODUCTION→READY→SHIPPED→DELIVERED→CLOSED / CANCELLED w/ reason + compensating events); one-click "Start production" → WO `ORD-n/1` (+ stage rows from AppSetting pipeline; BLOCKED if deposit gate active); payments/deposits recording (Payment rows; deposit paid ⇒ WO unblocks); promise-date edits audited; the ONE-TIMELINE view (email → quote vN → confirmed → payments → WO stages → shipment → review — pull from linked entities + AuditLog); size-run entry for B2B lines (matrix editor `sizeRun` Json) exploding to per-size WOs.
- **Views:** DataGrid (status tabs, party filter, promise-date sort, money columns grain-gated, monday-grade row interactions: status cell click-through, hover reveal, batch bar, undo toast via compensating events) + kanban by state (drag = validated command — cannot drop into SHIPPED without a shipment; reject with the reason).
- **Verdicts:** Katana one-click SO→MO + status-words-as-UI (Materials cell says "In stock / Expected / Not available" — click explains, once FP7's fold powers it; before FP7 show "—"); NetSuite created-from chain ADAPT; ERPNext docstatus ADOPT.
- **RBAC:** `orders.edit/cancel`, `payments.record`. **Bulk:** status/assign/export; order-history CSV import for migrating old records (dry-run).

### FP5 — Contacts `/contacts` — ✅ SHIPPED (FP5.1–FP5.4, ends `6a8c9994`; report `FP5-REPORT.md`)

> Built to this seed. Delivered: `/contacts` list by kind, ContactDetail (Overview = identity inline-autosave + emails manager w/ matchDomain + price-list assignment), **versioned MeasurementProfiles** (`src/lib/contacts/measurements.ts` organizeProfiles — edit = new version supersedes, prior immutable), **history tabs** (conversations/quotes/orders/reviews aggregated + deep-linked, money grain-gated), and the **compare-pricing tool** (`/api/contacts/compare` — pure FP2 engine per party, discount vs base, grain-gated), parties CSV export extended (price_list + deposit_pct). Migration-free; `contacts.manage` seeded. Bug fixed in verify: template detail exposes `optionGroups` not `groups`. Deferred (report): merge-duplicates, per-party configurator defaults, measurement photos, bulk archive. Below is the original seed for reference.

- **Purpose:** promote the minimal party records into the relationship workspace.
- **Entities/API:** Party CRUD + kind-specific faces; PartyEmail manager (+matchDomain); MeasurementProfile CRUD (versioned — new version supersedes, never edits; fields Json per garmentType, fit notes, photo attachments via local/Drive); per-party price-list assignment + terms + depositDefaultPct; **side-by-side price comparison** (pick a template+config → table of each party's composed price + discount vs Listino base — pure pricing-engine calls, the Owner's stated must-have); full history tabs (conversations, quotes w/ won/lost, orders, reviews); merge-duplicates (audited, relinks FKs).
- **Verdicts:** Front contact-sidebar → real workspace ADAPT; measurement profiles ADOPT (Tailornova pattern); per-party configurator defaults (Json on Party, consumed by FP3).
- **RBAC:** `contacts.manage`; terms/lists behind `financials.suppliers/prices`. **Import/export:** already live (F1) — extend the CSV with terms/deposit columns (grain-gated on export).

### FP6 — Production `/production` — ✅ SHIPPED (FP6.1–FP6.5, ends `3d3c62c0`; report `FP6-REPORT.md`)

> Built to this seed. Delivered: the 5-stage Owner board (columns from `production.stages`, live per-stage timers, Start/Pause/Finish, per-stage assign, ▲▼ priority) + WO drawer; pure engines `src/lib/production/` (stage-timer, reserve/allocateByPriority, cert-gate, demand/reserve-service) heavily tested; **material reservations** (RESERVE at production start via the F1 `foldMovements` ledger, from the line's selections through the FP2 engine) → **coverage traffic-lights** (🟢🟡🔴 from RESERVE−RELEASE vs inStock, priority-allocated — reorder reallocates); **Cutting actual-use** → OUT+RELEASE + est-vs-actual diff; **QC checklist + EN 17092 cert gate (FD14)** blocking QC→Packing on missing/expired cert; scrap; est-vs-actual cost panel (Owner); the **cost-blind Worker kiosk** (WORKER role or `?worker=1`: my-queue, big buttons, no money — payload strip-verified); order flips READY when all WOs Done. Migration `fp6_production` (WorkOrder.orderLineId + WorkOrderStage.pausedAt). Deviations flagged (report): per-garment (not qty-scaled) reservations, labor-cost/QC-photos/comment/free-drag deferred. Below is the original seed for reference.

- **Purpose:** the 5-stage board (Owner) + the zero-training shop-floor view (Workers — THEIR page; nav shows only this + Materials).
- **Entities/API:** WO board grouped by stage (columns from AppSetting `production.stages`); drag priority ⇒ reservation reallocation by priority order (ledger RESERVE shuffling — pure function, heavily tested); per-stage assign; stage Start/Pause/Finish (timestamps + pausedMs; timers feed `actualCostCents` via labor rate AppSetting later — v1 records time only); CUTTING finish prompts actual material use (`actualMaterialUse` Json → ledger OUT+RELEASE, diff vs estimate surfaced); QC stage checklist (items ticked w/ user+ts) + photo attach + `certCheckPassed` — **PACKING creation BLOCKED if the template's cert is missing/expired (FD14)**; scrap + reason; est-vs-actual cost panel per WO (Owner-only).
- **Shop-floor view (`/production?worker=1` or auto by role):** my-queue list sorted by priority — "your next task is the top line" — big Start/Pause/Finish, ingredient traffic lights (fold-powered), comment composer, NO money anywhere (strip + no grains; verify by test).
- **Verdicts:** Odoo shop-floor cards ADOPT (free, not Enterprise-paid); MRPeasy kiosk trio + my-plan ADOPT; Katana cost-blind operators ADOPT; capacity math IGNORE ("latest safe start" warning from promise date is the only scheduling).
- **RBAC:** `workorders.advance/assign`, `materials.consume`. LAN access matters here (phones): `FACTORY_LAN=1` binds 0.0.0.0 — session auth still applies.

### FP7 — Materials `/materials` — ✅ SHIPPED (FP7.1–FP7.4, ends `a25e6662`; report `FP7-REPORT.md`)

> Built to this seed. Delivered: the four-column fold (`materialStock`: In stock / Committed / Expected / Available, 8 tests), per-material Adjust (signed ADJUST, reason-required), the detail drawer (movements timeline + lots + where-used), Purchase Orders (DRAFT→SENT→PARTIAL→RECEIVED via `poStateAfterReceive`) with receive→MaterialLot→IN movement, one-click **"+ Buy"** from a shortage → PO pre-filled with the gap, supplier-cost **reprice ripple** ("N templates + M open quotes reference this"), and the movement-ledger CSV export. Cost-blind Worker pinned by `materials-strip` test. **Verified live: the Owner ran the golden flow (Q-1→ORD-1→IN_PRODUCTION) after the Start-production 500 fix.** Deviations flagged (see report): opening-stock CSV import deferred (Adjust + PO-receive already set stock); lot→WO traceability partial (ledger records lot+ref; dedicated view is a follow-up). Below is the original seed for reference.

- **Purpose:** the ledger's face. Stock is a DERIVED number with a paper trail.
- **Entities/API:** Material CRUD (+units HIDE/SQM/PIECE/M) + lots (hide/dye batch); movements timeline per material (append-only, filterable); Katana 4-column math (In stock / Committed / Expected / Available — Expected needs PO lines: `Σ open PO qty`); "+ Buy" from shortage → pre-filled PO (PurchaseOrder CRUD, states DRAFT→SENT→PARTIAL→RECEIVED; receive = IN movements per lot); reorder-level chips; supplier `costCents` edit → **reprice ripple flag** ("3 templates, 7 open quotes reference this — review"); lot lookup ("which WOs consumed lot L-88" — refType/refId query).
- **Verdicts:** six-state parts grammar (MRPeasy) rides WO cards in FP6 — FP7 provides the fold + shortage explanations; ledger BEAT (already structural).
- **RBAC:** `materials.adjust/receive`; supplier prices behind `financials.suppliers.view`. **Import:** materials + opening stock CSV (opening stock = IN movements with reason "opening balance"); ledger slice export.

### FP8 — Shipping `/shipping` — ✅ SHIPPED (FP8.1–FP8.4, ends `<FP8.4>`; report `FP8-REPORT.md`)

> Built to this seed. Delivered: the `CarrierAdapter` operational half (getRates/createShipment/cancelShipment/pollTracking) on `src/lib/carriers/types.ts` with a real `SendcloudAdapter` (`/parcels` + `/tracking`) AND a `FakeCarrierAdapter` + `resolveCarrier` (real iff a CarrierAccount is connected, else fake; always fake under `FACTORY_FORCE_FAKE_CARRIER` so verify never spends). Two-click buy-and-print on `/shipping` (parcel preset → ship-to prefilled from `Party.addressJson` → rates cheapest-selected → confirm), label PDF stored locally + streamed behind `guarded()`, order READY→SHIPPED. Worker 15-min tracking tick (`pollInflightShipments`, read-only, forward-only) → SHIPPED→DELIVERED. Owner-initiated **Share tracking** (cost-free IT reply into `order.conversationId` via the FP1 MIME pipeline; sandbox dry-run so automation never sends). Void (pre-dispatch → order back to READY). Day-sheet manifest PDF + capability-gated pickup (records intent). Bulk-buy (N boxes = N shipments). Shipments CSV (grain-gated cost). Pure core (`src/lib/shipping/`) with 17 tests. **Verified headless at $0** with the fake carrier; the real Sendcloud path + €0 unstamped label is the Owner's gate step. Additive migration `fp8_shipping`. Deviations flagged (see report): real pickup-API booking, auto-send tracking, true multicollo, returns/RMA, second carrier all deferred. Below is the original seed for reference.

- **Purpose:** label queue + tracking timelines; the CarrierAdapter comes alive.
- **Build:** implement `SendcloudAdapter` fully against `src/lib/carriers/types.ts` (getRates advisory, createShipment → label inline base64 → store PDF locally + `labelRef`, cancelShipment, pollTracking batched); **re-run the capability probe at build start** — tracking-poll availability on the Owner's plan is empirical (if gated: labels still work; tracking degrades to manual + a Finding). Two-click purchase ON THE ORDER (rail: parcel preset → confirm-and-print; rates inline, cheapest pre-selected); PACKING done ⇒ order READY ⇒ label CTA; tracking events → order timeline + auto-email into the thread (via reply pipeline, per-brand sender identity later); day-sheet manifest (PDF of today's parcels) + pickup booking (carrier rules: BRT ≥5 parcels — capability-flag UI, never block: "booked outside system" checkbox); worker tracking poll (15–30 min, in-flight only) with outbox events.
- **Verdicts:** Sendcloud rules→2-3 clicks ADOPT (ours: fewer); ShipStation Create+Print split ADOPT; returns = rework conversations from the thread (authorization + label, minimal).
- **RBAC:** `labels.purchase/void`; costs grain-gated. **Bulk:** size-run multi-parcel purchase.

### FP9 — Financials `/financials`

- **Purpose:** order-level money truth; explicitly NOT accounting (ledger goes to the commercialista via exports).
- **Build:** rollups (SQLite views/queries): per-order quoted/invoiced/paid/balance + est-vs-actual margin; per-party and per-period (month) aggregates; deposits outstanding (FD13 view: BLOCKED WOs awaiting money); Invoice records (number, amount, PDF ref, sent/paid — lightweight, no tax engine; VAT display fields only); payment recording UX (bank-CSV import matched to invoices, dry-run idiom); everything drills to its orders (every code a link); full period export CSV/XLSX (strip-called; the accountant interface).
- **RBAC:** the page itself is the gate — absent from non-financial navs entirely.

### FP10 — Analytics `/analytics`

- **Purpose:** the factory's rhythm — every metric answers a decision.
- **Build:** three live counters up top (unanswered threads / quotes awaiting approval / overdue promises — SSE-fresh); charts (recharts, already a dep): throughput (WOs done/wk), stage lead times + bottleneck (stage timestamp deltas), on-time vs promise, margin by product/party/period (est vs actual), quote win/loss + reasons, material consumption trends; every aggregate → drill link to the filtered source page; saved views (SavedView model exists).
- **Verdicts:** three counters over leaderboards; local SQLite = any question one query away (BEAT Katana export-only).

### FP11 — Settings polish + Team & WhatsApp decision

- **Team & Roles UI:** members list, invitations (Invitation model + accept flow — the schema and guardrails exist), role matrix editor from `permissionCatalog()`, custom roles (guardrails enforced: last-owner, system-role immutability, unknown-permission). **Flip `FACTORY_RBAC_MODE=enforce`** as part of this gate (before any second login exists).
- **Settings depth:** stage-pipeline editor (the global list, rename/add/reorder — WO stage keys reference it), pricing defaults editor (margin floor, deposit default), notification preferences, backup panel (snapshot list + restore-drill button), quota meters.
- **WhatsApp (FD5):** present the decision with real volume data: unofficial bridge (free, fragile, ToS risk — Owner knows it from Xavia) vs Meta Cloud API (official, per-message fees). Whichever wins, it lands as a second `Conversation.channel` behind the same Inbox — the schema is ready.
- Also: mint `events.listen` permission if custom roles arrive (events/notifications routes currently ride `pages.production` — documented shortcut).

## 12. Definition of done — checklist for EVERY cycle

- [ ] Spec existed and was Owner-approved BEFORE build; build matches spec; scope creep = next cycle
- [ ] `npm test` green (new pure cores have tests) · `check:rbac` · `check:no-touch` · `check:ds-parity` green
- [ ] `FACTORY_BUILD_DIR=.next-verify npx next build` green; runtime smoke on :3199 (never :3100); no live sends/purchases in automation
- [ ] Every new route: `export const permission` + `guarded()`; money fields `*Cents`; exporters/PDF/emails call stripFinancials
- [ ] Mutations audited; domain events published (outbox from worker context); notifications for assignments/mentions
- [ ] Skeletons, empty states, freshness lines, keyboard paths; zero dead links; DS-only components
- [ ] Committed in sub-phase commits (scoped `--only`), pushed (expect the concurrent-push race; verify remote)
- [ ] `F1-REPORT.md`-style gate appendix or `FPn-REPORT` section: eng trans · files · click-through · findings · rollback
- [ ] Memory file `project_factory_os.md` updated (status line + commit)
- [ ] STOPPED for Owner approval before the next cycle

## 13. Known traps (every one of these already bit us — do not repeat)

1. **Concurrent sessions commit to main constantly.** Scoped commits only (`--only`); push rejections saying remote "is at <your sha>" mean someone pushed your commit for you — fetch and verify.
2. **The pre-push hook builds apps/web + api** (minutes; occasionally flaky on a `.next` race from parallel sessions) — retry once before diagnosing.
3. **Shell cwd drifts between Bash calls.** ALWAYS `cd` explicitly in the same command as `npx next build`/`start`/`prisma` — we once built apps/web thinking it was factory.
4. **`next build` vs the Owner's running dev server:** dev uses `.next-dev`; verification uses `.next-verify` on port 3199. NEVER run bare `next build`+`next start` against `.next` while anything might read it, and never bind 3100 for tests.
5. **Empty-string env vars:** `.env` templates ship `KEY=`; use `||` fallbacks, never `??`.
6. **Prisma 7:** datasource `url` lives in `prisma.config.ts` (engine "classic"), NOT the schema; `prisma.config.ts` stays excluded from tsconfig; env not auto-loaded (dotenv import); custom client output; migrations additive while anything runs.
6b. **⚠️ After ANY migration + `prisma generate`, RESTART the Owner's `:3100` dev server.** The `prisma` singleton is cached on `globalThis.__factoryPrisma` (survives HMR to avoid connection churn), so a long-running dev server keeps the OLD generated client. Reading old columns is fine, but any code that WRITES a new column (`create({data:{newCol}})`) throws "Unknown argument" on the stale client → **HTTP 500**. This bit Start-production after FP4's `WorkOrder.label` + FP6's `orderLineId` (500 on `:3100`, 200 on a fresh `.next-verify` build) — fixed by restarting `npm run dev`. The isolated `:3199` verify build is always fresh so it hides this; reproduce a suspected client-staleness bug against `:3100` directly.
7. **DS copy is byte-identical** — parity script proves it; NEVER add headers or edits to it; overrides go in `globals.css` under `.factory-frame`; the DS `useToast` is `toast(msg, tone)` (no `.success`); DS `DataGrid` Columns REQUIRE `render`; import `ShellNavEntry` type from `patterns/AppShell` directly (barrel doesn't export it); a SERVER file must not import the DS barrel (hooks lack 'use client') — go through client components (`Providers.tsx` pattern).
8. **React versions:** root hoists 19.x; factory pins 18.3.1 EXACT — never remove the pins.
9. **Worker ≠ web process:** in-process bus events from the worker are invisible to web SSE — durable events go through `FactoryEventOutbox` (FP1.1 builds it; use it forever after).
10. **Gmail:** consent screen in Testing = 7-day token death (setup card warns); `history.list` 404 = expired historyId ⇒ full resync (handled — don't "fix" it); threading needs threadId + In-Reply-To/References + Subject together; personal send cap 500 recipients/day.
11. **tsx respects tsconfig paths** (`@/` works in scripts/worker) but eval one-liners are CJS (no top-level await) — write real script files (scratch dir), run with `npx tsx`.
12. **Playwright lives in apps/web** — `createRequire` trick (§10); UI login races hydration on dev servers — log in via `page.request`.
13. **macOS has no `timeout` command**; `lsof -ti :PORT | xargs kill -9` is the port cleaner.
14. **sanitize-html is installed for FP1** — email HTML is untrusted input even local-first; sanitize at write, sandbox at render, block remote images by default.

## 14. Backlog (approved-to-defer; do not build ad hoc)

FTS5 search upgrade · Gmail Pub/Sub push (sub-10s) · browser notifications opt-in · Playwright golden-flow suite · factory stage in `.githooks/pre-push` (add once cycles stabilize) · Tauri v2 packaging (path documented in F0-ARCHITECTURE §Stack) · WhatsApp channel (FP11 decision) · per-brand sender identities for outbound mail · `events.listen` permission · cid: inline-image rendering · CommentsPane generic mount for non-inbox entities (service is ready) · price-list effective-dating · Litestream continuous replica (nightly VACUUM snapshots already run).

---

*If you are a fresh session: read §2, §3, §13, then the spec for the cycle you're on. When in doubt, the F0 docs are law, the Owner's approval is the gate, and "flag, don't silently fix" is the culture. The Owner is Awais — plain-English gate summaries, no time estimates, ship live not dark.*
