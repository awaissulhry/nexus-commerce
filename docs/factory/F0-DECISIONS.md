# Factory OS decision register (F0)

F0 deliverable 4 of 6 — every open decision with a recommendation, its trade-offs, and the F0 evidence behind it. FD1–FD9 are the register from the master prompt (Part IX); FD10–FD14 surfaced during F0 research. The Owner decides each at the F0 gate; recommendations are marked **(Rec)**. No decision here is implemented yet — F0 shipped zero product code.

## Naming (Owner's call, no recommendation forced)

Working name **"Nexus Factory OS"**. Candidates if a rename is wanted: **Officina** (the Italian word a factory owner actually says), **Nexus Officina** (family branding), **Telaio** (frame/loom), or keep as-is. The app brand mark slots into the rail's 28×28 logo block regardless (see F0-DESIGN-BRIDGE).

## FD1 — Code location: monorepo app `apps/factory` **(Rec)** vs separate repo

**Recommendation: monorepo app, own database.** Verified mechanics: npm workspaces auto-include `apps/factory` (glob `apps/*`), turbo tasks already cover Next outputs, `@nexus/factory` follows the naming convention; the design-system copy + parity script are trivially cheap in-repo and painful across repos. The factory schema/data stay fully separate (own SQLite file, own Prisma schema, own env var) — FD1 is about code proximity, not data mixing.
**Trade-offs:** the repo is busy (concurrent agent sessions commit to main continuously; grid-lens/bulk-edit churned mid-recon) — mitigated because factory code is a disjoint path (`apps/factory`, `docs/factory`) and commits use `--only`. Existing pre-push hooks/CI don't cover the new app until F1 adds explicit stages (they also won't break on it). A separate repo would give cleaner isolation and its own history but costs an extracted design-system package (see FD12), duplicated tooling conventions, and slower pattern borrowing — the wrong price for a one-owner codebase.

## FD2 — Local stack & packaging: Next.js + SQLite/Prisma now, Tauri path **(Rec)** vs Electron vs hosted-later

**Recommendation: one Next.js 16 App Router app (UI + API route handlers, port 3100) + a small sidecar worker process + SQLite via Prisma 7.8.0 (pinned) with `@prisma/adapter-better-sqlite3`; package later with Tauri v2 running Next's standalone output behind a real-node sidecar; Electron only if Tauri friction proves real.** All load-bearing claims verified (see F0-ARCHITECTURE): enums/Json work on SQLite since Prisma 6.2; WAL must be enabled manually; Next static export cannot host route handlers (so any desktop build ships the Node server); `instrumentation.ts` double-evaluates in dev, which is why the Gmail poller gets its own process.
**Trade-offs:** two processes instead of one (accepted: separate crash domains for the poller); Prisma 7's new requirements (driver adapters, `prisma.config.ts`) mean version pinning discipline; SQLite enum values are runtime-enforced only (zod at boundaries + weekly integrity sweep). Electron would be simpler to package but ~200 MB+ and Chromium maintenance. Pure-hosted contradicts local-first + $0.

## FD3 — Gmail scope: label/alias as "the factory inbox" **(Rec)** vs whole mailbox

**Recommendation: label-scoped ingestion.** A Gmail label ("Factory", populated by Gmail filters the Owner controls, e.g. on recipient alias or sender domains) bounds the initial backfill and the `history.list(labelId)` polling, keeps personal mail out of the local DB (privacy + smaller sync), and makes the ingestion contract visible inside Gmail itself. The Settings connect flow lets the Owner pick the label and preview what would sync before confirming.
**Trade-offs:** a mislabeled order email doesn't appear — mitigated by the daily reconciliation sweep flagging unlabeled threads from known party senders ("3 messages from known customers outside the Factory label — review?"), and a one-click "pull this thread in". Whole-mailbox remains a Settings toggle for a future where the account is factory-dedicated.

## FD4 — Drive layout: per-party/per-order folders **(Rec)** vs flat + metadata

**Recommendation: `Factory/{Party}/{ORD-214}/` folders.** Human-navigable from Drive itself (the Owner will look there), matches the `drive.file` scope model (we only ever see files we created), and folder ids cache locally so lookups cost nothing.
**Trade-offs:** renames/moves done inside Drive can orphan our cached ids — mitigated by storing both id and path and re-resolving on 404. Flat-with-metadata is more robust to manual reorganisation but unusable to a human browsing Drive — wrong trade for a tool that augments rather than traps. **Scope correction from research:** Drive is NOT the bulk-media store (15 GB shared with the mailbox; videos live on local disk; Drive holds customer-shared files) — see F0-FINDINGS §2.

## FD5 — WhatsApp channel (deferred to FP11): unofficial bridge vs Meta Cloud API

