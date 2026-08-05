/** Reproduce the owner's import: file rows × CURRENT grid rows → planFamilyImport.
 *  Finds same-family duplicate SKUs the merge would produce. */
import { readFile } from 'node:fs/promises'
const { parseXlsx } = await import('../src/services/import/parsers.js')
const { planFamilyImport } = await import('../../web/src/app/products/ebay-flat-file/importFamilies.pure.js')
const { default: Fastify } = await import('fastify')
const { default: routes } = await import('../src/routes/ebay-flat-file.routes.js')

// 1. Parse + minimally map the file (headers → colIds like the wizard would)
const bytes = new Uint8Array(await readFile('/Users/awais/Downloads/GALE eBay IT - 5 listings XXS-5XL (import).xlsx'))
const parsed = await parseXlsx(bytes)
const H: Record<string, string> = {
  'SKU': 'sku', 'Parent/Child': 'parentage', 'Parent SKU': 'parent_sku',
  'Item ID': 'it_item_id', 'Variation Theme': 'variation_theme',
  'Shared-SKU (Trading API)': 'shared_sku_listing', 'Title': 'title',
  'Price (EUR)': 'it_price', 'Quantity': 'it_qty',
}
const mapped = (parsed.rows as Array<Record<string, unknown>>).map((src) => {
  const out: Record<string, unknown> = {}
  for (const [h, col] of Object.entries(H)) if (src[h] !== undefined) out[col] = src[h]
  if (typeof out.shared_sku_listing === 'string') out.shared_sku_listing = /^true$/i.test(out.shared_sku_listing as string)
  if (typeof out.parentage === 'string') out.parentage = (out.parentage as string).toLowerCase()
  return out
})

// 2. Current grid rows from the real GET /rows
const app = Fastify({ logger: false })
await app.register(routes)
await app.ready()
const r = await app.inject({ method: 'GET', url: '/ebay/flat-file/rows?familyId=cmokmy3a40078pm0p1fvnu523&marketplace=IT' })
const gridRows = ((r.json() as any).rows ?? []) as Array<Record<string, unknown>>
await app.close()

// 3. Plan the merge
const actions = planFamilyImport(mapped, gridRows)
const adds = actions.filter((a: any) => a.kind === 'add')
const updates = actions.filter((a: any) => a.kind === 'update')
console.log(`grid=${gridRows.length} file=${mapped.length} → updates=${updates.length} adds=${adds.length}`)
const addsByFamily = new Map<string, string[]>()
for (const a of adds as any[]) {
  const fam = a.parent?.sku ?? (a.isParent ? '(as parent)' : '(orphan)')
  if (!addsByFamily.has(fam)) addsByFamily.set(fam, [])
  addsByFamily.get(fam)!.push(String(a.imp.sku))
}
for (const [fam, skus] of addsByFamily) console.log(`  ADD under ${fam}: ${skus.length} → ${skus.slice(0, 5).join(', ')}${skus.length > 5 ? '…' : ''}`)
// 4. Post-merge duplicate check: same (family, sku) twice
const famOf = (row: any) => String(row.parent_sku || row.platformProductId || (row._isParent ? row.sku : ''))
const seen = new Map<string, number>()
for (const g of gridRows) if (!g._isParent) { const k = `${famOf(g)}|${g.sku}`; seen.set(k, (seen.get(k) ?? 0) + 1) }
for (const a of adds as any[]) if (!a.isParent) { const k = `${a.parent?.sku ?? ''}|${a.imp.sku}`; seen.set(k, (seen.get(k) ?? 0) + 1) }
const dups = [...seen].filter(([, n]) => n > 1)
console.log(`post-merge same-family duplicate (family|sku): ${dups.length}`)
for (const [k, n] of dups.slice(0, 8)) console.log(`  ${n}× ${k}`)
process.exit(0)
