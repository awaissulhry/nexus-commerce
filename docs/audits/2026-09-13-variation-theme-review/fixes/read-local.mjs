// Read-only local HTTP evidence. No catalog writes or provider publication.
import fs from 'node:fs/promises'
const product = 'cmokmy3a40078pm0p1fvnu523'
if (process.argv.includes('--database')) {
  const { createRequire } = await import('node:module')
  const require = createRequire(new URL('../../../../package.json', import.meta.url))
  const env = require('dotenv').parse(await fs.readFile(new URL('../../../../apps/api/.env', import.meta.url)))
  const url = new URL(env.DATABASE_URL)
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/nexus_development') throw new Error('Local database guard refused')
  const db = new (require('pg').Client)({ connectionString: env.DATABASE_URL })
  await db.connect()
  try {
    const listings = (await db.query(`SELECT channel, marketplace, version, "platformAttributes"->>'categoryId' AS category, "platformAttributes"->>'ebayCategoryId' AS "ebayCategory", "platformAttributes"->>'taxonomy_id' AS taxonomy, "platformAttributes"->>'taxonomyId' AS "taxonomyId" FROM "ChannelListing" WHERE "productId"=$1 AND "workspaceId"='nexus_legacy_workspace' AND "aliasKey"=''`, [product])).rows
    const categories = listings.filter(l=>l.channel==='EBAY').map(l=>l.category||l.ebayCategory).filter(Boolean)
    const schemas = (await db.query(`SELECT channel, marketplace, "productType", "isActive", "fetchedAt", jsonb_typeof("schemaDefinition"->'aspects') AS aspects FROM "CategorySchema" WHERE channel='EBAY' AND "productType"=ANY($1::text[]) AND "workspaceId"='nexus_legacy_workspace'`, [categories])).rows
    const fixtures = (await db.query(`SELECT count(*)::int AS remaining FROM "Product" WHERE id LIKE 'vt-quality-%'`)).rows
    const evidence={listings,schemas,fixtures}; await fs.writeFile(new URL('./database-read.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n'); console.log(JSON.stringify(evidence))
  } finally { await db.end() }
  process.exit(0)
}
const scopes = [
  { channel: null, market: 'IT' },
  { channel: 'AMAZON', market: 'IT', accountId: 'cmothu9bo0000nz01asw6wx8j' },
  { channel: 'AMAZON', market: 'DE', accountId: 'cmothu9bo0000nz01asw6wx8j' },
  { channel: 'EBAY', market: 'IT', accountId: 'cmr4aaqb00025nz016k18rup9' },
  { channel: 'SHOPIFY', market: 'GLOBAL', accountId: 'cmtugfpaa0006njhq8m2nvnxx' },
  { channel: 'ETSY', market: 'GLOBAL', accountId: 'cmtvy3wta00fjnjpxl22lly3k' },
]
const results = []
for (const scope of scopes) {
  const query = new URLSearchParams({ market: scope.market })
  if (scope.channel) { query.set('scope', 'channel'); query.set('channel', scope.channel) }
  if (scope.accountId) query.set('accountId', scope.accountId)
  for (const endpoint of scope.channel ? ['sheet', 'projection'] : ['sheet']) {
    const start = performance.now()
    try {
      const response = await fetch(`http://127.0.0.1:8091/api/products/${product}/studio/${endpoint}?${query}`, { signal: AbortSignal.timeout(60000) })
      const body = await response.json()
      if (endpoint === 'sheet' && scope.channel === 'ETSY') console.log(JSON.stringify({ etsyScope: body.scope }))
      const result = { scope, endpoint, status: response.status, ms: Math.round(performance.now() - start) }
      if (endpoint === 'sheet') {
        const rows = body.rows ?? []
        const parent = rows.find(r => r.id === product && !r.aliasId)
        const cell = parent?.values?.variation_theme?.value
        Object.assign(result, {
          columns: (body.columns ?? []).filter(c => c.kind === 'variationTheme' || c.key === 'variationTheme').map(c => ({ key: c.key, kind: c.kind, width: c.width, shape: c.shape })),
          cell: cell ? { theme: cell.theme, source: cell.source, deliveryNote: cell.deliveryNote, axes: cell.axes, dropped: cell.dropped, collisions: cell.collisions, candidatesState: cell.candidates?.state, candidateCount: cell.candidates?.items.length, writable: cell.writable, expectedVersion: cell.write?.expectedVersion } : null,
          childThemeNonNull: rows.filter(r => r.parentId && r.values?.variation_theme?.value != null).length,
          rowCount: rows.length, error: body.error,
        })
      } else Object.assign(result, { version: body.version, theme: body.theme?.value, mapping: body.mapping, collisions: body.collisions ? { unresolved: body.collisions.unresolved, summary: body.collisions.summary } : null, error: body.error })
      results.push(result)
      console.log(JSON.stringify(result))
    } catch (error) {
      results.push({ scope, endpoint, error: String(error) }); console.log(JSON.stringify(results.at(-1)))
    }
  }
}
await fs.writeFile(new URL('./local-read-results.json', import.meta.url), JSON.stringify(results, null, 2) + '\n')
