'use client'

/**
 * §14.1 — ONE toolbar for both scopes.
 *
 * 🔴 The divergence this closes is structural, not cosmetic. The master scope mounted `GridToolbar`;
 * the channel scope hand-rolled `<div className="nds-grid-prefsbar nds-channel-toolbar">` and never
 * mounted it at all. Two components for one role, so the two scopes drifted into two applications:
 * SR.1 measured 42px against 99–111px, and the channel scope had silently lost search, Overview ▾,
 * Customise, Export, Reload, the checkbox column, the filter row and the bulk bar — carrying six of
 * ten operator tasks. **A sheet's chrome is a property of the SHEET, not of the scope.**
 *
 * The rule this component enforces, and the reason it takes the props it does:
 *
 *  1. **Scope-specific controls are ADDITIONS, never replacements — and since CH.1 (Owner,
 *     2026-09-05) they are not BUTTONS either.** A scope's own verbs (the family verbs, a listing's
 *     preflight, add alias) are items of the one ⋯ overflow; `status` holds transient status data only.
 *     The bar therefore renders the same controls, in the same order, on master and on every channel.
 *  2. **A control absent on a scope is absent for a STATED REASON.** `absent` is not documentation —
 *     it is the only way to omit anything, it is typed, and the reason is rendered as a disabled overflow item. Silence is what let the channel scope lose five controls without anyone deciding
 *     to remove them.
 *
 * Owner item 26 (two master sheets, one role) is the same shape one level up; this is the fix for
 * the toolbar half of it.
 *
 * CH.1 (Owner, 2026-09-05 — the converged sheet-chrome recommendation): five controls, one way to
 * narrow columns. The views trigger lists All attributes and the operator's saved views (pick ·
 * save · default); the second fixed set, Required, is a chip beside it; the view chips stay; Export
 * always writes the full importable file; Reload lives in the ⋯ overflow. Presets per group, quick
 * picks, "Export view" and the per-column filter row are gone by the Owner's ruling, not by omission.
 *
 * SHEET-VIEWS (Owner, 2026-09-26): the views menu manages views in full — New view…, Rename… and
 * Duplicate… are back beside save · update · default · delete — and the bar gains the row-height
 * control the products grid has (Compact · Cozy · Spacious). A saved view keeps the row height, the
 * widths and the sort with its columns. Same on every scope, like everything else here.
 *
 * TOOLBAR REBUILD (Owner, 2026-09-27: "extremely confusing … especially the filters thing, the different chips").
 * ONE control per question, each named for its question:
 *   - **Columns ▾** — which attributes: the built-in views, My layout, my views, the team's, Customise columns….
 *     The "Required" and "Languages" chips are gone: Required is a built-in view, and languages are the Editing
 *     bar's Languages menu alone.
 *   - **Rows ▾** — which rows: All rows or one filter, named on the trigger with its count and a ✕. It says, as a
 *     switch, that it also narrows the columns (D1 = A, on by default).
 * `docs/product-sheet-toolbar/PLAN-2026-09-27.md`.
 */
import { useRef, type ReactNode } from 'react'
import { AlertTriangle, ChevronDown, MoreHorizontal, Search, X } from 'lucide-react'

import { Button, Input } from '@/design-system/primitives'
import { Menu, type MenuItemDef } from '@/design-system/components'
import { GridToolbar } from '@/design-system/patterns'
import { GRID_DENSITY_OPTIONS, GridDensityToggle, GridSearchSlot, GridSelectionActions, GridViewsMenu, SheetStatuses, type SheetStatus, useToolbarOverflow, useToolbarOverflowTier, useToolbarStatusCompaction, type GridStateApi, type GridViewPreset, type SavedGridView } from '@/design-system/grid'
import type { GridDensityName } from '@/design-system/tokens/grid'

import { viewChipIsAlarm, type ViewChip } from '../contracts'
import { viewChipCountLabel, viewChipSummary } from '../viewChips'
import { orderLanguageChips } from './languageChips'

/** A control this scope does not offer, and why. Both fields are required — that is the point. */
export interface AbsentControl {
  control: 'search' | 'views' | 'chips' | 'customise' | 'export' | 'import' | 'reload'
  /** Shown to the operator. Write what is true of the SCOPE, not of the implementation. */
  reason: string
}

