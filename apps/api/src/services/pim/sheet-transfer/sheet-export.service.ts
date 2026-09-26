/**
 * PSIE — the product sheet's Export: the editing file for the products and listings the dialog chose, in the sheet
 * style (readable tabs, no action columns, short instructions). Nothing is left out silently: each thing that could not
 * go into the file is a note (a listing without an account, a store's fields not loaded yet).
 */
import type { ProductTransferSelection } from '@nexus/shared/catalog-transfer'
import prisma from '../../../db.js'
import { resolveProductTransferBoundary } from '../catalog-product-transfer.js'
import { exportCatalogTransfer } from '../catalog-transfer-export.js'
import { writeEditorWorkbook } from '../catalog-editor-workbook.js'

/** A file name a person recognises: the family's SKU and the day, e.g. `GALE-JACKET 2026-09-26.xlsx`. */
export const sheetFileName = (sku: string, extension: string, day = new Date()) => `${sku.replace(/[^\w.-]+/g, '-').slice(0, 60)} ${day.toISOString().slice(0, 10)}.${extension}`

export async function exportSheetFile(input: { productId: string; market: string; selection: ProductTransferSelection; fields?: string[]; userId: string | null }) {
  const boundary = await resolveProductTransferBoundary(input.productId, input.selection)
  const notes: string[] = []
  const file = await exportCatalogTransfer({ market: input.market, boundary, fields: input.fields, layout: 'wide', sheet: { notes },
    workbookWriter: scopes => writeEditorWorkbook(scopes, boundary, input.userId, { style: 'sheet' }) })
  const root = await prisma.product.findUnique({ where: { id: boundary.rootId }, select: { sku: true } })
  return { ...file, filename: sheetFileName(root?.sku ?? 'products', file.filename.split('.').pop() ?? 'xlsx'), notes, products: boundary.products.length, listings: boundary.listings.length }
}
