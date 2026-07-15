# EPO — Orders UI Inventory (total interaction surface + backend contract + cross-page wiring)

> Scope: the entire clickable/typeable surface of the Orders workspace at `apps/factory` — the board (grid + kanban), the OrderDetail view, all five modals, the one-timeline — PLUS the backend contract behind it (routes, state machine, money exposure, events/audit coverage) and the cross-page wiring in both directions (every hop-link that exists, every dead-end, every deep-link contract other pages honor). Read-only audit (research for `EPO-PROPOSAL.md`); no code changed. Line numbers as of 2026-07-11 research.
>
> Source files:
> - `src/app/(app)/orders/page.tsx`, `.../_components/OrdersClient.tsx`, `OrderDetail.tsx`, `Timeline.tsx`, `KanbanBoard.tsx`, `OrderItems.tsx`, `types.ts`
> - Libs: `src/lib/orders/{transitions,timeline,production,money}.ts`, `src/lib/financials/{rollup,load}.ts`, `src/lib/use-factory-events.ts`
> - API: `src/app/api/orders/**`, `/api/exports/orders`, `/api/parties-lite`, `/api/financials/order/[id]`, `/api/quotes/[id]/convert`, `/api/search`
> - Adjacent surfaces audited for reuse: shipping `BuyPanel`/`ShipmentDrawer`, financials `MoneyDrawer`, production WO drawer, contacts `ContactDetail`/`ContactHistory`, quotes `QuoteEditor`/`ConvertBar`, inbox `ContextRail`, `NotificationBell`, `CommandPalette`
>
> Permission keys in play: page `PAGES.orders`; `orders.edit` (`canEdit`), `orders.cancel` (`canCancel`), `payments.record` (`canPay`), `labels.purchase` (`canBuyLabel`), `exports.run` (server-side on export); money grains `financials.prices.view` / `financials.margins.view` / `financials.costs.view` via `stripFinancials` (name-based: any `*Cents`).
> Durable events published by orders routes: `order.updated` (state change only), `payment.recorded`, `workorder.created`/`workorder.updated` (via payments/start-production). Events NOT published: promise-date change, line edit (see §6e).

---

## Surface 0 — Route anatomy

- `page.tsx:4-6` renders `<OrdersClient/>` only. `PipelineInner` is wrapped in `<Suspense fallback={null}>` (`useSearchParams` at OrdersClient.tsx:52).
- **Single-route trick:** `?o=<orderId>` (OrdersClient.tsx:69) swaps the ENTIRE board for `<OrderDetail>` (:186). Board and detail share one route — no nested routing.
- Nav writes use `history.replaceState` + a synthetic `PopStateEvent` (`openDetail`/`closeDetail`, :126-127) — **no history entries are created; browser Back does not close the detail** (UX trap).
- Three states: (A) grid list + (B) kanban under `factory-page factory-grid-grow-2` (:189 — Party col index 2 absorbs slack, `globals.css:99-102`), (C) detail under `factory-page--centered` (OrderDetail.tsx:115, 1180px).

## Surface 1 — Board header (shared by grid + kanban)

| Surface | Element | Label (exact) | Visibility / enablement | Handler → API → effect → feedback |
|---|---|---|---|---|
| header | PageHeader | eyebrow `Factory OS`, title `Orders`, subtitle (operational-board line) | always | display (OrdersClient.tsx:190) |
| counters | hand-rolled tile ×3 | `In production` / `Awaiting deposit` / `Overdue` | always; render `data?.counters.x ?? 0` → **literal 0s before load, pop-in shift** | display only; tones primary/warning/danger, warn/danger only when >0 (:192-194). NOT clickable, NOT SSE-live. minWidth:120 (:38) |
| header right | raw `<a>` | `Export CSV` | always (not client-gated) | `GET /api/exports/orders` — streamed CSV, id-spine 500-batches, money cols server-gated on `financials.margins.view` (exports/orders/route.ts:13-15). **Ignores all active filters** (:196) |
| header right | hand-rolled 2-button toggle | `Grid` / `Kanban` | always | `switchView` (:72) → `setView` + `localStorage["factory:orders:view"]`. No `role`, no aria, no keyboard grouping (:197-200) |

## Surface 2 — Grid view (`OrdersClient.tsx:203-243`)

### 2a. Toolbar

