'use client'
import { ShopifySheetReview } from '../../shopify/ShopifySheetReview'

import { recoverSheetRow } from '../sheetRecovery'
import { useShopifyDraftCell, shopifyDraftColumn } from '../../shopify/ShopifyDraftCell'
import { shopifyGridTransfer } from '../../shopify/shopifyGridTransfer'
import { withShopifyColumns } from '../../shopify/unlinkedInformationColumns'
import { channelScopeUrl } from './useChannelSheet'
import { reloadImpact } from '../master/reloadGuard'
import { ProductRoleChip } from '../ProductRoleChip'

import { formulaTransfer } from '@/design-system/grid'

/**
 * PES.3 — a CHANNEL SCOPE of the Product Edit Studio sheet (e.g. eBay · IT).
 *
 * `docs/2026-09-01-product-edit-studio-layout.md` §1. The same sheet as the master scope,
 * re-projected: rows are one collapsible group per LISTING ALIAS (①②③…), each with the same child
 * SKUs underneath and one shared stock pool; columns are that channel's own field family; every cell
 * shows which layer of the cascade it came from.
 *
 * ── What this component does NOT own ────────────────────────────────────────────────────────────
 * The grid chrome lives in the engine (feedback_grid_chrome_lives_in_the_engine): `NexusGrid` +
 * `GridSheet` + `SHEET_GRID_OPTIONS` are consumed exactly as `/products/_sheet/MasterSheet.tsx`
 * consumes them, never restyled here. Two pieces of substrate this scope needs do not exist yet —
 * a provenance cell affordance and an alias band renderer — and are requested of PES.2 in
 * `docs/pes-claims.md`. Until they land they are local components in this folder, marked for
 * deletion, not forks of anything.
 *
 * ── Honesty ─────────────────────────────────────────────────────────────────────────────────────
 * The read belongs to PES.5 and is not deployed yet. When it 404s this renders a notice that says
 * exactly that. It never falls back to fixture rows: an empty grid and a missing endpoint look
 * identical on screen, and only one of them is a fact about the catalogue.
 */
import { SchemaStatus } from './SchemaStatus'
import { scalarColumnDef, BOOLEAN_OPTIONS, SHEET_NUMBER_EDITOR_PARAMS } from '@/design-system/grid/editors/scalarValue'
import { columnForCategory } from '@nexus/shared/master-sheet'
import { EbayPolicyEditor, isEbayPolicyField } from '../EbayPolicyInput'
import { ChannelCategoryEditor } from '../ChannelCategoryEditor'
import { useGridLifetime } from '@/design-system/grid'
import { channelLabel } from '../../scopes'
import { SheetLoadError } from '../SheetLoadError'
import { SHEET_STATE_OVERLAYS, sheetEmptyState } from '../sheetGridStates'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { mediaGridTransfer } from '../../media/mediaGridTransfer'
import { productMediaColumn, useProductMediaEditor, withProductMediaColumn, PRODUCT_MEDIA_COLUMN } from '../../media/productMediaColumn'

import {
  CellSaveTracker,
  GridSheet,
  GridSheetStatus,
  NexusGrid,
  CompletenessPill,
  BAND_WIDTH_FLOOR,
  buildSkuFont,
  deriveBandWidthFromDom,
  findKeyBearingBand,
  gridSelection,
  IdentityBand,
  measureLongestSku,
  ProvenanceMark,
  SHEET_GRID_OPTIONS,
  SheetWriter,
  bandColSpan,
  classifyProvenance,
  provenanceClassRules,
  roundTripClassRules,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type ICellRendererParams,
  type SheetWriteRequest,
  type ValueGetterParams,
  type ValueSetterParams,
  selectEditor,
  SELECT_CELL_CLASS,
  exprOf,
  isFormulaDraft,
  formulaCellEditorSelector,
  numericColumn,
  composeCellTooltip,
  longTextTooltipLine,
  sheetValidationFor,
  composeSheetCellClassRules,
  shapeColumnDef,
  shapeEditorSpec,
  shapeTooltipLine,
  isShaped,
  suppressFormulaKeys,
  SelectPanelEditor,
  type FormulaCandidate,
  type FormulaWiring,
} from '@/design-system/grid'
import { SkuTag } from '@/design-system/grid'
import { Button, TooltipPortalProvider } from '@/design-system/primitives'
import { Modal, useToast, type MenuItemDef } from '@/design-system/components'
import { refusalWords } from '@/design-system/grid/editors/refusalWords'

import { AliasBandCell, BandExpander } from './AliasBandCell'
import { describeValueSource, resetSourceLabel } from './value-source'
import { AliasPublishControl } from './AliasPublishControl'
import { StructuredAttributeEditor, parseRecordValue, recordSummary } from '../StructuredAttributeEditor'
import { CascadeCell } from './CascadeCell'
import { useCellFormulas } from '../../useCellFormulas'
import { useActionConfirm } from '@/design-system/grid/actions/ActionConfirm'
import { wholeListWriteField } from './provenance'
import { channelWriteIdentity, channelWriteGate, dataPathFor, isRevealAnchor, withMappingRun, distinctVariantCount, isCellEditable, offersCascade, orderRows, rowIdOf, summariseAlias, withRowIdentity, cellHoverNote, crossChannelColumnCount, variantRowsOf, filterRowsWithBands } from './rows'
import { aliasMark, cascadeIntent, cascadeOf, type CascadeIntent } from './provenance'
import { studioAccountAccess } from '../../accountScope'
import type { AliasGroup as PreflightAlias } from './types'
import { mappingHref } from '@/app/channels/mapping/_shared/navigation'
import type { GetContextMenuItemsParams } from '@/design-system/grid'
import { addListingAlias, commitChannelRow, useChannelSheet } from './useChannelSheet'
import { buildChannelChips, chipHasCell, rowsForChip } from './viewChips'
import { useRegisterViewChip, useSaveReporter, useStudioRecord, useStudioScope, useViewChips } from '../../contracts'
import type { CompareTarget } from '../../drawer/types'
import { useAuth } from '@/lib/auth/AuthProvider'
import { ProductTransferDrawer } from '../../import/ProductTransferDrawer'
import { StudioDock, revealColumn, traceRevealSkip } from '../../drawer'
import { revealStash, type RevealIntent, type RevealRequest } from '../../drawer/revealCell'
import { readinessMeta } from '@/design-system/grid/renderers/readiness'
import { getBackendUrl } from '@/lib/backend-url'
import { channelSurfaceKey } from './persistence'
import { exportGridCsv, GridExportRefused } from '@/design-system/grid/export/exportGrid'
import { useSheetColumns } from '../useSheetColumns'
import type { SheetExportMode } from '../sheetExport'
import type { SheetColumn as StudioSheetColumn } from '../master/types'
import type { PrefsBridgeOptions } from '@/design-system/grid/columns/columnPrefs'
import { PreferencesModal, type PreferencesValue } from '@/design-system/patterns'
import { FormulaBulkDialog } from '../FormulaBulkDialog'
import { FormulaHistoryDialog } from '../FormulaHistoryDialog'
import { SheetToolbar } from '../SheetToolbar'
import { longTextEditor } from '@/design-system/grid/editors/sheet'

import { actionContextMenu, actionMenuItems } from '@/design-system/grid/actions/menuAdapters'
import { useActionPress } from '@/design-system/grid/actions/useActionPress'

// 🔴 IMPORTED, never forked. #173's default-view rule is PES.2's and is deliberately
// channel-agnostic — it takes columns + context and returns keys. Re-deriving it here would give
// the two scopes different answers to "what should an operator land on", which is the exact drift
// the anti-fork directive exists to stop.
import { useReferenceNames } from '../useReferenceNames'
import { parseReferenceOrScalarValue, referenceColumnDef, referenceSearchText, referenceTooltip } from '../referenceLabels'
import { isReferenceField } from '../referenceOptions'
import { ReferenceSelectEditor } from '../ReferenceSelectEditor'
// The ORDER rule travels with it (#684/#687). `orderColumnKeys` is the same ranking applied to
// every column rather than the default view's subset; this scope imported only the VISIBILITY half,
// so it hid the right columns and then rendered the survivors in the contract's own order.
import { orderColumnKeys, rankOfColumn, RESERVED_COLUMN_IDS } from '../views'
// #467/D11 — ONE rule-4 implementation for both scopes, read from the server's readiness verdict
// rather than from delivered cells. Imported from the shared layer, not through master's barrel.
import { flaggedColumnKeys } from '../flaggedColumns'

import { CHANNEL_VERB_PERMISSION, channelActions, type PermissionState } from './channelActions'

import { aliasKeyOf, type ChannelScopeChannel, type ChannelSheetRow, type SheetColumn, type StudioCellValue } from './types'

import './channel-sheet.css'
import { columnApplies } from '@nexus/shared/master-sheet'
import { SheetFooterNote } from '../SheetFooterNote'

/**
 * The validation a channel column carries — master's definition (`sheetValidationFor`), gated on
 * the SAME `columnApplies` master gates on. Before 2026-09-04 this scope validated nothing: no
 * invalid tint, no corner mark, no `⚠ required`, no length warning, while master showed all four.
 */
const channelValidation = (col: SheetColumn) => sheetValidationFor<ChannelSheetRow>(col, (d) => columnApplies(col, d))

export interface ChannelSheetProps {
  shopifySchema?: import('@nexus/shared/shopify-linked-products').ShopifyStoreSchema | null
  accountId?: string
  productId: string
  channel: ChannelScopeChannel
  marketplace: string
  locale?: string
}

/* 🔴 THE SLOT TABLE IS GONE (#742). Three versions of it were wrong in three different ways — one
   measured while the `⋯` was silently absent, one split the trail into two boxes and charged a gap
   the DOM never spends, one enumerated the five real children and STILL truncated five keys because
   the text box carries an inset no slot list mentions. Each looked right and each was caught only by
   a truncating SKU.

   `deriveBandWidthFromDom` measures the COMPLEMENT — `cellWidth − textWidth` is every pixel the row
   spends on something that is not the key, whatever those pixels are for — so a slot added tomorrow
   is counted without anyone updating a list. PES.2's, shared, and the reason my scopes and master
   now agree on 404 is that neither is enumerating anything. */


/**
 * The channel drawer's refusal, in ONE place because two things must say it identically: the
 * `onWrite` result an operator sees when a write is attempted, and the `writesRefused` flag that
 * stops the formula field offering one in the first place.
 */
const DRAWER_READ_ONLY = 'Edit channel values in the sheet — the drawer is read-only on a channel scope.'

