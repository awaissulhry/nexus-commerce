/** Real saves, exact read-back and restoration; no failed/no-op write can pass as a cheap bulk operation. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { ApiRow, SheetRead } from './grid'

interface Counts { trips: number; statements: number }
interface Family { family: string; connection: string }

export async function checkBulkSql(app: FastifyInstance, family: Family, headers: Record<string, string>, count: () => Counts) {
  assert(family?.family.startsWith('e2e_sheet_'), 'bulk SQL writes require the synthetic speed family')
  assert(family.connection, 'the speed family must name its synthetic channel account')
  const path = `/api/products/${family.family}/studio/sheet?scope=channel&channel=EBAY&market=IT&accountId=${family.connection}&locale=it`
  const read = async (): Promise<SheetRead> => {
    const response = await app.inject({ method: 'GET', url: path, headers })
    assert.equal(response.statusCode, 200, 'bulk SQL fixture read failed')
    return response.json()
  }
  const context = [{ channel: 'EBAY', marketplace: 'IT', accountId: family.connection, locale: 'it', aliasKey: '' }]
  const save = async (rows: ApiRow[], values: unknown[], phase: string) => {
    const operationId = randomUUID()
    const units = rows.map((row, index) => {
      const cell = row.values.subtitle
      assert(cell, 'the speed row needs a subtitle')
      assert.equal(typeof row.listing?.version, 'number', 'the listing version must come from the real read')
      return { key: `primary:${row.id}#${index}`, expectedVersion: row.listing!.version, marketplaceContexts: context,
        changes: [{ id: row.id, field: cell.writeField ?? 'subtitle', target: 'channel', value: values[index], intent: 'set',
          ...(cell.contentAddress ? { contentAddress: cell.contentAddress } : {}) }] }
    })
    const before = count()
    const started = performance.now()
    const response = await app.inject({ method: 'POST', url: '/api/products/bulk-save',
      headers: { ...headers, 'idempotency-key': operationId }, payload: { operationId, units } })
    const after = count()
    const measured = { phase, rows: rows.length, trips: after.trips - before.trips,
      sql: after.statements - before.statements, ms: performance.now() - started }
    console.log(`SHEET_BULK_SQL ${JSON.stringify({ ...measured, sqlPerRow: measured.sql / rows.length, targetPerRow: 15 })}`)
    assert.equal(response.statusCode, 200, 'bulk SQL save HTTP status')
    const body = response.json()
    assert.equal(body.saved, rows.length, 'every sent unit must save')
    assert.equal(body.failed, 0, 'no bulk unit may fail')
    assert.deepEqual(body.units.map((unit: { key: string }) => unit.key), units.map(unit => unit.key), 'each answer belongs to its sent unit')
    for (const unit of body.units) {
      assert.equal(unit.status, 200, 'bulk SQL unit status')
      assert.deepEqual(unit.body.errors ?? [], [], 'a successful unit must not refuse a cell')
    }
    assert(measured.trips > 0 && measured.sql > 0, 'the instrument must see actual bulk SQL')
    return measured
  }
  const failures: string[] = []
  for (const size of [21, 105]) {
    const rows = (await read()).rows.filter(row => !row.isParent).slice(0, size)
    assert.equal(rows.length, size, 'seed at least 105 variations for the SQL budget')
    const originals = new Map(rows.map(row => [row.id, row.values.subtitle.value]))
    const value = `bulk-sql-${randomUUID()}`
    let measured: Awaited<ReturnType<typeof save>>
    try {
      measured = await save(rows, rows.map(() => value), 'set')
      const saved = await read()
      for (const row of rows) assert.equal(saved.rows.find(now => now.id === row.id)?.values.subtitle.value, value, 'each bulk value must persist')
    } finally {
      // Always restore before judging the budget, using current versions even if the measured request failed.
      const current = await read()
      const fresh = rows.map(row => {
        const now = current.rows.find(item => item.id === row.id)
        assert(now, 'the bulk row disappeared before restoration')
        return now
      })
      await save(fresh, fresh.map(row => originals.get(row.id)), 'restore')
      const restored = await read()
      for (const [id, original] of originals) assert.deepEqual(restored.rows.find(row => row.id === id)?.values.subtitle.value, original, 'bulk fixture restored exactly')
    }
    if (measured.sql > size * 15) failures.push(`${size} rows: ${measured.sql} SQL (${(measured.sql / size).toFixed(2)}/row) > 15/row`)
  }
  // Count both sizes before failing. This remains red until the original P2 target is met.
  assert.deepEqual(failures, [], 'bulk SQL budget exceeded')
}
