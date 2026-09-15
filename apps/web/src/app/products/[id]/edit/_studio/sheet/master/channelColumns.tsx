'use client'
import { scalarColumnDef, BOOLEAN_OPTIONS, SHEET_NUMBER_EDITOR_PARAMS } from '@/design-system/grid/editors/scalarValue'
import { columnForCategory, columnApplies } from '@nexus/shared/master-sheet'
import { EbayPolicyEditor, isEbayPolicyField } from '../EbayPolicyInput'
import { ChannelCategoryEditor } from '../ChannelCategoryEditor'
import { StructuredAttributeEditor, parseRecordValue, recordSummary } from '../StructuredAttributeEditor'
import { CascadeCell } from '../channel/CascadeCell'
import { isCellEditable, withMappingRun } from '../channel/rows'
import { chipHasCell } from '../channel/viewChips'
import { parseReferenceOrScalarValue, referenceColumnDef } from '../referenceLabels'
import { isReferenceField } from '../referenceOptions'
import { ReferenceSelectEditor } from '../ReferenceSelectEditor'
import { orderColumnKeys, rankOfColumn, type ViewContext } from '../views'
import { productMediaColumn, PRODUCT_MEDIA_COLUMN, type useProductMediaEditor } from '../../media/productMediaColumn'
import { shopifyDraftColumn, type useShopifyDraftCell } from '../../shopify/ShopifyDraftCell'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import type { ChannelSheetRow, SheetColumn, ChannelScopePage } from '../channel/types'
import {
  classifyProvenance, provenanceClassRules, roundTripClassRules, type CellSaveTracker,
  type ColDef, type ValueGetterParams, type ValueSetterParams, type FormulaWiring,
  longTextEditor, selectEditor, SELECT_CELL_CLASS, formulaCellEditorSelector, numericColumn,
  sheetValidationFor, composeSheetCellClassRules, shapeColumnDef, shapeEditorSpec, isShaped,
  suppressFormulaKeys, SelectPanelEditor, variationThemeColumnDef,
} from '@/design-system/grid'

export const channelValidation = (col: SheetColumn) => sheetValidationFor<ChannelSheetRow>(col, row => columnApplies(col, row))

export interface BuildChannelColumnsOptions {
  data: ChannelScopePage | null
  gridColumns: SheetColumn[]
  formulaWiring: FormulaWiring<ChannelSheetRow>
  accountId?: string
  openCellDetails: (row: ChannelSheetRow, column: SheetColumn) => void
  productLevelOnly: boolean
  refusedReasonFor: (rowId: string, key: string) => string | null
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
  const { data, gridColumns, formulaWiring, accountId, openCellDetails, productLevelOnly, refusedReasonFor,
    tracker, activeCellsRef, viewCtx, mediaEditor, shopifyEditor, shopifySchema, auth } = options
  if (!data) return []
  const fields: ColDef<ChannelSheetRow>[] = gridColumns.map((col) => ({
    colId: col.key,
    cellClass: 'nds-ag-cell',
    headerName: col.label,
    headerTooltip: col.helpText ?? `${col.label} — ${col.group}`,
    width: col.width ?? 180,
    suppressKeyboardEvent: suppressFormulaKeys,
    ...(col.kind === 'longtext'
      ? longTextEditor(col.maxLength ? { maxLength: Math.max(col.maxLength, 200) } : {})
      : col.kind === 'select'
        ? selectEditor((col.options ?? []).map((o) => ({ value: o, label: col.optionLabels?.[o] ?? o })))
        : col.kind === 'boolean'
          ? selectEditor(BOOLEAN_OPTIONS)
          : col.kind === 'number'
            ? { ...numericColumn, cellEditor: 'agNumberCellEditor', cellEditorParams: SHEET_NUMBER_EDITOR_PARAMS }
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
    cellRendererParams: { column: col, onDetails: openCellDetails, productLevelOnly, refusedReasonFor, tracker,
      hideRoutineSourceIndicators: ['EBAY', 'AMAZON', 'SHOPIFY'].includes(data.scope.channel) },
    cellClassRules: composeSheetCellClassRules<ChannelSheetRow>({
      validation: channelValidation(col),
      // The tint is PES.2's too (hub ruling #11) — one definition of what "inherited" looks like.
      // The run-level mapping fact travels with the cell — see `withMappingRun`. Without it
      // `mappedShared` is unreachable and 15 of 21 Amazon·IT cells mis-classify as `mapped`.
      provenance: provenanceClassRules<ChannelSheetRow>((d, colId) =>
        classifyProvenance(
          { ...withMappingRun(d.values?.[colId], productLevelOnly), refusedReason: refusedReasonFor(d.rowId, colId) },
          'channel',
        ),
      ),
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
      ? variationThemeColumnDef<ChannelSheetRow>(col, (d) => d.values?.[col.key]?.value, composeSheetCellClassRules<ChannelSheetRow>({
          validation: channelValidation(col),
          provenance: provenanceClassRules<ChannelSheetRow>((d, colId) =>
            classifyProvenance({ ...withMappingRun(d.values?.[colId], productLevelOnly), refusedReason: refusedReasonFor(d.rowId, colId) }, 'channel')),
          roundTrip: roundTripClassRules<ChannelSheetRow>(tracker, (d) => d.rowId),
        }) as never)
      : {}),
  }))
  const rank = new Map(orderColumnKeys(gridColumns as never, viewCtx).map((k, i) => [k, i]))
  const ordered = fields
    .map((c, i) => ({ c, r: rankOfColumn(c, rank), i }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c)
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
}