**Recommendation: defer exactly as planned; keep `Conversation.channel` + `MailStore`-style transport abstraction so nothing blocks either path.** Evidence gathered anyway: Front/Missive both treat WhatsApp as a first-class channel behind their most expensive tiers — confirming channel-pluggable Conversations are the right primitive. The Owner already knows the unofficial-bridge trade-offs from Xavia Automation (free, fragile, ToS risk); Meta Cloud API is official with per-message pricing. Decide at FP11 with real volume data.

## FD6 — First carrier adapter: Sendcloud **(Rec)** vs Shippo vs EasyPost vs direct DHL/UPS

**Recommendation: Sendcloud — CONFIRMED by API research, with one caveat.** It is the only candidate whose catalog matches this factory's Italian shipping mix (BRT, Poste/Crono, GLS, InPost, DHL, UPS), supports own carrier contracts, has a pickup API, and — decisive for local-first — **pollable tracking** (no public webhook endpoint needed). The account already exists at Xavia; the free "Unstamped letter" method tests the whole flow at €0.
**The caveat:** API access requires ≥ Lite (€28/mo + €0.10/label), and the pricing page's "Tracking API" row starts at Growth (€87/mo) with the exact Lite boundary for tracking polls unverified — an operating cost, not infrastructure. The F1 spike must confirm both label AND tracking API access on Xavia's actual plan before treating this as already-paid. **Alternatives:** Shippo (no BRT/GLS-Italy/InPost — fails the catalog test), EasyPost (US-centric, repriced abruptly in Feb 2026 — the rug-pull a $0 tool must not build on), direct MyDHL (documented as the proven second adapter when volume justifies; free API, onboarding approval required), UPS direct (highest onboarding friction — skip).

## FD7 — Pricing-model grain: per-price-list option deltas **(Rec)** vs global deltas + party multipliers

