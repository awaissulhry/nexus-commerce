# C — design-system parts for the approvals grid (2026-10-05, not committed)

**1. ChangeCell (G1)** — `@/design-system/grid`. `ChangeLine = { label: string; from: string | null; to: string | null }` (values pre-formatted; `from: null` = new value, `to: null` = removed).
`<ChangeValue changes={ChangeLine[]} more?={n} compact?={false} hideLabels? className? />` (drawers/lists; renders null when empty). Grid: `changeColumn<T>(field, { compact? = true, hideLabels? })` → `ChangeCell`; cell value `ChangeLine[] | { changes, more }`; sets tooltip (all lines), CSV/clipboard and quick-filter text; not sortable; no change = the grid dash. Screen readers hear "Price: from €49.90 to €44.90; and 2 more changes".
```tsx
{ colId: 'change', headerName: 'Change', width: 200, ...changeColumn<Row>('change'), valueGetter: (p) => ({ changes: p.data?.changes ?? [], more: p.data?.moreChanges }) }
<ChangeValue changes={row.changes} more={row.moreChanges} />   // drawer: every line
```
**2. Two row verbs (G2)** — `@/design-system/grid`. `actionsColumn<T>({ primary?: RowVerb<T> | [v] | [v, v] | ((row: T) => RowVerbs<T>), items?, menuLabel?, width?, pinned? })`.
`RowVerb<T> = { id?, label: ReactNode, tone?: 'primary' | 'default' | 'danger' (red outline), href?(row), onClick?(row), disabled?(row) => reason | null/undefined/false, ariaLabel?(row) }`. A held verb stays focusable (aria-disabled + portal tooltip + aria-description), click does nothing. A click anywhere in the actions cell never fires `rowClicked`/`cellClicked` (AG stop flag set in the capture phase; the button handler still runs). Two verbs/function: width 200 + `suppressKeyboardEvent: rendererOwnsKeyboard` (Tab walks Approve → Reject → ⋯). The single-object form is unchanged: markup byte-identical to HEAD (checked), width 120; callers checked: products/next/columns.tsx, grid-lab GdsScenarios (2). Registry: `actionVerbs<T>({ actions, onSelect, isRecord?, show: ['approve', 'reject'], tones?, ariaLabel? })` → `(row) => RowVerbs<T>`; `actionMenuItems({ …, omit: ['approve', 'reject'] })` keeps ⋯ from repeating them.
```tsx
const approve: RowVerb<Row> = { id: 'approve', label: 'Approve', tone: 'primary', onClick: approveRow, disabled: (r) => r.heldReason, ariaLabel: (r) => `Approve: ${r.what} ${r.sku}` }
actionsColumn<Row>({ primary: (r) => (r.status === 'waiting' ? [approve, reject] : r.status === 'failed' ? [retry] : []),
  items: (r) => [{ id: 'automate', label: 'Automate this kind…', onSelect: () => openAutomate(r) }], menuLabel: (r) => `More actions for ${r.what}` })
```
**3. Countdown (G7)** — `@/design-system/components`. `<Countdown to={iso | epochMs} label?={(t) => string /* default "in 14 s" */} doneLabel?="now" onDone?={fn} announce?={true} now?={ms} className? />`. A component, not an `AsOf` live mode: AsOf is an observation stamp ("checked 5 min ago"), a countdown is a deadline whose end the page acts on. 1 s ticks under 60 s, then ≤30 s ("3 h"); ONE shared timer per page (tested with 50 subscribers), none while the tab is hidden (catches up on return); re-renders only when its words change; `onDone` once at zero, only if it saw time left (a moment already past at mount does not fire); polite aria-live at 60/30/10 s and zero, cleared after 4 s. In a busy grid D may pass `announce={false}` and own one live region.
```tsx
<Countdown to={row.executeAfter} label={(t) => `Runs in ${t}`} doneLabel="Starting…" onDone={refresh} />
```
**4. useGridShortcuts (G8)** — `@/design-system/grid`. `useGridShortcuts(containerRef: RefObject<HTMLElement | null>, shortcuts: GridShortcut[], { enabled? }) → GridShortcutHint[]`; `GridShortcut = { key: 'a' | 'Enter' | 'Escape' | 'Space' | …, label, run(event), disabled?: boolean | reason, repeat? }`; hint `{ key, keyLabel, label, disabled, reason? }`. Works only while focus is inside the container; never with Ctrl/⌘/Alt, IME, a handled key, text fields/selects/contenteditable/comboboxes, an open cell editor, a menu inside the grid or a modal outside it; Enter/Space stay a focused button's; auto-repeat only with `repeat: true`. The grid needs `suppressCellFocus={false}`; the row is the page's (`api.getFocusedCell()`). Pure filter: `matchGridShortcut`.
```tsx
const hints = useGridShortcuts(hostRef, [{ key: 'a', label: 'Approve', run: () => approve(focusedRow()) }, { key: 'r', label: 'Reject', run: () => reject(focusedRow()) }, { key: 'Enter', label: 'Open', run: () => open(focusedRow()) }, { key: 'Escape', label: 'Close', run: closeDrawer }])
<div ref={hostRef}><GridCard toolbar={…}><NexusGrid suppressCellFocus={false} … /></GridCard></div>   {hints.map((h) => <span key={h.key}><Kbd>{h.keyLabel}</Kbd> {h.label}</span>)}
```
**Files (apps/web/src/design-system/…).** New: `grid/renderers/{ChangeCell.tsx, changeValue.ts, rowVerbs.ts}`, `grid/hooks/{gridShortcuts.ts, useGridShortcuts.ts}`, `components/{Countdown.tsx, countdownTicker.ts}`, `catalog/{ChangeValueExample, CountdownExample, GridRowVerbsExample}.tsx`, tests `changeValue`, `rowVerbs`, `actions/actionVerbs`, `columns/presets.verbs`, `countdownTicker`, `hooks/gridShortcuts` (`.vitest.test.ts`). Changed: `grid/renderers/cells.tsx` (ActionsCell), `grid/actions/menuAdapters.tsx` (`actionVerbs`, `omit`), `grid/columns/presets.ts` (`changeColumn`, widths/keys), `grid/index.ts` (+ `rendererOwnsKeyboard`), `components/index.ts`, `styles/components.css` (`.nds-change*`, `.nds-countdown`), `catalog/TokenCatalog.tsx` + `README.md`, `docs/GRID.md`, `CHANGELOG.md`; `.claude/DS-GAPS.md` (+4 lines). **Factory, byte-identical copies:** `grid/renderers/cells.tsx`, `grid/renderers/rowVerbs.ts` (new), `grid/actions/menuAdapters.tsx`, `components/index.ts`, `components/Countdown.tsx` + `countdownTicker.ts` (new).

