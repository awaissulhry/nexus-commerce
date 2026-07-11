# EPQ — Quotes UI Inventory (total interaction surface)

> Scope: the entire clickable/typeable surface of the Quotes workspace at `apps/factory` — the pipeline list, the New-quote modal, the QuoteEditor (configurator + right rail), the SendModal, the ConvertBar, and the public customer accept page at `/q/[token]`. Every row = one interactive element with its visibility/enablement gates, handler, API call (method + path), server effect (DB writes / state changes), events & notifications emitted, and UI feedback. Read-only audit; no code changed.
>
> Source files:
> - `src/app/(app)/quotes/page.tsx`, `.../_components/QuotesClient.tsx`, `QuoteEditor.tsx`, `SendModal.tsx`, `ConvertBar.tsx`, `types.ts`
> - `src/app/q/[token]/page.tsx` (public accept page)
> - Design-system primitives/components consumed: `DataGrid`, `Modal`, `Listbox`, `DateField`, `Banner`, `Pill`, `Button`, `Checkbox`, `RadioCard`, `Toast`, `EuroInput` (`products/_components/money.tsx`)
> - API: `src/app/api/quotes/**`, `src/app/api/q/[token]/**`, `src/app/api/exports/quotes`, `src/app/api/parties-lite`, `src/app/api/settings/pricing-defaults`, `src/app/api/products/preview` & `/templates`, `src/app/api/search`
>
> Permission keys in play: `quotes.create` (`FEATURES.quotesCreate`), `quotes.send` (`FEATURES.quotesSend`, server-only), `quotes.convert` (`FEATURES.quotesConvert`), `financials.margins.view` (`FIELDS.marginsView` → `canMargin`), `financials.costs.view` (`canCost`), page access `PAGES.quotes`.
> Durable events: `pricing.updated`, `conversation.updated`. Notifications: `STATE_CHANGE` to all active OWNER users (public accept/reject only).

---

## Surface 1 — Pipeline page (`QuotesClient` → `PipelineInner`)

Rendered when there is **no** `?q=` param. Wrapped in `<Suspense fallback={null}>`. Data loads from `GET /api/quotes?state=<tab>&q=<search>` on a 200 ms debounce whenever `state` or the search box changes.

### 1a. Header + counters + top-right actions

| Surface | Element | Label (exact) | Visibility / enablement | Handler → API → server effect → events → feedback |
|---|---|---|---|---|
| page | PageHeader (static) | eyebrow `Factory OS`, title `Quotes`, subtitle `The RFQ pipeline: configure, price with margin, send into the thread, track to won or lost.` | always | none (display) |
| page · counter | stat tile | `Drafts` + `data.counters.drafts` | always; value 0 until load | display only; value = `prisma.quote.count({state:"DRAFT"})`. Tone `--h10-text`. |
| page · counter | stat tile | `Awaiting approval` + `data.counters.awaiting` | always | display; value = count of `state:"SENT"`. Tone `--h10-primary`. |
| page · counter | stat tile | `Overdue` + `data.counters.overdue` | always | display; value = count of `state ∈ {DRAFT,SENT}` AND `validUntilAt < now`. Tone `--h10-danger` iff `overdue>0`, else `--h10-text-3`. **No affordance** — clicking does nothing (see gaps). |
| page | anchor link | `Export CSV` | always visible (NOT client-gated) | `GET /api/exports/quotes` → server-gated by `FEATURES.exportsRun`; returns `quotes.csv` (columns: number, party, state, net, [margin_pct if `marginsView`/owner], deposit_pct, valid_until, updated) over whole table. Plain `<a>` navigation, **no toast** on 403. |
| page | Button `variant=primary` | `New quote` (with `Plus` icon) | only if `canCreate` (`quotes.create`) | `onClick=startCreate` → `GET /api/parties-lite` (BRAND+CUSTOMER, archivedAt null) into `parties`, opens New-quote modal (`creating=true`). Errors swallowed (`catch {}`) → modal opens with empty list. |

### 1b. Tabs + search + grid controls

