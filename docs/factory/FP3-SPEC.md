# FP3 — Quotes: page-cycle spec (awaiting Owner approval)

Written 2026-07-05 on FP2's approval. Gate 1 of the FP3 double gate — nothing below is built until the Owner approves. Seeds: `F0-IA.md` §2, PLAYBOOK §11-FP3, and the CPQ / Fulcrum / JobBOSS² / Katana / Odoo verdicts in `F0-TEARDOWN.md`. **This cycle closes the golden flow's first half** — the wedge the whole product was justified on. It takes the FP1 Inbox (a matched thread) and the FP2 engine (live-margin pricing) and joins them: a quote is *born from the email*, priced with margin visible, sent back into the same thread, and accepted by the customer with one click.

## Purpose (one sentence)

Turn a matched Gmail thread into a priced, margin-visible quote in fewer clicks than any competitor's order-entry screen, send it from the same thread as a professional PDF, let the customer accept it with a link, and convert the acceptance into an Order — every price composed through the FP2.1 engine, every sent quote frozen as an immutable version.

## Scope

**IN (FP3):**
- **The configurator that WRITES a quote** — the FP2 preview engine, now persisting: party-scoped option toggles, the 4-line waterfall (Cost → List → Adjustment → Net) with live margin, constraint blocks, a per-line manual adjustment *with a reason*, goal-seek, deposit %, promise/validity dates. Money is composed server-side and stored on the quote line (the engine is the only price authority).
- **The `/quotes` RFQ pipeline** — list by state (Draft · Sent · Accepted · Rejected · All) with per-state counts, party/number search, and the three live counters (draft / awaiting-approval / overdue) from the Analytics verdict.
- **Quote lifecycle** — DRAFT → SENT → ACCEPTED / REJECTED / EXPIRED, forward-only with audited transitions; won/rejected carry a reason.
- **Snapshot-on-send versioning** — sending freezes a `QuoteVersion` (options + costs + prices + rendered PDF); editing a sent quote creates v2 that supersedes v1 (ERPNext docstatus + CPQ verdicts). Sent snapshots never change even if a template or material cost later moves (the "sent quotes are snapshots" promise made in FP2).
- **Send into the same thread** — a server-rendered **PDF** (customer-facing, Italian labels, **never any cost or margin column**) attached to a Gmail reply threaded into the linked conversation (reuses FP1's MIME builder), with an optimistic OUTBOUND message; a margin-floor speed bump (net margin below the seeded threshold → red badge + explicit confirm) guards the send.
- **Customer accept/reject by link** — a `PUBLIC` tokenized page (`/q/<token>`) showing the quote (no cost/margin) with Accept / Request-changes buttons; accepting flips the quote to ACCEPTED and notifies the Owner. The golden-flow payoff: the customer approves from the email.
- **Convert accepted quote → Order** — a minimal `Order` record (CONFIRMED, lines snapshotted, deposit placeholder per FD13) linked to the quote and thread; the quote shows a "converted to ORD-n" badge. *(The Orders board/timeline/production is FP4/FP6 — see OUT.)*
- **Similar-quote recall** — a panel surfacing this party's and this template's past quotes with won/lost outcome and price (JobBOSS² verdict).
- **Estimated lead time** — a configurable AppSetting shown as the promise-date default, clearly labelled an *estimate* (real capable-to-promise from floor load arrives with FP6).
- **Inbox integration** — a "New quote" action in FP1's thread context rail (pre-scoped to the matched party) and the reserved **Linked** slot now renders the thread's quotes (state · net · margin). This modifies FP1 Inbox components (same app, in scope).
- Quotes CSV **export**.

**OUT (named, so the boundary is explicit):**
- The **Orders workspace** — the board, the one-timeline, status management, size-run explosion (FP4). Convert creates only the bare Order record.
- **Work Order explosion + production** (FP6); **material reservations** are NOT written on quote acceptance (Katana verdict: quotes never commit stock — reservation happens at production start).
- **Measurement profiles** management + self-measure-form send (FP5). FP3 leaves `QuoteLine.measurementProfileId` null; sizing is handled as an ordinary option group.
- **Payments / real invoicing** (FP9). The deposit is a placeholder record + a PDF line, not a payment integration.
- Quote CSV **import** (export only); quote-template *designer*, A+ rich layouts, guided-selling questionnaires (IGNORE verdicts).

## Layout

**`/quotes`** — pipeline list; clicking a quote (or "New quote") opens the full-screen **QuoteEditor**.

```text
PIPELINE:   counters row (Drafts · Awaiting approval · Overdue) · state tabs · search
            DataGrid: number · party · state pill · net* · margin*(pill) · valid-until · updated
QUOTE EDITOR (born-from-thread or standalone):
┌ header: Quote Q-214 · party (locked once sent) · state · [Send] [Convert] [⋯]
├───────────── CONFIGURATOR (left, flex) ──────────────┬──── QUOTE RAIL (360px) ────┐
│ line tabs (multi-line quotes) + "add line"           │  Party card (list, terms*) │
│ per line: template picker → option groups            │  ── this line ──           │
│   (RadioCard pick-1 / Checkbox multi)                │  Cost* → List* → Adj* → Net*│
│   constraint BLOCK banners inline                    │  Margin*  (floor badge)    │
│   adjustment € + reason · qty                        │  goal-seek (net ⇄ margin)* │
│                                                       │  ── quote totals ──        │
│                                                       │  deposit % · valid until   │
│                                                       │  promise (est.) · lead-time│
│                                                       │  Similar quotes (won/lost) │
│                                                       │  Versions (v1 sent …)      │
└───────────────────────────────────────────────────────┴────────────────────────────┘
PUBLIC /q/<token>:  factory header · quote lines (desc + chosen options + qty + price, NO cost/margin) ·
                    total · deposit · [Accept] [Request changes] · valid-until
```
`*` = grain-gated (server-stripped; the public page and PDF are composed with a customer-shaped filter so cost/margin can never appear).

## Component reuse

| Region | Components |
|---|---|
| Pipeline | `DataGrid`, `Tabs`, `Pill`, `MetricStrip` (the three counters), `Input` search |
| Configurator | the FP2 preview toggle UI (RadioCard/Checkbox), `Banner` (blocks), `DeltaInput`/`EuroInput` (money helpers), reused verbatim |
| Rail | `Card`, `Pill`, `DateField` (valid-until, promise), goal-seek inputs (FP2 pattern) |
| Send/convert | DS `Modal` confirm-with-consequences (margin-floor bullet, deposit summary), `useToast` |
| PDF | server-side `pdfkit` (new dep, FP3.1) — programmatic, no browser |
| Inbox wiring | FP1 `ContextRail` (Linked slot + New-quote button), FP1 reply/MIME pipeline for the send |
| States | `Skeleton`, `EmptyState`, freshness where relevant |

## Data & API

**Migration `fp3_quotes`** (additive; applied via the patient-connection recipe if the dev server is up, or stop it briefly): `Quote.acceptTokenHash String? @unique` (public link), `Quote.validUntilAt DateTime?`, `Quote.sentAt DateTime?`, `Quote.convertedOrderId String?`. Everything else (Quote / QuoteLine / QuoteVersion / Order / Payment) shipped in F1.

**Routes** (all `guarded()` + coverage-checked; money via `jsonStripped` or explicit customer-shaped strip):

| Route | Methods | Permission |
|---|---|---|
| `/api/quotes` | GET (list), POST (create) | `pages.quotes` / `quotes.create` |
| `/api/quotes/[id]` | GET, PATCH (state/deposit/dates/reason), DELETE (draft only) | `pages.quotes` / `quotes.create` |
| `/api/quotes/[id]/lines` · `/api/quotes/lines/[lid]` | POST / PATCH (recomposes via engine + persists), DELETE | `quotes.create` |
| `/api/quotes/[id]/send` | POST (render PDF → Gmail reply → snapshot → SENT; margin-floor confirm flag) | `quotes.send` |
| `/api/quotes/[id]/convert` | POST (create Order + deposit placeholder) | `quotes.convert` |
| `/api/quotes/[id]/pdf` | GET (Owner preview) | `pages.quotes` |
| `/api/quotes/similar` | GET `?partyId=&templateId=` | `pages.quotes` |
| `/api/exports/quotes` | GET (CSV) | `exports.run` |
| `/api/q/[token]` | GET (customer view, stripped) | **PUBLIC** |
| `/api/q/[token]/accept` · `/reject` | POST | **PUBLIC** (token is the auth) |
| `/api/inbox/[id]` | (extend) include linked quotes | `pages.inbox` |

Line compose contract: PATCH a line with `{ templateId, selections[], adjustmentCents, adjustmentReason, qty }`; the server loads the party's price list, calls `compose()`, and persists `listPriceCents/costCents/netPriceCents/marginCents/marginPct` — the browser never computes money. Numbering: `Q-<n>` from a counter (like `ORD-`). PUBLIC routes: constant-time token-hash lookup, no session; every accept/reject audited with the token's quote.

## Interactions

- **Born from thread:** Inbox → thread → context rail **New quote** → QuoteEditor opens with the party locked and its price list pre-selected; on send, the PDF threads into that conversation. Standalone: `/quotes` → New quote → pick party.
- **Configure:** identical feel to the FP2 preview, but every change PATCHes the line and re-persists composed money; BLOCK violations disable **Send** with the reason shown.
- **Send:** confirm modal states the customer, the net total, the deposit, and — if net margin < floor — a red "Below your {n}% margin floor" bullet requiring an explicit tick. On confirm: PDF rendered, Gmail reply sent into the thread, `QuoteVersion` frozen, state → SENT, OUTBOUND message inserted, `pricing`/conversation events published.
- **Customer accepts:** clicks the link in the email → `/q/<token>` → Accept → quote ACCEPTED, Owner notified (bell), thread reopens if closed. Request-changes → REJECTED with the typed note.
- **Convert:** on an ACCEPTED quote, **Convert to Order** → confirm (deposit summary) → Order CONFIRMED created, lines snapshotted, quote badged "converted"; toast "ORD-n created — the Orders board arrives in FP4."
- **Revise a sent quote:** editing forces a new version; the prior version stays frozen and viewable; the customer link points at the latest.
- **Similar quotes:** the rail shows up to ~5 past quotes for this party/template with won/lost + net, one click to open.

## States

Skeletons on pipeline + editor; EmptyState ("No quotes yet — start one from an Inbox thread or here"); BLOCK banners in the configurator; a clear frozen-version indicator on sent quotes; PUBLIC page has its own minimal states (valid / already-accepted / expired / not-found) with no app chrome and no cost ever.

## RBAC

`pages.quotes` to view; `quotes.create` / `quotes.send` / `quotes.convert` to act; every money field behind `financials.*` grains. The **PDF renderer and the PUBLIC page compose with a customer-shaped resolved** (no grains) so cost/margin are structurally impossible to leak — a dedicated test asserts a rendered quote payload and the PDF's text contain no cost/margin. WORKER has none of these (nav lacks Quotes).

## Bulk / import-export

Bulk mark-lost on the pipeline; quotes CSV export (number, party, state, net, margin* [grain-gated], dates). No import.

## Teardown verdicts applied (traceability)

| Verdict (F0-TEARDOWN) | Where it lands |
|---|---|
| Live cost breakdown + margin on the quote — ADOPT (Fulcrum) | The configurator rail, composed per line |
| 4-line price waterfall — ADAPT (CPQ) | Cost → List → Adjustment → Net |
| Snapshot-on-send versioning — ADOPT (CPQ + ERPNext docstatus) | `QuoteVersion` frozen JSON + PDF; sent = immutable |
| Quotes never reserve stock — ADAPT (Katana) | Convert creates the Order but writes NO material reservations |
| Approval = a link in the thread, no portal — ADAPT (Odoo) | PUBLIC tokenized accept/reject |
| Margin-floor speed bump, not approval chains — ADAPT (CPQ Advanced Approvals) | Confirm-with-consequences on send |
| Similar-quote recall — ADOPT (JobBOSS²) | Rail panel |
| Goal-seek target price ⇄ margin — ADOPT (Tacton) | Rail two-way field (FP2 engine) |
| Capable-to-promise date — ADAPT (Fulcrum, honest v1) | Estimated lead time, labelled |
| Customer-facing content in Italian — user policy | PDF + public page in Italian; app UI stays English |

## Acceptance targets (gate-2 click-through)

From a real *AWA ORDER* thread → New quote (party pre-scoped) → add a line, pick the Cowhide Suit + Kangaroo + Perforated, watch net/margin compose and the perforated/waterproof block fire → set a −€40 adjustment with reason and a 30% deposit → try Send below the margin floor and see the speed bump → Send → the PDF arrives in your Gmail thread (open Gmail: it threaded; the PDF has line prices and NO cost/margin) → open the customer link in a private window → Accept → the quote flips to ACCEPTED and your bell rings → Convert to Order → "ORD-n created" → the pipeline shows it converted; the rail shows the frozen v1 and any similar past quotes → export the quotes CSV. Plus: a test proves the PDF/public payload carry no cost or margin; engine-composed line money matches FP2; 92+ existing tests stay green; rbac/no-touch/parity/build green.

## Build plan (no time estimates)

FP3.1 migration + `pdfkit` dep + quote/line CRUD with engine-backed compose + numbering + tests → FP3.2 `/quotes` pipeline + QuoteEditor configurator (reusing FP2 toggles) → FP3.3 PDF render + send-into-thread + snapshot-on-send + margin-floor + Inbox context-rail wiring → FP3.4 PUBLIC accept/reject link + convert-to-Order + similar-quote recall + lead-time + export → FP3.5 headless verify on isolated :3199 (NO live sends in automation — the Owner sends the real one) + `FP3-REPORT.md`. Each sub-phase a scoped commit; push at cycle end; STOP for gate 2.
