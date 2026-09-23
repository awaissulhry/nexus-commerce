

## A-46 — Step 4.3 #3, bullets in one cell: the plan. FOR YOUR RULING (two questions + one defect). Nothing built.

*Drafted by sub-agent P3 (read only). Builds with A-42's EditorShell (`ListBody`), after its gates are back (R-45).*

2026-09-23. "read" = line opened; "inferred" = not opened or not run. Builds only AFTER A-42 (EditorShell step 1) and the
restored editor-open gate (R-45).

### 1. The premise, re-checked — partly out of date
- 🟠 **Shared already has ONE bullets cell and no slots.** With a family schema (every studio master scope), bullets are
  unbounded → one list column `bulletPoints` (`sheet-columns.service.ts:580`, `:1321`), edited by the studio-local
  `AttributeShapeEditor` popup (`master/columns.tsx:394-395`; `AttributeShapeInput.tsx:46-52`: a Textarea per item, Remove,
  Add, no reorder, inline pixel styles, OUTSIDE the design system).
- **The ten slots exist on the CHANNEL scopes** (Amazon `bullet_point` 10 × 700 → `bulletPoints_1…10`,
  `channel-specs/amazon.ts:48`, `sheet-columns.service.ts:782-800`) and on a master sheet with no family (`MASTER_LIST_FIELDS`
  max 10, `:349`; the `/products` MasterSheet — not a studio builder, not switched here).
- So the new cell is for the channel scopes (`master/channelColumns.tsx`), and Shared's cell moves to the SAME editor.

### 2. Storage and every slot-name dependant (search `bulletPoints_` + `slot.of`/`slotKey(`; positive control: `studio-sheet.service.ts:886` found)
- Store: master `Product.bulletPoints String[]` (+ `localizedContent` per language); channel `ChannelListing.bulletPointsOverride`
  + `followMasterBulletPoints`; sent as Amazon `bullet_point` per language tag (the content resolver, R-LX-6).
- Slot keys are LIVE in: the write field `bulletPoints[3]` (`sheet-columns.service.ts:787`; `bulk-edit.service.ts:615-773`,
  AM.1 read-modify-write, holes kept — the 09-05 ruling); the per-slot cap key (`bulk-edit.service.ts:765-766`); widths
  (`studio-sheet.service.ts:886`); readiness list grouping (`readiness.service.ts:140-147`); formulas (`cell-formula.service.ts:570`,
  `formula-storage.ts:25`); cell history (`cell-history.service.ts:136`); `content-bulk-write.ts:33-35`; `information-validation.ts:27-32`;
  the Languages view (`language-sheet.ts:17-20`, `bulletPoints_3@de`); web `views.ts:33`, the list reset (`useChannelSheetAdapter.tsx:317-320`).
- 🟠 Correction: the master WORKBOOK exports the LIST, not the slots (`catalog-transfer-export.ts:121,143`,
  `catalog-workbook-scopes.ts:38,58` skip `c.slot`); the Amazon workbook uses `#N` headers (`catalog-amazon-workbook.ts:12`).
  "Do not replace the slots" still stands — every line above keys off them.
- 🔴 Found: the WHOLE-list write paths have no per-item cap — master `bulletPoints` drops blanks and has no length check
  (`bulk-edit.service.ts:990-1021`); channel `bulletPointsOverride` coerces a list only (`:851-858`). Only the SLOT path checks 700.

### 3. The new cell — a view over the ten slots, written as SLOT writes
- **Column id `slots:bulletPoints`** — client-only, never a write field (the adapter refuses an unknown field,
  `useChannelSheetAdapter.tsx:509-511`), so a whole-list write that skips the caps cannot happen by accident.
- **Built in the engine, once:** new DS `grid/editors/slotListColumn.ts` — given a slot group (same `slot.of`) it returns the
  column def and a pure `slotListChanges(before, after, slotWriteFields)`. Both studio builders call it whenever a slot group
  exists (so they cannot drift); no API file changes, so export, readiness, completeness and formulas never see it.
- **Shows:** `N of 10 · <first bullet>`, the inherited mark when the listing follows the master, the room-left mark of the
  fullest position (`cells.tsx:334`).
- **An edit → slot writes:** each changed position i → `{ field: bulletPoints[i], value | null }`, all in ONE request with the
  row's `expectedVersion` (the one door, `PATCH /products/bulk`). The server's AM.1 path seeds, composes in order, keeps holes and
  checks 700 per slot. Count cap = the positions (1…max from the channel facts). Per-position cap shown as a counter; the server
  is the judge (Step 3.6: per-row refusal, the rest saved).
- **Reorder:** move up/down (buttons + Alt+↑/↓) — rewrites the positions it touches. **Empty positions:** shown, never compacted.
- **Pinned / following:** following → shows the master's list, marked; an edit pins the whole list (AM.1 seeds the rest, as a
  slot edit does today); "follow the master again" = the existing list-level reset.