| Surface | Element | Label | Visibility / enablement | Handler → effect |
|---|---|---|---|---|
| page · tab | button | `All` | always; active bg `--h10-primary`/white | `setState("all")` → reload. No count badge (all tab suppressed). |
| page · tab | button | `Draft` | always | `setState("draft")`; shows count badge `data.counts.DRAFT` if >0. |
| page · tab | button | `Sent` | always | `setState("sent")`; badge `counts.SENT`. |
| page · tab | button | `Accepted` | always | `setState("accepted")`; badge `counts.ACCEPTED`. |
| page · tab | button | `Rejected` | always | `setState("rejected")`; badge `counts.REJECTED`. |
| page | text input | placeholder `Search number or party…` | always | `setQ` → debounced reload with `?q=`; server does `contains` on `number` OR `party.name` (case-insensitive per DB collation). |

### 1c. DataGrid columns (`rows = data.quotes ?? []`, `rowKey = r.id`)

Grid is **not** sortable (no `sortable`/`sortValue` on any column), not selectable, no totals row.

| Column key | Header | Render logic | Permission gate |
|---|---|---|---|
| `number` | `Quote` | `<button>` styled as link (`--h10-text-link`, bold) → `openEditor(r.id)` (rewrites URL to `/quotes?q=<id>` via `history.replaceState` + synthetic `popstate`). | — |
| `party` | `Party` | `r.party.name` (plain text). | — |
| `state` | `State` | `<Pill tone={STATE_TONE[r.state]}>{r.state}</Pill>`; if `r.convertedOrderId` also `<Pill tone="success">order</Pill>`. | — |
| `net` | `Net` (right) | `r.lineCount ? eur(r.netCents) : "—"`. | — |
| `margin` | `Margin` (right) | `r.lineCount ? <Pill tone={r.marginCents<0?"danger":"success"}>{marginPct.toFixed(0)}%</Pill> : "—"`. | **column present only if `canMargin`** |
| `valid` | `Valid until` | `r.validUntilAt ? toLocaleDateString() : "—"`. | — |
| `updated` | `Updated` | `new Date(r.updatedAt).toLocaleDateString()`. | — |

**Empty state (exact):** `No quotes yet — start one from an Inbox thread or with New quote.`

---

## Surface 2 — New-quote modal (`Modal size="sm"`)

Opened by the header `New quote` button (also the ContextRail `New quote`/`Another quote` path goes straight to the editor instead — see Deep-links IN).

| Surface | Element | Label | Visibility / enablement | Handler → API → server effect → feedback |
|---|---|---|---|---|
| modal | title | `New quote` | while `creating` | — |
| modal | helper text | `Who is this quote for?` | always | — |
| modal | Listbox | ariaLabel `Party`; first option `Choose a contact…` then each party as `${name} (${kind})` | always | `onChange=setPartyId`. Options from `parties-lite`. Esc closes popover; click-away closes. |
| modal | empty note | `No contacts yet — create one from an Inbox thread first.` | only if `parties.length === 0` | display (also shown on a swallowed fetch error). |
| modal · footer | Button | `Cancel` | always | `setCreating(false)`; no server call. |
| modal · footer | Button `primary` | `Create` | disabled if `!partyId \|\| busy` | `POST /api/quotes` body `{partyId}` → **creates** `Quote` (number via `nextNumber("quote")`, `depositPct = party.depositDefaultPct`, `validUntilAt = now+30d`, `promiseDateAt = now + leadTimeDays(default 21)`), `audit(created)`. On success: close modal, clear partyId, `openEditor(quote.id)` (navigate to editor). On error: toast `(e).message` danger. **No durable event on create.** |
| modal | (keyboard) | Esc / backdrop click | always | closes modal (`onClose`). |

---

## Surface 3 — Quote Editor header (`DetailHeader` in `QuoteEditor`)

Rendered when `?q=<id>` present. Loads in parallel: `GET /api/quotes/:id` (quote+totals), `GET /api/products/templates`, `GET /api/settings/pricing-defaults` (→ `floorPct`, default 20). While `quote===null`: renders a Card with a single `Back` button (`ArrowLeft`) → `onBack` (back to list).

