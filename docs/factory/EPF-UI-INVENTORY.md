# EPF-UI-INVENTORY — Total UI inventory: Financials `/financials`

Produced 2026-07-11 for the EPF cycle under the EP research completeness standard (ENTERPRISE-PROGRAM.md, protocol item 2): every surface, every control with its full wiring chain (handler → API route → service → DB writes → events/notifications), every navigation edge in and out. Neutral inventory — quality findings live in `EPF-PROPOSAL.md`. Scope root: `apps/factory/src/app/(app)/financials/**` and every server path it reaches. Paths are relative to `apps/factory/src`; `file:line` throughout (as of commit `38574b84`).

## Page-level facts (apply to every surface below)

- Entry component: `app/(app)/financials/page.tsx:4` → renders `<FinancialsClient/>` (`app/(app)/financials/_components/FinancialsClient.tsx:24`).
- Whole page gated by `pages.financials` at the nav layer (`lib/nav.ts:165`) and at every read route (`export const permission = PAGES.financials`). A WORKER never sees the nav entry (`lib/auth/permissions.ts:111-119`, `SYSTEM_ROLES.WORKER` lacks `pages.financials`).
- Four client permission probes (`FinancialsClient.tsx:26-29`):
  - `canMargin = usePermission("financials.margins.view")` → `FIELDS.marginsView`
  - `canInvoice = usePermission("invoices.manage")` → `FEATURES.invoicesManage`
  - `canPay = usePermission("payments.record")` → `FEATURES.paymentsRecord`
  - `canImport = usePermission("imports.run")` → `FEATURES.importsRun`
  - `usePermission` = `useAuth().has` (`lib/auth/client.tsx:94`, `70`); resolves from `/api/auth/me`; OWNER or `permissions.has(p)`.
- **Money grain-stripping** (`lib/auth/strip-financials.ts:37`, invoked by `jsonStripped` in `lib/auth/guard.ts:76`): every `*Cents`/`*Pct` key is DELETED from JSON responses unless the caller holds the matching grain — `marginsView` for `margin*`, `costsView` for `*CostCents`, `pricesView` for any other `*Cents` (`strip-financials.ts:23-34`). Consequence: a holder of `pages.financials` WITHOUT `financials.prices.view` sees every money value render as `—` (`money()` = `c == null ? "—"` at `FinancialsClient.tsx:22`). OWNER (`resolved.isOwner`) bypasses stripping (`strip-financials.ts:38`).
- **No URL/query state**: the client uses no `useSearchParams`/`useRouter`; `tab` and `detailId` are local React state only (grep for `useSearchParams|useRouter|focus=` in `financials/**` returns nothing). No `?tab=`, no `?focus=`.
- **No SSE**: `FinancialsClient` does not import `useFactoryEvents`; the page never subscribes to the bus. Refresh is manual via `refreshAll` (`FinancialsClient.tsx:69`). (Contrast `AnalyticsClient.tsx:15` which does subscribe.)
- Fetch plumbing: `apiJson`/`apiFetch` (`lib/api-client.ts:21-36`) — same-origin, auto-mirrors `factory_csrf` cookie into `x-factory-csrf` header on mutating methods; sets `content-type: application/json` when a body is present; throws `Error(body.error ?? "HTTP <status>")` on non-2xx.
- Server guard on every route: `guarded()` (`lib/auth/guard.ts:32`) — CSRF double-submit check on POST/PATCH (`guard.ts:34-40`), session validate, `resolvePermissions` (`lib/auth/rbac.ts:16`), `hasPermission` (`rbac.ts:32`); in `enforce` mode a denial writes an `auth/access.denied` AuditLog and returns 403 (`guard.ts:52-64`), in `shadow` mode it logs and allows (`guard.ts:65-67`).

## 1. Surface tree (every surface incl. states)

