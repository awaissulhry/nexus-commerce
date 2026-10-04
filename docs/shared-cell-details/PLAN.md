# Cell details on the Shared scope — one window for both scopes (PLAN, 2026-10-04)

Branch `feat/shared-cell-details`, from origin/main `6f28ee119` (includes #302). Status: **APPROVED 2026-10-04** ("Yes, start"; decisions below).

## Summary

- Today only the channel scopes have "Cell details…" (right-click, Shift+F10, toolbar ⋯). The window is inline JSX in
  `sheet/channel/useChannelSheetAdapter.tsx` (~906-949, ~1289-1300, ~1516-1524). The Shared scope explains a cell only by
  hover, so phone and keyboard users cannot read it.
- This PR: ONE window component, ONE menu item and ONE ⋯ item, owned by the shared `useSheetControl`; each scope supplies
  only "describe this cell". The channel window looks and behaves exactly as today.
- On Shared the window says what the value is, where it comes from (the mark's own sentence — the same function, so the
  mark and the window can never disagree), what an edit changes, the family count, checks, language, formula, AI
  draft, read-only reason and save state — and offers only actions that have a real writer.

## The shared window (no visible change on channel scopes)

- `sheet/CellDetailsDialog.tsx` (DS `Modal` + `Button`, beside `SheetControlDialogs.tsx`) — the channel window moved
  as is: title `{field}: {SKU}`, value, notes, Close, action button(s), focus back to the cell on close.
- `sheet/cellDetails.ts` (pure): `CELL_DETAILS_COPY` (item, description, "Select an attribute cell first…" toast),
  `CellDetailsContent { title, value, notes[], actions[] }`, `cellDetailsValue()`. Each action names its writer
  (`reset` = the cell menu's own writer; `cascade` = the channel pin/reset) — no writer, no button.
- `useSheetControl` gains `details: { explains(colId), describe(row, colId), cascade? }` and returns the menu item,
  the ⋯ item and the window. Right-click, Shift+F10 and ⋯ then work the same on both scopes.
- Channel: `channelCellDetails(row, column, ctx)` = today's `openCellDetails` content, moved to a pure function with
  golden tests taken from today's output. Menu order unchanged ("Open reusable mapping", resets, Cell details).

## What a Shared cell's window says

| Section | Words | Source of truth |
|---|---|---|
| Title / value | `{field}: {SKU}`; the value as the cell formats it (labels, lists, records), or "Empty" | the column's own formatter |
| Where it comes from | the mark's sentence, word for word; no mark: "This row's own value" / "No value yet" | `provenanceTooltip(member, from)` — shared with the mark |
| What an edit changes | "Saved on the Shared product{, as its German text}. Listings that follow the Shared product for this field change with it; a listing with its own value keeps it." (no count: this scope does not know it) | `contentAddress.tier` |
| Family row | "17 of 20 variations follow this value; 3 have their own." Follows = inherits from the family row; own = a value, pin or formula of its own. No count when the family value is empty or itself a language fallback, or when a variation is neither (a fallback to its own text) — follow + own always equals the variations counted. Not the column menu's "Reset column to inherited (n)" (that counts only rows on screen, and on a language column the family row's own translation too). | `inheritedFrom` per variation (`familyFollowCount`) |
| Checks | the validation message; "Required by Amazon · DE, the product family" | `sheetValidationFor`, `requiredBy` per row |
| Language | "German text, written by machine, not reviewed" / "Out of date" | `cell.translation` |
| Formula / AI draft / read-only / save | the expression and the server's last error; the hover's draft lines; the read-only reason; the save note | existing helpers |

One function feeds the mark, the hover and the window (`markFrom` and the hover's notes move to `columnRules.ts`).

**Columns:** relationship, variation theme, bullets, read-only and not-applicable cells open the window (with their
reason). Product photos → "Photos have their own editor: press Enter on the cell." Progress, Status, Action and
Product → "Select an attribute cell first, then open Cell details."

## Words fixed in the same PR (honesty)

- No "Master" in user words: the header "Required by Master" → "Required by the Shared product"; "master sheet" → "Shared".
- Sentences that advise an action the sheet cannot do ("translate again or mark reviewed") name where it is done, or drop
  the advice. Done ONCE in the design system (`provenanceTooltip`), for both scopes — no per-page override: "Out of date —
  the source changed after this translation was written"; a machine translation (`ai` / `aiStale` with "the source text")
  "Translated by machine and not reviewed yet" / "Translated by machine from an older value — the source text has changed
  since"; a PES.8 AI draft keeps its sentences (the AI drafts review does approve it). The channel Cell details drop "Review
  it before it counts as confirmed" and "Translate it again or review it" (the one intended channel change).
- A Shared content edit is sent to following listings automatically — never write "Publish sends it".

## Contract (fixed by the lead before the build agents start — already in the tree)

- `sheet/cellDetails.ts`: `CELL_DETAILS_COPY`, `CellDetailsAction { label, description, run }`, `CellDetailsContent
  { title, value, notes (one composed text), action? }`, `CellDetailsSource<Row> { explains(colId) → true | false |
  { refusal }, describe(row, colId) → content | null }`, `cellDetailsValue(value)`.
- `useSheetControl` (agent E): `SheetControlOptions<Row>.details?: CellDetailsSource<Row>`; returns
  `cellDetails: { open(row, colId): void; overflowItem }` (the toolbar ⋯ item, same type the adapters' overflow lists
  use); `cellMenuItems(params)` appends the Cell details item when `explains(colId) === true`; the window renders inside
  the hook's existing `element`; focus goes back to the cell on close (by row id; a row inside a collapsed group keeps
  no focus — say nothing).
- Shared adapter (agent F): passes `details` and places `control.cellDetails.overflowItem` in its ⋯ list (before
  "Formula history…"); the right-click menu shows it through `cellMenuItems`.

## Build

- Agent E: the shared window + `useSheetControl` + the channel move (golden tests: channel unchanged).
- Agent F: the Shared content (`sharedCellDetails`, `columnRules` helpers, master adapter wiring, the words above).
- Then a review, checks (typecheck, sheet tests, guards), one browser pass on the private stack (Shared + eBay + Amazon,
  light + dark, 1280 + 390: right-click, Shift+F10, ⋯, phone), the public-repo id scan, PR. Merge on the Owner's word.

## Owner decisions (2026-10-04)

1. **Actions in the Shared window: only what the Shared cell menu already does** — "Reset to inherited" (and its
   formula version). One button, like the channel window. AI drafts stay in their own review panel; no new "Keep this
   value and remove the formula" item.
2. **A variation's own axis values (colour, size …) on Shared: NO mark** — a variation's axis value is always its own
   and never follows the parent, so "Pinned — it no longer follows GALE-JACKET" (live since #302) was misleading.
   Cell details says "This variation's own Colour" (the column's label as written: "Size (EU)", "Colore"). (40 fewer marks
   on GALE-JACKET.) A language fallback on an axis stored as text (German asked, the variation's own Italian "Nero") keeps
   its 🔗 "Inherited from the Italian text". The Variants tab draws its axis columns with the same factory
   (`buildMasterColumns`), so its colour and size cells lose the ✎ and the pinned tint too.