| Surface | Element | Label | Visibility / enablement | Handler → API → effect → feedback |
|---|---|---|---|---|
| page | DetailHeader back | `All quotes` | always | `onBack` → `closeEditor()` (URL back to `/quotes`, reload list). |
| header · title | Pills | `{quote.number}` + `<Pill tone={STATE_TONE[state]}>{state}</Pill>`; if `convertedOrderId` also `<Pill tone="success">converted</Pill>` | always | display. |
| header · actions | anchor | `PDF` (`FileDown` icon) | always | `GET /api/quotes/:id/pdf` in new tab → live preview from customer snapshot (no cost/margin); no version param. |
| header · actions | Button | `Revise` | only if `quote.state === "SENT"` (NOT client permission-gated) | `patchQuote({state:"DRAFT"})` → `PATCH /api/quotes/:id` (server-gated `quotesCreate`) → `state=DRAFT`, `audit(updated)`, event `pricing.updated`. Feedback = reload only (no success toast); error → toast. |
| header · actions | Button `primary` | `Send` (`Send` icon) | if `state ∈ {DRAFT,SENT}`; **disabled if `lines.length===0`** | opens SendModal (`setSending(true)`). No API yet. |

### Meta line (below header)
Display only: `{party.name}` · if conversation: `from thread "{subject}"` · price list: `list: {priceList.name}` or `Listino base` if none.

---

## Surface 4 — ConvertBar (`ConvertBar`, top of editor body)

State machine banner. Renders one of: converted / accepted / rejected / sent / null.

| State branch | Surface | Element | Label (exact) | Visibility / enablement | Handler → API → server effect → events/notif → feedback |
|---|---|---|---|---|---|
| `convertedOrderId` set | banner success | (text) | title `Converted to an order`, body `This quote became an order. The Orders board arrives in FP4; the record exists now.` | whenever converted | display only — **no link to the order** (dead end, see gaps). |
| `state==="ACCEPTED"` | banner success | text | title `Accepted by the customer`; body `Turn it into an order` + (if `depositPct`) ` (a {depositPct}% deposit is due per the quote)` + `.` | always in ACCEPTED | — |
| `state==="ACCEPTED"` | Button `primary` | `Convert to order` | **only if `canConvert`**; disabled while `busy` | `POST /api/quotes/:id/convert` → creates `Order` (number `nextNumber("order")`, `state=CONFIRMED`, `bornFromQuoteId`, copies lines desc/selections/qty/net/cost, carries `promiseDateAt`), sets `quote.convertedOrderId`, `audit(converted)` + `audit(order created)`, event `pricing.updated`. Toast success `{order.number} created — the Orders board arrives in FP4`; then `onChanged` reload. Guards: 400 if not ACCEPTED, 409 if already converted → toast `(e).message`. |
| `state==="REJECTED"` | banner danger | text + inline button | title `Declined / changes requested`; body `"{lostReason}"` if present else `The customer didn't proceed.` then inline `Revise` link | always in REJECTED; `Revise` only if `canCreate` | `Revise` → `patchState("DRAFT")` → `PATCH /api/quotes/:id {state:"DRAFT"}`; reload, no success toast. |
| `state==="SENT"` (`&& canCreate`) | banner info | text + 2 buttons | title `Sent — awaiting the customer`; helper `They accept from the email link — or record it here if they replied.` | only if `canCreate`; else **whole bar is null** (no mark-accepted path) | — |
| ↳ SENT | Button `primary` | `Mark accepted` | disabled while busy | `patchState("ACCEPTED")` → `PATCH /api/quotes/:id {state:"ACCEPTED"}`, event `pricing.updated`; reload (silent success). |
| ↳ SENT | Button | `Mark rejected` | disabled while busy | `setRejecting(true)` → reveals reason UI (below). |
| ↳ SENT · rejecting | text input | placeholder `What did they want changed? (optional)` | while rejecting | `setReason`. |
| ↳ SENT · rejecting | Button | `Mark rejected` | disabled while busy | `patchState("REJECTED", reason \|\| undefined)` → PATCH with `{state:"REJECTED", lostReason}`; reload. |
| ↳ SENT · rejecting | Button | `Cancel` | always | `setRejecting(false)`. |
| `state==="DRAFT"` | — | (bar returns `null`) | — | no ConvertBar on drafts. |

---

## Surface 5 — Quote Editor · line configurator (left Card)

### 5a. Line tabs + add

