/** Read-only live verification: sheet reads and bulk validation with dryRun=true. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

const base = process.env.ATTRIBUTE_QA_API ?? 'http://localhost:8091'
const id = process.env.ATTRIBUTE_QA_PRODUCT ?? 'cmokmy3a40078pm0p1fvnu523'
async function request(path: string, body?: unknown) {
  const response = await fetch(`${base}/api/${path}`, body ? { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) } : { signal: AbortSignal.timeout(45000) })
  const result = await response.json()
  assert(response.ok, `${path}: ${response.status} ${JSON.stringify(result)}`)
  return result as any
}
const sheets = await Promise.all(['master', 'AMAZON', 'EBAY'].map(async scope => {
  const query = scope === 'master' ? 'scope=master' : `scope=channel&channel=${scope}`
  const sheet = await request(`products/${id}/studio/sheet?${query}&market=IT&locale=it`)
  await writeFile(`/tmp/nexus-foundation-${scope.toLowerCase()}.json`, JSON.stringify(sheet, null, 2))
  assert.equal(new Set(sheet.columns.map((c: any) => c.key)).size, sheet.columns.length, `${scope}: duplicate keys`)
  assert.equal(new Set(sheet.columns.map((c: any) => c.label.toLowerCase())).size, sheet.columns.length, `${scope}: duplicate labels`)
  for (const row of sheet.rows) for (const column of sheet.columns) {
    const cell = row.values[column.key]
    assert(cell, `${scope}: missing declared cell ${column.key}`)
    if (scope !== 'master' && cell.editable && cell.writable) assert.equal(cell.writeTarget, 'channelListing', `${scope}: ${column.key} edits Master`)
    if (cell.mapped?.status === 'mapped') assert.deepEqual(cell.value, cell.mapped.value, `${scope}: ${column.key} differs from mapping preview`)
  }
  for (const row of sheet.rows) {
    const blocked = new Set(row.readiness.issues.filter((issue: any) => issue.severity === 'error').map((issue: any) => issue.key))
    for (const issue of row.readiness.issues) if (issue.severity === 'warn') assert(!blocked.has(issue.key), `${scope}: duplicate warning and error for ${issue.key}`)
  }
  return sheet
}))
const child = sheets[0].rows.find((row: any) => row.parentId)?.id ?? id
const cases: Array<{ name: string; field: string; value: unknown; channel?: string; rejects?: boolean; multi?: boolean }> = [
  { name: 'family material', field: 'attr_material', value: 'QA material' },
  { name: 'shared bullets beyond legacy limit', field: 'bulletPoints', value: Array.from({ length: 21 }, (_, i) => `Bullet ${i + 1}`) },
  { name: 'reject structured records in text bullets', field: 'bulletPoints', value: [{ text: 'Do not stringify or discard me' }], rejects: true },
  { name: 'protector records', field: 'impactProtectors', value: [{ zone: 'shoulder', standard: 'EN 1621-1', level: '2' }, { zone: 'elbow', standard: 'EN 1621-1', level: '1' }] },
  { name: 'native PPE enum', field: 'ppeCategory', value: 'CAT_II' },
  { name: 'invalid PPE enum', field: 'ppeCategory', value: 'II', rejects: true },
  { name: 'eBay title boundary', field: 'ebay_title', value: 'x'.repeat(80), channel: 'EBAY' },
  { name: 'eBay title over boundary', field: 'ebay_title', value: 'x'.repeat(81), channel: 'EBAY', rejects: true },
  { name: 'eBay brand store', field: 'attr_brand', value: 'QA brand', channel: 'EBAY' },
  { name: 'eBay price', field: 'ebay_price', value: 25.5, channel: 'EBAY' },
  { name: 'eBay zero quantity', field: 'ebay_quantity', value: 0, channel: 'EBAY' },
  { name: 'eBay fractional quantity', field: 'ebay_quantity', value: 1.5, channel: 'EBAY', rejects: true },
  { name: 'eBay typed false', field: 'attr_bestOffer', value: false, channel: 'EBAY' },
  { name: 'eBay legacy condition', field: 'attr_conditionId', value: '1000', channel: 'EBAY' },
  { name: 'unknown eBay attribute', field: 'attr_not_a_category_attribute', value: 'x', channel: 'EBAY', rejects: true },
  { name: 'foreign Amazon field', field: 'attr_subtitle', value: 'x', channel: 'AMAZON', rejects: true },
  { name: 'ambiguous attribute fanout', field: 'attr_brand', value: 'QA brand', channel: 'EBAY', multi: true, rejects: true },
  { name: 'Amazon oversized slot', field: 'amazon_bulletPoints[1001]', value: 'x', channel: 'AMAZON', rejects: true },
]
const checks = []
for (const test of cases) {
  const result = await request('products/bulk', {
    dryRun: true,
    marketplaceContexts: test.channel ? [{ channel: test.channel, marketplace: 'IT' }, ...(test.multi ? [{ channel: 'AMAZON', marketplace: 'IT' }] : [])] : [{ marketplace: 'IT', locale: 'it' }],
    changes: [{ id: child, field: test.field, value: test.value, ...(test.channel ? { target: 'channel' } : {}) }],
  })
  assert.equal(result.dryRun, true, `${test.name}: did not confirm dry run`)
  assert.equal(result.errors.length > 0, !!test.rejects, `${test.name}: ${JSON.stringify(result)}`)
  checks.push({ name: test.name, result: test.rejects ? 'correctly refused' : 'accepted', errors: result.errors })
}
const result = { scopes: sheets.map(sheet => ({ scope: sheet.scope.label, columns: sheet.columns.length, rows: sheet.rows.length, groups: sheet.groups.map((g: any) => g.label), missing: sheet.meta.schemaMissing, schemaAge: sheet.meta.schemaAge })), checks, productValuesChanged: 0 }
await writeFile('/tmp/nexus-foundation-live-verification.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
