# AG Grid migration — the AG series

**Written 2026-08-28 by session `9f386ec9`.** Read this before touching
`apps/web/src/design-system/patterns/workspace-grid/engine/` or `/design/grid-lab`.

> **Provenance.** This plan was authored on 2026-08-27 by session `46206639` and existed ONLY in
> that session's transcript — no file, no memory entry. That session was killed by the kernel
> panic at 22:52 (see `b4607e0fb`). Had the transcript rotated, a nine-phase plan for the
> platform's core data layer would have been lost. It is written down here for that reason. The
> phases below are that plan; the STATUS column is measured against the tree at `9ea2f0ca7`.

---

## 1. The bet

A full rewrite of a 1.2M-LOC platform is not the sane reading of "rebuild with AG Grid". The bet
is that **the props contract is the seam**: call sites keep talking in
`GridColumn` / `renderFirst` / `freezeRight`, and only the engine underneath them is swapped.

`engine/AgWorkspaceGrid.tsx` is therefore **the only file in the repo allowed to import
`ag-grid-react`**. That rule is what makes a rollback a one-line change instead of an archaeology
project, and it is worth enforcing with a guard the moment a second file wants the import.

Four grid engines are live simultaneously today:

| Engine | Render sites |
|---|---|
| DS `WorkspaceGrid` (+ the `AdsDataGrid` shim) | 54 files via the shim, 1 direct |
| DS `DataGrid` | 75 sites — its own source says it is the one being retired |
| `grid-lens/VirtualizedGrid` + ~5,100 L of satellites | 18 workspace pages |
| raw tables / `@tanstack/react-table` | 207 / 17 files |

Plus `apps/factory`'s own copies. **Explicitly out of scope throughout:** `FlatFileGrid`, FBA
quantity, existing import — standing untouchable rules.

---

## 2. Phases and status

| # | Phase | Status |
|---|---|---|
| 0 | Prerequisites — register only the modules used, never `AllEnterpriseModule` (bundle budget on a 330-route app) | ✅ `engine/modules.ts` |
| 1 | Foundation — one DS-owned engine, token-driven theme, client boundary | ✅ shipped `24edfc826` |
| 2 | Parity harness — side-by-side **+ a conformance suite over the props surface** | ⚠️ **HALF** — see §3 |
| 3 | Re-engine `WorkspaceGrid` behind identical props, per-`storageKey` flag, one page at a time | ▶ next |
| 4 | Preference & saved-view migration — read-old-write-new, per key | ⏸ the real risk |
| 5 | Retire DS `DataGrid` (75 sites) via the `AdsDataGrid` shim precedent | ⏸ |
| 6 | `grid-lens` (18 pages) — the biggest payoff; this is where the TWO-Customize-dialogs fork dies | ⏸ |
| 7 | Unlock: range selection, Excel export (replacing hand-rolled `exceljs` in 26 files), master/detail, pivot, Server-Side Row Model | ⏸ |
| 8 | `apps/factory` + guards — fork-drift ratchet fails the push the moment the web DS changes | ⏸ |

**The standing recommendation from the original plan:** commit to **0–4 only** (the ads console,
already contract-shaped), prove parity on prod, then decide 5–8 on evidence rather than estimate.

---

## 3. Why Phase 2 is only half done

The commit is titled "AG.1/AG.2", which reads as two phases finished. Its own body is more honest:
filters, `editMode`, hierarchy, `groupBy`, `server`, saved views and the Customize dialog are
*"not mapped yet, and not faked with a hopeful `any`"*.

Measured at `9ea2f0ca7`:

- `WorkspaceGridProps` declares **51 props**; `AgWorkspaceGrid` implements **14** of them, plus 4
  engine-only (`height`, `enableSideBar`, `enableSetFilters`, `enableColumnResize`).
- **No conformance test exists** for the engine. `/design/grid-lab` measures exactly six DOM
  properties — row height, header height, cell/header font-size, cell colour, row rule colour.
- **Zero production call sites.** Only the lab imports the engine.

Phase 2 was described as *"what makes the rest safe"*. A six-property screenshot is not that. What
is still owed: assertions for `sinkBlanks`, null-never-coerced-to-zero, totals, selection, and
sticky / `freezeRight`, driven from one fixture through both engines.

---

## 4. What the remaining prop work actually weighs

Usage of each **unimplemented** prop across the 55 real sites, measured 2026-08-28:

```
storageKey        38      filters           27      selectionActions  23
customizable      13      onRowClick        13      editMode          10
groupBy            3      rowClassName       3      keyboardNav        2
hierarchy          1      server             1      searchable         1
exportable         0      total              0      pagerCentered      0
```

Two things follow, and they set the order of Phase 3:

1. **Sequence against raw demand, not with it.** `storageKey` (38) and `customizable` (13) carry
   the localStorage migration that Phase 4 flags as *"where a careless migration silently resets
   everyone's columns"*. `filters` (27) and `selectionActions` (23) touch no persisted state. Do
   the safe ones first and the risky ones behind the migrator.
2. **Three declared props have no consumer at all** — `exportable`, `total`, `pagerCentered`. The
   engine never needs to implement them. Do not port a prop because the interface names it.

---

## 5. Behaviours that are load-bearing and differ from the engine defaults

Implemented at the site rather than assumed, and the first things a conformance suite must pin:

- **A blank sorts to the BOTTOM in both directions** (`sinkBlanks`) — the KT.3 parity rule.
- **`null` is never coerced to `0`** (`readSortValue`). AG Grid's default aggregations and value
  formatters will render `null` as `0`. That violates the honesty rule, and a null that sorts as
  zero is the same bug class as a null that matches every `lte`.
- **Modules register at module scope, not in an effect** — the registry must be populated before
  the first grid mounts, and an effect runs after the first render.

## 6. Theming — why the Theming API and not a stylesheet

The theme is built with the Theming API, never by loading `ag-theme-quartz.css`. A fifth global
stylesheet in a cascade already decided by source order — four DS sheets plus ~3,000 lines of
`ads.css` — is a fight this codebase has lost twice: once to a page rule beating a DS primitive,
once to a token triplet colliding on load order. The Theming API emits scoped custom properties,
so the grid never enters that cascade.

Every colour binds to a `var(--nds-*)`, already defined in both `:root` and `.dark`, so dark mode
costs nothing and cannot drift — a hex here would have produced a grid that silently stayed light.
`browserColorScheme` is the one thing a token cannot carry (it drives native scrollbars and
in-cell form controls), so it is set per mode and the wrapper stamps `data-ag-theme-mode`.

---

## 7. Risks carried forward

- **Page stylesheets beat DS primitives.** ~7 known `.h10-*` selectors in `ads.css` / `amazon.css`
  already override DS controls and will fight AG Grid cells the same way. Probe a real control
  bay; never trust the DS in isolation.
- **~20 pre-push gates**, including contrast and token ratchets. The default palette will not pass
  them — the theme has to be token-driven from day one, not retrofitted.
- **Bundle size** on a 330-route Next app.
- **The ads console cannot be verified locally** — its data regions 401 with no CORS, so the
  chrome renders and a screenshot looks half-right. `/design/grid-lab` runs off a frozen fixture
  and needs no API, which is why parity work belongs there.
- **Phase 4 is a DATA migration, not a UI one.** Today's state lives in bespoke localStorage
  shapes (`${storageKey}-hidden-cols`, `-frozen-cols`, `COLS_KEY`, `SAVED_VIEWS_STORAGE_KEY`,
  `ACTIVE_VIEW_KEY`, `ff-*`); AG Grid wants `columnState` / `filterModel`.
