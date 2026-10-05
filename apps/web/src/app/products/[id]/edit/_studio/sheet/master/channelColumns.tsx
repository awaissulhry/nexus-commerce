'use client'
import { scalarColumnDef, BOOLEAN_OPTIONS, SHEET_NUMBER_EDITOR_PARAMS } from '@/design-system/grid/editors/scalarValue'
import { slotListColumnDef } from '@/design-system/grid/editors/slotListColumn'
import { columnForCategory, columnApplies } from '@nexus/shared/master-sheet'
import { EbayPolicyEditor, isEbayPolicyField } from '../EbayPolicyInput'
import { ChannelCategoryEditor } from '../ChannelCategoryEditor'
import { StructuredAttributeEditor, parseRecordValue, recordSummary } from '../StructuredAttributeEditor'
import { CascadeCell } from '../channel/CascadeCell'
import { asinColumnDef } from '../channel/AsinCell'
import { LISTING_ASIN_KEY } from '../channel/stockCells'
import { stockColumnDef } from '../channel/stockColumns'
import { isCellEditable } from '../channel/rows'
import { channelCellDrawsRequired, channelCellMark, channelCellProvenance } from '../channel/channelCellProvenance'
import { optimisticCell } from '../channel/savedCellPatch'
import { chipHasCell } from '../channel/viewChips'
import { parseReferenceOrScalarValue, referenceColumnDef } from '../referenceLabels'
import { isReferenceField } from '../referenceOptions'
import { ReferenceSelectEditor } from '../ReferenceSelectEditor'
import { orderColumnKeys, rankOfColumn, type ViewContext } from '../views'
import { SLOT_LIST_FIELDS, type SlotColumnLike } from '../slotListColumns'
import { productMediaColumn, PRODUCT_MEDIA_COLUMN, type useProductMediaEditor } from '../../media/productMediaColumn'
import { shopifyDraftColumn, type useShopifyDraftCell } from '../../shopify/ShopifyDraftCell'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import type { ChannelSheetRow, SheetColumn, ChannelScopePage } from '../channel/types'
import { createOwnAxisAttribute, loadOwnAxisSources } from './ownAxisSourcesLoader'

/* Sheet pop-up P3 A2 — the channel variation pop-up reads "Values from" through this host loader (a STABLE object: AG re-runs
   its column model on a new params object, reference_ag_react_inline_options_rerun_column_model). A3 — and makes a new
   per-variant attribute through the same host. */
const CHANNEL_VARIATION_EDITOR_PARAMS: Record<string, unknown> = Object.freeze({ loadOwnAxisSources, createOwnAxisAttribute })
import {
  provenanceClassRules, roundTripClassRules, type CellSaveTracker,
  type ColDef, type ValueGetterParams, type ValueSetterParams, type FormulaWiring,
  longTextEditor, textLimitFor, selectEditor, SELECT_CELL_CLASS, SELECT_CLEAR_LABEL, formulaCellEditorSelector, numericColumn,
  sheetValidationFor, composeSheetCellClassRules, shapeColumnDef, shapeEditorSpec, isShaped,
  suppressFormulaKeys, SelectPanelEditor, variationThemeColumnDef, type CellProvenance,
} from '@/design-system/grid'

export const channelValidation = (col: SheetColumn) => sheetValidationFor<ChannelSheetRow>(col, row => columnApplies(col, row), { channelList: true })

export interface BuildChannelColumnsOptions {
  /** Only the scope is read (P2: the column model must not depend on a read's rows). */
  data: Pick<ChannelScopePage, 'scope'> | null
  gridColumns: SheetColumn[]
  formulaWiring: FormulaWiring<ChannelSheetRow>
  accountId?: string
  productLevelOnly: boolean
  refusedReasonFor: (rowId: string, key: string) => string | null
  /** The listing alias's label, or null — read at paint time for the marks' sentences (`CascadeCell`). */
  aliasLabelOf?: (aliasId: string | null) => string | null
  tracker: CellSaveTracker
  activeCellsRef: { current: { byRow: Record<string, string[]> } | null }
  viewCtx: ViewContext
  mediaEditor: ReturnType<typeof useProductMediaEditor>
  shopifyEditor: ReturnType<typeof useShopifyDraftCell>
  shopifySchema?: ShopifyStoreSchema | null
  auth: { has: (permission: string) => boolean }
}

