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
 */
import { useRef, type ReactNode } from 'react'
import { AlertTriangle, MoreHorizontal, Search } from 'lucide-react'

import { Button, FilterChip, Input } from '@/design-system/primitives'
import { Menu, type MenuItemDef } from '@/design-system/components'
import { GridToolbar } from '@/design-system/patterns'
import { ALL_VIEW_ID, GridSearchSlot, GridToolbarFold, GridViewsMenu, SheetStatuses, type SheetStatus, useToolbarOverflow, useToolbarStatusCompaction, type GridStateApi, type GridViewPreset, type SavedGridView } from '@/design-system/grid'

import { viewChipIsAlarm, type ViewChip } from '../contracts'
import { viewChipCountLabel, viewChipSummary } from '../viewChips'
import { orderLanguageChips } from './languageChips'
import { LANGUAGES_VIEW_ID } from './languages'
import { REQUIRED_VIEW_ID } from './views'

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

  /* ── the standard controls. Every scope gets all of them unless it says otherwise. ───────── */
  search: string
  onSearch: (v: string) => void
  views?: GridStateApi<TPage>
  presets?: readonly GridViewPreset[]
  activePresetId?: string | null
  languagesView?: boolean
  onApplyPreset?: (preset: GridViewPreset) => void
  /** The trigger's label when neither a preset nor a saved view is active ("Custom (23)"). */
  viewsEmptyLabel?: string
  /** Save / update what is on screen as a columns view; the hook supplies both (`useSheetColumns`). */
  onSaveCurrentView?: (name: string) => Promise<unknown>
  onUpdateCurrentView?: (view: SavedGridView<TPage>) => Promise<unknown>
  /** A note under a saved view — the columns it names that this product type lacks. */
  describeView?: (view: SavedGridView<TPage>) => { note?: string; title?: string } | null
  /** Already filtered by `isViewChipVisible` — `useViewChips()` does it. Do not re-filter. */
  chips?: readonly ViewChip[]
  activeChipId?: string | null
  onChipToggle?: (id: string | null) => void
  onCustomise?: () => void
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
  const tight = useToolbarOverflow(actionsRef)
  /* R-LX-27 — the LAST tier, armed by the one above it: only once the chips have folded and the verbs
     have moved does a bar that is still over ask its status pills for their width back. Reasoned with
     the measured 230.8px at `design-system/grid/toolbars/GridToolbarFold.tsx`. */
  const compactStatus = useToolbarStatusCompaction(actionsRef, tight)
  const foldedActions: MenuItemDef[] = !tight ? [] : [
    ...(!gone('export') && p.onExport ? [{
      id: 'folded-export', label: 'Export',
      description: p.exportPurpose === 'workbook' ? 'Choose products and destinations for an editing workbook' : 'Every attribute this scope declares',
      disabled: blocked || p.exportDisabled, onSelect: () => p.onExport?.('all'),
    } as MenuItemDef] : []),
    ...(!gone('import') && p.onImport ? [{
      id: 'folded-import', label: 'Import', description: 'Bring values in from a workbook',
      disabled: blocked || p.importDisabled, onSelect: () => p.onImport?.(),
    } as MenuItemDef] : []),
  ]
  return (
    <GridToolbar
      count={
        blocked ? <span role="status">{p.loading ? 'Loading information…' : 'Information unavailable'}</span> : <>
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
            blocked ? <Button size="sm" disabled>All attributes</Button> : p.views && p.presets ? (
              <>
                <GridViewsMenu
                  views={p.views}
                  presets={p.presets}
                  activePresetId={p.activePresetId}
                  onApplyPreset={p.onApplyPreset ?? (() => {})}
                  emptyLabel={p.viewsEmptyLabel ?? 'View'}
                  showCounts
                  manage="minimal"
                  presetInMenu={(x) => x.id !== REQUIRED_VIEW_ID && x.id !== LANGUAGES_VIEW_ID}
                  onSaveCurrent={p.onSaveCurrentView}
                  onUpdateCurrent={p.onUpdateCurrentView}
                  describeView={p.describeView}
                />
                {/* Daily column sets stay beside the view menu; other presets remain in the menu. */}
                {p.presets.filter((x) => x.id === REQUIRED_VIEW_ID || x.id === LANGUAGES_VIEW_ID).map((x) => {
                  const on = !p.activeChipId && p.activePresetId === x.id
                  const all = p.presets!.find((y) => y.id === ALL_VIEW_ID)
                  return (
                    <FilterChip
                      key={x.id}
                      size="md"
                      pressed={on}
                      count={`${x.columns.length} ${x.columns.length === 1 ? 'column' : 'columns'}`}
                      onClick={() => {
                        if (!on) p.onApplyPreset?.(x)
                        else if (all) p.onApplyPreset?.(all)
                      }}
                      title={x.description ?? x.label}
                    >
                      {x.label}
                    </FilterChip>
                  )
                })}
              </>
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
            LX.F2 / R-LX-18 — the chips are handed to the ENGINE's overflow rule, not folded here. The
            rule, its thresholds and the measured widths that chose it all live in
            `design-system/grid/toolbars/GridToolbarFold.tsx`; this file only says WHICH group folds
            first and what its trigger counts. Measured before: 9 chips = 1345.4px of a 2150px bar
            against 1200px of usable width at 1280, 9 controls clipped; after: the chips fold into one
            ~150px trigger and nothing clips at 1280 / 1440 / 1728 / 2048.
          */}
          {!gone('chips') && <GridToolbarFold label="Filters" count={orderLanguageChips(p.chips ?? [], p.languagesView ?? p.activePresetId === LANGUAGES_VIEW_ID).length}>
          {orderLanguageChips(p.chips ?? [], p.languagesView ?? p.activePresetId === LANGUAGES_VIEW_ID).map((chip) => {
            const on = p.activeChipId === chip.id
            const n = viewChipCountLabel(chip)
            const detail = [viewChipSummary(chip), chip.count !== null ? chip.note : null].filter(Boolean).join('. ')
            return (
              /*
               * A FILTER CHIP, not a button (CT.1, 2026-09-04). This was a `Button size="sm"`
               * carrying `aria-pressed` — a toggle that filters the sheet, styled as a secondary
               * action — while the Errors & Sync facets, the same role, were a clickable Pill. One
               * role, one control, on every surface: the DS `FilterChip` at its toolbar height.
               */
              <FilterChip
                key={chip.id}
                size="md"
                disabled={blocked}
                pressed={on}
                // `null` renders no number and keeps the chip — see the ViewChip contract.
                count={n ?? undefined}
                onClick={() => p.onChipToggle?.(on ? null : chip.id)}
                title={detail}
                aria-label={`${chip.label}: ${detail}`}
                compactLabel={chip.compactLabel}
              >
                {/* The glyph follows the chip's KIND (§6.2). A warning glyph on a count of WORK is
                    a false positive, and a false positive teaches operators the alarm means nothing. */}
                {viewChipIsAlarm(chip) && <AlertTriangle size={11} />} {chip.label}
              </FilterChip>
            )
          })}
          </GridToolbarFold>}
          <SheetStatuses status={p.status} compact={compactStatus} />
          <div className="nds-sheet-toolbar-actions" ref={actionsRef}>
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
      {!gone('search') && (
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
