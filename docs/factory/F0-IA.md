# Factory OS information architecture (F0)

F0 deliverable 2 of 6 — the finalized sidebar/page list, refined from the master prompt's Part VII seed against the teardown (`F0-TEARDOWN.md`). For each page: purpose, primary entities, key actions, and what "best in class" concretely means, with the teardown verdicts it applies. Ends with the recommended page-cycle order and its rationale. This document is the canonical IA reference once the Owner approves the F0 gate; page-cycle specs (FP1…n) elaborate but do not contradict it without a new gate.

Working name throughout: **Nexus Factory OS** (Owner may rename at the gate — candidates in `F0-DECISIONS.md`).

## The golden flow, traced through the pages

The product IS this flow; the IA exists to serve it. Every step names the page that owns it:

```text
Email arrives ──────────────────► INBOX      sender auto-matched to Party; unmatched → one-click create
Open configurator ─────────────► QUOTES     pre-scoped to the party's price list (model from PRODUCTS)
Options → live price + margin ─► QUOTES     4-line waterfall, constraint checks, promise date
Quote sent (same Gmail thread) ► INBOX+QUOTES  snapshot frozen, follow-up reminder armed
Approval ──────────────────────► ORDERS     quote → Order; deposit invoice if gated
Order explodes ────────────────► PRODUCTION Work Order born (shared identity), materials reserved (MATERIALS ledger)
Stages tracked ────────────────► PRODUCTION CUTTING → STITCHING → ASSEMBLY → QC → PACKING
Label in two clicks ───────────► SHIPPING   carrier adapter; tracking auto-shared into the thread
Delivered ─────────────────────► ORDERS     status advances from tracking events
Review requested + recorded ───► INBOX+CONTACTS  reply lands in the same thread; rating on the Party
Money reconciled ──────────────► FINANCIALS quoted/invoiced/paid/balance; est-vs-actual margin closed
```

Cross-cutting on every step: comments + @mentions, append-only audit, bulk operations, import/export, global search (the F1 platform primitives).

## Sidebar (11 pages, final list)

Adopts the design-system `AppShell` rail (66px collapsed → 344px hover-expand, blue-fill active — spec in `F0-DESIGN-BRIDGE.md`). Order mirrors the golden flow top-to-bottom; Settings sits last per Nexus convention.

| # | Page | Route | One-line purpose |
|---|---|---|---|
| 1 | Inbox | `/inbox` | Where orders are born: unified conversations (Gmail now, WhatsApp later) |
| 2 | Quotes | `/quotes` | The configurator + RFQ pipeline: options → live price with margin → send → track → convert |
| 3 | Orders | `/orders` | The operational board: every confirmed job's status, money and promise date |
| 4 | Production | `/production` | Work orders on the 5-stage board + the workers' shop-floor view |
| 5 | Materials | `/materials` | Raw-material inventory on the movement ledger; suppliers; purchase orders |
| 6 | Products | `/products` | Templates, option groups, pricing model, BOM composition, cert registry |
| 7 | Contacts | `/contacts` | Brands, customers, suppliers: price lists, terms, measurement profiles, full history |
| 8 | Shipping | `/shipping` | Carrier connections, label queue, pickups, tracking timelines |
| 9 | Financials | `/financials` | Per-order and per-party money: invoiced/paid/balance, costs, margins (field-gated) |
| 10 | Analytics | `/analytics` | Throughput, stage lead times, on-time rate, margin trends, quote win/loss, reviews |
| 11 | Settings | `/settings` | Integrations (Gmail/Drive/carriers), team & roles, import/export center, stage + pricing config |

Not pages (deliberate): **Reviews** live on Orders/Contacts/Analytics, not a standalone page (volume is per-order, not a queue). **Compliance/certificates** live inside Products + the QC stage (new scope, see `F0-FINDINGS.md` §9). **Reports** are Analytics. A 12th "Dashboard/Home" page is deferred — Inbox IS the home page in an email-born workflow; revisit after FP4 if the Owner misses a snapshot view.

