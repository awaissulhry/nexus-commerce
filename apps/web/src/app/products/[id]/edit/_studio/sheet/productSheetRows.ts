export interface ProductSheetRowIdentity {
  id: string
  parentId: string | null
  rowId?: string
  rowKind?: 'parent' | 'variant'
  aliasId?: string | null
}

export const productSheetRowKey = (row: ProductSheetRowIdentity): string => row.rowId ?? row.id

export function productSheetRowPath(row: ProductSheetRowIdentity): string[] {
  if (row.rowId !== undefined) {
    const alias = row.aliasId ?? 'primary'
    return row.rowKind === 'parent' ? [alias] : [alias, row.rowId]
  }
  return row.parentId ? [row.parentId, row.id] : [row.id]
}

/** Keep matching rows and their ancestors, including each listing's own group. */
export function filterProductSheetRows<Row extends ProductSheetRowIdentity>(rows: Row[], matches: (row: Row) => boolean): Row[] {
  const paths = new Set<string>()
  for (const row of rows) {
    if (!matches(row)) continue
    const path = productSheetRowPath(row)
    for (let n = 1; n <= path.length; n++) paths.add(JSON.stringify(path.slice(0, n)))
  }
  return rows.filter(row => paths.has(JSON.stringify(productSheetRowPath(row))))
}
