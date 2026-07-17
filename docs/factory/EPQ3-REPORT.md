# EPQ.3 — Gate report: pricing discipline

Built to `EPQ-PROPOSAL.md` §5 EPQ.3 by a worktree agent (branch `worktree-agent-ac1003af4a3bf14f5`, commit `feat(factory): EPQ.3 — …` + follow-up build-env fix). Migration `epq3_pricing_discipline` authored additive and **NOT applied** — the merging session runs `prisma migrate dev` after the Owner's dev server restarts (trap 6b), exactly like EPQ.2.

## Plain English

Pricing now has discipline you can see. Type the number you want the quote to land on — target net or target margin — and the active line's adjustment is solved for you, then the cursor jumps to the reason field, because a discount without a story is still not allowed. Every adjustment can carry a coded WHY (Loyalty, Competitive, Volume, Rework, Goodwill, Other) beside the free text. Quantity tiers and a below-MOQ surcharge per product, plus an automatic size surcharge above a threshold, each show as their own labeled line in the price waterfall — nothing is folded invisibly into a total. Brand quotes get a size-run matrix (sizes × quantities as ONE line, the sum becomes the qty, production explodes it per size after convert). If you open a quote while another open quote for the same party has the same configuration, a banner tells you before you price the same job twice. Similar past quotes now show a "repeat" chip when they were actually produced, and clicking one opens it. None of this changes a single existing number: with no tiers, no MOQ and no size rule configured, every old quote composes to the cent it composed to before — that parity is asserted in tests.

## Shipped

- **Engine (`src/lib/pricing.ts`)** — `compose()` gains optional `qty` + template `quantityBreaks`/`moqQty`/`moqSurcharge*` + `sizeSurcharge` rule; three new labeled waterfall rows (kind `surcharge`, sources `quantity-tier` | `moq` | `size-surcharge`), all folded into `listPriceCents` per unit, costs untouched. Absent inputs ⇒ byte-identical output (parity block in tests).
- **Goal-seek (S7 killed)** — `src/lib/quotes/goal-seek.ts` reuses `goalSeekByNet/ByMargin` verbatim on an aggregated base; `POST /api/quotes/lines/[lid]/goal-seek` (DRAFT-only, `quotes.create`) returns the solved per-unit `adjustmentCents`; the rail's field pair (Target net / Target margin %, margin grain-gated) applies it through the NORMAL line PATCH and focuses the reason input.
- **Rail truthfulness** — new read-only `GET /api/quotes/lines/[lid]/compose` composes the STORED line qty-aware (the old `/api/products/preview` rail path was qty-blind and would have hidden the tier/MOQ rows); the "This line" card shows List (pre-discipline) → each surcharge row → Adjustment → Net.
- **Reason codes** — `QuoteLine.adjustmentReasonCode` + enum-in-code (`src/lib/quotes/reason-codes.ts`), Listbox beside the reason text, code shown in the waterfall annotation, before/after in the line audit.
- **Tiers + MOQ (B2B)** — `QuantityBreak` model (`@@unique([templateId, minQty])`) + `ProductTemplate.moqQty/moqSurchargeMode/moqSurcharge`; highest tier ≤ qty applies; below-MOQ adds its row. **API-only for now** — see handoffs.
- **Measurement surcharge** — AppSetting `quotes.measurementSurcharge` (lazy defaults `{sizeThreshold: 58, mode: PERCENT, value: 800}`), applied in compose-line when a selected option in a size-NAMED group ("Size/Sizing/Taglia/Taglie") parses to a number ≥ threshold.
- **Size-run matrix (BRAND parties)** — modal editor (mirrors FP4 OrderItems); stored as `{options, sizeRun}` inside `QuoteLine.selections` via `src/lib/quotes/selections.ts` (legacy plain-array shape preserved for every run-less line); qty derived = Σ sizes (input locks); customer snapshot/PDF prints "Size run: 48×5 · 50×3"; **convert maps it into `OrderLine.sizeRun` + plain option-id array into `OrderLine.selections`** so production's cert-gate/reserve readers and per-size WO explosion keep working unchanged (verified: convert copies selections ✓, and now normalizes them).
- **Repeat-order plumbing** — `/api/quotes/similar` rows gain `wasProduced` (convertedOrderId set); rail card chips "repeat" and rows now OPEN the quote (`?q=`, inventory gap 7 closed). Actuals-prefill remains EPQ.4.
- **Duplicate-open-quote banner** — editor GET flags another DRAFT/SENT quote for the same party with the same template set (bounded take-10 candidate query + pure set compare in `src/lib/quotes/duplicate.ts`); warning Banner links to it.
- **FS3 adoption (registry row)** — pipeline `DataGrid` → `VirtualDataGrid` (height-bound `calc(100dvh − 380px)`); New-quote party Listbox → `AsyncCombobox` over `parties-lite?q=` (whole-table prefetch gone).

