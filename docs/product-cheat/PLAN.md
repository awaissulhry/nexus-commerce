

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

## A-47 — R-57's premise is half false: channel bullet saves ARE capped; the MASTER (Shared) bullets are not, and no master cap exists. FOR YOUR RULING.

**Measured by sub-agent B1 (a probe with a positive control; `bulk-edit.service.ts` unchanged, hash checked).** Every bullets save
leaves `applyProductBulkEdits` early (`bulk-edit.service.ts:592`, `applyContentBulk`); the two branches P3 named (`:851`, `:990`)
and the slot cap (`:767`) are never reached by a bullets save (0 hits vs 544 on the control).
- ✅ **Channel scopes:** an over-cap bullet is refused and not stored; a whole list is refused as a wrong shape.
- 🔴 **Master (Shared):** a whole list and a single bullet over any channel's cap are both STORED. The master bullets column has no
  `maxLength`, no channel facts, and no master cap exists anywhere in the code. It is caught only later, when a channel refuses it.
- 🟠 Also found: content saves (title, description, bullets, keywords) are **all-or-nothing** — one bad bullet blocks the good one
  in the same request (Step 3.6's per-row result covered `attr_*` only); and the error names the wrong bullet ("Bullet 1" for a
  bullet-4 save).
- New `services/products/bullet-list-cap.vitest.test.ts`: 3 channel arms green + 2 arms pinned as expected-to-fail on the master
  defect (they turn red — i.e. must be flipped — when a master cap lands). Mutations 2/2 red. Related suites 42 green; `tsc` 0.

**Recommendation — one (a):** a master bullet may not exceed the TIGHTEST bullet cap of the channels the product is listed on (from
the same channel facts the slot path reads), checked at the content edit step (`:~584`), refused with its reason and the right
bullet number; a product listed nowhere keeps no cap. (b) A fixed 700 — not recommended (a number no channel declared).

| # | Question | Ruling (2026-09-24 00:12 UTC, thirty-seventh set) |
|---|---|---|
| **R-58** | A-47 — the master bullet cap | ✅ **(a)** The tightest bullet cap of the channels the product is listed on, checked at the content edit step; the error names the right bullet; a product listed nowhere keeps no cap |
| **R-59** | A-47 — content saves all-or-nothing | ✅ **Per row**, like attribute cells: good rows save, bad rows are refused with their reason |

## A-47 / R-58 — BUILT: master bullets are capped at the tightest channel cap; errors name the right bullet.