**Recommendation: per-price-list deltas with inheritance.** A `PriceList` overrides base prices and option deltas **only where it differs** from the default list (sparse overrides, not full copies). This is the grain that delivers the Owner's stated requirement — side-by-side price comparison per party with visible discounts — and it maps exactly onto the CPQ teardown's strongest ADOPTs (contracted per-account pricing auto-applied by sender match; SAP's "Price Source" explanation of *why* this price).
**Trade-offs:** more rows and a two-step resolution (list → fallback to default) vs the multiplier model's one factor — but multipliers can't express "this brand gets kangaroo at cost + fixed €40" and force spreadsheet workarounds within a month. Cost side stays global (one `costDelta` per option; costs don't vary by customer), so margin math stays honest per party. Sparse inheritance keeps authoring cheap: a new B2B list starts empty ("= listino base") and grows only its negotiated lines.

## FD8 — Inventory: immutable movement ledger **(Rec)** vs editable quantities

**Recommendation: ledger, no contest — and F0 evidence strengthened it.** Every credible manufacturing platform converges here (Katana's perpetual movements; ERPNext's docstatus discipline; monday's editable cells are precisely why it fails as a system of record — its own Activity Log is a paid, expiring feature, while ours is structural). Stock/committed/expected are derived views; corrections are compensating `ADJUST` movements with mandatory reasons; the undo toast emits a compensating event rather than deleting history. Lot-aware (hide/dye batches) for color consistency and recall traceability.
**Trade-offs:** marginally more code than an editable column (a view + movement writers), and stock corrections require a reason — that friction IS the audit trail. Accepted.

## FD9 — Roles at launch: schema-ready roles, minimal UI **(Rec)** vs Owner-only v1

**Recommendation: full auth schema from day one (User/Role/Session/Invitation, `permissionsVersion`, guardrails) with two seeded roles — OWNER and WORKER — and the team-management UI deferred to FP11.** The S-series replication recipe makes the schema nearly free; retrofitting auth is never free. WORKER sees Production + Materials-consume and **zero** financial fields (the strongest zero-training move: their nav simply lacks Quotes/Products/Financials). `FACTORY_RBAC_MODE=shadow` during development, `enforce` before a second human gets a login.
**Trade-offs:** none material — Owner-only v1 would still need sessions (LAN shop-floor phones), at which point roles cost one seed script. An `OFFICE`/`ACCOUNTANT` role is a later permission-list edit, not a schema change (FIELDS grains already exist).

---

## New decisions surfaced by F0 (FD10–FD14)

## FD10 — Gmail consent posture: Production-unverified **(Rec)** vs Testing vs Workspace Internal

**Recommendation: External consent screen, published to Production, deliberately unverified** — Google's documented personal-use path (<100 users; users click through the unverified warning once; no refresh-token expiry). **Testing mode is a trap** (7-day refresh-token expiry — verified) and is asserted-against in the setup wizard. **Workspace Business Starter (~$7/mo) + Internal app** is the terminal escape hatch if Google ever tightens unverified restricted-scope access — a policy-risk insurance policy the Owner can buy at any time, not now. Scopes stay minimal (`gmail.modify` + `drive.file`) to remain squarely inside the allowance; the IMAP/app-password fallback stays warm behind the `MailStore` interface. (Risk register: F0-FINDINGS §1.)

## FD11 — Background-job shape: sidecar worker process **(Rec)** vs inside Next

**Recommendation: sidecar worker** (`apps/factory/worker/`, plain Node/tsx) for the Gmail poller, tracking poller, reminders and backups. Verified reasons: Next `instrumentation.ts` can evaluate multiple times in dev (double-scheduled pollers), and coupling the poller's uptime to UI restarts is wrong for a component that must never miss an order email. Both processes share the SQLite file safely under WAL. **Trade-off:** `npm run factory` starts two processes via concurrently — invisible to the Owner.

## FD12 — Design-system consumption: verbatim copy into `apps/factory` + parity script **(Rec)** vs `packages/design-system` extraction vs cross-app import

**Recommendation: copy `apps/web/src/design-system/` verbatim into `apps/factory/src/design-system/` + a read-only `ds-parity-check.mjs` that diffs the copy against the canonical files and reports drift.** Why not the alternatives: *extracting* to `packages/` would modify `apps/web` imports — forbidden by the no-touch rule; a *new* package that web doesn't consume is the same duplication as copying, with a misleading "shared" label; *cross-app importing* `@/../../web/src/design-system` couples factory to a file tree that concurrent sessions churn daily and that has a pending `.h10-*` → `.nx-*` rename. The copy is the only shape that honors no-touch AND measures drift honestly. Full file list + parity checklist in F0-DESIGN-BRIDGE. **Trade-off:** deliberate duplication (~small, self-contained per the DS README) re-synced by choice, not by accident.

## FD13 — Deposit-gated production: default ON for one-off CUSTOMER orders **(Rec)**, OFF for established B2B

**Recommendation:** quote carries `depositPct` (party default → per-quote override; 30%/50% are the observed market patterns in the custom-moto-gear teardown); when set, the Work Order is created at order confirmation but **blocked from CUTTING until the deposit payment is recorded**, with the block reason visible on the board. B2B parties with terms default to no gate. This encodes the industry's made-to-measure risk control without a payments integration (recording a payment is a manual act in v1).
**Owner input wanted:** default percentages, and whether any customer segment should bypass the gate.

## FD14 — Compliance scope: EN 17092 certificate registry + QC gate **(Rec: include)** vs defer

**Recommendation: include in scope** (Products: `Certificate` registry — class, cert number, notified body, expiry, with covered styles/sizes via a many-to-many to templates since one cert covers several styles; Production: QC stage blocks PACKING when the garment's cert is missing/expired; Shipping: DoC/label data attach to the shipment email). F0 evidence: none of the apparel verticals (ApparelMagic/WFX/BlueCherry) models EU PPE Regulation 2016/425 — for a factory shipping CE-classed motorcycle garments this is a true differentiator at near-zero build cost (one table + one gate + one attachment rule).
**Trade-off:** slightly widens Products/Production scope; the alternative (a folder of PDFs) is exactly the scattered-records problem this platform exists to end. Defer only if the Owner says compliance documentation is handled elsewhere.

---

## Decision summary for the gate

| # | Decision | Recommendation |
|---|---|---|
| — | Name | Owner's call ("Nexus Factory OS" works; candidates listed) |
| FD1 | Code location | Monorepo `apps/factory`, own SQLite DB |
| FD2 | Stack & packaging | Next.js 16 single app + sidecar worker + Prisma 7/SQLite; Tauri v2 path later |
| FD3 | Gmail scope | Label-scoped ("Factory" label) with reconciliation sweep |
| FD4 | Drive layout | Per-party/per-order folders; bulk media on local disk |
| FD5 | WhatsApp | Defer to FP11; channel-pluggable schema now |
| FD6 | First carrier | Sendcloud (verify Xavia plan ≥ Lite); MyDHL second later |
| FD7 | Pricing grain | Per-price-list sparse deltas over a default list |
| FD8 | Inventory | Immutable movement ledger, lot-aware |
| FD9 | Roles | Schema day one; OWNER + WORKER seeded; team UI at FP11 |
| FD10 | Gmail consent | Production-unverified; Workspace Internal as escape hatch |
| FD11 | Job runner | Sidecar worker process |
| FD12 | Design system | Verbatim copy + parity script (no-touch honored) |
| FD13 | Deposit gating | ON for one-off customer orders by default; % configurable |
| FD14 | EN 17092 compliance | In scope: cert registry + QC gate + shipment DoC |
