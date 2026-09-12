import { formulaFillSourceIndex } from '@/design-system/grid/editors/formulaTransfer'
import { nativeFieldValueError, type NativeEdit } from '@nexus/shared/shopify-information'
import { validateShopifyField } from '@nexus/shared/shopify-linked-products'
import type { ChannelSheetRow, SheetColumn } from '../sheet/channel/types'
import type { mediaGridTransfer } from '../media/mediaGridTransfer'
import { encodeInformationTransfer, decodeInformationTransfer, transferableField } from './informationTransfer'
import { shopifyRawValue } from './ShopifyDraftCell'

export function shopifyGridTransfer(base: ReturnType<typeof mediaGridTransfer<ChannelSheetRow>>, columns: SheetColumn[], accountId: string, announce: (message: string) => void) {
  const fields = new Map(columns.filter(c => c.shopifyField).map(c => [c.key, c.shopifyField!]))
  return { ...base,
    processCellForClipboard: (p: Parameters<typeof base.processCellForClipboard>[0]) => {
      const field = fields.get(p.column.getColId())
      return field ? encodeInformationTransfer(field, shopifyRawValue(p.value), accountId) : base.processCellForClipboard(p)
    },
    processCellFromClipboard: (p: Parameters<typeof base.processCellFromClipboard>[0]) => {
      const field = fields.get(p.column.getColId()), text = String(p.value ?? '')
      const current = p.node ? p.api.getCellValue({ rowNode: p.node, colKey: p.column }) : null
      if (!field) { if (text.startsWith('NEXUS_SHOPIFY_VALUE_V1:')) { announce('This Shopify value requires a compatible Shopify field.'); return current }; return base.processCellFromClipboard(p) }
      const result = decodeInformationTransfer(text, field, accountId)
      const error = result.error ?? (field.definition ? validateShopifyField(field.definition, result.value) : nativeFieldValueError(field.id as NativeEdit['field'], result.value, shopifyRawValue(current)))
      if (error) { announce(`${field.label}: ${error}`); return current }
      return result.value
    },
    cellSelection: { handle: { ...base.cellSelection.handle, setFillValue: (p: Parameters<typeof base.cellSelection.handle.setFillValue>[0]) => {
      const count = p.initialValues.length, vertical = p.direction === 'up' || p.direction === 'down', displayed = p.api.getAllDisplayedColumns()
      const targetIndex = vertical ? p.rowNode.rowIndex : displayed.indexOf(p.column)
      if (!count || targetIndex == null || targetIndex < 0) return p.currentCellValue
      const index = formulaFillSourceIndex(targetIndex, p.currentIndex, count, p.direction)
      const source = vertical ? p.api.getDisplayedRowAtIndex(index) : p.rowNode, sourceColumn = vertical ? p.column : displayed[index]
      const field = fields.get(p.column.getColId()), from = sourceColumn && fields.get(sourceColumn.getColId())
      if (!field && !from) return base.cellSelection.handle.setFillValue(p)
      if (!field || !from || !source || !sourceColumn || field.type !== from.type || !!field.definition !== !!from.definition || !transferableField(field)) return p.currentCellValue
      const value = shopifyRawValue(p.api.getCellValue({ rowNode: source, colKey: sourceColumn }))
      const error = field.definition ? validateShopifyField(field.definition, value) : nativeFieldValueError(field.id as NativeEdit['field'], value, shopifyRawValue(p.currentCellValue))
      if (error) { announce(`${field.label}: ${error}`); return p.currentCellValue }
      return value
    } } },
  }
}