| Surface | Element | Label | Visibility / enablement | Handler → API → effect |
|---|---|---|---|---|
| card · line tabs | button per line | `l.template?.name` else `Line {i+1}` | always (one per `quote.lines`) | `setActiveLineId(l.id)`; active = primary wash. |
| card | Button | `line` (`Plus` icon) | only if `isDraft` (`state==="DRAFT"`) | `addLine` → `POST /api/quotes/:id/lines {}` → creates empty `QuoteLine` (`selections:[]`), `audit(line.added)`; reload + focus new line. Server 400 if not draft. |
| card | empty text | `Add a line to start configuring.` (if 0 lines) OR `Select a line.` (if lines exist but none active) | when `!activeLine` | display. |

### 5b. Active-line editor

| Surface | Element | Label | Visibility / enablement | Handler → API → server effect → feedback |
|---|---|---|---|---|
| card | Listbox | ariaLabel `Template`; `Product:` prefix; first option `Choose a product…` then each template name | present when a line is active; **disabled if `!isDraft`** | `onChange` → `patchLine({templateId: v\|\|null, selections:[]})` → `PATCH /api/quotes/lines/:lid` → recompose via engine + **persist** money (list/cost/net/margin), returns compose `result` for rail, `audit(line.updated)`; then full `load()`. Errors → toast. |
| card | icon button | (Trash2 icon, no text) | only if `isDraft && quote.lines.length>1` | `deleteLine(activeLine.id)` → `DELETE /api/quotes/lines/:lid` → deletes line, `audit(line.removed)`; clears active, reload. Server 400 if not draft. |
| card | Banner danger (0..n) | title `Can't be quoted`, body = violation.message | for each `result.violations` with `severity==="BLOCK"` | display; also blocks Send server-side. |
| card | Banner warning (0..n) | title `Heads up`, body = violation.message | for each `severity==="WARN"` | display (non-blocking). |
| card · option group | RadioCard (per option) | `o.name`; group header `{g.name} · pick {min}–{max}` | when group `maxSelect===1`; **disabled if `!isDraft`** | `toggleOption(true, ids, o.id)` → single-select within group → `patchLine({selections:[...]})`. |
| card · option group | Checkbox + label (per option) | `o.name` | when group `maxSelect!==1`; disabled if `!isDraft` | `toggleOption(false, ids, o.id)` → toggle membership → `patchLine({selections})`. |
| card | number input | `Qty` | shown if `activeLine.templateId`; disabled if `!isDraft` | **commit on blur** (uncontrolled, `key={qty}`): if changed → `patchLine({qty: Math.max(1, Number)})`. Min 1. |
| card | `EuroInput` | `Adjustment` (ariaLabel `Adjustment`, width 78) | shown if templateId; disabled via `!isDraft`? (note: `EuroInput` not passed `disabled` here) | **commit on blur** (and Enter→blur): if `euroStrToCents !== cents` → `patchLine({adjustmentCents})`. |
| card | text input | placeholder `reason for the adjustment` | only if `activeLine.adjustmentCents !== 0`; disabled if `!isDraft` | **commit on blur**: if changed → `patchLine({adjustmentReason: value\|\|null})`. |

---

## Surface 6 — Quote Editor · right rail

All commit-on-blur inputs use `key={value}` uncontrolled pattern; Enter is not wired on the plain `<input>`s (only EuroInput/DeltaInput blur on Enter).

### 6a. Quote total card

| Element | Label | Visibility | Notes |
|---|---|---|---|
| header | `Quote total` | always | — |
| Row | `Cost` = `eur(totals.costCents)` (muted) | only if `canCost` and totals | — |
| Row | `Net total` = `eur(netCents)` or `—` | always | strong. |
| Row | `Margin` = `eur(marginCents) · {marginPct.toFixed(1)}%` | only if `canMargin` and totals | value red if `marginCents<0` else green. |
| note | `Below your {floorPct}% margin floor.` | only if `belowFloor` (`canMargin && netCents>0 && marginPct<floorPct`) | red text. |

### 6b. "This line" card
Shown only if `activeLine.templateId && result && canCost`. Rows: `Cost`, `List`, `Net` from the compose `result`. Display only.

### 6c. Deposit / dates card