/** Channel field factory, beside buildMasterColumns. The host owns only lifecycle and live refs. */
export function buildChannelColumns(options: BuildChannelColumnsOptions): ColDef<ChannelSheetRow>[] {
  const { data, gridColumns, formulaWiring, accountId, productLevelOnly, refusedReasonFor, aliasLabelOf,
    tracker, activeCellsRef, viewCtx, mediaEditor, shopifyEditor, shopifySchema, auth } = options
  if (!data) return []
  /* 2026-10-04 (channel cell marks) — the ONE channel verdict (`channelCellProvenance`) for the tint, the mark
     (`CascadeCell`), the bullets mark and Cell details. `drawsRequired` is the value branch's own rule, so an empty
     required cell is judged here exactly as the cell draws it. */
  const columnByKey = new Map(gridColumns.map(c => [c.key, c]))
  /* One verdict per cell per render pass: `provenanceClassRules` asks once per class key (15 of them), so the verdict is
     remembered on the cell object, keyed on what else it reads — the formula refusal and the row's values (a required
     rule may read other cells). A save replaces the cell object (and `row.values`), which forgets it. */
  const verdicts = new WeakMap<object, { values: object; refusedReason: string | null; member: CellProvenance }>()
  const provenanceOf = (row: ChannelSheetRow, key: string): CellProvenance => {
    const cell = row.values?.[key]
    if (!cell) return 'own'
    const refusedReason = refusedReasonFor(row.rowId, key)
    const known = verdicts.get(cell)
    if (known && known.values === row.values && known.refusedReason === refusedReason) return known.member
    const column = columnByKey.get(key)
    const member = channelCellProvenance(cell, { productLevelOnly, refusedReason, shape: column?.shape,
      drawsRequired: !!column && channelCellDrawsRequired(column, row, cell) })
    verdicts.set(cell, { values: row.values, refusedReason, member })
    return member
  }
  /* The mark's text for one cell — `from`, and the whole sentence when a reusable rule authors the value — the words
     `CascadeCell` gives its mark, for the bullets cell's and the theme cell's marks. */
  const markOf = (row: ChannelSheetRow, key: string) => {
    const cell = row.values?.[key], column = columnByKey.get(key)
    return channelCellMark(cell, provenanceOf(row, key), { refusedReason: refusedReasonFor(row.rowId, key), row,
      aliasLabel: () => aliasLabelOf?.(row.aliasId) ?? null, drawsRequired: !!column && channelCellDrawsRequired(column, row, cell) })
  }
  const fields: ColDef<ChannelSheetRow>[] = gridColumns.map((col) => ({
    colId: col.key,
    cellClass: 'nds-ag-cell',
    headerName: col.label,
    headerTooltip: col.helpText ?? `${col.label} — ${col.group}`,
    width: col.width ?? 180,
    suppressKeyboardEvent: suppressFormulaKeys,
    ...(col.kind === 'longtext'
      ? longTextEditor()
      : col.kind === 'select'
        ? selectEditor((col.options ?? []).map((o) => ({ value: o, label: col.optionLabels?.[o] ?? o })))
        : col.kind === 'boolean'
          ? selectEditor(BOOLEAN_OPTIONS)
          : col.kind === 'number'
            /* R-63 — no static editor: the selector below ALWAYS decides on this sheet (the formula-aware popup where a
               formula is available, the same popup with formulas off where not). A static editor's params would be
               merged into the selector's by AG and turn `=` off — the 2026-09-24 regression. */
            ? { ...numericColumn }
            : {}),
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
            params: { maxLength: textLimitFor(colForRow.maxLength) },
          }
        : colForRow.kind === 'select'
          ? {
              component: SelectPanelEditor,
              params: {
                options: (colForRow.options ?? []).map((o) => ({ value: o, label: colForRow.optionLabels?.[o] ?? o })),
                // An open channel list (eBay FREE_TEXT, an Amazon open enum) takes a typed value (#27).
                allowCustom: colForRow.mode === 'open',
                emptyLabel: SELECT_CLEAR_LABEL,
              },
            }
          : colForRow.kind === 'boolean'
            ? {
                component: SelectPanelEditor,
                params: { options: BOOLEAN_OPTIONS },
              }
            : colForRow.kind === 'number'
              ? 
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
    ...scalarColumnDef<ChannelSheetRow>(col),
    ...referenceColumnDef<ChannelSheetRow>(col, row => row.values[col.key]?.value),
    ...((col.kind === 'select' || col.kind === 'boolean' || isReferenceField(col.key)) && !isShaped(col) ? { cellClass: `nds-ag-cell ${SELECT_CELL_CLASS}` } : {}),
    valueGetter: (p: ValueGetterParams<ChannelSheetRow>) => p.data?.values?.[col.key]?.value ?? null,
    valueSetter: (p: ValueSetterParams<ChannelSheetRow>) => {
      const prev = p.data?.values?.[col.key]
      if (!p.data || !prev) return false
      // reference_ag_value_setter_must_mutate_params_data — AG reads the row back off params.data.
      // Typing into a cell pins it at this row's layer, which is what the server will report back (`optimisticCell`:
      // an eBay listing-level value keeps its source; the server's cell is remembered for the in-place settle).
      const value = parseReferenceOrScalarValue(columnForCategory(col, data?.scope.label ?? '', p.data.productType ?? null), p.newValue)
      p.data.values = { ...p.data.values, [col.key]: optimisticCell(prev, value, p.data.rowKind) }
      return true
    },
    ...(Array.isArray(col.validation?.recordFields) ? { valueParser: (p: { newValue: unknown }) => parseRecordValue(p.newValue), valueFormatter: (p: { value: unknown }) => recordSummary(p.value, col.validation!.recordFields as any) } : {}),
    cellRenderer: CascadeCell,
    /* 2026-10-04 — the Shared scope's rule on every channel: a mark only where the cell differs from the Shared product
       or its next action differs (`channelCellProvenance`); Cell details explains every cell, marked or not. */
    cellRendererParams: { column: col, productLevelOnly, refusedReasonFor, tracker, aliasLabelOf },
    cellClassRules: composeSheetCellClassRules<ChannelSheetRow>({
      validation: channelValidation(col),
      // The tint is PES.2's (hub ruling #11) — one definition of what each member looks like — fed the same verdict
      // the mark draws. The run-level mapping fact (`productLevelOnly`) rides into it: without it `mappedShared` is
      // unreachable.
      provenance: provenanceClassRules<ChannelSheetRow>(provenanceOf),
      roundTrip: roundTripClassRules<ChannelSheetRow>(tracker, (d) => d.rowId),
      extra: {
      'nds-cell-is-editable': (p) => isCellEditable(p.data?.values?.[col.key]),
      'nds-cell-is-locked': (p) => !isCellEditable(p.data?.values?.[col.key]),
      // While a chip is active, mark the exact cells it counted. Filtering to the ROWS alone
      // would leave the operator hunting for which of 102 columns was the reason.
      'nds-cell-chip-hit': (p) =>
        !!activeCellsRef.current && !!p.data &&
        chipHasCell(activeCellsRef.current, p.data.rowId, col.key),
      },
    }),
    /**
     * 🔴 VT.2 — the `Variation theme` column, from the ENGINE, spread by BOTH builders (the twin of
     * the branch in `master/columns.tsx`). LAST in the literal on purpose: it must override
     * `cellRenderer: CascadeCell`, the scalar `valueFormatter` and the `valueSetter` above, because a
     * projection is not a scalar this row stores — the editor reports a whole `VariationThemeCell` and
     * `variationThemeColumnDef` owns every one of those pieces for both sheets at once
     * (`reference_two_column_builders_drift`).
     */
    ...(col.kind === 'variationTheme'
      ? { ...variationThemeColumnDef<ChannelSheetRow>(col, (d) => d.values?.[col.key]?.value, composeSheetCellClassRules<ChannelSheetRow>({
          validation: channelValidation(col),
          provenance: provenanceClassRules<ChannelSheetRow>(provenanceOf),
          roundTrip: roundTripClassRules<ChannelSheetRow>(tracker, (d) => d.rowId),
        }) as never,
        /* 2026-10-04 — the theme's mark and tint from the SHEET verdict, the one Cell details and the other tints read: a
           theme derived from the family axes follows the Shared product (no mark); only an override is ✎. A cause
           (attention, pending, a refusal) reads the sheet's sentence, as every other cell's mark does. */
        (row) => provenanceOf(row, col.key), (row) => markOf(row, col.key)), cellEditorParams: CHANNEL_VARIATION_EDITOR_PARAMS }
      : {}),
    /**
     * Amazon sheet gaps — Mode / Qty / Buffer are the MATRIX's columns (`matrixColumnDef` over the row's own Matrix
     * cells, written through the Matrix door), and the ASIN is its own read-only cell. LAST for the same reason as the
     * theme: each owns the renderer, the setter, the text and the editor, and clears this builder's formula selector.
     */
    ...(col.kind === 'stockControl' ? stockColumnDef(col, { tracker, scope: data.scope }) : {}),
    ...(col.key === LISTING_ASIN_KEY ? asinColumnDef(col, data.scope.marketplace) : {}),
  }))
  const rank = new Map(orderColumnKeys(gridColumns as never, viewCtx).map((k, i) => [k, i]))
  const ordered = fields
    .map((c, i) => ({ c, r: rankOfColumn(c, rank), i }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c)
  const byId = new Map(ordered.map(c => [c.colId, c]))
  return ordered.map(column => {
    if (column.colId === PRODUCT_MEDIA_COLUMN) return productMediaColumn<ChannelSheetRow>(mediaEditor.open, mediaEditor.actions)
    const definition = gridColumns.find(c => c.key === column.colId)
    /* Step 4.3 #3 (A-52, R-55) — the one bullets cell: the ENGINE's whole ColDef, never spread over the column built
       above (that one carries this builder's formula SELECTOR, which would beat the editor). Each position writes
       through that slot column's own setter, so an edit here is exactly a slot typed there. */
    const slotGroup = (definition as SlotColumnLike | undefined)?.slotGroup
    if (definition && slotGroup) {
      const first = gridColumns.find(c => c.key === slotGroup.keys[0])
      return slotListColumnDef<ChannelSheetRow>(slotGroup, {
        label: definition.label, itemLabel: SLOT_LIST_FIELDS[slotGroup.of]?.itemLabel, width: definition.width, headerTooltip: definition.helpText,
        cellOf: (row, key) => row.values?.[key],
        setSlot: (row, key, value) => {
          const setter = byId.get(key)?.valueSetter
          return typeof setter === 'function' ? !!setter({ data: row, newValue: value, oldValue: row.values?.[key]?.value } as never) : false
        },
        rowIdOf: (row) => row.rowId,
        tracker,
        provenanceOf,
        // A uniform list's mark reads its first filled position's text — the words that position's own cell gives.
        markOf,
        // The empty list draws `⚠ required` by the cell's own rule: its first position's (`channelCellDrawsRequired`).
        required: (row) => !!first && channelCellDrawsRequired(first, row, row.values?.[first.key]),
      })
    }
    if (definition?.shopifyField && !shopifySchema) return { ...column, editable: false }
    return definition?.shopifyField && shopifySchema ? { ...column, ...shopifyDraftColumn(definition, shopifyEditor.open, shopifyEditor.closed, shopifyEditor.historyRefused),
      /* The cell's action (`CascadeCell`'s `CellAction`, `revealOnRowHover`) fades in while the pointer or the focus is
         on the cell: `nds-reveal-row` is the DS's hook for that (primitives.css), carried by the cell itself. */
      cellClass: `${typeof column.cellClass === 'string' ? column.cellClass : 'nds-ag-cell'} nds-reveal-row`,
      // Its value setter reads the Shopify draft history's private undo values (`shopify/draftHistory.ts`).
      context: { ...((column as { context?: object }).context ?? {}), readsHistoryValue: true },
      editable: p => !!p.data?.values[definition.key]?.writable && auth.has('products.edit') && (definition.shopifyField?.id !== 'inventory' || auth.has('inventory.adjust')),
      cellRendererParams: { ...column.cellRendererParams, openEditor: shopifyEditor.open, formattedPreview: true,
        suppressMouseEventHandling: (p: { event: MouseEvent }) => p.event.target instanceof Element && !!p.event.target.closest('[data-nds-cell-action]') },
    } : column
  })
}