| Element | Label | Visibility | Handler → effect |
|---|---|---|---|
| tab pill ×7 | `All / Confirmed / In production / Ready / Shipped / Delivered / Cancelled` (+count badge from `data.counts`) | grid view only (:205) | `setState(t.id)` → 200ms-debounced `GET /api/orders?state=<tab>` (+q, partyId) (:207-211). Raw buttons, no `role=tab` |
| Party filter | Listbox `All parties` + each party | only if `parties.length>0` (mounts AFTER `/api/parties-lite` resolves → toolbar shift) (:215-219) | `setPartyId` → refetch with `&partyId=`. Source unpaged (FS3 AsyncCombobox adoption assigned to EPO) |
| Search | raw `<input>` placeholder search number/party | always | `setQ` → debounced `&q=` LIKE on number OR party name (:220) |

### 2b. DataGrid columns (`:224-239`)

| Column | Cell content | Interactive? | Notes |
|---|---|---|---|
| Order | number as link-styled `<button>` | `openDetail(r.id)` (:226) | no hover/focus style |
| Party | `r.party.name` plain text | **NO — dead-end** (:227) | `/contacts?c=` honors a link; none rendered |
| State | Pill inside DS `Menu` of `legalTargets` | transition per item (:173-184) | plain Pill if `!canEdit` or no legal targets; `CANCELLED` item filtered unless `canCancel`; `blocked` warning Pill if `r.woBlocked` |
| Net | `eur(netCents)` right-aligned | no | **renders `eur(0)`=€0,00 when grain-stripped** (keys off `lineCount`, not `netCents` presence) (:229-230) |
| Margin | `marginPct` | no | column only when `canMargin` |
| Deposit | chip due/paid | no | from `depositRequired/PaidCents` |
| Promise | date, red+bold if overdue | no | `toLocaleDateString()` (:232) |
| WOs | count | no | plain number, no link |
| Updated | date | no | (:234) |

Empty state: bare string `No orders yet — they arrive when you convert an accepted quote.` (:238) — purpose line but **no action link**. **No pagination UI: grid caps at server TAKE=200; API returns `nextCursor` (route.ts:97) that the grid branch ignores (:102-107)** — orders past 200 silently vanish. No selection column, no BulkActionBar, no saved views, no date filter.

### 2c. Transitions from the grid (state cell menu)

| Target | Wiring |
|---|---|
| non-terminal (e.g. READY) | `transition()` (:129-142) → `PATCH /api/orders/:id {state}` → `load()` + toast `Moved to <label>` with **Undo** button when the reverse edge is legal (:137); Undo → `PATCH {state: back}` + toast `Reverted` (:143-146) |
| CANCELLED | opens Cancel modal (§4.1) (:130) |
| SHIPPED | opens **Mark-shipped modal (§4.2 — STALE FP8 stopgap)** (:131) |
| CONFIRMED→IN_PRODUCTION | never offered as a plain edge; server refuses with `useStartProduction` (transitions.ts:75, route :93) |

## Surface 3 — Kanban view (`KanbanBoard.tsx`)

- `DndContext`, PointerSensor `distance:5` (:75) — **no KeyboardSensor: drag-to-transition is mouse/touch only**.
- 5 lanes = `BOARD_LANES` CONFIRMED · IN_PRODUCTION · READY · SHIPPED · DELIVERED (transitions.ts:36); Cancelled/Closed are grid tabs only. Lanes `flex:1 0 220px`, container `overflowX:auto` (:51,90).
- Lane header: label + true count `n of TOTAL` (:52-56; FS1 fix). Lane body: cards, `—` when empty (:59 — no EmptyState), `Load N more` when `nextCursor` (:60-64) → `loadMoreLane` appends (`OrdersClient.tsx:113-122`).
- Card (:22-46): number link-button (`onMouseDown` stops drag, :26), `eur(net)`, party name (ellipsis, no tooltip :29), deposit dot, `blocked` pill, promise date. Drag end → `onMove(r,to)` (:82-87) → OrdersClient:155-158: CONFIRMED→IN_PRODUCTION routes to Start-production; **SHIPPED lane is a legal drop target → opens the stale manual Mark-shipped modal** (IA law says "cannot drop into SHIPPED without a shipment"). `!canEdit` ⇒ toast `You can't change order status` (:241).
- Kanban `load()` fires **6 parallel requests** (counts `countsOnly=1` + 5 lanes) (OrdersClient.tsx:92-101).