| Element | Label | Enablement | Commit semantics → API |
|---|---|---|---|
| number input | `Deposit %` (0–100) | disabled if `!isDraft` | **blur**: if changed → `patchQuote({depositPct: Number\|\|null})` → `PATCH /api/quotes/:id`, event `pricing.updated`. (Note: `0` coerces to `null`.) |
| `DateField` | `Valid until` | disabled if `!isDraft` | **onChange** (calendar pick, immediate): `patchQuote({validUntilAt: new Date(`{v}T23:59:00`).toISOString() \|\| null})`. Clear row sets null. |
| `DateField` | `Promise date` + subnote `(estimate; real lead time in FP6)` | disabled if `!isDraft` | **onChange**: `patchQuote({promiseDateAt: `{v}T12:00:00` ISO \|\| null})`. |

DateField/Listbox popovers: Esc closes, click-away closes, prev/next month nav buttons (`Previous month` / `Next month` aria), `clear` foot row.

### 6d. Sent-versions card (`Sent versions (frozen)`)
Shown only if `quote.versions.length>0`. Per version: `v{version}` + `sentAt` date + (if `pdfRef`) anchor `PDF` → `GET /api/quotes/:id/pdf?version=N` new tab (serves the stored frozen PDF). Rows themselves not clickable.

### 6e. Similar-quotes card (`Similar past quotes`)
Loaded from `GET /api/quotes/similar?partyId&excludeId[&templateId]` (top 5 ACCEPTED/REJECTED for this party or template). Shown only if `similar.length>0`. Per row: `{number}` + `<Pill tone={ACCEPTED?"success":"danger"}>{ACCEPTED?"won":"lost"}</Pill>` + `eur(netCents)`. **Not clickable** — display only (dead end).

---

## Surface 7 — SendModal (`Modal size="sm"`)

Opened by header `Send`. Props carry `belowFloor`, `floorPct`, `totals`.

| Surface | Element | Label (exact) | Visibility / enablement | Handler → API → server effect → events → feedback |
|---|---|---|---|---|
| modal | title | `Send {quote.number}` | while sending | — |
| modal | body line | `To **{party.name}**` + (conversation) ` — replies into the thread "{subject}".` OR ` — a new email (no linked thread).` | always | — |
| modal | row | `Net total` = `eur(netCents)` or `—` | always | — |
| modal | row | `Deposit ({depositPct}%)` = `eur(depositCents)` | only if `quote.depositPct` truthy | depositCents = `round(net*pct/100)`. |
| modal | note | `A PDF is attached; the customer can accept it with a link. This send is frozen as a version.` | always | — |
| modal | Banner danger + checkbox | title `Below your {floorPct}% margin floor`; label `Send anyway — I've reviewed the margin ({marginPct}%).` | **only if `belowFloor`** | Checkbox `ack` (ariaLabel `Acknowledge margin floor`) → `setAck`. Gates the Send button. |
| modal · footer | Button | `Cancel` | always | `onClose`. |
| modal · footer | Button `primary` | `Send quote` (busy → `Sending…`) | **disabled if `busy \|\| (belowFloor && !ack)`** | `POST /api/quotes/:id/send {acknowledgeFloor: ack}` → server: recompose every line (400 on any BLOCK), margin-floor gate (422 if `<floor && !ack`), requires Gmail connected (400 `Connect Gmail in Settings › Integrations first`), requires recipient email (400 `This contact has no email on file` / `No recipient email`), renders PDF to `data/quotes/<id>-v<n>.pdf`, sends Gmail (threaded reply if linked else new mail), **creates `QuoteVersion`** (frozen snapshot + pdfRef), **sets `state=SENT`**, sets `sentAt` (first time), sets `acceptTokenHash` (generated on first send only), if conversation: creates OUTBOUND `Message` + bumps `conversation.lastMessageAt`, `audit(sent)`, events `conversation.updated` + `pricing.updated`. Success toast `Quote sent into the thread` (if conversation) else `Quote sent`; then `onSent` (close + reload). Errors → toast `(e).message`. |
| modal | (keyboard) | Esc / backdrop | always | `onClose`. |

Accept-link caveat: raw accept URL is included in the email **only on the first send** (token raw value is not reconstructable afterward); re-sends omit the link though the token stays valid.

---

