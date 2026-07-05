# FP2 — Products & Pricing: page-cycle spec (awaiting Owner approval)

Written 2026-07-05 on FP1's approval. Gate 1 of the FP2 double gate — nothing below is built until the Owner approves. Seeds: `F0-IA.md` §6, PLAYBOOK §11-FP2, and the CPQ/Craftybase/SAP/Genius verdicts in `F0-TEARDOWN.md`. This cycle builds the **pricing model and its engine** — the thing the FP3 configurator (and every quote after it) will consume. It is deliberately the least glamorous and most load-bearing cycle: if the engine is right, FP3 is a UI; if it's wrong, everything downstream lies about money.

## Purpose (one sentence)

Author the factory's sellable reality — templates, option groups with cost+price deltas, constraints, bills of material, certificates, and per-party price lists — and prove it with a live preview that composes price, margin and materials exactly the way FP3's configurator will.

## Scope

**IN (FP2):**
- **The pricing engine** (`src/lib/pricing.ts`) — a pure, exhaustively-tested `compose()` + `goalSeek()` (formula below). The deliverable everything else decorates.
- Product templates CRUD; option groups (min–max select) and options with **cost and price deltas, absolute (cents) or percent (basis points)**.
- **One constraint table** — REQUIRES / EXCLUDES with BLOCK / WARN severity and a human message, edited as sentences (BEAT verdict on Salesforce's two overlapping engines).
- **Minimal materials registry** (name, unit HIDE/SQM/PIECE/M, current `costCents`, reorder level; CRUD + CSV import) — BOMs need materials to point at. The full Materials page (lots, ledger UI, POs, four-column stock) stays FP7; the schema already exists, so this is UI only.
- Base BOM per template + **per-option material draws** (kangaroo and cowhide consume different hides — the Genius "spec-artifact→BOM" verdict, our option sheet being the CAD).
- **Certificate registry** (EN 17092: class AAA–C, cert number, notified body, expiry) with many-to-many template coverage — the FD14 differentiator. FP6 will enforce it at QC; FP2 stores and displays it (expiry chips).
- **Price lists** (FD7): sparse overrides over the seeded "Listino base" — per-template base override and/or per-option delta override; a new list starts EMPTY (= inherits everything). Light party-assignment multiselect on the list detail (parties exist from imports/Inbox; the full party workspace stays FP5).
- **Preview-as-configurator**: pick a party (or Listino base) → toggle options → live 4-line waterfall (Cost → List → Adjustment → Net, margin € and % beside), constraint feedback, composed material lines, per-line **price source** ("why this price": template base / list override / option / list-option override — the SAP verdict, stolen verbatim). Server-composed and grain-stripped, so a Worker-shaped caller mathematically cannot see cost or margin.
- **Reprice ripple**: editing a material's `costCents` shows "N templates reference this material" (and, once FP3 exists, open quotes — the query ships now, counting zero).
- CSV import with dry-run for materials and for options-per-template; full pricing-model export.
- Optional **starter structure** button: creates a real, zero-priced "Custom Cowhide Suit" template pre-filled with the canonical groups (Leather type, Lining, Armor level, Perforation, Custom fit, Branding) — scaffolding to edit, clearly labeled, no fake prices.

**OUT (named):** quotes and the thread-born configurator (FP3 — the preview is its dress rehearsal), quote-level snapshots (FP3), party workspace + measurement profiles (FP5), lots/ledger surfaces/purchase orders (FP7), certificate file upload (metadata + optional link now; files ride the Drive flow later), effective-dated price lists (backlog), option images/visual config (IGNORE verdict), multi-currency (EUR per F0).

## The pricing formula (normative — the engine implements exactly this)

```text
resolvedBase(list)      = list.entry(template).basePriceCents ?? template.basePriceCents
priceDelta(option,list) = list.entry(option).priceDelta ?? option.priceDelta       (mode rides along)
absΣ                    = Σ deltas with mode ABSOLUTE (cents)
pctΣ                    = Σ (deltaBp / 10_000) × resolvedBase     ← percent applies to BASE, never compounds
listPriceCents          = resolvedBase + absΣ + pctΣ
costCents               = template.baseCostCents + same shape over costDelta        (global — costs never vary by party)
netPriceCents           = listPriceCents + adjustmentCents        (quote-level manual ±, with reason — used by FP3)
marginCents             = netPriceCents − costCents;  marginPct = margin / net × 100 (0-safe)
materials               = base BOM + Σ selected options' draws, merged by material
violations              = REQUIRES(if selected → then must be selected) · EXCLUDES(both selected) · group min/max — each with severity + message
goalSeek(targetNet)     → adjustmentCents + resulting margin;  goalSeek(targetMarginPct) → adjustment + resulting net (two-way, the Tacton verdict)
priceSource per line    = which layer decided it (template | list-base | option | list-option)
```

Engine tests (vitest, exhaustive): abs+pct mixing · sparse list fallback to defaults · both constraint types × both severities · group min/max validity · goal-seek round-trips (net→margin→net exact) · zero/negative margin flagged · draws merging · percent-of-base non-compounding.

## Layout

`/products` becomes a three-tab workspace (DS `Tabs`): **Templates · Price lists · Materials**.

```text
TEMPLATES tab:  DataGrid (name · groups · options · cert chip [OK/expiring/missing] · base price* · updated)
   → detail:    header (name, base cost*/price*, archive) + Tabs:
                Options      groups as cards (drag-sort) · option rows inline-editable (name, cost Δ*, price Δ, mode toggle €/%)
                Constraints  sentence list ("Perforated panels EXCLUDES Waterproof liner — blocks") + builder (2 Listboxes + type + severity + message)
                BOM & draws  base BOM grid (material, qty, unit) + per-option draws editor
                Certificates attach/detach from the registry; per-coverage sizes
                Preview      party Listbox → option toggles (RadioCard/Checkbox per group) → right rail: waterfall* + margin* + materials + violations + goal-seek fields*
PRICE LISTS:    grid (name · kind · entries · parties) → detail: sparse override grid (only overrides are rows; "+ Override…" pickers) + party multiselect
MATERIALS:      grid (name · unit · cost* · used-by-N-templates · reorder level) + CSV import panel (dry-run idiom)
```
`*` = grain-gated: absent without `financials.*` (server-stripped; columns don't render as empty husks — the column registry checks the grain).

## Component reuse (all DS, nothing hand-rolled that exists)

| Need | Component |
|---|---|
| Grids | `DataGrid` (all tabs), `GridToolbar`, `BulkActionBar` (bulk archive options / delete overrides) |
| Editors | `Modal` (template/list/material create), `Drawer` (option + constraint editors), `Input` with `prefix="€"` / `suffix="%"`, `Listbox`, `Checkbox`, `Toggle` (mode €/%), `Tag` |
| Preview | `RadioCard`/`Checkbox` per group semantics, `Card` rail, `Pill` (violations, price-source), `Banner` (BLOCK explanations) |
| Feedback | `useToast`, DS `Modal` confirms with consequence bullets (e.g. archive template referenced by N lists) |
| Drag-sort | `@dnd-kit` (already a dependency via the DS PreferencesModal pattern) |
| States | `Skeleton` rows, `EmptyState` per tab with purpose + next action |

## Data & API

**Schema migration: NONE** — every entity shipped in F1 (`ProductTemplate`, `OptionGroup`, `Option.materialDraws`, `OptionConstraint`, `BomLine`, `Certificate`, `CertificateCoverage`, `PriceList`, `PriceListEntry`, `Material`). One **registry addition** (code only): `FEATURES.materialsManage = "materials.manage"` — catalog CRUD is a different act from adjusting stock (`materials.adjust`, FP7) and WORKER gets neither.

Routes (all `guarded()` + coverage-checked; money responses via `jsonStripped`):

| Route | Methods | Permission |
|---|---|---|
| `/api/products/templates` | GET, POST | `products.manage` (GET: `pages.products`) |
| `/api/products/templates/[id]` | GET, PATCH, DELETE(archive) | `products.manage` |
| `/api/products/templates/[id]/groups` · `/api/products/groups/[gid]` · `…/options` · `/api/products/options/[oid]` | POST / PATCH, DELETE | `products.manage` |
| `/api/products/templates/[id]/constraints` · `/api/products/constraints/[cid]` | POST / PATCH, DELETE | `products.manage` |
| `/api/products/templates/[id]/bom` | PUT (replace-set) | `products.manage` |
| `/api/products/preview` | POST {templateId, selections[], priceListId?, adjustmentCents?, goalSeek?} | `pages.products` |
| `/api/certificates` · `/api/certificates/[id]` | GET, POST / PATCH, DELETE | `products.manage` |
| `/api/pricelists` · `/api/pricelists/[id]` | GET, POST / GET, PATCH, DELETE; entries PUT; parties PUT | `pricelists.manage` (GET: `pages.products`) |
| `/api/materials` · `/api/materials/[id]` | GET, POST / PATCH, DELETE(archive) | `materials.manage` (GET: `pages.products`) |
| `/api/imports/materials` · `/api/imports/options` | POST {csv, dryRun} | `imports.run` |
| `/api/exports/pricing-model` | GET (CSV) | `exports.run` |

Deletion policy (docstatus spirit): templates/materials referenced anywhere → **archive**, never delete; hard delete only for never-referenced rows; every mutation audited; `import.finished` / `conversation.updated`-style events published (`pricing.updated` joins the event union) so FP3 can live-refresh later.

## Interactions

- Option rows edit inline (click-to-edit cells, Enter commits, Esc reverts); groups and options drag-sort with immediate persist.
- Mode toggle per delta: `€` absolute ⇄ `%` of base — the row shows the resolved € effect next to a % entry ("+8% → +€64.00 on this base") so percent never surprises.
- Constraint builder renders live as a sentence; saving re-validates existing templates' preview state.
- Preview recomposes on every toggle via the server (debounced ~150 ms — local SQLite; the strip boundary stays server-side). Goal-seek: type a target net → adjustment + margin fill; type target margin → net fills (two-way).
- Material cost edit prompts the ripple banner: "Used by N templates — their composed costs change immediately; sent quotes are snapshots and never move" (FD frozen-history rule stated where the Owner acts).
- Every price shows its **source** on hover (template / list / option / override) — the "why this price" line.

## States

Skeleton grids; per-tab EmptyStates ("No templates yet — start from the Cowhide Suit structure or create blank"); BLOCK violations render as danger Banners in preview with the human message; archived rows hidden behind a filter toggle; all destructive confirms state consequences (counts of references).

## RBAC

`pages.products` to see; `products.manage` / `pricelists.manage` / `materials.manage` to change; every `*Cents`/`*Delta` field rides the existing grain strip (costs → `financials.costs.view`, prices/deltas → `financials.prices.view`, margins → `financials.margins.view`). WORKER: the page isn't in their nav, the API denies, and the strip is the third fence — verified by a role-shaped test on `/api/products/preview`.

## Bulk / import-export

Materials CSV (name, unit, cost_cents, reorder_level) and per-template options CSV (group, min, max, option, cost_delta, cost_mode, price_delta, price_mode) — both through the dry-run diff idiom with per-row results. Export: the full pricing model as CSV (templates + groups + options + overrides per list), the Owner's spreadsheet-audit interface.

## Teardown verdicts applied (traceability)

| Verdict (F0-TEARDOWN) | Where it lands |
|---|---|
| CPQ bundle = features(min–max) → options — ADOPT | OptionGroup/Option model + editors |
| Option constraints requires/excludes, ONE table — ADOPT + BEAT | The constraint tab (sentences, two severities, one engine) |
| Price waterfall collapsed to 4 visible lines — ADAPT | Preview rail: Cost → List → Adjustment → Net (+margin) |
| Cost+markup with permission-gated cost visibility — ADOPT | Grain-gated everything; server-side strip |
| Contracted per-party pricing auto-applied — ADOPT | PriceList sparse overrides + party assignment |
| "Price Source" explains why — ADOPT (SAP) | Per-line source labels |
| Goal-seek target price ⇄ margin — ADOPT (Tacton) | Preview two-way fields |
| Cost roll-up → suggested price + reprice ripple — ADOPT (Craftybase) | Ripple banner + live recompose |
| Spec-artifact→BOM — ADAPT (Genius CAD2BOM) | Per-option material draws composing the material list |
| Item-master-before-quote — BEAT (SAP) | Templates are option sheets, not SKU ceremonies; SKUs never explode |
| Cert/testing docs first-class — BEAT (apparel trio) | Certificate registry + coverage + expiry chips (FD14; QC gate lands FP6) |

## Acceptance targets (gate-2 click-through preview)

Create the starter Cowhide Suit → set base cost/price → add "Kangaroo leather +€120 / cost +€80" and "Perforated panels +5%" → constraint "Perforated panels EXCLUDES Waterproof liner (BLOCK)" → import materials CSV (dry-run → apply) → give Kangaroo a draw of 2.5 SQM kangaroo hide → attach an EN 17092 AA cert (expiry next year → OK chip) → create price list "Listino B2B", override the suit base −10%, assign a brand party → Preview: toggle options as Listino base vs Listino B2B (watch List and source labels change), trip the EXCLUDES block and read the message, type a target margin and watch net fill → edit kangaroo hide cost and read the ripple banner → export the model CSV → confirm a Worker-shaped request to `/api/products/preview` returns no cost/margin keys. Engine suite green (~25+ new tests); 58+ existing tests stay green; rbac coverage/no-touch/parity/build green.

## Build plan (no time estimates)

FP2.1 engine + tests + registry addition → FP2.2 templates/groups/options/constraints (API + UI) → FP2.3 materials mini-registry + BOM/draws + certificates → FP2.4 price lists + preview panel → FP2.5 imports/exports + ripple + polish + headless verify (isolated :3199, `.next-verify`) + `FP2-REPORT.md`. Each sub-phase a scoped commit; push at cycle end; STOP for gate 2.