## Surface 4 — Order detail (`OrderDetail.tsx`)

Layout: `factory-page--centered`; body grid `minmax(0,1fr) | 340px` (:138); **340px rail is hard — never stacks at narrow widths**. Loading state = bare Card with only a Back button (:106) — no Skeleton.

### 4a. Header + sub-line

| Element | Label | Visibility | Handler → API |
|---|---|---|---|
| DetailHeader back | `All orders` | always | `closeDetail` → replaceState `/orders` + `load()` (:116-117) |
| title | `ORD-n` + state Pill | always | display |
| Button primary (Hammer) | `Start production` | `canEdit && state==="CONFIRMED"` (:122) | opens §4.3 modal |
| Button primary (Truck) | `Buy label` | `canBuyLabel && state==="READY"` (:123) | hard nav `window.location.href='/shipping?buy=<id>'` |
| Menu | `Change status` | `canEdit && legalTargets>0` (:124) | item → `patch({state})`; PATCH returns the full fresh payload → `setD` + toast + Undo (:61-71, route :110-111) |
| sub-line link | `from <quote.number>` | if `bornFromQuote` (:130) | `/quotes?q=<id>` ✓ |
| sub-line link | `thread` | if `conversation` (:131) | `/inbox?focus=<convId>` ✓ |
| sub-line text | party name | always | **plain text — dead-end** (:129) |
| banner (hand-rolled div) | cancel reason | `state===CANCELLED && cancelReason` (:134-136) | display; raw wash hex fallback |

### 4b. Right rail (340px)

| Card | Contents | Actions | Gating |
|---|---|---|---|
| `Money` | Net / Cost / Margin (`orderTotals` fold — **not** `orderFinancials`; **no invoiced/paid/balance/actual margin anywhere on this page**) | `+ Record payment` link-button → §4.4 (kind=BALANCE) (:152) | card hidden when money stripped (:148); `canPay` for the action |
| `Deposit (FD13)` | Required / Paid + due chip | `Record deposit` full-width Button → §4.4 (kind=DEPOSIT, amount prefilled with remainder) (:167) | shown when `depositRequiredCents>0` (:160); `depositDue && canPay` |
| `Dates` | Promise DateField (noon-ISO or null) + Confirmed date | `patch({promiseDateAt})` (:175) | `disabled={!canEdit}`. **No original-promise, no slip history; change publishes NO event** |
| `Work orders` | WO number + stage + state Pill per row | **NONE — plain text, no link to /production** (:186-194) | — |
| footer link | `Open quote <n> ↗` | `/quotes?q=` (:200-202) | if `bornFromQuote` |

### 4c. Timeline (left pane; `Timeline.tsx` + `lib/orders/timeline.ts`)

Event kinds merged (10): `email, quote, quote-sent, quote-accepted, order, payment, workorder, transition, shipment, review` — sources: linked Conversation, bornFromQuote (created/sentAt), AuditLog (`quote/accepted`, `order/state-changed` excl. CONFIRMED), payments, workOrders (+`blocked:` suffix), shipments, reviews (timeline.ts:46-86; assembled inline in detail GET, route :33-58 — no standalone endpoint).

| kind | icon | tone | href |
|---|---|---|---|
| email | Mail | text-3 | `/inbox?focus=` ✓ |
| quote / quote-sent | FileText / Send | text-3 | `/quotes?q=` ✓ |
| quote-accepted | CheckCircle2 | success | **none** |
| order | ClipboardCheck | primary | **none** |
| payment | Euro | success | **none** (no /financials hop) |
| workorder | Hammer | warning | **none** (no /production hop) |
| transition | ArrowRight | text-3 | **none** |
| shipment | Truck | text-3 | **none** (label-bought only; no tracking/delivered events) |
| review | Star | text-3 | **none** |

Rendering: 28px icon circle over a 2px spine; label 13/600 + optional `eur(amountCents)` mono; meta ts via `toLocaleString()` (**browser locale — inconsistent** with grid `toLocaleDateString()` and DS `formatDate` en-GB); rows keyed by INDEX (:39,57); linked rows wrap in `next/link` with `.factory-timeline-row` hover.
**Timeline MISSES:** invoices (not even in `DETAIL_INCLUDE`, route :22-31), comments, `line-edited` + `promise-changed` + `deposit-met` audits, WO **stage** progress, shipment tracking/delivery, the cancellation **reason** (dropped from `after.reason`), material movements.

