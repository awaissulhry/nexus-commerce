/** Read-only audit of every market currently exposed by the product editor. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

const base = process.env.ATTRIBUTE_QA_API ?? 'http://localhost:8091'
const productId = process.env.ATTRIBUTE_QA_PRODUCT ?? 'cmokmy3a40078pm0p1fvnu523'
const markets = ['IT', 'DE', 'FR', 'ES', 'BE', 'IE', 'NL', 'PL', 'SE', 'TR', 'UK', 'GLOBAL']
const results: any[] = []
const findings: any[] = []
for (const market of markets) {
  // Limit concurrency so schema and mapping reads do not swamp the development API.
  const batch = await Promise.allSettled(['master', 'AMAZON', 'EBAY'].map(async scope => {
    const query = new URLSearchParams({ market, scope: scope === 'master' ? 'master' : 'channel',
      ...(scope === 'master' ? {} : { channel: scope }) })
    const started = Date.now()
    const response = await fetch(`${base}/api/products/${productId}/studio/sheet?${query}`, { signal: AbortSignal.timeout(60000) })
    const sheet = await response.json() as any
    if (!response.ok) return { market, scope, status: response.status, error: sheet.error, message: sheet.message, elapsedMs: Date.now() - started }
    await writeFile(`/tmp/nexus-product-grid-market-${scope}-${market}.json`, JSON.stringify(sheet))
    const check = (ok: unknown, issue: string, detail?: unknown) => { if (!ok) findings.push({ scope, market, issue, detail }) }
    check(sheet.scope.kind === (scope === 'master' ? 'master' : 'channel'), 'wrong scope')
    if (scope !== 'master') {
      check(sheet.scope.channel === scope && sheet.scope.marketplace === market, 'wrong channel/market')
      check(!sheet.meta.mapping?.skippedReason, 'mapping unavailable', sheet.meta.mapping?.skippedReason)
    }
    check(new Set(sheet.columns.map((c: any) => c.key)).size === sheet.columns.length, 'duplicate column keys')
    check(new Set(sheet.rows.map((r: any) => `${r.id}:${r.aliasId ?? ''}`)).size === sheet.rows.length, 'duplicate row coordinates')
    let cells = 0, editable = 0, overrides = 0
    for (const row of sheet.rows) for (const column of sheet.columns) {
      cells++
      const cell = row.values[column.key]
      const detail = { sku: row.sku, key: column.key }
      check(!!cell, 'missing declared cell', detail)
      if (!cell) continue
      if (cell.writable && cell.editable) {
        editable++
        check(cell.writeTarget === (scope === 'master' ? 'master' : 'channelListing'), 'wrong write target', detail)
      }
      if (cell.mapped?.status === 'mapped') {
        try { assert.deepEqual(cell.value, cell.mapped.value) }
        catch { findings.push({ scope, market, issue: 'grid differs from mapping preview', detail }) }
      }
      if (cell.mapped?.provenance === 'override') {
        overrides++
        check(cell.pinned && cell.follows !== true, 'override reported as inherited', { ...detail, layer: cell.layer, follows: cell.follows })
      }
    }
    return { scope, market, status: response.status, columns: sheet.columns.length, rows: sheet.rows.length,
      cells, editable, overrides, locale: sheet.scope.locale, schemaMissing: sheet.meta.schemaMissing,
      mappingSkipped: sheet.meta.mapping?.skippedReason ?? null, elapsedMs: Date.now() - started,
      serverMs: sheet.meta.tookMs, phases: sheet.meta.phases,
      rowsWithErrors: sheet.rows.filter((r: any) => r.readiness.issues.some((i: any) => i.severity === 'error')).length,
      issues: [...new Set(sheet.rows.flatMap((r: any) => r.readiness.issues.map((i: any) => i.message)))],
    }
  }))
  for (let index = 0; index < batch.length; index++) {
    const result = batch[index]
    const value = result.status === 'fulfilled' ? result.value : { market, scope: ['master', 'AMAZON', 'EBAY'][index], error: String(result.reason) }
    results.push(value)
    console.log(JSON.stringify(value))
  }
}
const report = { productId, generatedAt: new Date().toISOString(), results, findings, productValuesChanged: 0 }
await writeFile('/tmp/nexus-product-grid-market-audit.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify({ scopes: results.length, findings: findings.length, productValuesChanged: 0 }))
if (findings.length || results.some(r => !r.status || r.status >= 500)) process.exitCode = 1
