# Factory OS architecture (F0)

F0 deliverable 3 of 6 — the stack decision honoring local-first + $0, the Gmail/Drive sync designs, the carrier-adapter interface, the data-model ERD formalizing the master prompt's Part IV, and the RBAC permission-registry draft. Every load-bearing claim below was verified in F0 research (versions, quotas, policies as of July 2026 — sources in the `scratchpad`-derived research notes and `F0-TEARDOWN.md`); repo facts were read from the monorepo at HEAD on 2026-07-05. Canonical once the F0 gate passes; F1 implements exactly this unless a Finding forces a re-gate.

## Stack decision (summary)

| Layer | Decision | Why (verified) |
|---|---|---|
| App | **One Next.js 16 App Router app** (`apps/factory`): UI (RSC) + API (route handlers), one process, one port (default **3100**) | Single origin kills CORS, cookie topology, and the entire SSR-anonymous-fetch incident class Nexus hit at RBAC enforce (see §RBAC); localhost gains nothing from a separate Express tier |
| Background jobs | **A small sidecar worker process** (`apps/factory/worker/`, plain Node via `tsx`): Gmail poller, tracking poller, reminders, nightly backup | `instrumentation.ts` can be evaluated multiple times in dev (vercel/next.js#51450 — a naive `setInterval` double-schedules) and couples poller uptime to Next restarts; a separate crash/restart domain is the honest shape. Both processes share one SQLite file under WAL |
| ORM/DB | **Prisma 7.8.0 (pinned) + `@prisma/adapter-better-sqlite3` + SQLite** | Enums and Json ARE supported on SQLite since Prisma 6.2 (runtime-enforced, not DB-enforced — zod at boundaries). Prisma 7 requires driver adapters + `prisma.config.ts`; pin versions (7.3.0 had to pin better-sqlite3 against an upstream SQLite bug) |
| SQLite mode | `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `BEGIN IMMEDIATE` for read-then-write transactions | WAL is NOT enabled by Prisma automatically; exactly one writer at a time — web + worker serialize safely on a local disk |
| Search | **FTS5** virtual tables + sync triggers, created in hand-edited (`--create-only`) migrations, queried via `$queryRaw` | Official Prisma workflow blesses hand-edited migration SQL; register FTS + shadow tables in `prisma.config.ts` `tables.external` to silence `migrate dev` drift nags (prisma#8106) |
| Launcher | Root scripts via `concurrently`: `npm run factory` = web + worker; `factory:db:migrate` / `factory:db:seed` / `factory:db:reset` (reset = delete file + migrate deploy + seed) | `npm run --workspaces` can't run parallel persistent scripts; concurrently is the standard |
| Packaging (later, documented now) | **Tauri v2 + real `node` binary as sidecar** running `next build` standalone output; DB in `appDataDir()`; Electron as boring fallback | Confirmed: Next static export cannot host route handlers. `pkg`-compiled sidecars can't carry better-sqlite3's native addon; the proven pattern ships the real node binary (~84 MB, bundle ≈160 MB). Not an F1 deliverable |
| Backup | Nightly `VACUUM INTO` snapshots (rotate 14) + **Litestream ≥0.5.13** file replica to a second disk/synced folder; scheduled restore drill | Plain file-copy of a live WAL DB is unsafe. Litestream is Apache-2.0, active (v0.5.13, 2026-06-30), supports local-disk replicas — $0. Never put the live DB inside a cloud-synced folder; only snapshot/replica outputs |

## Where the code lives (FD1 — monorepo)

```text
apps/factory/
  package.json            @nexus/factory · private · declares react/react-dom EXACT-pinned (root declares ^19.2.5 → hoisted 19.2.6; apps/web declares ^18.2.0 → nested 18.3.1; an app that omits the dependency silently inherits 19.x)
  next.config.js          serverExternalPackages for prisma client; port 3100 via PORT idiom
  tsconfig.json           copied from apps/web (repo has no base tsconfig); strict: true; "@/*" → ./src/*
  prisma/
    schema.prisma         provider = "sqlite" · env("FACTORY_DATABASE_URL") — DATABASE_URL is claimed by Neon
    prisma.config.ts      migrations path · tables.external (FTS + shadow tables)
    migrations/           committed, reversible; rollback notes per migration
  prisma-client/          generated client (custom `output` — two default-output Prisma clients would collide in hoisted node_modules/@prisma/client)
  src/
    app/                  Next App Router: pages per F0-IA + app/api/* route handlers
    design-system/        verbatim copy from apps/web/src/design-system (see F0-DESIGN-BRIDGE)
    lib/                  db singleton (WAL pragmas) · auth · rbac · mailstore · pricing engine · ledger · events bus · TtlCache
    vendor/               copied Nexus idioms (grid-lens, bulk-edit, Toast, ConfirmProvider, Skeleton, CommandPalette…) — provenance headers, zero imports from apps/web
  worker/
    index.ts              tsx entry: Gmail history poll · tracking poll · reminders · snapshots
  scripts/
    ds-parity-check.mjs   diff factory DS copy vs apps/web canonical (read-only on web)
    no-touch-check.mjs    fails if apps/factory imports from apps/web or apps/api
    check-rbac-coverage.mjs  every app/api route file must export its permission mapping
  .env.example            names only: FACTORY_DATABASE_URL · FACTORY_ENCRYPTION_KEY · FACTORY_RBAC_MODE · FACTORY_OWNER_EMAIL · NEXUS_ENABLE_* gates
docs/factory/             this F0 set + per-cycle specs
```

Workspace mechanics (verified): npm@10 workspaces `apps/*` auto-include the new app; turbo 2's `build`/`dev` tasks already cover `.next/**` outputs; Node 20+ (CI pins 20). The factory app is NOT wired into `.githooks/pre-push` or `ci.yml` automatically — F1 adds explicit stages (build + rbac coverage + no-touch check) so factory work gates pushes without touching the existing stages.

**Data isolation:** factory has its OWN Prisma schema and SQLite file. `packages/database` is hard-wired to Postgres/Neon (`@prisma/adapter-pg`, `DATABASE_URL`) and is not shared. No factory table lives in the commerce DB; no commerce table is readable by factory code.

## Data model (ERD formalizing Part IV + F0 discoveries)

House-style model tree (fields abbreviated; money in **cents**, `*CostCents`/`*MarginPct` naming discipline is load-bearing for field-gating — see §RBAC):

```text
Party (kind BRAND|CUSTOMER|SUPPLIER)
 ├─ emails            PartyEmail[]           ← Inbox sender matching keys
 ├─ priceListId       → PriceList            default list for the configurator
 ├─ currency, paymentTerms, depositDefaultPct, notes
 ├─ measurementProfiles MeasurementProfile[] (name, garmentType, fields Json, fitNotes, photos, version, supersedesId)  ← F0 addition (MTM teardown)
 └─ reviews           Review[] (rating, notes, followUpFlag, orderId)

ProductTemplate ("Custom Cowhide Suit")
 ├─ baseCostCents, basePriceCents
 ├─ optionGroups      OptionGroup[] (name, minSelect, maxSelect, sort)
 │   └─ options       Option[] (name, costDeltaCents|Pct, priceDeltaCents|Pct, materialDraws Json)
 ├─ constraints       OptionConstraint[] (type REQUIRES|EXCLUDES, ifOptionId, thenOptionId, severity BLOCK|WARN, message)
 ├─ bomLines          BomLine[] (materialId, qty, unit, perOption?)
 └─ certificates      ← via CertificateCoverage (a cert may cover several styles/sizes)

Certificate (standard "EN 17092", class AAA|AA|A|B|C, certNumber, notifiedBody, expiresAt)   ← F0 addition (compliance); top-level
 └─ coverage CertificateCoverage[] (templateId, coveredSizes) — many-to-many to ProductTemplate

PriceList
 ├─ kind DEFAULT|PARTY_TIER, name
 └─ entries PriceListEntry[] (templateId|optionId, basePriceCents?, priceDeltaCents|Pct?)   ← FD7: per-list deltas; lists override only where they differ

Conversation (channel GMAIL|WHATSAPP_LATER, gmailThreadId, subject, partyId?, assigneeId?, state OPEN|SNOOZED|CLOSED, snoozeUntil)
 └─ messages Message[] (gmailMessageId, direction, from, to, bodyRef, sentAt, labels Json)
    └─ attachments Attachment[] (filename, size, localPath?, driveFileId?, webViewLink?)

Quote (partyId, conversationId?, state DRAFT|SENT|ACCEPTED|REJECTED|EXPIRED, depositPct, promiseDateAt, marginFloorBreached)
 ├─ lines QuoteLine[] (templateId, selections Json, measurementProfileId?, listPriceCents, adjustmentCents, adjustmentReason, netPriceCents, costCents, marginCents, marginPct)
 └─ versions QuoteVersion[] (version, sentSnapshot Json, pdfRef, sentAt)     ← snapshot-on-send; sent = immutable

Order (bornFromQuoteId, partyId, conversationId?, state CONFIRMED|IN_PRODUCTION|READY|SHIPPED|DELIVERED|CLOSED|CANCELLED, promiseDateAt, number "ORD-214")
 ├─ lines OrderLine[] (from quote lines; sizeRun Json for B2B matrix rows)
 ├─ workOrders WorkOrder[] (number "ORD-214/1" — shared identity)
 ├─ shipments Shipment[]
 ├─ invoices Invoice[] (number, amountCents, pdfRef, sentAt, paidAt)
 └─ payments Payment[] (kind DEPOSIT|BALANCE|OTHER, amountCents, method, receivedAt)

WorkOrder (orderId, priority, state, blockedReason?, estCostCents, actualCostCents)
 └─ stages WorkOrderStage[] (stage — key into the Settings-defined global pipeline; default CUTTING|STITCHING|ASSEMBLY|QC|PACKING; assigneeId?, startedAt, pausedMs, finishedAt,
        checklist Json (items + per-tick userId/ts), photos[], scrapNotes?, actualMaterialUse Json)
        · QC stage carries certCheckPassed — PACKING creation blocked if the template's active Certificate is missing/expired

Material (name, unit HIDE|SQM|PIECE|M, reorderLevel, costCents)      ← costCents = current supplier cost; edits ripple-flag quotes
 ├─ lots MaterialLot[] (lotCode, supplierId, receivedAt, notes)
 └─ movements MovementLedger[] (type IN|OUT|ADJUST|RESERVE|RELEASE, qty, lotId?, reason?, refType/refId (PO|WorkOrder|Order), actorId, createdAt)
        · APPEND-ONLY (FD8). Stock, committed, expected are derived views. Corrections are compensating movements.

PurchaseOrder (supplierId, state, lines Json, expectedAt)
Shipment (orderId, carrierAccountId, service, trackingNumber, trackingUrl, labelRef, costCents, state, events TrackingEvent[])
CarrierAccount (adapterId "sendcloud", label, credentialsEncrypted, caps Json)
Pickup (carrierAccountId, date, window, parcelIds Json)

— platform primitives —
Comment (entityType, entityId, authorId, body, mentions Json, createdAt, editedAt?)        ← ONE table for every entity (BEAT: Nexus has two per-entity pockets with no delivery)
Notification (userId, kind MENTION|ASSIGNMENT|STATE_CHANGE|REMINDER|SYSTEM, entityType/entityId, title, href, readAt?, createdAt)
AuditLog (actorId, entityType/entityId, action, before Json, after Json, createdAt)        ← append-only; every write path stamps it
FieldAudit — folded into AuditLog; rendered inline in entity timelines (Odoo tracking=True idiom)
ImportJob (entity, mode DRY_RUN|APPLY, rowsTotal/ok/error, diff Json, resultRef, actorId)
SavedView (page, name, config Json, userId)

— auth (S-series replica, SQLite-adapted) —
User (email @unique, passwordHash, status, failedLoginCount, lockedUntil, permissionsVersion, mfa* optional)
Role (key @unique, name, permissions Json (string[]), isSystem)                              ← Postgres String[] → Json on SQLite
UserRole (@@unique(userId, roleId), grantedByUserId)
Session (tokenHash @unique, idleExpiry, absoluteExpiry, revokedAt, userAgent, ip)
Invitation (email, roleId, tokenHash @unique, expiresAt, acceptedAt?, revokedAt?)
```

State machines are forward-only with named backward edges (`cancel`, `reopen`), every transition audited and published on the event bus. Quotes never reserve stock; `Order` confirmation writes `RESERVE` movements; CUTTING finish converts reservations to `OUT` with actual-use diff.

## Gmail integration (the front door — design locked by verified policy facts)

**Posture:** one Google Cloud project, **OAuth Desktop client**, consent screen **External + published to Production, deliberately unverified**. Google's own personal-use exemption covers apps with <100 users clicking through the unverified-app screen — including restricted scopes (lifetime cap: 100 restricted-scope grants per project). Production mode has **no 7-day refresh-token expiry**; that trap is Testing-mode-only (both verified against Google's published docs, July 2026). The setup wizard asserts publishing status = "In production" and flags weekly re-consent as the misconfiguration symptom.

*Policy sources (re-check these when Google policy shifts):* loopback/installed-app flow — developers.google.com/identity/protocols/oauth2/native-app · Testing-mode 7-day expiry + refresh-token death triggers — developers.google.com/identity/protocols/oauth2#expiration · publishing states + test-user caps — support.google.com/cloud/answer/15549945 · verification exemptions (personal use <100 users) — support.google.com/cloud/answer/13464323 · restricted-scope verification + 100-grant lifetime cap + CASA — developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification · scope classification — developers.google.com/workspace/gmail/api/auth/scopes · quota units + per-user rate — developers.google.com/workspace/gmail/api/reference/quota · sync/threading — developers.google.com/workspace/gmail/api/guides/{sync,push,sending} · IMAP extensions — developers.google.com/workspace/gmail/imap/imap-extensions · app passwords — support.google.com/accounts/answer/185833.

**Scopes (minimal):** `gmail.modify` (read + send + labels — the send capability is included; one restricted scope total) + `drive.file` (non-sensitive; app-created files only). Loopback (`http://127.0.0.1:{port}`) + PKCE; the desktop client secret is explicitly non-secret per Google. Refresh token stored encrypted at rest via the Vault pattern (AES-256-GCM, key = `FACTORY_ENCRYPTION_KEY`, never printed) — OS keychain integration optional later.

**Sync (worker process):**
1. Initial scoped backfill: `messages.list` bounded by the FD3 label/query, throttled under the 6,000 units/min per-user ceiling.
2. Steady state: `history.list(startHistoryId, labelId)` every **10 s** → 17,280 units/day ≈ 0.02% of the 80M/day project quota. A heavy factory day (200 inbound `messages.get`, 50 sends) stays under ~45k units/day.
3. `historyId` expiry (records guaranteed ~a week, sometimes less) → HTTP 404 → automatic full resync; plus a **daily reconciliation sweep** (`messages.list` last-7-days vs SQLite) so a missed order email is structurally impossible to keep missing.
4. Optional upgrade path (post-v1): `users.watch` → Pub/Sub **pull** subscription (no public endpoint needed) if sub-10 s latency ever matters.

**Send:** replies supply `threadId` + `In-Reply-To`/`References` + matching `Subject` (all three required for correct threading). Send-as aliases: configured once in Gmail's own settings (managing them via API needs restricted `gmail.settings.*` — avoided). Attachments: ≤ ~18 MB practical (25 MB MIME limit incl. base64 overhead); larger → resumable Drive upload into the order's folder + link in the body (Gmail's web UI does this automatically; an API client must do it itself). Personal-account cap 500 recipients/rolling-24h — review-request batches queue against a daily budget.

**Transport abstraction (the policy-risk hedge):** all mail I/O goes through a `MailStore` interface. Primary impl = Gmail API. **Fallback impl (feature-flagged, kept warm): IMAP/SMTP with an app password** — verified still supported July 2026 (survived the 2025 LSA shutdown "with the exception of app passwords"); Gmail IMAP extensions map losslessly onto our schema (`X-GM-THRID` → threadId, `X-GM-MSGID` → message id — documented as the same ids the REST API uses — `X-GM-LABELS` → labels, IDLE for push). **Terminal escape hatch:** Workspace Business Starter (~$7/user/mo) + "Internal" app = zero verification exposure forever. Risk register in `F0-FINDINGS.md` §1.

## Google Drive (FD4)

`drive.file` scope; folder tree auto-created per party → per order (`Factory/{Party}/{ORD-214}/`). Resumable uploads (256 KiB-multiple chunks, one-week session validity) for anything above 5 MB. Store `driveFileId` + `webViewLink` (stable); **never hot-link `thumbnailLink`** (expires in hours) — thumbnails cached locally. **Storage reality (scope correction to Part III):** the free 15 GB pool is shared with the mailbox itself; production/fit videos would exhaust it — so bulky media lives on **local disk** by default with an explicit "share via Drive" action for customer-facing files; an in-app quota meter reads `about.get`. Drive API is free today with monetization "planned later in 2026" for extreme volumes (ours ≈ 0.001% of thresholds) — usage telemetry ships anyway.

## Carrier adapter (FD6 — Sendcloud first, verified)

Sendcloud confirmed as connector #1: Basic auth (public/secret key, self-generated — no approval step), v3 sync create-shipment returns the label **inline base64**, own-contract carriers supported (BRT + Poste Crono have dedicated flows), pickups via API (Italy: BRT needs ≥5 parcels, Mon–Fri), and — decisive for local-first — **tracking is pollable** (`GET /api/v2/tracking/{nr}`, 1,000 GET/min; webhooks optional). Honest caveat: **API access requires ≥ Lite (€28/mo + €0.10/label), and the pricing page's "Tracking API" row starts at Growth (€87/mo) — the exact Lite boundary for tracking polls is unverified.** The F1 spike must confirm both label AND tracking API access on Xavia's actual plan before FD6 is treated as settled; the free "Unstamped letter" method exercises the whole flow at €0. Shippo/EasyPost rejected on Italian coverage (no BRT/GLS-Italy/InPost); MyDHL direct documented as the proven second adapter when volume justifies it.

```ts
interface CarrierAdapter {
  readonly id: string;                         // "sendcloud"
  readonly caps: {
    supportsPickup: boolean;
    supportsPollingTracking: boolean;          // REQUIRED true for local-first v1
    supportsWebhookTracking: boolean;          // unused until a public endpoint exists
    supportsServicePoints: boolean;            // InPost / Punto Poste lockers
    supportsOwnContract: boolean;
    supportsMulticollo: boolean;
    labelFormats: ("PDF_A4" | "PDF_A6" | "ZPL")[];
  };
  getRates(s: ShipmentSpec): Promise<RateQuote[]>;            // advisory; margin math from our own tariff table
  createShipment(s: ShipmentSpec): Promise<{ shipmentId: string; trackingNumber: string; trackingUrl: string; cost?: Money }>;
  getLabel(shipmentId: string, fmt: LabelFormat): Promise<Buffer>;   // stored immediately (Sendcloud label URLs require auth)
  cancelShipment(shipmentId: string): Promise<void>;
  pollTracking(refs: TrackingRef[]): Promise<TrackingEvent[]>;      // worker cron, in-flight parcels only, every 15–30 min
  schedulePickup?(req: PickupRequest): Promise<PickupConfirmation>;
  listServicePoints?(near: Address, carrier?: string): Promise<ServicePoint[]>;
}
```

The Settings › Integrations wizard follows the Sendcloud own-contract shape: pick carrier → one credential form with inline field help → **test call** → live. Capability flags render honest UI (no pickup button for adapters without it; "pickup booked outside system" checkbox so the flow never blocks).

## RBAC (S-series pattern, replicated standalone)

Factory OS replicates the proven Nexus S0–S5 architecture (registry → global gate + manifest → resolver with `permissionsVersion` → web `usePermission`/`<Can>`/nav filter → field-level strip → guardrailed team service), shrunk to factory scale (~35 permissions vs Nexus's 135; dozens of routes vs 2,038). Single-origin design deletes Nexus's hardest problems by construction: no CHIPS/Partitioned cookies, no fetch-patching, and **the SSR-anonymous-fetch incident class cannot occur** (the session cookie is first-party to the one process).

- **Registry:** one file, three layers, dot notation — `pages.*` (11), `<module>.<action>` (~20: `quotes.create/send`, `orders.edit`, `workorders.advance`, `materials.adjust`, `labels.purchase`, `pricelists.manage`, `users.manage`, …), `financials.*` (master + `costs/margins/suppliers` grains, expanded via `expandPermissions`). OWNER implicit-all; roles at launch per FD9: `OWNER`, `WORKER` (production + materials-consume only, **zero** `financials.*`, nav simply lacks Quotes/Products/Financials), optional `OFFICE` later.
- **Enforcement:** every `app/api/**/route.ts` exports its permission mapping; one shared `guard()` wrapper enforces it (session → resolve → deny-by-default). A boot-time coverage script walks the route-file tree and **fails on any unmapped route** (port of `check-rbac-coverage.ts`). `FACTORY_RBAC_MODE=shadow|enforce` preserved — shadow logs would-be denials during development; go-live is an env flip.
- **Field level (the Worker-vs-margin requirement):** naming discipline (`*Cents`/`*MarginPct` suffixes) + one `stripFinancials(payload, resolved)` filter applied at the response boundary — and, closing Nexus's documented gaps at birth: the same filter is called explicitly by **CSV/XLSX exporters, SSE payload serializers, PDF renderers (a Worker-visible work-order PDF must not embed prices), and email composers**; wholly-financial routes map to `financials.view` in the manifest; grid column specs carry `permission?:` keys so gated columns don't render as blank husks (`<Can>` at the column registry, not a retrofit sweep).
- **Sessions/auth:** server-side sessions (opaque token, sha256 in DB, 7-day idle / 30-day absolute), bcrypt, lockout, invitation-based onboarding, `SameSite=Lax; HttpOnly` first-party cookie, double-submit CSRF on mutations. Boot seeds system roles idempotently; `bootstrap-owner` from `FACTORY_OWNER_EMAIL` (initial password never printed). Guardrails as pure predicates: last-OWNER protection, system roles immutable, permission lists validated against the registry.

## Platform primitives (F1 builds; every page consumes)

| Primitive | Design (source idiom — see F0-DESIGN-BRIDGE for file-level reuse) |
|---|---|
| Audit log | Append-only `AuditLog` stamped by every write service; field diffs rendered inline in entity timelines (Odoo `tracking=True` idiom); never deleted |
| Movement ledger | §Data model — stock is a view over movements; corrections compensate, undo toast emits a compensating event (monday undo + our ledger) |
| Comments + @mentions | ONE `Comment` table (entityType/entityId) + mention autocomplete + notification fan-out; ⌘+Enter composer, chip rendering (bones from Nexus `PoComment`, delivery gap closed) |
| Notification center | `InboxItem`-shaped aggregator (kind/severity/href/readAt) + bell with Mentioned tab; SSE-pushed, not polled; browser notifications opt-in via localStorage config (RT.17 pattern) |
| Events / real-time | In-process bus + SSE endpoint with 25s heartbeat + `?since=` ring-buffer replay (100 events / 5 min) + debounced client hooks + `BroadcastChannel` cross-tab invalidation — the Nexus stack, near-verbatim, single machine, no Redis |
| Import/export | The eBay-ads dry-run idiom generalized: parse-pure → diff (per-row from/to/note/error) → apply-valid-rows, one endpoint with `dryRun` flag, per-entity CSV templates, `ImportJob` history |
| Bulk framework | `BulkActionShell` + two-step review modal (select changes → review) on every grid; escalation ladder: confirm-with-consequences → diff-then-apply |
| Global search | FTS5 over conversations/quotes/orders/parties/materials + CommandPalette (⌘K, chords, live entity search, Recent) |
| Freshness | `FreshnessIndicator` ("Updated Xs ago", amber past staleness) + multi-source line ("mail synced · tracking polled · prices updated") on integration-backed panels |
| Caching | `TtlCache` (TTL + updatedAt-keyed) for pricing-model evaluations and Gmail thread metadata; hover-warm prefetch for configurator-from-email |

## Runtime & operations

- `npm run factory` → concurrently WEB (Next, :3100) + WORKER (tsx). First run: `factory:db:migrate` + `factory:db:seed` (system roles, owner bootstrap, demo-free — no fake data presented as real; a separate `seed:demo` exists for development only, guarded by env).
- Worker owns: Gmail poll (10 s), tracking poll (15–30 min, in-flight only), reminder/snooze firing, review-request queue (daily send budget), nightly `VACUUM INTO` snapshot + Litestream replica, weekly integrity sweep (`PRAGMA integrity_check` + enum-validity queries — SQLite doesn't enforce enums).
- Observability, local-first: a Settings › Health panel (worker heartbeat, last poll ts, quota meters, DB size, last snapshot/restore-drill result) instead of external APM.
- LAN access for shop-floor phones: web binds `0.0.0.0` behind `FACTORY_LAN=1`; session auth applies; HTTPS unnecessary on-LAN in v1 (documented trade-off, revisit at packaging).
- Never printed: `FACTORY_ENCRYPTION_KEY`, OAuth tokens, `FACTORY_DATABASE_URL`, carrier secrets. Env template committed with names only.

## Testing

vitest for the pure cores (pricing engine compose/goal-seek, constraint evaluation, ledger derivations, CSV parse/diff, guardrails, permission matrix — the Nexus `permission-matrix.vitest.test.ts` pattern) + Playwright for golden-flow click-throughs (copy `apps/web/playwright.config.ts` idioms: chromium, `it-IT` locale, Europe/Rome TZ). Tests ship with each phase; the F1 gate demo is scripted, not ad-hoc.