## Surface 8 — Public accept page `/q/[token]` (customer-facing, Italian, no session)

Client component. On mount: `GET /api/q/:token` (token-authed via sha256 hash lookup → latest frozen version snapshot; no cost/margin). Status states: `loading` / `ready` / `notfound` / `done`.

### 8a. Non-interactive states (exact copy)

| Status | Copy |
|---|---|
| loading | `Caricamento…` |
| notfound (404) | h2 `Preventivo non trovato` + `Il link non è valido o è scaduto.` |
| done (accepted) | h2 `Grazie! Preventivo accettato.` + `Ti contatteremo a breve per procedere.` |
| done (rejected) | h2 `Grazie, abbiamo ricevuto la tua richiesta.` + `Rivedremo il preventivo e ti risponderemo.` |

### 8b. Ready view — header, line items, totals (display)
Header: `Preventivo {number}` + `Valido fino al {dmy(validUntilAt)}`; sub `{partyName}`. Each snapshot line: `{description}` + ` × {qty}` if qty>1, options joined by ` · `, `eur(lineTotalCents)`. Totals: `Totale` = `eur(totalCents)`; if depositPct: `Acconto ({depositPct}%)` = `eur(depositCents)`. Custom Italian `eur` (`€ 1.234,56` comma-decimal) and `dmy` (it-IT locale).

### 8c. Ready view — conditional decision block

`openForDecision = (state==="SENT" && !expired)`. Priority: decided/converted → expired → openForDecision → (else nothing).

| Condition | Surface | Element | Label / copy | Handler → API → server effect → notif → feedback |
|---|---|---|---|---|
| `decided \|\| converted` | banner (grey) | text | converted → `Questo preventivo è stato accettato ed è in lavorazione.` · ACCEPTED (not converted) → `Questo preventivo è stato accettato.` · else → `Questo preventivo non è più disponibile.` | display. |
| `expired` (validUntil<now) | banner (amber) | text | `Questo preventivo è scaduto — contattaci per un aggiornamento.` | display. |
| openForDecision | buttons | `Accetta preventivo` (busy → `…`) | — | `act("accept")` → `POST /api/q/:token/accept` (CSRF double-submit via `apiFetch`; token IS auth) → guards: 404 not_found, 409 `already_decided` (state≠SENT), 410 `expired` (validUntil<now). On ok: `quote.state=ACCEPTED`, reopens CLOSED conversation, `audit(accepted, via public link)`, **notifyOwners** `Quote {number} accepted by the customer` (STATE_CHANGE, href `/quotes?q=<id>`), event `pricing.updated`. UI → `done`/accepted. On error → `alert()`: expired→`Questo preventivo è scaduto.`, already_decided→`Questo preventivo è già stato gestito.`, else→`Si è verificato un errore.` |
| openForDecision | button | `Richiedi modifiche` | — | `setRejecting(true)` → reveals note UI. |
| ↳ rejecting | textarea | placeholder `Cosa vorresti modificare? (facoltativo)` | — | `setNote`. |
| ↳ rejecting | button (red) | `Invia richiesta` | disabled while busy | `act("reject")` → `POST /api/q/:token/reject {note}` → `state=REJECTED`, `lostReason=note`, `audit(rejected)`, **notifyOwners** `Quote {number}: customer requested changes` (body=note, href `/quotes?q=<id>`), event `pricing.updated`. UI → done/rejected. Errors → same `alert()` map. |
| ↳ rejecting | button (outline) | `Annulla` | — | `setRejecting(false)`. |

**Superseded state:** there is no explicit "superseded" concept; only the latest frozen version snapshot is ever shown. An accepted-but-not-converted quote shows the ACCEPTED grey banner. There is **no** render branch for `state==="EXPIRED"` with a future `validUntilAt` (renders nothing below the total — see gaps).

---

## Surface 9 — Deep links IN (who navigates to Quotes)