```
/financials  (page — pages.financials)                         FinancialsClient.tsx:24
├─ Header
│  ├─ Title "Financials" + subtitle                            :76-78
│  ├─ [Import bank CSV] button        (visible iff canImport)  :80
│  └─ [Export period] link  <a> → /api/exports/financials      :81
├─ Tile row (4 display-only tiles, non-interactive)            :85-90
│  ├─ Outstanding balance   (tone warning)                     :86
│  ├─ Deposits due          (tone danger)                      :87
│  ├─ Invoiced this month                                      :88
│  └─ Paid this month        (tone success)                    :89
├─ Tab bar (4 TabBtn)                                          :92-97
│  ├─ By order    (default)                                    :93
│  ├─ By customer                                              :94
│  ├─ By month                                                 :95
│  └─ Deposits outstanding (N)  ← count shown iff deposits>0   :96
├─ Tab body (exactly one of):
│  ├─ STATE tab=party   → DataGrid customers                   :99-112
│  │     empty: "No customers with orders yet."                :111
│  │     Margin (actual) column present iff canMargin          :107
│  ├─ STATE tab=month   → DataGrid months                      :113-127
│  │     empty: "No months with orders yet."                   :126
│  │     Margin (actual) column iff canMargin                  :122
│  ├─ STATE tab=orders  → DataGrid orders                      :128-144
│  │     empty: "No orders yet — money lands here as quotes convert."  :142
│  │     Order # = drill button; Balance pill "paid" when 0    :131,137
│  │     Margin column (MarginCell) iff canMargin              :138
│  │     ├─ "Showing N of M" truncation note (>200 orders)     :145-149
│  └─ STATE tab=deposits→ DataGrid deposits                    :150-164
│        empty: "No deposits outstanding — nothing on the floor is waiting on money."  :162
│        Order # = drill button; Blocked WOs pill              :153,158
├─ MoneyDrawer  (open iff detailId != null)                    :166,177-254
│  ├─ Loading state: drawer open, body empty until detail      :202 (title "Money")
│  ├─ Title "Money · <ORD-n>"                                  :202
│  ├─ Close: X button / Esc / backdrop (design-system)         Drawer.tsx:29,39,51
│  ├─ Figures grid: Quoted/Invoiced/Paid/Balance               :211-215
│  │     + Margin fig (est|actual) iff canMargin               :216
│  ├─ Invoices section                                         :219-236
│  │     empty: "No invoices yet."                             :221
│  │     per invoice: PDF link, amount, status Pill,           :222-234
│  │       [Send] (iff canInvoice && !sentAt && !paidAt)       :229
│  │       [Mark paid] (iff canInvoice && !paidAt)             :230
│  ├─ Payments section                                         :238-249
│  │     empty: "No payments yet."                             :240
│  └─ Footer (iff detail loaded)                               :202-208
│        [New invoice]   iff canInvoice                        :204
│        [Record payment] iff canPay                           :205
│        [Open order] <a> → /orders?o=<id>  (always)           :206
├─ PaymentModal (open iff payFor != null)  size=sm             :167,265-293
│     Close: Cancel / X / Esc / backdrop                       Modal.tsx:29,38,50
│     Title "Record payment — <ORD-n>"                         :285
│     fields: Kind (Listbox), Amount(€), Method                :287-289
│     footer: [Cancel] [Record]                                :285
├─ ImportModal (open iff importOpen)  size=md                  :168,295-352
│     Close: Cancel/Back / X / Esc / backdrop                  Modal.tsx
│     STATE A (no proposals): CSV textarea                     :332-336
│        footer: [Cancel] [Match] (disabled if !csv.trim)      :330
│     STATE B (proposals): checkbox list of matches            :337-349
│        empty: "No rows parsed."                              :339
│        footer: [Back] [Apply selected] (iff canPay)          :328
└─ Toasts (useToast, transient)                                :25, many
      success/danger per handler (enumerated in §2 notes)
```

## 2. Control table per surface

### Surface: Header (`FinancialsClient.tsx:74-83`)