| check | command | result |
|---|---|---|
| web typecheck | `npx next typegen && npx tsc --noEmit -p tsconfig.json --tsBuildInfoFile /private/tmp/claude-501/approvals-C-web.tsbuildinfo` | pass |
| factory typecheck | `npx tsc --noEmit --incremental false -p apps/factory/tsconfig.json` | 446 errors before AND after, identical set, 0 in design-system (pre-existing, outside DS) |
| new tests | `npx vitest run` on the 6 new files | 48/48 pass |
| nearby tests | vitest `src/design-system/{grid,components,catalog}`, `app/products/next`, `app/design`, `app/settings/ai`, `app/fleet`; `app/products/[id]/edit/_studio` | 175 files / 2284 pass; 235 files / 3454 pass |
| legacy actions cell | one-off render of 4 old shapes, HEAD vs new (temp files removed) | byte-identical |
| static gates | `node scripts/ci/run-static-gates.mjs` | 61/65 before AND after; same 4 pre-existing failures: shell pin freshness, dark ⇄ pin parity, token resolution (`--nds-grid-tone-*`), DS api guard (`patterns/preferencesDnd.tsx` DragKind/DragHandle) |
| fork drift · DS-GAPS | `check-ds-fork-drift.mjs --check` · `check-ds-gaps-append-only.mjs --check` | pass · pass |
| browser | — | not run (DS parts; the catalog README lists what to verify, light/dark, 390 px) |

**Open:** no browser pass yet (D's page check covers it). Not built: a "?" shortcut-help dialog, G3/G4/G5/G6/G9. Factory's committed `.d.ts` artifacts are stale as before (not a gate). Tests caught and fixed one bug in the new ticker (a direct tick orphaned the armed timer).