/**
 * Generic over the page-state type, like `GridViewsMenu` itself. Flattening it to `unknown` here
 * would push every caller into a cast — a shared component that costs its consumers their types is
 * not shared, it is duplicated with extra steps.
 */
export interface SheetToolbarProps<TPage> {
  /* ── the count slot ─────────────────────────────────────────────────────────────────────── */
  visible: number
  total: number
  selected: number
  /** What this sheet IS — the family descriptor, or the channel coordinate. */
  descriptor?: ReactNode
  /**
   * The verbs for the selected rows (SHEET-VIEWS, Owner 2026-09-26). Given AND rows selected, the bar
   * swaps into its selection state — the products grid's shape (`GridSelectionActions`): the count reads
   * "Selected N rows", the verbs and Clear take the search field's place, the row-height control steps
   * aside. A scope with no verbs keeps its normal bar and counts the selection beside its rows.
   */
  selectionActions?: ReactNode
  onClearSelection?: () => void

  /* ── the standard controls. Every scope gets all of them unless it says otherwise. ───────── */
  search: string
  onSearch: (v: string) => void
  views?: GridStateApi<TPage>
  presets?: readonly GridViewPreset[]
  activePresetId?: string | null
  /** Two or more content languages are on: the language filters lead the Rows menu. */
  languagesView?: boolean
  onApplyPreset?: (preset: GridViewPreset) => void
  /** What the Columns trigger names when neither a preset nor a saved view is on: "My layout". */
  viewsEmptyLabel?: string
  /** The attributes on screen in the active view — the Columns trigger's number. */
  activeCount?: number | null
  /** "My layout", offered right after the built-in views when the scope has one. */
  myLayout?: { count: number } | null
  myLayoutActive?: boolean
  onApplyMyLayout?: () => void
  /** D1 = A — while a row filter is on, show only the columns with matches. */
  narrowToMatches?: boolean
  onNarrowToMatches?: (on: boolean) => void
  /** Save / update what is on screen as a columns view; the hook supplies both (`useSheetColumns`). */
  onSaveCurrentView?: (name: string) => Promise<unknown>
  onUpdateCurrentView?: (view: SavedGridView<TPage>) => Promise<unknown>
  /** "New view…" — opens the Customise dialog with the view-name field open (`useSheetPreferences`). */
  onNewView?: () => void
  /** A note under a saved view — the columns it names that this product type lacks. */
  describeView?: (view: SavedGridView<TPage>) => { note?: string; title?: string } | null
  /** SHEET-VIEWS step 4 — the product type on screen; the views menu offers "Make default for <Type> products". */
  productType?: { code: string; label: string } | null
  /** The column count beside a saved view — a rule view counts what its rules add on this product type. */
  viewColumnCount?: (view: SavedGridView<TPage>) => number | null
  /** Already filtered by `isViewChipVisible` — `useViewChips()` does it. Do not re-filter. */
  chips?: readonly ViewChip[]
  activeChipId?: string | null
  onChipToggle?: (id: string | null) => void
  onCustomise?: () => void
  /** Row height. Both or neither: the toggle shows only when the sheet can change it. */
  density?: GridDensityName
  onDensity?: (density: GridDensityName) => void
  /**
   * Export requests every attribute. Shared sheets retain their editable key row; channel sheets
   * declare review-only output because resolved values do not describe stored overrides.
   */
  onExport?: (mode: 'view' | 'all') => void
  exportPurpose?: 'editing' | 'review' | 'workbook'
  exportCounts?: { view: number; all: number }
  exportDisabled?: boolean
  /** Opens the import drawer. A scope that does not offer import declares it `absent` with a reason. */
  onImport?: () => void
  importDisabled?: boolean
  onReload?: () => void
  loading?: boolean
  /** A write is pending; hold overflow verbs without hiding the loaded rows. */
  pendingWrite?: boolean
  /** The current read failed; keep recovery available without authoring an empty layout. */
  unavailable?: boolean

  /* ── scope-specific ADDITIONS ───────────────────────────────────────────────────────────── */
  /**
   * CH.1 (Owner, 2026-09-05): the bar is the SAME on every scope — every button, in the same order.
   * A scope's own verbs (the family verbs, a listing's preflight, add alias) are ITEMS of the one ⋯
   * overflow, above Reload; they never add a button of their own.
   */
  overflow?: readonly MenuItemDef[]
  /** Status data only. Commands belong in the single overflow; arbitrary nodes are rejected. */
  status?: readonly SheetStatus[]
  /** 🔴 The ONLY way to omit a standard control, and it costs a reason. */
  absent?: readonly AbsentControl[]
}