### 4d. Items pane (`OrderItems.tsx`)

Line rows: description ×qty + size-run summary. `Edit size run` / `+ Size run` link-button (:54) gated `canEdit && state==="CONFIRMED"` (:24) → §4.5. **Lines lock entirely after CONFIRMED — no add/remove-line surface exists at all** (no API route either).

## Surface 5 — Modals (all DS `Modal` size="sm", portaled, Esc+backdrop close; NO Drawer used on this page)

| # | Modal | Trigger(s) | Fields (validation) | Buttons | API + feedback |
|---|---|---|---|---|---|
| 4.1 | **Cancel** — DUPLICATED in OrdersClient:245-251 AND OrderDetail:238-244 | grid menu →CANCELLED; detail Change-status | raw textarea `Why is this order being cancelled?` (reason required); body: `A reason is required. Open work orders are cancelled with the order.` | `Keep order` / danger `Cancel order` (disabled `!reason.trim()||busy`) | `POST /api/orders/:id/cancel {reason}` → load + toast `Order cancelled` info |
| 4.2 | **Mark shipped** (board only) OrdersClient:253-259 | grid menu →SHIPPED; kanban drop into SHIPPED | raw input `Tracking number / carrier (optional)`; body VERBATIM: **“Shipments & labels arrive in FP8 — for now this records the shipped state manually.”** | `Cancel` / primary `Mark shipped` | `PATCH {state:"SHIPPED", note}` → toast `Marked shipped`. **STALE: FP8 shipped long ago; this path bypasses the real shipment flow entirely** |
| 4.3 | **Start production** OrderDetail:207-217 | header button (CONFIRMED) | none; body: `This creates {plannedCount} work order(s)…`; deposit-due warning wash `blocked from cutting until you record it` / success wash | `Not yet` / primary `Start production` | `POST …/start-production {}` → `{workOrders, blocked}`; toast warning if blocked else success |
| 4.4 | **Record payment** OrderDetail:220-236 | Money `+ Record payment` (BALANCE) / Deposit `Record deposit` (DEPOSIT + prefill) | Kind Listbox (Deposit/Balance/Other) · Amount € raw number input (finite>0 else toast `Enter an amount`) · Method raw input optional | `Cancel` / primary `Record` | `POST …/payments {kind, amountCents, method}` → `{unblocked}`; toast `…deposit met, N work order(s) unblocked` when unblocked>0. **No idempotency key — double-submit = duplicate Payment row** |
| 4.5 | **Size run** OrderItems:61-77 | per line, CONFIRMED only | dynamic rows size/qty + remove, `+ Add size`; body: `Enter a quantity per size. Each size becomes its own work order.` | `Clear` / `Cancel` / primary `Save (N)` (disabled total===0) | `PATCH …/lines/:lid {sizeRun: obj\|null}` → detail reload + toast. **Publishes NO event** |

## Surface 6 — Backend contract

### 6a. Domain model (schema.prisma)

Order (:410-434): `number` unique `ORD-n`, `partyId` required, `bornFromQuoteId?`, `conversationId?`, `state` default CONFIRMED, `promiseDateAt?`, `cancelReason?`; relations lines/workOrders/shipments/invoices/payments/reviews; indexes `[state,promiseDateAt]`, `[partyId]`, `[createdAt]`. OrderLine (:436-448): description, `selections Json?`, `sizeRun Json?`, qty, `netPriceCents`, `costCents`. Payment (:683-694): kind DEPOSIT|BALANCE|OTHER, `amountCents`, method?, receivedAt, notes?.

Dangle risks: `bornFromQuoteId` null ⇒ **deposit gate silently OFF** (depositPct unreachable, money.ts:27-41); `Quote.convertedOrderId` is a bare String (NOT a FK); `conversationId` null ⇒ timeline loses email origin; Shipments have **no line linkage**; Comment/Attachment polymorphic, unwired to orders UI; **no version column** (no optimistic locking; only `updatedAt`).

### 6b. Route table