export function ChannelSheet({ productId, channel, marketplace, locale, accountId, shopifySchema }: ChannelSheetProps) {
  const { toast } = useToast()
  const { accounts, destination, setListing, registerScopeChangeGuard } = useStudioScope()
  const alternateAccount = !studioAccountAccess(accounts, accountId).supportsPrimaryTools
  const { data: loadedData, loading, error, backendMissing, reload, refresh } = useChannelSheet({
    productId,
    schemaRevision: shopifySchema?.revision,
    channel,
    marketplace,
    locale,
    accountId,
  })
  const selectedAlias = destination.status === 'ready' ? destination.data.aliasKey : null
  const selectedData = useMemo(() => !loadedData || selectedAlias === null ? loadedData : {
    ...loadedData, rows: loadedData.rows.filter(row => (row.aliasId ?? '') === selectedAlias),
    aliases: loadedData.aliases.filter(alias => (alias.id ?? '') === selectedAlias),
  }, [loadedData, selectedAlias])
  const shopifyData = useMemo(() => withShopifyColumns(selectedData, shopifySchema), [selectedData, shopifySchema])
  const data = useReferenceNames(shopifyData, channel, marketplace, accountId)
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  const { apiRef, gridApi: gridReady, getApi: getGridApi, bind: bindGridApi, onGridPreDestroyed: releaseGrid } = useGridLifetime<GridApi<ChannelSheetRow>>()
  const [tracker] = useState(() => new CellSaveTracker())
  /**
   * The active chip's cells, read by `cellClassRules` at paint time.
   *
   * A REF rather than a dependency on purpose: putting the active chip in `columnDefs`' deps
   * rebuilds the whole column model whenever a chip is toggled, which loses column state mid-edit
   * (reference_ag_react_inline_options_rerun_column_model). The ref keeps the model stable and a
   * `refreshCells` below repaints instead.
   */
  const activeCellsRef = useRef<{ byRow: Record<string, string[]> } | null>(null)

  /**
   * PES.1's contract: "PES.2 / PES.3 WRITE it — the sheet reports per-cell outcomes; the header
   * never computes one." So every write is announced here and the sticky header aggregates.
   *
   * Held in a ref because the writer below is constructed once and would otherwise close over the
   * first render's reporter — a save that reports `pending` to a stale reporter never resolves on
   * the real one, and the header sticks on "Saving…" forever.
   */
  const reporter = useSaveReporter()
  const reporterRef = useRef(reporter)
  reporterRef.current = reporter
  const writeSeq = useRef(0)
  const writeInstanceId = useId()
  const [formulaHistoryOpen, setFormulaHistoryOpen] = useState(false)
  const [bulkFormulaRows, setBulkFormulaRows] = useState<Array<{ id: string; label: string; rowId: string; aliasKey: string }> | null>(null)
  const [selected, setSelected] = useState<ChannelSheetRow[]>([])
  const [transferIntent, setTransferIntent] = useState<'import' | 'export'>('import')
  const [transferOpen, setTransferOpen] = useState(false)
  const [cellDetails, setCellDetails] = useState<{ title: string; value: string; notes: string; rowId: string; colKey: string; action?: { label: string; description: string; run: () => void } } | null>(null)

  /**
   * §9.5a — widths, pins and sort survive between visits, **keyed per coordinate**; membership and
   * order come from the VIEW (design V.2/V.8). The storage is `useGridState`'s now, inside
   * `useSheetColumns` below — the same hook master calls, with the same three persisted slices.
   *
   * 🔴 The key carries the channel AND the market. Channels declare different column sets, so a
   * master-shaped key would land eBay's widths on Amazon's columns — and those entries would read
   * as preferences an operator set, not as a bug. Saved VIEWS are per CHANNEL: the column set is the
   * channel's, and a view built on Amazon·IT is exactly as true on Amazon·DE.
   */
  const surfaceKey = channelSurfaceKey(channel, marketplace)
  /** §14.1's standard controls — every one wired, none declared absent (views included since 2026-09-04). */
  const [search, setSearch] = useState('')
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [prefsDraft, setPrefsDraft] = useState<PreferencesValue | null>(null)
  /**
   * The operator's column padlocks — `[]` by default, and this scope has no structural half.
   *
   * The lock contract (2026-09-05): a lock is `pinned: 'left'` ON THE GRID, so this state is the
   * dialog's starting point and never the source of truth — every apply reads the pins back off the
   * grid (`useSheetColumns.gridLocks`), because AG's header menu "Pin left" writes them too and a
   * React mirror would go stale on the first one. The identity band is not in this list on any
   * market: it is `{ key: '__identity', locked: true }` in the bridge and `lockPinned` in its
   * colDef, which is a STRUCTURAL lock — the grid's own, never the operator's to open. (Master's
   * `product` differs: unlocking it there rewrites that sheet's column definitions, so master keeps
   * a one-bit structural set beside this one.)
   */
  const [lockedColumns, setLockedColumns] = useState<string[]>([])
  const [exportNote, setExportNote] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [refused, setRefused] = useState(0)
  const [pending, setPending] = useState(0)
  // The IDS as well as the count — the refusal note's "show affected rows" narrows to them (master's §6.5).
  const [refusedRowIds, setRefusedRowIds] = useState<ReadonlySet<string>>(() => new Set())
  const [showRefusedOnly, setShowRefusedOnly] = useState(false)
  // A PAGE fact, stated once in the footer; clears itself when a read answers (master's rule).
  const [offline, setOffline] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)

  const rows = useMemo(
    () => (data ? orderRows(withRowIdentity(data.rows, data.aliases)) : []),
    [data],
  )

  /**
   * The live mirrors of `data` and `rows`, declared HERE beside what they mirror.
   *
   * They exist because the auto group column's def is built once and would otherwise serve the
   * first render's data forever (see `autoGroupColumnDef`); the formula wiring below needs the same
   * property for the same reason, and reads them from ~900 lines above their old home. A ref
   * captured inside a closure resolves at call time, so the old order worked — but "it works
   * because nothing calls it during render" is a property nobody can see while editing, and this
   * file has already paid once for a def that captured an empty list (`menuItemsRef`).
   */
  /**
   * Has the identity band DERIVED its width, or is it still at the 240px floor? (#752)
   *
   * The reveal host cannot ask the DOM this: a band at the floor and a band whose derived width
   * happens to BE the floor look identical, and the difference decides whether a measurement is
   * usable or merely early. So the sheet that owns the band answers it.
   */
  const bandDerivedRef = useRef(false)
  const dataRef = useRef(data)
  dataRef.current = data
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  /**
   * D16 — cell formulas on a CHANNEL scope (#775), through the SAME hook master uses.
   *
   * 🔴 Imported, never copied. PES.2 moved this out of `sheet/master/` and widened it to the full
   * coordinate precisely so the two scopes cannot drift: one parse, one request body, one place a
   * coordinate can be fixed. A channel copy would have diverged the first time either of us touched
   * it — the same argument that put `IdentityBand` in the engine (#710).
   *
   * ⚠ `market` and `marketplace` carry the same value here and that is not redundancy: the route
   * takes `market` as the SHEET's market (it decides which column keys a `$ref` may name, #729) and
   * `marketplace` as the coordinate's half of `channel · marketplace`. Master sends a market and no
   * marketplace; a channel scope owes both, and the hook spreads one `coord` object so neither can
   * be half-sent.
   *
   * The ids are PRODUCT ids (`r.id`), not the grid's row ids (`rowIdOf`, which carries the alias):
   * a formula is stored per product · field · coordinate on the primary account/listing.
   * Alternate accounts and aliases do not own that formula. Deduped for the batch read.
   */
  const formulaRowIds = useMemo(() => rows.map(r => r.rowId), [rows])
  const formulaRowScopes = useMemo(() => Object.fromEntries(rows.map(r => [r.rowId, { productId: r.id, aliasKey: r.aliasId ?? '' }])), [rows])
  const formulas = useCellFormulas({
    productId,
    scope: 'channel',
    channel,
    marketplace,
    market: marketplace,
    locale: data?.scope.locale ?? locale ?? '',
    rowIds: formulaRowIds,
    rowScopes: formulaRowScopes,
    channelConnectionId: data?.scope.connectionId ?? accountId,
    onSettled: () => { void refresh(() => !tracker.hasUnconfirmedChanges && (getGridApi()?.getEditingCells().length ?? 0) === 0) },
    onValueSaved: (rowId, fieldKey, value) => {
      const node = getGridApi()?.getRowNode(rowId)
      if (!node?.data) return
      const cell = node.data.values?.[fieldKey]
      if (cell) node.data.values = { ...node.data.values, [fieldKey]: { ...cell, value } }
      getGridApi()?.refreshCells({ rowNodes: [node], columns: [fieldKey], force: true })
    },
  })

  /**
   * What a `$reference` can name on this row, WITH the value it currently holds.
   *
   * Built from THIS sheet's columns, so the list is exactly what the operator can see in front of
   * them. A typing aid and not a verdict: the server resolves against the full per-coordinate key
   * set and its `unknownRefs` overrides this the moment it answers. Deriving "unknown" from this
   * list alone would mark a good reference red because the sheet happens to be filtered — and this
   * scope filters far more aggressively than master does.
   */
  const candidatesFor = useCallback(
    (row: ChannelSheetRow): FormulaCandidate[] => {
      const cols = (dataRef.current?.columns ?? []).map((c) => {
        const v = row.values?.[c.key]?.value
        return {
          name: c.key,
          kind: 'field' as const,
          label: c.label,
          group: 'Columns',
          /* Absent rather than `''`: the editor draws no chip for a field with no value, and an
             empty chip and a missing one look identical while meaning different things. */
          value: v == null || v === '' ? undefined : String(v),
        }
      })
      const fns = formulas.functions.map((f) => ({
        name: f.name,
        kind: 'function' as const,
        label: f.name,
        group: 'Functions',
      }))
      return [...cols, ...fns]
    },
    [formulas],
  )

  /**
   * `$name` → the `colId` to outline in the same row while the formula is being edited.
   *
   * Read through the live `dataRef` rather than closing over `data`: the column model is built once
   * (see the note on `columnDefs`), so a version of this that captured the first render's columns
   * would outline nothing after the first load.
   */
  const colIdOfRef = useCallback(
    (name: string) => ((dataRef.current?.columns ?? []).some((c) => c.key === name) ? name : null),
    [],
  )

  /**
   * STABLE identity, live values — the shape the column model needs.
   *
   * 🔴 `[]` deps on purpose. `columnDefs` builds 97 definitions and AG rebuilds its column model
   * whenever their identity changes, which loses column state mid-edit
   * ([[reference_ag_react_inline_options_rerun_column_model]]). A wiring object that changed on
   * every formula load would do exactly that. The ref keeps the VALUES current while the object
   * the defs captured stays the same one — master's `formulaLive` pattern, deliberately identical.
   */
  const formulaLive = useRef({ candidatesFor, colIdOfRef, formulas, alternateAccount })
  formulaLive.current = { candidatesFor, colIdOfRef, formulas, alternateAccount }
  /* #780 — one identity-stable reader, handed to both the class rules and the renderer.
     🔴 DECLARED HERE, ABOVE `columnDefs`, AND THAT POSITION IS LOAD-BEARING. It was first written
     next to the other cell handlers ~500 lines below, where `columnDefs` uses it — a `const` in the
     temporal dead zone. The whole CHANNEL SCOPE threw `Cannot access 'refusedReasonFor' before
     initialization` and rendered no rows at all; the sheet did not degrade, it disappeared behind
     the error boundary. Caught by the gate, which reported every Amazon·IT row as "no rows
     rendered" while master stayed green — a scope-shaped failure is the tell. */
  /**
   * 🔴 REPAINT WHEN THE FORMULA BATCH LANDS. This scope had no such effect at all: the batch
   * resolves after first paint, changes no prop AG watches, and nothing repaints — so a refusal
   * (and the ƒ mark before it) was correct and invisible here. Master has carried this since the ƒ
   * landed; the channel never got it, which is the "shared = exactly the same" drift again, found by
   * the gate rendering nothing on this scope while master rendered the mark.
   */
  useEffect(() => {
    const api = getGridApi()
    if (!api || api.isDestroyed()) return
    api.refreshCells({ force: true })
  }, [formulas.exprFor, formulas.errorFor])

  /**
   * 🔴 KEYED ON `row.id`, THE BARE PRODUCT ID — NOT `row.rowId`.
   *
   * `rowId` is this scope's GRID identity and it is deliberately different: `id` is not unique here,
   * because the same child SKU under three aliases is three rows (types.ts:323). The formula map is
   * built from `rows.map(r => r.id)` and keyed by the server on `productId`, and the ƒ path already
   * passes `(r) => r.id` into `formulaCellEditorSelector` — correctly. I mirrored the neighbouring
   * call and passed `rowId` instead, so every lookup missed and the classifier received no reason at
   * all: `pinned` with an empty mark, which is exactly what it returns when asked about nothing.
   * A prefixed key against a bare-keyed map is a miss that looks like an absence.
   */
  const refusedReasonFor = useCallback(
    (productId: string, fieldKey: string) => formulaLive.current.formulas.errorFor(productId, fieldKey),
    [],
  )

  const formulaWiring = useMemo<FormulaWiring<ChannelSheetRow>>(
    () => ({
      canEditRow: () => true,
      candidatesFor: (row) => formulaLive.current.candidatesFor(row),
      preview: (rowId, fieldKey, expr, signal) => formulaLive.current.formulas.preview(rowId, fieldKey, expr, signal),
      functions: () => formulaLive.current.formulas.functions,
      replaceFormula: (rowId: string, fieldKey: string, value: unknown) => formulaLive.current.formulas.replace(rowId, fieldKey, value),
      unavailableReason: () => formulaLive.current.formulas.loadError ?? (formulaLive.current.formulas.ready ? null : 'Loading formulas…'),
      retry: () => formulaLive.current.formulas.reload(),
      sourceLabel: () => formulaLive.current.formulas.sourceLabel,
      exprFor: (rowId, fieldKey) => formulaLive.current.formulas.exprFor(rowId, fieldKey),
      /* #780 — same ref-read as `exprFor`; the refusal lands with the formula batch, after paint. */
      errorFor: (rowId, fieldKey) => formulaLive.current.formulas.errorFor(rowId, fieldKey),
      colIdOfRef: (name) => formulaLive.current.colIdOfRef(name),
    }),
    [],
  )
  const formulaClipboard = useMemo(() => formulaTransfer<ChannelSheetRow>({
    exprFor: (row, key) => formulaWiring.exprFor(row.rowId, key),
    canEditRow: formulaWiring.canEditRow,
  }), [formulaWiring])


  /**
   * Every write goes through PES.2's `SheetWriter` (hub ruling #11), never a lane-built save.
   *
   * It owns the three things a per-cell call cannot survive on a sheet: it advances the row VERSION
   * from the server's `currentVersion` (a lane save that keeps re-sending the version it first read
   * has its own second edit refused 409), it coalesces a fill or a paste into one request per row,
   * and it serialises a row against itself. `commit` is this lane's only job — it knows the endpoint,
   * the writer does not.
   */
  const unsettledWrites = useRef(new Map<string, { writeId: string; subject: string }>())
  const writerRef = useRef<SheetWriter<ChannelSheetRow> | null>(null)
  if (writerRef.current === null) {
    writerRef.current = new SheetWriter<ChannelSheetRow>({
      tracker,
      getApi: getGridApi,
      commit: async (req: SheetWriteRequest<ChannelSheetRow>) => {
        /**
         * #699 — the header counts failures per SUBJECT, and this scope was passing none.
         *
         * Without a subject every attempt is its own failure: a row refused, edited and saved left
         * the earlier refusal in the count for ever, so the header read "2 changes not saved" for
         * one row with nothing unsaved. `channelWriteIdentity` is the pure half, so the convention
         * is testable — this closure is not reachable from the node suite.
         */
        const { writeId, subject } = channelWriteIdentity(req.rowId, ++writeSeq.current, { channel, marketplace, accountId, locale, instanceId: writeInstanceId })
        reporterRef.current.pending(writeId, subject)
        const result = await commitChannelRow(req, { channel, marketplace, accountId, locale })
        // The server's own words on failure, verbatim — the header shows them unedited.
        if (result.unreachable) unsettledWrites.current.set(req.rowId, { writeId, subject })
        else reporterRef.current.resolved(writeId, result.ok, result.reason, subject)
        return result
      },
      onConflict: () => {}, // Keep the refused edit visible until the operator reviews Reload.
      readBack: async (request) => {
        const response = await fetch(channelScopeUrl({ productId, channel, marketplace, accountId, locale }), { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(30_000) })
        if (!response.ok) return null
        return recoverSheetRow(await response.json(), request, { channel, market: marketplace, accountId, locale })
      },
      onReconciled: ({ rowId, ok, savedAt }) => {
        const { writeId, subject } = channelWriteIdentity(rowId, ++writeSeq.current, { channel, marketplace, accountId, locale, instanceId: writeInstanceId })
        const held = unsettledWrites.current.get(rowId)
        ok = ok && !Object.keys(rowsRef.current.find(row => row.rowId === rowId)?.values ?? {}).some(key => tracker.get(rowId, key)?.state === 'refused')
        reporterRef.current.resolved(held?.writeId ?? writeId, ok, ok ? undefined : 'Review the highlighted edits against the stored values.', held?.subject ?? subject)
        unsettledWrites.current.delete(rowId)
        if (ok) { setLastSavedAt(savedAt); void refreshRef.current(() => writerRef.current?.pending === 0 && !tracker.hasUnconfirmedChanges && (getGridApi()?.getEditingCells().length ?? 0) === 0) }
      },
      /**
       * 🔴 ONLY A SUCCESS STAMPS THE CLOCK (#700, found on screen).
       *
       * `onSettled` fires after EVERY settled batch, refusals included (`sheetWriter.ts:371` passes
       * `ok`), and this ignored it — so a refused write put "Saved 15:21" in the footer while the
       * header beside it said "1 change not saved" and the cell was outlined red. Two statements
       * about the same write, one of them false, on the line an operator checks before closing the
       * tab. Screenshot taken before the fix, at 15:21.
       */
      onSettled: ({ ok, savedAt }) => {
        if (!ok) return
        setLastSavedAt(savedAt)
        if (writerRef.current?.pending !== 0) return
        const savedSequence = writeSeq.current
        void refreshRef.current(() =>
          writeSeq.current === savedSequence && writerRef.current?.pending === 0 &&
          !tracker.hasUnconfirmedChanges &&
          (getGridApi()?.getEditingCells().length ?? 0) === 0,
        )
      },
    })
  }
  const writer = writerRef.current

  /**
   * Clean the writer up on unmount — WITHOUT the StrictMode trap that killed master's autosave
   * (#572).
   *
   * `arm()` goes in the effect BODY, not just `destroy()` in the cleanup. StrictMode mounts, runs
   * the cleanup, and mounts again; a writer that only ever sets `destroyed = true` in its cleanup
   * would then be destroyed for the life of the page, and every `set()` would return on its first
   * line. On master that showed as autosave silently dead: the cell displayed the typed value
   * because AG updates its own data, and only the SAVE was gone.
   *
   * This sheet held its writer in a ref and never destroyed it, so it was never bitten — but it
   * also never cleaned up. The pair fixes the leak without reintroducing the bug: `destroy()`
   * best-effort FLUSHES queued cells rather than dropping them, so an operator's last edit still
   * leaves on unmount, and `arm()` clears only the flag, so queues, versions and rows survive the
   * destroy/arm pair a second mount performs.
   *
   * `[writer]` rather than `[]`: the ref is stable, so it runs once, but the dep names what the
   * effect actually operates on instead of asserting an emptiness the code does not depend on.
   */
  useEffect(() => {
    writer.arm()
    return () => writer.destroy()
  }, [writer])

  // Tell the writer what the server last said about each row's version. Seeding is monotonic, so a
  // refetch that resolves after a save cannot walk the version backwards.
  useEffect(() => {
    if (!data) return
    writer.seed(rows.map((r) => ({ id: r.rowId, version: r.version, row: r })))
  }, [data, rows, writer])

  useEffect(() => {
    const unsubscribe = writer.subscribe(() => {
      setSaving(writer.busy)
      setPending(writer.pending)
      setOffline(writer.unreachable ?? false)
      refreshCountsRef.current()
    })
    return unsubscribe
  }, [writer])

  /**
   * Recount refusals from the tracker rather than incrementing a counter: a cell edited again after
   * a refusal clears its own mark, and a counter that only goes up would keep reporting a failure
   * the operator has already fixed.
   */
  const refreshCounts = useCallback(() => {
    if (!data) return
    let n = 0
    const ids = new Set<string>()
    for (const row of rows) {
      for (const col of data.columns) {
        if (tracker.get(row.rowId, col.key)?.state === 'refused') {
          n++
          ids.add(row.rowId)
        }
      }
    }
    setRefused(n)
    setRefusedRowIds(ids)
  }, [data, rows, tracker])
  const refreshCountsRef = useRef(refreshCounts)
  refreshCountsRef.current = refreshCounts

  const reloadConfirm = useActionConfirm()
  const onReload = useCallback(async () => {
    const impact = reloadImpact({ pending: writer.pending, refused, unknown: writer.unknownCount })
    if (impact && !(await reloadConfirm.ask(impact))) return
    reporterRef.current.cleared(rows.map(row => channelWriteIdentity(row.rowId, 0, { channel, marketplace, accountId, locale, instanceId: writeInstanceId }).subject))
    writer.discard()
    reload()
  }, [writer, refused, rows, channel, marketplace, accountId, locale, writeInstanceId, reload, reloadConfirm.ask])

  const aliasLabel = useCallback(
    (aliasId: string | null) =>
      data?.aliases.find((a) => aliasKeyOf(a.id) === aliasKeyOf(aliasId))?.label ?? 'Primary',
    [data],
  )

  /**
   * A click on a cell's mark pins or resets it. Both change which LAYER supplies the cell, and only
   * the server knows what a reset falls back to — so the page refetches rather than painting a
   * guess. A provenance badge that is wrong for even a moment teaches an operator to stop trusting
   * the glyph.
   */
  const listResetConfirm = useActionConfirm()
  const onCascade = useCallback(
    async (row: ChannelSheetRow, cell: StudioCellValue, intent: CascadeIntent) => {
      // Only a channel-routed, writable cell may pin or reset. A master-routed cell can SHOW
      // `follows` but must never offer an un-pin: acting on it would rewrite every channel (#58).
      if (!offersCascade(cell)) return
      const colKey = Object.keys(row.values).find((k) => row.values[k] === cell) ?? cell.writeField
      if (intent.action === 'reset' && wholeListWriteField(cell.writeField)) {
        // Save earlier edits before presenting the list being replaced. The row's listing version
        // still guards a change from another editor while the confirmation is open.
        await writer.flush()
        const base = wholeListWriteField(cell.writeField)!
        const slots = (data?.columns ?? []).filter(col => wholeListWriteField(row.values[col.key]?.writeField ?? '') === base)
        const followsMaster = !!cell.mapped?.sourcePath && !cell.mapped.usesExpression
        const confirmed = await listResetConfirm.ask({ level: 'confirm', title: followsMaster ? 'Follow Master for the whole list?' : 'Remove the whole list’s override?',
          consequences: [
            `Remove the override for all ${slots.length} positions in this list for ${row.sku} on ${channel} · ${marketplace}, ${aliasLabel(row.aliasId)}.`,
            followsMaster ? 'Future Master changes will flow through its channel mapping.' : 'The list will use its configured mapping or default. It may become empty if no source is configured.',
            'Current values being replaced:',
            ...slots.map(col => `${col.label}: ${String(row.values[col.key]?.value ?? 'Empty')}`),
          ] })
        if (!confirmed) return
        writer.set(row.rowId, colKey, null, { row, intent: 'reset-list' })
        return
      }
      writer.set(row.rowId, colKey, intent.value, { row, intent: intent.action })
    },
    [writer, data, channel, marketplace, aliasLabel, listResetConfirm.ask],
  )

  /**
   * 🔴 The `affectsAllChannels` acknowledgement (ruling #58, BINDING).
   *
   * 399 of 441 cells on eBay·IT route to MASTER, because `PATCH /api/products/bulk` has
   * channel-specific routes for only six field names. An operator editing on a channel scope
   * reasonably assumes the edit is scoped to that channel; without this it would silently rewrite
   * the value for every channel.
   *
   * Asked ONCE per coordinate rather than per cell: a modal on every keystroke in a 102-column
   * sheet is one an operator learns to dismiss without reading, which is worse than not asking.
   * Until it is acknowledged the write does not leave the browser — the pending edit is held, and
   * declining reverts the cell rather than leaving a value on screen the server never received.
   */
  const [pendingMasterWrite, setPendingMasterWrite] = useState<
    { rowId: string; colId: string; value: unknown; row: ChannelSheetRow; previous: unknown } | null
  >(null)
  const acknowledgedRef = useRef(false)
  /**
   * 🔴 True while THIS component is putting a declined value back.
   *
   * `setDataValue` fires `cellValueChanged` again, and AG does not mark it `source: 'data'` — so
   * without this flag the revert re-enters the handler, sees `affectsAllChannels` again and
   * re-arms the very bar the operator just dismissed. Measured on screen: Cancel reverted the cell
   * correctly and sent nothing, but the bar came straight back for the same field, leaving no way
   * out but navigating away. The deny-list guard cannot catch this one; only the component knows
   * that this particular change is its own undo.
   */
  const revertingRef = useRef(false)
  useEffect(() => {
    // A new coordinate is a new promise to the operator — ask again.
    acknowledgedRef.current = false
    setPendingMasterWrite(null)
  }, [channel, marketplace])

  /** A typed edit is the same write as a pinned one: typing into a cell pins it at this row's layer. */
  const onCellValueChanged = useCallback(
    (e: { data?: ChannelSheetRow; colDef: { colId?: string }; newValue: unknown; source?: string; oldValue?: unknown }) => {
      const colId = e.colDef.colId
      if (!e.data || !colId) return
      /**
       * 🔴 `source: 'data'` is NOT an operator edit — it is the grid's own data being set — and
       * saving it would write the sheet back to the server every time it repopulates. This lane
       * refetches after every cascade pin/reset, so without this guard each of those refetches
       * would fire a write per cell and the sheet would talk to itself.
       *
       * DENY-listed, not allow-listed, and that asymmetry is deliberate (PES.2's guard, adopted
       * verbatim per ruling #53): AG types `source` as `string | undefined` with only EXAMPLES
       * documented, so an allow-list silently drops any edit source I failed to predict — and an
       * edit that shows on screen but never reaches the server is precisely the dishonesty this
       * sheet exists to prevent. Saving one source too many is the cheaper mistake.
       *
       * It also means undo/redo need no code: AG fires this event with `'undo'`/`'redo'`, so an
       * undone cell travels the same writer, batching and version path as the edit before it.
       */
      const gate = channelWriteGate({
        colId,
        source: e.source,
        selfInflicted: revertingRef.current,
        cell: e.data.values?.[colId],
        acknowledged: acknowledgedRef.current,
      })
      if (gate === 'ignore' || gate === 'blocked') return
      if (gate === 'acknowledge') {
        setPendingMasterWrite({
          rowId: e.data.rowId,
          colId,
          value: e.newValue,
          row: e.data,
          previous: (e as { oldValue?: unknown }).oldValue,
        })
        return
      }
      /**
       * 🔴 D16 — a FORMULA is not a value, and this is the line that keeps it from becoming one.
       *
       * Master's rule, mirrored here because the hazard is WORSE on this scope, not merely equal:
       * a channel write merges into `overrideData`, and `attribute-resolver.ts` reads that bag as a
       * value layer — so the characters `="a" + $brand` stored here would resolve as the cell's
       * value and PUBLISH to Amazon, with preflight calling it valid. On master the same mistake
       * stays inside the PIM until something syndicates it.
       *
       * The leading `=` is stripped by `exprOf`: `=` is a real equality operator in this language,
       * and a stored expr that keeps it parses as a comparison against nothing (the route refuses
       * one). `row.id` is the PRODUCT id, not `rowId` — formulas are keyed per product · field ·
       * coordinate, while the writer is keyed per grid row.
       */
      const shopifyValue = !!data?.columns.find(column => column.key === colId)?.shopifyField
      if (!shopifyValue && !formulas.ready) {
        const reason = formulas.loadError ?? 'Formulas are still loading. Retry this edit once they are ready.'
        tracker.set(e.data.rowId, colId, 'refused', reason)
        const { writeId, subject } = channelWriteIdentity(e.data.rowId, ++writeSeq.current, { channel, marketplace, accountId, locale, instanceId: writeInstanceId })
        reporterRef.current.pending(writeId, subject); reporterRef.current.resolved(writeId, false, reason, subject)
        return
      }
      const typed = typeof e.newValue === 'string' ? e.newValue : null
      if (!shopifyValue && ((typed !== null && isFormulaDraft(typed)) || formulas.exprFor(e.data.rowId, colId!))) {
        /* Captured, not read off `e` inside the callbacks below. `e.data` is a mutable property, so
           the narrowing from the guard at the top of this handler does not survive into a `.then` —
           and the row object is exactly what the refusal branch has to mutate. Holding the reference
           also means a re-read that replaces the sheet cannot swap the row out from under a save
           that is still in flight. */
        const row = e.data
        /* Put the DISPLAYED value back at once (ruled #763): AG's valueSetter has already written
           the expression into the row — that mutation is what makes this event fire — so left alone
           the cell renders `=upper($brand)` as though it were the value. At rest a formula cell
           shows the engine's OUTPUT with the `ƒ` mark; the text belongs to the editor. */
        const prev = row.values?.[colId]
        if (prev) {
          row.values = { ...row.values, [colId]: { ...prev, value: e.oldValue } }
          const node = getGridApi()?.getRowNode(rowIdOf(row))
          if (node) getGridApi()?.refreshCells({ force: true, rowNodes: [node], columns: [colId] })
        }

        const { writeId, subject } = channelWriteIdentity(row.rowId, ++writeSeq.current, { channel, marketplace, accountId, locale, instanceId: writeInstanceId })
        reporterRef.current.pending(writeId, subject)
        void (typed !== null && isFormulaDraft(typed) ? formulas.save(row.rowId, colId, exprOf(typed)) : formulas.replace(row.rowId, colId, e.newValue))
          .then((r) => {
            reporterRef.current.resolved(writeId, r.ok, r.error, subject)
            tracker.set(row.rowId, colId, r.ok ? 'saved' : 'refused', r.error)
            /* A REFUSED formula stays in the cell so it can be corrected (Owner, #775). Putting the
               old value back is right while the save is in flight and right when it succeeds; it is
               wrong on a refusal, where the operator would have to retype an expression to fix one
               character. The cell carries the refusal and its reason, which is what distinguishes it
               from a value — the never-revert rule is about a rejected VALUE, and a formula was
               never one.

               ⚠ `formulaWritable` is a COLUMN condition and the channel writer also refuses per ROW
               (no listing on this coordinate), so a refusal here is reachable on a cell the gate
               correctly let through. That is the case this branch exists for. */
            if (!r.ok) {
              const cell = row.values?.[colId]
              if (cell) {
                row.values = { ...row.values, [colId]: { ...cell, value: e.newValue } }
                const n = getGridApi()?.getRowNode(rowIdOf(row))
                if (n) getGridApi()?.refreshCells({ force: true, rowNodes: [n], columns: [colId] })
              }
            }
            /* The value layer moved server-side and nothing here knows the new value — a formula row
               caches no result by design — so the only honest way to show what it produced is to
               re-read. */
            // The formula queue refreshes once after the whole edit batch settles.
          })
          .catch((err: unknown) => {
            const reason = err instanceof Error ? err.message : String(err)
            tracker.set(row.rowId, colId, 'unknown', `Could not confirm this save. Refresh to check: ${reason}`)
            reporterRef.current.resolved(writeId, false, reason, subject)
          })
        return
      }
      // A typed edit pins the cell at this row's layer — `set` is the substrate's default.
      writer.set(e.data.rowId, colId, e.newValue, { row: e.data, intent: 'set' })
    },
    [writer, formulas, reload, channel, marketplace, accountId, locale, writeInstanceId],
  )

  /** Memoised: an inline factory would rebuild the column model every render. */
  const bandSpan = useMemo(
    () => bandColSpan<ChannelSheetRow>({ isBand: (d) => d?.rowKind === 'parent' }),
    [],
  )

  /**
   * #135 — the drawer's open affordance. `record.open` is the frame's URL-backed record state, the
   * same door the master sheet uses; without this the drawer was mounted and resolvable but had no
   * way in, so on a channel scope it did not exist for an operator.
   */
  const record = useStudioRecord()
  // The frame's marketplace options — what this tenant actually sells on, for Compare's neighbourhood.
  /**
   * 🔴 There is deliberately NO `onRowDoubleClicked` here (#182, superseding my own interim).
   *
   * **Double-click EDITS, everywhere.** I had wired it to open the record drawer (#135) and the
   * gesture then did two things at once: AG opened the cell editor AND the drawer mounted, whose
   * re-flow of a horizontally scrolled grid moved the editor onto a DIFFERENT cell and row than the
   * one double-clicked. On a channel scope that is a write aimed at the wrong field, and it is why
   * the rule is now "opening the record is explicit only".
   *
   * The explicit paths remain: the `open-record` verb in the ⋯ menu and the row context menu, both
   * fed by the same `channelActions` declaration.
   */
  const auth = useAuth()
  const permission: PermissionState =
    auth.status === 'loading' ? 'checking'
    : auth.status === 'anon' ? 'no-session'
    : auth.has(CHANNEL_VERB_PERMISSION) ? 'granted'
    : 'denied'

  /**
   * ONE verb list, three surfaces (#110): the drawer's `RecordActions`, the row context menu and
   * the ⋯ column. Declared here rather than inline in the JSX because an inline object is a new
   * identity every render and re-runs AG's whole column model
   * (`reference_ag_react_inline_options_rerun_column_model`).
   */
  const verbs = useMemo(
    () =>
      data
        ? channelActions({
            accountSpecific: alternateAccount,
            channel,
            marketplace,
            scopeLabel: data.scope.label,
            aliases: data.aliases,
            // Derived, never assumed. `'no-session'` was hardcoded here from the measured local-dev
            // fact — which would have shipped every gated verb permanently disabled on prod, where
            // there IS a session. The four states map one-to-one onto the auth provider's own.
            permission,
            siblingMarkets: [],
            pickMarkets: async () => null,
            /**
             * 🔴 Opens WITH the focused column, not the row alone. `StudioDock` fires
             * `onRevealCell` only when `record.colKey` is set, so passing the row id by itself
             * leaves §5.4's reveal as dead code — the drawer lands on the very cell the operator
             * opened it from and nothing scrolls. The focused cell IS the one they acted on.
             */
            openRecord: (rowId: string) => record.open(rowId, lastDataCell.current ?? undefined),
            openRecordId: record.rowId,
          })
        : [],
    [data, channel, marketplace, permission, record.open, record.rowId, alternateAccount],
  )

  /**
   * 🔴 The sheet runs verbs, so the sheet MOUNTS THE CONFIRM (PES.2's #145, inherited rather than
   * rediscovered). A surface that offers a verb with a preflight but never renders
   * `confirmElement` leaves the verb awaiting an `ask()` whose dialog never appears: the promise
   * never settles, the menu closes, nothing happens, and there is no error anywhere. It is the
   * quietest possible failure, and both `pause-offer` and `broadcast-to-listings` have preflights.
   */
  const { press, problem, clearProblem, confirmElement } = useActionPress<ChannelSheetRow>()

  /**
   * PES.4 §5.4 — the drawer must not land on top of the cell that opened it.
   *
   * The RULE is PES.4's pure function; the SCROLL is this sheet's, because the panel is portalled
   * and holds no `GridApi` while the sheet does. The OVERLAP is measured here from the panel's real
   * box rather than taken from the dock (#457): the grip resizes the panel 380–720, so a hard 520
   * would be wrong in both directions — and under an inset the panel's width is not the overlap at
   * all.
   *
   * Matters more here than on master: this scope's field family is wide enough that the cell an
   * operator opened a record from is very often in the right-hand band the panel covers.
   */
  const revealNow = useCallback((colKey: string, intent: RevealIntent): boolean => {
    const api = getGridApi()
    /* On the SAME tape as the host's own decisions (#752). These two exits live on this side —
       `api.isDestroyed()` and a React ref are not the host's to see — and a trace that only starts
       after they pass is blind exactly where the cold deep link fails: before the grid exists. */
    if (!api || api.isDestroyed()) return traceRevealSkip(colKey, intent, 'no-api')
    const host = document.querySelector<HTMLElement>('.nds-grid-sheet .ag-root-wrapper')
    if (!host) return traceRevealSkip(colKey, intent, 'no-host')
    /**
     * 🔴 ONE host rule, in `_studio/drawer/revealHost.ts` — this was ~90 lines of inline copy and it
     * is gone (#752). Everything it encoded is still true and now true in one place: the panel's
     * RESTING left rather than its live rect, `panelReadiness`'s three states so "not measurable"
     * cannot collapse into "nothing covers it", the forwarded `intent`, and `=== 0` rather than
     * `<= 0`. Two copies of that rule is what made #748 fix one scope and leave the other.
     *
     * 🔴 `bandReady` is the sixth argument and PES.2 made it REQUIRED rather than defaulted, which
     * is the whole cause: the identity band mounts at `BAND_WIDTH_FLOOR` (240) and derives its real
     * width from content ~46ms later. A reveal replayed inside that window measured the cell against
     * a 240px pinned block, concluded "clear", and retired the stash as SERVED. The cell then
     * settled 164px further right (404 − 240) and sat covered by 24 — the unexplained 24 UX.1 and I
     * both measured, and the far column's "stops 148 short" is the same number less
     * `REVEAL_MARGIN`. A STALE measurement, not a missing one; from the outcome the two are
     * identical, which is why every instrument aimed at the panel came back ambiguous.
     */
    return revealColumn(api, host, colKey, intent, record.rowId != null, bandDerivedRef.current)
  }, [record.rowId])

  /**
   * Hold-until-ready, and replay ONCE — AG.1 (#286/#314), ported from the master sheet so the two
   * scopes behave identically.
   *
   * Measured on master and true here for the same reason: on a cold `?rec=…&cell=…` load `StudioDock`
   * fires the reveal about a second in, before `apiRef.current` exists, and because it dedupes per
   * opened cell it never fires again — the deep link silently reveals nothing. A fire that cannot be
   * served is stashed rather than dropped.
   *
   * 🔴 Replayed off `gridReady` STATE, not the api ref: a ref assignment triggers no render, so an
   * effect keyed on it never re-runs and the stash would sit there forever.
   */
  // 🔴 The INTENT is stashed with the coordinate. The cold `?rec=&cell=` load is the path that both
  // needs `'reveal'` and always defers — replaying with a defaulted `'uncover'` would lose exactly
  // the case #421 exists for, and silently, because the replay still "succeeds".
  const pendingReveal = useRef<RevealRequest | null>(null)
  const revealCell = useCallback(
    (colKey: string, intent: RevealIntent = 'uncover') => {
      pendingReveal.current = revealStash(pendingReveal.current, {
        kind: 'request',
        request: { colKey, intent },
        served: revealNow(colKey, intent),
      })
    },
    [revealNow],
  )
  /**
   * 🔴 THE REPLAY KEEPS AN UNSERVED REQUEST, and re-arms on the panel (#750) — a reversal of this
   * host's own "replay once, whether or not it succeeds".
   *
   * That policy was right while the only reason to defer was a missing grid, which `gridReady`
   * answers. It is wrong for the reason the cold `?rec=&cell=` load actually defers: the PANEL has
   * not mounted, and clearing the stash before the attempt meant the single retry — fired when the
   * grid became ready, which races the drawer — consumed the request and nothing tried again.
   *
   * `revealStash` is the shared policy, not a local `if`: master and this host cannot fix it twice
   * and differently. `'recordClosed'` below buys back the guarantee the old clear-first policy was
   * paying for — nothing replays into a drawer the operator has shut.
   *
   * The re-arm is a `MutationObserver` filtered to `data-resting-left`, over `document.body` because
   * the drawer is not in the DOM yet to be watched — not a timer (#744), and no grid cell carries
   * that attribute so a virtualising sheet cannot wake it.
   */
  useEffect(() => {
    if (!gridReady || !data) return
    const replay = () => {
      const p = pendingReveal.current
      if (!p) return
      pendingReveal.current = revealStash(p, { kind: 'replay', served: revealNow(p.colKey, p.intent) })
    }
    replay()
    if (!pendingReveal.current) return
    const obs = new MutationObserver(() => {
      replay()
      if (!pendingReveal.current) obs.disconnect()
    })
    obs.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-resting-left'] })
    /* 🔴 The panel is not the only thing a stashed reveal waits for (#752). The band's derived width
       arrives as a COLUMN change, and asking for a width is not the width changing — PES.2 measured
       a synchronous replay still reading the old `viewportLeft` 124ms after `setColumnWidths`. So
       the replay rides AG's own events for it rather than a timer or a hopeful `rAF`. */
    const api = getGridApi()
    api?.addEventListener?.('displayedColumnsChanged', replay)
    api?.addEventListener?.('columnResized', replay)
    return () => {
      obs.disconnect()
      if (api && !api.isDestroyed()) {
        api.removeEventListener('displayedColumnsChanged', replay)
        api.removeEventListener('columnResized', replay)
      }
    }
  }, [gridReady, data, revealNow])

  /* A reveal belongs to the record that asked for it: without this the surviving stash could replay
     into a closed drawer on the next `data-resting-left` write — a resize, or the next record. */
  useEffect(() => {
    if (record.rowId == null) pendingReveal.current = revealStash(pendingReveal.current, { kind: 'recordClosed' })
  }, [record.rowId])

  /** A band row is a group header, not a record — no verbs rather than verbs acting on a non-id. */
  const isRecordRow = useCallback((r: ChannelSheetRow) => r.rowKind === 'variant', [])

  const menuItems = useMemo(
    () => actionMenuItems<ChannelSheetRow>({ actions: verbs, onSelect: press, isRecord: isRecordRow }),
    [verbs, press, isRecordRow],
  )
  // Build explanations only when requested; ordinary pointer movement does no cell validation or popup work.
  const openCellDetails = useCallback((row: ChannelSheetRow, column: SheetColumn) => {
    const cell = row.values[column.key]
    const value = cell?.value
    const formulaReason = refusedReasonFor(row.rowId, column.key)
    const source = describeValueSource(cell, classifyProvenance({ ...withMappingRun(cell, data?.meta?.mapping?.productLevelOnly ?? false), refusedReason: formulaReason }, 'channel'), formulaReason)
    const layer = cascadeOf(cell, row.rowKind)
    const intent = cell && offersCascade(cell) && cell.editable && layer !== 'unset' && !['formula', 'warning', 'ai'].includes(source.kind)
      ? cascadeIntent(layer, row.rowKind, value ?? null) : null
    setCellDetails({
      title: `${column.label}: ${row.sku}`,
      rowId: row.rowId,
      colKey: column.key,
      action: intent && cell ? {
        label: intent.action === 'pin' ? 'Keep as listing override' : wholeListWriteField(cell.writeField) ? 'Review removing list override…' : 'Remove listing override',
        description: intent.action === 'pin'
          ? `Keep the current value for ${row.sku} · ${aliasLabel(row.aliasId)} on this channel and market.`
          : `Remove this ${wholeListWriteField(cell.writeField) ? 'whole list’s' : 'listing'} override and ${resetSourceLabel(cell)}.`,
        run: () => { void onCascade(row, cell, intent) },
      } : undefined,
      value: value == null || value === '' ? 'Empty' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value),
      notes: composeCellTooltip(
        tracker.get(row.rowId, column.key)?.reason,
        channelValidation(column).validate(value, row, column.key).message,
        cell?.mapped?.errors.join('\n'),
        cell?.mapped?.warnings.join('\n'),
        `${source.label}. ${source.description}`,
        column.kind === 'longtext' ? longTextTooltipLine(value, column) : null,
        shapeTooltipLine(column, value),
        referenceTooltip(value, column.optionLabels),
        cellHoverNote(cell, data?.scope.label ?? ''),
        column.helpText,
      ),
    })
  }, [data, tracker, refusedReasonFor, onCascade, aliasLabel])
  const closeCellDetails = useCallback(() => {
    const previous = cellDetails
    setCellDetails(null)
    if (previous) requestAnimationFrame(() => {
      const api = getGridApi(), node = api?.getRowNode(previous.rowId)
      if (node?.rowIndex != null) api?.setFocusedCell(node.rowIndex, previous.colKey)
    })
  }, [cellDetails, getGridApi])
  const contextMenu = useMemo(() => {
    const actions = actionContextMenu<ChannelSheetRow>({ actions: verbs, onSelect: press, isRecord: isRecordRow })
    return (params: GetContextMenuItemsParams<ChannelSheetRow>) => {
      const items = actions(params)
      const row = params.node?.data
      const column = data?.columns.find(c => c.key === params.column?.getColId())
      if (row && column) items.unshift({ name: 'Cell details…', action: () => openCellDetails(row, column) })
      const mapping = data && column?.channels?.[data.scope.label]
      const field = mapping?.key ?? mapping?.attribute
      if (!row || !field) return items
      const supplyingRule = column && row.values[column.key]?.mapped?.supplyingRule
      return [{ name: 'Open reusable mapping for this field', tooltip: 'This rule can affect other matching products. Opens separately to preserve your edits.',
        action: () => window.open(supplyingRule?.href ?? mappingHref({ channel, market: marketplace, category: row.productType, field, productId: row.id }), '_blank', 'noopener') }, ...items]
    }
  }, [verbs, press, isRecordRow, data, channel, marketplace, openCellDetails])

  /** Whether THIS mapping run was product-grain — a fact about the run, supplied to every cell. */
  const productLevelOnly = data?.meta?.mapping?.productLevelOnly ?? false

  /**
   * Does EVERY variant on this sheet carry axis values? See the identity renderer for why it is
   * all-or-nothing: a second line that appears on 2 rows of 20 is a ragged column, not information.
   */
  const familyShowsAxes = useMemo(() => {
    const variants = rows.filter((r) => r.rowKind === 'variant')
    return variants.length > 0 && variants.every((r) => Object.keys(r.axisValues ?? {}).length > 0)
  }, [rows])

  /**
   * The context BOTH view rules read: `defaultViewColumns` (what is VISIBLE) and `orderColumnKeys`
   * (what ORDER the grid renders in). One object rather than two literals, because they are two
   * questions asked of the same context and a second copy is exactly how they would come to
   * disagree about which columns are this family's axes.
   */
  const viewCtx = useMemo(
    () => ({
      variationAxes: data?.family?.variationAxes ?? [],
      locale: data?.scope.locale ?? locale ?? '',
      flaggedKeys: flaggedColumnKeys(rows),
      requiredKeys: [...new Set(rows.flatMap(row => Object.entries(row.values).filter(([, cell]) => cell.mapped?.requiredByRule).map(([key]) => key)))],
    }),
    [data, rows, locale],
  )

  /**
   * The columns this sheet BUILDS: the contract minus `RESERVED_COLUMN_IDS` — exactly master's rule
   * (`sku` is the identity band's key line on both scopes, not a column). Every grid-facing site
   * reads THIS, never `data.columns`, so the two cannot disagree about what a column is.
   */
  const shopifyEditor = useShopifyDraftCell(shopifySchema, getGridApi)
  const mediaEditor = useProductMediaEditor(() => { void refresh(() => !tracker.hasUnconfirmedChanges && (getGridApi()?.getEditingCells().length ?? 0) === 0) }, data?.scope.locale ?? locale)
  const mediaClipboard = useMemo(() => mediaGridTransfer(formulaClipboard, mediaEditor.actions), [formulaClipboard, mediaEditor.actions])
  const gridColumns = useMemo(() => withProductMediaColumn(data?.columns ?? []).filter((col) => !RESERVED_COLUMN_IDS.includes(col.key as never)), [data])

  const columnDefs = useMemo<ColDef<ChannelSheetRow>[]>(() => {
    if (!data) return []


    /**
     * ⚠ There is deliberately NO stock/quantity column synthesised here.
     *
     * PES.5 §3.2: "Quantity is per alias, never summed … The contract carries no 'total quantity'
     * field precisely so no client can invent one"
     * (reference_oversell_is_per_channel_not_summed). Quantity reaches this sheet the same way every
     * other channel field does — as the channel's own qty COLUMN in `data.columns`, one cell per
     * alias × row, resolved and written through the same cascade. A column assembled here from row
     * data would be exactly the invented total the contract refuses to ship.
     */

    const fields: ColDef<ChannelSheetRow>[] = gridColumns.map((col) => ({
      colId: col.key,
      /* The base cell class master's every cell carries — FIRST, so the number kind's `numericColumn`
         and the select kind below compose on top of it rather than lose it (2026-09-04: the class
         SETS differed by exactly this token on every kind). */
      cellClass: 'nds-ag-cell',
      headerName: col.label,
      headerTooltip: col.helpText ?? `${col.label} — ${col.group}`,
      width: col.width ?? 180,
      /* 🔴 SAME AS MASTER, and it was not: this scope never set `suppressKeyboardEvent`, so Tab
         inside a formula's completion panel MOVED CELLS here while it accepted a completion on
         master. `suppressFormulaKeys` is the engine's one rule (Tab suppressed only while a panel
         is open); the sheet only hands it to AG. Found by a cross-scope audit, not a report —
         nobody types a formula on two scopes in one sitting. */
      suppressKeyboardEvent: suppressFormulaKeys,
      /* The column filter with its floating input — master's, and the reason master's header was
         57px to this scope's 29px until 2026-09-04: this scope had no filters at all. */
      /**
       * 🔴 Long text edits in a BOX, on this scope too (#293).
       *
       * This sheet set no `cellEditor` at all, so every field fell to AG's default inline input.
       * SR.1 measured the cost on the same row and build: `item_name` (127 chars) opens at
       * **460×126 with all 127 visible on master**, and at **158×25 showing the last ~23** here —
       * the sheet whose entire purpose is tuning a market's copy had the worse editor for copy.
       *
       * `longTextEditor()` is PES.2's factory, spread exactly as `master/columns.tsx:279` does, and
       * the `Math.max(maxLength, 200)` floor comes with it rather than being re-derived. No
       * invented cap: an absent `maxLength` sends no attribute, because `agLargeTextCellEditor`
       * hands it to a real `<textarea>` that the BROWSER enforces — a default there stops an
       * operator typing at a limit no channel asked for.
       *
       * ⚠ Spread BEFORE `editable`: the factory sets `editable: true`, and letting that land last
       * would override the per-cell server answer below and make a `writable: false` alias row
       * editable.
       */
      /**
       * 🔴 Closed lists get the SAME dropdown as master (#669/D18/D11).
       *
       * This branch handled `longtext` and nothing else, so all 24 `select` columns on Amazon·IT —
       * `country_of_origin` (268 options), `status`, the marketplace's own lists — fell to AG's
       * default inline text input: free typing into a closed list, on the scope the Owner uses
       * most. D18 shipped on master only, and the acceptance was measured there.
       *
       * `selectEditor` is the DS factory, spread exactly as `master/columns.tsx:255` spreads it,
       * and options are built from the CONTRACT (`col.options` + `col.optionLabels`), never a list
       * kept here. `cellEditorPopup: true` comes with the factory.
       */
      ...(col.kind === 'longtext'
        ? longTextEditor(col.maxLength ? { maxLength: Math.max(col.maxLength, 200) } : {})
        : col.kind === 'select'
          ? selectEditor((col.options ?? []).map((o) => ({ value: o, label: col.optionLabels?.[o] ?? o })))
          : col.kind === 'boolean'
            ? selectEditor(BOOLEAN_OPTIONS)
            : col.kind === 'number'
              ? { ...numericColumn, cellEditor: 'agNumberCellEditor', cellEditorParams: SHEET_NUMBER_EDITOR_PARAMS }
              : {}),
      /**
       * D16 — `=` opens the formula editor, through the ENGINE's selector (#775).
       *
       * 🔴 ONE selector, not a channel copy. What it holds is policy — which editor a cell opens,
       * when a stored formula overrides the gate, what a refused column falls back to — and a copy
       * per sheet means the first person to fix one of those fixes it on one scope. PES.2 hoisted it
       * out of `master/columns.tsx` on this request; both scopes now call the same function and the
       * rules underneath it (`formulaEditorChoice`) are pure and tested.
       *
       * ⚠ The `rowIdOf` passed here is `(r) => r.id`, the PRODUCT id — NOT this module's `rowIdOf`,
       * which is alias-qualified for the grid. A formula is stored per product · field · coordinate,
       * so the alias-qualified id would look up a formula that cannot exist and every formula cell
       * would open empty.
       *
       * The fallback is whatever the column would have opened without a formula, so a cell the gate
       * refuses is not left without an editor — it simply opens its ordinary one, and the tooltip
       * says why.
       */
      /* AM.1 §A.3 rows 3–4 — the engine's shape definition, spread AFTER the kind spreads so its
         editor, formatter, parser and equality win over the scalar defaults for a list or a measure. */
      ...shapeColumnDef<ChannelSheetRow>(col, (d) => d.values?.[col.key]?.value),
      ...formulaCellEditorSelector<ChannelSheetRow>(
        formulaWiring,
        col,
        (row) => {
          const scoped = columnForCategory(col, data?.scope.label ?? '', row?.productType ?? null)
          const colForRow = scoped
          if (Array.isArray(colForRow.validation?.recordFields)) return { component: StructuredAttributeEditor, popup: true, params: { attributeColumn: colForRow } }
          return (data?.scope.channel === 'EBAY' && colForRow.key === 'categoryId' || data?.scope.channel === 'AMAZON' && colForRow.key === 'productType' || data?.scope.channel === 'ETSY' && colForRow.key === 'taxonomy_id')
          ? { component: ChannelCategoryEditor, popup: true, params: { channel: data.scope.channel, market: data.scope.marketplace, accountId: data.scope.connectionId ?? accountId } }
          : data?.scope.channel === 'EBAY' && isEbayPolicyField(colForRow.key)
          ? { component: EbayPolicyEditor, popup: true, params: { fieldKey: colForRow.key, market: data.scope.marketplace, connectionId: data.scope.connectionId ?? accountId } }
          : isReferenceField(colForRow.key)
          ? { component: ReferenceSelectEditor, popup: true, params: { fieldKey: colForRow.key, market: data?.scope.marketplace, productType: row?.productType, connectionId: data?.scope.connectionId ?? accountId } }
          : colForRow.shape === 'list' || colForRow.shape === 'measure'
          ? shapeEditorSpec(colForRow)!
          : colForRow.kind === 'longtext'
          ? {
              component: 'agLargeTextCellEditor',
              popup: true,
              /* No `rows`/`cols` here: selector params merge LAST (`mergeParams`, main.esm.mjs:3102)
                 and a constant 8×60 silently overrode the per-cell size `longTextEditor()` computes
                 — the same 488×158 the sizing rule exists to remove, back through a second door.
                 The size is the ColDef's; the selector only names the component. */
              params: { ...(colForRow.maxLength ? { maxLength: Math.max(colForRow.maxLength, 200) } : {}) },
            }
          : colForRow.kind === 'select'
            ? {
                component: SelectPanelEditor,
                params: { options: (colForRow.options ?? []).map((o) => ({ value: o, label: colForRow.optionLabels?.[o] ?? o })) },
              }
            : colForRow.kind === 'boolean'
              ? {
                  component: SelectPanelEditor,
                  params: { options: BOOLEAN_OPTIONS },
                }
              : colForRow.kind === 'number'
                ? /* `agNumberCellEditor` refuses the `=` keystroke outright — it accepts digits — so
                     the mode switch can never be typed once that editor is mounted. The selector is
                     resolved BEFORE any editor exists and sees `eventKey`, which is the only point
                     where `=` on a numeric cell can still be caught. */
                  {
                    component: 'agNumberCellEditor',
                    params: SHEET_NUMBER_EDITOR_PARAMS,
                  }
                : { component: 'agTextCellEditor' }
        },
        (r) => r.rowId,
      ),
      // Editability is the SERVER's answer per cell, not a guess from the column. `writable: false`
      // (a row under a non-primary alias, whose write path is unproven until PES.5-ii) blocks the
      // editor outright — ruling #58.
      editable: (p) => isCellEditable(p.data?.values?.[col.key]),
      // Explanations live in Cell details. Header help and visible validation states remain available.
      /**
       * 🔴 The code → label map lives on the COLUMN, not only in the renderer — master's AG.1-e
       * lesson, which this scope had never had at all. Without it `country_of_origin` reads `PK`
       * everywhere: on screen, in the CSV export, in a clipboard copy. Adding the dropdown WITHOUT
       * this would have been worse than leaving it: the operator picks "Pakistan" from a list and
       * the cell then shows `PK`, so the sheet disagrees with the choice it just accepted.
       *
       * `optionLabel` is the shared definition (#501), the same one IO.1's import diff uses.
       */
      ...scalarColumnDef<ChannelSheetRow>(col),
      ...referenceColumnDef<ChannelSheetRow>(col, row => row.values[col.key]?.value),
      /* D13's closed-list affordance, applied by KIND from the engine's own constant — so a select
         on this scope cannot look like free text either. */
      /* COMPOSED with the base, as master composes it — replacing it dropped `nds-ag-cell` on selects. */
      /* A shaped column is not a single select even when its kind says `select` — no select class, no chevron. */
      ...((col.kind === 'select' || col.kind === 'boolean' || isReferenceField(col.key)) && !isShaped(col) ? { cellClass: `nds-ag-cell ${SELECT_CELL_CLASS}` } : {}),
      valueGetter: (p: ValueGetterParams<ChannelSheetRow>) => p.data?.values?.[col.key]?.value ?? null,
      valueSetter: (p: ValueSetterParams<ChannelSheetRow>) => {
        const prev = p.data?.values?.[col.key]
        if (!p.data || !prev) return false
        // reference_ag_value_setter_must_mutate_params_data — AG reads the row back off params.data.
        // Typing into a cell pins it at this row's layer, which is what the server will report back.
        p.data.values = {
          ...p.data.values,
          [col.key]: {
            ...prev,
            value: parseReferenceOrScalarValue(columnForCategory(col, data?.scope.label ?? '', p.data.productType ?? null), p.newValue),
            layer: p.data.rowKind === 'parent' ? 'alias' : 'aliasVariant',
            pinned: true,
            inherited: false,
          },
        }
        return true
      },
      ...(Array.isArray(col.validation?.recordFields) ? { valueParser: (p: { newValue: unknown }) => parseRecordValue(p.newValue), valueFormatter: (p: { value: unknown }) => recordSummary(p.value, col.validation!.recordFields as any) } : {}),
      cellRenderer: CascadeCell,
      cellRendererParams: { column: col, onDetails: openCellDetails, productLevelOnly, refusedReasonFor },
      /* THE order, fixed once for every scope (`composeSheetCellClassRules`): validation → provenance
         → round-trip → this sheet's own. The sets are asserted disjoint, so the order decides nothing —
         and it is fixed here so that it never can again. */
      cellClassRules: composeSheetCellClassRules<ChannelSheetRow>({
        validation: channelValidation(col),
        // The tint is PES.2's too (hub ruling #11) — one definition of what "inherited" looks like.
        // The run-level mapping fact travels with the cell — see `withMappingRun`. Without it
        // `mappedShared` is unreachable and 15 of 21 Amazon·IT cells mis-classify as `mapped`.
        provenance: provenanceClassRules<ChannelSheetRow>((d, colId) =>
          classifyProvenance(
            /* #780 — the same merge the renderer does, so the TINT and the MARK cannot disagree
               about whether this cell was refused. */
            { ...withMappingRun(d.values?.[colId], productLevelOnly), refusedReason: refusedReasonFor(d.rowId, colId) },
            'channel',
          ),
        ),
        roundTrip: roundTripClassRules<ChannelSheetRow>(tracker, (d) => d.rowId),
        extra: {
        /**
         * 🔴 A LOCKED cell must LOOK locked — this scope painted none of them (found via PES.2's
         * #775 check on master, from the opposite direction: they had the class and derived it from
         * the wrong predicate, this sheet had no class at all).
         *
         * Measured on the wire, Amazon·IT, GALE-JACKET: **236 of 2,037 cells (12%) across 16 columns
         * are not editable** — `sku`, `condition_type`, `amazonAsin`, `buyBoxPrice`, the identity
         * codes, the whole read-only-on-this-channel set — and every one of them rendered exactly
         * like a cell an operator can type into. The server even supplies the sentence
         * ("Read-only on this channel — the marketplace does not accept a value for this field."),
         * which reached the tooltip and nothing else. A sheet that shows 236 cells as writable and
         * then swallows the keystroke is the honest-UI rule broken in the quietest possible way.
         *
         * ⚠ Derived from `isCellEditable` — the SAME predicate AG's own `editable` prop uses two
         * dozen lines above, not a second rule that happens to agree today. That is the exact defect
         * PES.2 just fixed on master (`applies()` for the class, `cellIsEditable` for `editable`),
         * and re-deriving it here would have reproduced their bug rather than avoided it.
         */
        'nds-cell-is-editable': (p) => isCellEditable(p.data?.values?.[col.key]),
        'nds-cell-is-locked': (p) => !isCellEditable(p.data?.values?.[col.key]),
        // While a chip is active, mark the exact cells it counted. Filtering to the ROWS alone
        // would leave the operator hunting for which of 102 columns was the reason.
        'nds-cell-chip-hit': (p) =>
          !!activeCellsRef.current && !!p.data &&
          chipHasCell(activeCellsRef.current, p.data.rowId, col.key),
        },
      }),
    }))

    /**
     * 🔴 §9.2's RENDER ORDER, on this scope at last (#684/#687, hub-ruled).
     *
     * `defaultViewColumns` was imported here and `orderColumnKeys` was not, so the channel hid the
     * right columns and then drew the survivors in the CONTRACT's order — which puts `name` (220),
     * `productType` (160) and `status` (110) between `brand` and the other six required columns.
     * Measured on screen at 1440 before this line existed (GALE-JACKET, Amazon·IT, root 1372):
     * **3 of 7 required columns visible at scrollLeft 0**, against master's 6 of 7 on the same
     * market — 490px of non-required columns sitting inside the required block. §9.3b fixed exactly
     * this arrangement on master and the channel never received it.
     *
     * The rule is IMPORTED, never re-derived: one ranking, two scopes, and `rankOfColumn` is the
     * same helper master ranks with. Stable on the original index, so a column the rule does not
     * name keeps its contract position relative to its unnamed neighbours.
     *
     * ⚠ What this does NOT fix, measured on the same build: rule 1 hoists a variation AXIS ahead of
     * the required block, and on the IT market the contract returns `color.scope: 'per_variant'`
     * (on DE it returns `global`), so `color` — 160px — lands in front of the seven. Master·IT pays
     * the identical 160px and reads 6/7 at 1440 for the identical reason. That residual belongs to
     * the shared rule, not to this scope, and it is the hub's to rule (#687).
     */
    const rank = new Map(orderColumnKeys(gridColumns as never, viewCtx).map((k, i) => [k, i]))
    const ordered = fields
      .map((c, i) => ({ c, r: rankOfColumn(c, rank), i }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.c)

    /* 🔴 THE `actions` COLUMN IS GONE (#724). The ⋯ is the band's last trailing item on BOTH scopes
       now, so the verbs travel with the row's identity instead of living in a 56px pinned column at
       the far right. That column existed because an UNPINNED ⋯ scrolls off a 100-column sheet (the
       defect this lane measured at #146); inside the band the question does not arise. Retiring it
       also removes the only pinned-right band either scope had, which is what makes the pinned
       geometry read identically on master, Amazon and eBay. */
    return ordered.map(column => {
      if (column.colId === PRODUCT_MEDIA_COLUMN) return productMediaColumn<ChannelSheetRow>(mediaEditor.open, mediaEditor.actions)
      const definition = gridColumns.find(c => c.key === column.colId)
      if (definition?.shopifyField && !shopifySchema) return { ...column, editable: false }
      return definition?.shopifyField && shopifySchema ? { ...column, ...shopifyDraftColumn(definition, shopifyEditor.open),
        editable: p => !!p.data?.values[definition.key]?.writable && auth.has('products.edit') && (definition.shopifyField?.id !== 'inventory' || auth.has('inventory.adjust')),
        cellRendererParams: { ...column.cellRendererParams, openEditor: shopifyEditor.open, formattedPreview: true,
          suppressMouseEventHandling: (p: { event: MouseEvent }) => p.event.target instanceof Element && !!p.event.target.closest('[data-nds-cell-action]') },
      } : column
    })
  }, [shopifySchema, shopifyEditor.open, mediaEditor.open, mediaEditor.actions, data, gridColumns, rows, aliasLabel, openCellDetails, tracker, menuItems, productLevelOnly, viewCtx, familyShowsAxes, auth, toast, getGridApi])

  /**
   * Ruling #34: this lane PRODUCES its chips (it owns the counts and the cells) and RENDERS them in
   * its own toolbar; the frame only holds the registry and the `?chip=` selection. Counts come from
   * the same payload the grid draws, so a chip and the cells it filters to cannot disagree.
   *
   * Memoised because the chip is an effect dependency — a fresh object each render re-registers
   * every render, the identity trap the contract warns about.
   */
  /**
   * §14.1 search. Narrows on the row's own identity and on any cell VALUE, because an operator
   * hunting "Nero" is as likely to be looking at an attribute as at a SKU. Alias band rows are kept
   * whenever any of their variants match, or a search would dissolve the grouping it filters.
   */
  const searchColumnLabels = useMemo(() => new Map(gridColumns.map(col => [col.key, col.optionLabels])), [gridColumns])
  const searchTerm = search.trim().toLowerCase()
  const matchesSearch = useCallback(
    (r: ChannelSheetRow) => {
      if (!searchTerm) return true
      if (`${r.sku ?? ''} ${r.name ?? ''}`.toLowerCase().includes(searchTerm)) return true
      return Object.entries(r.values ?? {}).some(([key, c]) =>
        referenceSearchText(c?.value, searchColumnLabels.get(key)).includes(searchTerm),
      )
    },
    [searchTerm, searchColumnLabels],
  )

  /** Search/refusal scope is shared by the chip counts and the rendered rows. */
  const scopeRows = useMemo(() => {
    /* "Show affected rows" on the refusal note — master's since §6.5, this scope's since 2026-09-04.
       A band row survives when any of its variants was refused, by the same rule the search uses. */
    const afterRefused = (() => {
      if (!showRefusedOnly || refusedRowIds.size === 0) return rows
      return filterRowsWithBands(rows, row => refusedRowIds.has(row.rowId))
    })()
    if (!searchTerm) return afterRefused
    // A band row survives when any of its variants does — filtering it out would strand its
    // children under no group, which reads as a broken sheet rather than a narrowed one.
    return filterRowsWithBands(afterRefused, matchesSearch)
  }, [rows, searchTerm, matchesSearch, showRefusedOnly, refusedRowIds])

  const drafts = useMemo(
    () => (data ? buildChannelChips(scopeRows, gridColumns, data.meta.mapping ?? null) : []),
    [data, scopeRows, gridColumns],
  )
  const missingChip = useMemo(() => drafts.find((c) => c.id === 'missing-required') ?? null, [drafts])
  const warningsChip = useMemo(() => drafts.find((c) => c.id === 'channel-warnings') ?? null, [drafts])
  const mappingChip = useMemo(() => drafts.find((c) => c.id === 'mapping-errors') ?? null, [drafts])
  const invalidChip = useMemo(() => drafts.find((c) => c.id === 'validation-errors') ?? null, [drafts])
  useRegisterViewChip('missing-required', missingChip)
  useRegisterViewChip('channel-warnings', warningsChip)
  useRegisterViewChip('mapping-errors', mappingChip)
  useRegisterViewChip('validation-errors', invalidChip)

  const { chips, activeId, active, setActive } = useViewChips()

  const visibleRows = useMemo(
    () => active ? rowsForChip(scopeRows, active.cells as { byRow: Record<string, string[]> }) : scopeRows,
    [scopeRows, active],
  )

  activeCellsRef.current = (active?.cells as { byRow: Record<string, string[]> } | undefined) ?? null
  // The column model is intentionally blind to the chip (see the ref above), so the repaint is
  // explicit — without it the tint would not appear until some other change forced a render.
  useEffect(() => {
    getGridApi()?.refreshCells({ force: true })
  }, [activeId])

  /**
   * 🔴 The channel scope lands on the SHORT view too (#173, reached master and not this scope).
   *
   * Measured before fixing: 102 columns × the server's own widths = **15,664px, 11.4 screens** at a
   * 1376px viewport. An operator arriving here had to scroll eleven screens to survey one product,
   * which is the Owner's "I barely see a few columns" from the other direction — the sheet was
   * spending its width on emptiness.
   *
   * The rule is PES.2's, imported: identity → the family's variation axes → commerce spine →
   * everything REQUIRED for this product type (filled or not, because an empty required cell IS the
   * work) → anything readiness has flagged on a row in view.
   */
  /**
   * #513 — how many columns on this scope leave the channel. Derived from a VARIANT row: the
   * parent carries the axis rule and answers differently, and a count taken from it would describe
   * a row the operator cannot edit anyway.
   */
  const crossChannelCols = useMemo(
    () => crossChannelColumnCount(rows.find((r) => r.rowKind === 'variant')),
    [rows],
  )

  /**
   * Views, landing, the chip's column narrowing and the Customise apply — the SAME hook master
   * calls (design V.8/V.10). The channel scope used to land through its own one-shot
   * `setColumnsVisible`, restore visibility from AG state, and let its chips filter rows but never
   * columns; master answered each of those differently. One hook, one answer on both scopes: the
   * confirmed personal layout is restored per channel and market. A chip narrows to its cells'
   * columns and clearing it restores the active view.
   */
  // The channel's hand-written column mirror is structurally the studio's; the cast is the same one
  // `orderColumnKeys` already takes (`data.columns as never`), stated once here for the shared hook.
  const schemaColumns = useMemo(() => gridColumns as never as StudioSheetColumn[], [gridColumns])
  /**
   * The bridge: `locked` is STRUCTURAL, the operator's locks are not in it.
   *
   * `{ key: '__identity', locked: true }` is the identity band — held at the left, no padlock
   * offered, and excluded from `PreferencesValue.lockedColumns` by `operatorLocks` however a caller
   * spells it. Everything else is togglable, which is exactly what makes it lockABLE: the engine
   * freezes the operator's set as a contiguous `pinned: 'left'` block right after this lead column,
   * in the order they locked them. Both scopes keep their identity band structurally pinned.
   */
  const prefsBridge = useMemo<PrefsBridgeOptions>(
    () => ({
      columns: [{ key: '__identity', locked: true }, ...gridColumns.map((c) => ({ key: c.key }))],
      treeColumnKey: '__identity',
    }),
    [gridColumns],
  )
  const sheetColumns = useSheetColumns<ChannelSheetRow, null>({
    apiRef,
    gridReady,
    columns: schemaColumns,
    viewCtx,
    identityColumn: '__identity',
    prefsBridge,
    activeChip: active,
    setChip: setActive,
    layoutSurface: `product-edit:layout:${channel.toUpperCase()}:${marketplace.toUpperCase()}`,
    grid: {
      surface: surfaceKey,
      viewsSurface: `product-edit:views:${channel.toUpperCase()}`,
      baseUrl: getBackendUrl(),
      getPageState: () => null,
      applyPageState: () => {},
    },
  })
  const { gridState } = sheetColumns

  // Compare the selected listing with Shared facts. Every channel read has the same
  // explicit account and alias as the open row; no default-account comparisons.
  const compareTargets = useMemo<CompareTarget[]>(() => {
    if (!data || !accountId) return []
    const aliasId = rows.find(row => row.rowId === record.rowId)?.aliasId ?? ''
    const label = data.scope.label
    return [
      { id: 'master', label: 'Shared', kind: 'master', scope: { kind: 'master', label: 'Shared' } },
      { id: JSON.stringify([channel, marketplace, accountId, aliasId]), label, kind: 'channel',
        scope: { kind: 'channel', channel: data.scope.channel, marketplace, accountId, aliasId, label, locale: data.scope.locale } },
    ]
  }, [data, channel, marketplace, accountId, rows, record.rowId])

  /**
   * Table export reflects the current view. Editable exports use catalog-transfer's explicit
   * account/listing identities, stored override state and record versions.
   */
  const onExport = useCallback(
    (mode: SheetExportMode) => {
      const api = getGridApi()
      if (!api || api.isDestroyed() || !data) return
      try {
        const r = exportGridCsv<ChannelSheetRow>(api, `${data.family?.sku ?? 'channel'}-${channel}-${marketplace}-table`, {
          columns: mode === 'all' ? sheetColumns.orderedKeys : 'displayed',
          leading: [
            { colId: '__sku', header: 'SKU', value: row => row.sku },
            { colId: '__account', header: 'Account', value: () => accountId ?? 'Primary account' },
            { colId: '__market', header: 'Marketplace', value: () => marketplace },
            { colId: '__alias', header: 'Listing alias', value: row => row.aliasId ?? '' },
          ],
          narrowed: searchTerm.length > 0 || !!activeId,
        })
        setExportNote(`${r.rows} rows · ${r.columns} columns → ${r.fileName} · reference table`)
      } catch (e: unknown) {
        setExportNote(e instanceof GridExportRefused ? e.message : 'Could not build the file.')
      }
    },
    [data, channel, marketplace, accountId, searchTerm, activeId, sheetColumns],
  )

  /** Read the current order and pins together with the layout's group assignments. */
  const openCustomise = useCallback(() => {
    if (!getGridApi()) return
    setPrefsDraft(sheetColumns.currentPreferences())
    setPrefsOpen(true)
  }, [sheetColumns])

  /**
   * AG.1-d — **Reset columns**, which this scope did not have at all.
   *
   * `NexusGrid` strips AG's own `columnChooser` and `resetColumns` from the header menu and re-adds
   * only what `columnDialog` supplies; this sheet supplied nothing, so it had neither Customise in
   * the header menu nor any way back from a rearrangement. Master's shape, imported rather than
   * reinvented: AG's own reset drops what a VIEW deliberately never touches (sort, ad-hoc pins,
   * widths), `forget()` stops the persistence bringing them back, and the ground preset re-applies
   * the full set. The LOCKS need no separate step — `resetColumnState` puts every column back on its
   * colDef, so the identity keeps its structural pin and every operator pin is gone, and the apply
   * below reads that set off the grid. No two-render dance either (master needs one because its
   * padlock feeds `columnDefs`; `__identity` is structural here, so nothing rebuilds).
   */
  const resetColumns = useCallback(() => {
    const api = getGridApi()
    if (!api) return
    api.resetColumnState()
    /* `resetColumnState` puts the identity band back on its colDef width — the FLOOR the def was built
       with, not the width derived from the longest SKU after mount (#731/#752). Measured 2026-09-05
       (STUDIO lane, Amazon·IT): after Reset the SKU read `GALE-…` and the cells `G.` until a reload.
       The derivation is not repeated (nothing about the family changed); its result is re-stated. */
    if (bandDerivedRef.current) api.setColumnWidths?.([{ key: 'ag-Grid-AutoColumn', newWidth: bandWidthRef.current }])
    gridState.forget()
    setPrefsDraft(null)
    setLockedColumns([])
    const ground = sheetColumns.presets[0]
    if (ground) sheetColumns.applyPreset(ground)
  }, [gridState, sheetColumns])

  const columnDialog = useMemo(() => ({ customise: openCustomise, reset: resetColumns }), [openCustomise, resetColumns])

  const getDataPath = useCallback((d: ChannelSheetRow) => dataPathFor(d), [])
  const getRowId = useCallback((p: { data: ChannelSheetRow }) => rowIdOf(p.data), [])

  /**
   * The band's width, derived once per family (#731) — `deriveBandWidth` is the engine's, shared
   * with master, so the two scopes cannot answer it with two rules.
   *
   * 🔴 The font is built from the DS TOKENS on `documentElement`, never from a rendered
   * `.nds-identity-band-sku`: this runs BEFORE any band is mounted, so a node query returns null
   * and the canvas falls back to a default face. PES.2 hit exactly that and the tell was a result
   * sitting EXACTLY on the 420 ceiling — a clamp is where a failed measurement lands, so a derived
   * width equal to the ceiling is a reading to distrust before it is a number to use.
   */
  const [bandWidth, setBandWidth] = useState(BAND_WIDTH_FLOOR)
  const bandWidthRef = useRef(bandWidth)
  bandWidthRef.current = bandWidth

  /**
   * The band's width, measured from the rendered band once the rows are there (#742).
   *
   * 🔴 RETRIES until a band exists, and that is not defensive padding. PES.2's first version
   * returned when `querySelector` found nothing — honest about not measuring, but with no path to
   * measure again, so on any load where AG paints after the effect the column stayed at the FLOOR
   * and every SKU truncated. I read exactly that on their screen (240px, 21 of 21) while their own
   * load happened to have the band already. **A clamp value is what a failed measurement looks
   * like, from either end** — 420 when the fixed part is large, 240 when it is small.
   *
   * `setTimeout`, never `requestAnimationFrame`: rAF does not fire in a hidden window, and every
   * probe this lane runs is a hidden window.
   *
   * The write is skipped within half a pixel of the current width, so setting it — which re-renders
   * the band — cannot feed back into another measurement.
   */
  useEffect(() => {
    if (!gridReady || rows.length === 0) return
    const api = getGridApi()
    let cancelled = false
    let tries = 0
    const attempt = () => {
      if (cancelled || !api || getGridApi() !== api) return
      /* 🔴 The row-kind choice is the ENGINE's now (#746): `findKeyBearingBand` excludes the
         level-0 alias band, whose trail carries a status pill AND readiness (130px) where a
         variant's carries readiness and the ⋯ (104) — measuring the first band on screen derived
         412 here against master's 404, 26px of trail the rows with the long keys never spend.
         Master cannot hit it (no such row), which is exactly why it lives in one place: a rule
         invisible on one scope and 26px wrong on the other gets fixed once and left broken once. */
      const band = findKeyBearingBand()
      // `deriveBandWidthFromDom` takes `Element | null`, so the two compose without a guard here.
      const next = deriveBandWidthFromDom(band, measureLongestSku(rows.map((r) => r.sku).filter(Boolean), buildSkuFont()))
      if (next == null) {
        if (tries++ < 40) setTimeout(attempt, 50)
        return
      }
      /* 🔴 Set BEFORE the "already right" return, not after it. A family whose derived width equals
         the current one takes that early return, and marking readiness after it would leave the
         reveal permanently waiting for a derivation that had in fact already happened — the
         floor-equals-derived case, which is precisely the one nothing else can distinguish. */
      bandDerivedRef.current = true
      if (Math.abs(next - bandWidthRef.current) < 0.5) return
      setBandWidth(next)
      getGridApi()?.setColumnWidths?.([{ key: 'ag-Grid-AutoColumn', newWidth: next }])
    }
    attempt()
    return () => { cancelled = true }
  }, [gridReady, rows])

  /**
   * 🔴 LIVE REFS, because AG builds the AUTO GROUP column ONCE (#724, measured).
   *
   * `autoGroupColumnDef` is read when the grid initialises; a later object with new closures does
   * not rebuild that column. The first render has `data === null`, so a renderer that closed over
   * `data` captured an empty alias list for the life of the grid — the band row rendered EMPTY on
   * every scope while the variant rows, whose branch needs no lookup, drew correctly. That is the
   * column-state-frozen-at-mount trap wearing a different hat: nothing errors, one row kind is
   * simply blank.
   *
   * Reading through refs keeps the def's identity stable AND its values current. Same pattern as
   * master's `rowsRef`, and the reason is the same.
   */
  const familyShowsAxesRef = useRef(familyShowsAxes)
  familyShowsAxesRef.current = familyShowsAxes
  /* The verbs go through a ref for the SAME reason and it bit the same way: the frozen def captured
     the first render's `menuItems`, which closes over `verbs` — and `verbs` is `[]` until `data`
     arrives. The band then rendered no `⋯` at all on any row, silently, because an empty item list
     is a legitimate "this row has no verbs". Measured: 0 buttons in the band, no `.nds-menu-wrap`. */
  const menuItemsRef = useRef(menuItems)
  menuItemsRef.current = menuItems

  const autoGroupColumnDef = useMemo<ColDef<ChannelSheetRow>>(
    () => ({
      /* The identity band's own definition, which used to be a second pinned column (`__identity`).
         Everything below the geometry is unchanged from that column — the same renderer, the same
         `colSpan`, the same tooltip — so this is a MOVE, not a rewrite. */
    /**
     * 🔴 NAMESPACED, because the channel's own field family contains a `sku` column.
     *
     * A plain `colId: 'sku'` collided with it: AG kept the first and silently renamed the
     * channel's to `sku_1` (warning #273). Everything this lane keys by `col.key` — the cascade
     * renderer, the round-trip class rules, a chip's cell list — would then address a column id
     * that no longer exists, so the channel's real SKU cells would render unstyled and a chip
     * naming `sku` would filter to the identity column instead. The grid still LOOKED right,
     * which is why this is namespaced rather than renamed.
     */
                /**
     * An alias band is about the LISTING, not one 240px SKU column, so it spans.
     *
     * 🔴 NOT a literal count (PES.2's `bandColSpan`, ruling #67). Two defects in `() => 8`: a span
     * cannot cross AG's PINNED boundary, and this identity column is pinned — so the literal spanned
     * the pinned section only and the band was overflowing its cell rather than spanning. And a
     * fixed number breaks on the first view that shows a different column set. `bandColSpan`
     * derives from the DISPLAYED columns, respects the section, and returns 1 for a missing column.
     */
    // No cast: PES.2 widened the helper's params AND `SpanColumnLike.getPinned()` to AG's full
    // `ColumnPinnedType`. The narrow type was not a nicety — behind the cast it filed `false` and
    // `null` into different sections, so a row whose columns spelled "unpinned" two ways split in
    // two and every span collapsed to exactly 1. That is this lane's 240px band.
    colSpan: bandSpan,
    valueGetter: (p: ValueGetterParams<ChannelSheetRow>) => p.data?.sku ?? null,
    cellRenderer: (p: ICellRendererParams<ChannelSheetRow>) => {
      const row = p.data
      if (!row) return null
      // The alias band spans the sheet: its content is the LISTING, not a SKU.
      if (row.rowKind === 'parent') {
        const alias = (dataRef.current?.aliases ?? []).find((a) => aliasKeyOf(a.id) === aliasKeyOf(row.aliasId))
        if (!alias) return null
        return <AliasBandCell {...p} summary={summariseAlias(rowsRef.current, alias)} aliasCount={(dataRef.current?.aliases ?? []).length} menuItems={menuItemsRef.current(row)} />
      }
      /**
       * 🔴 THE SAME THUMBNAIL MASTER DRAWS, from the same shared cell (#709b, D11).
       *
       * The Owner, looking at Amazon·DE: *"why does it all differ… why don't I see the images
       * here?"* — master put a picture on every row and this scope put none, on the same product.
       * `IdentityCell` is `design-system/grid/renderers/cells.tsx`, the one `MasterSheet`'s
       * `ProductCell` renders and the one /products/next measured its geometry into; the size and
       * the fallback come with it rather than being restated here.
       *
       * The data was already on the wire and only this renderer ignored it: 21 of 21 rows carry
       * `imageUrl` and a non-zero `photoCount` on Amazon·IT, Amazon·DE AND eBay·IT (measured
       * before the change, three coordinates).
       *
       * `noImage` rather than a second branch: master gates its thumbnail on the row HAVING an
       * image so an empty catalogue does not get a column of grey placeholders, and the shared
       * cell already expresses exactly that.
       *
       * ⚠ The inherited mark is a branch I could not exercise: `imageInherited` is false on all 21
       * rows of this family, so the ProvenanceMark below is written from master's vocabulary and
       * verified by reading, not on screen.
       */
      /**
       * 🔴 THE SHARED BAND (#721/#710). `IdentityBand` is the engine's — one component drawing
       * the identity row on BOTH sheets, on the Owner's *"It must all be the same exactly"*. The
       * SLOT ORDER is the parity (expand · role · picture · sku · secondary · trailing); what
       * goes in each slot is this scope's: master puts a P/C chip and a product name where this
       * puts an alias mark and the axis values.
       *
       * `expand` is deliberately empty here: AG's auto group column still owns this sheet's tree
       * control in its own 44px column (silent since #713), so passing `ExpandSlot` would add
       * 20px of nothing beside it. When the hub rules the column merge, the band takes the
       * expander via the engine's `useExpanded` — which is now exported (`cells.tsx:517`) so
       * neither scope hand-rolls the node subscription.
       *
       * `secondary` is the axis VALUES — what actually tells one row from another on a family
       * sheet, and the reason §9.2's rule wanted an axis column in the first place. It reads from
       * the row's own `axisValues`, which is the server's vocabulary (`{"Size":"XS"}`), not a
       * fixed Colour/Size pair.
       */
      /**
       * 🔴 THE SECOND LINE IS A FAMILY DECISION, NOT A ROW ONE (#721, PES.2's lesson from landing
       * the band on master, and my own measurement agrees to the row).
       *
       * Measured on all four coordinates — master·IT, Amazon·IT, Amazon·DE, eBay·IT — **2 of 20
       * variants carry `axisValues`; the other 18 carry `{}`**. A per-row fallback therefore
       * prints "Nero · XS" on two rows and nothing on eighteen, in one column, with nothing on
       * screen saying why they differ. `familyShowsAxes` decides once for the whole sheet, so the
       * line is either there for every variant or for none.
       *
       * ⚠ `axisValues` is `{}` on rows that lack it, never absent — `!!row.axisValues` and
       * `'axisValues' in row` both answer true. The test has to be on the key COUNT.
       */
      const axes = familyShowsAxesRef.current ? Object.values(row.axisValues ?? {}).filter(Boolean) : []
      const axisTitle = Object.entries(row.axisValues ?? {}).map(([axis, value]) => `${axis}: ${value}`).join(' · ')
      return (
        <IdentityBand
          expand={<BandExpander node={p.node} />}
          /* #739 — the C chip, on BOTH scopes: a channel variant is a child of the family too, and
             the Owner asked to see the chips. Same component, same tone as master's
             (`MasterSheet.tsx`'s ProductCell), so the two sheets cannot draw a child two ways. */
          role={<ProductRoleChip product={row} />}
          image={row.imageUrl}
          noImage={!row.imageUrl}
          photoCount={row.imageInherited ? undefined : row.photoCount}
          imageMark={
            row.imageInherited ? (
              <ProvenanceMark provenance="inherited" from="the family's picture — this variation has none of its own" />
            ) : null
          }
          sku={row.sku ? <SkuTag>{row.sku}</SkuTag> : null}
          secondary={axes.length > 0 ? axes.join(' · ') : null}
          secondaryTitle={axisTitle || undefined}
          /* #731 — a variant row carries the LISTING's readiness in `trailing`, coloured by its
             STATE (#43), so the same slot means the same thing on every row and both scopes. */
          trailing={
            <CompletenessPill
              /* This counts all applicable channel fields, including optional fields. The listing
                 band's percentage counts required fields; the tooltip names the denominator. */
              pct={row.completeness?.overall?.pct ?? null}
              state={row.readiness?.state}
              tip={`${row.sku} — ${row.completeness?.overall?.filled ?? 0} of ${row.completeness?.overall?.total ?? 0} channel fields filled (including optional fields)${row.readiness?.state ? ` · ${row.readiness.state}` : ''}`}
            />
          }
          menuItems={menuItemsRef.current(row)}
          menuLabel={`Actions for ${row.sku ?? row.rowId}`}
        />
      )
    },
    headerTooltip: 'One group per listing alias; the child SKUs beneath it are shared by every alias',
      /**
       * 🔴 ONE identity column (#724). This WAS a 44px expander-only column sitting beside a
       * separate 240px `__identity`, which is the "two columns" the Owner saw and master never had:
       * master's auto group column IS its identity column. Merging them means the band owns the
       * tree control (`useExpanded` + `ExpandButton`, both the engine's) and there is nothing left
       * to print AG's group key into, so `#713`'s `innerRenderer: () => null` goes with it.
       *
       * `headerName: 'SKU'` because this column now IS the SKU column; the header used to be blank
       * because the thing it labelled was an expander.
       */
      /* 'Product', as master names the same band (thumb · SKU · readiness) — 2026-09-04: the two
         scopes headed the identical column 'Product' and 'SKU'. */
      headerName: 'Product',
      colId: 'alias',
      pinned: 'left',
      lockPinned: true,
      lockPosition: 'left',
      /**
       * 🔴 DERIVED from what the band contains (#731), never a constant. 240 was "what `__identity`
       * had always been" and 376 was "what master's three columns added up to" — measured at 240
       * with the trailing pill in, the SKU truncated on eBay·DE's variant rows and the band row
       * truncated both its label and its "20 variants".
       *
       * The slots below are MEASURED on this surface, not copied from master's: they are the widest
       * box of each kind across BOTH row kinds this scope draws, because one column has to hold
       * both. `role` is the 13px alias mark (the band row's), `thumb` the 32px picture (the variant
       * rows'), `trailing` the band row's 130px status-pill-plus-readiness — the widest case.
       */
      width: bandWidthRef.current,
      suppressHeaderMenuButton: true,
      cellClass: 'nds-ag-cell',
      /* #713's `innerRenderer: () => null` is GONE WITH THE COLUMN IT GUARDED: AG only prints the
         group key when the auto column falls through to `agGroupCellRenderer`, and this column now
         has a `cellRenderer` of its own (master's shape — see `MasterSheet.tsx`'s `ProductCell`).
         The expander it used to own moved into the band's `expand` slot. */
    }),
    [],
  )

  const onGridPreDestroyed = useCallback((event: { api: GridApi<ChannelSheetRow> }) => {
    if (apiRef.current === event.api) {
      sheetColumns.captureGridState()
      gridState.persist()
      setSelected([])
    }
    releaseGrid(event)
  }, [apiRef, gridState, releaseGrid, sheetColumns.captureGridState])

  const onGridReady = useCallback((e: GridReadyEvent<ChannelSheetRow>) => {
    bindGridApi(e.api)
    // `useGridState` (inside the column hook) persists the allow-listed slices on `stateUpdated`,
    // debounced, under this coordinate's key — the same writer master uses.
    gridState.bind(e.api)
    // 🔴 A ref is invisible to the effect system. The landing effect depends on the grid existing,
    // and `apiRef.current` changing does not re-run anything — so gated on the ref alone it ran once
    // with a null api, returned, and never fired again: the sheet stayed 15,664px wide and the
    // measurement was identical to having written no rule at all.
  }, [bindGridApi, gridState])

  // reference_ag_react_inline_options_rerun_column_model — an inline arrow here rebuilds the
  // column model on every render, which loses column state mid-edit.
  /**
   * The last DATA cell the operator was in — what §5.4 means by "the cell you opened the record
   * from", and not the same as `getFocusedCell()` at the moment the verb runs.
   *
   * 🔴 Measured: clicking the `⋯` button moves AG's focus to the actions cell, so reading focus
   * inside `openRecord` yielded `cell=actions` — a pinned column that is always visible, so the
   * reveal computed "not covered" and nothing ever scrolled. The chrome columns are excluded here
   * for that reason: they are never the cell someone was working in.
   */
  const lastDataCell = useRef<string | null>(null)
  const onCellFocused = useCallback((e: { column?: unknown }) => {
    const col = e.column as { getColId?: () => string } | null | undefined
    const id = typeof col?.getColId === 'function' ? col.getColId() : undefined
    if (isRevealAnchor(id)) lastDataCell.current = id!
  }, [])

  /**
   * 🔴 A REFUSED OPEN GESTURE SAYS WHY ON THIS SCOPE TOO (Owner's ruling, 2026-09-03).
   *
   * This file's own comment above `editable` said it plainly — *"A non-editable cell drops the
   * editor silently"* — and the contract gate measured it: on Amazon·IT, `condition_type` refused
   * double-click, Enter, F2, a typed character and `=` with nothing said, while master explained
   * itself for all five. Master was wired first and the channel was left, which is precisely the
   * "shared = exactly the same" drift that never shows up in a diff.
   *
   * 🔴 The WORDS come from the engine (`refusalWords`), the REASON is decided here. The two scopes
   * do not share an editability predicate and should not be made to: this scope has a `writable`
   * veto master has no concept of, and master has a per-variation-on-parent veto this scope does
   * not. Sharing the sentence is what matters to the operator; sharing the rule would mean
   * inventing a veto for one scope or dropping a real one from the other.
   */

  const shopifyClipboard = useMemo(() => shopifyGridTransfer(mediaClipboard, data?.columns ?? [], accountId ?? '', message => toast(message, 'info')), [mediaClipboard, data?.columns, accountId, toast])
  const refusalRef = useRef<(colId: string | undefined, row: ChannelSheetRow | undefined) => boolean>(() => false)
  /* Deduped for 2.5s: without it a locked cell answers once per KEYSTROKE, and five stacked copies
     of the same sentence is a fault of its own rather than an explanation. */
  const lastSaid = useRef<{ text: string; at: number }>({ text: '', at: 0 })
  refusalRef.current = (colId, row) => {
    if (!colId || !row) return false
    const col = data?.columns.find((c) => c.key === colId)
    if (!col) return false
    const cell = row.values?.[colId]
    if (isCellEditable(cell)) return false
    const label = col.label || col.key
    /* The server may provide a specific remedy, including relationship fields that cannot be
       edited on Master either. Use the generic channel guidance only when no reason is supplied. */
    const why = cell?.writeBlockedReason || (
      cell?.writable === false
        ? refusalWords(label, { kind: 'channel-not-writable' })
        : col.editable === false
          ? refusalWords(label, { kind: 'column-read-only' })
          : refusalWords(label, { kind: 'cell-locked' }))
    const now = Date.now()
    if (lastSaid.current.text === why && now - lastSaid.current.at < 2500) return true
    lastSaid.current = { text: why, at: now }
    toast(why, 'info')
    return true
  }
  const onCellDoubleClicked = useCallback((e: { column?: unknown; data?: ChannelSheetRow }) => {
    const col = e.column as { getColId?: () => string } | null | undefined
    refusalRef.current(typeof col?.getColId === 'function' ? col.getColId() : undefined, e.data)
  }, [])
  /* Enter, F2 and a printable character are open gestures exactly as a double-click is, and all
     five were measured silent here. A ref keeps the handler's identity stable so AG is not handed a
     new callback on every render. */
  const onCellKeyDown = useCallback((e: { event?: Event | null; column?: unknown; data?: ChannelSheetRow }) => {
    const ke = e.event as KeyboardEvent | undefined
    if (!ke || ke.altKey || ke.ctrlKey || ke.metaKey) return
    const opensAnEditor = ke.key === 'Enter' || ke.key === 'F2' || (ke.key.length === 1 && ke.key !== ' ')
    if (!opensAnEditor) return
    const col = e.column as { getColId?: () => string } | null | undefined
    refusalRef.current(typeof col?.getColId === 'function' ? col.getColId() : undefined, e.data)
  }, [])

  const onSelectionChanged = useCallback(() => {
    setSelected(getGridApi()?.getSelectedRows() ?? [])
  }, [])

  /**
   * 🔴 THE CHECKBOXES, which this scope never had (#711, Owner-visible).
   *
   * `onSelectionChanged` above, `selected.length` in the toolbar (`:1178`) and in the footer
   * (`:1293`) were all already wired — the sheet counted a selection it gave the operator no way to
   * make, because `rowSelection` was never passed to the grid and AG renders no checkbox column
   * without it. Three consumers of a number that could only ever be 0.
   *
   * `gridSelection()` is the ENGINE's, called exactly as master calls it
   * (`MasterSheet.tsx:1000`) with no options, so both scopes get the same mode, the same header
   * box, the same 43px column and the same `enableClickSelection: false`. Passing options here to
   * "improve" it is how the two scopes drift.
   */
  const rowSelection = useMemo(() => gridSelection<ChannelSheetRow>(), [])

  /**
   * `[+ Add listing alias]` (layout §1). Creating a listing is outward-facing, so this creates a
   * DRAFT only — no channel call, no ItemID, no publish. The new alias is filled in on the sheet and
   * sent explicitly through the same preflight-first path as every other one.
   */
  const [adding, setAdding] = useState(false)
  const aliasCreationPending = useRef(false)
  useEffect(() => registerScopeChangeGuard(() => !aliasCreationPending.current), [registerScopeChangeGuard])
  const [preflightAlias, setPreflightAlias] = useState<PreflightAlias | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const nativeReviewRow = preflightAlias ? rows.find(row => row.aliasId === preflightAlias.id && row.shopify) : null
  const reviewPath = nativeReviewRow?.shopify && accountId ? `/api/products/${encodeURIComponent(nativeReviewRow.shopify.productId)}/shopify-linked?${new URLSearchParams({ accountId, listingId: nativeReviewRow.shopify.listingId, market: 'GLOBAL', ...(locale ? { locale } : {}) })}` : null
  const [addError, setAddError] = useState<string | null>(null)
  const onAddAlias = useCallback(async () => {
    if (aliasCreationPending.current) return
    aliasCreationPending.current = true
    setAdding(true)
    setAddError(null)
    const res = await addListingAlias({ productId, channel, marketplace, accountId })
    aliasCreationPending.current = false
    setAdding(false)
    if (!res.ok) {
      setAddError(res.reason ?? 'Could not add a listing alias')
      return
    }
    reload()
    // A newly created alias must be visible even when the previous view focused one listing.
    if (selectedAlias !== null) setListing(undefined)
    toast('Listing alias created as a Nexus draft.', 'success')
  }, [productId, channel, marketplace, accountId, reload, selectedAlias, setListing, toast])

  /* CH.1 — the listing verbs are ITEMS of the toolbar's ⋯ overflow (the bar is identical on every
     scope): one preflight per alias, and add-alias. The preflight itself opens in a modal (below). */
  const overflowItems = useMemo<MenuItemDef[]>(() => {
    const items: MenuItemDef[] = (data?.aliases ?? []).map((a) => {
      const n = variantRowsOf(rows, a.id).length
      const mark = aliasMark(a.position)
      if (n === 0) return { id: `preflight:${a.id}`, label: `${channel === 'SHOPIFY' ? 'Preflight' : 'Check Information'} ${mark}`, disabled: true, description: `${mark} has no applicable rows to check` }
      return {
        id: `preflight:${a.id}`,
        // §6.4 — on an unlisted coordinate the preflight survives but loses its count: `(20)` would be
        // rows of a listing that does not exist yet.
        label: channel === 'SHOPIFY' ? `Review synchronization ${mark} (${n})` : `Check Information ${mark} (${n})`,
        disabled: pending > 0 || refused > 0,
        description: channel === 'SHOPIFY' ? 'Review the store synchronization payload' : 'Review saved Information errors for this listing',
        onSelect: () => setPreflightAlias(a),
      }
    })
    items.push({
      id: 'add-alias',
      label: adding ? 'Adding…' : '+ Add listing alias',
      disabled: adding || pending > 0 || refused > 0 || !auth.has('products.edit'),
      ...(addError ? { description: addError } : {}),
      onSelect: () => void onAddAlias(),
    })
    items.unshift({
      id: 'cell-details', label: 'Cell details…', description: 'Select a cell to inspect its full value, source and validation.',
      onSelect: () => {
        const api = getGridApi(), focused = api?.getFocusedCell()
        const row = focused ? api?.getDisplayedRowAtIndex(focused.rowIndex)?.data : undefined
        const column = data?.columns.find(col => col.key === focused?.column.getColId())
        if (row && column) openCellDetails(row, column)
        else toast('Select an attribute cell first, then open Cell details.', 'info')
      },
    })
    return items
  }, [data, rows, adding, addError, onAddAlias, alternateAccount, channel, pending, refused, getGridApi, openCellDetails, toast, auth.has])

  const unavailable = !loading && (backendMissing || !!error || !data)
  const emptyState = sheetEmptyState(rows.length, () => {
    setSearch('')
    setActive(null)
    setShowRefusedOnly(false)
    getGridApi()?.setFilterModel(null)
  }, reload)

  /**
   * §6.4 — is this coordinate not listed at all?
   *
   * Read from the SERVER's state, never inferred from an empty alias or a null ItemID: PES.5 sends
   * `readiness.state: 'unlisted'` precisely so the client does not have to guess, and inferring it
   * is how `?? 'DRAFT'` happened one level down. Every alias must agree — a scope where one alias
   * exists and another does not is a listed scope with a gap, not an unlisted one.
   */
  const unlisted =
    !!data?.aliases.length && data.aliases.every((a) => a.readiness?.state === 'unlisted')


  return (
    <GridSheet
      toolbar={
        /**
         * §14.1 — ONE toolbar for both scopes. This was a hand-rolled
         * `<div className="nds-grid-prefsbar nds-channel-toolbar">` that rendered its own chips and
         * status line and simply had no search, Views, Customise, Export or Reload — SR.1 measured
         * the scope as "a different application" (chrome 99–111px against master's 42) while it
         * carried six of ten operator tasks.
         *
         * The standard controls are not props here, they ARE the component, so this scope cannot
         * drop one by forgetting it. The channel's own controls go in the slots.
         */
        <>
        <SheetToolbar
          /* Every rendered row, as master counts them (its parent row counts; this scope's band row
             counts the same way) — the toolbar said 20 while the footer beneath it said 21. */
          visible={visibleRows.length}
          total={rows.length}
          selected={selected.length}
          descriptor={
            data && <span className="nds-cell-muted">
              {' · '}
              {unlisted ? `${readinessMeta('unlisted', 'row').label} · ` : ''}
              {data.aliases.length} {data.aliases.length === 1 ? 'listing' : 'listings'} ·{' '}
              {distinctVariantCount(rows)} variations
              {/* 🔴 #513 — where an edit from this tab actually LANDS, stated standing rather than
                  at the moment of the write. Measured on eBay·IT: 33 of 35 columns carry
                  `affectsAllChannels`, so most of this sheet writes the shared master record and an
                  operator who thinks they are tuning eBay is changing Amazon too. The same honesty
                  as Amazon's shared-EU quantity. Rendered only when the count is real — a scope
                  whose columns are all channel-local says nothing. */}
              {/* CH.1: that sentence now lives in the FOOTER — the count slot is the same shape on every
                  scope, and the bar no longer overflows its 1660px (it was 503px over at 1728). */}
              {/* A SKU count, never a unit total: a SKU listed three times is one SKU, but its
                  units listed three times are still one pool (PES.5 §3.2). */}
            </span>
          }
          search={search}
          onSearch={setSearch}
          /* Views on the channel scope too (design V.10) — the same menu, the same builder, the same
             presets rule as master, saved per CHANNEL. The `absent: 'views'` entry this scope carried
             is gone with the gap it declared. */
          views={gridState}
          presets={sheetColumns.presets}
          activePresetId={sheetColumns.activePresetId}
          onApplyPreset={sheetColumns.applyPreset}
          viewsEmptyLabel={sheetColumns.emptyLabel}
          onSaveCurrentView={sheetColumns.saveCurrentAs}
          onUpdateCurrentView={sheetColumns.updateView}
          describeView={sheetColumns.describeView}
          chips={chips}
          activeChipId={activeId}
          onChipToggle={(id) => setActive(id === activeId ? null : id)}
          onCustomise={openCustomise}
          onExport={() => { setTransferIntent('export'); setTransferOpen(true) }}
          exportCounts={{ view: sheetColumns.visibleAttributeKeys().length, all: sheetColumns.orderedKeys.length }}
          exportDisabled={!data || loading || destination.status !== 'ready' || !auth.has('products.export')}
          exportPurpose="workbook"
          onReload={onReload}
          onImport={() => { setTransferIntent('import'); setTransferOpen(true) }}
          importDisabled={!data || loading || destination.status !== 'ready' || !auth.has('products.import')}
          loading={loading}
          unavailable={unavailable}
          overflow={[...overflowItems, { id: 'formula-history', label: 'Formula history…', disabled: selectedAlias == null && new Set(selected.map(row => row.aliasId ?? '')).size !== 1, description: 'Select rows from one listing to inspect its formula history.', onSelect: () => setFormulaHistoryOpen(true) }, { id: 'bulk-formula', label: 'Apply formula to selected products…', disabled: !selected.length || !formulas.ready || new Set(selected.map(row => row.aliasId ?? '')).size !== 1, onSelect: () => setBulkFormulaRows(selected.map(row => ({ id: row.id, label: row.sku ?? row.id, rowId: row.rowId, aliasKey: row.aliasId ?? '' })).sort((a, b) => Number(a.id === productId) - Number(b.id === productId))) }]}
          trailing={
            data && <>
              <SchemaStatus channel={channel} market={marketplace} accountId={accountId} categories={[...new Set(rows.map(row => row.productType).filter((v): v is string => !!v))]} missing={data.meta.schemaMissing} ages={data.meta.schemaAge} onRefreshed={reload} />
              {/* CH.1 — the preflight, opened from the ⋯ overflow. A DS Modal is the interim shell until
                  PES.2's publish drawer; the control inside is unchanged and still sends nothing. */}
              {preflightAlias && (
                <Modal
                  open
                  onClose={() => { if (!reviewBusy) setPreflightAlias(null) }}
                  title={`${channel === 'SHOPIFY' ? 'Review synchronization' : 'Information check'} · ${data.scope.label} · ${aliasMark(preflightAlias.position)}`}
                  subtitle={reviewPath ? "Review the exact destination and changes before synchronization." : "What a send would carry, checked by the server. Nothing is sent from here."}
                  size="lg"
                >
                  <>{reviewPath ? <ShopifySheetReview key={reviewPath} path={reviewPath} schema={shopifySchema} onBusyChange={setReviewBusy} onChanged={() => void refresh(() => !tracker.hasUnconfirmedChanges)} /> : <AliasPublishControl alias={preflightAlias} rows={rows} channel={channel} marketplace={marketplace} autoRun />}</>
                </Modal>
              )}
              {exportNote && <span className="nds-cell-sub">{exportNote}</span>}
              {pendingMasterWrite && (
                <span className="nds-channel-ack">
                  <strong>This field is not channel-specific.</strong> Saving it changes{' '}
                  <strong>{pendingMasterWrite.colId}</strong> on the master record, so every channel —
                  Amazon, eBay, Shopify — shows the new value, not just {data.scope.label}.
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      acknowledgedRef.current = true
                      const pm = pendingMasterWrite
                      setPendingMasterWrite(null)
                      onCellValueChanged({ data: pm.row, colDef: { colId: pm.colId }, newValue: pm.value, oldValue: pm.previous, source: 'edit' })
                    }}
                  >
                    Save to all channels
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const pm = pendingMasterWrite
                      setPendingMasterWrite(null)
                      revertingRef.current = true
                      try {
                        getGridApi()?.getRowNode(pm.rowId)?.setDataValue(pm.colId, pm.previous)
                      } finally {
                        revertingRef.current = false
                      }
                    }}
                  >
                    Cancel
                  </Button>
                </span>
              )}
            </>
          }
        />
        </>
      }
      footer={
        !loading && !unavailable && data && <GridSheetStatus
          rows={visibleRows.length}
          selected={selected.length}
          pending={pending}
          saving={saving}
          refused={refused}
          lastSavedAt={lastSavedAt}
        >
          {/* 🔴 #513 — where an edit from this tab LANDS, standing. Moved here from the count slot by
              CH.1; rendered only when the count is real, on one line, never wrapping the strip. */}
          {crossChannelCols > 0 && (
            <span
              className="nds-cell-muted cs-cross-channel-note"
              style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={`${crossChannelCols} of ${data.columns.length} columns write the shared master record — every channel sees those edits`}
            >
              {crossChannelCols} of {data.columns.length} columns write the shared master record — every channel sees those edits
            </span>
          )}
          {/* The ONE note slot — offline · refusal · keyboard hint — shared with master, so the footer
              reads identically on every scope (2026-09-04). */}
          <SheetFooterNote
            offline={offline}
            layoutRecovery={sheetColumns.loadError ? { retry: sheetColumns.reloadSavedPreferences } : null}
            refused={refused}
            showRefusedOnly={showRefusedOnly}
            onToggleRefused={() => setShowRefusedOnly((v) => !v)}
            lastSavedAt={lastSavedAt}
          />
        </GridSheetStatus>
      }
    >
      {unavailable ? <SheetLoadError label={`${channelLabel(channel)} · ${marketplace} information`} unavailable={backendMissing} onRetry={reload} /> : <>
      {/*
        PES.4's dock, mounted on the channel scope (#129). Without it the frame's reserved track is
        0px and a channel verb has no surface to appear on — their adapter was unit-tested but had
        never rendered, because no lane had declared verbs for it to render.

        `rowActions` is this lane's registry (`channelActions`), so the drawer, the row menu and the
        selection bar offer the SAME verbs from one definition. `resolveRow` reads the rows the grid
        already holds — no second fetch to open a record.
      */}
      {data && <StudioDock<ChannelSheetRow>
        resolveRow={(id) => rows.find((r) => r.rowId === id) ?? null}
        onRevealCell={revealCell}
        columns={data.columns}
        scope={{ kind: 'channel', accountId, aliasId: rows.find(r => r.rowId === record.rowId)?.aliasId ?? '', channel: data.scope.channel, marketplace: data.scope.marketplace, label: data.scope.label, locale: data.scope.locale }}
        compareTargets={compareTargets}
        loading={loading}
        error={error}
        rowActions={verbs}
        // Refused, not broken: this scope's writes go through the sheet's own cascade + writer, so
        // a second write path in the drawer would be two ways to change one cell.
        onWrite={async () => ({ state: 'refused' as const, message: DRAWER_READ_ONLY })}
        /**
         * D16 in the drawer — the seam, and the DECLARATIVE refusal that makes it safe (#775/PES.4).
         *
         * 🔴 `writesRefused` is not decoration. Without it `FormulaField` would have offered a live
         * formula write three lines under the refusal above, because `RecordField`'s `editable`
         * derives only from cell and column facts and the field references `onWrite` zero times —
         * PES.4 confirmed both from their own source. And a host that refuses WHOLESALE cannot be
         * discovered by calling `onWrite`, because calling it IS the write; the signal has to be
         * declarative. It suppresses every authoring path: the ƒ button, the remove button, the `=`
         * keystroke, and the field's disabled state, with early returns in `save`/`removeFormula`
         * behind it so a hidden control and an impossible write are separately true.
         *
         * ⚠ ONE constant, not the same sentence typed twice. Passing a matching string would let the
         * two drift the first time either is reworded, and then the drawer would explain a refusal
         * in words the refusal itself does not use.
         *
         * A STORED formula still DISPLAYS here, read-only — PES.4's exception and I agree with it:
         * hiding it would leave an operator looking at a computed value whose rule they can neither
         * read nor account for, which is the hazard `formulaAvailability`'s "a stored formula is
         * always available" arm exists to prevent. Read-only display grants no write.
         */
        writesRefused={DRAWER_READ_ONLY}
        formulas={{ ...formulas,
          exprFor: (id, key) => formulas.exprFor(record.rowId ?? id, key),
        }}
        /* The value layer moved server-side and this sheet holds no cached result for a formula row
           by design, so a re-read is the only honest way to show what it produced — the same reason
           the sheet's own formula commit reloads. */
      />}

      <TooltipPortalProvider disabled>
      <NexusGrid<ChannelSheetRow>
        fill
        {...SHEET_GRID_OPTIONS}
        {...SHEET_STATE_OVERLAYS}
        loading={loading}
        noRowsOverlayComponentParams={emptyState}
              {...shopifyClipboard}
        /* 🔴 `media-line`, with the thumbnail above and for the same reason (#709b). It is a row
           KIND, not a density (`tokens/grid.ts:40`): 36px = a 32px thumbnail + 2 above + 2 below in
           compact. Left at the default `text` (28px) the picture would overflow its own row — the
           height is a property of what the row now carries, so it moves with the content. Master
           has carried `rows="media-line"` since its thumbnail landed. */
        rows="media-line"
        rowData={visibleRows}
        columnDefs={columnDefs}
        treeData
        getDataPath={getDataPath}
        getRowId={getRowId}
        autoGroupColumnDef={autoGroupColumnDef}
        groupDefaultExpanded={1}
        onGridReady={onGridReady}
        onGridPreDestroyed={onGridPreDestroyed}
        initialState={sheetColumns.initialState}
        onCellValueChanged={onCellValueChanged}
        rowSelection={rowSelection}
        onSelectionChanged={onSelectionChanged}
        onCellFocused={onCellFocused}
        onCellDoubleClicked={onCellDoubleClicked}
        onCellKeyDown={onCellKeyDown}
        getContextMenuItems={contextMenu}
        /* The header menu's own two verbs (AG.1-d): `NexusGrid` strips AG's `columnChooser` and
           `resetColumns` and re-adds only these, so without the prop this scope had no Customise in
           the column menu and no Reset anywhere. Same pair master passes. */
        columnDialog={columnDialog}
      />
      </TooltipPortalProvider>

      {/*
        🔴 The confirm, mounted by the surface that runs the verbs (#145). Without this element in
        the tree, a verb with a preflight awaits an `ask()` whose dialog never renders: the promise
        never settles, the menu closes, and nothing happens — no error, no toast, no console line.
        `pause-offer` and `broadcast-to-listings` both have preflights, so this is not theoretical.
      */}
      {confirmElement}
      {listResetConfirm.element}
      {reloadConfirm.element}

      {/* The ONE Customise dialog — the DS `PreferencesModal`, same component master opens, never a
          channel-local fork (`reference_customize_dialog_is_ds_preferences_modal`). */}
      <PreferencesModal
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        /* `lockedColumns` is PRESENT even when empty — that field is the padlock's opt-in in the DS
           dialog (`locksPersist`), and this scope round-trips it (the lock contract). */
        value={prefsDraft ?? { visibleColumns: [], lockedColumns, stickyFirstColumn: true, stickyLastColumn: false, pageSize: 0, sortBy: '', sortDir: 'asc' }}
        onConfirm={async (value) => {
          const api = getGridApi()
          const wasVisible = new Set((api?.getColumnState() ?? []).filter((c) => !c.hide).map((c) => c.colId))
          const firstNew = value.visibleColumns.find((key) => !wasVisible.has(key)) ?? null
          await sheetColumns.savePreferences(value)
          if (firstNew) setTimeout(() => revealCell(firstNew, 'uncover'), 0)
          setLockedColumns(value.lockedColumns ?? [])
          setPrefsDraft(value)
        }}
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
        viewSave={{
          activeName: sheetColumns.activeViewName,
          onSaveAs: async (name, value) => {
            await sheetColumns.savePreferencesAs(name, value)
            setLockedColumns(value.lockedColumns ?? [])
            setPrefsDraft(value)
          },
          onUpdate: sheetColumns.activeViewName
            ? async (value) => {
                const activeView = sheetColumns.active
                if (activeView.kind !== 'saved') return
                const view = gridState.views.find((v) => v.id === activeView.id)
                if (!view) throw new Error('That view no longer exists')
                await sheetColumns.updatePreferences(view, value)
                setLockedColumns(value.lockedColumns ?? [])
                setPrefsDraft(value)
              }
            : undefined,
        }}
        title={sheetColumns.activeViewName ? `Customise columns · ${sheetColumns.activeViewName}` : 'Customise columns'}
        listHint="Organise channel attributes into groups and choose their order. Save keeps your personal layout for this channel and market after a reload."
      />

      {/* A refusal or failure in the operator's view, in the server's own words. `press` reports a
          problem for `refused` and `failed` and stays silent on `cancelled`, which is correct: an
          operator who backed out does not need to be told they backed out. */}
      {problem && (
        <div className="nds-channel-ack" role="status">
          <span>{problem}</span>
          <Button variant="secondary" size="sm" onClick={clearProblem}>
            Dismiss
          </Button>
        </div>
      )}
      {formulaHistoryOpen && <FormulaHistoryDialog familyProductId={productId} coordinate={{ scope: 'channel', channel, marketplace, market: marketplace, locale: data?.scope.locale ?? locale ?? '', channelConnectionId: data?.scope.connectionId ?? accountId ?? undefined, aliasKey: selectedAlias ?? selected[0]?.aliasId ?? '' }}
        onClose={() => setFormulaHistoryOpen(false)} onApplied={() => { formulas.reload(); void refresh(() => true) }} />}
      {bulkFormulaRows && data && <FormulaBulkDialog rows={bulkFormulaRows} columns={data.columns}
        coordinate={{ scope: 'channel', channel, marketplace, market: marketplace, locale: data?.scope.locale ?? locale ?? '', channelConnectionId: data?.scope.connectionId ?? accountId ?? undefined, aliasKey: bulkFormulaRows[0]?.aliasKey ?? '' }}
        functions={formulas.functions} preview={(id, key, expr, signal) => formulas.preview(bulkFormulaRows.find(row => row.id === id)!.rowId, key, expr, signal)}
        candidatesFor={id => { const row = rows.find(row => row.rowId === bulkFormulaRows.find(item => item.id === id)?.rowId); return row ? candidatesFor(row) : [] }}
        onClose={() => setBulkFormulaRows(null)} onApplied={() => { formulas.reload(); void refresh(() => true) }} />}
      </>}
      <ProductTransferDrawer open={transferOpen} intent={transferIntent} onClose={() => setTransferOpen(false)}
        productId={productId} market={marketplace} channel={channel} accountId={accountId} aliasKey={selectedAlias} locale={locale}
        selectedIds={selected.map(row => row.id)} onReference={() => onExport('view')}
        visibleFields={sheetColumns.visibleAttributeKeys().flatMap(key => { const c = data?.columns.find(c => c.key === key); return c ? [c.slot?.of ?? c.key, ...Object.values(c.channels ?? {}).flatMap(channel => [channel.key, channel.attribute])] : [] })}
        onApplied={() => { formulas.reload(); reload() }} />
      {mediaEditor.element}
      {shopifyEditor.element}
      {cellDetails && <Modal open readable size="md" title={cellDetails.title} onClose={closeCellDetails}
        footer={<><Button size="sm" onClick={closeCellDetails}>Close</Button>
          {cellDetails.action && <Button size="sm" variant="primary" onClick={() => { cellDetails.action?.run(); closeCellDetails() }}>{cellDetails.action.label}</Button>}
        </>}>
        <div className="cs-cell-details">
          <p>{cellDetails.value}</p>
          <p>{cellDetails.notes}</p>
          {cellDetails.action && <p>{cellDetails.action.description}</p>}
        </div>
      </Modal>}
    </GridSheet>
  )
}