## Choices flagged (per the phase brief)

- **Size hook = name-pattern parse, not an option flag.** The live catalog has NO size option group at all (checked read-only: Leather/Lining/Armor/Perforation/Custom fit/Branding), so nothing structural exists to flag; a group named Size/Taglia with numeric option names lights the rule up with zero schema or Products-page surface. The surcharge is therefore dormant on live data until sizes are modeled — deliberate.
- **Tier/MOQ seeding is API-only.** The "existing template routes" are Products-page files (out of scope for this phase), so no editing surface ships; values enter via DB/scripts until the EPD session builds the editor (handoff below).
- **Goal-seek targets the QUOTE total** (the pair sits under "Quote total"); solved per-unit adjustment lands within 1c for qty 1 (asserted), within qty/2 cents for larger runs (nearest-cent per unit — also asserted).

## Handoffs recorded

- **EPD (Products page, unclaimed):** tier + MOQ editor on the template detail (rows for `QuantityBreak`, `moqQty`/surcharge fields) + a surface for AppSetting `quotes.measurementSurcharge`.
- **EPA (Analytics page, unclaimed):** win/loss by-reason-code tally — `quoteWinLoss*` folds are groupBy(state, lostReason) counts; adding line-level `adjustmentReasonCode` needs a join, not trivial, so not touched here.

## Deviations (accepted)

- One extra read-only route beyond the brief (`lines/[lid]/compose`) so the rail can't lie about qty-dependent pricing — same composeQuoteLine path as PATCH/send, zero writes.
- `next.config.js` gains `turbopack.root` pinned to the checkout's monorepo root (separate commit): builds inside a git worktree saw two lockfiles, inferred the OUTER repo as root, and mixed the commerce tree's Next runtime into the factory build ("Expected workStore to be initialized" at export — reproduced on PRISTINE main in the worktree, so pre-existing environmental, not EPQ.3). On the main checkout the pinned root equals what Next already inferred — no behavior change.
- Adjustment `EuroInput` now honors `disabled` outside DRAFT (inventory note: it was the one editor input not passed `disabled`; the server always refused the write — the control just no longer pretends).

## Verified

- **407 tests / 46 files** (34 new in `epq3-pricing-discipline.test.ts`: parity ×4, tiers ×4, MOQ ×4, size surcharge ×6, size-run ×6, goal-seek ×5, duplicate ×3, reason codes ×2) · `check:rbac` 137 routes · `check:no-touch` · `check:ds-parity` 97/97 · `check:query-bounds` 139 files · `tsc` · `next build` green (after the root pin; verified against a scratch DB with the migration applied — `migrate diff --exit-code` = no difference between migration end-state and schema).
- **Headless runtime smoke on :3199** (prod build + scratch DB): boot 200, new routes guarded (401/403 unauthenticated); DB-level smoke through the real migrated SQLite: tier €380.00 ✓, below-MOQ €430.00 + labeled row ✓, goal-seek solve→apply→recompose = target ±1c ✓, size-run + reasonCode DB round-trip ✓ (all smoke rows removed).

## For the merging session

1. Restart the Owner's `:3100` dev server, then `npm run db:migrate -w @nexus/factory` (applies `epq3_pricing_discipline` — plain ADD COLUMNs + one CREATE TABLE, no rebuilds).
2. `prisma generate` rides the migrate; until both run, the new code must not serve live traffic (it selects the new columns).
