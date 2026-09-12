'use client'
import { useGridLifetime } from '@/design-system/grid'
import { SheetLoadError } from '../SheetLoadError'
import { SHEET_STATE_OVERLAYS, sheetEmptyState } from '../sheetGridStates'

import { formulaTransfer } from '@/design-system/grid'

/**
 * PES.2 — the MASTER SCOPE SHEET. One family, every master attribute, edited cell by cell.
 *
 * The approved layout's "the grid IS the page": rows are the parent and its child SKUs as a tree,
 * columns are every master attribute, views decide which of them are on screen, and each edit
 * autosaves on its own and paints the server's answer on that cell.
 *
 * Built fresh (programme §2.10 — old trees are specification, never source). What it takes from the
 * platform is the DESIGN SYSTEM: `NexusGrid` in the `GridSheet` host, the sheet editing contract,
 * the cell library, `SheetWriter` for the write path, `useGridState` + the one `PreferencesModal`
 * for views. Nothing here restyles a grid or re-implements a cell.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

import { useAuth } from '@/lib/auth/AuthProvider'

import { Banner, useToast } from '@/design-system/components'
import { Button, InfoTip, Pill } from '@/design-system/primitives'
import { PreferencesModal, type PreferencesValue } from '@/design-system/patterns'
import { ProductTransferDrawer } from '../../import/ProductTransferDrawer'
import { FormulaBulkDialog } from '../FormulaBulkDialog'
import { FormulaHistoryDialog } from '../FormulaHistoryDialog'
import { SheetToolbar } from '../SheetToolbar'
import { SheetFooterNote } from '../SheetFooterNote'
import {
  ExpandButton,
  ExpandSlot,
  IdentityBand,
  BAND_WIDTH_FLOOR,
  deriveBandWidthFromDom,
  findKeyBearingBand,
  measureLongestSku,
  buildSkuFont,
  useExpanded,
  CompletenessPill,
  ProvenanceMark,
  NexusGrid,
  GridSheet,
  GridSheetStatus,
  ReadinessCell,
  SHEET_GRID_OPTIONS,
  actionContextMenu,
  actionMenuItems,
  useActionConfirm,
  useActionPress,
  GridExportRefused,
  gridSelection,
  sheetPasteProcessor,
  writeGate,
  exprOf,
  isFormulaDraft,
  type FormulaCandidate,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type ICellRendererParams,
  type PrefsBridgeOptions,
  type ReadinessValue,
  type ValueGetterParams,
} from '@/design-system/grid'
import { getBackendUrl } from '@/lib/backend-url'
import { ClassificationDialog } from './ClassificationDialog'

import {
  EMPTY_VIEW_CHIP_CELLS,
  useRegisterViewChip,
  useSaveReporter,
  useStudioRecord,
  useViewChips,
  viewChipHasCell,
  viewChipRows,
  type ViewChip,
} from '../../contracts'
import { isRevealAnchor, revealColumn, revealStash, traceRevealSkip, StudioDock, type RecordWriteRequest, type RecordWriteResult, type SheetRow as DrawerSheetRow, type RevealIntent, type RevealRequest } from '../../drawer'
import { AiDraftReview, useAiDraftLayer } from '../../ai'
import { buildMasterColumns } from './columns'
import { ProductRoleChip } from '../ProductRoleChip'
import { identitySecondary, secondaryPlan, type SecondaryPlan } from './identitySecondary'
import type { MenuItemDef } from '@/design-system/components'
import { reloadImpact } from './reloadGuard'
import { familySummaryOf, useFamilyVerbs } from './FamilyBar'
import type { NewVariationDraft } from './addVariation'
import { useFamilyProductPicker } from './FamilyProductPicker'
import { familyActions } from './familyActions'
import { familyOps } from './familyOps'
import { FamilySelectionBar } from './FamilySelectionBar'
import { useFamily } from './useFamily'
import { useCellFormulas } from '../../useCellFormulas'
import { cellOf, editRefusalReason } from './columnRules'
import type { RowReadiness, SheetColumn, StudioRow } from './types'
import { useMasterSheet } from './useMasterSheet'
import { mediaGridTransfer } from '../../media/mediaGridTransfer'
import { productMediaColumn, useProductMediaEditor, withProductMediaColumn, PRODUCT_MEDIA_COLUMN } from '../../media/productMediaColumn'
import { useReferenceNames } from '../useReferenceNames'
import { referenceSearchText } from '../referenceLabels'
import { flaggedColumnKeys, IDENTITY_COLUMN, orderColumnKeys, rankOfColumn, RESERVED_COLUMN_IDS } from '../views'
import { useSheetColumns } from '../useSheetColumns'
import { exportGridCsv } from '@/design-system/grid/export/exportGrid'
import type { SheetExportMode } from '../sheetExport'

export interface MasterSheetProps {
  productId: string
  market: string
  locale: string
  variationAxes?: string[]
}

/** The tree control and the P/C mark. The NAME is an editable column and is not repeated here. */
function ProductCell(
  p: ICellRendererParams<StudioRow> & {
    secondaryRef?: { current: SecondaryPlan }
    rowMenuRef?: { current: (row: StudioRow) => MenuItemDef[] }
  },
) {
  const expanded = useExpanded(p.node)
  const d = p.data
  if (!d) return null
  const parent = d.isParent
  const expander =
    parent && d.childCount > 0 ? (
      <ExpandButton expanded={expanded} onToggle={() => p.node.setExpanded(!expanded)} labels={['Expand children', 'Collapse children']} />
    ) : (
      <ExpandSlot />
    )
  const role = <ProductRoleChip product={d} />

  /*
   * Ruling #169 — "the picture on the left" — and #710: the picture, the key, the second line and
   * the readiness reading are ONE band now, drawn by the engine's `IdentityBand` so this scope and
   * every channel scope render the same row. There is no longer a branch for "has an image": the
   * band takes `noImage` and lays out the rest identically either way, which is what stops the two
   * cases drifting into two layouts.
   *
   * 🔴 Still gated on the row actually HAVING an image. The studio contract does not supply one yet
   * (measured: no `imageUrl` on any row, no image column among the 102), and an ungated thumbnail
   * would put a grey placeholder on every row — the empty-column complaint that reopened this lane.
   *
   * 🔴 An INHERITED face image is MARKED, not silently passed off as the row's own: 74 of 301
   * children have no image of their own (PES.5), so the parent's picture stands in. The mark is the
   * sheet's existing `inherited` provenance — one idea, one vocabulary — and the photo count is
   * suppressed with it, because "8 photos" would be a claim about images this row does not have.
   */
  /* One call, one line — computed here rather than twice in the JSX. */
  const line = p.secondaryRef ? identitySecondary(d, p.secondaryRef.current) : d.name

  return (
    <IdentityBand
      expand={expander}
      role={role}
      image={d.imageUrl}
      photoCount={d.imageInherited ? undefined : d.photoCount}
      noImage={!d.imageUrl}
      imageMark={
        d.imageInherited ? (
          <ProvenanceMark provenance="inherited" from="the family's picture — this variation has none of its own" />
        ) : null
      }
      sku={d.sku}
      /* Axis values when the FAMILY is fully covered, else the name — one kind of sentence per
         column, decided once (#716). `identitySecondary` holds the rule and the reasons. */
      secondary={line}
      secondaryTitle={line ?? undefined}
      menuItems={p.rowMenuRef?.current(d)}
      menuLabel={`Actions for ${d.sku}`}
      trailing={
        /* No `state`: master completeness is a RATIO with no readiness behind it, so the pill
           paints neutral and says so, rather than inventing a colour from the percentage (#43). */
        <CompletenessPill
          pct={d.completeness.overall.pct}
          tip={`${d.completeness.overall.pct}% — filled ÷ applicable master attributes`}
        />
      }
    />
  )
}

/** Identity stays visible and pinned while attribute columns are rearranged. */
const DEFAULT_LOCKED_COLUMNS: readonly string[] = ['product']

/** Search remains page state; confirmed layouts are persisted separately by useSheetColumns. */
interface SheetPageState {
  search: string
}

/**
 * 🔴 A module-level constant, NOT `= []` in the signature.
 *
 * A default parameter is evaluated on every call, so `variationAxes = []` handed this component a
 * BRAND NEW ARRAY on every render where the prop was omitted — which is every render, since the
 * studio does not pass it. That identity fed `viewCtx` (deps `[sheet, locale, variationAxes]`),
 * which fed `columnDefs`, which made AG re-render every mounted cell.
 *
 * Measured, after two wrong guesses: I first reasoned from the dependency list that `columnDefs`
 * was stable on dock open (it was not — FE.1 profiled `CellComp` 756 across three commits), then
 * fixed two other props that genuinely did re-identify and did not fix this. Bisecting the memo's
 * five deps with an in-page probe named `viewCtx`, and drilling one level named `variationAxes`.
 * **Neither of my two hypotheses, nor FE.1's named suspect (`openRecordId`), was the cause.**
 */
const NO_VARIATION_AXES: readonly string[] = []

