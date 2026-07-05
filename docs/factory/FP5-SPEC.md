# FP5 — Contacts: page-cycle spec (awaiting Owner approval)

Written 2026-07-05 on FP4's approval. Gate 1 of the FP5 double gate — nothing below is built until the Owner approves. Seeds: `F0-IA.md` §2, PLAYBOOK §11-FP5, and the Front / Tailornova / NetSuite-CRM verdicts in `F0-TEARDOWN.md`. **This is the CRM spine the golden flow already leans on.** FP1 creates minimal parties from senders; FP2 assigns them price lists; FP3/FP4 price and produce against their deposit defaults and (soon) their measurements. FP5 promotes those thin records into a real relationship workspace — and gives the Owner the **side-by-side price comparison** they named as a must-have.

## Purpose (one sentence)

Turn the minimal party records the app already creates into a proper contact workspace — identity, emails (with domain-matching), price-list + terms + deposit, versioned **measurement profiles**, and the full linked history (threads · quotes · orders · reviews) — plus a **compare-pricing tool** that shows, for any configured product, what each customer would pay and their discount vs the base list, every number composed through the FP2 engine.

## Scope

**IN (FP5):**
- **The `/contacts` workspace** — parties by kind (Customers · Suppliers · Brands · All) with counts, search, and money-lite columns; clicking a contact opens the full-screen detail. Reuses the existing party rails (`parties-lite`, imports/exports already shipped in F1).
- **Contact detail — identity & commercial** — name, kind, currency, **payment terms**, **default deposit %**, notes (inline-editable); **emails manager** (add / remove / label each address + the `matchDomain` toggle that maps a whole B2B domain to one party); **price-list assignment** (the party's Listino, or base).
- **Measurement profiles (versioned)** — CRUD per garment type: `fields` (Json — the measurements), fit notes, photo attachments (local / Drive). **Editing creates a new version that supersedes the old one (never mutates it)** — the Tailornova ADOPT; the frozen history stays viewable. These are what FP3 quote lines will reference.
- **Full history tabs** — the contact's **conversations** (link to Inbox), **quotes** (state + net + won/lost), **orders** (state + net + promise), **reviews** — each aggregated from the linked records and deep-linked. Read-only here; the owning pages act.
- **Side-by-side price comparison (the must-have)** — a tool on `/contacts`: pick a template, configure its options once, and see a **table of every customer's composed price + their discount vs "Listino base"** (and margin, grain-gated). Pure FP2 engine calls per party — no new pricing logic.
- **Party CRUD + archive** — create a contact directly (not only from a thread/import); soft-archive (`archivedAt`) rather than delete (parties are referenced by quotes/orders); un-archive.
- **CSV export extension** — add `payment_terms` + `deposit_pct` columns to the existing parties export (grain-gated).

**OUT (named, so the boundary is explicit):**
- **Merge-duplicates** — deferred (relinking FKs across quotes/orders/threads + the audit trail is its own careful cycle). Flagged in the backlog.
- **Per-party configurator defaults** (`Party.configuratorDefaults` Json + consumption in the FP3 quote configurator) — deferred: FP3 is already shipped, so wiring party-level option defaults into it is a separate follow-up. FP5 adds no schema.
- **Supplier deep features** — supplier price lists, PO history, landed cost live in Materials / Purchase Orders (FP7 / PO-series). A supplier contact shows the basics + links out.
- **Composing/sending email from the contact** — the Inbox owns sending; the contact links to its threads.
- Full activity log beyond the linked records; lead/opportunity pipeline (not this product).

## Layout

**`/contacts`** — list; clicking a contact (or "New contact") opens the full-screen **ContactDetail**. A **Compare pricing** action opens the comparison tool.

```text
LIST:   kind tabs (Customers · Suppliers · Brands · All) · search · [Compare pricing] [New contact]
        DataGrid: name · kind · emails(n) · price list · terms* · deposit%* · quotes · orders · updated
CONTACT DETAIL (full-screen):
┌ header: name · kind pill · [archive] ·  from-thread/first-seen
├──────────── tabs: Overview · Measurements · History ────────────┬──── RAIL (320px) ────┐
│ OVERVIEW:  identity (name/kind/currency/terms*/deposit*/notes)   │ Price list           │
│            emails manager (+matchDomain)                          │ Terms* · Deposit*    │
│ MEASUREMENTS: profiles by garment type · version chips · [+ new] │ Quotes n · Orders n  │
│            a profile = fields table + fit notes + photos          │ Reviews (avg)        │
│ HISTORY:   conversations · quotes(won/lost) · orders · reviews    │ Similar / links      │
└──────────────────────────────────────────────────────────────────┴──────────────────────┘
COMPARE PRICING:  pick template → configure options → table: party · composed net* · vs base* · margin* · list
```
`*` = grain-gated (server-stripped; terms/deposit/margin never reach a caller without `financials.*`).

## Component reuse

| Region | Components |
|---|---|
| List | `DataGrid`, `Pill`, `Input` search, kind tabs (FP4 pattern), `factory-page factory-grid-grow-1` (name grows) |
| Detail | `DetailHeader`, `Tabs`, `Card`, `Listbox` (price list), `DateField` where needed |
| Emails / measurements | `Modal` add/edit, `Pill` (version chips), `FileDropzone`/ImageUpload (photos → local/Drive, FP1 attachment pipeline) |
| Compare pricing | the FP2 preview toggle UI (RadioCard/Checkbox) + `DataGrid` (party × price), reused verbatim |
| History | reuse the FP4 timeline-item look for a compact per-tab list |
| States | `Skeleton`, `EmptyState`, `useToast` |

## Data & API

**No migration** — `Party` / `PartyEmail` / `MeasurementProfile` all shipped in F1; the deposit/terms/currency fields already exist. (Configurator-defaults column is deferred, see OUT.)

**Routes** (all `guarded()` + coverage-checked; money via `jsonStripped`):

| Route | Methods | Permission |
|---|---|---|
| `/api/contacts` | GET (list by kind + counts), POST (create) | `pages.contacts` / `contacts.manage` |
| `/api/contacts/[id]` | GET (detail + history aggregate), PATCH (identity/terms/deposit/notes/priceList), DELETE (archive) | `pages.contacts` / `contacts.manage` |
| `/api/contacts/[id]/emails` · `/emails/[eid]` | POST / PATCH (label, matchDomain), DELETE | `contacts.manage` |
| `/api/contacts/[id]/measurements` · `/measurements/[mid]` | GET, POST (new version — supersedes), DELETE | `contacts.manage` |
| `/api/contacts/compare` | POST `{ templateId, selections[] }` → per-party composed price | `pages.contacts` (+ grain strip) |
| `/api/exports/parties` | (extend) terms + deposit columns | `exports.run` |

Compare contract: for each active CUSTOMER party, call the FP2 `compose()` with that party's price list and the chosen `{templateId, selections}`; return `{ partyId, name, netCents, baseNetCents, discountPct, marginCents* }` — the server does the pricing; the browser only renders. Measurement versioning: POST creates a new `MeasurementProfile` with `supersedesId` = the prior head; the prior stays immutable (docstatus discipline, same as sent quotes).

## Interactions

- **Land on `/contacts`:** Customers tab, the contacts the app already knows (the AWA senders, importer rows). Search by name/email.
- **Open a contact:** Overview edits identity inline (autosave + toast); the emails manager adds an address and flips `matchDomain` so `orders@brand.it` and `sales@brand.it` resolve to one party (the FP1 matching key).
- **Measurements:** add a profile for a garment type; editing it creates **v2** (v1 stays, shown as a superseded chip) — so a customer's size history is a paper trail, never overwritten.
- **History:** the tabs read the linked quotes/orders/threads/reviews; every row deep-links to the owning page.
- **Compare pricing:** pick "Cowhide Suit", tick Kangaroo + Perforated, and see each customer's net and their discount vs base side by side — the Owner's pricing-decision tool, powered by the same engine that writes the quotes.
- **Archive:** a referenced contact archives (hidden from pickers) rather than deletes; un-archive restores.

## States

Skeletons on list + detail; EmptyState ("No contacts yet — they appear as you match senders or import"); measurement empty-state per garment; the compare tool shows an empty prompt until a template is chosen; archived contacts filterable; every write toasts.

## RBAC

`pages.contacts` to view; `contacts.manage` to create/edit/archive, manage emails + measurements; **terms / deposit / margin behind `financials.*` grains** via `jsonStripped` (the list, the rail, the compare table, and the CSV all compose through it). A WORKER without the grains sees names and measurements but no commercial money. Both permissions were seeded in F1 — **no new permissions**.

## Bulk / import-export

Parties CSV import already live (F1) — **export extended** with `payment_terms` + `deposit_pct` (grain-gated). Bulk archive on the list. No merge (deferred).

## Teardown verdicts applied (traceability)

| Verdict (F0-TEARDOWN) | Where it lands |
|---|---|
| Contact-sidebar → a real workspace — ADAPT (Front) | The `/contacts` detail (identity + tabs + rail) |
| Measurement profiles, versioned — ADOPT (Tailornova) | `MeasurementProfile` CRUD, new-version-supersedes |
| Domain → one party — F0 finding (B2B) | `PartyEmail.matchDomain` manager |
| Per-party pricing as list overrides — ADAPT (FD7) | Price-list assignment + the compare tool |
| Side-by-side customer pricing — Owner must-have | `/api/contacts/compare` (pure engine, grain-gated) |
| Created-from chain (thread↔quote↔order) — ADAPT (NetSuite) | The history tabs, aggregated + deep-linked |
| Soft-archive over delete for referenced records — ADOPT (ERPNext) | `archivedAt`, un-archive |

## Acceptance targets (gate-2 click-through)

Open `/contacts` → a real customer (an AWA sender) → edit terms + default deposit (autosave) → add a second email and flip **matchDomain** → add a **measurement profile** for a jacket, then edit it and watch **v2 supersede v1** (v1 still viewable) → open **History** and see the linked quote/order → **Compare pricing**: pick a template, tick options, and read each customer's net + discount vs base side by side → archive a test contact and un-archive it → export the parties CSV and confirm terms/deposit columns (and that a no-grains export omits them). Plus: a test proves the compare payload and CSV strip commercial money for a no-grains caller; measurement versioning never mutates a prior version; 119+ existing tests stay green; rbac / no-touch / parity / build green.

## Build plan (no time estimates)

FP5.1 `/api/contacts` CRUD + emails routes + `/contacts` list + ContactDetail shell (Overview: identity + emails + price list) + tests → FP5.2 MeasurementProfile CRUD (versioned) + Measurements tab (fields editor + photos) → FP5.3 History tabs (conversations/quotes/orders/reviews aggregation) → FP5.4 Compare-pricing tool (engine per party, grain-gated) + parties CSV export extension + bulk archive → FP5.5 headless verify on isolated :3199 + `FP5-REPORT.md`. Each sub-phase a scoped commit; push at cycle end; STOP for gate 2.
