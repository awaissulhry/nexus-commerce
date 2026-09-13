// Read-only local HTTP evidence. No catalog writes or provider publication.
import fs from 'node:fs/promises'
const product = 'cmokmy3a40078pm0p1fvnu523'
const scopes = [
  { channel: null, market: 'IT' },
  { channel: 'AMAZON', market: 'IT', accountId: 'cmothu9bo0000nz01asw6wx8j' },
  { channel: 'AMAZON', market: 'DE', accountId: 'cmothu9bo0000nz01asw6wx8j' },
  { channel: 'EBAY', market: 'IT', accountId: 'cmr4aaqb00025nz016k18rup9' },
  { channel: 'SHOPIFY', market: 'GLOBAL', accountId: 'cmtugfpaa0006njhq8m2nvnxx' },
  { channel: 'ETSY', market: 'GLOBAL' },
]
const results = []
for (const scope of scopes) {
  const query = new URLSearchParams({ market: scope.market })
  if (scope.channel) { query.set('scope', 'channel'); query.set('channel', scope.channel) }
  if (scope.accountId) query.set('accountId', scope.accountId)
  for (const endpoint of scope.channel ? ['sheet', 'projection'] : ['sheet']) {
    const start = performance.now()
    try {
      const response = await fetch(`http://127.0.0.1:8091/api/products/${product}/studio/${endpoint}?${query}`, { signal: AbortSignal.timeout(20000) })
      const body = await response.json()
      const result = { scope, endpoint, status: response.status, ms: Math.round(performance.now() - start) }
      if (endpoint === 'sheet') {
        const rows = body.rows ?? []
        const parent = rows.find(r => r.id === product && !r.aliasId)
        const cell = parent?.values?.variation_theme?.value
        Object.assign(result, {
          columns: (body.columns ?? []).filter(c => c.kind === 'variationTheme' || c.key === 'variationTheme').map(c => ({ key: c.key, kind: c.kind, width: c.width, shape: c.shape })),
          cell: cell ? { theme: cell.theme, source: cell.source, axes: cell.axes, dropped: cell.dropped, collisions: cell.collisions, candidatesState: cell.candidates?.state, candidateCount: cell.candidates?.items.length, writable: cell.writable, expectedVersion: cell.write?.expectedVersion } : null,
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