| Origin (file) | Trigger / label | Target URL | Lands on |
|---|---|---|---|
| Inbox ContextRail `LinkedQuotes` (`inbox/_components/ContextRail.tsx`) | Button `New quote` / `Another quote` (label flips if quotes exist); gated `quotes.create` + party matched | `POST /api/quotes {partyId, conversationId}` then `router.push('/quotes?q=<id>')` | **QuoteEditor** (new draft, thread-linked). |
| Inbox ContextRail linked-quote chips | quote pill button (`{number}` + STATE pill + `order` pill + `eur` [+ margin if canMargin]) | `router.push('/quotes?q=<id>')` | QuoteEditor. |
| ContextRail helper (no party) | text `Match this thread to a contact first, then quote them.` | — | (no link; dead affordance until matched) |
| Contacts ContactHistory (`contacts/_components/ContactHistory.tsx`) | Quotes sub-tab rows | `/quotes?q=<id>` | QuoteEditor. |
| Orders OrderDetail (`orders/_components/OrderDetail.tsx`) | meta `· from {number}` and action `Open quote {number} ↗` | `/quotes?q=<id>` | QuoteEditor. |
| Analytics (`analytics/_components/AnalyticsClient.tsx`) | Counter `Quotes awaiting approval` + Panel `Quote win / loss` | `/quotes` | Pipeline list (no filter applied). |
| Notifications (public accept/reject → `notifyOwners`) | notification href | `/quotes?q=<id>` | QuoteEditor. |
| Orders timeline (`lib/orders/timeline.ts`) | `Quote {number} drafted` / `... sent` events | `/quotes?q=<id>` | QuoteEditor. |
| Global search ⌘K (`api/search/route.ts`) | Quotes group result | **`/quotes?focus=<id>`** | **BROKEN** — page reads `?q=`, not `?focus=` → lands on plain list (see gaps). |

## Surface 10 — Deep links OUT (from Quotes)

| From | Element | Target |
|---|---|---|
| Editor header | `PDF` | `/api/quotes/:id/pdf` (live preview). |
| Rail versions | `PDF` per version | `/api/quotes/:id/pdf?version=N` (frozen). |
| Pipeline header | `Export CSV` | `/api/exports/quotes`. |
| Send email body | accept link (first send only) | `{FACTORY_PUBLIC_URL}/q/<rawToken>` → public page. |
| Convert | (no link) | order exists but ConvertBar/converted banner offers **no** navigation to it. |

## Surface 11 — `?q=` param behavior

- `PipelineInner` reads `openId = params.get("q")`. If truthy → renders `<QuoteEditor quoteId={openId}>` **instead of** the list (full swap, not a modal/drawer).
- `openEditor(id)`: `history.replaceState(null,"","/quotes?q="+id)` then dispatches synthetic `PopStateEvent("popstate")` to force `useSearchParams` re-read. `closeEditor()`: replaceState back to `/quotes`, dispatch popstate, reload list.
- Because it uses `replaceState` (not push), the browser Back button does **not** step list↔editor; it exits the page.
- `?focus=` is **not** read anywhere in Quotes.

---

## Toast / alert catalog

| Trigger | Text | Tone |
|---|---|---|
| Send success (linked thread) | `Quote sent into the thread` | success |
| Send success (no thread) | `Quote sent` | success |
| Convert success | `{order.number} created — the Orders board arrives in FP4` | success |
| Any list/create/patch/line/convert/send/state error | `(e as Error).message` (server error string) | danger |
| Public accept/reject — expired | `Questo preventivo è scaduto.` | `alert()` |
| Public — already decided | `Questo preventivo è già stato gestito.` | `alert()` |
| Public — generic | `Si è verificato un errore.` | `alert()` |

Server error strings surfaced verbatim as danger toasts include: `Only draft quotes can be deleted — mark a sent quote rejected instead`, `Revise the quote to a draft before editing lines`, `A {STATE} quote cannot be sent`, `Add at least one line first`, `A line has a blocking constraint — resolve it before sending`, `Net margin X% is below your Y% floor — acknowledge to send`, `Connect Gmail in Settings › Integrations first`, `This contact has no email on file`, `Only accepted quotes convert to orders`, `Already converted`.

## Pill / Badge tone rules

| Location | Rule |
|---|---|
| `STATE_TONE` (canonical) | DRAFT→neutral, SENT→info, ACCEPTED→success, REJECTED→danger, EXPIRED→warning. |
| Grid `order` / editor `converted` pill | success, iff `convertedOrderId`. |
| Grid margin pill | `marginCents<0` → danger else success; text `{marginPct.toFixed(0)}%`. |
| Similar-quotes pill | ACCEPTED → success `won`; else danger `lost`. |
| ContextRail chips | `QUOTE_TONE[state]` (mirrors STATE_TONE) + `order` success. |