- **Languages view:** one virtual cell per language slot group (`slots:bulletPoints@de`), built by the same helper.

### 4. The editor and its keys
- A DS **`ListBody`** for the EditorShell (A-42): fixed positions, DS `Textarea` per position, counter vs cap, move / clear.
  It replaces `AttributeShapeEditor` for bullets on Shared too — one bullets editor everywhere. Catalogued, changelogged, a
  `.claude/DS-GAPS.md` row, mirrored in `apps/factory`.
- Keys = the A-42 model (R-48's one hint line): Enter commits + moves down · Esc cancels, never writes · click-away commits ·
  opened and untouched = 0 writes · a line break in a bullet is refused (Amazon bullets are one line — inferred from the spec
  kind, to confirm) · Tab: **Question 1**. AG36: the body reports through `props.onValueChange`; keys taken with the shell's
  `suppressEditorKeys` (an AG popup owns Enter/Tab/Esc otherwise).

### 5. Pixels, declared before landing
New column 240 px, immediately before `Bullet 1`, same group. The popup through `editorBox` (new kind `slotlist`): width
min(560 px, 85 vw), max-height 65 vh, anchored under the cell (today's `AttributeShapeEditor`: 520 px, inline style). The ten
slot columns keep their 110 px and order; they shift right by 240 px only when the new cell is shown. Nothing else moves.

### 6. The gate
- Node (apps/web vitest is node-only): `slotListChanges` — all ten round trip; a hole kept; reorder; clear; untouched → 0 changes.
  Parity: both builders emit the column when a slot group exists, neither when it does not; the colId is never a write field.
- API (the real save path on PGlite, as `paste-validity.vitest.test.ts`): ten slot changes in one request → the stored list equals,
  holes kept; one position of 701 chars refused per row, the others stored.
- Browser (the restored editor-open gate): a `slotlist` row on AMAZON·IT and EBAY·IT — open; Esc = 0 writes; untouched = 0 writes;
  one position edited = exactly 1 slot write.
- Mutations: the fan-out sends one whole-list write; a hole compacted; reorder loses a position; one builder without the column;
  the colId sent as a field; the untouched guard removed.

### 7. Files it would hold
DS: new `grid/editors/slotListColumn.ts`, new `grid/editors/ListBody.tsx`, `editorBox.ts` (kind), `index.ts`, catalog example +
index, `CHANGELOG.md`, `.claude/DS-GAPS.md`, and the `apps/factory` mirrors. Studio: `master/channelColumns.tsx`,
`master/columns.tsx` (Shared → `ListBody`), `channel/useChannelSheetAdapter.tsx` + `master/useMasterSheetAdapter.tsx` (the
fan-out call), `views.ts` (group). New tests. No API file.

### 8. Risks
A `valueSetter` that does not mutate `params.data` for the ten slot keys leaves them stale until a refetch · a `=` formula on the
virtual column must be refused (formulas stay on the slots) · ten writes share one CAS: a version conflict refuses them all ·
the whole-list paths' missing caps (§2) stay open for other callers — a separate fix · `/products` MasterSheet not switched.

### 9. Two questions for the Owner
1. **Tab inside the bullets editor:** move between the ten positions (leaving past the last commits and moves right), or the one
   model's "Tab commits and moves right"? — **Recommend: move between positions**; ten fields are a small form.
2. **Default view on channel scopes:** show the one cell and hide Bullet 1–10 by default (still in Customise, still used by
   import/export), or show both? — **Recommend: show the one cell, hide the ten by default.**

| # | Question | Ruling (2026-09-23 23:45 UTC, thirty-sixth set) |
|---|---|---|
| **R-55** | A-46 Q1 — Tab inside the bullets editor | ✅ **Moves between the bullet positions**; Tab past the last commits and moves right (a stated exception to R-48's one model, for this small form) |
| **R-56** | A-46 Q2 — channel scopes' default view | ✅ **The one cell shown, Bullet 1–10 hidden by default** (still in Customise, still used by import/export) |
| **R-57** | A-46 defect — whole-list bullet saves skip the per-bullet cap | ✅ **Fix it now:** the server checks every bullet on the whole-list paths too and refuses an over-long one per row with its reason |

### Step 4.2 — gate 1 of 4 in the hook: the 7:1 contrast ratchet (2026-09-23 23:50 UTC, R-45)
`.githooks/pre-push`, right after `check-global-exposure`: the script's own tests, then `check-nds-contrast.mjs --max-failures 49
--max-aa-failures 10`. `bash -n` clean; the stage passes on today's tokens and fails with the limit one tighter (control). Lower
both numbers as the AAA sweep (Step 4.3 #5) lands. The three browser gates follow when G1's fixes and runner are in (A-43).