| control | visibility / enabled | permission | handler | API call | service chain | DB writes | audit | events / notifications |
|---|---|---|---|---|---|---|---|---|
| **Import bank CSV** button (`:80`) | visible iff `canImport` | `imports.run` (client); server route `FEATURES.importsRun` | `onClick={() => setImportOpen(true)}` | none (opens ImportModal) | — | — | — | — |
| **Export period** link `<a>` (`:81`) | always rendered (NO client perm gate) | server route `FEATURES.exportsRun`; margin cols additionally need `financials.margins.view` | plain anchor `href="/api/exports/financials"` (GET, full request) | `GET /api/exports/financials` (optional `?from=&to=`, client sends none) | `exports/financials/route.ts:15` → `loadOrderFinancials(createdAt)` (`lib/financials/load.ts:33`) → `orderFinancials` fold + `vatDisplay` (`rollup.ts:149`) + `AppSetting financials.defaults` read + `toCsv` (`lib/csv.ts`) | reads Order/OrderLine/Payment/Invoice/MovementLedger/Material/AppSetting; **no writes** | none | none |

### Surface: Tiles (`:85-90`) — display-only, **no controls** (no onClick). Values from `data.tiles` (`GET /api/financials`).

### Surface: Tab bar (`:92-97`, `TabBtn` `:173-175`)

| control | visibility / enabled | permission | handler | API call (lazy on first activate) | service chain |
|---|---|---|---|---|---|
| **By order** (`:93`) | always | page perm | `setTab("orders")` | data already loaded on mount: `GET /api/financials` | `financials/route.ts` → `loadOrderFinancials` → `tiles` |
| **By customer** (`:94`) | always | page perm | `setTab("party")` | `GET /api/financials/party` (fires iff `parties==null`, `:60`) | `party/route.ts:9` → `partyRollup(loadOrderFinancials())` (`rollup.ts:108`) |
| **By month** (`:95`) | always | page perm | `setTab("month")` | `GET /api/financials/period` (iff `months==null`, `:61`) | `period/route.ts:9` → `periodRollup(loadOrderFinancials())` (`rollup.ts:124`) |
| **Deposits outstanding (N)** (`:96`) | always; badge count iff `deposits.length>0` | page perm | `setTab("deposits")` | `GET /api/financials/deposits` (iff `deposits==null`, `:59`) | `deposits/route.ts:18` → `loadOrderFinancials(undefined,{excludeStates:["CANCELLED","CLOSED"],sorted:false})` + `prisma.workOrder.groupBy(state=BLOCKED)` → `depositsOutstanding` (`rollup.ts:141`) |

All four are read-only GETs; **no writes / audit / events**.

### Surface: Orders DataGrid (`:128-144`)

| control | visibility / enabled | permission | handler | API call | service chain | writes/audit/events |
|---|---|---|---|---|---|---|
| **Order number** button (`:131`) | one per row | page perm | `openDetail(r.orderId)` → `setDetailId` + `loadDetail` (`:68`) | `GET /api/financials/order/{id}` | `order/[id]/route.ts:15` → `prisma.order.findUnique(...)` + `actualCostByOrder` (`actual-cost.ts:9`) → `orderFinancials` fold | none (read) |
| Balance cell (`:137`) | display; Pill "paid" when `balanceCents===0` | — | — | — | — | — |
| Margin cell `MarginCell` (`:138,366`) | column present iff `canMargin` | `financials.margins.view` | — (display) | — | — | — |

### Surface: Deposits DataGrid (`:150-164`)

| control | visibility | permission | handler | API call | service chain |
|---|---|---|---|---|---|
| **Order number** button (`:153`) | one per row | page perm | `openDetail(r.orderId)` | `GET /api/financials/order/{id}` | same as above (opens MoneyDrawer) |
| Blocked WOs Pill (`:158`) | display iff `blockedWorkOrders>0` | — | — | — | count from `workOrder.groupBy` in deposits route |

Customer & Month DataGrids (`:99-127`): **no interactive controls** — all cells are display renders. Margin column gated by `canMargin`.