Built by sub-agent B1; re-run by this lane (products / price-door / content suites: 23 files, 235 tests green, 12 skipped as before;
the two bulk route files: 88 green; `tsc` 0). `services/products/bulk-edit.service.ts`: a master bullet may not exceed the tightest
bullet cap of the channels where the product OR its children are listed — each channel's cap from its own column rules (that
rule-building code extracted once, shared by both uses); listed nowhere → no cap; a channel whose cap cannot be read → the save is
refused (fail closed). Errors name the right position: *"Bullet 2 takes at most 20 characters — the Amazon · IT cap (it has 25)"*.
New `bullet-list-cap.vitest.test.ts` (11 arms; the two former expected-to-fail master arms are now real arms). **Mutations 6/6
red** (one — children not counted — first stayed green; a parent/child arm was added, then red).
*Done when* ✅ · *Cost when* `flat` (one read of the listings' channel facts per content save) · *Rollback* — revert.

🔴 **R-59 NOT built — premise changed.** Three callers treat ANY error from the content path as a whole failure: the translation
form (`routes/product-translations.routes.ts:147-151`), restore (`routes/products.routes.ts:838-841`), the AI writes
(`routes/products-ai.routes.ts:319-322`). Per row there would commit some fields and still report "failed", with no audit row.
**Recommendation:** per row as an OPT-IN used only by the sheet's `PATCH /products/bulk`; the three callers keep all-or-nothing.
- 🟠 **Stated:** R-45's hook cost was described to the Owner as "a few minutes"; G1 MEASURED ~20–26 minutes for a UI push that runs
  editor-open (see A-48). Raised with the Owner before the browser gates enter the hook.

| # | Question | Ruling (2026-09-24 ~09:30 UTC, thirty-eighth set) |
|---|---|---|
| **R-60** | A-47 / R-59 refined — per-row content saves | ✅ **Sheet only:** per row as an opt-in used by the sheet's `PATCH /products/bulk`; the translation form, restore and the AI writes keep all-or-nothing |

## Step 2.7 — CLOSED (verified 2026-09-24 02:35 UTC, run by this lane under R-40). Step 2.6's day-after check — ✅.

`node docs/product-cheat/tools/readiness-age.mjs` (production, `BEGIN READ ONLY`, `readOnly: on`) — record
`records/step-2.7-readiness-age-production-2026-09-24T02-35Z.txt`:

| R-28's verify | Measured |
|---|---|
| `CronRun` `readiness-reconcile` SUCCESS for both businesses | ✅ Xavia Racing 02:17:02–02:22:58 UTC (356 s) · Motovento 02:17:00–02:17:01 |
| `stopped: complete`, 0 failed | ✅ *"32 done · 9741 rows · stopped: complete"* · *"2 done · 22 rows · stopped: complete"* |
| no live product without a row since the deploy | ✅ Xavia Racing 333 live products, **0** without a row since the 06:46 UTC deploy; Motovento 22, **0** |
| roots due now | **0** in both (34 live roots) |

The run inside the 10-minute budget (356 s for 32 roots) — the deployed job is still the id-order one (A-30 ships with the next
merge); at 34 roots it covers the catalogue in one night, as predicted. 🟠 Stated: Xavia Racing still holds 145 rows computed on
2026-09-14 (5 families); every LIVE product has a newer row, so they belong to products that are no longer live.
**All four closure fields:** *Done when* ✅ (the verify above) · *Cost when* — bounded at 10 min a night; 356 s today · *Gate* — A-30's
8 arms + 5 mutations, and this verify · *Rollback* — revert A-30; the data is derived.

`node docs/product-cheat/tools/axis-stores.mjs` (production, read only) — record `records/step-2.6-axis-stores-production-2026-09-24T02-35Z.txt`:
legacy `va` sizes **35**, colours **44** — ✅ **not grown** (= the 21:09 mid-way run and the post-2.6d count); store `vr` 301 / 285;
`va` vs `vr` **0** differ.

## A-48 — Step 4.2: the three browser gates are fixed and run end to end behind a runner. TWO QUESTIONS FOR YOU. Not in the hook yet.

Built by sub-agent G1 (report: session scratchpad `G1-report.md`; nothing committed yet). 🟠 Method miss stated by G1: predictions were
not written before its first run; it overwrote `scripts/lib/gate-aloneness.test.mjs` by mistake and restored it byte-identical from git.

| Fix | Where |
|---|---|
| 🔴 the editor-open write guard: any non-GET to `/api/…` OR `/backend/api/…`, **on any host**, is aborted and counted (the old rule let a proxied `PATCH /backend/api/products/bulk` reach the database) | new `scripts/lib/gate-write-guard.mjs` (+6 arms), used by editor-open and grid chrome |
| `pgrep -af` — the safe wrapper refused on every run since 09-13 | `scripts/lib/gate-aloneness.mjs` (+1 arm) |
| sign-in accepts `/backend/api/auth/me`; grid chrome signs in; workspace-scoped URLs; census itemises every red surface | the gate scripts + `scripts/studio-browser-auth.mjs`, `scripts/studio-gate-session.mjs` |
| the runner (R-50): path-scoped by each gate's own stamp list; OWN servers on free ports + the LOCAL database (read back from the API process's env; the 28 root-`.env`-only keys blanked); a ratchet vs `scripts/browser-gates-baseline.json`; NOT MEASURED always fails; stops what it started | new `scripts/run-browser-gates.mjs` (+10 arms), `package.json` `gates:browser` |