---

## 1. Inbox — `/inbox`

**Purpose.** The factory's front door. Every Gmail conversation in the factory's scope, rendered as a work object: assigned, commented, linked to the party and to the quote/order it produces. Two-way: replies send from the Owner's own address and thread correctly; everything stays visible in Gmail itself (we augment Gmail, never trap mail).

**Primary entities.** `Conversation` (channel-agnostic), `Message`, `Party` (matched by sender), links to `Quote`/`Order`, `Comment`, `Attachment`.

**Key actions.** Reply / reply-with-quote (opens the configurator pre-scoped) · assign · internal comment with @mention · link/unlink to party, quote, order · create party from unmatched sender · snooze + follow-up reminder (auto-cancels on customer reply) · save attachment to Drive · mark done (close).

**Best in class means** (verdicts applied):
- The Front/Missive four-pane anatomy — folders/queues rail, conversation list, thread pane, context rail (ADOPT). The context rail shows the matched party card (price list, terms, history) and LIVE linked objects: the quote's state, the order's stage, price and margin — not a URL chip (BEAT vs Front Links).
- Missive-style internal comments interleaved in the thread as visually distinct bubbles, composer with a Reply/Comment toggle — a mis-send to a B2B brand is unrecoverable (ADOPT).
- Close-vs-archive semantics: team queue → assign → close on delivery; a customer reply reopens to the assignee. "Done" is a state of the work (ADOPT from Missive).
- Gmail fidelity is non-negotiable: labels/read/archive round-trip; the Owner can still live in Gmail on day 30 (ADOPT; Front's import-once-then-diverge is the named trap).
- ~5 plain-English toggleable rules (sender-domain → Brand match, auto-tag, "unanswered after X business hours → amber + notify Owner"), not a rules builder (ADAPT from Front/Missive).
- Freshness line always visible: "mail synced Xs ago" in the ads-console idiom.

**RBAC.** `pages.inbox`; reply/send gated by `inbox.send`; financial figures in the context rail obey `financials.*` grains.

**Bulk / import-export.** Bulk assign/tag/close on the list; conversations export (CSV of metadata, not bodies).

## 2. Quotes — `/quotes`

**Purpose.** The RFQ pipeline and the configurator — the heart of the product. Compose a priced, margin-visible offer from the pricing model in less time than a competitor types their order form; send it into the same Gmail thread; track it to won/lost; convert to an Order on approval.

**Primary entities.** `Quote`, `QuoteLine`, `QuoteVersion` (sent snapshots), `ProductTemplate`/`OptionGroup`/`Option` (consumed), `PriceList` (party-scoped), `MeasurementProfile` (referenced), `Party`, `Conversation` (link).

**Key actions.** New quote from thread (pre-scoped) or from scratch · toggle options with live price/margin/constraint feedback · goal-seek (target price ⇄ margin) · attach/request measurement profile (self-measure kit email) · set deposit % · send (freezes snapshot v1) · revise (v2 supersedes) · mark won/lost with reason · convert to Order · duplicate from a past quote.

**Best in class means:**
- Option groups with min–max, requires/excludes constraints re-evaluated on every toggle with human explanations ("perforation excludes waterproof liner") — ONE constraint table, not two overlapping engines (ADOPT Salesforce CPQ model, BEAT its rules DSL).
- The 4-line visible waterfall per line: Cost → List (party's price list) → Adjustment (±, with reason) → Net, with margin € and % beside — Owner-only via field gating (ADAPT from CPQ's 9 stages; SAP's Gross Profit button always-on).
- Live cost breakdown (material/labor lines that later drive reservations) + negative-margin flag (ADOPT Fulcrum); capable-to-promise date beside the price, derived from current floor load (ADAPT Fulcrum's CTP button + MRPeasy's "Estimate costs and dates" — ours recomputes continuously, not on a button).
- Similar-quote recall: this party's and this garment-type's past quotes with won/lost outcomes surface while quoting (ADOPT JobBOSS²).
- Snapshot-on-send versioning; sent quotes are immutable, edits create v2 (ADOPT CPQ + ERPNext docstatus). Quotes never reserve stock; conversion does (ADAPT Katana's quote semantics — ours confirms from the email thread).
- Customer approval is a link in the email thread — no portal account (ADAPT Odoo's portal sign/pay, BEAT MRPeasy's B2B portal).
- A margin-floor speed bump (net margin below threshold → red badge + explicit confirm), not approval chains (ADAPT CPQ Advanced Approvals).

**RBAC.** `pages.quotes`; `quotes.create/send/approve`; cost/margin fields behind `financials.margins.view` — a Worker literally cannot see the waterfall.

**Bulk / import-export.** Price-list and option-delta CSV import with dry-run diff; quotes export; bulk mark-lost.

## 3. Orders — `/orders`

**Purpose.** The operational truth: every confirmed job, its lifecycle status, owner, promise date, money summary, and one-click drill into thread, quote, work order, shipment. The monday-grade board the Owner runs the day from.

**Primary entities.** `Order`, `OrderLine`, links to `Quote` (born-from), `WorkOrder`, `Shipment`, `Invoice`/`Payment` (financial summary), `Party`, `Conversation`.

**Key actions.** Confirm from quote (auto) · one-click "Start production" → Work Order with shared identity (ORD-214/1) · record payment/deposit · edit promise date (audited) · bulk status/assign/tag/export · drill to any linked record · cancel with reason (compensating events).

**Best in class means:**
- Katana's one-click order→production with shared numbering and bidirectionally synced priority (ADOPT) plus its status-words-as-UI: Materials "In stock / Expected / Not available", Production "In progress @ STITCHING" — click the word to see the why and the fix (ADOPT).
- monday's row grammar: status cells with click→color-palette, hover choreography (drag handle, checkbox reveal, open-card affordance), bottom batch-actions bar, undo toast — but statuses come from the domain state machine and drag-to-stage is a validated command (can't drop into SHIPPED without a label) (ADOPT/ADAPT monday).
- The linked chain rendered as ONE timeline on the order card: email → quote v2 → confirmed → WO stages → label → delivered → review (ADAPT NetSuite's created-from chain + Odoo's smart buttons, collapsed to one screen).
- B2B size runs enter as a matrix row (2×S, 5×M, 3×L) that explodes into per-size work orders (ADAPT Infor Fashion/ApparelMagic).
- Docstatus discipline: a confirmed order is never silently editable; amendments are audited revisions (ADOPT ERPNext).
- Two projections of the same query: table + kanban by lifecycle stage (ADAPT monday views).

**RBAC.** `pages.orders`; `orders.edit/cancel`; money columns behind `financials.*` grains (a Worker sees the board without prices).

**Bulk / import-export.** Bulk everything on the grid; order import (CSV template) for migrating history; export selection.

## 4. Production — `/production`

**Purpose.** Work orders through the fixed pipeline CUTTING → STITCHING → ASSEMBLY → QC → PACKING (stage list configurable in Settings, fixed by default). Two faces: the Owner's board (all WOs, stage columns, bottlenecks) and the worker's shop-floor view (my next task, big buttons, zero training) — on a phone or tablet on the LAN.

**Primary entities.** `WorkOrder`, `WorkOrderStage` (assignee, timestamps, checklist, photos), `MovementLedger` RESERVE/RELEASE + consumption events (reservations are ledger rows), `MeasurementProfile` (the spec), `Certificate` (QC gate), `Comment`.

**Key actions.** Owner: reprioritize by drag (reallocates material reservations by priority — Katana's signature move) · assign stage to worker · view est-vs-actual cost per WO · approve QC exceptions. Worker: Start / Pause / Finish on my current stage (timer feeds actuals) · report actual material use at CUTTING finish (hide usage vs estimate — the profit leak) · tick stage checklist items (auto user+timestamp) · attach QC/fit photos · scrap + reason · comment/@mention from the floor.

**Best in class means:**
- Odoo's shop-floor operator surface (cards, step checklists, timers, tap-to-switch operator, log-note from the floor) — their best screen, Enterprise-paywalled; we ship the pattern free (ADOPT).
- MRPeasy's kiosk trio Start/Pause/Finish with quantity/consumption prompts + "my production plan" queue ("your next task is the top line") (ADOPT); Epicor's big-button MES station reduced to a phone page per stage (ADAPT).
- Katana's ingredient traffic lights on the task, and its rule that operators never see costs or prices (ADAPT its Shop Floor App — same pattern, enforced by RBAC field-gating rather than sold as a separate app SKU).
- Estimated-vs-actual per WO, side by side, recalculating as workers report — the margin-truth loop (ADOPT MRPeasy/ApparelMagic/Fulcrum).
- Unit-level genealogy for qty-1 garments via per-stage assignee + timestamps + comments — no scanners, no piece-rate apparatus (ADAPT BlueCherry, IGNORE its payroll machinery).
- QC stage = checklist + photo evidence + fit-check gate for MTM + the cert gate: PACKING is blocked if the garment's EN 17092 class cert is missing/expired (BEAT — no apparel vertical models EU PPE).
- Scheduling honesty: a per-stage queue + "latest safe start" warning derived from the promise date (ADAPT MRPeasy backward scheduling); no Gantt, no workstation capacity math (IGNORE — capacity here is three pairs of hands within earshot).

**RBAC.** `pages.production`; `workorders.advance`, `materials.consume`; Workers see NO financial fields anywhere on this page — the strongest zero-training move is a nav that simply lacks Quotes/Products/Financials.

**Bulk / import-export.** Bulk assign/advance (Owner); WO list export; stage-time CSV export for analysis.

## 5. Materials — `/materials`

**Purpose.** Raw materials (leather by hide/m², linings, armor, zips, thread) on an immutable movement ledger — stock is always a derived number. Suppliers and purchase orders live here; low-stock and reservation pressure are visible before they bite.

**Primary entities.** `Material`, `MaterialLot` (hide/dye batch), `MovementLedger` (IN purchase / OUT consumption / ADJUST with reason / RESERVE/RELEASE), `Supplier` (a `Party` kind), `PurchaseOrder`.

**Key actions.** Receive PO (IN movements per lot) · adjust with mandatory reason · reserve/release (driven by order confirmation) · "+ Buy" from any shortage (pre-filled PO — two clicks) · set reorder level · record supplier price change (triggers reprice ripple flag on affected options/quotes) · lot lookup ("which orders consumed hide lot L-88?").

**Best in class means:**
- Katana's four-column math per item: In stock / Committed / Expected / Calculated, perpetual and automatic from buy-make-sell activity (ADAPT: one location, leather units — hides + m², lot-aware).
- MRPeasy's six-state parts grammar on work orders (Not booked → Not enough → Requested → Delayed → Expected → Received) driving honest promise dates (ADOPT).
- Reservation at order confirmation against the WO (ADOPT ERPNext v16), released or consumed at stage completion; actual hide usage prompted at CUTTING finish and diffed vs estimate (ADAPT backflush — leather waste is the profit leak).
- The ledger IS the audit: every number explains itself as a sum of movements; "undo" is a compensating movement (FD8; BEAT monday/spreadsheets where quantities are editable cells).
- Supplier cost edit → visible ripple: "3 templates, 7 open quotes reference this cost" (ADOPT Craftybase's reprice ripple).
- Cut-plan optimization: IGNORE — leather is cut hide-by-hide around scars; optimization lives in the cutter's hands.

**RBAC.** `pages.materials`; `materials.adjust/receive`; supplier prices behind `financials.suppliers.view`.

**Bulk / import-export.** Material catalog + opening-stock CSV import (dry-run diff); PO import; ledger export (append-only slice).

## 6. Products — `/products`

**Purpose.** The pricing model's home: product templates ("Custom Cowhide Suit"), option groups and options with cost + price deltas, BOM composition rules (per-option material draws), base costs/prices, and the certificate registry per style. Everything the configurator consumes.

**Primary entities.** `ProductTemplate`, `OptionGroup` (min–max select), `Option` (costDelta, priceDelta, material draws), `OptionConstraint` (REQUIRES/EXCLUDES + message + severity), `BomLine`, `Certificate` (EN 17092 class, number, notified body, expiry, covered styles/sizes), `PriceList` overrides (shared with Contacts).

**Key actions.** Author template/groups/options · set per-option cost+price deltas (absolute or %) · define material draws per option (kangaroo vs cowhide consume different hides) · author constraints with messages · attach certificates · preview-as-configurator (dry-run pricing for any party) · version prices (edits never mutate sent-quote history).

**Best in class means:**
- The CPQ product model made native and margin-live: bundle → features → options with constraints (ADOPT Salesforce concepts), composed per one-off order instead of authored per SKU (BEAT SAP's item-master-before-quote and Odoo's combinatorial variants).
- The option sheet IS the spec: configurator selections compile deterministically into the WO's material list and a tech-pack-lite PDF (ADAPT Genius CAD2BOM + ApparelMagic tech packs — render, don't author).
- Size/color dimensions without SKU explosion: dimensioned styles, grids wherever quantities appear; SKUs materialize only for export (ADOPT ApparelMagic/BlueCherry pattern).
- Costing sheet = the pricing model itself: cost roll-up → target-margin suggested price, with cost-change ripple (ADOPT Craftybase, ADAPT ApparelMagic's static per-style sheet into live per-order composition).
- Cert registry as first-class data with a QC enforcement hook (our BEAT — see Production).

**RBAC.** `pages.products`; `products.manage`; all cost fields behind `financials.costs.view`.

**Bulk / import-export.** Template/options/BOM CSV import with dry-run diff (the primary authoring accelerant); full pricing-model export; per-entity import templates.

## 7. Contacts — `/contacts`

**Purpose.** Brands, customers and suppliers as one `Party` model with kind-specific faces: emails (the Inbox matching keys), price list assignment, currency, payment terms, deposit defaults, measurement profiles, and the full relationship history (conversations, quotes with won/lost, orders, shipments, reviews).

**Primary entities.** `Party` (BRAND | CUSTOMER | SUPPLIER), `PartyEmail`, `PriceList` (+ per-party assignment), `MeasurementProfile` (named, versioned, fit notes, photos), `Review`, links to everything.

**Key actions.** Create (or one-click from an unmatched sender in Inbox) · assign price list + terms + deposit default · manage measurement profiles (new version on re-measure; append-only history) · compare prices side-by-side across parties for the same configuration · record review/rating · merge duplicates (audited).

**Best in class means:**
- Front's contact sidebar concept promoted to a real workspace: everything keyed by sender email, pre-scoped to price list, terms, sizes on file (ADAPT — factory-schema'd fields, not a generic field builder).
- Measurement profiles as first-class typed schema per garment type — named sets, versioning, freeform fit/posture/injury notes, photo attachments — referenced by many orders, never buried in a notes blob (ADOPT Tailornova/MTM landscape, BEAT CRM-custom-fields approaches).
- Per-party configurator defaults (their leather, their branding zones) (ADAPT MTM dealer models).
- The side-by-side price comparison per party with visible discounts — the Owner's stated requirement, enabled by FD7's per-list deltas (ADAPT SAP's pricing hierarchy: five layers collapsed to a party list + its "price source" line stolen verbatim).

**RBAC.** `pages.contacts`; `contacts.manage`; terms/discount/price-list contents behind `financials.view` grains.

**Bulk / import-export.** Contact + price-list CSV import (dry-run); export per segment; measurement-profile PDF per party.

## 8. Shipping — `/shipping`

**Purpose.** Carrier connections (the connect-a-courier wizard lives in Settings › Integrations; this page operates them), the label queue, pickups, and tracking timelines that push status back into orders and threads.

**Primary entities.** `Shipment`, `TrackingEvent`, `CarrierAccount`, `Pickup`, links to `Order`/`WorkOrder` (PACKING handoff).

**Key actions.** Buy label from an order in two clicks (service pre-assigned by rules; confirm-and-print) · compare 3–5 live rates inline, cheapest pre-selected · void label · book pickup (day-sheet of today's parcels pre-filled) · share tracking into the thread (automatic, with per-brand sender identity) · create return authorization from the thread (label attached).

**Best in class means:**
- Strictly fewer clicks than the bar: Sendcloud needs rules → select → Create labels (2–3 clicks); ShipStation's Create+Print split-button and configure-shipment rail; ours collapses purchase+review+print into one confirm on the order (ADOPT both, BEAT Shippo's 4-screen flow).
- Rate comparison inside the purchase moment, not a separate comparator page (BEAT Sendcloud's detached price list).
- Tracking by polling — decisive for local-first (no public endpoint): batched poll of in-flight parcels every 15–30 min via the adapter's `pollTracking` (Sendcloud confirmed pollable; capability-flagged per adapter).
- Scan-based return labels attached dormant to B2B shipments, charged only if used (ADOPT Shippo concept; verify Italian-carrier support).
- Estimated total incl. typical surcharges shown at purchase; carrier invoices reconciled back to shipments monthly (BEAT the silent-surcharge billing everyone complains about).

**RBAC.** `pages.shipping`; `labels.purchase/void`; shipping costs behind `financials.costs.view`.

**Bulk / import-export.** Bulk label purchase for a size-run's parcels; day-sheet manifest PDF; shipments CSV export.

## 9. Financials — `/financials`

**Purpose.** Order-level money truth rolling up to party and period: quoted → invoiced → paid → balance, cost and margin (estimated vs actual), deposits outstanding, discounts given. Explicitly NOT general accounting — we track order financials and hand the ledger to the commercialista (ADAPT Fishbowl's "own ops, delegate the ledger" boundary; confirmed by the teardown, no platform under review made in-app accounting a win at this scale).

**Primary entities.** `Invoice` (lightweight: number, amount, PDF), `Payment` (incl. deposits), `Order` money rollups, `Party` rollups.

**Key actions.** Record payment/deposit · issue deposit request on quote acceptance (WO unlocks on paid, when gated) · mark invoice sent/paid · period + party rollups · export everything (the accountant interface is CSV/XLSX).

**Best in class means:**
- Every number drills to its orders (SAP golden-arrow ADOPT: every code a link).
- Estimated-vs-actual margin per order closed by production actuals — the loop no competitor closes at quote time (Fulcrum closes it post-hoc; we show the delta live and feed the next quote).
- Deposit patterns first-class: % per quote (30%/50% observed in the MTM market), balance-before-ship flag (ADOPT).
- Field-gating is the page: OWNER sees everything; FINANCE-like role read-only; Workers don't see the page at all (`pages.financials` absent from their nav).

**Bulk / import-export.** Payment import (bank CSV, dry-run matched to invoices); full export per period for the accountant.

## 10. Analytics — `/analytics`

**Purpose.** The factory's rhythm: throughput, stage lead times and bottlenecks, on-time-vs-promise rate, margin by product/party/period, quote win/loss and reasons, review scores, material consumption trends.

**Primary entities.** Read-models over everything (SQLite views); no new writes except saved report configs.

**Key actions.** Filter by period/party/product · drill from any aggregate to its rows · save a view · export any chart's data.

**Best in class means:** three live counters beat leaderboards (unanswered threads, quotes awaiting approval, overdue promises — ADOPT our Inbox/monday findings; IGNORE team leaderboards for 4 people); every metric answers a decision ("which stage eats our lead time", "which brand's discounts erode margin", "what's our win rate on perforated suits"); local SQLite means any question is one query away (BEAT Katana's export-only reporting).

**RBAC.** `pages.analytics`; margin/financial widgets per `financials.*` grains.

## 11. Settings — `/settings`

**Purpose.** Integrations (Gmail connect + sync status + label scope; Drive; the connect-a-courier wizard; WhatsApp later), team & roles (the RBAC console, FP11), import/export center (templates per entity, job history, dry-run everywhere), pricing defaults (margin floor, deposit default, VAT display), stage configuration, backup status (last snapshot/replica, restore drill).

**Primary entities.** `User`/`Role`/`Invitation`/`Session`, `CarrierAccount`, integration connections (Gmail/Drive OAuth grants — token status, never token values), `ImportJob`, stage-pipeline config, pricing defaults, backup/health status records.

**Key actions.** Connect/test/disconnect Gmail, Drive, carriers (the wizard) · pick the Gmail label scope + preview what would sync · invite a user + assign role · edit a custom role's permission list (guardrailed) · download per-entity import templates · run import (dry-run → apply) / export · edit the stage list, margin floor, deposit default · trigger snapshot + restore drill · view worker heartbeat, quota meters, DB size.

**Best in class means:** the Sendcloud own-contract connect shape (pick carrier → one credential form with field help → test call → live) (ADOPT); Gmail connect proves the riskiest integration in F1 with visible sync status and quota meters; every integration panel states freshness; backup status is a first-class panel (local-first means WE are the ops team — surface it, don't hide it).

**RBAC.** `pages.settings` + `settings.integrations.manage`, `users.manage`, `roles.manage` (Owner-only by default).

---

## Page-cycle order (FP1…n) — recommendation

**FP1 Inbox → FP2 Products & Pricing → FP3 Quotes → FP4 Orders → FP5 Contacts & Price Lists → FP6 Production → FP7 Materials → FP8 Shipping → FP9 Financials → FP10 Analytics → FP11 Settings polish + WhatsApp decision.**

Rationale:
1. **FP1 Inbox first** — it is the wedge (the teardown's one-sentence result), it exercises the riskiest integration (Gmail, already proven in F1's Settings connect), and it delivers standalone value on day one: the Owner can run real correspondence in it before any other page exists. Party auto-match ships here with a minimal party record (full Contacts workspace waits for FP5).
2. **FP2 Products & Pricing before Quotes** — the configurator is only as good as the model it reads. FP2 builds templates/groups/options/constraints/BOM + cost/price deltas and the dry-run preview. (`Party` and `PriceList` schema exist from F1; FP2 gives deltas a home; FP5 later gives parties their full workspace.)
3. **FP3 Quotes closes the golden flow's first half** — email → configurator → live margin → quote sent in-thread. This is the demo that beats every competitor's order-entry screen; win/loss tracking starts accruing data for Analytics from day one.
4. **FP4 Orders** — approval → Order with the board, timeline, and money summary. The Owner can now run the business end-to-end with manual production tracking.
5. **FP5 Contacts & Price Lists** — promote the minimal party records into the full workspace (measurement profiles, side-by-side price comparison, history). Placed here because quoting pressure will have revealed real price-list needs.
6. **FP6 Production, FP7 Materials** — the factory floor: WO explosion, stage board, shop-floor view; then the ledger's full UI, POs, reservations. (Ledger + reservation schema run underneath from F1/FP4 — FP6/FP7 give them their surfaces. Materials after Production because reservations only matter once stages consume them.)
7. **FP8 Shipping** — first carrier adapter (Sendcloud) live; PACKING → label → tracking → thread. Deliberately after Production so the label queue has real WOs feeding it.
8. **FP9 Financials, FP10 Analytics** — rollups once there is data worth rolling up.
9. **FP11 Settings polish + WhatsApp decision (FD5)** — team & roles UI, import/export center polish, and the WhatsApp channel call with real usage evidence.

Each cycle is double-gated per the master prompt: written spec → Owner approval → build → click-through verification → Owner approval. Never build ahead of an approved spec.