export function MasterSheet({ productId, market, locale, variationAxes = NO_VARIATION_AXES as string[] }: MasterSheetProps) {
  const { apiRef, gridApi: gridReady, getApi: getGridApi, bind: bindGridApi, onGridPreDestroyed: releaseGrid } = useGridLifetime<GridApi<StudioRow>>()
  const reporter = useSaveReporter()
  const record = useStudioRecord()
  /**
   * 🔴 D2 (#356) — why these two are read through a ref.
   *
   * MEASURED: opening the dock changes **nothing** about the grid's geometry. Viewport 1660, root
   * 1660, sheet 1662, 294 cells, 28 columns — identical with the dock closed and open, with the
   * slide-over confirmed present. §5.1 holds: the sheet really is undisplaced. So the 189-cell
   * repaint FE.1 profiled is **not** a response to a resize; something was telling AG the grid had
   * changed.
   *
   * It was these two props. `record` is a context value whose identity changes when `rowId` does —
   * i.e. on every dock open and close — and it reached the grid twice: through `onCellKeyDown`, and
   * through `getContextMenuItems` (via `famActions`, which legitimately needs `record.rowId` as
   * DATA so a verb can refuse the row already open). AG then re-rendered every mounted cell.
   *
   * 🔴 **And this is where my own banked note nearly stopped the investigation.** AG.1 measured that
   * a new `getContextMenuItems` identity fires **0** column-model events, which is true — and I had
   * it written down as "memoise it for tidiness, not for correctness". A column-model rebuild and a
   * React repaint are **different costs**, and measuring the absence of one says nothing about the
   * other. The note now says so.
   *
   * Both are invoked ON DEMAND — a right-click, a keypress — so the latest logic through a ref is
   * exactly right, and neither has any reason to re-identify.
   */
  const recordRef = useRef(record)
  recordRef.current = record

  /**
   * PES.4 §5.4 — "the cell the record would be opened from".
   *
   * 🔴 NOT `getFocusedCell()` read when the verb runs. PES.3 measured why: clicking the `⋯` button
   * MOVES AG's focus to the actions cell, so the verb read `cell=actions` — a pinned, always-visible
   * column — `isCellCovered` answered "not covered", and the whole reveal was inert while looking
   * implemented. `isRevealAnchor` is their rule, lifted into the drawer barrel at #227 so master and
   * channel share ONE definition of what counts as chrome rather than each keeping a list.
   */
  /**
   * 🔴 A REFUSED OPEN GESTURE MUST SAY WHY — ruling 1's second half, 2026-09-03.
   *
   * MEASURED before this existed, on `condition_type` (`editable: false` on the wire, made visible
   * through Customise), master·DE: double-click, Enter, F2 and a typed character each produced
   * **0 editors, 0 toasts, no `title`, nothing new on screen.** Four gestures, four silences — and
   * an operator cannot tell that apart from a broken sheet, which is precisely how the fill-handle
   * defect above went two days without being called one.
   *
   * The words come from `editRefusalReason`, which is DERIVED from `cellIsEditable` rather than
   * restated beside it and is held to that by a test over every combination of the four vetoes: a
   * reason exists for exactly the cells AG refuses. A second predicate one line away would drift,
   * and both directions of drift are invisible — silence where the cell is locked, or an
   * explanation for a refusal that never happened.
   *
   * A DS toast, not an in-cell note: `StudioClient` already mounts `ToastProvider` for this subtree
   * (the root layout's is the OLD library's context and `useToast` throws against it), it is this
   * app's established answer for "an outcome happened", and it changes no cell geometry — a new
   * in-cell surface is a design decision and design authority is the Owner's. **Stated for the
   * Owner: the words are the cell's, the surface is mine, and moving them into the cell is a change
   * of one call.**
   */
  const { toast } = useToast()
  /* Chrome is silent by construction: `ag-Grid-AutoColumn` and the `ready:*` columns are built by
     this sheet and are in no `SheetColumn`, so the lookup misses and nothing is said. Enter on the
     identity cell keeps meaning "open the record" — see `onCellKeyDown`. */
  const columnByKeyRef = useRef<Map<string, SheetColumn>>(new Map())
  /* 🔴 The last thing said, and when. Without it a locked cell answers ONCE PER KEYSTROKE — an
     operator typing five characters into a read-only cell would get five identical toasts stacked
     on top of each other, which is not an explanation, it is a fault of its own. */
  const lastSaid = useRef<{ text: string; at: number }>({ text: '', at: 0 })
  const sayWhyRefused = useCallback(
    (colId: string | undefined, data: StudioRow | undefined): boolean => {
      if (!colId || !data || colId === PRODUCT_MEDIA_COLUMN) return false
      const col = columnByKeyRef.current.get(colId)
      if (!col) return false
      const why = editRefusalReason(col, data)
      if (!why) return false
      const now = Date.now()
      if (lastSaid.current.text === why && now - lastSaid.current.at < 2500) return true
      lastSaid.current = { text: why, at: now }
      toast(why, 'info')
      return true
    },
    [toast],
  )
  /* Invoked on a gesture, so a ref keeps the grid handlers' identity stable — the same reason
     `recordRef` above exists. */
  const sayWhyRefusedRef = useRef(sayWhyRefused)
  sayWhyRefusedRef.current = sayWhyRefused
  const onCellDoubleClicked = useCallback(
    (e: { column?: { getColId(): string } | null; data?: StudioRow }) => {
      sayWhyRefusedRef.current(e.column?.getColId?.(), e.data)
    },
    [],
  )

  const lastDataCell = useRef<string | null>(null)
  const onCellFocused = useCallback((e: { column?: { getColId(): string } | string | null }) => {
    // 🔴 AG types this `Column | string | null` — it really can hand back a bare colId. Reading only
    // `.getColId()` made every string arrive as `undefined`, i.e. "this is chrome", which would have
    // cleared the anchor on exactly the focus events that should set it.
    const col = e.column
    const colId = typeof col === 'string' ? col : col?.getColId?.()
    if (isRevealAnchor(colId)) lastDataCell.current = colId ?? null
  }, [])

  const onWriteStart = useCallback((id: string, rowId: string) => reporter.pending(id, rowId), [reporter])
  const onWriteEnd = useCallback((id: string, ok: boolean, msg?: string, rowId?: string) => reporter.resolved(id, ok, msg, rowId), [reporter])
  /* The ONLY writer of the save clock (#705). `onSettled` fires for every settled batch including
     refusals — `sheetWriter.ts:371` passes `ok` precisely so a caller can tell them apart. */
  const onSettled = useCallback(({ ok, savedAt }: { rowId: string; ok: boolean; savedAt: string }) => {
    if (ok) setLastSavedAt(savedAt)
  }, [])

  const { sheet: loadedSheet, loading, error, contractProblems, reload, refresh, writer, tracker, conflicts, bindGrid } = useMasterSheet({
    productId, market, locale, onWriteStart, onWriteEnd, onSettled,
  })
  const sheet = useReferenceNames(loadedSheet, 'MASTER', market)
  /**
   * D16 — cell formulas (#730). The endpoints live in the hook; the editor is the engine's and
   * knows no URLs. See `useCellFormulas` for why the split is a measurement and not a preference.
   */
  const formulaRowIds = useMemo(() => (sheet?.rows ?? []).map((r) => r.id), [sheet])
  const formulas = useCellFormulas({ productId, market, locale, rowIds: formulaRowIds, onSettled: refresh, onValueSaved: (rowId, fieldKey, value) => {
      const node = getGridApi()?.getRowNode(rowId)
      if (!node?.data) return
      const cell = node.data.values?.[fieldKey]
      if (cell) node.data.values = { ...node.data.values, [fieldKey]: { ...cell, value } }
      getGridApi()?.refreshCells({ rowNodes: [node], columns: [fieldKey], force: true })
    } })

  /**
   * What a `$reference` can name on this row, WITH the value it currently holds.
   *
   * 🔴 Built from the sheet's own columns, so the list is exactly what the operator can see on the
   * row in front of them. It is a TYPING AID and not a verdict: the server resolves against the
   * full per-market key set (#728/#729) and its `unknownRefs` overrides this the moment it answers
   * (`unknownRefNames`). Deriving "unknown" from this list alone would mark a good reference red
   * because the sheet happens to be filtered.
   */
  const candidatesFor = useCallback(
    (row: StudioRow): FormulaCandidate[] => {
      const cols = (sheet?.columns ?? []).map((c) => {
        const cell = cellOf(row, c.key)
        const v = cell?.value
        return {
          name: c.key,
          kind: 'field' as const,
          label: c.label,
          group: 'Columns',
          /* Absent rather than `''` for an empty cell — the editor draws no chip for a field with
             no value, and an empty chip and a missing one look identical while meaning different
             things. */
          value: v == null || v === '' ? undefined : String(v),
        }
      })
      const fns = formulas.functions.map((f) => ({
        name: f.name,
        kind: 'function' as const,
        label: f.signature,
        group: 'Functions',
      }))
      return [...cols, ...fns]
    },
    [sheet, formulas.functions],
  )

  /* `$name` → the column to outline. The sheet's key IS the colId here, but it is looked up rather
     than assumed so a column the sheet does not build gets no outline instead of a stale one. */
  const colIdOfRef = useCallback(
    (name: string): string | null => {
      const hit = (sheet?.columns ?? []).find((c) => c.key.toLowerCase() === name.toLowerCase())
      return hit ? hit.key : null
    },
    [sheet],
  )

  /**
   * 🔴 Identity-STABLE, reading through a ref — never a fresh object per render.
   *
   * This goes into `buildMasterColumns`, and a new `columnDefs` identity makes AG re-run its whole
   * column model and take the operator's widths and order with it. Both halves of this arrive
   * asynchronously (the function docs and the family's formulas), so a value-carrying object would
   * rebuild 102 column definitions twice on every load. `cellEditorParams` runs when an editor
   * opens, so the ref read there is the freshest one available, not a stale one.
   */
  const formulaLive = useRef({ candidatesFor, formulas, colIdOfRef })
  formulaLive.current = { candidatesFor, formulas, colIdOfRef }
  const formulaWiring = useMemo(
    () => ({
      candidatesFor: (row: StudioRow) => formulaLive.current.candidatesFor(row),
      preview: (rowId: string, fieldKey: string, expr: string, signal?: AbortSignal) => formulaLive.current.formulas.preview(rowId, fieldKey, expr, signal),
      functions: () => formulaLive.current.formulas.functions,
      replaceFormula: (rowId: string, fieldKey: string, value: unknown) => formulaLive.current.formulas.replace(rowId, fieldKey, value),
      unavailableReason: () => formulaLive.current.formulas.loadError ?? (formulaLive.current.formulas.ready ? null : 'Loading formulas…'),
      retry: () => formulaLive.current.formulas.reload(),
      sourceLabel: () => formulaLive.current.formulas.sourceLabel,
      exprFor: (rowId: string, fieldKey: string) => formulaLive.current.formulas.exprFor(rowId, fieldKey),
      /* #780 — same ref-read discipline as `exprFor`: the refusal arrives with the formula batch,
         after first paint, and must not rebuild a hundred column definitions to become visible. */
      errorFor: (rowId: string, fieldKey: string) => formulaLive.current.formulas.errorFor(rowId, fieldKey),
      colIdOfRef: (name: string) => formulaLive.current.colIdOfRef(name),
    }),
    [],
  )
  const formulaClipboard = useMemo(() => formulaTransfer<StudioRow>({
    exprFor: (row, key) => formulaWiring.exprFor(row.id, key),
  }), [formulaWiring])


  // F1 — the family overview (audit row 6.16). Its own read; see useFamily for why not the sheet's.
  const familyQuery = useFamily(productId)
  // The DESCRIPTOR half of the folded family bar (§2.1c) — derived from F1's read, rendered in the
  // toolbar's count slot. Derived, never stored: a second copy is a second thing to leave stale.
  const familySummary = familySummaryOf(familyQuery.family, familyQuery.loading)
  // F2 — the family VERBS. Permission is an input rather than a guess: unlink is served from
  // /api/amazon and gated by `channels.sync`, while the other three want `pim.manage`, so an
  // operator can genuinely hold one set and not the other (see familyActions' header).
  const { has, status: authStatus } = useAuth()
  // `has` is rebuilt on every AuthProvider render, so depending on it directly defeats the memo
  // below and re-renders both memo'd bars for nothing. The ANSWERS are stable; the function is not.
  // F4's COLLECT result. Held by the host rather than the bar because it is an INPUT to the verb,
  // and the verb is built here — a copy in the bar would be a second source for what gets created.
  const [newVariation, setNewVariation] = useState<NewVariationDraft | null>(null)
  const familyProductPicker = useFamilyProductPicker(productId)
  const canPim = has('pim.manage')
  const canSync = has('channels.sync')
  const canEdit = has('products.edit')
  const famActions = useMemo(
    () =>
      familyActions({
        family: familyQuery.family,
        ops: familyOps,
        can: (p) => (p === 'pim.manage' ? canPim : p === 'channels.sync' ? canSync : p === 'products.edit' ? canEdit : has(p)),
        authStatus,
        pickProduct: familyProductPicker.pick,
        pending: newVariation ? { newVariation } : undefined,
        openRecord: (rowId) => record.open(rowId, lastDataCell.current ?? undefined),
        openRecordId: record.rowId,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `has` is intentionally excluded; the
    // three booleans above are what actually change, and `has` changes identity every render.
    [familyQuery.family, canPim, canSync, canEdit, authStatus, newVariation, record, familyProductPicker.pick],
  )
  /**
   * Ruling #141 — the row's right-click menu, reading the SAME registry the family bar and the
   * selection bar read. Not a second list: `actionsFor(…, ROW, [row])` filters the one declaration,
   * so a verb cannot be offered here and refused there.
   *
   * Memoised because a memo whose dependency changes every render never caches, which
   * makes it a memo in name only. 🔴 NOT because it rebuilds AG's column model — AG.1 measured that
   * on 36.1 with a positive control: a new `getContextMenuItems` identity produces 0
   * `newColumnsLoaded` / 0 `columnEverythingChanged` / 0 `displayedColumnsChanged`, versus 1/1/1 for
   * `columnDefs`. The banked trap is real for column DEFS and I over-generalised it to callbacks
   * (ruling #192). The memo stays on its true reason; the false one is worse than none because the
   * next reader would trust it.
   */
  // A ref rather than the callback itself: `onFamilyChanged` is declared below (it needs `reload`),
  // and threading the value through a ref keeps the press handler's identity stable so the memo
  // above keeps a stable identity rather than churning on every reload closure.
  const onFamilyChangedRef = useRef<() => void>(() => {})
  const rowPress = useActionPress<StudioRow>(() => onFamilyChangedRef.current())

  /*
   * The SAME verbs the right-click offers, in the band's `⋯` (#724) — through the same adapter, so
   * the two surfaces cannot drift into different menus for one row. `actionMenuItems` returns a
   * per-row builder; the band calls it for the row it is drawing.
   *
   * 🔴 Through a REF for the reason the secondary plan is: the band's column def is memoised on
   * `[lockedColumns]`, so a value here would freeze at first render or, in the deps, rebuild the
   * column on every action change.
   */
  const rowMenuRef = useRef<(row: StudioRow) => MenuItemDef[]>(() => [])
  rowMenuRef.current = useMemo(
    () =>
      actionMenuItems<StudioRow>({
        actions: famActions,
        onSelect: (action, rows) => void rowPress.press(action, rows),
        isRecord: (r) => !!r?.id,
      }),
    [famActions, rowPress.press],
  )

  const getContextMenuItems = useMemo(
    () =>
      actionContextMenu<StudioRow>({
        actions: famActions,
        onSelect: (action, rows) => void rowPress.press(action, rows),
        // The parent row IS a record here — the sheet's tree puts it in the grid — so every row
        // qualifies. The verbs themselves refuse a parent where that matters.
        isRecord: (r) => !!r?.id,
      }),
    // 🔴 `rowPress.press`, NOT `rowPress`. `useActionPress` returns a fresh object literal on every
    // render, so depending on the object makes this memo recompute every time — and a
    // a memo that recomputes every render is not a memo. `press` is a `useCallback` and is stable.
    // (This used to cite an AG column-model rebuild; measured false for callbacks — see above.)
    [famActions, rowPress.press],
  )
  /**
   * The identity AG actually receives. `getContextMenuItems` above still re-computes when the dock
   * opens — `famActions` needs `record.rowId` — but the GRID must not see that, so this wrapper is
   * built once and reads the current menu builder at right-click time.
   */
  const contextMenuRef = useRef(getContextMenuItems)
  contextMenuRef.current = getContextMenuItems
  const stableContextMenu = useCallback<typeof getContextMenuItems>((p) => contextMenuRef.current(p), [])

  const onFamilyChanged = useCallback(() => { familyQuery.reload(); reload() }, [familyQuery, reload])
  onFamilyChangedRef.current = onFamilyChanged

  const [search, setSearch] = useState('')
  // F2 — the ROWS, not a count. A selection verb has to see what it would act on: `unlink` refuses
  // a row that is not a variation and says which ones, and a number cannot answer that.
  const [formulaHistoryOpen, setFormulaHistoryOpen] = useState(false)
  const [bulkFormulaRows, setBulkFormulaRows] = useState<Array<{ id: string; label: string }> | null>(null)
  const [selectedRows, setSelectedRows] = useState<StudioRow[]>([])
  const selected = selectedRows.length
  const [pending, setPending] = useState(0)
  const [refused, setRefused] = useState(0)
  const [refusedRowIds, setRefusedRowIds] = useState<ReadonlySet<string>>(() => new Set())
  const [offline, setOffline] = useState(false)
  /** Set by the footer's refusal note: narrow the sheet to the rows a write was refused on. */
  const [showRefusedOnly, setShowRefusedOnly] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  /* The structural identity pin only. The operator's column locks live on the
     grid as `pinned: 'left'` and are read from there — never mirrored here, because AG's header
     menu can write them and a mirror would go stale on the first "Pin left". */
  const [lockedColumns, setLockedColumns] = useState<string[]>([...DEFAULT_LOCKED_COLUMNS])
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [prefsDraft, setPrefsDraft] = useState<PreferencesValue | null>(null)
  // 🔴 STATE, not just a ref. The landing effect below needs to run when the grid becomes ready,
  // and `onGridReady` writing a ref triggers no render — so with a ref alone the effect saw
  // `apiRef.current === null`, returned, and never ran again once the api existed. Measured: the
  // sheet kept whatever column state localStorage had and never applied its landing view.

  /**
   * 🔴 Repaint when the family's formulas ARRIVE. Without this the `ƒ` mark is correct and invisible.
   *
   * The mark is drawn from `exprFor`, read through a ref at paint time so a formula load cannot
   * rebuild a hundred column definitions. The cost of that choice is that a load changes no prop
   * AG watches, so nothing repaints — the batch resolves after the first paint and the mark misses
   * its own data. `exprFor`'s identity changes exactly when the map does, which is the one honest
   * signal available here.
   */
  useEffect(() => {
    if (!gridReady) return
    getGridApi()?.refreshCells({ force: true })
  }, [formulas.exprFor, formulas.errorFor, gridReady])

  const rows = useMemo(() => sheet?.rows ?? [], [sheet])
  const rowsRef = useRef<StudioRow[]>(rows)
  rowsRef.current = rows

  /* ── the writer's own counters, so the strip is the truth ───────────────────────────────── */
  useEffect(() => {
    const sync = () => {
      setPending(writer.pending)
      let r = 0
      const ids = new Set<string>()
      for (const row of rowsRef.current) {
        for (const col of sheet?.columns ?? []) {
          if (tracker.get(row.id, col.key)?.state === 'refused') { r++; ids.add(row.id) }
        }
      }
      setRefused(r)
      // The IDS, not just the count — `GridSheetNote`'s `onShow` is required by its type precisely
      // so a refusal cannot be a number you can only stare at, and a handler with nowhere to go
      // would satisfy the compiler while reproducing the bug.
      setRefusedRowIds(ids)
      // The outage is a PAGE fact, stated once, and it clears itself when a read answers — the
      // per-cell marks say what happened to each value; this says why none of them are moving.
      setOffline(writer.unreachable)
      /* Deliberately does NOT stamp: `prev ?? null` was a no-op that looked like an update, and a
         quiet writer means "nothing in flight", never "something just saved". The clock is written
         in one place only — the `onSettled` handler below, gated on `ok`. */
    }
    return writer.subscribe(sync)
  }, [writer, tracker, sheet])

  /*
   * 🔴 RELOAD ASKS BEFORE IT DISCARDS (#663). Measured on the sheet 2026-09-02: pressing Reload
   * with a refused edit replaced the operator's typed value with the stored one and LEFT the marks
   * — the cell stayed red, the footer said "1 cell blocked" and the header said "1 change not
   * saved", all three about a change that no longer existed. Two failures in one press: work
   * destroyed without asking, and marks outliving the values they describe.
   *
   * `writer.discard()` is the second half: it drops the queue WITHOUT sending it and clears the
   * tracker in the same call, so there is no way to do half of it.
   */
  const reloadConfirm = useActionConfirm()
  const onReload = useCallback(async () => {
    const impact = reloadImpact({ pending: writer.pending, refused, unknown: writer.unknownCount })
    if (!impact) {
      reload() // nothing typed is at risk — asking would teach them to dismiss dialogs
      return
    }
    if (!(await reloadConfirm.ask(impact))) return // cancel changes NOTHING, marks and typing intact
    /* 🔴 The header is a THIRD surface and it does not clear itself (#693). `writer.discard()`
       clears the queue and the tracker — the cell and the footer — but the frame's failure count
       is the frame's, and until it is told, it goes on reporting refusals for rows that no longer
       hold one. Measured: rows and footer clean, header still "2 changes not saved".
       Told BEFORE the discard, because `refusedRowIds` is derived from the tracker that
       `discard()` is about to empty. */
    reporter.cleared(sheet?.rows.map(row => row.id) ?? [...refusedRowIds])
    writer.discard()
    reload()
  }, [writer, refused, refusedRowIds, sheet, reporter, reload, reloadConfirm])

  /* ── views ──────────────────────────────────────────────────────────────────────────────── */

  /**
   * The server's field family MINUS the ids the sheet renders itself. Derived ONCE.
   *
   * 🔴 Every consumer must use this, not `sheet.columns`: the schema also contains `sku`, and the
   * sheet draws its own pinned `sku`. Two column defs with one colId makes AG silently rename the
   * second `sku_1` (#273, measured here) — after which every lookup keyed by the column's key
   * addresses a ghost while the grid still looks right. It also lets a VIEW name a key with no
   * built def. This was filtered at four separate call sites; one missed site was all it would have
   * taken, so it is one derivation now and the sites read from it.
   */
  const mediaEditor = useProductMediaEditor(refresh, locale)
  const mediaClipboard = useMemo(() => mediaGridTransfer(formulaClipboard, mediaEditor.actions), [formulaClipboard, mediaEditor.actions])
  const schemaColumns = useMemo(
    () => withProductMediaColumn(sheet?.columns ?? []).filter((c) => !RESERVED_COLUMN_IDS.includes(c.key as never)),
    [sheet],
  )

  const viewCtx = useMemo(
    () => ({
      variationAxes: sheet?.family.variationAxes?.length ? sheet.family.variationAxes : variationAxes,
      locale,
      // Rule 4 of the approved default view (#173): anything readiness flagged on a row IN VIEW.
      // Derived from the rows rather than assumed, because "which fields are in trouble" is a
      // fact about this family — measured on the sample, it is the GPSR pair on 104/120 rows,
      // and the server's own message says those can get a listing suppressed on EU marketplaces.
      flaggedKeys: flaggedColumnKeys(sheet?.rows),
    }),
    [sheet, locale, variationAxes],
  )

  /* ── the column set: views, landing, chips, Customise — ONE hook for BOTH scopes (V.7/V.8) ── */

  /* Filled here rather than at the ref's declaration: `schemaColumns` is defined below it, and the
     refusal words need the SheetColumn the wire actually sent, never a copy. */
  columnByKeyRef.current = useMemo(() => new Map(schemaColumns.map((c) => [c.key, c])), [schemaColumns])
  const allColumnKeys = useMemo(() => schemaColumns.map((c) => c.key), [schemaColumns])
  const customisableColumns = schemaColumns

  /** Identity is structural; attribute pins are read from the grid and saved in the layout. */
  const prefsBridge = useMemo<PrefsBridgeOptions>(
    () => ({
      columns: [
        { key: 'product', locked: true },
        ...allColumnKeys.map((k) => ({ key: k })),
      ],
      treeColumnKey: 'product',
    }),
    [allColumnKeys],
  )

  /* The frame's chip registry, read here because the column hook composes a chip with the active
     view (a chip narrows to its cells' columns; clearing it restores exactly the view it narrowed). */
  const chipBar = useViewChips()

  /**
   * Views, landing, the chip's column narrowing and the Customise dialog's apply all live in
   * `useSheetColumns` — the channel scope calls the same hook, so the two sheets cannot answer the
   * same question two ways (design V.8). It also owns `useGridState`: last-used widths/pins/sort under
   * `product-edit:master`, saved views under `product-edit:views:master`.
   */
  const sheetColumns = useSheetColumns<StudioRow, SheetPageState>({
    apiRef,
    gridReady,
    columns: schemaColumns,
    viewCtx,
    serverViews: sheet?.views,
    identityColumn: IDENTITY_COLUMN,
    prefsBridge,
    activeChip: chipBar.active,
    setChip: chipBar.setActive,
    layoutSurface: `product-edit:layout:master:${market.toUpperCase()}`,
    grid: {
      surface: 'product-edit:master',
      viewsSurface: 'product-edit:views:master',
      baseUrl: getBackendUrl(),
      /* #425 — belt-and-braces beside §9.5a. When the URL names a cell, AG's own deferred
         `initialState` scroll restore lands ~90ms AFTER the reveal has already scrolled there and
         wins the race. §9.5a already strips `scroll.left` from storage, so this is the second lock:
         an explicit coordinate should not have to out-run an implicit one at all. */
      omitScroll: record.colKey != null,
      getPageState: () => ({ search }),
      applyPageState: (pg) => setSearch(pg.search ?? ''),
    },
  })
  const { gridState, applyPreset } = sheetColumns


  const scopeRows = useMemo(() => {
    let out = rows
    if (showRefusedOnly && refusedRowIds.size > 0) {
      // Parents are kept when a child is refused, or the tree has no path to the row.
      const keep = new Set(refusedRowIds)
      for (const r of rows) if (r.parentId && keep.has(r.id)) keep.add(r.parentId)
      out = out.filter((r) => keep.has(r.id))
    }
    const q = search.trim().toLowerCase()
    if (q) {
      const keep = new Set<string>()
      for (const r of out) {
        if (!`${r.sku} ${r.name ?? ''}`.toLowerCase().includes(q) && !Object.entries(r.values).some(([key, cell]) =>
          referenceSearchText(cell?.value, columnByKeyRef.current.get(key)?.optionLabels).includes(q))) continue
        keep.add(r.id)
        if (r.parentId) keep.add(r.parentId)
      }
      out = out.filter((r) => keep.has(r.id))
    }
    return out
  }, [rows, search, showRefusedOnly, refusedRowIds, schemaColumns])

/* ── the Missing-required view chip (#34) ───────────────────────────────────────────────── */

  /**
   * PES.2 PRODUCES this chip; the frame owns only the registry. The count is CELL-level, per the
   * ratified contract — from `{rows, cols}` you cannot recover WHICH cell in the rectangle was the
   * reason, and the chip's whole job is to take the operator to those cells.
   *
   * The source is the server's own `completeness.required.missing`, which is computed from the same
   * applicability rules as the readiness verdict (`@nexus/shared/master-sheet`). Deriving it here
   * from "empty and requiredBy is non-empty" would let the chip and the readiness pill disagree
   * about the same cell.
   */
  const missingRequiredChip = useMemo<ViewChip>(() => {
    if (!sheet) {
      // 🔴 `count: null` is not zero. Nothing has been counted yet, so the chip stays visible and
      // prints no number — rendering `(0)` here would answer "we checked, there are none".
      return {
        id: 'missing-required',
        label: 'Missing required',
        // §6.2 rule 1 (#362): a count of WORK is a view, not a warning. `neutral` keeps the chip and
        // its count and drops the ⚠ — the glyph now follows `tone` (see `viewChipIsAlarm`), so this
        // one line is what decides whether "Missing required (42)" reads as a filter or as an alarm.
        // 42 incomplete fields is the normal state of a catalogue, not an incident.
        tone: 'neutral',
        count: null,
        note: 'Counted once the sheet has loaded',
        cells: EMPTY_VIEW_CHIP_CELLS,
      }
    }
    const byRow: Record<string, string[]> = {}
    let cells = 0
    for (const row of scopeRows) {
      const keys = [...new Set(row.completeness.required.missing.map((m) => m.key))].filter((k) => schemaColumns.some((c) => c.key === k))
      if (keys.length > 0) {
        byRow[row.id] = keys
        cells += keys.length
      }
    }
    // `neutral`, not `warning` — see the pending branch above for why.
    return { id: 'missing-required', label: 'Missing required', tone: 'neutral', count: cells, cells: { byRow } }
  }, [sheet, scopeRows, schemaColumns])

  useRegisterViewChip('missing-required', missingRequiredChip)

  /* CH.1 — the SAME chip rule as the channel scopes (`buildChannelChips`): a `warn`-severity readiness
     issue is a Warnings cell. Master had counted only the required gaps, so its bar showed one chip
     where a channel showed three; the rule is now identical and only the DATA decides what appears. */
  const warningsChip = useMemo<ViewChip>(() => {
    if (!sheet) {
      return { id: 'warnings', label: 'Warnings', tone: 'neutral', count: null, hideWhenZero: true, note: 'Counted once the sheet has loaded', cells: EMPTY_VIEW_CHIP_CELLS }
    }
    const byRow: Record<string, string[]> = {}
    let cells = 0
    for (const row of scopeRows) {
      for (const issue of row.readiness?.issues ?? []) {
        if (issue.severity !== 'warn' || !schemaColumns.some((c) => c.key === issue.key)) continue
        if (byRow[row.id]?.includes(issue.key)) continue
        ;(byRow[row.id] ??= []).push(issue.key)
        cells += 1
      }
    }
    // `neutral` on purpose (§6.2 rule 1, the layout gate's no-warning-chip check): 42 flagged values are
    // WORK to do, not an incident. Mapping errors keep their glyph — a value that would not ship is an alarm.
    return { id: 'warnings', label: 'Warnings', tone: 'neutral', count: cells, hideWhenZero: true, note: 'A value the channel would accept but flag — the same rule the channel scopes count', cells: { byRow } }
  }, [sheet, scopeRows, schemaColumns])
  useRegisterViewChip('warnings', warningsChip)

  const invalidChip = useMemo<ViewChip>(() => {
    const byRow: Record<string, string[]> = {}
    for (const row of scopeRows) {
      const missing = new Set(row.completeness.required.missing.map((m) => m.key))
      const keys = [...new Set((row.readiness?.issues ?? [])
        .filter((i) => i.severity === 'error' && !missing.has(i.key) && schemaColumns.some((c) => c.key === i.key))
        .map((i) => i.key))]
      if (keys.length) byRow[row.id] = keys
    }
    return {
      id: 'validation-errors', label: 'Invalid values', tone: 'danger', hideWhenZero: true,
      count: sheet ? Object.values(byRow).reduce((n, keys) => n + keys.length, 0) : null,
      cells: { byRow },
    }
  }, [sheet, scopeRows, schemaColumns])
  useRegisterViewChip('validation-errors', invalidChip)

  /**
   * PES.8's AI layer. ONE fetch feeds both halves: the `✦ AI drafts (N)` chip registers itself, and
   * `draftFor` is the ref-reading, stable-identity function the column factory takes — so a draft
   * arriving repaints cells instead of rebuilding a hundred column definitions.
   *
   * `channel: null` IS the master scope in their contract, not a missing value.
   */
  const productIds = useMemo(() => rows.map((r) => r.id), [rows])
  // `locale` is passed so a TRANSLATION draft (PES.8's D7) becomes visible when the operator
  // switches locale. Absent it means "the master's own values only" in their contract — safe, but
  // it would leave translation drafts permanently invisible. The overlay index stays keyed by
  // (row, column) and the server filters by locale, which is right while the sheet shows one
  // locale at a time.
  const aiLayer = useAiDraftLayer({ productIds, channel: null, marketplace: market, locale })
  /** The review lists rows by product; an operator reads SKUs, not cuids. */
  const skuById = useMemo(() => Object.fromEntries(rows.map((r) => [r.id, r.sku])), [rows])

  const activeChip = chipBar.active

  /**
   * The active chip's cells, behind a ref.
   *
   * The class rule reads this at PAINT time, so selecting a chip repaints the cells instead of
   * handing AG a new `columnDefs` identity and re-running the column model for a hundred columns
   * (reference_ag_react_inline_options_rerun_column_model).
   */
  const chipCellsRef = useRef(activeChip?.cells ?? null)
  chipCellsRef.current = activeChip?.cells ?? null
  const isChipCell = useCallback(
    (rowId: string, colId: string) => (chipCellsRef.current ? viewChipHasCell(chipCellsRef.current, rowId, colId) : false),
    [],
  )
  useEffect(() => {
    const api = getGridApi()
    if (api && !api.isDestroyed()) api.refreshCells({ force: true })
  }, [activeChip])


  /* ── rows on screen ─────────────────────────────────────────────────────────────────────── */

  const visibleRows = useMemo(() => {
    let out = scopeRows
    if (activeChip) {
      // The chip names its own rows; a child still needs its parent or the tree has no path to it.
      const own = new Set(viewChipRows(activeChip.cells))
      const keep = new Set<string>()
      for (const r of out) {
        if (!own.has(r.id)) continue
        keep.add(r.id)
        if (r.parentId) keep.add(r.parentId)
      }
      out = out.filter((r) => keep.has(r.id))
    }
    return out
  }, [scopeRows, activeChip])

  /* ── columns ────────────────────────────────────────────────────────────────────────────── */

  const attributeColumns = useMemo(
    () => (sheet ? buildMasterColumns({ columns: schemaColumns.filter(column => column.key !== PRODUCT_MEDIA_COLUMN), tracker, locale, market, reservedColumnIds: RESERVED_COLUMN_IDS, isChipCell, draftFor: aiLayer.draftFor, formula: formulaWiring }, rowsRef) : []),
    /* `formulaWiring` is identity-stable by construction (see its definition) — it is in the deps
       because it is used, not because it changes. */
    [sheet, schemaColumns, tracker, locale, market, isChipCell, aiLayer.draftFor, formulaWiring],
  )

  /*
   * 🔴 `sku` and `completeness` USED to be pinned columns here and are now inside the band (#710).
   * The Owner: "It must all be the same exactly, visually and all." Three pinned columns meant
   * three widths kept in step by hand, which is how the P/C chip came to overlap the thumbnail —
   * each was sized on its own and none on the content. The readiness NUMBER did not vanish with its
   * column: it is the band's trailing pill, and it gained a bar, which a 90px numeric column could
   * not show.
   */
  const identityColumns = useMemo<ColDef<StudioRow>[]>(() => [], [])

  /**
   * Readiness renders what the READ actually answered, and the two reads answer differently.
   *
   * The studio route gives ONE verdict for the row in this scope; the catalogue read gives one per
   * channel coordinate. Rather than collapse the richer answer or invent the poorer one, the sheet
   * draws whichever it was given — and the footer already says which read it is showing.
   */
  const readinessColumns = useMemo<ColDef<StudioRow>[]>(() => {
    const toValue = (r: RowReadiness | undefined): ReadinessValue | null =>
      r ? { state: r.state, issues: r.issues.map((i) => i.message), ref: r.ref } : null
    const rowValue = (row: StudioRow | undefined): ReadinessValue | null => {
      if (!row) return null
      const edits = (sheet?.columns ?? []).map(col => tracker.get(row.id, col.key)).filter(Boolean)
      const failures = edits.filter(edit => edit?.state === 'refused' || edit?.state === 'unknown')
      if (failures.length) return { state: 'errors', issues: [...new Set(failures.map(edit => edit?.reason || 'An edit has not been saved.'))] }
      if (edits.some(edit => edit?.state === 'saving')) return null
      return toValue(row.readiness)
    }

    /**
     * AG.1-e — the readiness verdict as TEXT, for every consumer that is not the screen.
     *
     * `ReadinessCell` draws a pill from a structured value, and a column whose only rendering lives
     * in a `cellRenderer` exports as the literal `[object Object]` (AG's `useFormatter` stringifies
     * whatever the column holds). The export now blanks that string rather than printing nonsense,
     * which left the column empty — honest, but a hole where the file's most useful column should
     * be. This states the same verdict the pill states, so the CSV says "Missing · 3" where the
     * screen shows `Missing · 3`.
     */
    const readinessText = (v: ReadinessValue | null | undefined): string => {
      if (!v) return ''
      // Capitalised to match the pill the operator reads (GRID.md §6: `Ready` · `Missing · n` ·
      // `Errors · n`). The wire states are lowercase, and a file that says "missing · 2" where the
      // screen says "Missing · 2" is a small, needless difference between the two.
      const state = v.state ? v.state.charAt(0).toUpperCase() + v.state.slice(1) : ''
      const n = v.issues?.length ?? 0
      return n > 0 ? `${state} · ${n}` : state
    }

    const coordinates = sheet?.coordinates ?? []
    if (coordinates.length > 0) {
      return coordinates.map((c) => ({
        colId: `ready:${c.channel}:${c.marketplace}`,
        headerName: c.label,
        width: 160,
        sortable: false,
        editable: false,
        cellClass: 'nds-ag-cell nds-cell-is-locked',
        valueGetter: (p: ValueGetterParams<StudioRow>): ReadinessValue | null =>
          toValue(p.data?.readinessByCoordinate?.[`${c.channel}:${c.marketplace}`]),
        valueFormatter: (p) => readinessText(p.value as ReadinessValue | null),
        cellRenderer: ReadinessCell,
      }))
    }
    if (!sheet) return []
    return [
      {
        colId: 'ready:scope',
        headerName: 'Readiness',
        width: 170,
        sortable: false,
        editable: false,
        cellClass: 'nds-ag-cell nds-cell-is-locked',
        headerTooltip: `Saved Information against ${sheet.scope.label}; unsaved errors take priority. This is not publication eligibility.`,
        valueGetter: (p: ValueGetterParams<StudioRow>): ReadinessValue | null => rowValue(p.data),
        valueFormatter: (p) => readinessText(p.value as ReadinessValue | null),
        cellRenderer: ReadinessCell,
      },
    ]
  }, [sheet, tracker, pending, refused, offline])

  /**
   * AG.1-d — FLAT. The readiness columns were the last `marryChildren` group on the sheet, and with
   * the attribute bands gone (`columns.tsx`) keeping this one would have been the worst of both:
   * the whole header still paying its 30px strip, to label a single group.
   *
   * Where the market goes, precisely — the two readiness shapes differ and only one of them named
   * it in the band: with per-coordinate columns each header IS the coordinate (`c.label`, e.g.
   * "Amazon · DE"), so the band only repeated its children. With the single-scope fallback the
   * header is the bare word "Readiness" and the coordinate lives in its `headerTooltip` ("This row
   * against …") plus the scope bar directly above the sheet. So one case loses nothing and the
   * other loses a label it already states on hover; neither is worth 30px on every screen.
   */
  /**
   * The default column-definition order. The shared layout hook applies the saved membership
   * and order after these definitions are registered with the grid.
   *
   * `identityColumns` (SKU, Master) stay in front unsorted: they are the row's identity, not
   * attributes competing for the operator's first glance. `readinessColumns` stay at the end.
   * Only the attribute band is re-ranked, and only into a PERMUTATION of itself.
   */
  const columnDefs = useMemo(() => {
    const rank = new Map(orderColumnKeys(schemaColumns, viewCtx).map((k, i) => [k, i]))
    const ordered = attributeColumns
      .map((c, i) => ({ c, r: rankOfColumn(c, rank), i }))
      // Stable on the original index: a column the rule does not name keeps its schema position
      // relative to its unnamed neighbours instead of moving for no stated reason.
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.c)
    /* 🔴 §9.2's NON-INTERACTIVE TAIL (#448), and it is an invariant rather than a coincidence.
       UX.1 measured that 4 of 19 master columns can never be cleared of the panel at max scroll —
       the trailing panel-width of the sheet is permanently coverable, so whatever sits there is
       unreachable while a record is open. Non-interactive columns are the only ones that can
       afford that position, so `readinessColumns` (`ready:scope` and the per-coordinate
       `ready:<channel>:<marketplace>`) go LAST, after the whole attribute band.

       Stated here because the order was already right by accident of composition, and an accident
       is not a rule: anyone reordering this line would move interactive columns into the dead zone
       with nothing to tell them they had. */
    return [...identityColumns, productMediaColumn<StudioRow>(mediaEditor.open, mediaEditor.actions), ...ordered, ...readinessColumns]
  }, [identityColumns, attributeColumns, readinessColumns, schemaColumns, viewCtx, mediaEditor.open, mediaEditor.actions])

  /* ── grid wiring ────────────────────────────────────────────────────────────────────────── */

  const getRowId = useCallback((p: { data: StudioRow }) => p.data.id, [])
  const getDataPath = useCallback((d: StudioRow) => (d.parentId ? [d.parentId, d.id] : [d.id]), [])
  /*
   * The band's second line, decided ONCE for the family (#716). `rows` and `schemaColumns` are the
   * same values the band renders, so the coverage test and the render cannot disagree — a server
   * coverage figure could say "full" while the rows on screen were empty.
   *
   * 🔴 Handed to the renderer through a REF, for the reason `readRow` gives above: the column def's
   * deps are `[lockedColumns]`, so putting the plan itself in `cellRendererParams` would either
   * capture the first load's answer forever, or — if added to the deps — rebuild the auto group
   * column on every data load and re-run the column model with it. The ref's identity is stable and
   * the renderer reads `.current` when it draws.
   */
  /*
   * The band's WIDTH — derived from the band the browser actually drew (#742).
   *
   * 🔴 No slot constants. They were a measurement of another component's rendering held as numbers
   * in this file: nothing type-checked them, no test could see them, and when `CompletenessPill`
   * gained a fixed-width number the pill went 65.2 → 70 while the constant stayed 66 — five SKUs
   * truncated silently in the same edit. Measuring the first rendered band means the number cannot
   * go stale, and means this scope and the channel derive the SAME width for the same family by
   * construction rather than by two lists agreeing.
   *
   * The cost, stated: the column mounts at the floor and is corrected once the first band exists,
   * so there is one width change on the first paint of a family. The alternative is a constant that
   * is right until someone edits a component, which is the defect this replaces.
   */
  const [bandWidth, setBandWidth] = useState(BAND_WIDTH_FLOOR)
  const bandWidthRef = useRef(bandWidth)
  bandWidthRef.current = bandWidth
  /* 🔴 Has the derivation happened AT ALL — not "is the width plausible". `bandWidth` starts at the
     floor, and a floor is a legitimate derived answer for a family of short SKUs, so no reading of
     the width can tell "240 because measured" from "240 because not yet measured". The reveal needs
     exactly that distinction (`revealHost.ts`), and only this flag carries it. */
  const bandDerivedRef = useRef(false)
  /* The stash replay, reachable from the band derivation above it. A ref rather than a dependency
     because the replay is defined ~500 lines below, next to the stash it drains. */
  const replayRevealRef = useRef<(() => void) | null>(null)
  /** Stable handler for AG's column events — see the JSX. */
  const replayReveal = useCallback(() => replayRevealRef.current?.(), [])

  const secondaryRef = useRef<SecondaryPlan>({ mode: 'none', axisKeys: [] })
  secondaryRef.current = useMemo(() => secondaryPlan(rows, schemaColumns), [rows, schemaColumns])
  const autoGroupColumnDef = useMemo<ColDef<StudioRow>>(
    () => ({
      /*
       * 🔴 SIZED FROM ITS CONTENT, and clamped so nothing can squeeze it below that (#709a, Owner:
       * "we need to make sure that everything fits in the column and in the default view").
       *
       * Measured on master·IT before the fix: the column rendered **46.4px** while this def said 76,
       * and the cell's own content overflowed BOTH numbers — expander 120→140, the P/C chip
       * 146→166 and the thumbnail 131→163 against a clip edge at 156.4. The chip and the picture
       * occupied overlapping x-ranges and both crossed the clip, so the Owner saw a thumbnail and
       * no parent/child pill at all.
       *
       * Two causes, and the width alone was not one of them:
       *  1. CONTENT: expander 20 + 6 + chip 20 + 6 + thumb 32 = 84, plus the cell's 10px padding
       *     either side = 104. At the declared 76 the pill was already being clipped; the persisted
       *     46.4 only made it worse.
       *  2. PERSISTED STATE: `nds-grid:product-edit:master:v1` carried
       *     `{colId: 'ag-Grid-AutoColumn', width: 46.4453125}` — an auto-fit remainder saved from an
       *     earlier session, which beat this `width` on every load. `minWidth` is what a restored
       *     column state cannot argue with, which is why it is here and not just a bigger `width`.
       */
      /*
       * 🔴 ONE BAND, SIZED FROM ITS CONTENT (#710). It replaces `product` + `sku` + `completeness`
       * (104 + 180 + 90 = 374), so 376 is a like-for-like swap and the 1440 budget UX.1 measures is
       * unchanged — the identity is now one column instead of three, not a wider one.
       *
       * `minWidth` is what a RESTORED COLUMN STATE cannot argue with, and that is not theoretical:
       * `nds-grid:product-edit:master:v1` was carrying `{colId:'ag-Grid-AutoColumn', width:46.44}`,
       * an auto-fit remainder from an earlier session, and it beat this def on every load (#709a).
       * Content floor: expander 20 + chip 24 + thumb 32 + the readiness pill 68, four 8px gaps and
       * 20px of cell padding = 196 before a single character of SKU.
       */
      headerName: 'Product', colId: 'product', width: bandWidth, minWidth: BAND_WIDTH_FLOOR,
      pinned: lockedColumns.includes('product') ? 'left' : undefined,
      lockPinned: lockedColumns.includes('product'),
      lockPosition: lockedColumns.includes('product') ? 'left' : undefined,
      cellRenderer: ProductCell, cellClass: 'nds-ag-cell', suppressHeaderMenuButton: true,
      cellRendererParams: { secondaryRef, rowMenuRef },
      headerTooltip: 'Family — a parent and its children',
    }),
    [lockedColumns, bandWidth],
  )
  /*
   * Measure the band and push the width onto the live column.
   *
   * 🔴 Driven by the EVENTS THAT CREATE THE BAND, not by a timer. The first version returned when
   * the band was absent and never looked again — PES.3 found master at the 240 floor with 21 of 21
   * keys truncated. The second version retried 40 × 50 ms, which is still a give-up with a deadline:
   * a background tab is a zero-dimension container, AG renders no rows in it, and a cold dev
   * compile easily outlasts two seconds — so the column would sit at the floor until the next
   * `rows` change, on the one load nobody is watching.
   *
   * `firstDataRendered` and `rowDataUpdated` fire when rows actually exist, and `visibilitychange`
   * re-arms for the tab that was never visible to render into. The short retry stays only as a
   * belt for the gap between an event and layout settling; it is no longer the mechanism.
   */
  const remeasureBand = useCallback(() => {
    if (rowsRef.current.length === 0) return
    /* The band that CARRIES A KEY — the engine picks it, because a channel's alias band row has a
       different trail and measuring it reserves 26px the long keys never spend (#744). */
    const next = deriveBandWidthFromDom(
      findKeyBearingBand(),
      measureLongestSku(rowsRef.current.map((r) => r.sku), buildSkuFont()),
    )
    if (next == null) return false
    /* 🔴 Derived — and the reveal is told, BEFORE the early return below. A reveal that deferred on
       `bandReady` is waiting on this exact moment, and a family whose derived width equals the
       floor still has to release it: gating the publish on the width having CHANGED would strand
       the deep link on precisely the families where nothing moved. */
    const first = !bandDerivedRef.current
    bandDerivedRef.current = true
    /* Skip when it is already right: setting the width re-renders the band, which would re-measure
       and set it again. Terminates on the first pass rather than relying on convergence. */
    if (Math.abs(next - bandWidthRef.current) < 0.5) {
      if (first) replayRevealRef.current?.()
      return true
    }
    setBandWidth(next)
    getGridApi()?.setColumnWidths?.([{ key: 'product', newWidth: next }])
    /* 🔴 The reveal is NOT replayed here, and the first version of this fix was: it called the
       replay on the line below, and MEASURED (trace, cold load at 1280) the replay still reading
       `viewportLeft: 350` — the pre-derivation layout — 124ms after the derivation it was supposed
       to be waiting for. Asking for a width is not the width changing. `setBandWidth` lands through
       a React render of `autoGroupColumnDef`, and the pinned column's id is `ag-Grid-AutoColumn`,
       not `product`, so the `setColumnWidths` call above is not what moves it either. The replay
       rides `onDisplayedColumnsChanged` / `onColumnResized` instead — AG saying the columns HAVE
       moved, which is the event the #744 ruling asks for rather than a frame's grace. */
    return true
  }, [])

  /** One event can arrive a tick before layout settles; this retries briefly, then stops. */
  const remeasureSoon = useCallback(() => {
    const api = getGridApi()
    if (!api) return
    let tries = 0
    const go = () => {
      if (getGridApi() !== api) return
      if (remeasureBand() !== false) return
      if (tries++ < 20) { setTimeout(go, 50); return }
      /* 🔴 Gave up — so RELEASE the reveal rather than strand it. `bandReady` turns a stale
         measurement into a deferral, and a deferral that can never end is a worse defect than the
         one it replaces: the operator's deep-linked cell would sit under the drawer forever with
         nothing reported, which is the give-up-in-silence shape twice over. Measuring at the floor
         is the OLD behaviour, and the old behaviour is the correct floor for this gate. */
      bandDerivedRef.current = true
      replayRevealRef.current?.()
    }
    go()
  }, [remeasureBand])

  useEffect(() => {
    // The tab that was never visible to render into: re-arm when it becomes so.
    const onVis = () => { if (document.visibilityState === 'visible') remeasureSoon() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [remeasureSoon])

  const rowSelection = useMemo(() => gridSelection<StudioRow>(), [])
  const defaultColDef = useMemo<ColDef<StudioRow>>(() => ({ sortable: true, resizable: true }), [])
  const processDataFromClipboard = useMemo(
    () => sheetPasteProcessor<StudioRow>(customisableColumns.map((c) => ({ colId: c.key, headerName: c.label }))),
    [customisableColumns],
  )

  const onGridPreDestroyed = useCallback((event: { api: GridApi<StudioRow> }) => {
    if (apiRef.current === event.api) {
      sheetColumns.captureGridState()
      gridState.persist()
      bindGrid(null)
      setSelectedRows([])
    }
    releaseGrid(event)
  }, [apiRef, gridState, releaseGrid, bindGrid, sheetColumns.captureGridState])

  const onGridReady = useCallback(
    (e: GridReadyEvent<StudioRow>) => {
      bindGridApi(e.api)
      bindGrid(e.api)
      gridState.bind(e.api)
    },
    [bindGrid, bindGridApi, gridState],
  )

  /**
   * Every edit — typed, filled down, pasted, or undone — arrives here and goes to the ONE writer.
   * AG fires this per cell, so a fill down 20 rows is 20 calls; the writer batches them per row.
   */
  const onCellValueChanged = useCallback(
    (e: { data: StudioRow; colDef: { colId?: string }; oldValue?: unknown; newValue: unknown; source?: string }) => {
      const colId = e.colDef.colId
      /**
       * One gate, pure and tested (`design-system/grid/editors/writeGate.ts`), rather than a pile
       * of `if`s nothing covers. It refuses three things: a change with no column, the grid setting
       * its own data, and a change this component caused itself.
       *
       * `selfInflicted` is false here and that is a statement, not an oversight: this sheet NEVER
       * reverts. A refusal is a result that stays on the cell with its reason, and a 409 offers a
       * refresh rather than fighting the value back — so there is no programmatic write to
       * re-enter. `setDataValue` (which re-fires this event WITHOUT `source: 'data'`, ruling #63)
       * appears nowhere in this lane; the only programmatic call is `refreshCells`, which repaints
       * and fires nothing.
       *
       * Undo needs no code of its own: AG fires this event for `'undo'` and `'redo'`, so an undone
       * cell travels the same writer, batching and version path as the edit before it.
       */
      /**
       * `oldValue`/`newValue` are passed so the gate can refuse a change that did not change
       * anything (AG.1, hub #256). AG's FILL fires this event for every cell in the range whether or
       * not the value moved — measured on the wire: a fill down three rows that already held the
       * same value issued 2 PATCHes for 0 changes, each carrying an `expectedVersion` that can lose
       * a 409 race against a real concurrent edit.
       */
      if (!writeGate({ colId, source: e.source, selfInflicted: false, oldValue: e.oldValue, newValue: e.newValue }).write) return
      /**
       * 🔴 D16 — a FORMULA is not a value, and this is the line that keeps it from becoming one.
       *
       * The editor commits the text the operator typed. If that text starts with `=` it is an
       * expression, and it belongs in `CellFormula` with the server writing the RESULT into the
       * value layer (§1.6(A)). Sending it down the ordinary write path would store the characters
       * `="a" + $brand` as the cell's literal value — and `overrideData` is read as a value layer
       * by the resolver (`attribute-resolver.ts:258`), so the formula TEXT would publish to a
       * channel and preflight would call it valid. The leading `=` is stripped by `exprOf` on the
       * way, because `=` is a real equality operator in this language and a stored expr that keeps
       * it parses as a comparison against nothing (§1.6(B); the route refuses one).
       */
      if (!formulas.ready) {
        const reason = formulas.loadError ?? 'Formulas are still loading. Retry this edit once they are ready.'
        tracker.set(e.data.id, colId!, 'refused', reason)
        const writeId = `${e.data.id}:${colId}:${Date.now()}`
        onWriteStart(writeId, e.data.id); onWriteEnd(writeId, false, reason, e.data.id)
        return
      }
      const typed = typeof e.newValue === 'string' ? e.newValue : null
      if ((typed !== null && isFormulaDraft(typed)) || formulas.exprFor(e.data.id, colId!)) {
        /**
         * 🔴 Put the DISPLAYED value back at once — the formula text must never sit in the cell as
         * though it were the value (Owner 16:58, ruled #763).
         *
         * AG's `valueSetter` has already written `=upper($brand)` into the row by the time this
         * runs, because that mutation is what makes this event fire at all. Left alone the cell
         * renders the expression until the reload lands, and on a refusal it renders it for good —
         * a formula presented as a value, which is exactly the honest-UI rule this sheet is held
         * to. At rest the cell shows the engine's OUTPUT with the `ƒ` mark; the text belongs to the
         * editor and only while it is open.
         *
         * The value the server computes arrives by re-read below. This is not the sheet "reverting"
         * a refusal — the ruled never-revert policy is about a rejected VALUE, and a formula was
         * never a value. The unsaved counter still carries the failure.
         */
        const prev = cellOf(e.data, colId!)
        /* `cellOf` is `StudioCellValue | undefined` — a cell the row has never held. Guarded rather
           than asserted: writing an `undefined` entry into `values` would make the renderer read a
           cell that is not there, which is the shape that draws "—" over a real value. */
        if (prev) {
          e.data.values = { ...e.data.values, [colId!]: { ...prev, value: e.oldValue } }
          const node = getGridApi()?.getRowNode(e.data.id)
          if (node) getGridApi()?.refreshCells({ force: true, rowNodes: [node], columns: [colId!] })
        }

        const writeId = `${e.data.id}:${colId}:${Date.now()}`
        onWriteStart(writeId, e.data.id)
        /**
         * 🔴 The CELL tracker as well as the header reporter — they are two different things and I
         * had only fed one (PES.3, measured on the channel scope and true here too).
         *
         * `onWriteStart`/`onWriteEnd` drive `SaveReporter`, which is the header's unsaved COUNT.
         * The cell's state and its reason come from `CellSaveTracker`, which every ordinary write
         * goes through (`sheetWriter.ts:239`) and which the formula path never touched. So a refused
         * formula counted in the header, kept its text for correction — and said nothing about WHY,
         * which is exactly the half of my own contract that was missing.
         */
        tracker.set(e.data.id, colId!, 'saving')
        void (typed !== null && isFormulaDraft(typed) ? formulas.save(e.data.id, colId!, exprOf(typed)) : formulas.replace(e.data.id, colId!, e.newValue))
          .then((r) => {
            onWriteEnd(writeId, r.ok, r.error, e.data.id)
            /* The server's sentence, verbatim, on the cell it belongs to — for a refused option it
               is the one that names the allowed values, which is the whole point of PES.5 returning
               it rather than a generic "not allowed". */
            tracker.set(e.data.id, colId!, r.ok ? 'saved' : 'refused', r.error)
            /**
             * 🔴 A REFUSED formula stays in the cell so it can be corrected (Owner, #775).
             *
             * The display was put back to the old value the moment the edit committed, because a
             * formula is not a value and must not sit there looking like one. That is right while
             * the save is in flight and right when it succeeds. It is WRONG on a refusal: the
             * operator's expression would vanish and they would have to retype it to fix one
             * character. So on failure the text goes back, and the sheet's never-revert rule
             * applies — the cell carries the refusal and its reason (`onWriteEnd` above), which is
             * what distinguishes it from a value.
             */
            if (!r.ok) {
              const cell = cellOf(e.data, colId!)
              if (cell) {
                e.data.values = { ...e.data.values, [colId!]: { ...cell, value: e.newValue } }
                const n = getGridApi()?.getRowNode(e.data.id)
                if (n) getGridApi()?.refreshCells({ force: true, rowNodes: [n], columns: [colId!] })
              }
            }
            /* The value layer moved server-side, and nothing on this sheet knows the new value —
               there is no cached result on the formula row by design (§1.6(E)), so the only honest
               way to show what it produced is to re-read. */
            // The formula queue refreshes once after the whole edit batch settles.
          })
          .catch((err: unknown) => {
            const reason = err instanceof Error ? err.message : String(err)
            onWriteEnd(writeId, false, reason, e.data.id)
            /* A transport failure is an UNKNOWN outcome, not a refusal: the write may yet have
               landed. `unknown` is the tracker's word for exactly that, and it must not read as
               "rejected" when a re-read might show it saved. */
            tracker.set(e.data.id, colId!, 'unknown', `Could not reach the server — ${reason}. Refresh to see whether this saved.`)
          })
        return
      }
      writer.set(e.data.id, colId!, e.newValue, { row: e.data })
      /* 🔴 NO SAVE CLOCK HERE (#705). This ran `setLastSavedAt(new Date().toISOString())` the moment
         an edit was QUEUED — before the request had left — so the footer said "Saved HH:MM" for a
         write the server had not seen, and went on saying it when that write came back refused or
         died in an outage. The stamp now comes from the writer's settle callback, and only when
         `ok`. Found by PES.3 on the channel sheet, where the false clock sat 700px from a red cell
         and a header reading "1 change not saved". */
    },
    [writer, formulas, onWriteStart, onWriteEnd, reload],
  )

  const onSelectionChanged = useCallback(
    (e: { api: GridApi<StudioRow> }) =>
      setSelectedRows(e.api.getSelectedNodes().map((n) => n.data).filter((d): d is StudioRow => !!d)),
    [],
  )
  const clearSelection = useCallback(() => getGridApi()?.deselectAll(), [])

  /**
   * 🔴 `onRowDoubleClicked={openRecord}` is RETIRED (spec §7.3, hub ruling #184).
   *
   * **Double-click EDITS the cell.** AG.1 measured 95 of 100 columns editable, so the collision was
   * the normal case rather than an edge, and PES.3 saw this same handler open an editor on the
   * WRONG cell after the drawer reflowed a scrolled grid. One gesture may not have two owners, and
   * the editor has the better claim: the operator double-clicked a CELL, not a row.
   *
   * Three EXPLICIT affordances replace it, because removing a gesture without giving the operator
   * the way back would be the worse bug: Enter on the identity cell (below), the `open-record` verb
   * — which the registry puts on BOTH the row menu and the right-click menu from one declaration —
   * and the identity cell's own control once UX.1 specs its glyph.
   */

  /**
   * Enter on the IDENTITY cell opens the record — one of the three explicit affordances that
   * replace double-click (§7.3).
   *
   * Scoped to the identity columns on purpose: Enter anywhere else is the sheet's own "commit and
   * move down" gesture, and stealing it would be the same mistake as double-click one key over.
   * The identity cell is not editable, so Enter there has no other owner.
   */
  const onCellKeyDown = useCallback(
    (e: { event?: Event | null; data?: StudioRow; column?: { getColId(): string } }) => {
      const ke = e.event as KeyboardEvent | undefined
      if (!ke) return
      /* 🔴 A refused KEY gesture answers too, and answers FIRST — Enter, F2 and a printable
         character are open gestures exactly as a double-click is (ruling 1), and all four were
         measured silent on a locked cell. Chrome falls through: the identity column is in no
         `SheetColumn`, so `sayWhyRefused` declines it and Enter keeps opening the record below. */
      const opensAnEditor =
        !ke.altKey && !ke.ctrlKey && !ke.metaKey &&
        (ke.key === 'Enter' || ke.key === 'F2' || (ke.key.length === 1 && ke.key !== ' '))
      if (opensAnEditor && sayWhyRefusedRef.current(e.column?.getColId?.(), e.data)) return
      if (ke.key !== 'Enter' || ke.altKey || ke.ctrlKey || ke.metaKey || ke.shiftKey) return
      const colId = e.column?.getColId?.()
      if (colId !== 'ag-Grid-AutoColumn' && colId !== 'sku') return
      if (!e.data) return
      ke.preventDefault()
      // The identity cell IS chrome, so the anchor is the last data cell the operator was in.
      recordRef.current.open(e.data.id, lastDataCell.current ?? undefined)
    },
    // 🔴 `[]`, via a ref. See `stableContextMenu` below for the measurement — this handler is
    // INVOKED on a keypress, so it never needs to re-identify, and re-identifying it hands AG a new
    // prop every time the dock opens.
    [],
  )

  /** Read the current order and pins together with the layout's group assignments. */
  const openCustomise = useCallback(() => {
    if (!getGridApi()) return
    setPrefsDraft(sheetColumns.currentPreferences())
    setPrefsOpen(true)
  }, [sheetColumns])

  /* A ref because `revealNow` is defined below this callback and a hoisted `const` would be a TDZ —
     the same trap that took this file down for twenty minutes earlier tonight. The ref is assigned
     immediately after `revealNow` exists, so by the time any operator can press Save it is set. */
  /* D15 — the import drawer. It defaults to the FIXTURE transport, which is dark and bannered and
     cannot write, so mounting it here puts nothing live; PES.5's endpoint swaps the transport in
     later without this file changing. */
  const [importOpen, setImportOpen] = useState(false)
  const [transferIntent, setTransferIntent] = useState<'import' | 'export'>('import')

  const revealNowRef = useRef<((colKey: string, intent: RevealIntent) => boolean) | null>(null)

  const confirmPrefs = useCallback(
    async (next: PreferencesValue) => {
      const api = getGridApi()
      // Capture the previous set before the successful save applies the new layout.
      const wasVisible = new Set((api?.getColumnState() ?? []).filter((c) => !c.hide).map((c) => c.colId))
      const firstNew = next.visibleColumns.find((key) => !wasVisible.has(key)) ?? null
      await sheetColumns.savePreferences(next)
      // Allow AG to apply the saved order before uncovering a newly shown column.
      if (firstNew) setTimeout(() => revealNowRef.current?.(firstNew, 'uncover'), 0)
      setPrefsDraft(next)
    },
    [sheetColumns],
  )

  /** Preserve the confirmed order and groups; update local state only after durable success. */
  const saveDraftAsView = useCallback(
    async (name: string, value: PreferencesValue) => {
      await sheetColumns.savePreferencesAs(name, value)
      setPrefsDraft(value)
    },
    [sheetColumns],
  )
  const updateActiveView = useCallback(
    async (value: PreferencesValue) => {
      const active = sheetColumns.active
      if (active.kind !== 'saved') return
      const view = gridState.views.find((v) => v.id === active.id)
      if (!view) throw new Error('That view no longer exists')
      await sheetColumns.updatePreferences(view, value)
      setPrefsDraft(value)
    },
    [sheetColumns, gridState.views],
  )

  /** Reset clears grid arrangement, then applies the first preset: the full default column set. */
  const landingPresetOf = useCallback(() => sheetColumns.presets[0], [sheetColumns.presets])
  /**
   * 🔴 Restoring the padlocks has to happen in a SEPARATE render from re-applying the view, and
   * that is measured, not defensive.
   *
   * `lockedColumns` feeds `identityColumns` → `columnDefs`. A new `columnDefs` IDENTITY makes AG
   * rebuild its whole column model (measured: `newColumnsLoaded` ×1, `columnEverythingChanged` ×1)
   * and a rebuild restores the colDefs' own order. So calling `setLockedColumns` and then applying
   * the preset in the same handler put the preset's order on screen and let the rebuild throw it
   * away one tick later — Reset left the SCHEMA order, not the view's. Everything else about the
   * reset looked right, which is exactly why only the on-screen check caught it.
   *
   * The common case does not pay for this at all: an operator who never touched a padlock takes the
   * straight path, no state change, no rebuild.
   */
  const pendingResetRef = useRef(false)
  const resetColumns = useCallback(() => {
    const api = getGridApi()
    if (!api) return
    // AG's own reset drops what a VIEW deliberately no longer touches (AG.1-c): sort, ad-hoc pins,
    // widths. Clearing those is a reset's job, and a reset says so.
    api.resetColumnState()
    /* That is also what releases the operator's LOCKS, and it is the whole mechanism: a lock is a
       left pin, `resetColumnState` puts every column back on its colDef (identity pinned, the rest
       unpinned), and the preset applied below reads its lock set off the grid — so it re-states the
       identity's structural pin and nothing else. Defaults restored, no second list to keep. */
    // A reset also stops remembering: the persisted widths, pins and sort are exactly what
    // `resetColumnState` just cleared, and a reload that brought them back would undo the reset.
    gridState.forget()
    setPrefsDraft(null)
    const locksAreDefault =
      lockedColumns.length === DEFAULT_LOCKED_COLUMNS.length && lockedColumns.every((k) => DEFAULT_LOCKED_COLUMNS.includes(k))
    if (locksAreDefault) {
      const preset = landingPresetOf()
      if (preset) applyPreset(preset)
      return
    }
    pendingResetRef.current = true
    setLockedColumns([...DEFAULT_LOCKED_COLUMNS])
  }, [lockedColumns, landingPresetOf, applyPreset, gridState])

  useEffect(() => {
    if (!pendingResetRef.current) return
    pendingResetRef.current = false
    const preset = landingPresetOf()
    if (preset) applyPreset(preset)
  }, [lockedColumns, landingPresetOf, applyPreset])

  /* CH.1 — the family verbs as items of the toolbar's ⋯ overflow: the bar is identical on every scope. */
  const familyVerbs = useFamilyVerbs({
    family: familyQuery.family,
    actions: famActions,
    error: familyQuery.error,
    onRetry: familyQuery.reload,
    onDone: onFamilyChanged,
    onCollectVariation: setNewVariation,
  })
  const columnDialog = useMemo(() => ({ customise: openCustomise, reset: resetColumns }), [openCustomise, resetColumns])

  /**
   * PES.4 §5.4 — the slide-over overlays the right band of the sheet, so a record opened FROM a
   * column in that band lands underneath its own panel. The RULE is PES.4's (`revealDistance` /
   * `revealScroll`, pure and unit-tested); the SCROLL is the sheet's, because the sheet holds the
   * `GridApi`.
   *
   * 🔴 A POSITION, not a column. This used `ensureColumnVisible(colKey, 'start')`, and UX.1's sweep
   * across 25 positions showed why that cannot work: its target is derived from the COLUMN and is
   * independent of the viewport — `status` lands at 380 and `brand` at 490 at every window width —
   * so for the leftmost scrollable column the target is 0, which is where the grid already is, and
   * it no-ops however badly the panel covers it. AG has no idea the panel exists. `scrollGridTo`
   * (the engine's helper) applies `revealScroll`'s pixels instead; AG 36.1 has no horizontal-scroll
   * setter of its own, which is why that helper had to be written.
   *
   * 🔴 Only scrolls when the rule says the cell is covered — `revealDistance` returns 0 otherwise
   * and `revealScroll` hands back the current position unchanged. Scrolling regardless would move
   * the grid under an operator who could already see the cell: the same class of defect as the
   * double-click collision AG.1-a removed, an action firing when nothing asked for it.
   *
   * The anchor is `lastDataCell` — the last NON-CHROME cell the operator focused — not the cell
   * focused when the verb runs. Clicking `⋯` moves AG's focus to the actions column, which is
   * pinned and always visible, so reading focus at verb time answered "not covered" every time and
   * the reveal was inert while looking implemented (PES.3's measurement, #227).
   */
  /* The dock no longer sends a width at all (#457) — the boundary used to accept and discard one.
     The reveal measures the panel's real box, so nothing here needs the dock's own dimensions. */
  const revealNow = useCallback((colKey: string, intent: RevealIntent = 'uncover'): boolean => {
    const api = getGridApi()
    // Reported, not silently dropped: these two exits ARE the cold path, and a `false` that says
    // nothing is indistinguishable from a reveal that never ran (`traceRevealSkip`).
    if (!api || api.isDestroyed()) return traceRevealSkip(colKey, intent, 'no-api')
    const host = document.querySelector<HTMLElement>('.nds-grid-sheet .ag-root-wrapper')
    if (!host) return traceRevealSkip(colKey, intent, 'no-host')
    /* The URL cursor, never the DOM — `record.rowId` is set before the drawer has a track to
       portal into, which is the whole window this reveal is served in. */
    return revealColumn(api, host, colKey, intent, record.rowId != null, bandDerivedRef.current)
    /* 🔴 `record.rowId` IS a dependency. This was `[]`, and with the cursor now read inside it an
       empty list would freeze the value from the first render — false for the whole life of a
       verb-opened record, which is the stale-closure shape that has already cost this sheet its
       landing view (#194). The identity churn is wanted here: the replay effect below keys on this
       callback, so a record OPENING re-runs it, which is precisely when a stashed reveal becomes
       servable. */
  }, [record.rowId])
  revealNowRef.current = revealNow

  /**
   * Hold-until-ready, and replay UNTIL SERVED (hub #277/#286, amended by #750).
   *
   * ⚠ "replay ONCE" is what this said, and it was true of the code until #750 measured what the one
   * replay actually lands in. Restated rather than left standing: a comment asserting a property
   * the code no longer has is worse than none, because the next reader stops looking.
   *
   * Measured on a cold `?rec=…&cell=…` load: `StudioDock` fires the reveal once, ~1.3s in, with
   * `apiRef.current` still `null` and the grid not yet in the DOM — and because it dedupes per
   * opened cell it never fires again. 1,089px of scroll sat unused and the operator's cell stayed
   * under the panel. So a fire that cannot be served is STASHED rather than dropped.
   *
   * 🔴 Replayed off `gridReady` STATE, not the api ref: a ref assignment triggers no render, so an
   * effect keyed on it never re-runs and the stash would sit there forever — the trap that already
   * cost this sheet its landing view (#194). `sheet` is in the deps too, because the grid can be
   * ready before the rows and columns exist and there is nothing to measure until they do.
   */
  /* 🔴 The stash carries the INTENT. Found by PES.3 and not named in the ruling: the `?rec=&cell=`
     path is both the one that needs `'reveal'` AND the one that always defers, so a stash without
     the intent replays as `'uncover'` and loses exactly the deep-link case — silently, because the
     replay still reports success. The deferred path is the one that matters most and the one a
     defaulted argument breaks. */
  const pendingReveal = useRef<RevealRequest | null>(null)
  const onRevealCell = useCallback(
    (colKey: string, intent: RevealIntent = 'uncover') => {
      const request = { colKey, intent }
      pendingReveal.current = revealStash(pendingReveal.current, {
        kind: 'request', request, served: revealNow(colKey, intent),
      })
    },
    [revealNow],
  )

  /**
   * 🔴 The replay KEEPS an unserved request, and re-arms on the panel — #750, and it is a reversal.
   *
   * This used to clear the stash before attempting, on the stated reasoning that "a stash that
   * survives a failed replay would scroll the grid the next time the sheet happened to re-render".
   * The hazard is real; the conclusion was still wrong, because the single replay fires on
   * `gridReady` and that RACES the drawer. On a cold `?rec=&cell=` load the one attempt lands in the
   * window where the panel does not exist yet, so the request was discarded having never once been
   * measurable — a retry that gives up before the thing it waits for can exist.
   *
   * Measured, on my own #747 build: `bullet_point` at 1280 stayed covered by 24px with `writes []`,
   * byte-identical to the pre-fix reading, three runs (UX.1) and reproduced on both scopes (PES.3).
   *
   * So the stash survives, and the stale-scroll hazard is answered by a NARROWER guard — the stash
   * is dropped when the record closes (`revealStash`'s `'recordClosed'`), so nothing can replay into
   * a sheet whose drawer has gone.
   *
   * 🔴 Re-armed on the panel PUBLISHING its position, not on a timer. The hub's standing ruling from
   * the band width (#744): a bounded retry loop is "a give-up with a timer", and the event exists —
   * `StudioDock` writes `data-resting-left` the moment it knows where the panel lands. The observer
   * is filtered to that one attribute over the whole document rather than watching the drawer
   * (which is not in the DOM yet to be watched): a subtree registration reaches nodes added later,
   * and no grid cell carries the attribute, so a virtualising sheet does not wake it.
   */
  useEffect(() => {
    if (!gridReady || !sheet) return
    const replay = () => {
      const p = pendingReveal.current
      if (!p) return
      pendingReveal.current = revealStash(p, { kind: 'replay', served: revealNow(p.colKey, p.intent) })
    }
    replay()
    /* 🔴 Published to the band derivation, whether or not there is something stashed right now:
       the reveal can be stashed AFTER this effect runs, and a ref assigned only on the branch that
       still has work would leave the later stash with nothing to be woken by. */
    replayRevealRef.current = replay
    if (!pendingReveal.current) return
    const obs = new MutationObserver(() => {
      replay()
      if (!pendingReveal.current) obs.disconnect()
    })
    obs.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-resting-left'] })
    return () => obs.disconnect()
  }, [gridReady, sheet, revealNow])

  /* A reveal belongs to the record that asked for it. Without this the surviving stash could replay
     into a closed drawer on the next `data-resting-left` write (a resize, or the next record). */
  useEffect(() => {
    if (record.rowId == null) pendingReveal.current = revealStash(pendingReveal.current, { kind: 'recordClosed' })
  }, [record.rowId])

  /**
   * AG.1-e (#216) — Export. Owner decision D9 removed the header's "Datasheet" link-out, and
   * "the grid IS the flat file" was true for READING with no way to get the file out.
   *
   * `exportGridCsv` takes the columns as displayed and ordered, the rows as filtered and sorted, and
   * each cell as the grid renders it — so `country_of_origin` exports "Pakistan", not "PK". It
   * refuses under a server-side row model rather than writing a silent subset; this sheet is
   * client-side and holds every row, so here the grid IS the full scope.
   */
  const [exportNote, setExportNote] = useState<string | null>(null)
  /** Reference table only. Editable exports use the scoped catalog workbook engine. */
  const onExport = useCallback(
    (mode: SheetExportMode) => {
      const api = getGridApi()
      if (!api || api.isDestroyed() || !sheet) return
      try {
        const r = exportGridCsv<StudioRow>(api, `${sheet.family.sku}-${market}-table`, {
          columns: mode === 'all' ? sheetColumns.orderedKeys : 'displayed',
          leading: [{ colId: '__sku', header: 'SKU', value: row => row.sku }],
          narrowed: search.trim().length > 0,
        })
        setExportNote(`${r.rows} rows · ${r.columns} columns → ${r.fileName} · reference table`)
      } catch (e) {
        setExportNote(e instanceof GridExportRefused ? e.message : 'Could not build the file.')
      }
    },
    [sheet, market, search, sheetColumns],
  )

  /* ── PES.4's record drawer (ruling #30) ─────────────────────────────────────────────────── */

  /**
   * The dock lives HERE because the data it needs lives here: the frame reserves the track but
   * holds no rows, no columns and no writer. PES.4 deliberately did not cross the boundary.
   */
  /**
   * The row the drawer opens on — the object the grid already holds, which was the point.
   *
   * `completeness` no longer needs converting: PES.4's mirror now matches the wire (verified against
   * their `types.ts` and `master-completeness.service.ts`), so that shim is gone per the #47
   * handshake. ONE field still differs and it is not mine to rename: their `SheetRow` requires
   * `listings` (a map keyed by coordinate, the catalogue read's shape) while the live studio route
   * sends `listing` — singular, and `null` on master because a master row has no channel listing.
   *
   * On THIS sheet `{}` is the truthful answer rather than a placeholder: master scope genuinely has
   * no per-coordinate listings. It would NOT be truthful on PES.3's channel sheet, which is why
   * this is a master-only line and a rename request rather than a shared helper.
   */
  const resolveRow = useCallback((rowId: string) => {
    const row = rowsRef.current.find((r) => r.id === rowId)
    return row ? ({ ...row, listings: {} } as unknown as DrawerSheetRow) : null
  }, [])

  const drawerScope = useMemo(
    () => ({ kind: 'master' as const, marketplace: market, locale, label: sheet?.scope.label ?? `Master · ${market}` }),
    [market, locale, sheet],
  )

  /**
   * A drawer edit goes through the SAME writer as a cell edit — one write path, one dirty state,
   * one set of cell states. The drawer's `intent` rides along; `commit` decides what a reset costs
   * on this scope (see `useMasterSheet`).
   *
   * It answers `pending` rather than waiting for the server: the write is queued and batched, and
   * the cell it belongs to paints its own outcome. Blocking the drawer's field on a round trip
   * would give the operator two different accounts of the same save.
   */
  const onDrawerWrite = useCallback(
    async (req: RecordWriteRequest): Promise<RecordWriteResult> => {
      const row = rowsRef.current.find((r) => r.id === req.rowId)
      if (!row) return { state: 'refused', message: 'That row is no longer on the sheet — reload it.' }
      // The drawer speaks `writeField` (the wire name); the writer and the grid speak column keys.
      const column = (sheet?.columns ?? []).find((c) => c.writeField === req.writeField || c.key === req.writeField)
      if (!column) return { state: 'refused', message: `No column on this sheet writes “${req.writeField}”.` }
      writer.set(req.rowId, column.key, req.value, { row, intent: req.intent })
      return { state: 'pending' }
    },
    [sheet, writer],
  )

  const compareTargets = useMemo(
    () => (sheet ? [{ id: 'master', label: sheet.scope.label ?? 'Master', kind: 'master' as const, scope: drawerScope }] : []),
    [sheet, drawerScope],
  )
  const staleTypes = sheet?.meta.schemaAge.filter((a) => Date.now() - new Date(a.fetchedAt).getTime() > 7 * 864e5) ?? []
  const emptyState = sheetEmptyState(rows.length, () => {
    setSearch('')
    chipBar.setActive(null)
    setShowRefusedOnly(false)
    getGridApi()?.setFilterModel(null)
  }, onReload)

  return (
    <>
      {mediaEditor.element}
      {formulaHistoryOpen && <FormulaHistoryDialog familyProductId={productId} coordinate={{ scope: 'master', market, locale }}
        onClose={() => setFormulaHistoryOpen(false)} onApplied={() => { formulas.reload(); refresh() }} />}
      {bulkFormulaRows && <FormulaBulkDialog rows={bulkFormulaRows} columns={sheet?.columns ?? []}
        coordinate={{ scope: 'master', market, locale }} functions={formulas.functions} preview={formulas.preview}
        candidatesFor={id => { const row = rowsRef.current.find(row => row.id === id); return row ? candidatesFor(row) : [] }}
        onClose={() => setBulkFormulaRows(null)} onApplied={() => { formulas.reload(); refresh() }} />}
      <GridSheet
        toolbar={
          <>
          {/* §2.1c — the family bar is FOLDED, not deleted: its 49px band cost more than it earned
              above a sheet, but both halves survive. The descriptor joins the count slot (it is
              what this sheet IS, which is the same kind of fact as how many rows it has); the
              family verbs move into the toolbar's right-hand group.

              🔴 The verbs go to the TOOLBAR, not the selection bar — the correction that came out
              of §2.1c. They are `contextOf('product-family')`: they act on the family, so on a real
              session they are available at ZERO selection, and a selection-gated bar would make an
              operator tick an arbitrary row to reach a verb that does not act on it. The evidence
              that they were "all disabled at zero selection anyway" was a local-dev artifact —
              every `can()` is false on this machine because the session is `anon`. */}
          {/* §14.1 — the SHARED bar. Master and channel mount the same component; the family
              verbs and the schema-staleness warning are ADDITIONS to it, not a replacement for it.
              Nothing standard is passed in, so nothing standard can be silently dropped. */}
          <SheetToolbar
            visible={visibleRows.length}
            total={rows.length}
            selected={selected}
            descriptor={
              familySummary.role !== '—' ? (
                <span className="nds-cell-muted"> · {familySummary.role} · {familySummary.detail}</span>
              ) : null
            }
            search={search}
            onSearch={setSearch}
            views={gridState}
            presets={sheetColumns.presets}
            activePresetId={sheetColumns.activePresetId}
            onApplyPreset={applyPreset}
            viewsEmptyLabel={sheetColumns.emptyLabel}
            onSaveCurrentView={sheetColumns.saveCurrentAs}
            onUpdateCurrentView={sheetColumns.updateView}
            describeView={sheetColumns.describeView}
            chips={chipBar.chips}
            activeChipId={chipBar.activeId}
            onChipToggle={chipBar.setActive}
            onCustomise={openCustomise}
            onExport={() => { setTransferIntent('export'); setImportOpen(true) }}
            exportCounts={{ view: sheetColumns.visibleAttributeKeys().length, all: sheetColumns.orderedKeys.length }}
            exportDisabled={!sheet || loading || !has('products.export')}
            exportPurpose="workbook"
            onImport={() => { setTransferIntent('import'); setImportOpen(true) }}
            /* Disabled until the sheet has loaded: the drawer writes to the coordinate the sheet
               was on, and until `sheet.scope` exists there is no coordinate to name. */
            importDisabled={!sheet || loading || !has('products.import')}
            onReload={onReload}
            loading={loading}
            unavailable={!!error}
            overflow={[...familyVerbs.items, { id: 'formula-history', label: 'Formula history…', onSelect: () => setFormulaHistoryOpen(true) }, { id: 'bulk-formula', label: 'Apply formula to selected products…', disabled: !selected || !formulas.ready || !canEdit, onSelect: () => setBulkFormulaRows(selectedRows.map(row => ({ id: row.id, label: row.sku ?? row.id })).sort((a, b) => Number(a.id === productId) - Number(b.id === productId))) }]}
            trailing={
              <>
                <ClassificationDialog productId={productId} disabled={loading || !!error || !canEdit} onChanged={onFamilyChanged} />
                {(staleTypes.length > 0 || (sheet?.meta.schemaMissing.length ?? 0) > 0) && (
                  <InfoTip
                    tip={
                      sheet && sheet.meta.schemaMissing.length > 0
                        ? `Attribute setup is incomplete: ${sheet.meta.schemaMissing.join(', ')}. Choose a product family in Classification; channel requirements use their selected category.`
                        : `Length caps and lists come from a schema last fetched ${staleTypes.map((t) => `${t.productType} ${t.fetchedAt.slice(0, 10)}`).join(', ')}.`
                    }
                  >
                    <Pill tone="warning" size="md"><AlertTriangle size={11} /> {(sheet?.meta.schemaMissing.length ?? 0) > 0 ? 'Setup incomplete' : 'Cached requirements'}</Pill>
                  </InfoTip>
                )}
                {familyVerbs.status}
              </>
            }
          />
          </>
        }
        footer={
          !loading && !error && <>
          {/* F2 — the selection verbs. In the FOOTER so it sits at the bottom of the sheet's own
              bounded container, which is where BulkActionBar is specified to live; it renders
              nothing at zero selection, so it costs no space until there is a selection. */}
          <FamilySelectionBar rows={selectedRows} actions={famActions} onClear={clearSelection} onDone={onFamilyChanged} />
          {/* 🔴 The right-click menu's OWN confirm dialog. Without this mounted, a verb run from the
              context menu would await an `ask()` whose dialog never renders — the promise never
              settles and the verb hangs silently, with the row menu simply closing as if nothing
              had been pressed. Every surface that runs a verb has to mount its own. */}
          {rowPress.problem && <div className="nds-grid-footstrip" role="alert"><span className="nds-cell-stock-out">{rowPress.problem}</span></div>}
          {rowPress.confirmElement}
          {familyVerbs.dialogs}
          {reloadConfirm.element}
          <GridSheetStatus rows={visibleRows.length} selected={selected} pending={pending} refused={refused} saving={writer.busy} lastSavedAt={lastSavedAt}>
            {/* §6.5 — ONE footer slot, occupants by priority. The refusal outranks the hint because a
                blocked write is the only thing here an operator must act on; the hint is what they
                can already do. Height never changes (DS.2 measured STRIP_GREW 0 for all four kinds),
                so the strip does not move under them when a write is refused. */}
            {/* The ONE note slot — offline · refusal · keyboard hint — is `SheetFooterNote`, shared with
                the channel scopes so the footer reads identically on all three (2026-09-04). */}
            <SheetFooterNote
              layoutRecovery={sheetColumns.loadError ? { retry: sheetColumns.reloadSavedPreferences } : null}
              offline={offline}
              refused={refused}
              showRefusedOnly={showRefusedOnly}
              onToggleRefused={() => setShowRefusedOnly((v) => !v)}
              lastSavedAt={lastSavedAt}
            />
            {/* AG.1-e — what the file actually contains. A download that says nothing leaves the
                operator checking their Downloads folder to find out whether it worked, and a REFUSAL
                (a server-side row model) has to be readable rather than silent. */}
            {exportNote && <span className="nds-cell-muted">{exportNote}</span>}
            {sheet?.meta.source === 'legacy' && (
              <InfoTip tip="The studio sheet route is not deployed yet, so this is the catalogue read adapted to the same shape. Cell values and versions are real; the layer each value came from is INFERRED here rather than stated by the server.">
                <Pill tone="neutral" size="sm">adapted read</Pill>
              </InfoTip>
            )}
            {conflicts.length > 0 && (
              <Button size="sm" variant="link" onClick={reload}>
                {conflicts.length} {conflicts.length === 1 ? 'row' : 'rows'} changed elsewhere — refresh
              </Button>
            )}
          </GridSheetStatus>
          </>
        }
      >
        {error ? (
          <SheetLoadError label="shared product information" onRetry={reload} />
        ) : (
          <>
            {contractProblems.length > 0 && (
              <Banner tone="warning" title="The sheet read did not match its contract">
                {contractProblems.join(' · ')}
              </Banner>
            )}
            <NexusGrid<StudioRow>
              fill
              {...SHEET_GRID_OPTIONS}
              {...SHEET_STATE_OVERLAYS}
              noRowsOverlayComponentParams={emptyState}
              {...mediaClipboard}
              rows="media-line"
              getContextMenuItems={stableContextMenu}
              treeData
              flatTree
              groupDefaultExpanded={-1}
              tooltipShowDelay={300}
              rowData={loading ? [] : visibleRows}
              /* The band's width is measured from the band, so it is measured when AG says a band
                 exists — never on a timer (#744). */
              onFirstDataRendered={remeasureSoon}
              onRowDataUpdated={remeasureSoon}
              /* A stashed reveal becomes measurable the moment the columns actually move — which is
                 what the band's derivation does to every centre column. Cheap: `replayReveal` is a
                 no-op unless something is stashed, and the stash is dropped once served. */
              onDisplayedColumnsChanged={replayReveal}
              onColumnResized={replayReveal}
              columnDefs={columnDefs}
              defaultColDef={defaultColDef}
              autoGroupColumnDef={autoGroupColumnDef}
              getRowId={getRowId}
              getDataPath={getDataPath}
              rowSelection={rowSelection}
              onSelectionChanged={onSelectionChanged}
              onGridReady={onGridReady}
              onGridPreDestroyed={onGridPreDestroyed}
              onCellValueChanged={onCellValueChanged}
              processDataFromClipboard={processDataFromClipboard}
              loading={loading}
              columnDialog={columnDialog}
              initialState={sheetColumns.initialState}
              onCellDoubleClicked={onCellDoubleClicked}
              onCellKeyDown={onCellKeyDown}
              onCellFocused={onCellFocused}
            />
          </>
        )}
      </GridSheet>

      {/*
        PES.8's review panel (ruling #75), shown only while the ✦ chip is ACTIVE.
        The chip stays a pure filter (#34) — it narrows the sheet to the drafted cells — and this
        appears beside that filtered view, so approve/reject sits next to the tinted cells it
        decides on rather than in a surface of its own. It shares the chip's fetch: one
        `useAiDraftLayer` feeds the overlay, the chip and this panel.

        🔴 `onApplied={reload}` is not optional. Approving replays through `PATCH /api/products/bulk`,
        so the CELL now holds a new value while these rows still hold the old one. PES.8's hook
        refreshes its own drafts and has no way to refresh mine — without this the tint clears and
        the cell underneath still shows the pre-approval value, breaking "displayed must round-trip"
        at the exact moment the operator is watching for the change they just made.
      */}
      {chipBar.activeId === 'ai-drafts' && <AiDraftReview drafts={aiLayer.drafts} skuById={skuById} onApplied={reload} />}

      {/*
        PES.4's record drawer (ruling #30). It portals itself into the frame's reserved track, so
        it renders nothing until a row is open — the sheet does not lay out around it.
      */}
      <StudioDock
        resolveRow={resolveRow}
        columns={sheet?.columns ?? []}
        scope={drawerScope}
        compareTargets={compareTargets}
        loading={loading}
        error={error}
        onWrite={onDrawerWrite}
        onRevealCell={onRevealCell}
        /* PES.4's D16 formula field in the drawer (#730). The hook stays HERE and is injected
           because it needs the full coordinate including `market`, which `DrawerScope` does not
           carry — `/pim/formulas/preview` refuses without one (#729) and a guessed market is a
           plausible wrong answer rather than an error. Injecting also keeps ONE answer to "what
           formula is on this cell" for rows the sheet already holds.
           🔴 No `writesRefused` here, deliberately: master's drawer DOES write. The channel scope
           refuses writes wholesale and must declare it, because a host that refuses by RETURNING a
           refusal from `onWrite` can only be discovered by calling `onWrite` — and calling it is
           the write. A formula reaches the server through `save`, not through `onWrite`, so that
           refusal could not have stopped it (PES.3's catch, not mine). */
        formulas={formulas}
      />

      {/*
        The ONE Customise dialog, wired the way `/products/next` wires it — same component, same
        props shape, same behaviour. `showSticky={false}`: the sheet pins its identity block through
        the padlocks above, and a second sticky control would be a different answer to the same
        question. No group/aggregate options: the rows are one family's tree, and row grouping would
        fight `treeData`.
      */}
      {sheet && (
        <ProductTransferDrawer
          open={importOpen}
          intent={transferIntent}
          onClose={() => setImportOpen(false)}
          productId={productId}
          market={market}
          locale={locale}
          selectedIds={selectedRows.map(row => row.id)}
          visibleFields={sheetColumns.visibleAttributeKeys().flatMap(key => { const c = sheet.columns.find(c => c.key === key); return c ? [c.slot?.of ?? c.key] : [] })}
          onReference={() => onExport('view')}
          onApplied={() => { formulas.reload(); reload(); familyQuery.reload() }}
        />
      )}
      {familyProductPicker.element}
      <PreferencesModal
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        value={prefsDraft ?? { visibleColumns: [], lockedColumns, stickyFirstColumn: true, stickyLastColumn: false, pageSize: 0, sortBy: '', sortDir: 'asc' }}
        onConfirm={confirmPrefs}
        /* 🔴 ONE identity entry, derived — not three hardcoded ones. `sku` and `completeness` were
           offered here as lockable columns after they had become the band's key line and its
           readiness pill, so the dialog promised two toggles the grid could not honour and the
           bridge refused them on every load. The label names what the single locked column now
           contains, because "Family" no longer describes a cell holding the SKU and the pill. */
        allColumns={sheetColumns.preferenceColumns}
        // Reset = the ground state: every column, §9.2 order (design V.4d).
        defaultVisible={sheetColumns.allColumnKeys}
        pageSizeChoices={[]}
        sortFieldOptions={[]}
        showSticky={false}
        groupToggles
        inViewCount
        attributeGroups
        onReloadSaved={sheetColumns.reloadSavedPreferences}
        viewSave={{ activeName: sheetColumns.activeViewName, onSaveAs: saveDraftAsView, onUpdate: sheetColumns.activeViewName ? updateActiveView : undefined }}
        title={sheetColumns.activeViewName ? `Customise columns · ${sheetColumns.activeViewName}` : 'Customise columns'}
        listHint="Organise attributes into groups and choose their order. Save keeps your personal layout for this market, including after a reload."
      />
    </>
  )
}