### Surface: MoneyDrawer (`:177-254`)

| control | visibility / enabled | permission | handler (`file:line`) | API call (method + path + body) | service chain (server) | DB writes | audit | events / notifications |
|---|---|---|---|---|---|---|---|---|
| **New invoice** (`:204`) | footer; iff `canInvoice`; `disabled={busy}` | client `invoices.manage`; route `FEATURES.invoicesManage` | `createInvoice` (`:181-189`) | `POST /api/invoices` body `{ orderId: detail.order.id }` | `invoices/route.ts:24` → `prisma.order.findUnique` → validate lines>0 & amount>0 → `AppSetting financials.defaults` (vatRatePct) + `AppSetting factory.name` reads → `nextNumber("invoice")` (`counters.ts:10`) → `renderInvoicePdf` (`render-invoice.ts:24`) → write PDF to `data/invoices/<id>.pdf` (fs) | `Invoice.create` (`:50`); `Invoice.update pdfRef` (`:53`); `AppSetting` upsert `counter.invoice` (`counters.ts:15`) | `audit invoice/created` (`:55`) | `order.updated {orderId}` durable (`:56`) — via `publishEventDurable` → in-proc bus + `FactoryEventOutbox.create` (`events.ts:75-86`). **No notification created.** |
| **Record payment** (`:205`) | footer; iff `canPay` | client `payments.record` | `onPay({id,number})` → `setPayFor` (`:166`) | none (opens PaymentModal) | — | — | — | — |
| **Open order** link (`:206`) | footer; always | page perm | plain `<a href="/orders?o=<id>">` (full-page nav) | GET `/orders?o=<id>` | — (navigation OUT) | — | — | — |
| **Invoice PDF** link (`:223`) | one per invoice row | route GET `PAGES.financials` | `<a href="/api/invoices/<id>" target="_blank">` | `GET /api/invoices/{id}` | `invoices/[id]/route.ts:17` → `prisma.invoice.findUnique(pdfRef)` → stream file (`Content-Type: application/pdf`) | none (read) | none | none |
| **Send** (invoice) (`:229`) | iff `canInvoice && !iv.sentAt && !iv.paidAt`; `disabled={busy}` | client `invoices.manage`; route `FEATURES.invoicesManage` | `invAction(iv.id,"send")` (`:190-197`) | `PATCH /api/invoices/{id}` body `{ action:"send" }` | `invoices/[id]/route.ts:28` → validate `!sentAt` → `Invoice.update{sentAt}` | `Invoice.update sentAt` (`:38`) | `audit invoice/sent` (`:39`) | `order.updated` + `payment.recorded` both fired (`:49-50`) even for send. **No notification.** |
| **Mark paid** (invoice) (`:230`) | iff `canInvoice && !iv.paidAt`; `disabled={busy}` | `invoices.manage` | `invAction(iv.id,"paid")` (`:190-197`) | `PATCH /api/invoices/{id}` body `{ action:"paid" }` | `invoices/[id]/route.ts:40` → validate `!paidAt` → `$transaction[ Invoice.update{paidAt}, Payment.create{kind:BALANCE, amountCents:inv.amountCents, method:"invoice", notes:"Fattura <n>"} ]` | `Invoice.update paidAt` (`:43`); `Payment.create` BALANCE (`:44`) | `audit invoice/paid` (`:46`) + `audit order/payment-recorded` (`:47`) | `order.updated` + `payment.recorded` durable (`:49-50`). **No notification.** |
| Close (X / Esc / backdrop) | drawer open | — | `onClose` → `setDetailId(null)` (`:166`) | none | — | — | — | — |

Toasts from drawer handlers: `Invoice <n> created` success (`:187`); `Marked paid — a balance payment was recorded` / `Marked sent` success (`:194`); error toast danger on catch (`:188,196`).

### Surface: PaymentModal (`:265-293`)

