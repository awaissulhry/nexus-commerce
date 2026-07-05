# Factory OS competitor teardown (F0)

F0 deliverable 1 of 6 — researched 2026-07-04/05 against live vendor docs, help centers, changelogs and review sites (G2/Capterra/Software Advice/Reddit); every section carries its sources. This document is the canonical competitive record for the Factory OS workstream: page-cycle specs (FP1…n) must cite these verdicts when they adopt, adapt, beat or ignore a capability. No product code exists yet; nothing here commits us to anything until the Owner approves the F0 gate.

**Verdict legend** (argued from THIS factory's reality — tiny team, one-off made-to-measure leather work, orders born in Gmail, $0 infrastructure; never from generic best practice):

| Verdict | Meaning |
|---|---|
| **ADOPT** | Copy the idea as-is |
| **ADAPT** | Take the concept, reshape it for a tiny custom factory |
| **BEAT** | They do it badly or heavily — we do it concretely better |
| **IGNORE** | Enterprise theater at our scale — with the reason |

**Coverage:** 12 deep teardowns (SAP Business One + S/4HANA, Odoo Community, Katana, MRPeasy, Fulcrum, ApparelMagic + WFX + BlueCherry, made-to-measure/configurator landscape, monday.com, Front + Missive, Sendcloud + ShipStation + Shippo + EasyPost, Salesforce CPQ/Revenue Cloud + Tacton) plus a long-tail sweep of 13 further platforms (NetSuite, Dynamics 365 Business Central, Acumatica, Epicor Kinetic, Infor M3/Fashion, Priority, ERPNext, Fishbowl, Cin7 Core, Unleashed, Craftybase, Genius ERP, JobBOSS²; the sweep's 14th entry, Fulcrum, was promoted to its own deep teardown) — 25+ products total.

## The one-sentence result

**Nobody owns the moment an order is born.** Every manufacturing platform starts at a hand-typed order form; every inbox platform stops at the conversation. The gap between them is the product.

| Platform | Where their flow starts | Email's role |
|---|---|---|
| SAP Business One | Item master + BOM, then a quotation form | Filed as ERP "activities" via a Windows-only Outlook add-on |
| Odoo | CRM lead / quotation form | Catchall alias creates records; generic, not sender-scoped |
| Katana | Sales-order card typed by hand | None — quotes leave as PDFs you email yourself |
| MRPeasy | CRM → Customer Order form (~8 interactions) | None — thread lives outside the ERP |
| Fulcrum (closest relative) | Quote form with live costing | **Send-only** — templates + PDF out; no inbound origin |
| Front / Missive | The email thread | Thread is the work object — but there is no domain behind it: a "Link" is a stateless URL chip |
| monday.com | A board item | Email-to-board dumps subject lines via an address that leaks an API key; no sender identity |
| **Factory OS** | **The inbound Gmail message** | **Sender auto-matched to a party → configurator pre-scoped to their price list → quote replies into the same thread → the thread gives birth to the Order and Work Order** |

## What we inherit (the master matrix)

The strongest ADOPT/ADAPT verdicts, grouped by the Factory OS surface they land on. Details and sources in each platform section below.

| Factory OS surface | Inherited capability | From |
|---|---|---|
| **Inbox** | Four-pane thread workspace (nav / list / thread / context rail) | Front + Missive |
| | Internal comments interleaved IN the thread, visually distinct from customer messages | Missive |
| | Close-vs-archive: "done" is a state of the work, not of someone's inbox view | Missive |
| | Send-message vs log-note split in one timeline | Odoo chatter |
| | Snooze / follow-up reminders that auto-cancel when the customer replies | Front + Missive |
| | Gmail two-way fidelity (labels/read/archive round-trip; Owner can still live in Gmail) | Missive |
| **Quotes / Configurator** | Bundle = option groups (min–max) → options; requires/excludes constraint table with human messages | Salesforce CPQ |
| | Per-party price list auto-applied by sender match; "Price Source" explanation | Salesforce CPQ + SAP B1 |
| | 4-line visible price waterfall: Cost → List → Adjustment (with reason) → Net, margin € and % beside | Salesforce CPQ (collapsed from 9 stages) |
| | Live labor/material cost breakdown + negative-margin flag on every quote line | Fulcrum |
| | Capable-to-promise date shown at quote time, derived from current floor load | Fulcrum + MRPeasy |
| | Goal-seek pricing (type target price → margin shows; type margin → price fills) | Tacton |
| | Target-margin suggested price + cost-change reprice ripple | Craftybase |
| | Similar-quote recall: this customer's / this garment's past quotes with won/lost prices | JobBOSS² |
| | Snapshot-on-send versioning; sent quotes freeze, edits create v2 | Salesforce CPQ + ERPNext docstatus |
| | Quotes never commit stock; confirmed orders do | Katana |
| | Deposit gates production (30% / 50% patterns observed); WO unlocks on deposit paid | Dainese Custom Works (30%) / AG10Moto (50%) |
| | Self-measure kit sent from the thread; specialist review gate before confirm | MTM landscape |
| **Orders** | One-click Order → Work Order with shared identity (SO-670/1) and bidirectional priority | Katana |
| | Status-words-as-UI (In stock / Expected / Not available) with click-through to the why + the fix | Katana |
| | Linked document chain with created-from trace, extended upstream to the email | NetSuite |
| | monday-grade row interactions: status-cell color picker, hover choreography, batch bar, undo toast | monday.com |
| | Size-run matrix order entry for B2B (one grid row, not ten lines) | Infor Fashion + ApparelMagic |
| **Production** | Shop-floor cards with step checklists, timers, tap-to-switch operator — free, not Enterprise-paid | Odoo (their best surface, paywalled) |
| | Kiosk Start/Pause/Finish with quantity prompts; per-worker "my plan" queue | MRPeasy + Epicor MES |
| | Ingredient traffic lights; operators never see costs or prices | Katana Shop Floor App |
| | Estimated-vs-actual cost per work order, side by side, actuals from stage timers | MRPeasy + ApparelMagic + Fulcrum |
| | Scrap + reason capture; QC checkpoints with photo evidence; fit-check gate for MTM | Fulcrum + WFX |
| | Cert registry + QC gate: PACKING blocked if the garment's EN 17092 cert is missing/expired | Our BEAT — no apparel vertical models EU PPE 2016/425 |
| **Materials** | In stock / Committed / Expected / Calculated columns, perpetual from buy-make-sell | Katana |
| | Six-state parts-readiness color grammar; "+ Buy" turns a shortage into a PO in two clicks | MRPeasy + Katana |
| | Material reservation against the work order at order confirmation | ERPNext v16 |
| | Lots = hides/dye batches for color consistency + recall trace | MRPeasy (concept) |
| **Shipping** | Rules pre-assign method → select → Create labels (2–3 clicks); own-contract carrier attach | Sendcloud |
| | Create + Print split-button; one configure-shipment rail on the order | ShipStation |
| | Scan-based return labels (charged only when used) | Shippo |
| | Day-sheet manifest + pickup booking fused | ShipStation (adapted) |
| **Contacts** | Contact sidebar keyed by sender email: history, custom fields, linked live objects | Front (theirs is a URL chip; ours is a real relation) |
| | Named, versioned measurement profiles with fit notes + photos, decoupled from any order | Tailornova + MTM landscape |
| | Per-party configurator defaults | MTM dealer "custom models" |
| **Collaboration / audit (platform primitives)** | Chatter as a universal mixin: messages + followers + field-change audit on EVERY record | Odoo — the industry benchmark |
| | `tracking=True`-style declarative field audit rendered inline between comments | Odoo |
| | Updates feed interactions: @mention autocomplete, replies, seen; notification center with Mentioned tab | monday.com |
| | ONE timeline per entity: domain events interleaved with comments (not two silos) | Our merge of Odoo + monday |
| | Undo toast backed by compensating ledger events (undo never erases history) | monday + our ledger |
| | Docstatus discipline: nothing submitted is silently editable; amendments create revisions | ERPNext |
| **Bulk / import-export** | Every grid bulk-operable + Excel-grade round-trip as a platform guarantee | Dynamics 365 BC ("Edit in Excel") |
| | Dry-run diff preview before any bulk apply | Our own eBay-ads CSV idiom (see F0-DESIGN-BRIDGE) |
| | Unlimited seats — every worker is a first-class user | Acumatica's licensing philosophy, delivered by $0 local |

## The cost argument (their pricing is our marketing)

| Platform | Realistic cost for this factory (July 2026) |
|---|---|
| SAP Business One | ~€2.7k/user perpetual + 20%/yr maintenance + $30k–120k partner implementation |
| Katana | Core $299/mo + Manufacturing $199 + Shop Floor ~$199 ≈ **$700+/mo** before per-order usage fees; +15% to lock rates annually |
| MRPeasy | ~€236/mo (4 seats × €59 Professional, configurator tier) |
| Fulcrum | ~$6k–18k/yr revenue-based + $5k–8k launch |
| Front / Missive / monday | ~$1.1k–3.1k/yr for four seats, features tier-gated |
| Odoo | Community free but shop-floor UI + quality are Enterprise; self-host = Postgres/workers/upgrade ops burden |
| ERPNext | Free (GPL) but MariaDB + 3×Redis + Python/Node workers to operate; golden flow absent |
| **Factory OS** | **$0 infrastructure** (local SQLite, free Gmail/Drive APIs). Honest operating costs: Sendcloud plan for API access (≥Lite €28/mo — likely already paid at Xavia), optional €1.99/mo Drive storage |

## The deliberately skipped 80% (named, so nobody re-litigates it)

Subscription/usage billing · contract lifecycle · partner/distributor tiers · price-rules DSLs with evaluation order · approval chains and delegation · template designers · guided-selling questionnaires · CAD/3D visual config · MRP planning wizards and scenario runs · workstation capacity factors and productivity math · multi-level BOM subassembly explosion · multi-plant/multi-warehouse · EDI/retail compliance · line planning calendars · piece-rate payroll · hourly line efficiency boards · AI agents on metered credits. Each is argued in its platform's section below.

---

*Per-platform teardowns follow. Order: the enemy first (SAP), then the free benchmark (Odoo), the SMB UX bars (Katana, MRPeasy), the closest relative (Fulcrum), the vertical neighbours (apparel, made-to-measure), the interaction bars (monday, Front/Missive), the shipping bar, the pricing model source (CPQ), and the long-tail sweep.*

---

## SAP Business One — the SMB ERP that still behaves like big SAP

SAP Business One (B1) is SAP's small-business ERP: version 10 (Feature Pack 2602, March 2026) with version 11 announced for 2027, sold and implemented exclusively through channel partners, running on MS SQL or HANA with an aging Windows desktop client and a partial Fiori Web Client migration (MRP, pick & pack, and project management only reach the Web Client at FP 2608). Its world starts at the Sales Quotation — after a business partner, item masters, price lists, and BOMs already exist. Everything before that (the email, the negotiation, the configuration) lives outside the product. S/4HANA, the enterprise sibling, is only a cautionary contrast here: GROW with SAP public cloud has a 15-FUE minimum (~$150–180/user/mo for advanced users) and $150K–$600K implementations — even SAP steers sub-mid-market buyers away from it.

### Who it's for & pricing reality

- **Named-user licenses, partner-quoted** (July 2026 partner-published figures): Professional ~€2,700 / $3,213 perpetual per user + ~20%/yr maintenance; Limited ~€1,400 / $1,666. Cloud subscription: Professional ~€91–108/user/mo, Limited ~€47–56/user/mo ([business-one-consultancy](https://www.business-one-consultancy.com/sap-business-one/prices-and-costs.html), [ERP Research](https://www.erpresearch.com/pricing/sap-business-one)).
- **Starter Package** (~$1,350 perpetual or ~€38–50/user/mo, max 5 users) — the only tier sized like our factory — **excludes manufacturing** and multi-warehouse logic. A 10-person shop that actually produces must buy Professional/Limited licenses.
- **Implementation is partner-led and quoted per project**: ~$15K for a bare 5-user install, $30K–$120K typical, $150K+ with customization; year-one total commonly 2–4× annual license cost ([ERP Pilot](https://www.erp-pilot.com/erp/erp-prices/sap-business-one-pricing)).
- **Custom/configured manufacture isn't core B1**: partners sell the separately licensed **Beas Manufacturing** add-on (Boyum) for made-to-order, variant BOMs, and its Product Configurator (pricing partner-quoted; unverified).
- **Carrier labels are not native** — third-party add-ons (Sendcloud, Ingold, ITM, Phoenix) sell rate-quoting/label printing back into B1.
- Infra: a SQL/HANA server plus a partner to patch it. Against this, Factory OS's $0 SQLite-on-the-Owner's-machine is a structural price attack, not a discount.

### The screens that matter

- **Sales Quotation window** (Sales A/R → Sales Quotation): header pulls Customer code/Name, Contact Person, Status, dates; four tabs — **Contents** (row grid: Item No., Description, Quantity, Unit Price, Discount %, Tax Code, Total), **Logistics** (Ship-to/Bill-to), **Accounting** (payment terms, journal remark), **Attachments**. Footer totals. A **Gross Profit** toolbar button opens a popup computing (Sales Price − Base Price) × Qty per row, as % or absolute — margin is visible pre-send, but only if you ask, in a separate window, keyed off item-master base prices.
- **Sales Order window**: identical four-tab anatomy; created via **Copy To** from the quotation (row selection, quantity edits). Commits stock.
- **Production Order** (Production → Production Order): header = Product No., Planned Qty, Priority (default 100), Order/Start/Due dates; **Components** tab rows show Base Qty (copied from BOM), Planned, Issued, issue method (Manual vs Backflush); **Summary** tab totals. Status walks **Planned → Released → Closed**; components can't be issued while Planned; closing posts a journal entry. Component issue and finished-goods receipt are two more documents: **Issue for Production**, **Receipt from Production**.
- **MRP Wizard** (MRP → MRP Wizard): six steps — scenario, planning horizon + display prefs, item selection, inventory data source (Company vs Warehouse), documents data source, Run — landing on **MRP Results** with a Recommendations tab; "Save Recommendations" doesn't create orders, it feeds a separate **Order Recommendation** report where you finally generate POs/production orders. Past-due lines go red.
- **Resource Capacity**: Resource Master Data → Planning Data defines daily capacity as up to four multiplied "factors" (e.g., 32 cycles × 2 machines = 64/day); a Resource Capacity window offers daily and cumulative views. No native Gantt or finite scheduling.
- **Pricing engine**: price lists per customer group, plus a five-layer resolution hierarchy (blanket agreement > special prices per business partner > discount groups > period/volume discounts > price list), with a **Price Source** field on each row showing which rule fired.
- Everywhere: **orange "golden arrow" drill-downs** — any code on any row jumps to its master record. Genuinely loved.

### Click-path notes

**Custom one-off (a made-to-measure cowhide suit), core B1:** (1) Inventory → Item Master Data — create the finished-good SKU; (2) create item masters for any new components; (3) Production → Bill of Materials; only now (4) Sales Quotation — pick the BP, add rows, open Gross Profit popup to check margin; (5) send PDF via the Windows-only Outlook add-in or B1 mailer (Gmail shop: export and attach by hand); (6) Copy To → Sales Order; (7) create Production Order (manually, or 6-step MRP Wizard → Save Recommendations → Order Recommendation → generate); (8) flip Planned → Released; (9) Issue for Production; (10) Receipt from Production; (11) Copy To → Delivery (label via add-on); (12) A/R Invoice, then Incoming Payment. **Three master-data screens before a price can even be quoted; ~12 windows intent-to-done.** With Beas, steps 1–3 collapse into a configurator questionnaire — for an extra license.

**Repeat B2B order of known SKUs:** skip 1–3; still ~8 windows quotation → invoice, each a separate modal in the desktop client.

**Where the order is born:** nowhere. B1's flow starts by picking a BP code inside the client. Inbound email → party match → pre-scoped quote does not exist; Outlook integration files emails as activities and can push quotations out, but sync is Windows/Outlook-bound and historically flaky.

### What users complain about

- UI: "The interface feels a bit outdated and not very user friendly at times" ([G2](https://www.g2.com/products/sap-business-one/reviews)); "not intuitive, visually outdated, and difficult for new users to navigate" ([Capterra](https://www.capterra.com/p/214667/SAP-Business-One/reviews/)).
- Performance: freezes and crashes; one Capterra reviewer: the system "freezes for a few minutes on the top of the hour."
- Cost: prohibitive licensing + implementation for smaller companies; steep learning curve ([Software Advice](https://www.softwareadvice.com/accounting/sap-business-one-profile/)).
- Partner roulette: "bad projects and consultants can hold you back"; active B1 partners are contracting as they chase S/4HANA deals, degrading SMB support ([ERP Research](https://www.erpresearch.com/en-us/sap-business-one-implementation)).
- Failed projects trace to data migration (mismatched item masters, inconsistent UoM, duplicate customers) and user adoption — training-hungry software meeting untrained small teams.

### Verdicts

| Capability | Verdict | Why / how it maps to Factory OS |
|---|---|---|
| Copy To document lineage (Quotation→Order→Delivery→Invoice, fully audited) | ADAPT | Keep base-document traceability, but as ONE continuous thread from the Gmail message through quote→order→work order→delivery — not five separate windows re-keyed by Copy To. |
| Gross Profit button on quotes | ADOPT | Margin-at-quote is exactly our pricing model — make it an always-on inline column while options are toggled, not an opt-in popup off item-master base prices. |
| Per-partner pricing hierarchy + Price Source field | ADAPT | Per-party price lists = our sender-matched configurator scoping. Collapse five layers into party list + option modifiers; steal Price Source ("why this price") verbatim. |
| Golden-arrow drill-down everywhere | ADOPT | Every code a link. Cheap to build on SQLite, huge zero-training payoff. |
| Production Order status gates + Issue/Receipt traceability | ADAPT | Keep component-issue audit and status discipline, mapped to CUTTING→STITCHING→ASSEMBLY→QC→PACKING stages with reservations at order explosion; hide journal-entry ceremony from workers. |
| Item master + BOM required before quoting | BEAT | Fatal for one-offs: three master-data screens (or a paid configurator add-on) before pricing a suit. We quote from options first and derive the BOM/work order after approval. |
| Beas Product Configurator (questionnaire → variant BOM/routing) | ADAPT | The guided-questionnaire concept is right — but native, margin-live, pre-scoped by the email sender's price list, not a separately licensed add-on. |
| Outlook email integration | BEAT | Emails filed as ERP activities, Windows-only, no Gmail. We are born in the inbox: sender→party auto-match, quote sent in the same thread. |
| 6-step MRP Wizard + Order Recommendation report | IGNORE | Scenario-based batch planning for hundreds of SKUs/warehouses. A one-off suit needs per-order material reservation at explosion time, not a planning-horizon wizard. |
| Resource capacity factors + cumulative view | IGNORE | Machine-cycle math for factories with machines to level. Our capacity is a few named workers per stage; a visible per-stage queue does the job. |
| Partner-led licensing/implementation model | BEAT | €2.7K/user + 20%/yr + $30K–$120K install + add-ons for configurator and labels is the churn engine. $0 infra, zero-training, self-serve setup is the whole counter-position. |
| S/4HANA / Web Client re-platforming | IGNORE | 15-FUE minimums and a multi-release UI migration are enterprise theater; their unfinished Fiori transition just proves UI age is a liability we don't have. |

### Sources

- https://www.business-one-consultancy.com/sap-business-one/prices-and-costs.html
- https://www.erpresearch.com/pricing/sap-business-one
- https://www.erp-pilot.com/erp/erp-prices/sap-business-one-pricing
- https://sap-b1-blog.com/en/sap-business-one-starter-package/
- https://learning.sap.com/courses/managing-logistics-in-sap-business-one/running-the-sales-process-in-sap-business-one
- https://learning.sap.com/courses/managing-logistics-in-sap-business-one/running-the-production-process-in-sap-business-one
- https://blog.vision33.com/bid/90555/basics-of-sap-business-one-for-sales-pt-1-sales-quotations
- https://firebearstudio.com/blog/how-to-use-the-wizard-to-execute-an-mrp-run-in-sap-business-one.html
- https://sap-ds.com/training/sap-business-one/logistics/production-and-mrp/managing-resource-capacity
- https://learning.sap.com/courses/managing-logistics-in-sap-business-one/exploring-the-pricing-concepts
- https://sap-b1-blog.com/en/glossary/gross-profit-calculation-sap-business-one/
- https://www.boyum-solutions.com/solutions/beas-manufacturing/
- https://help.sap.com/docs/SAP_BUSINESS_ONE/f7898af6aa7b40a2a2166d48443fc43f/45fe38abd67f04a7e10000000a114a6b.html
- https://www.sendcloud.com/integrations/sap-business-one/
- https://sap-b1-blog.com/en/sap-business-one-road-map-2026/
- https://www.g2.com/products/sap-business-one/reviews
- https://www.capterra.com/p/214667/SAP-Business-One/reviews/
- https://www.erpresearch.com/en-us/sap-business-one-implementation
- https://www.erp-pilot.com/erp/erp-prices/sap-s4hana-pricing
- https://blog.nbs-us.com/what-is-an-fue-when-buying-s/4hana-cloud

---

## Odoo Community — the free open-source ERP whose chatter primitive is the industry benchmark, but whose factory-floor surfaces are paywalled

### Who it's for & pricing reality
Current major version is **Odoo 19** (released at Odoo Experience, Oct 2025; minor 19.3 shipped May 2026 with AI agents and a redesigned Manufacturing kanban). Community and Enterprise ship from the same codebase; Community is LGPLv3, self-hosted, unlimited users, $0 license. Paid plans (EUR, from odoo.com/pricing, July 2026): **One App Free** €0 on Odoo Online; **Standard** €11.90/user/mo yearly (€14.90 monthly) — a "discount valid for 12 months" promo, renewal list price (unverified); **Custom** €17.90/user/mo adds Studio, multi-company, external API, on-premise/Odoo.sh.

The catch for a factory: the **Community/Enterprise split lands exactly on the shop floor**. Community includes CRM, Sales, Invoicing, Inventory, Purchase, Maintenance, and MRP core (BOMs, MOs, work centers, basic work orders). Enterprise-only: **Quality** (control points/alerts), **PLM**, **Barcode**, **Shop Floor** (the operator tablet app), **MPS**, Gantt work-order planning, OEE control panel, IoT — and **carrier shipping connectors** (DHL/FedEx/UPS label purchase). Odoo positions Community as "the core upon which Enterprise is built"; in practice back-office is free, operator-facing depth is paid. There is also **no official upgrade service for Community** — major-version DB migration is DIY via OCA OpenUpgrade.

### The screens that matter
**Chatter (on every record — leads, quotes, MOs, pickings).** Architecturally it's two mixins any model inherits: `mail.thread` (messages, followers, `message_post()`, `tracking=True` field audit) and `mail.activity.mixin` (scheduled activities). The widget sits right of the form (below on narrow screens). Anatomy:
- **Composer** with two modes: **Send message** (goes to followers/external contacts by email) vs **Log note** (internal-only, visually distinct); Ctrl+Enter sends; expand icon opens a full "Compose Email" popup with templates, subject, extra recipients; AI-draft icon in 19.
- **@mentions** notify by email or in-app inbox per each user's own notification preference; external contacts can be tagged in notes.
- **Followers**: creator and assignee auto-follow; person icon → "Add Followers"; pencil → "Edit Subscription" with per-record-type checkboxes of which event subtypes notify. To not notify someone you must *remove them as follower before sending*.
- **Audit trail in the same feed**: any field declared `tracking=True` logs "old → new" system lines with author + timestamp, interleaved with messages.
- Attachments (paperclip), in-thread **search**, message **Edit** via ⋮ (edits don't re-email recipients).
- **Activities**: typed follow-ups (To-Do, Call, Email, Meeting, Document, Signature) with due date + assignee; color-coded green/orange/red; "Done & Schedule Next" chaining; a global clock icon aggregates late/today/future across all apps.

**Quotation form (Sales, Community).** Status ribbon **Quotation → Quotation Sent → Sales Order**; header buttons Send by email / Confirm / Preview. Fields: Customer (auto-fills addresses, **Pricelist**, Payment Terms), Expiration, Quotation Template. Tabs: Order Lines ("Add a product" or Catalog picker, section headers, notes), Optional Products, Other Info, Notes. With the Margins setting on, **cost + margin show per line**. Customer Preview opens the portal quote with **Sign** and **Pay** buttons. Smart buttons top-right link Delivery/Invoices/MOs — the cross-document chain.

**Manufacturing order (Community).** Form with Product (BoM auto-populates), Quantity, Scheduled Date; tabs **Components / Work Orders / Miscellaneous**; buttons **Confirm**, Check Availability (reserves components), **Produce All**. Work orders (per work center, from the BOM's Operations tab) carry Start/Done buttons and duration tracking in plain list/form views.

**Shop Floor (Enterprise — the benchmark we ship free).** Top tabs: All / My WO / one per work center; left **Operator panel** (tap-to-switch signed-in employees). MO cards show product, status, greyed-out completed WOs, current WO with chevron; WO cards show a **checklist of steps** that open instruction popups, a running **timer**, Register Production line, footer "Close Production". Options menu includes Scrap, Add Component… and **Log Note** — chatter reaches the floor.

### Click-path notes
- **Email → lead**: per-sales-team email alias auto-creates a lead with the message in chatter (zero clicks) — but only after configuring inbound mail (own mail server/catchall or Gmail OAuth via a Google Cloud project). Replies thread into chatter.
- **Lead → quote**: open lead → New Quotation → pick products line by line → Send by Email (dialog) → customer signs in portal → auto-confirms to SO. ~4 screens, smooth *if* the product already exists.
- **One-off custom piece (our golden flow)**: no quantity-one path. You must create a **new product**, a **new BOM** (components + operations), then quote, confirm, and get the MO — ~5 forms across 3 apps before production starts. The sales **Product Configurator** checkbox isn't offered in Community settings per an Odoo forum thread (v17; unverified for 19) — Community gets Variant Grid Entry, and variants are combinatorial attributes, not made-to-measure options with per-option pricing/margin.
- **SO → MO**: automatic via MTO route + Manufacture route (replenishment magic that beginners routinely misconfigure; forum threads abound).
- **MO completion (Community)**: MO → Work Orders tab → Start … Done per WO → Produce All. Functional, but it's a back-office form, not an operator surface.
- **Ship + label**: Community = manual delivery methods; label purchase needs Enterprise connectors or third-party modules. Not two clicks.

### What users complain about
- **Learning curve and click depth**: "the biggest issue with Odoo ERP is the learning curve"; users call the UI "clunky, confusing, or overly complex" (Capterra 2026 reviews). Terminology is ERP-speak: leads vs opportunities, RFQs, pickings/transfers, routes.
- **True cost**: "a real Odoo deployment typically costs several times more than the advertised per-user price" once partners/customization enter (Swell/ERP Research 2026).
- **Upgrade pain (Community)**: "Odoo S.A. only offers their upgrade service for Enterprise… Community users must use OpenUpgrade," with manual fixes per custom module (OCU/Cloudpepper guides; OCA OpenUpgrade README). Yearly majors make this a treadmill.
- **Email plumbing**: Odoo maintains an entire "Common emailing issues" FAQ page — catchall/alias/bounce configuration is a known swamp for self-hosters.
- **Community withholding**: the recurring gripe that quality, barcode, shop floor, and planning — precisely the factory bits — are paid.

### Verdicts
| Capability | Verdict | Why / how it maps to Factory OS |
|---|---|---|
| Chatter as a universal mixin (messages+followers+audit on EVERY record) | ADOPT | One `Thread` primitive attached to Customer/Quote/Order/WO/Shipment is the correct schema decision; Odoo proves it scales from CRM to shop floor. |
| Send message vs Log note split in one thread | ADOPT | Exactly our need: customer-facing Gmail reply and internal margin talk live on the same quote, visually separated. |
| `tracking=True` declarative field audit rendered inline in the feed | ADOPT | Cheapest possible audit trail; "price 480 → 520 by Owner" between comments builds trust for free. |
| Followers + auto-subscribe (creator/assignee) | ADAPT | Keep auto-follow + @mention; drop the per-subtype "Edit Subscription" matrix — a 5-person team needs watchers, not notification governance. |
| Scheduled activities with types + chaining + global overview | ADAPT | Collapse to a single "next action + due date" chip on quotes/orders; typed activity admin is overhead at our scale. |
| Email alias → record, replies thread into chatter | ADAPT | Keep the email-born-record concept, but we live *inside* Gmail via API — no catchall/SMTP/OAuth-project swamp, and the thread starts at the sender, not an alias. |
| Portal quote with Sign/Pay + status ribbon (Quotation→Sent→Sales Order) | ADAPT | Adopt the explicit state ribbon + one-click customer approval link; skip portal accounts — approval happens from the email thread. |
| Customer→Pricelist auto-applied + per-line margin display | ADOPT | This is the seed of our party-scoped configurator: open from sender → their price list loads, margin visible live. |
| BOM→MO explosion with component reservation (Check Availability) | ADAPT | Keep explode+reserve; our "BOM" is generated per configured one-off (leather, lining, armor) instead of authored per product. |
| Work centers + routing as configurable operations | ADAPT | One global pipeline CUTTING→STITCHING→ASSEMBLY→QC→PACKING (the stage list itself is Settings-editable); per-product configurable routings are generality we don't need. |
| Shop Floor operator UI (cards, step checklists, timers, tap-to-switch operator, Log Note on floor) | ADOPT | Best-in-class operator surface — and it's Enterprise-paid. We copy the card/checklist/timer pattern and ship it free on a tablet. |
| Product Configurator / variants for custom work | BEAT | Variants are combinatorial SKUs; made-to-measure quantity-one needs new-product+new-BOM each time (~5 forms). Our configurator composes options+price+margin in one screen scoped to the sender. |
| Carrier label purchase | BEAT | Enterprise connectors only; Community is manual. Direct carrier API with two clicks from the order is a wedge Odoo Community concedes. |
| Cross-app document chain via smart buttons (lead→quote→SO→MO→delivery) | ADAPT | Keep the linked chain, render it as ONE timeline on one screen instead of six apps with six kanbans. |
| Quality / PLM / MPS / OEE / IoT modules | IGNORE | Enterprise theater for a tiny factory; QC is one checklist stage in our fixed pipeline, not an app. |
| Barcode app | IGNORE | Paid, warehouse-scale; a leather factory with ~4 workers tracks lots per work order, not scan events. |
| Self-hosting stack (Postgres, workers, wkhtmltopdf) + OpenUpgrade migrations | BEAT | Our local-first SQLite single file with no forced yearly migration is materially simpler than Community's DIY ops burden. |

### Sources
- https://www.odoo.com/odoo-19-release-notes — v19 release
- https://ecosire.com/blog/latest-odoo-version and https://www.aspiresoftserv.com/blog/odoo-19-3-release-notes-new-features-upgrade-guide — version/timeline, 19.3
- https://www.odoo.com/pricing — EUR plan prices (July 2026)
- https://www.odoo.com/page/editions — Community vs Enterprise matrix
- https://ventor.tech/odoo/odoo-17-community-vs-enterprise/ — edition split detail (Quality/PLM/Barcode/Shop Floor/MPS/connectors)
- https://www.odoo.com/documentation/19.0/applications/productivity/discuss/chatter.html — chatter anatomy
- https://www.odoo.com/documentation/19.0/applications/essentials/activities.html — activities
- https://www.odoo.com/documentation/19.0/developer/reference/backend/mixins.html — mail.thread / mail.activity.mixin
- https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/manufacturing/basic_setup/bill_configuration.html — BOM config
- https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/manufacturing/basic_setup/one_step_manufacturing.html — MO click path
- https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/manufacturing/shop_floor/shop_floor_overview.html — Shop Floor UI
- https://www.odoo.com/documentation/19.0/applications/sales/sales/sales_quotations/create_quotations.html — quotation form/flow
- https://www.odoo.com/documentation/19.0/applications/sales/crm/acquire_leads/email_manual.html — email→lead aliases
- https://www.odoo.com/documentation/19.0/applications/general/email_communication/faq.html — email issues FAQ
- https://www.odoo.com/forum/help-1/why-is-there-no-product-configurator-in-odoo-17-community-version-250095 — configurator absent in Community (v17)
- https://github.com/OCA/OpenUpgrade and https://ocu.winotto.com/articles/how-to-upgrade-odoo-community — Community upgrade reality
- https://www.capterra.com/p/135618/Odoo/reviews/ and https://www.g2.com/products/odoo-odoo-erp/reviews — user complaints
- https://www.swell.is/content/odoo-pricing and https://www.erpresearch.com/pricing/odoo — total-cost commentary

---

## Katana Cloud — the SMB MRP UX bar: order-driven manufacturing with traffic-light stock math, priced like enterprise software

### Who it's for & pricing reality

Katana targets small/mid manufacturers selling D2C + wholesale (Shopify/QuickBooks crowd). Pricing was revamped again in **February 2026** into a usage-based model ([official pricing page](https://katanamrp.com/pricing/)):

- **Free** — up to 30 SKUs, unlimited users/locations/integrations.
- **Core** — **from $299/mo**: unlimited SKUs and users, **1 location included** (extra locations billed per use), and **per-delivered-sales-order usage fees** on top. 24/7 support.
- **Advantage** — custom annual contract (dedicated Solutions Engineer, SLA, custom automations).
- **Add-on modules**: Traceability **$249/mo**, Manufacturing Management **$199/mo** (multi-level BOM, scheduling, costing), Warehouse Management **$149/mo**, Shop Floor App reported at **~$199/mo** (third-party figure — unverified on official page; operator seats themselves are unlimited). Optional onboarding package **$2,000**.
- **Annual billing costs MORE**: a **15% "price lock premium"** to freeze usage rates — the inverse of normal SaaS discounts.

History matters: Katana has re-priced repeatedly (per-user → per-sales-order-line → GMV-based → current modular+usage), and review aggregators carry cumulative-increase complaints (one reports a "523% price increase" claim — unverified individual case) ([Brahmin Solutions breakdown](https://www.brahmin-solutions.com/blog/katana-pricing), [Software Advice](https://www.softwareadvice.com/manufacturing/katana-mrp-profile/)). A factory like ours would realistically need Core + Manufacturing + Shop Floor ≈ **$700/mo before usage fees** (Brahmin's scenarios land at $747–$1,145/mo). That is ~€8k+/yr of pure rent our local-first SQLite model does not pay.

### The screens that matter

**Sell screen** (orders + quotes, tabbed Open/Quotes/Delivered). Each SO row carries three status columns that do all the work: **Sales items availability** ("In stock / Expected / Not available"), **Ingredients** (same three words for the BOM materials), and **Production** (an action button, e.g. "Make to order", or the linked MO's status). Clicking "Not available" opens the exact list of missing materials. Status words *are* the UI — no numbers to interpret.

**Make screen → Schedule tab.** All manufacturing orders in a priority-ordered list with production status, ingredient status, and deadline. **Rows drag-and-drop to reprioritize**, and this is the signature move: availability is allocated strictly by priority order, so dragging an MO up **instantly re-reserves materials away from lower-priority orders** and every traffic light on both screens recalculates ([Ingredients availability](https://support.katanamrp.com/en/articles/5914374-ingredients-availability)). Make-to-order MO priority is bidirectionally synced with its SO. No "run MRP" button exists anywhere.

**MO card.** Product, quantity, deadline, plus two row sections: **Ingredients** (per-material required qty + availability status) and **Production operations** (operation → resource/workstation → cost/hr × time). A "+ Buy" action turns missing ingredients into a PO directly from the shortage.

**Stock screen.** Per-item columns: **In stock**, **Committed** (allocated to open SOs/MOs/OPOs), **Expected** (incoming from POs/MOs/OPOs), and **Calculated stock = In stock − Committed + Expected − Safety stock**. All movements are perpetual/automatic from buy/make/sell activity ([Stock basics](https://support.katanamrp.com/en/articles/5908776-basics-of-inventory-management)).

**Shop Floor App** (web-based, phone/tablet). Each operator logs in to a personal queue of tasks from open MOs, ordered by MO priority (optionally forced sequential). Big **Start / Pause / Resume / Quit / Finish** buttons drive an automatic timer; actual vs planned time flows into production cost. Task detail shows the ingredient list **color-coded green (in stock) / yellow (incoming) / red (unavailable)**, supports barcode scan, actual-quantity entry, batch numbers, and comments. Operators **cannot see costs or prices** ([SFA overview](https://support.katanamrp.com/en/articles/5967437-shop-floor-control-app-overview), [using the app](https://support.katanamrp.com/en/articles/5967424-using-the-shop-floor-control-app)).

### Click-path notes

- **Order → production**: create SO on Sell screen → click **"Make to order"** in the row → MO exists, permanently linked, numbered **SO-670/1**, priority synced. **One click** from order to work order — this is the bar to beat ([MTO workflow](https://support.katanamrp.com/en/articles/5908804-make-to-order-workflow-for-manufacturers)).
- **Shortage → PO**: click red "Not available" → see missing materials → **"+ Buy"** → pre-filled PO. Two–three clicks, no navigation away.
- **Reprioritize**: drag an MO row. Zero dialogs; allocation cascade is immediate.
- **Quote → cash**: + Create → + Quote → fill card (customer, deadline, line items with price-per-unit) → **Print icon → save PDF → email it yourself outside the app** → on customer yes, flip status Pending → Confirmed → it becomes an open SO (revert possible until shipped). Quotes don't commit stock; SOs do. **No in-app email, no options/configurator, and no cost or margin shown anywhere on the quote** ([creating a quote](https://support.katanamrp.com/en/articles/5914239-how-to-create-a-quote), [managing quotes](https://support.katanamrp.com/en/articles/5914243-how-to-manage-quotes)).
- **Costing**: per-operation **Cost = cost/hr × time**; product cost = avg material costs + operation costs; Shop Floor timers overwrite planned time with actuals ([operations costs](https://support.katanamrp.com/en/articles/5967098-entering-production-operations-costs)).
- **Outsourcing**: OPO = a PO for a product where you supply and track the ingredients; contractor fee entered as cost/hr with time=1; supports partially outsourced routing ([OPO guide](https://support.katanamrp.com/en/articles/11774430-outsourced-manufacturing-getting-started-guide)).

### What users complain about

- **Pricing punishes small operators**: "If your business sells a lot of small-ticket orders, you get punished with pricing far beyond the value you actually consume" ([Software Advice reviews](https://www.softwareadvice.com/manufacturing/katana-mrp-profile/)). "We've ridden along with several price hikes but at one point enough is enough" — Janet ([SoftwareConnect](https://softwareconnect.com/reviews/katana-mrp/), 3.5/5 across sampled reviews). Users cite mid-contract increases, feature-removal-unless-you-upgrade, and a review-reported **60-day cancellation notice** (unverified in ToS).
- **Support**: "You can only email but we are yet to get any of our issues resolved" ([SoftwareConnect](https://softwareconnect.com/reviews/katana-mrp/)).
- **Feature gaps**: no custom reports (export-only); G2 reviewers "couldn't find a way to create sales prices based on cost" — i.e., **no cost-plus pricing even though the system knows the cost** ([G2 reviews](https://www.g2.com/products/katana-cloud-inventory/reviews)); no native mobile app (responsive web only).
- **Churn destinations**: MRPeasy (~$59/user/mo), Qoblex, Craftybase — "roughly ¼ of the cost" ([Qoblex comparison](https://qoblex.com/blog/8-best-katana-mrp-alternatives-in-2026-ranked-compared/)).

### Verdicts

| Capability | Verdict | Why / how it maps to Factory OS |
|---|---|---|
| One-click SO→MO with shared number (SO-670/1) + bidirectional priority sync | ADOPT | Exactly our Order→Work Order explosion: same identity, one click, priority lives in one place. Zero training because order and production are never two disconnected records. |
| Status-words-as-UI (In stock / Expected / Not available) with click-through to missing materials | ADOPT | The core zero-training trick: three colored words per row, click reveals the why, the fix action ("+ Buy") sits in the same spot. Copy onto our Orders and Materials pages verbatim. |
| Drag-to-reprioritize with instant priority-ordered material reallocation | ADOPT | With ~dozens of open one-off orders this recomputes in microseconds in SQLite. Drag = allocation policy, no MRP run, no dialogs — the Owner already thinks in "this suit first". |
| Committed/Expected/Calculated stock math (perpetual, automatic) | ADAPT | Keep the four-column math; simplify to one location and add leather-specific units (hides/sqft, lot-level). One-off pieces reserve material at quote-acceptance, not via safety-stock heuristics. |
| Shop Floor App (personal queue, Start/Pause/Finish timer, ingredient traffic lights, no cost visibility) | ADAPT | Right concept for our 3–5 workers, but ours is a phone page per work-order stage (CUTTING→…→PACKING) sharing the order's comment thread, works on LAN, and is not a $199/mo add-on. Keep: big verb buttons, timers feeding actuals, cost-blind operator view. |
| Quote lifecycle semantics (quotes don't commit stock; Pending→Confirmed becomes SO; revertible) | ADAPT | Sound state machine — adopt the no-commit-until-confirmed rule, but our quote is born from a Gmail thread with configurator options and live margin, and "Confirmed" is triggered by the customer's email reply. |
| Quoting surface itself (hand-typed card, print/save PDF, no email, no cost/margin, no options) | BEAT | This is the gap our product exists in: Katana starts after the order is typed in. We auto-match the sender, open a party-scoped configurator, compose price with visible margin, and send from the same thread. |
| Operation-row costing (cost/hr × time; actuals from timers) | ADAPT | Perfect kernel, wrong moment: Katana prices the MO after it exists; we run the identical formula at quote time inside the configurator, and let stage timers feed back into smarter estimates for the next quote. |
| Outsourced POs (your materials at a contractor, partial routing) | ADAPT | Collapse to an "external step" flag on a work-order stage with materials-out/goods-back tracking. A separate PO subsystem is overkill; also we're usually the contractor in B2B deals (the reverse direction, which Katana doesn't model). |
| Auto-MOs for subassemblies (make-to-stock levels) | IGNORE | One-off made-to-measure pieces don't stock subassemblies; lining/armor prep is a stage of the same work order, not a nested MO tree. |
| Cloud usage pricing, add-on gating, 15% annual lock, $2k onboarding | BEAT | Their economics are our marketing: $700+/mo scenarios, per-delivered-order fees, and repeated repricing churn vs our $0-infra local SQLite where every "module" is just included. |
| Custom reporting (export-only) | BEAT | Local SQLite + import/export-first grids means any question is one query/CSV away; Katana users must buy Easy Insight or live with canned views. |

### Sources

- https://katanamrp.com/pricing/ — official Feb-2026 pricing (Free/Core $299/Advantage, add-on prices, 15% price-lock premium, $2,000 onboarding)
- https://support.katanamrp.com/en/articles/5908804-make-to-order-workflow-for-manufacturers — MTO flow, Sell-screen columns, SO-670/1 numbering
- https://support.katanamrp.com/en/articles/5914371-manufacturing-orders — MO types, SO↔MO priority sync
- https://support.katanamrp.com/en/articles/5914374-ingredients-availability — statuses, priority-ordered allocation, drag recalculation
- https://support.katanamrp.com/en/articles/5908776-basics-of-inventory-management — In stock/Committed/Expected/Calculated formula
- https://support.katanamrp.com/en/articles/5967437-shop-floor-control-app-overview and https://support.katanamrp.com/en/articles/5967424-using-the-shop-floor-control-app — operator queue, Start/Pause/Finish, green/yellow/red ingredients, cost-blind operators
- https://support.katanamrp.com/en/articles/5914239-how-to-create-a-quote and https://support.katanamrp.com/en/articles/5914243-how-to-manage-quotes — quote card fields, print/PDF-only sending, Pending→Confirmed
- https://support.katanamrp.com/en/articles/5967098-entering-production-operations-costs — cost/hr × time
- https://support.katanamrp.com/en/articles/11774430-outsourced-manufacturing-getting-started-guide — OPO workflows
- https://www.brahmin-solutions.com/blog/katana-pricing — add-on breakdown, pricing history, $747/$1,145 scenarios
- https://softwareconnect.com/reviews/katana-mrp/ — user quotes on hikes and support
- https://www.softwareadvice.com/manufacturing/katana-mrp-profile/ — small-ticket pricing complaints
- https://www.g2.com/products/katana-cloud-inventory/reviews — no cost-based sales pricing, no custom reports
- https://qoblex.com/blog/8-best-katana-mrp-alternatives-in-2026-ranked-compared/ — churn destinations

---

## MRPeasy — the cheapest "real MRP": full quote→MO→shop-floor chain, sold per seat, born in settings screens rather than in email

### Who it's for & pricing reality
MRPeasy targets 10–200-employee manufacturers who want genuine MRP (capacity, routings, lot traceability) without SAP B1 money. Current pricing (official site, July 2026, EUR; aggregators quote USD $49/$69/$99/$149): **Starter €39**, **Professional €59**, **Enterprise €79**, **Unlimited €125** per user/month; users 11+ are bundled at €69 per 10-user block; annual billing gives one month free; 15+15-day trial, no card. Aggregators report a 2-user minimum (unverified on the official page). Tier gating that bites a shop like ours: the **product configurator (Matrix BOM) is a "Professional function"**; **barcodes and backward scheduling are Enterprise**; **API/webhooks are Unlimited-only** (REST API v2 + MCP tools shipped in beta May 2026). Every shop-floor worker who reports operations is a billable seat — a 4-person leather factory needing the configurator lands at ~€236/month (4 × €59) before Enterprise features. Product is alive and actively shipped: AI sales forecasting (May 2026), operation subtask checklists (Apr 2026), kiosk workstation filters (Mar 2026), consolidated invoicing (Mar 2026), Google/Microsoft SSO (Feb 2026).

### The screens that matter
**Customer Order detail** is the sale's spine: a ten-status lifecycle (Quotation → Waiting for confirmation → Confirmed → Waiting for production → In production → Ready for shipment → Shipped → Delivered, plus Canceled/Archived). The first three flips are **manual**; later ones auto-advance from MO/shipment events. Product lines carry per-line fulfillment status (Expected on time / Delayed / Ready for shipment / Delivered) computed from linked MOs and POs. Action buttons: **"Estimate costs and dates"** (capable-to-promise: computes cost and lead time from BOM + routing + current stock + workstation load), **Book all**, **Create manufacturing order**, quotation PDF + send-by-email, and links to shipments/invoices/payments.

**Production Schedule** has a Calendar view (tabs: Manufacturing Orders / Operations) and a Gantt view (tabs: Manufacturing orders / Workstations). Bars encode two dimensions: backdrop color = progress (not started / in progress / paused / finished; red-striped = overdue), text color = parts availability. Drag-and-drop rescheduling with real constraints: started/finished operations can't move; Calendar view blocks workstation overbooking and auto-shifts subsequent operations of the same MO; Gantt view asks whether to allow overbooking and whether to drag subsequent operations along, and skips material checks. Crucially, **only the dragged MO moves — nothing else re-optimizes**.

**Manufacturing Order detail**: header (status New → Scheduled → In progress → Paused → Done → Closed), **Parts table** with a six-state color grammar (Not booked / Not enough / Requested / Delayed / Expected / Received) plus Book-all / Release-all, **Operations table** (assignee, timing, subtasks, view/edit), **costing panel showing estimated vs actual side by side** (materials, labor, applied overhead — estimates recalculate to actuals as workers report), target lot for the finished goods, and print actions (MO PDF, labels, materials requisition).

**Routing editor**: per operation — workstation *group* (scheduler picks the concrete station by availability), setup time, cycle time, capacity per cycle, fixed + variable overhead, time- vs piece-payment, default department/worker, sequence dependencies, overlap quantity. Duration = (setup + cycle × qty / capacity) / workstation productivity factor.

**Worker surfaces**: "My production plan" (fuller view — calendar of operations assigned to me/my department, color-coded, with material-consumption reporting) and the **Internet-kiosk** (simplified list sorted by planned start time — "start with the one at the top"). Three buttons per operation line: **Start / Pause / Finish**. Pause prompts "quantity completed since last start" (default 0); Finish prompts final quantity (default = order quantity). Materials auto-consume (backflush) after the first operation completes; subtask checkboxes stamp username + time automatically.

**Matrix BOM / product configurator**: define parameters (leather type, color, size…) and relations in stock settings; picking parameter values on a Customer Order line auto-compiles the correct BOM. For true one-offs the documented pattern is a generic base item — on MO creation the software offers "configure BOM and routing," or skip and enter parts by hand on the MO.

### Click-path notes
- **Quote a configured product**: CRM → Customer Orders → new CO → pick customer (manual; nothing reads email) → add line, pick parameter values → "Estimate costs and dates" → set the sales price yourself (system shows cost; markup is on you) → generate PDF → send → manually flip status twice (Waiting for confirmation, then Confirmed). ~8 interactions across 3–4 screens, all inside the ERP; the email thread with the customer lives elsewhere.
- **Order → production**: on the confirmed CO, "Create manufacturing order" → MO auto-schedules (forward; backward + buffer days on Enterprise) → Book all parts → watch the parts color row.
- **Shop floor**: worker opens kiosk → taps Start on the top line → Pause/Finish with quantity prompt. Two to three taps per operation state change; zero navigation.
- **Ship**: CO → Ready for shipment → create shipment + delivery note + invoice. Carrier labels are not native — ShipStation via integration; no review-request step exists anywhere.

### What users complain about
- **Learning curve / not intuitive at first**: "Quite a large learning curve with the user interface, I don't think it is very intuitive at the beginning" ([Capterra reviews](https://www.capterra.com/p/134177/MRPEasy/reviews/)); multiple G2 reviewers say non-MRP people need real ramp-up.
- **Rigidity**: "the software seems somewhat rigid"; limited customization "making certain configurations challenging without workarounds" ([G2 pros & cons](https://www.g2.com/products/mrpeasy/reviews?qs=pros-and-cons)).
- **Shop-floor feel and cost**: described as "a bit clunky and expensive" for shop-floor operations; per-seat fees "climb sharply as headcount grows" ([Craftybase comparison](https://craftybase.com/compare/katana-vs-mrpeasy)).
- **Support**: remote/self-serve model with mixed reports — praised as detailed, but "response time can be slow during peak hours" and some issues left unresolved ([Software Advice reviews](https://www.softwareadvice.com/manufacturing/mrpeasy-profile/reviews/)).

### Verdicts
| Capability | Verdict | Why / how it maps to Factory OS |
|---|---|---|
| Kiosk Start/Pause/Finish with quantity prompts | ADOPT | The shop-floor pattern for our Production page: per-worker queue sorted by start time, three big buttons, prompt-on-pause. Zero training by construction. |
| "My production plan" per-worker queue | ADOPT | Worker home screen = "your next operation is the top line." Skip their calendar variant; a list is enough for 3 workers. |
| Estimated vs actual cost per MO | ADOPT | The margin-truth loop a custom shop lives on: quote-estimated vs actual (leather consumed, hours reported) on every Work Order, delta surfaced to the Owner. |
| Parts six-state color grammar | ADOPT | Material readiness at a glance on Work Order cards (not booked → reserved → expected → received). Drives honest promise dates. |
| Operation subtask checklists (Apr 2026) | ADOPT | Per-stage checklists (QC especially) with auto user+timestamp — cheap auditability. |
| "Estimate costs and dates" CTP at quote time | ADAPT | Their best idea, wrong surface: a button on an ERP form. Ours runs continuously inside the configurator — price, margin, and feasible date recompute per option toggle. |
| Matrix BOM / configurator | ADAPT | Validates parameters→BOM composition. But theirs lives in stock settings, composes BOM only, and leaves price/markup manual. Ours: party-scoped price list composes price + margin + BOM together. |
| One CO object, quote→delivered statuses | ADAPT | Keep the single-spine idea; kill the manual flips. Our statuses advance from real events (quote emailed, approval clicked, label bought, delivery scanned). |
| Backward scheduling + buffer days | ADAPT | Steal the concept as "latest safe start" per Work Order from the promised date; warn when today passes it. No Enterprise-tier scheduler needed. |
| Per-op routing (fixed 5-stage) | ADAPT | Default CUTTING→STITCHING→ASSEMBLY→QC→PACKING pipeline (global stage list Settings-editable, never per-product) with optional per-stage duration estimates. Skip cycle/capacity/productivity math — quantity is one. |
| Backflush material consumption | ADAPT | Auto-consume defaults are right, but leather waste is the profit leak: prompt actual hide usage at CUTTING finish, diff vs estimate. |
| Stock lots + FEFO | ADAPT | Lots = hides/dye batches (color consistency, recall trace). Expiry/FEFO logic: skip. |
| Drag-and-drop Gantt + workstation views | BEAT | Even MRPeasy only moves one MO per drag — no re-optimization. For 5 people, a per-stage board + due-date-sorted list with drag-between-days beats bar charts of workstation lanes. |
| B2B customer portal | BEAT | A login portal for approving quotes is friction; our approval is a link in the same Gmail thread the quote went out on. |
| Email/CRM entry point | BEAT | MRPeasy starts at manual CO entry; Gmail only via Zapier. Our order is born from the email itself — sender-matched, thread-preserved. Their structural blind spot. |
| Workstation groups, capacity %, productivity factors | IGNORE | Capacity here is three pairs of skilled hands, not machine groups. Queue depth + WIP visibility answer the same question. |
| Multi-level BOM with per-subassembly MOs | IGNORE | One-off garments are flat BOMs; subassembly explosion is batch-manufacturer machinery. |
| MPS, approval workflows, multi-site, maintenance (MMS) | IGNORE | Enterprise theater at this scale — one site, Owner approves everything by being in the room. |

### Sources
- [MRPeasy pricing](https://www.mrpeasy.com/pricing/)
- [Production Schedule — user manual](https://www.mrpeasy.com/resources/user-manual/production-planning/production-schedule/)
- [Routings — user manual](https://www.mrpeasy.com/resources/user-manual/stock/items/details/routings/)
- [Customer Orders — user manual](https://www.mrpeasy.com/resources/user-manual/crm/customer-orders/)
- [Manufacturing Order details — user manual](https://www.mrpeasy.com/resources/user-manual/production-planning/manufacturing-orders/details/)
- [Internet-kiosk — user manual](https://www.mrpeasy.com/resources/user-manual/reporting/internet-kiosk/)
- [My production plan — user manual](https://www.mrpeasy.com/resources/user-manual/reporting/my-production-plan/)
- [Matrix BOM / product configurator — user manual](https://www.mrpeasy.com/resources/user-manual/settings/system/professional-functions/matrix-bom/)
- [Stock lots — user manual](https://www.mrpeasy.com/resources/user-manual/stock/lots/)
- [Changelog](https://www.mrpeasy.com/changelog/)
- [G2 reviews — pros & cons](https://www.g2.com/products/mrpeasy/reviews?qs=pros-and-cons)
- [Capterra reviews](https://www.capterra.com/p/134177/MRPEasy/reviews/)
- [Software Advice reviews](https://www.softwareadvice.com/manufacturing/mrpeasy-profile/reviews/)
- [Craftybase: Katana vs MRPeasy](https://craftybase.com/compare/katana-vs-mrpeasy)
- [Zapier MRPeasy integrations](https://zapier.com/apps/mrpeasy/integrations)

---

## Fulcrum — quote-to-floor manufacturing OS where live cost breakdowns, an autoscheduler promise date, and shop-floor actuals form one closed loop

### Who it's for & pricing reality

Small/mid US job shops and made-to-order manufacturers (CNC, sheet metal, fabrication, some aerospace/automotive); it markets itself as replacing ERP/MRP/MES/QMS in one SaaS. 93% of reviewers are small companies. Pricing is **shop-revenue-based with unlimited users**, never per-seat. Reported tiers for shops under $3M revenue (softwareconnect, 2025): Base $6,000/yr + $5,000 one-time launch fee; Core $12,000/yr + $5,400; Pro $18,000/yr + $8,100 — scaling with revenue and integration complexity; commonly summarized as "starts ~$800/mo." No public price page; a sales call is required.

Implementation is in-house ("Fulcrum Launch"): fixed one-time fee, "no billable hours," a dedicated Launch Manager, phases of align → migrate/validate core data → "day-in-the-life" pressure-testing → launch, then a permanent Account Manager. Reviewers confirm the dedicated specialists are real and good — and that the long pole is *your data* (BOM cleanup), not the software.

### The screens that matter

**Quote screen.** A Quotes Grid filterable by status (Draft/Open/Sent…). Each line is an item — new, existing, or "a copy of an existing item" — with per-line attachments and stored price breaks. The signature move: **BOM and routing are editable directly on the quote**, and edits are "specific to this item on this quote" (master data stays clean). The **cost breakdown recomputes live** from labor + material + machine details as you adjust, and negative margins are auto-flagged. Sheet-metal-specific: upload a DXF on the quote and Fulcrum "generate[s] a nest and automatically update[s] material and machine time cost estimates without leaving Fulcrum"; an AI importer builds BOMs from PDFs, CSVs, images, or SolidWorks pack-and-go. Promise date: a **Calculate button** runs capable-to-promise against "all of my existing schedule and all of my existing jobs," honoring the priority set on the quote. Sending: PDF preview, then "email that directly from Fulcrum using our email template process"; a successful send **auto-moves the quote from Draft/Approved to Sent**. There is a quote approval workflow and an audit log keeping "a time-stamped record of each quote revision and approval" (AS9100 page). Dedicated win/loss-reason analytics or win-rate dashboards: **not publicly documented (unverified)** — the visible lifecycle is status-based (won quotes convert; no public lost-reason reporting).

**Autoschedule.** Continuous, not batch: "the schedule will update in real-time from the job tracker… as new jobs come in or as job priorities change." Inputs: shift days/times, equipment capabilities, job equipment specs, material availability, order of operations, operation time estimates. It "pull[s] apart the dependency string of all your operations, balancing priority levels, due dates, and capacity constraints," claiming thousands of jobs / tens of thousands of operations recomputed in minutes. UI: **one column per piece of equipment, one card per operation** (runtime, due date, priority). Manual control is fenced: drag-and-drop "within the next 48 hours," everything beyond stays algorithmic. Backlog is viewable by department or equipment. When the floor gets busy, quotes inherit reality automatically because capable-to-promise reads the same live schedule; bumping a quote/job priority visibly reorders the queue on refresh.

**Quote→job conversion.** Move a won quote to a status → a Sales Order auto-generates; approve the SO → "it automatically creates a Job." Quote ↔ SO ↔ Job are chained in an **Associated Records** tab; BOM, routing, files, and the cost/margin picture flow through ("sales data starts at the quote with margin and cost details that flow to the sales order"). The traveler is not paper: **the job page is the traveler** — operations with estimate-vs-actual per operation, materials to pick, drawings, notes, quality checkpoints, live job costing.

**Job Tracker (shop floor).** Tablet/terminal per operator: "a queue of every job in the entire shop," filterable by work center, with priority flags. Operator taps play; the screen shows "the actual versus the estimate of 30 minutes." Drawings render on the tablet; team notes surface in context (demo: "this is a new lot, so something could be wrong with the material"). Picking a material is "automatically depleting the inventory from the rest of Fulcrum." Scrap is quantity + reason, and a notification is "automatically going to send to the production manager." Quality = custom in-process checkpoints with tolerance ranges; out-of-tolerance entries are flagged and stored on the job. Auto-captured: machine/setup/labor time, scrap + reason, picks, checkpoint values, notes.

**Customer communication.** Outbound only: quotes/SOs/invoices go out as emailed PDFs from inside Fulcrum. A Customer Portal (shipped 2023) shows live order/invoice status, ship-by dates, totals, line items; access is granted per customer and per order, login via a "basic link." **No public evidence of inbound email capture, Gmail/Outlook thread integration, shared inbox, or email→RFQ parsing — email is an endpoint, not an origin.** Shipping/labels run through integrations (ShipStation and ~100 others), not native label purchase.

### Click-path notes

Observed in official video walkthroughs:

- **Quote:** open quote → add line (existing item with price breaks, or copy) → adjust BOM/routing inline (quote-scoped) → cost breakdown updates live → set priority → Calculate → completion date returned from the live schedule → preview PDF → email from Fulcrum → status flips to Sent.
- **Convert:** change quote status → SO auto-created → approve SO → Job exists; hop between them via Associated Records.
- **Floor:** tablet → filter queue by work center → open job → play (setup, then run) → pick material (inventory decrements shop-wide) → "scrap one, select that it was a defect due to the new lot" → checkpoint measurement ("it's flagged, and it's out of tolerance") → complete; manager auto-notified; costing shows actual vs estimate.

### What users complain about

- **Performance:** "system can be slow at times when a lot of data is moving"; "95% of the time it's great but the 5% is frustrating"; data-entry lag before updates appear.
- **Reporting:** "probably the most difficult thing early on"; built-in reports lack advanced filtering/customization.
- **Rigidity:** "some workflows feel overly rigid," extra clicks.
- **Release quality:** one Practical Machinist shop abandoned setup midway citing instability and lost confidence; a reviewer: "constant stream of new features can feel a bit overwhelming."
- **Costing needs a human clocking in/out** — actuals are hard to capture for unattended machines.
- **Implementation is data-bound:** BOM cleanup dominates; "significant learning curve"; one aerospace reviewer rated value 3/5 — "not a cheap investment."
- Caveat: the widely-quoted "minimum 5 paid users / price hikes" complaint belongs to Fulcrum the *field-data app* (fulcrumapp.com, different company) — excluded here.
- Counterweight praise: support rated 5.0/5 across sites; "scheduling… three hours daily, down to just 20-30 minutes"; onboarding specialists; unlimited users.

### Verdicts

| Capability | Verdict | Why / how it maps to Factory OS |
|---|---|---|
| Live cost breakdown + negative-margin flag on quote | ADOPT | Exactly our thesis: price composes live (leather/lining/armor/labor) with margin visible; flag below-floor margin per line. |
| Quote-scoped BOM/routing edits per line | ADAPT | Our configurator options ARE the BOM deltas; keep "copy an existing item and tweak" for repeat one-offs, skip freehand routing edits. |
| Capable-to-promise Calculate button at quote time | ADAPT | Copy the one-click promise date; power it with a coarse station-hours + queue-depth model, not a constraint solver — same customer value at SQLite scale. |
| Continuous autoscheduler, one column per machine, 48h drag fence | BEAT | We have 5 stations (CUT→STITCH→ASSEMBLY→QC→PACK), not 50 machines: a daily plan board with WIP limits and drag beats an opaque optimizer. Steal only the fence: human owns the next 48h, algorithm owns the rest. |
| Quote→SO→Job auto-chain with Associated Records | ADOPT | One click, zero retyping, bidirectional links — our quote→Order→Work Order explosion; add hard hide/lot reservation at explosion time (they only check availability). |
| Digital traveler (job page = ops + materials + files + checkpoints) | ADOPT | Same anatomy; ours adds customer-visible options (size, branding) per one-off piece. |
| Tablet play/stop with live actual-vs-estimate | ADAPT | One shared tablet per station, tap start/done only; artisans are not data clerks. Keep actual-vs-estimate visible to the owner, not the operator. |
| Material pick → live inventory decrement | ADOPT | Leather is the cost center; every pick tied to a hide lot (GPSR recall + defect clustering). |
| Numeric tolerance checkpoints (SPC-style) | ADAPT | Apparel QC is visual/binary: photo-attached pass/fail for stitch density, edge paint, fit — not micrometer tolerances. |
| Scrap qty + reason → auto-notify manager | ADOPT | Nearly free; leather defects cluster by lot, so reason+lot is the whole diagnosis. |
| DXF upload → auto-nest → estimate update | IGNORE | Sheet-metal theater for a leather shop; hides are irregular and graded by hand. Per-size/option consumption factors learned from actuals give the same estimate accuracy. |
| Customer Portal (per-customer login) | ADAPT | No accounts: a tokenized read-only status link auto-dropped into the same Gmail thread. Same transparency, zero login friction. |
| Email as send-only endpoint (templates, auto Sent-flip, audit log) | BEAT | Their email is an exit; our Gmail thread is the ORIGIN: sender→Brand/Customer match→pre-scoped configurator→quote lands back in-thread. Keep their auto status-flip on send and the time-stamped revision/approval audit log. |
| Floor actuals feed job costing (est vs actual per op) | ADOPT | The moat: rolling per-option/per-size actuals silently reprice the next quote. |
| Win/loss tracking | ADAPT | Their version is status-only publicly (unverified beyond that); we add a one-tap lost-reason on decline since the quote already lives in a thread. |
| Revenue-based pricing, unlimited users, fixed-fee in-house launch | IGNORE | Not a product surface — but the lesson stands: per-seat pricing is poison in factories, and their $5,000–8,100 launch fee plus data-prep grind is precisely the wedge for a zero-setup, $0-infra local tool. |

### Sources

- https://fulcrumpro.com/manufacturing-software/quoting-software-for-manufacturing
- https://fulcrumpro.com/article/mastering-manufacturing-sales-with-fulcrum-a-video-walkthrough
- https://fulcrumpro.com/manufacturing-software/production-scheduling
- https://fulcrumpro.com/article/maximize-on-time-delivery-with-fulcrums-advanced-autoschedule-a-video-overview
- https://fulcrumpro.com/manufacturing-software/production-tracking-and-job-costing
- https://fulcrumpro.com/manufacturing-software/job-tracking
- https://fulcrumpro.com/article/job-tracking-in-fulcrum-the-interface-for-the-shop-floor
- https://fulcrumpro.com/article/fulcrum-for-fabricators-workflows-for-custom-sheet-metal-shops
- https://fulcrumpro.com/article/leveraging-fulcrum-for-better-customer-communication-and-engagement
- https://fulcrumpro.com/product-update/customer-portal and https://fulcrumpro.com/article/manufacturing-customer-portal
- https://fulcrumpro.com/product-update/quote-uploads
- https://fulcrumpro.com/erp-implementation
- https://fulcrumpro.com/resources/as9100-requirements
- https://softwareconnect.com/reviews/fulcrum-pro/ (pricing tiers)
- https://www.softwareadvice.com/product/328655-Fulcrum-Pro/ (15 reviews, pros/cons)
- https://www.practicalmachinist.com/forum/threads/how-is-fulcrum-pro-erp.432690/ (direct fetch blocked 403; content via search snippets)
- https://www.g2.com/products/fulcrum-fulcrum/reviews

Gated/unverified: Fulcrum's help-center docs are not publicly indexed in depth; email-template configuration details, per-line revision UI, and any win/loss dashboards are unverified above and marked as such.

---

## ApparelMagic — small-brand fashion ERP bundling matrix inventory, light PLM and order-driven manufacturing

### Who it's for & pricing reality
Indie-to-mid fashion brands and small factories. Official pricing (verified July 2026, apparelmagic.com/pricing): **Professional $255/mo annual ($305 monthly)** — 3 users / 3 integrations / 3 warehouses, includes PLM + manufacturing; **Enterprise $495/mo ($595)** — 5 users, custom fields/triggers, audit logs, open API; **Ultimate** custom, 10+ users. Sales-rep seats $40–50/mo extra; unlimited styles/orders on all tiers; 30-day money-back. Cheapest of the three, still ~$3–7k/yr against our $0-infra constraint.

### The screens that matter
- **Style master with dimensions, not SKUs**: a style carries color/size axes; every transaction screen (sales order, PO, transfer) opens a **color×size matrix grid** where "all lines of a given style/fit combination" are keyed at once, with live inventory shown per cell. Line sheets reuse the same matrix for B2B order capture.
- **Tech pack from the style record**: one-click tech pack assembling images, specs and BOM; construction call-outs, measurements, material placement; every version archived as a PDF from concept to approval.
- **Manufacturing**: BOM + named labor steps per style. "Order Driven Project" tags demand lines and explodes them into work orders/POs; vendor contracts print with pull sheets and special instructions; **automatic cost actualization** (estimate vs actual); WIP filterable by project/style/vendor/date; raw materials issued and returned are tracked.
- **Vendor portal**: vendors open tech packs and PO files, and create shipments themselves. Document linking shows certification status and "instant images of the certificates" on records — attachments, not a structured registry.

### Click-path notes
- Order entry: New Order → customer (price level auto-applies) → add style → key quantities in the matrix → save. One grid replaces N variant rows; ~3 screens intent→done.
- Demand → production: Production > Manufacturing > Order Driven Project → tag order lines → BOM + steps explode into WOs/POs ("in seconds", their claim), vendor docs auto-sent. Two screens from order to work orders.
- Tech pack: style page → generate → versioned PDF → email to vendor from the same record.

### What users complain about
Capterra/Software Advice/G2 aggregates: "steep learning curve… about a month before understanding everything"; UI "could use some more polish"; price "very high" for 2–3-person teams; weak barcode scanning; "inability to combine or merge orders"; imperfect Xero sync; limited customization. Support responsiveness is consistently praised.

### Verdicts
| Capability | Verdict | Why / how it maps to Factory OS |
|---|---|---|
| Color×size matrix in order/PO lines with per-cell stock | ADOPT | The one apparel construct with no substitute. Style+dimension model in SQLite; materialize SKUs only for channel export. B2B brand orders arrive as size runs even in a custom shop. |
| Order-driven BOM+steps explosion into work orders | ADOPT | Exactly our Order → Work Order moment; keep steps fixed to CUTTING→STITCHING→ASSEMBLY→QC→PACKING instead of freeform routing. |
| Cost actualization (estimated vs actual per project) | ADOPT | Cheap to store actual material draw + hours against the quoted composition; closes the margin loop per one-off piece. |
| One-click tech pack w/ PDF version history | ADAPT | We don't author tech packs — the configurator's chosen options (leather, lining, armor, measurements) ARE the spec; render a tech-pack-lite PDF per order, version it on revision. |
| Per-style costing sheet (BOM+labor→margin at item level) | ADAPT | Their costing is static per style; ours composes live per order from option deltas with margin visible at quote time — the costing sheet becomes the pricing model. |
| Vendor portal / B2B storefront / multi-warehouse | IGNORE | No vendor network, one workshop, orders born in Gmail. Email + PDF suffices for the rare contractor. |

### Sources
- https://apparelmagic.com/pricing/
- https://apparelmagic.com/plm-software/ and https://apparelmagic.com/plm-software/manufacturing-production/
- https://apparelmagic.com/plm-software/vendor-access/
- https://apparelmagic.com/blog/how-apparelmagic-simplifies-the-challenging-process-of-vendor-management/
- https://www.capterra.com/p/15153/ApparelMagic/reviews/ ; https://softwareconnect.com/reviews/apparelmagic/

## WFX (World Fashion Exchange) — cloud PLM + ERP + Smart Factory MES for export-scale garment manufacturers

### Who it's for & pricing reality
Brands and 100–500+-operator factories across 50+ countries (600+ businesses claimed). Per-user/month subscription, **quote-only; no public prices** (unverified); third-party guides describe multi-month, consultant-led implementations and call it "over-specified and over-priced for CMT factories" below ~100 operators. Three separable products: PLM, Cloud ERP, Smart Factory (MES).

### The screens that matter
- **PLM tech packs**: custom templates with pre-determined fields per product type; measurement sheets; approval checkpoints captured at **fit, lab dips, testing, sales samples, production**; "WFX AI Techpack" converts static PDF tech packs into structured ERP-ready data (claims 70% processing-time cut). QC app arms inspectors with iPads — photos, defect capture, digital signatures, electronic inspection reports.
- **ERP production**: "Set rules to automatically route materials and production processes" (**route rules**); work orders flagged internal vs outsourced per production lifecycle; subcontracted orders and fulfillments managed in-system; **Material Requests generated from work-order quantity**, plus supplementary MRs on production loss; WIP material value; "track your daily and hourly production at line and process level"; unlimited process steps.
- **Smart Factory**: Excel lay-plan upload → numbering/bundling reports and bundle/box stickers "with a single click"; cut-plan optimizer (shrinkage/shade/width grouping, roll planning); barcode/QR scans at workstations; live TV dashboards by the line; operator-operation performance, bundle time, SAH, bottleneck heat maps.
- **Vendor compliance** module: define compliance criteria, schedule digital audits, tier-2/tier-3 supplier visibility, vendor blacklisting. No certificate-expiry or test-report registry described.

### Click-path notes
Order→floor spans three apps: ERP order → work order (+route rule decides outsource) → Smart Factory lay plan upload → print bundle stickers → operators scan each bundle per operation → TV dashboard. Powerful at 300 operators; at 4 people it's five surfaces and a scanner where a Kanban card would do.

### What users complain about
G2/Capterra: "Slow speed, constant bugs, poor performance plague heavy user"; "functionality, speed and features leave a lot to be desired"; "good option as a spec software if on a budget, but be prepared for frustrating experiences if heavy user"; hard "to manage data outputs to other systems". Support team responsiveness gets praise.

### Verdicts
| Capability | Verdict | Why / how it maps to Factory OS |
|---|---|---|
| Route rules (auto internal-vs-outsource per process) | ADAPT | Keep the concept, kill the rule engine: a per-stage "done by: in-house / contractor X" toggle on the work order, with a cost line and expected-return date. |
| Approval checkpoints (fit/testing/sample) w/ photo evidence | ADAPT | Fold into our QC stage: per-order checklist + photo + sign-off comment; for made-to-measure, a fit-check gate before PACKING. |
| Material Requests derived from work-order quantity | ADAPT | Our material reservation at Work Order creation is the same idea; add a "extra material request" event for cutting loss on hides. |
| AI Techpack (PDF → structured data) | ADAPT | Redirect the trick at our front door: parse inbound Gmail bodies/attachments into configurator pre-fills — the email is our tech pack. |
| Hourly line/process tracking, SAH, operator efficiency, TV boards | IGNORE | Industrial-engineering theater for a 3–6-person craft shop; stage timestamps on the work-order Kanban give the Owner the same answer free. |
| Cut-plan optimization (shade/shrinkage/roll planning) | IGNORE | Built for fabric rolls; leather is cut hide-by-hide around scars — optimization lives in the cutter's hands, not roll math. |

### Sources
- https://www.worldfashionexchange.com/apparel-erp-software/production.html
- https://www.worldfashionexchange.com/smart-factory.html
- https://www.worldfashionexchange.com/fashion-plm-software/vendor-compliance-software.html
- https://www.worldfashionexchange.com/blog/wfx-ai-techpack-automation/
- https://www.g2.com/products/wfx-plm/reviews ; https://scanerp.pro/blog/wfx-alternative-scan-erp-comparison.html

## BlueCherry (CGS) — enterprise fashion supply-chain suite whose Shop Floor Control tracks every unit per operator

### Who it's for & pricing reality
Mid-to-large apparel brands/manufacturers; modular ERP+PLM+EDI+MES, cloud or hybrid. Quote-only; per-user/month subscription, with third-party analyses citing **~$50,000 upfront starting cost** (directional, unverified); every source agrees it is consultant-led enterprise licensing. Explicitly out of our price universe — studied for constructs only.

### The screens that matter
- **Shop Floor Control (SFC)**: "tracks every unit as it moves through production, by operator, operation, line, and order." Workers scan **work tags on rugged industrial tablets**, see pacing tools and job instructions; the system runs **incentive/piece-rate pay automation** with HR/payroll integration and labor-law compliance reporting; management gets real-time KPIs, WIP and milestone dashboards (claims: 10–37% productivity gains, up to 45% fewer inline defects).
- **ERP**: "native support for two-dimensional size and color management" — style/color/size matrices in grid order entry and inventory analysis; claims up to 60% less manual SKU management.
- **Quality & compliance**: Quality Audit Management centralizes inspections, tracks non-conformances, "automated testing and reporting"; compliance tools "manage CPSIA, GCC and other compliance documentation, including factory audits"; vendor portal for compliance-document submission; ESG chain-of-custody material traceability. Closest of the three to first-class compliance docs — but organized around US consumer-product law and social audits, **not per-garment CE/PPE certificates**.

### Click-path notes
Operator flow: scan work tag at each operation → unit advances → payroll accrues; supervisor watches line dashboard. Admin flow is the complaint magnet: "too many steps to get to desired output." Getting live requires data migration, EDI setup and consultants — the anti-pattern of our install-and-run SQLite app.

### What users complain about
G2/Software Advice/Capterra: "extremely clunky and not very flexible"; "poor user interface and too many steps"; "the CSC product has been YEARS in trying to implement"; "every enhancement requires a consultant, takes thousands of dollars"; add-ons "feel like they have not been well tested"; support "not very easily accessible and too expensive."

### Verdicts
| Capability | Verdict | Why / how it maps to Factory OS |
|---|---|---|
| Unit-level genealogy (who did which operation on which piece) | ADAPT | Keep the answer, drop the apparatus: per-stage assignee + timestamps + comments on the work order gives full genealogy for qty-1 garments with zero scanners. |
| Piece-rate incentive payroll from scans | IGNORE | Pay machinery for hundreds of operators; irrelevant to a salaried 4-person workshop. |
| Compliance documentation module (CPSIA/GCC docs, audits, testing) | BEAT | None of the three models EU PPE 2016/425. We make certificates first-class: a cert registry (EN 17092 class AAA–C, cert number, notified body, expiry, covered styles/sizes) linked to styles; QC stage blocks PACKING if the garment's class cert is missing/expired; DoC + label data auto-attach to the shipment email. That's a true differentiator for a CE-classed moto-gear factory. |
| Native 2-D size/color item structure | ADOPT | Confirms the industry-wide pattern (same as ApparelMagic): dimensioned styles, never exploded SKU lists, grids everywhere quantities appear. |
| EDI / omnichannel & category planning / line calendars | IGNORE | Retail-compliance and fashion-season theater; our orders are born in Gmail threads, one at a time. |

### Sources
- https://bluecherry.com/en/solutions/manufacturing-execution-systems/shop-floor-control
- https://www.cgsinc.com/en/resources/bluecherry-shop-floor-control-real-time
- https://bluecherry.com/en/solutions/quality-audit-management ; https://bluecherry.com/en/blog/key-capabilities-every-fashion-erp-should-include
- https://www.softwareadvice.com/scm/bluecherry-profile/ ; https://www.g2.com/products/bluecherry-suite/reviews ; https://www.erpfocus.com/bluecherry-erp-software-342.html

## Cross-vertical synthesis — what a custom leather moto shop actually needs

Four apparel constructs earn their keep: (1) **dimensioned styles + matrix grids** (ADOPT — universal, and the only sane way to take a brand's size-run PO); (2) **order→BOM+stages explosion with material reservation** (ADOPT — ApparelMagic proves it can be two screens); (3) **costing that knows materials+labor+overhead+margin** (ADAPT — but moved to quote time inside the configurator, not a post-hoc sheet); (4) **tech-pack-lite** (ADAPT — auto-rendered from configurator choices + measurements, versioned per revision). The whole PLM calendar/line-planning/sampling-season layer, hourly SFC telemetry and piece-rate payroll are fashion-brand theater at our scale. The open flank all three leave: **CE/PPE certificate management as a first-class object** — BEAT territory Factory OS should own.

---

## Tailornova — browser CAD turning 15 body measurements into made-to-measure patterns

### Who it's for & pricing reality
Solo designers/small ateliers. Tracker-reported: Personal ~$29/mo, Commercial ~$39–49/mo (Capterra/SaaSworthy, 2026; exact tiers behind signup — unverified). Pattern CAD only: no orders, quotes, or customers.

### The screens that matter
Enter ~15 measurements → a 3D "FitModel"; designs simulate on that body and export PDF/DXF patterns. Users save **multiple named FitModels** and re-draft any design against any saved body without re-entering measurements.

### Click-path notes
One measurement form → persistent named profile → reusable across all designs. Pattern export is one action.

### What users complain about
Sparse reviews; limited garment types, nothing for leather/armored technical apparel.

### Verdicts
| Capability | Verdict | Why / mapping to Factory OS |
|---|---|---|
| Named, reusable measurement sets decoupled from any order | ADOPT | Exactly our `Party → MeasurementProfile(name, garmentType, 15–25 fields)` referenced by many orders |
| Auto-generated patterns | IGNORE | Our cutters work from existing patterns; CAD is a different business |

### Sources
- https://tailornova.com/technology , https://www.capterra.com/p/179815/Tailornova/ , https://www.saasworthy.com/product/tailornova/pricing

## Trinity Apparel (+ tailor-shop CRMs) — the measurement-profile gold standard, hiding in wholesale MTM dealer software

### Who it's for & pricing reality
Trinity is a US wholesale MTM suit maker; CloudCloset/WorkFlow tooling comes with the dealer relationship, not licensable standalone. Retail-side: Orderry, TailorPad, ThreadNix, Atelierware — small-shop CRMs for tailor/alteration shops. **The bespoke-factory software space is thin**: pattern CAD + alteration CRMs + wholesale dealer portals; nothing public owns email→quote→production for one-off leather. That gap is our product.

### The screens that matter
Trinity's client record stores **body AND garment measurements plus posture, shoulder position, fit observations** — numbers alone don't fit a real body. CloudCloset shows a visual order history per client; "custom models" preset recommended design details so order entry starts pre-filled. ThreadNix adds measurement **history** and **client photos**; Orderry adds order stages and e-signature quote approval.

### Click-path notes
Trinity repeat order: find client → prior order → reuse profile + model defaults ("repeat business in a few clicks"). Orderry: send quote → client e-signs remotely → order activates.

### What users complain about
Tailor CRMs read as generic ("a CRM with a measurements field"), weak on production stages; Trinity is dealer-locked. No public complaint corpus (help-center only — thin evidence).

### Verdicts
| Capability | Verdict | Why / mapping to Factory OS |
|---|---|---|
| Profile = named set + fit notes (posture/asymmetry) + photos + history | ADOPT | MeasurementProfile needs freeform fit notes, photo attachments, append-only versions |
| Per-dealer "custom models" presetting defaults | ADAPT | Becomes per-Brand/Customer configurator defaults + price list — matches email→party→pre-scoped configurator |
| Visual order history per client | ADAPT | One Party-page panel: past garments, fit outcomes, reviews |
| Measurements as CRM custom fields | BEAT | First-class typed measurement schema per garment type, not a notes blob |

### Sources
- https://trinity-apparel.com/tech , http://help.trinity-apparel.com/en/articles/2744550-fitting-guide
- https://orderry.com/tailor-shop-software/ , https://threadnix.com/

## Kickflip — SMB visual configurator whose bolt-on CPQ proves our quote thesis

### Who it's for & pricing reality
Shopify/WooCommerce DTC. $59/mo + transaction fee 1.95% sliding to 0% with volume; white-label +$49/mo; **quote requests +$99/mo**; unlimited products (gokickflip.com/pricing, July 2026).

### The screens that matter
Buyer: option groups in a side rail, layered 2D preview from multiple perspectives, per-option price deltas, live total. Admin: option editor with prices, **natural-language logic rules** ("When helmet material is red then helmet strap should not be red") that hide options and enforce valid combos, pricing equations with variables. CPQ: configure → "request a quote" replaces checkout → branded quote auto-generated with selections + breakdown + quote ID → merchant reviews/adjusts → converts to store order.

### Click-path notes
Buyer: one screen, live price throughout; quote request adds one modal. Merchant quote→order conversion is a short admin flow (exact steps undocumented).

### What users complain about
"Not viable unless your store is earning upwards of $10,000 per month" (Shopify reviews, on pricing changes); text editing "requires workarounds". 4.6/5 across ~134 Shopify reviews.

### Verdicts
| Capability | Verdict | Why / mapping to Factory OS |
|---|---|---|
| Natural-language conditional rules | ADAPT | We need ~20 rules (e.g. "kangaroo leather ⇒ no heavy perforation"): tiny when/then JSON DSL rendered as sentences; no no-code builder |
| Option-delta live pricing + equations | ADAPT | price = base + Σ deltas + size surcharge; but show **cost and margin** beside price — no configurator SaaS shows merchant margin live |
| CPQ request-a-quote from a configuration | ADAPT | Their quote is a checkout bolt-on; ours is the spine — born in the Gmail thread, versioned, becomes the Order |
| Layered 2D multi-view preview | ADAPT | Per-panel tinted PNG layers suffice; skip real-time 3D |
| Transaction-fee pricing | BEAT | $0 local SQLite; no per-sale tax on high-value low-volume pieces |

### Sources
- https://gokickflip.com/pricing , https://gokickflip.com/features/logic , https://gokickflip.com/features/configure-price-quote , https://apps.shopify.com/mycustomizer-1/reviews

## Zakeke — customizer suite with clean conditional-option "links", taxed by caps and fees

### Who it's for & pricing reality
Print/personalization merchants. Tracker-reported (official pricing behind login — unverified): Starter ~$68/mo → Scale ~$340/mo, **published-product caps 5/25/50**, 1.5–1.9% transaction fees on upper tiers, +$4.90/mo per extra seat, 3D/AR paid add-on, branding on low tiers.

### The screens that matter
Back-office "links": rules disabling an attribute/option when another option is selected — a clean disable-matrix. Pricing Rules price by conditions (number of colors, text length, design size). The 3D configurator re-queries price and stock from the host page on **every configuration change**.

### Click-path notes
Merchant: attributes → options → links → pricing rules → publish (multi-screen; learning curve is the top complaint). Buyer: one configurator screen, live price.

### What users complain about
"Steep learning curve"; "slow front-end performance and occasional platform instability"; slow support on lower tiers; "expensive" for small shops (G2/Capterra 2026).

### Verdicts
| Capability | Verdict | Why / mapping to Factory OS |
|---|---|---|
| Attribute/option disable-links | ADAPT | Same semantics as Kickflip rules; keep ONE rule mechanism |
| Re-price on every change | ADOPT | Recompute price+margin client-side per click from the party's price list — instant, offline-friendly |
| Product caps + per-seat + transaction fees | BEAT | Absurd for one factory configurator and three staff; $0 infra, unlimited everything |

### Sources
- https://zakeke.zendesk.com/hc/en-us/articles/360015984779-How-to-create-pricing-rules , https://docs.zakeke.com/docs/End-user-UI/3D-Configurator-Library-Documentation/Learn/price
- https://fibbl.com/zakeke-pricing/ , https://www.g2.com/products/zakeke/reviews

## Threekit — enterprise photoreal 3D; everything we should not build

### Who it's for & pricing reality
Enterprise manufacturers; unpublished custom pricing, reportedly ~$500/mo entry and $30k–100k/yr contracts plus render credits and per-SKU asset fees (CPQ3D/configurator.tech, 2026 — unverified).

### The screens that matter / click-path notes
Photoreal 3D/AR configurator, "virtual photographer". Geometry never changes — pre-modeled assets remix; every variant needs professional Maya/3ds-Max modeling; onboarding runs months; analytics are CSV exports.

### What users complain about
"Custom dimensions between predefined options cannot be generated"; costs "accumulate quickly with asset creation"; standalone CPQ "underpowered without Salesforce" (configurator.tech).

### Verdicts
| Capability | Verdict | Why / mapping to Factory OS |
|---|---|---|
| Photoreal 3D/AR configurator | IGNORE | Made-to-measure geometry is exactly what asset-remix 3D cannot do; modeling cost dwarfs our $0 constraint |

### Sources
- https://configurator.tech/blogs/threekit-configurable-products-review/ , https://cpq3d.com/3d-product-configurator-cost/

## Dainese Custom Works (+ REV'IT TAILORTECH) — flagship custom programs: online design, human gate, deposit

### Who it's for & pricing reality
Premium riders. Custom Color is fully online; Custom Fit in-store only. **30% non-refundable deposit** activates production; 8–10 weeks (Color) / 6–8 weeks (Fit). 2018 press put markup at ~25% (design) / ~30% (fit) over the base suit — dated, indicative only. REV'IT quotes 6–10 weeks, price undisclosed.

### The screens that matter
Configurator walks garment → leather (perforated or not) → **color per leather panel** → plate/slider colors → logos and **text/numbers in predetermined zones only**. Submitting a design does NOT place an order: "one of our Custom Works Specialists will review your design", emails confirmation; customer accepts terms, pays deposit. Custom Fit: a trained expert takes **25 measurements plus photos in a base layer**, with an interview on riding style and injuries. REV'IT adds a digital scan, notes asymmetries, offers template vs blank-canvas design, and video-call measuring for remote customers.

### Click-path notes
Custom Color: ~6–7 configurator screens → submit → specialist email → accept + 30% deposit. Custom Fit: appointment → 25 measurements + photos (~30 min) → deposit in store. No path skips the human.

### What users complain about
Little public negativity; in-store-only fit and race-season waits. Thin complaint corpus (owner-experience blogs like GearChic only).

### Verdicts
| Capability | Verdict | Why / mapping to Factory OS |
|---|---|---|
| Specialist review gate between submitted design and confirmed order | ADOPT | Configurator output lands as a draft quote the Owner reviews in the Gmail thread before sending |
| Predetermined personalization zones for lettering/logos | ADOPT | Named zones per garment kill unbounded art review on quantity-one pieces |
| 30% non-refundable deposit gates production | ADOPT | Quote accepted → deposit invoice → Work Order unlocks on deposit paid |
| 25 measurements + photos + injury interview | ADAPT | Measurement form = garment-type field set + base-layer photos + fit/injury notes on the MeasurementProfile |
| Dealer/store measuring network | IGNORE | We ARE the factory; customers visit or self-measure |

### Sources
- https://www.dainese.com/us/en/custom-works/custom-fit.html , https://www.dainese.com/us/en/custom-works/custom-color.html
- https://revitsport.com/en-us/pages/tailortech-process , https://www.asphaltandrubber.com/reviews/dainese-custom-works/

## 4SR, AG10Moto & Bison Track — small custom-leather shops: our closest analogs

### Who it's for & pricing reality
Racers buying one-off leathers from small factories (Czech, Spanish, US). AG10Moto: **€860 base with transparent add-on prices** (back protector €60, airbag compatibility €100–200, express +€100 → 15 working days), **50% deposit, balance before shipping**. Bison: from $1,425 (Thor.1) / $1,785 (Thor.2). 4SR: quote-back via individual@4SR.com; lead time seasonal — "several months" in race season, ~2 months off-season.

### The screens that matter
4SR's configurator covers colors, textures, panel details, protector/slider colors, logo upload — **no live price**; saving a design triggers personal contact. Measurements: "editable form with a video guide" for self-measure, or in-person fitting; leather (cow/kangaroo), cut (fitted/touring), 1- or 2-piece chosen up front; a designer co-iterates, then the design is printed onto leather. AG10Moto: self-design in a customizer or "reserve without a sketch" (team replies in 24–48h); photo/video measurement form; fit guarantee with free adjustments. Bison: no builder — a "Gear Customization Specialist" plus Design Central (leather samples, patterns, templates) and Measurement Central (videos, trackside measuring, fitment guarantee); options span perforation none→"all non-impact areas", accordion panels in seven areas, stingray sliders, armor/Helite airbag integration.

### Click-path notes
AG10Moto is the tightest loop: configure or reserve → 24–48h design contact → measurement form → 50% deposit → production → balance → ship. 4SR and Bison interpose more email/designer rounds; none shows a final live price for made-to-measure.

### What users complain about
Race-season lead-time stretch (HHR on 4SR: "several months"); otherwise thin public complaint data — these shops run on word-of-mouth.

### Verdicts
| Capability | Verdict | Why / mapping to Factory OS |
|---|---|---|
| Self-measure kit: editable form + how-to video, sent by email | ADOPT | Send our measurement-form link from the quote's Gmail thread; answers write into the MeasurementProfile |
| Transparent base + add-on price sheet (AG10) | ADOPT | Our option deltas ARE this sheet, composed live with Owner-visible margin |
| 50% deposit / balance-before-ship | ADOPT | Second deposit pattern beside Dainese's 30%; deposit % is a per-quote field |
| Fit guarantee with free adjustment | ADAPT | Quote-level policy toggle spawning a follow-up alteration Work Order |
| Designer co-iteration by raw email rounds | BEAT | We thread every design round through one audited Gmail-linked quote with versioned option snapshots |
| Configurator without live pricing (4SR) | BEAT | We can price live because options and per-party price lists are structured — their gap is exactly our golden flow |

### Sources
- https://www.4sr.com/4sr-individual-custom-motorcycle-gear-in-your-own-design.html , https://configurator.4sr.com/ (direct fetch blocked; behavior per official pages) , https://hhrperformance.com/products/racing-suit/
- https://www.ag10moto.com/en/made-to-measure-motorcycle-suit
- https://bisontrack.com/collections/bison-custom-built-suits , https://bisontrack.com/products/thor1-custom-suit

---

## monday.com — the "Work OS": generic colored boards whose collaboration micro-interactions set the bar we must match

### Who it's for & pricing reality
Teams of 3+ who want a customizable table that feels alive. Pricing (July 2026, annual): Free (2 seats, 3 boards), Basic $9/seat/mo, Standard $12, Pro $19, Enterprise custom; monthly billing $12/$14/$24. Minimum 3 seats, then buckets in multiples of 5 — a team of 6 pays for 10. Basic has **no automations or integrations at all**; Standard caps at 250 automation + 250 integration actions/mo; Pro raises that to 25,000 and gates Formula column, private boards, Workload view. Enterprise adds column permissions, audit-log API, 5-year activity-log retention. The 2026 pivot: an "AI Work Platform" — Sidekick assistant (early access), AI blocks, agent "digital workers", all metered from a shared AI-credit pool. Quotes/invoices live in a **separate product** (monday CRM: 50 quotes/mo on Standard, 250 on Pro). Factory math: Owner + 4 workers = 5 Pro seats ≈ $95/mo forever, and the workflow itself burns metered actions.

### The screens that matter
- **Board (table view)** — left rail of workspaces/boards; view tabs (Table, Kanban, Calendar, Gantt, Workload, Chart, Form); "Integrate / Automate" top-right; toolbar (New item, Search, Person, Filter, Sort, Hide). Body = **groups**: colored collapsible sections (color bleeds into each row's left edge), a "+ Add item" row pinned at each group's bottom, and a **column-summary footer** (numbers roll up with units; Status renders a stacked color distribution bar).
- **Columns** — 30+ types. Status: up to 40 custom labels with colors, per-label descriptions, configurable "done" semantics. People, Date, Numbers, Files, Formula (Pro; read-only, computed client-side), Connect Boards (manual item linking, max 60/board), Mirror (dead past 2 hops).
- **Subitems** — expand-arrow opens a nested mini-table **with its own column schema**; multi-level boards go 5 layers deep. Limits: 10,000 items/board (100k Enterprise), 20,000 items+subitems combined.
- **Item card** — click the item name → side card with fixed-order tabs: **Updates** (default), Files, Activity Log. Updates is a social feed: rich-text composer, files (computer/Drive/Dropbox/Box), GIFs, threaded replies, emoji reactions, a "Seen" eye, and a per-item email address ("write updates via email").
- **Bell (notification center)** — tabs "All" and "I was mentioned" (team-mentions land only in All). Triggers: mentions, assignments, replies, subscribed-board updates, due dates, automation "notify" actions. Hover a notification → check mark marks it read (turns white, stays listed). Email mirrors the bell. **My Work** adds a cross-board personal queue.
- **Email to board** — every board has a secret address (it embeds your API key): subject → item name, body → first update, item lands in a new "Emails" group at the top. No sender matching, no thread continuation.
- **Automation center** — recipe gallery plus a custom builder that reads as a fill-in-the-blank sentence: "**When** status changes **to something**, **then** notify **someone**" — trigger, optional condition, action(s); a redesigned "New Automation Builder" and a multi-step workflows canvas coexist.
- **Permissions** — Admin/Member/Viewer/Guest; boards Main/Private/Shareable; four permission sets: edit everything / edit content / edit only items assigned to you / view only; owners bypass all.

### Click-path notes
- **New order row**: "+ Add item" → type name → Enter. 2 interactions; columns filled cell-by-cell after.
- **Status change**: click cell → colored-label palette → click one. 2 clicks, instant repaint, no save step; destructive actions get a 10-second undo toast (Trash keeps deletions 30 days).
- **Relabel a pipeline**: status cell → "Edit Labels" at palette bottom → edit text/color/order inline → Apply. 4–6 interactions; renames don't break existing rows.
- **Comment with mention**: click item name (card opens on Updates) → type "@" → autocomplete of people/teams → pick → write → Update. ~5 interactions; mentioned person gets bell + email.
- **Bulk move 20 orders**: hover checkbox → shift-click range → bottom batch bar (count + Duplicate/Export/Archive/Delete/Move) → pick target. ~4 interactions.
- **Simple automation**: Automate → pick recipe card → fill each underlined token → Create. ~5–7 clicks.
- **Email → quoted order (our golden flow)**: forward the email to the board address → item appears in the top "Emails" group → drag to a stage group → hand-type customer, options, prices into cells; an actual quote document requires buying monday CRM, where quotes are metered. The flow exists only as fragments across two products, with zero party-matching and no priced configurator.

### What users complain about
- **Notification flood**: "You might get a lot of notifications and updates" with many tasks (G2) — the top recurring gripe; consultancies publish guides on taming monday email noise (Lucid Day).
- **Seat buckets & gated tiers**: users "don't like having to add seats/licenses in blocks versus per person"; must-have features (formulas, workload) sit behind Pro (G2).
- **Performance**: "sluggish even on high-end hardware… boards taking several seconds to load"; lag on large boards with many automations (Capterra/G2).
- **Automations break silently**: "automation breaking too easily… no way to fix broken automations" (Capterra); quotas surprise teams mid-month.
- **Formula column is a dead end**: can't trigger automations or appear in notification emails/widgets — a standing community feature request; the accepted workaround copies formula output into a helper column via workflows or a paid app.
- **Connect Boards is manual**: "no option for adding all tasks… automatically to the connected column — they must be added manually and individually" (Capterra); mirrors stop at 2 hops and clutter boards one column per field.

### Verdicts
| Capability | Verdict | Why / how it maps to Factory OS |
|---|---|---|
| Status cell interaction (click → color palette → instant repaint; inline "Edit Labels"; label descriptions) | ADOPT | Exactly our Orders/Work-Order status cells: zero-training, one-glance color. Pipeline stages come from the domain state machine; free labels only for tags. |
| Row hover choreography (drag handle at left edge, checkbox reveal, open-card affordance on name cell) | ADOPT | Proven "everything is touchable" grammar; copy verbatim in our Orders table. |
| Batch-actions bottom bar (count + Duplicate/Export/Archive/Delete/Move, X to dismiss) | ADOPT | Our bulk-operable requirement, solved. Same bar over SQLite rows. |
| Undo toast + 30-day trash | ADOPT | Confidence to click freely; ours is a compensating event on the ledger, so undo never erases history. |
| Updates feed per item (@mention autocomplete for people/teams, threaded replies, emoji reactions, files, "Seen") | ADOPT | The collaboration bar. Mention → notification → reply loop, unchanged. |
| Comments separated from field history (Updates vs Activity Log tabs) | ADAPT | Merge into one item timeline: domain events (status moved, price changed, label bought) interleaved with comments — one narrative, not two silos. |
| Notification center (All / Mentioned tabs, hover-check to clear) | ADAPT | Keep bell + Mentioned tab + hover-clear; default triggers cut to mentions, assignments, my-order state changes. Noise is monday's #1 complaint. |
| Groups-as-stages board, drag between groups | ADAPT | Groups = order lifecycle stages, but drag-to-group is a validated domain command (can't drop into SHIPPED without a label), not a free row move. |
| Subitems with own column schema | ADAPT | Proves inline expand-row UX for Work-Order steps (CUTTING→PACKING with station/worker/minutes/materials); ours are typed child entities, not ad-hoc columns. |
| Automation sentence UX ("When X, only if Y, then Z" fill-in-the-blank) | ADOPT | Best-in-class config-as-sentence. Ours runs in-process on domain events: no quotas, no silent breakage. |
| Formula column | BEAT | Client-side, read-only, Pro-gated, can't drive automations. Our pricing model is server-side, versioned, margin-aware, *is* the quote, and triggers anything. |
| Connect Boards + Mirror | BEAT | Hand-wired links, no referential integrity, 2-hop limit. Real foreign keys (Order→Customer→PriceList, WorkOrder→Order, Reservation→Material): relations are born, never wired. |
| Email to board | BEAT | Subject-dump into a top group via an address that leaks an API key; no sender identity. We match sender→party, open a pre-scoped configurator, reply the quote into the same Gmail thread. |
| Quotes & invoices (monday CRM, metered, separate product) | BEAT | Quote composition with live margin is our core loop, free and unlimited — and the quote *becomes* the order and work order. |
| Activity log (retention 1yr Pro / 5yr Enterprise) | BEAT | Append-only SQLite event ledger, kept forever, IS the system of record — audit is structural, not a plan feature. |
| Views: Table + Kanban re-projection of one dataset | ADAPT | Two projections of the same order query suffice: table + kanban by stage. |
| Workload view (capacity bubbles, red overload) | IGNORE | Resource-management theater for 3–4 workers within earshot; per-station work-order queues already show load. |
| Permission matrix (4 board sets, Enterprise column permissions) | ADAPT | Keep one idea — workers edit only items assigned to them; Owner sees margin columns. Two roles, hardcoded, zero admin UI. |
| AI agents / Sidekick / AI credits | IGNORE | Consumption-metered "digital workers" shepherding generic boards; our flows are deterministic domain code on local data — nothing to delegate at this scale. |

### Sources
- https://monday.com/pricing ; https://support.monday.com/hc/en-us/articles/4405633151634 (plans) ; https://get-alfred.ai/blog/monday-pricing (3-seat minimum, buckets)
- https://ir.monday.com/news-and-events/news-releases/news-details/2026/monday-com-Goes-All-In-on-AI-From-Work-Management-Platform-to-AI-Work-Platform/default.aspx
- support.monday.com articles: 7278527605906 (hierarchy), 360011905480 + 29810815287570 (subitems), 4404058746642 (item limits), 360001269685 (Status column), 360001235445 (Formula), 360000635139 + 360021743500 (Connect Boards), 360001733859 (Mirror), 115005900249 (Updates), 360017143959 (Item card), 115005310745 (Activity log), 360001259429 (Audit log), 360015535060 (Bell), 360001292545 (Notifications), 360012254440 (custom automations), 31585338491922 (New Automation Builder), 115005335049 (Batch actions), 360011810600 (undo), 115005315809 (board permissions), 115005339645 (Email to board), 360019213180 (Emails & Activities), 25760992782226 (monday CRM plans/quotes), 360010699760 (Workload)
- https://learn.g2.com/monday-review ; https://www.g2.com/products/monday-com/reviews ; https://www.capterra.com/p/147657/monday-com/reviews/
- https://community.monday.com/t/allow-formula-columns-to-be-used-in-automations/117674 ; https://community.monday.com/t/customizable-and-reusable-color-options-for-status-columns/100049
- https://lucidday.com/how-to-stop-monday-notifications-from-taking-over-your-inbox/

---

## Front + Missive — the shared-inbox bar: how an email thread becomes a work object

### Who it's for & pricing reality

**Front** restructured on 2025-09-02 from four plans to three: Starter $25/seat/mo (max 10 seats, ONE channel type, 10 automation rules), Professional $65 annual / $85 monthly (max 50 seats, omnichannel, 20 rules, sequences), Enterprise $105 (unlimited rules, AI bundled). The $59 Growth and $99 Scale tiers were deleted; Starter rose from $19. Below Enterprise, AI is add-ons: Copilot $20/seat, Smart QA $20, Smart CSAT $10, Autopilot from $0.05/conversation.

**Missive**: Free = 3 users, 15-day history, 2 shared accounts, no rules/integrations/API. Starter $14/user/mo annual (max 5 users) — still no rules, integrations, analytics or API. The real product starts at Productive $24 annual / $30 monthly (max 50 users): rules, sidebar integrations, API, AI, analytics. Business $36/$45 adds comparative analytics + SAML.

A 4-person factory pays Front Professional ≈ $3,120/yr or Missive Productive ≈ $1,152/yr, forever; Factory OS delivers this bar at $0.

### The screens that matter

Both converge on one **four-pane anatomy**: nav rail | conversation list | thread pane | right context sidebar.

- **Nav rail.** Front: Assigned to me, **Mentions**, **Subscribed** (threads bump on activity). Missive: personal Inbox vs **Team Inboxes** (triage queues), Tasks view, Activity feed.
- **Conversation list.** Assignee avatar, tags/labels, snippet, status; Missive adds a share-status border and task-progress badge per row.
- **Thread pane — key finding: neither uses a side-by-side comment rail.** Both interleave internal talk INTO the timeline. Front: an "Add internal comment" composer beside Reply; comments carry attachments (100 MB), emoji reactions, @mentions (top-5 suggestions, @all); a mention auto-subscribes you and surfaces the thread in Mentions/Subscribed. Missive goes further: "internal chat messages flow between external messages" — the thread literally is a chat room with emails pinned inside; assignment in the header, tasks embedded in-thread.
- **Right sidebar.** Front's Contact Details panel: About (fields + custom fields — definable on contacts, accounts, even conversations), Conversations (cross-channel history with that sender), Notes; CRM plugins keyed by sender email. Missive: contact details + history + integration iframes; custom iframe apps react to conversation selection via a JS SDK — "show recent order history" is Missive's own pitch.
- **Linked objects.** Front **Links** = a name + external URL attached like a tag; native Jira/Asana/Trello/GitHub or custom via API ("orders, shipments" per their docs); a recognized Link lists every conversation sharing it; webhooks fire on attach/detach. But the chip shows nothing of the object's state, and hand-pasted links aren't searchable.
- **Status semantics.** Front: archive/snooze/trash from a shared inbox changes the thread for everyone viewing it; followers keep it in Subscribed; a reply auto-reopens. Missive splits **Archive** (remove from my view) from **Close** (the work is done — task semantics): closing removes it from the Team Inbox for all and auto-archives for the closer; a reply reopens it into the assignee's inbox.

### Click-path notes

- **New email → owned work (Missive):** Team Inbox row → assign (1 keystroke; it leaves everyone else's queue) → reply → Close. One screen, ~3 actions, ownership unambiguous.
- **Internal question on a live thread (both):** type in the same pane, @mention → notification + Mentions entry. Zero forwarding, one screen.
- **Thread → external object (Front):** Tags ▸ Link ▸ paste URL ▸ Add = 4 actions — and the "order" is still a dumb chip; seeing its state means leaving Front.
- **Snooze / send later:** one action everywhere. Missive drafts take a follow-up reminder with **"Discard snooze if someone replies"** — the auto-cancelling chase.
- **Sequences (Front, Professional+):** 1–10 stages (A–J), each a reply to the previous, halts on genuine reply (OOO ignored), email-only. Missive: no first-class sequences; an "Automatic follow ups" rules template approximates one.
- **SLA:** Front = named time-goal rules + a breaches/overdue report (snooze does NOT pause the timer). Missive = composed from rule conditions — "Unreplied and open after 30 minutes" in business hours + notify/escalate.
- **Gmail fidelity:** Front imports Gmail labels as tags ONCE; after that labels, read state, archive, trash and snooze do not sync — Gmail degrades into a feeder. Missive keeps true two-way sync (labels, stars, archive, delete, snooze) on all plans — Gmail stays intact.
- **Channels:** Front gates omnichannel at $65 (Starter = one channel type); WhatsApp native or via Twilio. Missive unifies email/SMS/WhatsApp/Instagram/Messenger/live chat in one list; rules run cross-channel.

### What users complain about

**Front — pricing dominates.** "Multiple plans, AI add-ons, and hidden service fees… can quietly 2x your monthly bill" (Featurebase). A six-year customer paying €12,000/yr on Trustpilot: "the pricing model is no longer competitive… the level of customer support falls short." A January 2026 reviewer cancelled over broken Outlook two-way sync; roundups report mis-threading and rules silently failing to fire (eesel).

**Missive — depth costs.** G2 review mining (third-party; counts unverified): search is the weakest link (95 "lacking functionality" + 77 "search difficulty" mentions), a "steep" learning curve, mobile-app gaps, slowdowns on very large inboxes. An r/Missive user calls missing open tracking "the only real downside." Starter's bareness — no rules or integrations until Productive — is the quiet upsell.

### Verdicts

| Capability | Verdict | Why / how it maps to Factory OS |
|---|---|---|
| Four-pane thread workspace (nav / list / thread / context rail) | ADOPT | The proven anatomy; our Inbox = list, thread, right rail showing Party + linked Quote/Order. Looks like email people know → zero training. |
| Comments interleaved in the thread (not a side rail) | ADOPT | Missive-style distinct bubbles make internal-vs-customer unmistakable — a mis-send to a B2B brand is unrecoverable. Composer = Reply/Comment toggle. |
| @mentions + auto-subscribe + Mentions section | ADOPT | "@Luca can we perforate this hide?" → notification + Mentions filter. Trivial in SQLite; this IS collaboration for a tiny team. |
| Missive Close-vs-Archive (assignment = task with done state) | ADOPT | "Done" must be a state of the WORK, not of someone's inbox view. Team queue → assign (leaves queue for all) → close on delivery; reply reopens to assignee. |
| Front shared-inbox "archive affects everyone" | ADAPT | One shared thread state + a personal "my queue" suffices for 4 people; skip follower nuance and per-user option soup. |
| Front Links (thread ↔ external object) | BEAT | Their docs pitch "orders, shipments" — yet a Link is a stateless URL chip, unsearchable when hand-added. Ours: sending a quote from the thread auto-creates the relation; the rail renders live Order state (stage, price, margin); "all threads for this Order" is one query. They bolt work objects on; our threads give birth to them. |
| Contact sidebar: custom fields + cross-channel history | ADAPT | Front's About/Conversations/Notes keyed by sender email = our auto-matched Brand/Customer card, pre-scoped to price list, terms, sizes on file. Factory-schema'd fields, not a generic field builder. |
| Missive iframe-integration SDK | IGNORE | Platform plumbing for third parties. We ARE the CRM and order system; the sidebar is native. No HTTPS tunnels on a local-first machine. |
| General rules engine | ADAPT | Ship ~5 toggleable plain-English recipes (sender-domain→Brand match, auto-tag, unanswered nudge), not a builder with 1000-rule quotas for 4 users. |
| SLA time goals + breach reports | ADAPT | One recipe: "customer unanswered after X business hours → amber row + notify Owner." Copy Missive's business-hours timer; skip the reporting suite. |
| Snooze / send-later / follow-up with discard-on-reply | ADOPT | Quote chasing IS our follow-up problem; auto-cancel on reply prevents the double-chase. Cheap, daily value. |
| Outbound sequences (Front Professional+) | IGNORE | Demand arrives inbound — orders are born from received email. Cold-outreach drips are sales-tool theater here; the follow-up reminder covers quote chasing. |
| Omnichannel unification (WhatsApp/SMS/social) | ADAPT | Italian B2B lives on WhatsApp, but launch email-only ($0, Gmail quota). Keep Conversation/Message channel-agnostic so WhatsApp mounts later — without Front's $65 gate. |
| Missive-grade Gmail two-way fidelity | ADOPT | Non-negotiable: the Owner will still open Gmail; labels/read/archive must round-trip. Front's import-once-then-diverge trap forks the factory's memory. |
| Per-seat SaaS pricing | BEAT | $1.1k–3.1k/yr for four seats, features gated by tier. Local SQLite + free Gmail API = the same workspace at $0; a seasonal stitcher costs nothing to add. |
| Team analytics / leaderboards | IGNORE | Leaderboards for 4 people the Owner sees daily is theater. Keep three live counters: unanswered, quotes awaiting approval, overdue promises. |

### Sources

- https://front.com/pricing — plans, seat caps, rule limits, AI add-ons
- https://pricetimeline.com/data/price/front — 2025-09-02 restructure
- https://help.front.com/en/articles/2256 + https://help.front.com/en/articles/2065 — comments, @mentions
- https://help.front.com/en/articles/2134 + https://help.front.com/en/articles/2257 — status semantics, inbox sections
- https://help.front.com/t/60h1h1x/understanding-links + https://dev.frontapp.com/docs/creating-a-links-integration — Links, API webhooks
- https://help.front.com/t/63vv76/how-to-see-contact-details-and-communication-history + https://help.front.com/en/articles/2172 — contact panel, custom fields
- https://help.frontapp.com/t/q6hh1bw/sla-rules + https://help.front.com/en/articles/2151 — time goals, report
- https://help.front.com/en/articles/2259 — sequences (Professional+)
- https://help.front.com/en/articles/2061 + https://help.front.com/en/articles/205312 — Gmail label import, sync limits
- https://help.front.com/en/articles/245248 — Twilio WhatsApp channel
- https://www.trustpilot.com/review/front.com + https://www.eesel.ai/blog/front-review + https://www.featurebase.app/blog/front-pricing — complaints
- https://missiveapp.com/pricing + https://missiveapp.com/docs/administration/billing-and-plans — plans, Free-tier limits, gating
- https://missiveapp.com/docs/get-started/missive-interface — four-pane anatomy
- https://learn.missiveapp.com/missive-concepts-explained/what-is-the-difference-between-archiving-and-closing + https://learn.missiveapp.com/faq/conversations-closed-upon-archiving — close/archive semantics
- https://missiveapp.com/docs/core-features/team-inboxes — team-inbox triage
- https://missiveapp.com/docs/developers/ui-iframe-integrations — iframe SDK
- https://missiveapp.com/docs/advanced-features/rules/conditions + https://missiveapp.com/docs/advanced-features/rules/templates/automatic-follow-ups — rules, business-hours SLA, auto follow-ups
- https://missiveapp.com/docs/core-features/connected-accounts/email-accounts/gmail-google-workspace — two-way Gmail sync
- https://learn.missiveapp.com/faq/follow-up-reminder — discard-snooze-on-reply
- https://www.g2.com/products/missive/reviews + https://prospeo.io/s/missive-pricing-reviews-pros-and-cons — complaint mining (counts unverified)

---

## Sendcloud — EU-first shipping panel; the Owner's daily driver at Xavia

### Who it's for & pricing reality
EU e-commerce SMBs. Official tiers (sendcloud.com/pricing, July 2026, EUR, annual −20%): **Free** €0 — 20 parcels/mo, €0.10/label, Sendcloud rates only; **Lite** €28/mo — own carrier contracts, 5 shipping rules, €0.10/label (cap 400/mo, then +€0.15); **Growth** €87/mo — branded tracking page + return portal, Pack & Go, €0.09/label; **Premium** €175/mo — advanced returns, unlimited rules, €0.08/label; **Pro** €639/mo. Label fees stack on top of postage; pickups are paid-plan features (exact gating tier unverified).

### The screens that matter
- **Incoming Orders** — one grid: checkboxes, customer/destination, weight, per-row method dropdown pre-filled by Shipping Defaults + Rules; "Create labels" button with document-type dropdown (label/return/packing slip).
- **Shipping > Carriers** — toggle Sendcloud-rate carriers; **My contracts** tab + "Use only my rates" toggle.
- **Shipping > Shipping prices** — static price-list comparator (dims/weight/country → sortable table), outside the order flow.
- **Pick-ups** — Schedule/Reports tabs; per-carrier form; one-off or recurring.
- **Settings > Brands** — logo + color per brand, feeding tracking emails, tracking page/widget, return portal.

### Click-path notes
- **Connect own carrier contract**: Shipping > Carriers > My contracts (1) → "Add your own contract" (2) → find carrier → "Add contract" (3) → fill contract fields — account number / API creds, varying per carrier, each with a Help Center activation article (4) → "Add this contract" (5).
- **Onboarding**: signup → sender address → Settings > Integrations > Connect shop → €0.02 direct-debit mandate → enable carriers — five stations before label #1.
- **Order → printed label**: rules pre-assign the method: tick order (1) → "Create labels" (2) → print/auto-print (3). Bulk identical with select-all. ~2–3 clicks — the bar to match.
- **Pickup**: Pick-ups → Schedule → "Schedule a pick-up" → form (≥1 working day lead). **Returns**: customer opens brand portal → postal code + order number → reason; lands in Returns overview.

### What users complain about
Trustpilot: surcharges billed "sometimes 2 months later… exceeding €10 per label"; bills "10x higher" than quoted; monthly outages; cancellation lock-in (support confirmed, then refused, cancellation); "12.5% increase announced for September"; support decline through late 2025.

### Verdicts
| Capability | Verdict | Why / how it maps to Factory OS |
|---|---|---|
| Rules pre-assign method → select → Create labels (2–3 clicks) | ADOPT | Our two-click target: order carries a default service from the customer/price list; "Buy label" → confirm+print. |
| Own-contract attach (per-carrier form + help article + "use only my rates") | ADOPT | Copy the shape: pick carrier → one credential form with field help → test call → live; no plan gate or debit mandate. |
| Sendcloud API as label engine behind our UI | ADAPT | Wrap the Owner's Xavia account (or a €0/€28 factory account) as connector #1: BRT/GLS/Poste/DHL labels with zero integration work; adapter swappable. |
| Per-Brand identity (tracking email/page/portal) | ADAPT | Own-brand vs B2B-client shipments carry different sender identity. |
| Pack & Go scanner/queue modes | IGNORE | Warehouse theater; the Work Order PACKING step already knows the parcel. |
| Shipping-prices comparator as separate page | BEAT | Rate comparison belongs inside label purchase, cheapest-first — not a detached price list. |
| Pickup scheduling | ADAPT | One "book pickup" action pre-filled with today's parcels + factory address. |
| Return portal (postal code + order no.) | ADAPT | Made-to-measure returns are rework conversations: return-authorization inside the order's email thread emits a label. |
| Billing model (label fees, tier caps, late surcharges) | BEAT | No seat/label rent locally; show estimated total incl. typical surcharges at purchase; reconcile carrier invoices back to shipments. |

### Sources
- https://www.sendcloud.com/pricing/ · https://www.sendcloud.com/carrier-pickup/ · https://www.trustpilot.com/review/www.sendcloud.com
- https://support.sendcloud.com/hc/en-us/articles/360025449372 (own contract) · /360025263691 (process orders) · /360024833452 (getting started) · /360024841232 (tracking emails) · /360025142691 (return portal) · /360026392851 (pickups)

## ShipStation — US-centric order desk; home of "Create + Print Label"

### Who it's for & pricing reality
US/UK/AU volume shippers. Three volume-billed plans since July 2025 (shipstation.com/pricing): **Starter** $14.99/mo (50 shipments, 3 users; no own carrier accounts, no API) → $174.99 @5k; **Standard** $29.99 → $3,599.99 @100k (own carrier accounts, API, branded returns portal, unlimited automations); **Premium** $349.99 base. 30-day trial; own-carrier connection fees dropped for accounts created after July 8 2025 (legacy tiers still pay $5–95/mo).

### The screens that matter
- **Orders grid** — dense, filterable; selecting a row opens the **Configure Shipment widget** in the Shipping Sidebar: Ship From, weight, service, package, insurance, live rate — ending in a **Create + Print Label** split-button.
- **Rate Browser** — per-shipment rate comparison across connected carriers.
- **Shipments > End of Day** — "Close Shipments" → printable manifest/SCAN PDF per carrier.
- **Store Setup > Edit Store Details** — Tracking Page tab (radio: Use Branded Tracking Page), Returns tab (Activate Standard Returns).

### Click-path notes
- **Connect own carrier**: Account Settings → Shipping → Carriers (1–2) → "Connect Your Carriers" (3) → pick carrier (4) → per-carrier credential dialog (5). Built-in ShipStation Carriers instead demand payment method + T&C + pre-funded balance.
- **Order → label**: select order (1) → widget pre-filled by presets/automation → "Create + Print Label" (2). The two-click benchmark — but only after preset setup, and desktop printing needs the ShipStation Connect agent.
- **Bulk**: select N orders → apply preset → Create Labels (batch) → print batch.

### What users complain about
Price hikes and billing opacity; "changes… to cut costs by downsizing and offshoring their support have been very worrying" (G2); a bug reported Aug 2025, acknowledged Oct 2025, still unfixed Apr 2026 (Capterra); feature removals forcing tier upgrades.

### Verdicts
| Capability | Verdict | Why / how it maps to Factory OS |
|---|---|---|
| Create + Print Label split-button | ADOPT | The canonical two-click finish; we print via OS dialog — no agent install. |
| Configure Shipment sidebar (all shipment facts in one rail) | ADOPT | Same rail on our order: parcel preset, weight from product, service, cost + margin. |
| Automated rate shopping / Rate Browser | ADAPT | 3–5 live rates inline at purchase, cheapest pre-selected; no popup. |
| End of Day manifest | ADAPT | One "day sheet" button: PDF of today's parcels for the BRT/GLS driver, fused with pickup booking. |
| Branded returns portal (Standard+) | IGNORE | Plan-gated portal; our returns are rare rework negotiations. |
| Platform as our tool | IGNORE | US-first carriers, per-shipment volume pricing, no Italian depth. |

### Sources
- https://www.shipstation.com/pricing/ · https://help.shipstation.com/hc/en-us/articles/22354433862555 (fees) · /360026157651 (single labels) · /360025869732 (connect carriers) · /360025869792 (manifests) · /360026158351 (branded tracking)
- https://www.capterra.com/p/155621/ShipStation/reviews/ · https://www.g2.com/products/shipstation/pricing

## Shippo — API-plus-lite-dashboard; free tier and scan-based returns

### Who it's for & pricing reality
US-first SMBs and developers (goshippo.com/pricing): **Starter** free — 30 labels/mo, own carrier accounts $0.05/label; **Pro** from $17/mo (volume slider to 10,000 labels/mo) — own accounts free, branded tracking pages/emails, 5+ users; **Premier** custom. Overage 8¢/label; postage pay-as-you-go ($100 accrual or every 7 days).

### The screens that matter
- **Orders page** — grid with checkboxes and per-order "Create Label".
- **Rate list** mid-purchase — carrier, price, ETA, cheapest first.
- **Settings > Carriers** — Shippo master accounts vs "Your Accounts"; "+ Connect Carrier Account".
- **Settings > Labels & packing slips** — "Auto-create return labels for outbound shipments" (scan-based).

### Click-path notes
- **Connect own carrier**: gear (1) → Carriers (2) → "+ Connect Carrier Account" (3) → pick carrier (4) → fields → Submit (5); UPS inserts a T&C acceptance step.
- **Order → label**: ~4 screens / 5 clicks — addresses → "Next: Order Details" → rate list → Buy → review → Purchase → download 4x6 PDF. Double our budget; the review screen is a click Sendcloud/ShipStation don't charge you.
- **Bulk (≤100)**: select (1) → "View N Orders" (2) → extras → Save (3) → "Purchase Labels" (4) → confirm (5) → download + notify emails.

### What users complain about
Sudden account blocks pending ID verification ("suspended without justification… upload driver's license" — Trustpilot); XCover insurance claims "evaluated through AI" and denied; support fine until something breaks.

### Verdicts
| Capability | Verdict | Why / how it maps to Factory OS |
|---|---|---|
| Scan-based return labels (charged only when scanned) | ADOPT | Attach a dormant return label to B2B shipments at zero cost unless used (Italian-carrier support to verify). |
| 5-step carrier connect | ADAPT | Same shape, plus instant test-call validation and inline field help. |
| 4-screen label purchase | BEAT | Purchase+review+download collapse into one confirm-and-print on the order. |
| Free tier as the factory's engine | IGNORE | 30 labels/mo, US carrier bias, 5¢ own-account fee — Sendcloud wrap fits Italy better. |

### Sources
- https://goshippo.com/pricing · https://support.goshippo.com/hc/en-us/articles/360024209911 (connect carrier) · /360033153591 (label for order) · /360046583651 (batch) · /360035826412 (returns)
- https://goshippo.com/shipping/return-shipping-labels · https://www.trustpilot.com/review/goshippo.com

## EasyPost — carrier API infrastructure, not an ops surface (brief)

### Who it's for & pricing reality
Developers/enterprise logistics teams (easypost.com/pricing): **Free Access** up to 3,000 labels/mo on wallet carriers, per-label fees beyond; **BYOCA** $20/mo + per-label fees; tracking $0.01–0.03/shipment; insurance 1% ($1 min). A Feb-2026 repricing reportedly killed the 120k-labels/yr free tier, raised label fees ~60%, and added a 3% USPS surcharge from June 2026 (reported by 1TeamSoftware and competitor Shippo; unverified).

### The screens that matter
Minimal dashboard: API keys, wallet, carrier accounts, shipment log. No order desk — you build the UI.

### Click-path notes
All API: POST shipment → rate array → POST buy → label URL; webhooks push tracking. No human click-paths to copy.

### What users complain about
2026 repricing backlash (free-tier cut, USPS surcharge) in third-party writeups; fee complexity. Thin complaint surface — its users are developers.

### Verdicts
| Capability | Verdict | Why / how it maps to Factory OS |
|---|---|---|
| Adapter contract: quote → rate array → buy → webhook track → refund | ADAPT | Our courier-adapter interface mirrors this shape; backends stay swappable. |
| As a platform dependency | IGNORE | US-centric, repriced ~60% overnight — the rug-pull a $0-infra tool must not build on. |

### Sources
- https://www.easypost.com/pricing/ · https://1teamsoftware.com/2026/02/09/easypost-new-pricing-plans-2026/ · https://goshippo.com/blog/what-easyposts-new-3-fee-means-for-your-usps-shipping-costs

---

## Salesforce CPQ / Revenue Cloud — the reference model for option groups, price waterfalls and quote paperwork, currently mid-rebrand churn

### Who it's for & pricing reality
Enterprise sales orgs quoting inside Salesforce CRM. The legacy CPQ package hit **End of Sale March 2025** (existing customers keep support; end-of-life projected ~2029–30, unverified); new buyers get Revenue Cloud Advanced, renamed **"Agentforce Revenue Management"** at Dreamforce 2025 after the Spring '24 "Revenue Lifecycle Management" rename — three names in three years, and CPQ→RCA is a re-implementation, not an upgrade. Published add-on pricing: **CPQ $75/user/mo, CPQ+ $150, full RLM $200/user/mo** on top of Sales Cloud seats; real cost is dominated by consultant-led implementation (five/six figures widely reported, unverified). Disqualified on price alone for a three-person factory; we mine concepts only.

### The screens that matter
- **Quote Line Editor (QLE)** — the deal spreadsheet: one row per quote line, columns admin-defined via Field Sets (Product, Qty, List Price, Additional Discount, Net Total…), line groups as sections, mass-update, sort. Per-line **drawer** (slide-out) holds the long tail of fields — including **Cost** and **Markup** when cost pricing is on, gated by `View Cost on Line Item` / `Edit Cost on Line Item` permissions.
- **Bundle configurator** — Features render as titled sections (option groups) with **Min/Max Options**; options are product rows with checkbox + quantity; constraint violations surface as blocking or warning messages on save.
- **Generate Document** — template picker → preview → PDF/Word; every generation creates a **Quote Document record with a version number and timestamp**.
- RCA successor (Summer '26): Transaction Line Editor — expandable grid, side panel up to 200 attributes per line, bulk edits, live validations.

### Click-path notes
Quote a configured product for a known customer: Opportunity → New Quote → open QLE → Add Products → pick bundle → configurator (tick options per feature) → Save → per-line discounts → **Calculate** → Save → Generate Document → pick template → PDF → attach + email/e-sign — **≈9–10 screens**, and a discount past threshold inserts Submit-for-Approval → wait → resume. Guided selling (a "Quote Process" of admin-authored questions with show/hide conditions) merely pre-filters the product search — it still lands in the same path. Note: **email appears nowhere; the flow starts at a CRM Opportunity someone already created.** The moment we own — order born in Gmail — is upstream of their entire product.

### What users complain about
- **Performance**: big quotes and rule-heavy orgs mean slow calculation and timeouts; "each new rule increases processing time" (Salesforce Ben, CPQ optimization challenges).
- **Admin burden**: G2 reviewers on Revenue Cloud — "even seasoned Salesforce admins often find the product-to-cash architecture overwhelming, requiring specialized training or expensive outside consultants."
- **Platform churn**: EOS + rename treadmill forces paid re-implementation to stay current (servicepath, vendori).

### Verdicts
| Capability | Verdict | Why / how it maps to Factory OS |
|---|---|---|
| Bundle = Features (option groups w/ min–max) → Options | ADOPT | Direct map: ProductTemplate → OptionGroups(minSelect/maxSelect) → Options. Leather type (pick 1), lining, armor, perforation, sizing, branding are literally features. |
| Option Constraints: requires / excludes | ADOPT | One `OptionConstraint` table: type REQUIRES\|EXCLUDES + human message ("perforation excludes waterproof liner"); re-evaluate whole config on every toggle. |
| Second engine: Product Rules (validation/alert/selection + evaluation order) | BEAT | Salesforce splits constraint logic across two overlapping engines admins confuse. We ship ONE table with severity (block/warn) and effect (require/exclude/auto-add); exhaustive check is instant at our option-space size. |
| Price waterfall (List→Regular→Customer→Partner→Net, strict field order) | ADAPT | Collapse 9 stages to 4 visible lines per quote line: Cost → List (from party PriceList) → Adjustment (±, with reason) → Net, margin € and % beside. Partner/distributor tiers dropped. |
| Cost+Markup pricing; permission-gated cost visibility | ADOPT | Options carry `costDelta` + `priceDelta`; template carries base cost/price. Margin renders for Owner role only; customer PDF never contains cost columns. |
| Contracted per-account pricing auto-applied on line add | ADOPT | `PriceList` per Brand/Customer, auto-selected by Gmail sender match — this is the heart of the golden flow's "configurator opens pre-scoped". |
| Price Rules engine + lookup-query tables | BEAT | Their generic rules DSL is the top perf/admin complaint. Our pricing is a deterministic compose function in code (base + option deltas + size surcharge + party list + one manual adjustment) — transparent, testable, instant on SQLite. |
| Guided-selling questionnaire (Quote Process) | IGNORE | Owner is the domain expert and the configurator is already party-scoped; a Q&A wizard adds a screen, not information. |
| Quote Document versioning (snapshot + version number per generation) | ADOPT | `Quote.sentSnapshot` JSON frozen on send from the Gmail thread (options, costs, prices, rendered PDF); edits after send create v2 superseding v1. |
| Quote templates with dynamic sections | ADAPT | One hard-coded bilingual (IT/EN) PDF layout with a "show option detail" toggle; no template-designer UI. |
| Advanced Approvals (rules, chains, smart resubmit) | ADAPT | Reduce to a margin-floor speed bump: net margin below threshold → red badge + explicit confirm. Owner is the only approver; no chains, delegation or approval emails. |
| Revenue Cloud product-to-cash suite (billing, subscriptions, contract lifecycle, Agentforce agents) | IGNORE | Subscription-revenue machinery for SaaS ops; a factory sells one-off physical work. The rebrand churn is itself the argument for owning our stack locally. |

### Sources
- https://www.salesforce.com/sales/revenue-lifecycle-management/revenue-optimization-pricing/ (CPQ $75 / CPQ+ $150 / RLM $200)
- https://help.salesforce.com/s/articleView?id=000380701&language=en_US&type=1 (price waterfall order)
- https://help.salesforce.com/s/articleView?id=sales.cpq_bundle_products.htm · …cpq_constraint_guidelines.htm · …cpq_prod_option_consid.htm (bundles, features, option constraints)
- https://help.salesforce.com/s/articleView?id=sales.cpq_cost_markup_pricing.htm (cost+markup, View/Edit Cost permissions)
- https://help.salesforce.com/s/articleView?id=sales.cpq_contracted_prices_parent.htm (contracted pricing)
- https://help.salesforce.com/s/articleView?id=sales.cpq_price_rules_intro.htm (price rules, lookup queries)
- https://help.salesforce.com/s/articleView?id=sales.cpq_guided_selling.htm (guided selling)
- https://help.salesforce.com/s/articleView?id=sales.cpq_advanced_approvals.htm (advanced approvals)
- https://help.salesforce.com/s/articleView?id=sf.cpq_quote_document_overview.htm (quote document versioning)
- https://help.salesforce.com/s/articleView?id=sales.cpq_use_the_qle.htm (QLE, field sets, drawer)
- https://servicepath.co/2026/02/salesforce-cpq-end-of-sale-2026/ · https://vendori.com/blog/salesforce-cpq-end-of-life (EOS timeline)
- https://crmxai.com/blog/salesforce-agentforce-rebrand-product-names (Agentforce Revenue Management rename)
- https://veloceapps.com/post/summer-26-revenue-cloud-preview (Summer '26 TLE)
- https://www.g2.com/products/agentforce-revenue-management-formerly-salesforce-revenue-cloud/reviews · https://www.salesforceben.com/salesforce-cpq-optimization-challenges-to-overcome/ (complaints)

## Tacton CPQ — constraint-solver configuration for industrial manufacturers with combinatorially huge products

### Who it's for & pricing reality
Industrial manufacturers (machinery, compressors, trucks) whose products have more valid combinations than any rules tree can enumerate. **No public license pricing** — demo-led enterprise sales; SelectHub pegs subscription entry "roughly $100–$500" (unverified). Deployment is partner-led product-modeling work in Tacton's modeling environment before sellers see anything. Aggregate satisfaction ~87% across 72 reviews (SelectHub roll-up).

### The screens that matter
- **Configurator**: a needs panel (questionnaire-style) plus a spec panel; **every click re-solves the model** — BOM, customer net price and (where modeled) 3D visual update per selection; invalid combinations are never offerable because the solver auto-selects compatible modules and validates all constraints in real time.
- **Pricing engine**: dynamic price models by market/segment/channel with cost drivers (currency, material cost, shipping); one-time/recurring/usage types; any adjustment type including **goal-seeking** ("adjust the net price to ensure a certain margin level"); multi-step escalation/approval workflows on margin overrides.
- **CAD/visual config**: auto-generated drawings and 3D from the same model.

### Click-path notes
Needs → valid config → quote: answer **any subset of questions in any order**; the solver completes the remainder optimally and keeps the whole state valid — no dead ends, no forced sequence, change-your-mind-anytime. That guarantee, not the UI, is the product.

### What users complain about
G2/SelectHub themes: **expensive; steep learning curve; "interface less intuitive than competitors"; limited customization**; implementation depth gaps — "the company does not have the depth in key knowledge areas… the gap is only managed with 3rd party implementation support which is inferior" (SoftwareReviews via SelectHub).

### Verdicts
| Capability | Verdict | Why / how it maps to Factory OS |
|---|---|---|
| Constraint solver: declarative facts, order-independent, no dead ends | ADAPT | Keep the *guarantees* (any entry order, whole-config validation on each change, explain-why-disabled tooltips) but implement as exhaustive evaluation of our `OptionConstraint` rows — a suit has dozens of options, not 10^12 combos; no CSP engine needed. |
| Needs-based guided selling questionnaire | IGNORE | The customer's email IS the needs capture; the Owner translates it directly in a party-scoped configurator. |
| Live BOM + price recompute on every click | ADOPT | Configurator right rail: running price, margin, and material lines (leather m², lining, armor set) recompute per toggle — the same lines later drive Work Order material reservations. |
| Goal-seeking pricing (target margin ⇄ net price) | ADOPT | Two-way field on the quote screen: type the customer's target price → margin shows; type target margin → net price fills. Ideal for email haggling over one-off pieces. |
| Market/currency/material-cost price drivers | ADAPT | No live indices: editable cost fields on materials (e.g., cowhide €/m²) so one update re-prices every template's cost basis; EUR only. |
| Margin-override approval workflows | IGNORE | Owner approves himself; the margin-floor badge (Salesforce row) already covers it. |
| CAD / 3D visual configuration | IGNORE | Made-to-measure leather is paper patterns and craftsmanship, not parametric CAD; reference photos in the quote PDF suffice. |

The deliberately skipped 80%, named: subscription/usage billing, contract lifecycle, partner/distributor discount tiers, rules DSLs with evaluation order, approval chains, template designers, questionnaires, CAD/3D, multi-currency market models, AI agents. What survives for pricing a made-to-measure cowhide suit: option groups with cost+price deltas, requires/excludes constraints, per-party price lists, a 4-line margin-visible waterfall, goal-seek, and snapshot-on-send versioning.

### Sources
- https://www.tacton.com/buyer-engagement-platform/configuration/ · https://global.tacton.com/products/tacton-cpq/configurator/ (configurator, live BOM/price)
- https://www.tacton.com/cpq-blog/constraint-based-vs-rules-based-configuration-the-advantage-for-complex-manufacturing/ (constraint vs rules)
- https://www.tacton.com/buyer-engagement-platform/pricing/ (pricing engine, goal-seeking, approval workflows)
- https://www.tacton.com/learn/concepts-explained/ (concepts)
- https://www.g2.com/products/tacton-cpq/reviews · https://www.selecthub.com/p/cpq-software/tacton/ · https://www.softwarereviews.com/products/tacton-cpq?c_id=267 (reviews/complaints, unpublished pricing)

---

## Long-tail ERP/MRP sweep — 14 platforms scanned, gems extracted

Breadth pass to prove the field is covered. Each verdict is argued from THIS factory's reality — Owner + a few workers, one-off made-to-measure leather work, orders born in Gmail, $0 infrastructure — not from generic best practice. Pricing checked against July 2026 sources; quote-only vendors marked as reported ranges.

### NetSuite (+ Manufacturing)
Oracle's mid-market cloud suite; manufacturing arrives via WIP & Routings / Advanced Manufacturing modules and SuiteSuccess Manufacturing bundles. Real-world pricing: base license ~$999–$5,000/mo plus $99–$199/user/mo plus ~$600–$3,000/mo for manufacturing modules, annual contract, everything negotiated (Softype, Broken Rubik, ERP Research). Its order→production surface is the canonical linked record chain — Estimate → Sales Order → Work Order → Fulfillment → Invoice, every record audit-trailed and traceable via "created from" links, with saved searches doubling as ad-hoc reports and alerts. The one thing it does well that we want: that unbroken chain; nothing downstream is an orphan. Not our answer: five figures a year before a single customization, SaaS-only, and its chain starts at a CRM form — ours must start one step earlier, inside the Gmail thread.
**Verdict:** linked document chain with created-from trace: ADAPT — extend it upstream to the email; platform: IGNORE (cost, breadth, cloud).

### Microsoft Dynamics 365 Business Central
Microsoft's SMB ERP; manufacturing (production orders with Simulated→Planned→Firm Planned→Released→Finished lifecycle, routings, work/machine centers, planning worksheets) requires Premium at $110/user/mo (Essentials $80 — both raised Nov 2025), and partner implementations for manufacturers reportedly start around $30k (Elliott Clark, DynamicsSmartz). Screens are dense list pages with a role-center dashboard. The steal: "Edit in Excel" — virtually any list round-trips to Excel and publishes back, making bulk-operability a platform guarantee rather than a per-screen favor. Not our answer: per-user tax on production workers, partner-led setup, and zero notion of email-born quoting.
**Verdict:** Edit-in-Excel-grade bulk grids: ADAPT — every Factory OS table gets import/export + bulk edit by construction; platform: IGNORE.

### Acumatica (Manufacturing Edition)
Partner-sold mid-market cloud ERP whose signature is consumption licensing: unlimited users, priced by transaction tier — reported ~$15k–$45k/yr for entry-to-mid tiers plus $25k–$150k implementations (ERP Research, Protelo). Manufacturing Edition covers BOM/routing, production orders, estimating, MRP; the UI is grid-first with side panels (click a row, a contextual detail rail opens without leaving the list) and user-built generic inquiries. Steal: the licensing philosophy — seats are never rationed, so shop-floor workers are first-class users — plus the side-panel grid pattern. Not our answer: tens of thousands per year for a team you can count on one hand.
**Verdict:** unlimited seats + side-panel grids: ADAPT — $0 local-first already makes every worker a user; side panels fit our order grid; platform: IGNORE.

### Epicor Kinetic
Discrete-manufacturing ERP for job shops up to mid-market plants, with genuine MES: quote→job→schedule→operator clock-in/out on operations, actuals feeding job costing. Reviewers call it "powerful but not always intuitive," complain of script-reading first-line support, and resent the cloud-only push (G2, Gartner Peer Insights). The steal is the MES station: an operator screen reduced to big Start/Stop buttons against the current operation — actual minutes flow back into cost without anyone "using the ERP." Not our answer: enterprise weight, consultant dependence, price.
**Verdict:** big-button operator station: ADAPT — CUTTING→STITCHING→ASSEMBLY→QC→PACKING each get a phone-sized Start/Done view that writes the audit trail; platform: IGNORE.

### Infor (M3 / CloudSuite Fashion)
Enterprise ERP with the deepest apparel DNA in the market: native style–color–size matrix, season/line planning, multi-site sourcing; even Infor-aligned analysts point companies under ~$50M revenue elsewhere (ERP Research, infor.com). Steal: matrix-native order entry — a B2B size run (2×S, 5×M, 3×L of one jacket style) is one grid row, not ten line items. Not our answer: it exists for brands with factories, plural, and armies of planners.
**Verdict:** size/color matrix order entry: ADAPT — B2B brand orders enter as a matrix row that explodes into per-size work orders; platform: IGNORE.

### Priority Software
Israeli mid-market ERP (sweet spot ~50–500 employees), cloud reportedly from ~$60–150/user/mo, liked for flexibility and rapid go-lives (ERP Research, SelectHub). Manufacturing covers BOM/MRP/floor reporting; its distinctive trait is business-process flowcharts attached to documents — status transitions are visible, admin-editable diagrams instead of buried configuration. Not our answer: still a per-user, partner-flavored suite with breadth we would never touch.
**Verdict:** status flows as visible diagrams: ADAPT — order/WO status is a pipeline the Owner can see and (within guardrails) edit, not a hidden enum; platform: IGNORE.

### ERPNext (open-source — deeper look)
Free, GPL, on the Frappe framework; v16 current in 2026. Manufacturing is genuinely complete on paper: multi-level and phantom BOMs, Production Plan → Work Orders → auto-generated Job Cards per operation, workstations with capacity planning, and v16 added stock reservation for work orders plus consolidated MPS/MRP planner views (Frappe docs, Solufy). Quality is workable-but-rough: open GitHub bugs show job cards sticking in "Work In Progress" after completion (frappe/erpnext #52028, #54335), and the operator experience is doctype-forms-first, not floor-first. Self-hosting is not a binary but a stack — MariaDB, three Redis instances, Node, Python workers, wkhtmltopdf — with real recurring sysadmin burden ("Redis memory exhaustion silently breaks background jobs" — ECOSIRE); Frappe Cloud from ~$25/mo removes that but breaks $0-local. Would self-hosting rival building our own? It is the only credible free full ERP and beats us on breadth (accounting, HR, buying) — but it loses the golden flow: no Gmail-thread-born quoting, Item Variants are not a live-margin configurator, and its generic-ERP UI fails zero-training for a tiny team. It is the benchmark to stay honest against, not the base to build on.
**Verdict:** docstatus discipline (Draft→Submitted→Cancelled + Amend; nothing submitted is silently editable): ADOPT; material reservation against work orders: ADOPT; platform as our base: IGNORE — stack weight vs SQLite-local, and our differentiator is absent.

### Fishbowl
QuickBooks-companion inventory/manufacturing for US SMBs; now subscription (reported from ~$329–399/mo) layered over a legacy perpetual model (~$4,395/user historically; Manufacturing ~$6,595), split into Advanced (on-prem Windows client) and Drive (cloud). Complaints center on escalating module/user/support costs — "seeking assistance often entails spending thousands of dollars" (Research.com, PricingNow). The steal is its boundary discipline: own operations, delegate the ledger to QuickBooks instead of rebuilding accounting. Not our answer: dated client UX, module nickel-and-diming, no quoting/CPQ story at all.
**Verdict:** "own ops, delegate the ledger": ADAPT — Factory OS owns the flow and delegates mail to Gmail, files to Drive, books to the commercialista's tools; platform: IGNORE.

### Cin7 Core (ex-DEAR)
Retail/ecommerce inventory suite with bolt-on manufacturing; $349/$599/$999 per month tiers (cin7.com). Standard tier does BOMs and auto-assembly kitting — selling a kitted item auto-builds it and deducts components; Advanced adds production BOMs and resource scheduling; a reviewer verdict: "the production module was very poor" (Software Connect). Steal: the reflex that a demand document directly fires the build. Not our answer: channel-retail DNA, monthly cost, thin production depth.
**Verdict:** demand-doc-triggers-build: ADAPT — our approved quote auto-explodes into the Work Order with reservations, same reflex but deeper; platform: IGNORE.

### Unleashed
NZ-born SMB inventory for makers/distributors; Core $399/mo with a +$69/mo production module — multi-level BOMs, assembly costing, kanban production board (unleashedsoftware.com). The complaint that matters: "you can't relate a BOM to a sales order or a customer when you print out the BOM to be manufactured" — production is orphaned from the order that caused it. Not our answer: stock-first worldview, no routing/stages, per-month cost.
**Verdict:** order-blind production: BEAT — in Factory OS the Work Order is born FROM the customer's order and Gmail thread, so customer, chosen options, and thread link ride on every stage traveler; platform: IGNORE.

### Fulcrum (fulcrumpro.com)
Promoted to a full deep teardown after this sweep flagged it — the registered verdicts live in the dedicated Fulcrum section above (live cost breakdown + margin flag: ADOPT; capable-to-promise at quote: ADAPT; platform: IGNORE — cost, hosting, and email remains send-only).

### Craftybase
Micro-manufacturing bookkeeping for handmade sellers (Etsy/Shopify), $49–$349/mo (craftybase.com). Recipes (BOMs) roll material costs up automatically; it computes true per-product cost (materials + labor + overhead) and suggests a retail price from a target margin; when a supplier price or recipe changes, cost and suggested price ripple across every affected product. That is our pricing-model soul, shipped at hobby scale. Not our answer: no orders-from-email, no work orders or production stages, no B2B price lists — seller bookkeeping, not factory operations.
**Verdict:** cost roll-up → target-margin suggested price + reprice ripple: ADOPT — this is the configurator's pricing engine UX, extended with per-customer price lists and visible margin; platform: IGNORE.

### Genius ERP
Canadian ERP for custom/ETO SMB manufacturers; custom-quoted, positioned by analysts among the stronger options "under $200,000 in implementation cost" (Software Advice). Its flagship is CAD2BOM: generate the BOM and routing from a SolidWorks/Inventor/AutoCAD drawing "at the push of a button," with engineering changes propagating into purchasing and production; users praise support, knock self-serve reporting. Steal: the spec artifact IS the BOM source — never re-key an engineered one-off. Not our answer: implementation weight and engineer-centric DNA; our spec is an option sheet and a measurement form, not a drawing.
**Verdict:** spec-artifact→BOM compilation: ADAPT — configurator selections compile deterministically into the Work Order's material list; the option sheet is our CAD; platform: IGNORE.

### JobBOSS² (ECI)
The default small-job-shop ERP: quote→job→traveler→whiteboard schedule→ship→invoice; cloud reportedly ~$100/user/mo plus $5k–15k implementation (Top10ERP). Its estimating recalls similar historical quotes — find the near-identical part you quoted before, adjust material cost and quantity, re-issue. Complaints: a finicky web app that randomly logs users out, inflexible reporting, and paid add-ons users feel "should be standard" (Capterra). Steal: quote memory. Not our answer: per-user SaaS on a dated substrate, machine-shop assumptions everywhere.
**Verdict:** similar-quote recall in estimating: ADOPT — the configurator surfaces this customer's and this garment-type's past quotes with won/lost outcomes and prices; platform: IGNORE.

### Gems worth stealing

| Capability (source) | Verdict | Factory OS mapping |
|---|---|---|
| Live cost breakdown + negative-margin flag on the quote (Fulcrum) | ADOPT | Configurator shows cost lines and margin beside the price; the capable-to-promise date rides along as ADAPT (registered in the Fulcrum deep teardown) |
| Similar-quote recall from history (JobBOSS²) | ADOPT | Surface this customer's / this garment-type's past quotes with won/lost prices while quoting |
| Target-margin suggested price + supplier-cost reprice ripple (Craftybase) | ADOPT | Pricing engine: cost roll-up → suggested price; leather price change flags every affected option/quote |
| Docstatus immutability + amend-revision (ERPNext) | ADOPT | Sent quotes and confirmed orders freeze; changes create audited revisions |
| Material reservation against work orders (ERPNext v16) | ADOPT | Order confirmation reserves hides/linings/armor against the WO |
| Spec-artifact→BOM compilation (Genius CAD2BOM) | ADAPT | Option sheet + measurement form compile deterministically into the WO material list |
| Size/color matrix order entry (Infor M3 Fashion) | ADAPT | B2B size-run rows that explode into per-size work orders |
| Big-button operator MES station (Epicor Kinetic) | ADAPT | Phone-sized Start/Done per stage; actuals feed cost and audit trail |
| Edit-in-Excel-grade bulk grids (Business Central) | ADAPT | Import/export + bulk edit on every table by construction |
| Unlimited seats + side-panel grids (Acumatica) | ADAPT | $0 local = everyone gets a seat; row-click side rail on order/WO grids |
| Linked document chain with created-from trace (NetSuite) | ADAPT | Email → Quote → Order → WO → Label → Review, every hop linked and audited |
| Status flows as visible diagrams (Priority) | ADAPT | Order/WO pipeline rendered as a visible, guarded status flow |
| Own ops, delegate the ledger (Fishbowl) | ADAPT | Delegate mail/files/books to Gmail/Drive/accountant; own only the flow |
| Demand-doc-triggers-build (Cin7 Core) | ADAPT | Quote approval auto-explodes into WO + reservations |

### Deserves a deeper teardown?
- **Fulcrum — done.** Promoted to a dedicated deep teardown (see its section above) after this sweep flagged it as the only commercial product philosophically adjacent to ours. Residual unknowns sit behind its gated help center (win/loss analytics is marked unverified there).
- **ERPNext — yes.** The free-forever benchmark and the strongest "why not just self-host this?" objection. A focused memo should pin exactly where our golden flow beats it (Gmail-born quotes, live-margin configurator, zero-training floor view) and mine its doctype/workflow internals for schema ideas.
- **Craftybase — small pass.** One focused look at its pricing/COGS screens to calibrate our margin UX; nothing else to learn there.
- **Everything else — no.** The remaining eleven fail the $0/tiny-team/email-origin filter at the positioning level; further study would only re-prove it.

### Sources
- NetSuite pricing: https://softype.com/blogs/netsuite-pricing-2026-complete-breakdown-costs-licenses-hidden-fees ; https://www.brokenrubik.com/blog/netsuite-pricing-the-definitive-guide ; https://www.erpresearch.com/pricing/oracle-netsuite ; https://netsuite.folio3.com/blog/netsuite-manufacturing-pricing/
- Business Central: https://www.elliottclarkconsulting.com/post/dynamics-365-business-central-pricing ; https://www.dynamicssmartz.com/blog/microsoft-dynamics-365-business-central-cost/ ; https://www.microsoft.com/en-us/dynamics-365/products/business-central/pricing
- Acumatica: https://www.erpresearch.com/pricing/acumatica ; https://www.proteloinc.com/acumatica-pricing-guide ; https://www.acumatica.com/media/2026/05/Acumatica-Licensing-Guide-April2026-Final-May-21.pdf
- Epicor Kinetic: https://www.g2.com/products/epicor-kinetic/reviews ; https://www.gartner.com/reviews/market/cloud-erp-for-product-centric-enterprises/vendor/epicor/likes-dislikes
- Infor Fashion: https://www.infor.com/industries/fashion ; https://www.erpresearch.com/en-us/infor-cloudsuite-for-fashion
- Priority: https://www.erpresearch.com/en-us/priority-erp ; https://www.selecthub.com/p/business-management-software/priority-erp/
- ERPNext: https://frappe.io/erpnext/open-source-manufacturing-erp-software ; https://docs.erpnext.com/docs/user/manual/en/job-card ; https://github.com/frappe/erpnext/issues/52028 ; https://github.com/frappe/erpnext/issues/54335 ; https://www.solufyerp.com/erp-blog/the-ultimate-guide-to-erpnext-v16-features-improvements/ ; https://ecosire.com/blog/erpnext-hosting-options-compared ; https://frappe.io/cloud/pricing
- Fishbowl: https://www.capterra.com/p/123794/Fishbowl/pricing/ ; https://research.com/software/reviews/fishbowl-inventory ; https://pricingnow.com/question/fishbowl-inventory-cost/
- Cin7 Core: https://www.cin7.com/pricing/ ; https://softwareconnect.com/reviews/cin7-core/
- Unleashed: https://www.unleashedsoftware.com/pricing/ ; https://www.capterra.com/p/126644/Unleashed/
- Fulcrum: https://fulcrumpro.com/ ; https://fulcrumpro.com/manufacturing-software/quoting-software-for-manufacturing ; https://softwareconnect.com/reviews/fulcrum-pro/ ; https://www.g2.com/products/fulcrum-fulcrum/reviews
- Craftybase: https://craftybase.com/pricing ; https://craftybase.com/blog/how-to-determine-product-pricing
- Genius ERP: https://www.geniuserp.com/ ; https://www.softwareadvice.com/manufacturing/genius-manufacturing-profile/ ; https://thecfoclub.com/tools/genius-erp-review/
- JobBOSS²: https://www.ecisolutions.com/products/jobboss2/ ; https://www.capterra.com/p/219273/JobBOSS/reviews/ ; https://www.top10erp.org/products/jobboss%C2%B2/pricing