export function SheetToolbar<TPage>(p: SheetToolbarProps<TPage>) {
  const blocked = !!(p.loading || p.unavailable)
  const blockedReason = p.loading ? 'The sheet is still loading' : 'This sheet could not be read'
  const overflowReason = blocked ? blockedReason : p.pendingWrite ? 'Wait for the pending write to finish.' : null
  const gone = (c: AbsentControl['control']) => p.absent?.find((a) => a.control === c)

  /* LX.F2 / R-LX-18 — the ENGINE answers "is the bar over?"; this file answers "then which verbs
     move". Reasoned at `design-system/grid/toolbars/GridToolbarFold.tsx` with the measured widths. */
  const actionsRef = useRef<HTMLDivElement>(null)
  const selecting = p.selected > 0 && p.selectionActions != null
  /* Steps aside while rows are selected, as on the products grid: the verbs need the room. */
  const densityShown = !!(p.density && p.onDensity) && !selecting
  /* SHEET-VIEWS (2026-09-26) — the row-height control is the CHEAPEST thing to give up, so it folds
     first; the verbs move only if the bar is still over after that (`useToolbarOverflowTier`, with the
     measured widths). With no row-height control on this bar the verbs' tier is armed from the start,
     which is exactly the old single-tier behaviour. */
  const densityFolded = useToolbarOverflow(actionsRef)
  const tight = useToolbarOverflowTier(actionsRef, !densityShown || densityFolded)
  /* R-LX-27 — the LAST tier, armed by the one above it: only once the chips have folded and the verbs
     have moved does a bar that is still over ask its status pills for their width back. Reasoned with
     the measured 230.8px at `design-system/grid/toolbars/GridToolbarFold.tsx`. */
  const compactStatus = useToolbarStatusCompaction(actionsRef, tight)
  /* The Rows menu's items (see the render below for the Owner's rulings). */
  const filterChips = orderLanguageChips(p.chips ?? [], p.languagesView ?? false)
  const activeFilter = filterChips.find((chip) => chip.id === p.activeChipId) ?? null
  const activeFilterCount = activeFilter ? viewChipCountLabel(activeFilter) : null
  const filterItems: MenuItemDef[] = [
    { id: 'filter:all', label: <>All rows{activeFilter ? '' : ' ✓'}</>, description: 'No filter — every row of this sheet', disabled: blocked, onSelect: () => p.onChipToggle?.(null) },
    { id: 'sep-filters', separator: true },
    ...filterChips.map((chip): MenuItemDef => {
      const on = chip.id === p.activeChipId
      const n = viewChipCountLabel(chip)
      const detail = [viewChipSummary(chip), chip.count !== null ? chip.note : null].filter(Boolean).join('. ')
      /* The visible second line: the breadth ("41 affected cells across 1 column and 41 rows") only when
         there is something to count — at a measured zero the label already says "0 cells", and "0 affected
         cells across 0 columns and 0 rows" under it is noise. The tooltip keeps the full detail. */
      const zero = chip.count !== null && chip.count.n === 0
      const line = zero ? (chip.note ?? null) : detail
      return {
        id: `filter:${chip.id}`,
        /* The glyph follows the chip's KIND (§6.2): a count of WORK is not an alarm. */
        icon: viewChipIsAlarm(chip) ? <AlertTriangle size={12} aria-hidden /> : undefined,
        label: <>{chip.label}{n !== null && <> · {n}</>}{on ? ' ✓' : ''}</>,
        description: line,
        title: detail,
        disabled: blocked,
        onSelect: () => p.onChipToggle?.(on ? null : chip.id),
      }
    }),
    /* D1 = A (Owner, 2026-09-27) — a filter also narrows the COLUMNS, and says so here, where it can be turned off. */
    ...(activeFilter && p.onNarrowToMatches ? [
      { id: 'sep-narrow', separator: true } as MenuItemDef,
      {
        id: 'filter:narrow', checked: !!p.narrowToMatches, disabled: blocked,
        label: 'Only columns with matches',
        description: p.narrowToMatches ? 'The columns without a match are hidden while this filter is on' : 'Every column of the view stays; the matching cells are marked',
        onSelect: () => p.onNarrowToMatches?.(!p.narrowToMatches),
      } as MenuItemDef,
    ] : []),
  ]
  /* The Columns menu's own items: My layout after the built-in views, and Customise at the end. */
  const myLayoutItems: MenuItemDef[] = p.myLayout && p.onApplyMyLayout ? [{
    id: 'my-layout',
    label: <>My layout ({p.myLayout.count}){p.myLayoutActive ? ' ✓' : ''}</>,
    title: 'Your own arrangement for this scope — what Customise columns saves',
    onSelect: () => p.onApplyMyLayout?.(),
  }] : []
  const columnsEnd: MenuItemDef[] = !gone('customise') && p.onCustomise ? [{ id: 'customise', label: 'Customise columns…', disabled: blocked, onSelect: () => p.onCustomise?.() }] : []
  const activeViewLabel = p.views?.views.find((v) => v.id === p.views?.activeId)?.name
    ?? p.presets?.find((x) => x.id === p.activePresetId)?.label
    ?? p.viewsEmptyLabel ?? 'All attributes'
  const foldedActions: MenuItemDef[] = [
    /* The row height folds FIRST and as three items, so it stays one click away (✓ marks the one in force). */
    ...(densityShown && densityFolded ? GRID_DENSITY_OPTIONS.map((o) => ({
      id: `folded-density-${o.value}`, label: `Rows: ${o.label}${o.value === p.density ? ' ✓' : ''}`,
      disabled: blocked, onSelect: () => p.onDensity?.(o.value as GridDensityName),
    } as MenuItemDef)) : []),
    ...(tight && !gone('export') && p.onExport ? [{
      id: 'folded-export', label: 'Export',
      description: p.exportPurpose === 'workbook' ? 'Choose products and destinations for an editing workbook' : 'Every attribute this scope declares',
      disabled: blocked || p.exportDisabled, onSelect: () => p.onExport?.('all'),
    } as MenuItemDef] : []),
    ...(tight && !gone('import') && p.onImport ? [{
      id: 'folded-import', label: 'Import', description: 'Bring values in from a workbook',
      disabled: blocked || p.importDisabled, onSelect: () => p.onImport?.(),
    } as MenuItemDef] : []),
  ]
  return (
    <GridToolbar
      count={
        blocked ? <span role="status">{p.loading ? 'Loading information…' : 'Information unavailable'}</span> : selecting ? <>
          Selected <b>{p.selected}</b> {p.selected === 1 ? 'row' : 'rows'}
        </> : <>
          <b>{p.visible}</b> {p.visible === 1 ? 'row' : 'rows'}
          {p.visible !== p.total && <> of {p.total}</>}
          {p.selected > 0 && <> · <b>{p.selected}</b> selected</>}
          {p.descriptor}
        </>
      }
      right={
        <>
          {/*
            🔴 A hole PES.3 found as the first consumer, in exactly the guarantee this component
            exists to make. This read `{!gone('views') && p.views && p.presets && …}`, so a scope
            that simply did not pass the data lost the control **with no `absent` entry and no
            reason** — "cannot drop by omission" held only for the unconditionally rendered controls,
            which is to say it held wherever it was not needed.

            A data-driven control with no data and no `absent` entry does not vanish: it says so, in
            the bar, where the person who forgot the data will see it. Silence was the whole defect.
          */}
          {!gone('views') && (
            blocked ? <Button size="sm" disabled><span className="nds-toolbar-menu-lead">Columns</span></Button> : p.views && p.presets ? (
              /* TOOLBAR REBUILD — "Columns ▾": which attributes. Built-in views, My layout, my views, the team's. */
              <GridViewsMenu
                views={p.views}
                presets={p.presets}
                activePresetId={p.activePresetId}
                onApplyPreset={p.onApplyPreset ?? (() => {})}
                emptyLabel={p.viewsEmptyLabel ?? 'My layout'}
                showCounts
                manage="full"
                headings
                triggerLabel={<>
                  <span className="nds-toolbar-menu-lead">Columns</span>
                  <span className="nds-toolbar-fold-active">{activeViewLabel}</span>
                  {p.activeCount != null && <span className="nds-toolbar-fold-count">{p.activeCount}</span>}
                </>}
                triggerAriaLabel={`Columns: ${activeViewLabel}${p.activeCount != null ? `, ${p.activeCount} attributes` : ''}`}
                afterPresets={myLayoutItems}
                endItems={columnsEnd}
                onNewView={p.onNewView}
                onSaveCurrent={p.onSaveCurrentView}
                onUpdateCurrent={p.onUpdateCurrentView}
                describeView={p.describeView}
                productType={p.productType}
                viewColumnCount={p.viewColumnCount}
              />
            ) : (
              <span
                className="nds-grid-toolbar-absent nds-inline-error"
                title="Saved views are unavailable. Reload the information grid to try again."
              >
                Views unavailable
              </span>
            )
          )}
          {/*
            The View bar's chips. This component renders them; every lane that has data PRODUCES one
            through `useRegisterViewChip`, so a new chip appears here with no change to this file.
            Selection is single and URL-backed — two active chips would need union-or-intersection
            semantics nobody has specified.
          */}
          {/*
            LX.F2 / R-LX-18 measured why the filters must never sit on the bar one by one: 9 chips =
            1345.4px of a 2150px bar at 1280, 9 controls clipped. R-52 folded them into one trigger at
            every width; the trigger below keeps that one-trigger footprint.
          */}
          {/* SHEET-VIEWS (Owner, 2026-09-26: "instead of having chips, I think it's better to actually keep a
              dropdown"). The filters are ONE single-select dropdown — the DS `Menu`, the same control as the
              views menu and `⋯` — not chips in a panel. The trigger keeps R-52's reading: `Filters N` (how many
              exist) or `Filters · <label>` pressed when one is on. Each row keeps what its chip carried: the
              label, the count (`null` is never printed as 0), the alarm glyph for a warning/danger KIND, and
              the full detail as a visible second line. "All rows" clears; picking the active filter clears it. */}
          {/* TOOLBAR REBUILD — "Rows ▾": which rows. The trigger names what is on ("Rows: All rows", or the filter
              and its count); a ✕ beside it clears it in one click. It no longer prints how many filters EXIST,
              which read as "5 filters on" (2026-09-27). */}
          {!gone('chips') && filterChips.length > 0 && (
            <span className="nds-toolbar-rows">
              <Menu
                label={<>
                  <span className="nds-toolbar-menu-lead">Rows</span>
                  <span className="nds-toolbar-fold-active">{activeFilter ? activeFilter.label : 'All rows'}</span>
                  {activeFilterCount && <span className="nds-toolbar-fold-count">{activeFilterCount}</span>}
                  <ChevronDown size={11} aria-hidden />
                </>}
                items={filterItems}
                selectedId={activeFilter ? `filter:${activeFilter.id}` : 'filter:all'}
                triggerProps={{
                  className: ['nds-btn sm nds-toolbar-fold-trigger', activeFilter ? 'is-active' : ''].filter(Boolean).join(' '),
                  disabled: blocked,
                  'aria-label': activeFilter ? `Rows: ${activeFilter.label}${activeFilterCount ? `, ${activeFilterCount}` : ''}` : 'Rows: all rows',
                }}
              />
              {activeFilter && (
                <Button size="sm" variant="ghost" className="nds-toolbar-rows-clear" disabled={blocked} aria-label={`Clear the filter ${activeFilter.label}`} title="Show all rows" onClick={() => p.onChipToggle?.(null)}>
                  <X size={12} aria-hidden />
                </Button>
              )}
            </span>
          )}
          <SheetStatuses status={p.status} compact={compactStatus} />
          <div className="nds-sheet-toolbar-actions" ref={actionsRef}>
            {/* Beside Customise, as on the products grid: both change how the sheet LOOKS, not what it holds. */}
            {densityShown && !densityFolded && <GridDensityToggle value={p.density!} onChange={(d) => p.onDensity?.(d)} />}
            {!gone('customise') && p.onCustomise && <Button size="sm" disabled={blocked} onClick={p.onCustomise}>Customise</Button>}
            {!gone('export') && p.onExport && !tight && (
              /* The scope declares whether this file carries editable values or review data.
                 LX.F2 / R-LX-18 — when the bar is still over after the chips have folded, this verb
                 moves into the `⋯` menu below instead of being CLIPPED off the right edge (measured:
                 `Import` and `More` were unreachable at 1280 on amazon·DE). `tight` comes from the
                 ENGINE (`useToolbarOverflow`); this file only names which verbs give up their slot. */
              <Button
                size="sm"
                onClick={() => p.onExport?.('all')}
                disabled={blocked || p.exportDisabled}
                title={
                  blocked || p.exportDisabled
                    ? 'Nothing to export until the sheet has loaded'
                    : p.exportPurpose === 'workbook' ? 'Choose products and destinations for an editing workbook'
                      : `Every attribute this scope declares${p.exportCounts ? ` (${p.exportCounts.all})` : ''} — ${p.exportPurpose === 'review' ? 'table data for review; use Catalog import & export for editing' : 'importable as-is'}`
                }
              >
                Export
              </Button>
            )}
            {/* Beside Export deliberately: they are the same idea in two directions, and an operator
                looking for one will look where the other is. */}
            {!gone('import') && p.onImport && !tight && (
              <Button size="sm" onClick={p.onImport} disabled={blocked || p.importDisabled}>Import</Button>
            )}
            {((!gone('reload') && p.onReload) || (p.overflow?.length ?? 0) > 0 || p.absent?.length || foldedActions.length) ? (
              /* The ONE overflow: the scope's own verbs first, then Reload. Reload is a recovery verb,
                 not a daily one, so it does not spend a bar slot; with no live cells in this build
                 (CH.1 row 19), Reload plus the 409 version check on write is the whole "what changed
                 elsewhere" story. */
              <Menu
                label={<MoreHorizontal size={14} aria-hidden />}
                triggerProps={{ className: 'nds-btn sm', 'aria-label': 'More' }}
                items={[
                  /* LX.F2 / R-LX-18 — the verbs that gave up their slot come FIRST, so the operator
                     finds them where the bar stopped showing them. Same verb, same handler, same
                     disabled reason: a second HOST, not a second definition. */
                  ...foldedActions,
                  ...(foldedActions.length && ((p.absent?.length ?? 0) || (p.overflow?.length ?? 0) || (!gone('reload') && p.onReload))
                    ? [{ id: 'sep-folded', separator: true } as MenuItemDef]
                    : []),
                  ...(p.absent ?? []).map(a => ({ id: `absent-${a.control}`, label: a.control === 'views' ? 'Saved views — fixed column set on this page' : `${a.control} — unavailable`, description: a.reason, disabled: true })),
                  ...(p.overflow ?? []).map(item => overflowReason && !item.separator ? {
                    ...item,
                    disabled: true,
                    title: [overflowReason, item.title].filter(Boolean).join(overflowReason.endsWith('.') ? ' ' : '. '),
                    description: <>{overflowReason}{item.description != null && <>{overflowReason.endsWith('.') ? ' ' : '. '}{item.description}</>}</>,
                  } : item),
                  ...((p.overflow?.length ?? 0) > 0 && !gone('reload') && p.onReload
                    ? [{ id: 'sep-overflow', separator: true } as MenuItemDef]
                    : []),
                  ...(!gone('reload') && p.onReload
                    ? [
                        {
                          id: 'reload',
                          label: p.loading ? 'Loading…' : 'Reload',
                          description: 'Re-read this sheet from the server',
                          disabled: p.loading,
                          onSelect: () => p.onReload?.(),
                        } as MenuItemDef,
                      ]
                    : []),
                ]}
              />
            ) : null}
          </div>
        </>
      }
    >
      {selecting ? (
        <GridSelectionActions>
          {p.selectionActions}
          <Button variant="link" size="sm" onClick={p.onClearSelection}>Clear</Button>
        </GridSelectionActions>
      ) : !gone('search') && (
        <GridSearchSlot>
          <Input
            /* `xs`, not `sm`. Measured: the sm field is 36px against 28px buttons, and it was the
               single control holding the toolbar at 49 — 6 + 36 + 6 + 1. At xs it matches the
               buttons beside it and the band lands on the 40px token. */
            size="xs"
            leadingIcon={<Search size={13} />}
            placeholder="Find a SKU or a name…"
            aria-label="Find"
            value={p.search}
            disabled={blocked}
            onChange={(e) => p.onSearch(e.target.value)}
            style={{ width: '100%' }}
          />
        </GridSearchSlot>
      )}
    </GridToolbar>
  )
}