| Route | Method | Permission | Audit | Event |
|---|---|---|---|---|
| `/api/orders` | GET | PAGES.orders | — | — (list: state/lane/cursor/countsOnly/q/partyId; TAKE 200 grid/100 lane; counters+counts) |
| `/api/orders/[id]` | GET | PAGES.orders | — | — (detail + inline timeline + `orderTotals` money) |
| `/api/orders/[id]` | PATCH | orders.edit | `state-changed` / `promise-changed` | `order.updated` on state only; **promise change: NO event** |
| `/api/orders/[id]/cancel` | POST | orders.cancel | `state-changed` (order-level only; **no per-WO rows** for the cascade) | `order.updated` |
| `/api/orders/[id]/payments` | POST | payments.record | `recorded` + `deposit-met` | `payment.recorded` + `workorder.updated` (**no idempotency**) |
| `/api/orders/[id]/start-production` | POST | orders.edit | `state-changed` (order-level) | `order.updated` + `workorder.created` (409 if WOs exist) |
| `/api/orders/[id]/lines/[lid]` | PATCH | orders.edit | `line-edited` | **NONE** |
| `/api/financials/order/[id]` | GET | PAGES.financials | — | — (full `orderFinancials` + invoices + payments; **not consumed by orders UI**) |
| `/api/quotes/[id]/convert` | POST | quotes.convert | `order.created` | `pricing.updated` (**no order.created event type**) |
| `/api/exports/orders` | GET | exports.run | — | — |

No `POST /api/orders` (convert is the only create). No line add/delete routes. No bulk endpoints. No order import.

### 6c. State machine (`lib/orders/transitions.ts`)

`CONFIRMED→IN_PRODUCTION|CANCELLED · IN_PRODUCTION→READY|CANCELLED · READY→SHIPPED|IN_PRODUCTION(rework)|CANCELLED · SHIPPED→DELIVERED · DELIVERED→CLOSED · CANCELLED→CONFIRMED(reopen)`. Guards: start-production is the only CONFIRMED→IN_PRODUCTION path; cancel requires reason; `from===to` rejected. **NOT guarded:** READY→SHIPPED requires no Shipment row (manual override legal); deposit gate blocks WOs only, never the order lifecycle.
Real drivers since FP6/FP8: IN_PRODUCTION→READY (production stages route :65), READY→SHIPPED (shipping/buy :75), SHIPPED→DELIVERED (poll-tracking :54), SHIPPED→READY (void :30 — **edge exists only in the void driver, not in the canTransition graph**). **All four call `prisma.order.update` directly, bypassing `canTransition`** — the single-authority guarantee holds only for `/api/orders` routes.

### 6d. Money exposure