**Measured end to end (run 2, 2026-09-24 00:53–01:19 UTC, 1,543 s):** servers 8 s · grid chrome ✅ 16 s, 0 writes · editor-open 1,130 s —
every open gesture ✅ 20/20 kinds with **0 writes armed**, geometry ✅, master contract ✅; **Amazon·IT renders no rows locally** → 18
NOT MEASURED keys · census 387 s — master ✅, eBay·IT ✅, **Amazon·DE NOT MEASURED** (`studio/destination` → 400, most likely the
local Amazon account is disconnected — inferred). Baseline = those **25 blind keys**, printed on every run as *"BLIND there
(baselined, not green)"*. 🟠 Unresolved: U2 saw census 14/14 incl. Amazon·DE with its own older account. Mutations **10 of 11 red**
(M8 did not mutate — a later SIGKILL still stopped the server; M8b replaced it, red).

🔴 **The cost is ~20–26 minutes for a push that touches the editors or the grid** (editor-open ≈ 19 min). R-50 was chosen on "a few
minutes" — wrong; this is the measured number. A push that touches none of the watched files: ~1 s.
🔴 **A decision G1 took, for you to accept or undo:** the disposable local gate user copies the WIDEST role (today ADMIN) with MFA off —
the only way a gate can open a channel scope (`settings.integrations.manage`). Local only, deleted after each run, API writes aborted.
Noted, by design: `apps/api/src/env.ts:18-19` loads the root `.env` (production channel credentials) after the cwd `.env`,
non-overriding — hence "run the API from `apps/api`"; the runner blanks those 28 keys for its own servers.

| # | Question | Ruling (2026-09-24 ~09:45 UTC, thirty-ninth set) |
|---|---|---|
| **R-61** | A-48 Q1 — the gate cost, measured (~20–26 min on a UI push) | ✅ **All three browser gates in the push** (path-scoped) |
| **R-62** | A-48 Q2 — the disposable local gate user copies the widest role (ADMIN), MFA off | ✅ **Accepted** |

## A-47 / R-60 — BUILT: content saves are judged per row on the sheet's `PATCH /products/bulk` only.

Built by sub-agent B1; re-run by this lane (26 files / 328 tests green, 12 skipped as before; `tsc` 0). `bulk-edit.service.ts` — an opt-in
`contentPerRow`; `pim/content-bulk-write.ts` — with it, only good rows are written and the errors merged; `routes/products.routes.ts` —
ONE line, `contentPerRow: true`, in the `PATCH /products/bulk` handler. Without the flag nothing changes: restore, the translation form
and the AI writes keep all-or-nothing. New `content-per-row.vitest.test.ts` (5 arms: the real sheet route stores the good title and
refuses the over-long bullets; a refused row is not stored; no flag → nothing stored; only the sheet route sets the flag — a source
read; audit rows only for saved fields). **Mutations 5/5 red.** ⬜ Not tested: a mixed content + `attr_*` request where every `attr_*`
row is refused; the sheet's on-screen display of a per-row content refusal (the browser half) — not run.
*Done when* ✅ (tests) · *Cost when* `flat` · *Rollback* — revert.

### Step 4.2 — all four gates in the hook (2026-09-24 ~09:55 UTC, R-45, R-61)
`.githooks/pre-push`: after the contrast ratchet, the browser-gate stage (the runner's own tests, then `run-browser-gates.mjs
--pre-push`); the `.next-gate-*` dirs join the two-hour sweep. `bash -n` clean; a docs-only change → *"no watched file changed —
not run"*, exit 0 (checked). **Done when** (the plan's: five gates in the hook and green) — the four the plan names are in; green
against their ratchets; the first push through them is the proof (below, when it lands).