| control | visibility / enabled | permission | handler | API call | service chain | DB writes | audit | events / notifications |
|---|---|---|---|---|---|---|---|---|
| Kind Listbox (`:287`) | modal open | — | `setKind` | — | — | — | — | — |
| Amount input (`:288`) | modal open | — | `setAmount` | — | — | — | — | — |
| Method input (`:289`) | modal open | — | `setMethod` | — | — | — | — | — |
| **Cancel** (`:285`) | always | — | `onClose` → `setPayFor(null)` | none | — | — | — | — |
| **Record** (`:285`) | `disabled={busy}` | client gated by canPay (button only reachable via drawer's Record-payment, itself canPay); route `FEATURES.paymentsRecord` | `submit` (`:273-283`) | `POST /api/orders/{target.id}/payments` body `{ kind, amountCents, method: method||undefined }` | `orders/[id]/payments/route.ts:25` → `Order.findUnique(lines,payments,bornFromQuote,workOrders)` → `Payment.create` → deposit-gate calc (`orderTotals`,`depositRequiredCents`,`depositPaidCents`,`isDepositMet` `lib/orders/money.ts`) → if met & BLOCKED WOs: `workOrder.updateMany → READY` | `Payment.create` (`:41`); conditionally `WorkOrder.updateMany{state:READY,blockedReason:null}` (`:55`) | `audit payment/recorded` (`:45`); conditionally `audit order/deposit-met` (`:57`) | `payment.recorded {orderId,paymentId,kind}` (`:46`); conditionally `workorder.updated {orderId,unblocked}` (`:58`). **No notification.** |

Client validation (`:275-276`): `cents = Math.round(parseFloat(amount.replace(",","."))*100)`; if `!(cents>0)` → toast `"Enter an amount"` danger, abort. Success toast `Payment recorded — N work order(s) unblocked` when `r.unblocked>0` else `Payment recorded` (`:280`).

### Surface: ImportModal (`:295-352`)

| control | visibility / enabled | permission | handler | API call | service chain | DB writes | audit | events |
|---|---|---|---|---|---|---|---|---|
| CSV textarea (`:335`) | STATE A | — | `setCsv` | — | — | — | — | — |
| **Match** (`:330`) | STATE A; `disabled={busy \|\| !csv.trim()}` | route `FEATURES.importsRun` | `dryRun` (`:303-313`) | `POST /api/imports/payments` body `{ rawCsv: csv }` | `imports/payments/route.ts:26` → `parseBankCsv` (`bank-match.ts:54`) → `prisma.order.findMany(state≠CANCELLED)` → build `MatchTarget[]` (`orderTotals` net−paid balance) → `matchBankRows` (`bank-match.ts:45`) → `jsonStripped` proposals | none (dry-run, read-only) | none | none |
| **Cancel** (`:330`) | STATE A | — | `onClose` → `setImportOpen(false)` | none | — | — | — | — |
| Row checkbox (`:342`) | STATE B; `disabled={!p.orderId}`; default-checked for matched rows (`:309`) | — | `setPick` | — | — | — | — | — |
| **Back** (`:328`) | STATE B | — | `setProposals(null)` (returns to STATE A) | none | — | — | — | — |
| **Apply selected** (`:328`) | STATE B; iff `canPay`; `disabled={busy}` | client `payments.record`; route needs `imports.run` AND server re-checks `hasPermission(paymentsRecord)` (`:32`) | `apply` (`:314-324`) | `POST /api/imports/payments` body `{ apply: [{orderId, amountCents, note:"Bank: <desc>".slice(0,200)}] }` | `imports/payments/route.ts:31` → per item `Order.findUnique` → `Payment.create BALANCE method:"bank import"` | `Payment.create` per applied row (`:37`) | `audit payment/recorded` per row (`:38`) | `payment.recorded {orderId,paymentId,kind:BALANCE}` per row (`:39`). **No notification, no deposit-gate/WO unblock in the import path.** |
| Close (X/Esc/backdrop) | modal open | — | `onClose` | none | — | — | — | — |

Client validation/toasts: `dryRun` — if `proposals.length===0` toast `r.note ?? "No rows parsed"` danger (`:311`). `apply` — if no selected matched rows → toast `"Select at least one matched row"` danger (`:317`); success `N payment(s) recorded` (`:321`). `note` truncated to 200 chars client-side (`:316`), re-validated `.max(200)` server-side (`:23`).

### Surface: Toasts (`useToast` `:25`)

Read-path error toasts: `load` (`:42`), `loadDeposits` (`:48`), `loadParties` (`:52`), `loadMonths` (`:56`), `loadDetail` (`:66`) — each `toast((e as Error).message, "danger")`. Action toasts enumerated inline above. Toast text is the raw server `error` string surfaced by `apiJson` (`api-client.ts:34`).

## 3. Fields table per form

### Form: Create invoice (implicit — no UI fields; `FinancialsClient.tsx:185`)

| field | source | validation (server `invoices/route.ts`) | default |
|---|---|---|---|
| `orderId` | `detail.order.id` (hidden) | `z.string().min(1)` (`:22`) | — (required) |
| `netCents` | not sent by client | `z.number().int().positive().optional()` (`:22`) | falls back to `orderTotals(lines).netCents` (`:35`) |
| (derived) `vatRatePct` | — | — | `AppSetting("financials.defaults").value.vatRatePct ?? 22` (`:38-39`) |
| (derived) `factoryName` | — | — | `AppSetting("factory.name").value.name ?? "Nexus Factory"` (`:40-41`) |
| (derived) `number` | — | — | `nextNumber("invoice")` → `INV-<n>` (`counters.ts:8-19`) |
| guard: lines | — | `order.lines.length===0` → 400 "Add a line to the order first" (`:33`) | — |
| guard: amount | — | `amountCents<=0` → 400 (`:36`) | — |

### Form: Invoice action (`FinancialsClient.tsx:193`)

| field | validation | default |
|---|---|---|
| `action` | `z.enum(["send","paid"])` (`invoices/[id]/route.ts:26`) | — (required); send rejects if `sentAt` set, paid rejects if `paidAt` set |

### Form: PaymentModal (`FinancialsClient.tsx:287-289`)

| field | UI control | client validation | server validation (`orders/[id]/payments/route.ts:18-23`) | default |
|---|---|---|---|---|
| `kind` | Listbox: Deposit / Balance / Other | — | `z.enum(["DEPOSIT","BALANCE","OTHER"]).default("DEPOSIT")` | `"DEPOSIT"` (reset on open `:271`) |
| `amountCents` | number input, `step=0.01 min=0` | `Math.round(parseFloat(amount.replace(",","."))*100)` must be `>0` else toast (`:275-276`) | `z.number().int().positive("Amount must be positive")` | `""` (empty) |
| `method` | text input | sent as `method || undefined` | `z.string().trim().max(80).optional()` | `""` |
| `notes` | *(not in UI)* | — | `z.string().trim().max(500).optional()` — never sent by this form | — |

### Form: ImportModal (`FinancialsClient.tsx:335,342`)

| field | UI control | client handling | server validation (`imports/payments/route.ts:21-24`) | default |
|---|---|---|---|---|
| `rawCsv` | textarea (mono) | Match disabled unless `csv.trim()` | `z.string().optional()` | `""`; placeholder `date,amount,description\n2026-07-01,500.00,Bonifico ORD-1` |
| CSV parse | — | server: header must name `date`/`amount(importo)`/`desc(causale/reference)` columns; EUR comma-or-dot, optional €/sign (`bank-match.ts:54-89`) | — | rows with zero/NaN amount dropped (`:65`) |
| `apply[].orderId` | checkbox picks | only rows with `orderId` selectable (`:342`) | `z.string().min(1)` | matched rows pre-checked (`:309`) |
| `apply[].amountCents` | — | from proposal `p.amountCents` | `z.number().int().positive()` | — |
| `apply[].note` | — | `"Bank: <description>".slice(0,200)` (`:316`) | `z.string().max(200).optional()` | — |

## 4. Read-path table per tab / tile

| tab / tile | endpoint (method) | query params (client-sent) | route file | lib functions folded through | Prisma reads |
|---|---|---|---|---|---|
| Tiles ×4 + By-order table | `GET /api/financials` | none (route accepts `?from&to`) | `api/financials/route.ts:14` | `loadOrderFinancials(createdAt)` (`load.ts:33`) → `orderFinancials` (`rollup.ts:51`); `tiles` (`rollup.ts:90`); table = `fins.slice(0,200)`, `ordersTotal` (`route.ts:26`) | 4 SQL aggregates: Order+Party+Quote base, OrderLine sum, Payment groupBy, Invoice groupBy, MovementLedger×Material actual (`load.ts:45-65`) |
| By customer | `GET /api/financials/party` | none | `party/route.ts:9` | `partyRollup(loadOrderFinancials())` (`rollup.ts:108`) | same 4 aggregates |
| By month | `GET /api/financials/period` | none | `period/route.ts:9` | `periodRollup(loadOrderFinancials())` (`rollup.ts:124`) | same 4 aggregates |
| Deposits outstanding | `GET /api/financials/deposits` | none | `deposits/route.ts:18` | `loadOrderFinancials(undefined,{excludeStates:["CANCELLED","CLOSED"],sorted:false})` + `depositsOutstanding` (`rollup.ts:141`); `blockedByOrder` map | 4 aggregates + `workOrder.groupBy(state=BLOCKED)` (`:21`) |
| MoneyDrawer detail | `GET /api/financials/order/{id}` | path `id` | `order/[id]/route.ts:15` | `actualCostByOrder` (`actual-cost.ts:9`) → `orderFinancials` (`rollup.ts:51`) | `order.findUnique`(lines,payments,invoices,bornFromQuote,workOrders) + `movementLedger.findMany` + `material.findMany` |
| Export (header link) | `GET /api/exports/financials` | none (accepts `?from&to`) | `exports/financials/route.ts:15` | `loadOrderFinancials(createdAt)`; `vatDisplay` (`rollup.ts:149`); `toCsv` (`csv.ts`) | 4 aggregates + `AppSetting("financials.defaults")` |
| Invoice PDF (drawer link) | `GET /api/invoices/{id}` | path `id` | `invoices/[id]/route.ts:17` | streams `pdfRef` file | `invoice.findUnique(pdfRef,number)` |

All read routes: `permission = PAGES.financials` (except export = `FEATURES.exportsRun`; invoice-GET = `PAGES.financials`). All wrap response in `jsonStripped` → grain-stripping (except export/PDF which are non-JSON; export applies its own `canMargin` column gate `exports/financials/route.ts:16,27`).

## 5. Navigation edges

### OUT of /financials

| edge | target | type | source `file:line` |
|---|---|---|---|
| Export period | `/api/exports/financials` (GET) | `<a>` file download | `FinancialsClient.tsx:81` |
| Open order (drawer footer) | `/orders?o=<orderId>` | `<a>` full-page nav | `FinancialsClient.tsx:206` |
| Invoice PDF | `/api/invoices/<id>` (`target="_blank"`) | `<a>` new tab / PDF | `FinancialsClient.tsx:223` |
| Order # drill (orders tab) | in-page MoneyDrawer (no route change) | button → `openDetail` | `FinancialsClient.tsx:131` |
| Order # drill (deposits tab) | in-page MoneyDrawer | button → `openDetail` | `FinancialsClient.tsx:153` |

(No `router.push`, no `next/link` — every outbound edge is a raw `<a>` or an in-page state change.)

### IN to /financials

| source | mechanism | permission filter | `file:line` |
|---|---|---|---|
| Sidebar nav (FactoryShell) | renders `FACTORY_PAGES.filter(has(p.permission))`; active-state on pathname match | `pages.financials` | nav def `lib/nav.ts:160-175`; render `components/FactoryShell.tsx:62-69` |
| Command palette "Go to" | `FACTORY_PAGES.filter(has(p.permission))` → `router.push(href)` | `pages.financials` | list `CommandPalette.tsx:48-56`; push `:76-82`, invoked `:139` / `:175` |
| Analytics "Margin by customer (actual)" panel | `<Panel href="/financials">` → "Open" `<a>` | none on the link (page perm enforced on arrival) | `AnalyticsClient.tsx:93` via `charts.tsx:29` |
| Analytics "Margin by month (actual)" panel | `<Panel href="/financials">` → "Open" `<a>` | none on the link | `AnalyticsClient.tsx:96` via `charts.tsx:29` |

No notifications, inbox items, quotes, orders, or email templates deep-link into `/financials` (grep `"/financials"` across `apps/factory/src` returns only the four inbound sources above plus the page's own outbound API calls). No deep-link carries query/hash state into the page (the page reads none).

## 6. Keyboard + URL-state map

### Keyboard

| shortcut | scope | action | source |
|---|---|---|---|
| `⌘K` / `Ctrl+K` | global (app shell, not page-specific) | toggle Command Palette (which can navigate to `/financials`) | `CommandPalette.tsx:28-37` |
| `Esc` | Command Palette open | close palette | `CommandPalette.tsx:33` |
| `↑` / `↓` / `Enter` | Command Palette input | move cursor / navigate to selected href | `CommandPalette.tsx:130-140` |
| `Esc` | MoneyDrawer / PaymentModal / ImportModal | close surface (`onClose`) | `Drawer.tsx:29`, `Modal.tsx:29` |
| (backdrop click) | drawer/modal | close | `Drawer.tsx:39`, `Modal.tsx:38` |
| (X button, `aria-label="Close"`) | drawer/modal header | close | `Drawer.tsx:51`, `Modal.tsx:50` |
| `Esc` | Listbox (Payment Kind) open | close listbox | `Listbox.tsx:37` |

**The Financials page itself defines no keyboard shortcuts.**

### URL / query state

| state | stored where | notes |
|---|---|---|
| active tab (`orders`/`party`/`month`/`deposits`) | local React `useState` (`:33`) | NOT reflected in URL; not deep-linkable |
| open order drawer (`detailId`) | local React `useState` (`:31`) | NOT in URL; no `?focus=`/`?o=` read |
| PaymentModal target (`payFor`) | local state (`:38`) | — |
| ImportModal open (`importOpen`) | local state (`:37`) | — |
| `?from` / `?to` | consumed only server-side by `GET /api/financials` (`route.ts:16-18`) and `GET /api/exports/financials` (`route.ts:17-20`) | **client never sends them** — dormant capability; no date-range UI on the page |

The page has no `useSearchParams`/`useRouter`/history writes; navigating to `/financials?anything` is inert — the client ignores all query params.

## 7. Wiring-chain summary (all DB writes / audit / events reachable from this page)

- **Prisma models written**: `Invoice` (create + update sentAt/paidAt/pdfRef), `Payment` (create — via drawer mark-paid, PaymentModal, ImportModal apply), `WorkOrder` (updateMany → READY on deposit-met), `AppSetting` (upsert `counter.invoice`), `AuditLog` (append), `FactoryEventOutbox` (append per durable publish). Filesystem: `data/invoices/<id>.pdf`.
- **AuditLog actions emitted**: `invoice/created`, `invoice/sent`, `invoice/paid`, `order/payment-recorded`, `payment/recorded`, `order/deposit-met`, plus guard `auth/access.denied` (enforce-mode 403).
- **Events published** (`publishEventDurable` → bus + outbox, `events.ts:75`): `order.updated`, `payment.recorded`, `workorder.updated`. Event types enumerated in `events.ts:9-23`.
- **Notifications**: **none** — no financials mutation calls `notify()` (`lib/notifications.ts:9`); the bell is not fed from this page.
