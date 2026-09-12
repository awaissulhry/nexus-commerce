#!/usr/bin/env node
/** Read-only integration guard: compare both Variants states with the Information sheet on exact coordinates. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
const base = process.env.STUDIO_API_BASE ?? 'http://localhost:8091'
const product = process.env.CENSUS_PRODUCT ?? 'cmokmy3a40078pm0p1fvnu523'
const market = process.env.VARIANTS_MARKET ?? 'IT'
const locale = process.env.VARIANTS_LOCALE ?? 'it'
const read = async (path, query = {}) => {
  const response = await fetch(`${base}/api/products/${product}/${path}?${new URLSearchParams({ market, locale, ...query })}`, { signal: AbortSignal.timeout(120000) })
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`)
  return response.json()
}
const report = { at: new Date().toISOString(), product, market, locale, coordinates: [], failures: [] }
try {
  const family = await read('studio/family')
  const master = await read('studio/sheet', { scope: 'master' })
  const complete = (row, sheet) => sheet.meta.schemaMissing.length || !row.completeness.required.total ? null : row.completeness.overall.pct
  for (const child of [family.parent, ...family.children]) {
    const row = master.rows.find(row => row.id === child.id)
    assert.ok(row, `Missing master row ${child.sku}`)
    assert.equal(child.completeness?.pct, complete(row, master), `${child.sku}: master completeness`)
  }
  report.coordinates.push({ channel: 'master', rows: family.children.length + 1 })
  const connected = family.channels.filter(channel => channel.connected && channel.accountId)
  assert.ok(connected.length, 'No attributed channel measured')
  for (const coordinate of connected) {
    const query = { channel: coordinate.channel, market: coordinate.market, accountId: coordinate.accountId, aliasKey: '' }
    const projection = await read('studio/projection', query)
    const sheet = await read('studio/sheet', { ...query, scope: 'channel' })
    assert.equal(projection.coordinate.accountId, coordinate.accountId, 'Account changed during projection')
    assert.deepEqual(projection.children.map(child => child.id), family.children.map(child => child.id), `${coordinate.channel}: row order`)
    for (const [axis, column] of Object.entries(projection.axisColumns)) {
      assert.deepEqual(column, sheet.columns.find(item => item.key === column.key), `${coordinate.channel}/${axis}: column metadata`)
    }
    for (const child of [projection.parent, ...projection.children]) {
      const row = sheet.rows.find(row => row.id === child.id && !row.aliasId)
      assert.ok(row, `${coordinate.channel}: missing Information row ${child.sku}`)
      assert.equal(child.completeness?.pct, complete(row, sheet), `${coordinate.channel}/${child.sku}: completeness`)
      if (!child.values) continue
      const shared = family.children.find(item => item.id === child.id)
      assert.deepEqual(child.sharedAxisValues, shared.axisValues, `${child.sku}: identity values`)
      assert.deepEqual(child.axisValuesSuspect, shared.axisValuesSuspect, `${child.sku}: suspect marker`)
      for (const [axis, cell] of Object.entries(child.values)) {
        const column = projection.axisColumns[axis]
        const source = column ? row.values[column.key] : undefined
        assert.equal(cell.value, source?.value == null ? null : String(source.value), `${coordinate.channel}/${child.sku}/${axis}: resolved value`)
        if (cell.write) {
          assert.equal(cell.write.field, source.writeField, `${child.sku}/${axis}: write field`)
          assert.equal(cell.write.target, source.writeTarget, `${child.sku}/${axis}: write target`)
        }
      }
    }
    report.coordinates.push({ ...query, rows: projection.children.length + 1, axes: Object.keys(projection.axisColumns).length })
  }
} catch (error) { report.failures.push(error.message) }
writeFileSync('docs/audits/2026-09-11-variants-final/sheet-parity.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
process.exit(report.failures.length ? 1 : 0)