`orderFinancials` (rollup.ts:51-85) computes quoted/invoiced/paid/**balance**, deposit trio, est+**actual** cost/margin (`actualIsPending`), via 4 SQL aggregates (load.ts). The orders page instead uses the lesser `orderTotals` fold — list rows and detail expose net/cost/est-margin/deposit only. **Balance owed, invoiced, paid total, actual margin are invisible on /orders**, locked behind `PAGES.financials`.

### 6e. Events/audit coverage — silent-change violations

promise-date change: audited, **no event**. Line edit: audited, **no event**. Cancel/payment/start-production WO cascades (`updateMany`): **no per-WO audit rows** (aggregate only). Convert publishes no `order.created`-typed event (board learns via `pricing.updated`).

## Surface 7 — Cross-page wiring

### 7a. Deep-link contracts honored today (what /orders can link TO with zero foreign changes)

`/inbox?focus=<convId>` · `/quotes?q=<quoteId>` · `/orders?o=<orderId>` · `/contacts?c=<partyId>` · `/shipping?buy=<orderId>` (READY-queue only). **No reader exists** on /production, /materials, /financials, /analytics (`?tab=` only on /products).

### 7b. Working links vs dead-ends around orders

Working: detail→inbox/quotes/shipping-buy (§4a); timeline email/quote rows; financials MoneyDrawer→`/orders?o=` ✓; contacts ContactHistory→`/orders?o=` ✓ (the canonical pattern); analytics→page-level `/orders` (no focus).
**Dead-ends (entity rendered plain, no link):** orders grid/kanban/detail party name; detail WO rail + timeline workorder/payment/shipment/review/transition/order/quote-accepted rows; invoices (no surface on the order at all); quotes `ConvertBar` "Converted to an order" Banner (**static text; copy still says "The Orders board arrives in FP4"**; `convertedOrderId` in hand, ConvertBar.tsx:36-38); inbox ContextRail `order` Pill (id discarded, ContextRail.tsx:247); production cards/WO drawer orderNumber+party plain (ProductionClient.tsx:131-234); shipping ready/inflight grids order+party plain (ShippingClient.tsx:77-94); financials party names plain (:102-154). **Bell: no order-href emitter exists anywhere** (FC1-SUBSTRATE:7 confirms "FC1 invents the order deep-link").
**Search route (`api/search/route.ts`) emits `?focus=` for EVERY entity (:34,46,61,74,86) but only inbox reads `?focus=`** — palette/search jumps to orders/quotes/contacts/products/materials/production land on the page but never open the entity. One-file fix: emit `?o=`/`?q=`/`?c=`.

### 7c. Adjacent-surface reuse contracts

| Surface | Opens via | Data/actions | Reuse verdict for EPO |
|---|---|---|---|
| Shipping `BuyPanel` | `?buy=<orderId>` **only if order in ready queue** (ShippingClient:50-55) | presets→rates (`POST /api/shipping/rates`)→buy (`POST /api/shipping/buy`) | link as-is (already used) |
| Shipping `ShipmentDrawer` | state `detailId` (shipment id) — **no param** | `GET /api/shipping/:id`; share-tracking / void / label / events timeline (inline, not importable) | needs `?ship=` reader + shipmentId on order payload — coordination item |
| Financials `MoneyDrawer` | state only — no param | `GET /api/financials/order/:id` = the clean rollup payload; invoice create/send/mark-paid; PaymentModal hits the SAME `/api/orders/:id/payments` | **prefer embedding the payload on /orders (grain-gated) over navigation**; `?o=` reader on /financials = EPF handoff |
| Production WO drawer | state `openWo` (WO id) — **no param, page reads none** | `GET /api/production/wo/:id`; stages/timers/assign/QC | needs `?wo=` reader + OrderDetail WO rows become links; `StageTimer` + `QCChecklist` + `STAGE_LABEL` are importable today |
| Contacts detail | `?c=` ✓ works | `ContactHistory` is EXPORTED + pure (deep-links back to `/orders?o=`) | link party names now; reuse ContactHistory for any party mini-view |
| Quotes editor | `?q=` ✓ works | ConvertBar owns convert | EPQ-side one-liner: Banner → `/orders?o=` backlink |
| SSE | `useFactoryEvents(types, cb, {debounceMs=2000})` — `order.updated`, `workorder.*`, `shipment.updated`, `payment.recorded` all published; **consumed by analytics, NOT by /orders** | — | mirror AnalyticsClient:47 wiring; FS2 shipped → durable + gap-free |

## Surface 8 — DS usage + debt

**Used:** PageHeader, DetailHeader, Card (`padded` only — headers hand-rolled), DataGrid (no selectable/initialSort/maxHeight), Menu, Modal, Listbox, DateField, Button, Pill, useToast, `eur()`.
**Available-but-unused where they slot:** Tabs (7 raw tab buttons), SegmentedControl (view toggle), MetricStrip (counters), Banner (cancel/deposit washes), EmptyState (grid string, kanban `—`), Pagination (grid 200-cap), PreferencesModal (fixed 9 columns), GridToolbar ("Viewing N of M"), FilterBar (multi-filter + date range), BulkActionBar (+ `selectable`), Stepper (lifecycle header), FileDropzone (attachments), Skeleton (detail/board loading), Input primitive (every raw input incl. € adornment), Combobox→FS3 AsyncCombobox (party filter — adoption assigned to EPO), Drawer (detail-as-peek option).
**Element-level debt:** raw `#fff`/wash-hex fallbacks/rgba shadows (OrdersClient:34,208,246; OrderDetail:25,135,212,214; KanbanBoard:42,57,98); zero `:focus-visible` on all link-styled buttons; kanban has no KeyboardSensor (core-loop keyboard FAIL, §6 law); placeholder-only inputs without label association; counters 0→pop + late-mounting party filter + conditional rail cards = layout shift; grid Party col `width:100%` without ellipsis (variable row height); THREE date formats on one page (`toLocaleString` / `toLocaleDateString` / DS `formatDate` unused); font sizes 10.5–22px off the 13/12.5/11.5 scale; radii raw px not tokens; Cancel modal + transition/undo logic duplicated across OrdersClient and OrderDetail.