## Empty-state catalog (exact copy)

- Grid: `No quotes yet — start one from an Inbox thread or with New quote.`
- New-quote modal (no parties): `No contacts yet — create one from an Inbox thread first.`
- Editor, 0 lines: `Add a line to start configuring.`
- Editor, lines but none active: `Select a line.`
- Public notfound: `Preventivo non trovato` / `Il link non è valido o è scaduto.`

---

## Wiring gaps (dead ends, one-way links, feedback-free actions)

1. **Global-search deep link is broken.** `api/search/route.ts` emits `/quotes?focus=<id>` but `QuotesClient` only reads `?q=`. Clicking a quote in ⌘K lands on the unfiltered list, not the editor. (Contacts/Orders search use `?focus=` too, but Quotes has no `focus` handler.)
2. **`EXPIRED` state has tone + counter but no writer.** `STATE_TONE.EXPIRED` (warning) and the Overdue counter exist, and `PATCH` accepts `state:"EXPIRED"`, but nothing (no cron, no UI button) ever sets it. Overdue quotes stay DRAFT/SENT. The public page has no render branch for `state==="EXPIRED"` when `validUntilAt` is not in the past → renders no decision UI and no message (blank dead end).
3. **Converted-order dead end.** After convert, both the ACCEPTED→converted banner and the `converted` header pill offer no link to the new order. Navigation is one-way only (Order → quote exists via OrderDetail; quote → order does not).
4. **`Export CSV` not client-gated.** Always-visible plain `<a>`; a user without `exports.run` gets a server 403 with no toast/feedback (raw navigation).
5. **ConvertBar null on SENT without `quotes.create`.** A user with page access but not `quotes.create` sees no ConvertBar on a SENT quote → cannot Mark accepted/rejected at all. Similarly ACCEPTED without `quotes.convert` shows the banner text but no Convert button (informational dead end).
6. **Silent successes.** `Revise`, `Mark accepted`, `Mark rejected`, all `patchLine`/`patchQuote`/`addLine`/`deleteLine`, and option toggles emit **no success toast** — the only feedback is a grid/rail refresh. Only errors toast. State-changing `Revise` (SENT→DRAFT) and Mark-accepted have no confirm dialog.
7. **Similar-quotes rows are not clickable.** They show number/won-lost/price but cannot navigate to the referenced quote.
8. **Version rows not clickable** except the optional `PDF` sublink; a version without `pdfRef` is inert.
9. **Deposit `0` is unrepresentable.** `Number(e.target.value) || null` maps a deposit of exactly `0%` to `null` (unset), indistinguishable from "no deposit."
10. **Orphaned adjustment reason.** The reason input only appears while `adjustmentCents !== 0`; zeroing the adjustment back does not clear the stored `adjustmentReason` (it lingers in DB, hidden from UI).
11. **First-send-only accept link.** The raw accept URL is emailed only on the first send; re-sends omit it. A customer who lost the first email never gets the link again (token still valid but unreachable from later mails).
12. **No proactive send gating.** SendModal doesn't check Gmail connection or recipient email up front; those only surface as post-submit error toasts (`Connect Gmail…`, `This contact has no email on file`).
13. **`parties-lite` is `PAGES.products`-gated.** The New-quote modal's party list requires products page access; a user with `quotes.create` but not products access gets a swallowed fetch error → empty list → the misleading `No contacts yet — create one from an Inbox thread first.` copy (it's a permission problem, not an empty DB).
14. **Grid is non-sortable.** `DataGrid` supports sortable headers, but no Quotes column sets `sortable`/`sortValue`; headers are static despite the affordance existing in the primitive.
15. **Overdue counter is inert.** It's a display tile with no click target to filter to overdue quotes (no "overdue" tab exists; tabs are only All/Draft/Sent/Accepted/Rejected).
16. **Public page acts on possibly-stale state.** Accept/Reject buttons render from the initially-loaded snapshot; if the quote was decided/expired after load, the click fails and only then shows an `alert()` — no live re-check or pre-emptive disable.
