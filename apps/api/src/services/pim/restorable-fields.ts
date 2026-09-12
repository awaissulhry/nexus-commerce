/**
 * The master fields `POST /api/products/:id/restore` will actually write.
 *
 * Extracted so there is ONE definition. The restore route filters its incoming
 * `fields` against this set, and the restore-points read (#364) marks which
 * recorded changes can actually be restored — if those two lists were separate
 * copies they would drift, and the drawer would offer a moment the endpoint then
 * silently declines to write.
 *
 * ⚠ Deliberately narrow, and worth knowing before offering a restore UI: it is
 * master scalar columns only. `attr_*` category attributes, locale-prefixed keys
 * (`de.description`), and `sku` are NOT restorable through this path, and they
 * are a large share of what the audit trail actually records.
 */
export const RESTORABLE_MASTER_FIELDS: ReadonlySet<string> = new Set([
  'name', 'description', 'status', 'basePrice', 'costPrice', 'minPrice', 'maxPrice',
  'brand', 'manufacturer', 'ean', 'gtin', 'upc', 'productType',
  'bulletPoints', 'keywords', 'weightValue', 'weightUnit',
  'dimLength', 'dimWidth', 'dimHeight', 'dimUnit',
  'hsCode', 'countryOfOrigin', 'totalStock', 'lowStockThreshold',
])
