import { afterEach, expect, it, vi } from 'vitest'
import { readQuarantineInventory } from './ebay-quarantine-inventory.js'
import { FAKE_KMS_KEY_ID } from '../../../test-support/fake-kms.js'

const receivedAt = new Date('2026-09-23T01:00:00Z')
afterEach(() => vi.restoreAllMocks())
const record = (id: string, changed = {}) => ({ id, signatureOk: true, payloadPresent: true, payloadKeyId: 'env', apparentVersion: 'v1', resolved: false, ownerKnown: false, receivedAt, ...changed })
function database(rows: ReturnType<typeof record>[]) {
  const statements: Array<{ sql: string; values?: unknown[] }> = []
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push({ sql, values })
    if (sql.includes('transaction_timestamp()')) return { rows: [{ asOf: receivedAt, readOnly: 'on', isolation: 'repeatable read' }] }
    if (sql.includes('nexus_ebay_quarantine_inventory')) {
      return { rows: rows.filter(row => !values?.[0] || row.id > String(values[0])).slice(0, Number(values?.[1])) }
    }
    return { rows: [] }
  })
  return { query, statements }
}

it('traverses every snapshot page, including resolved history and rejected metadata', async () => {
  const db = database([record('a'), record('b', { payloadKeyId: FAKE_KMS_KEY_ID, apparentVersion: 'v2', resolved: true, ownerKnown: true }),
    record('c', { signatureOk: false, payloadPresent: false, payloadKeyId: null, apparentVersion: 'none' })])
  const report = await readQuarantineInventory(db as never, { pageSize: 2, maxRows: 10, targetKeyArn: FAKE_KMS_KEY_ID })
  expect(report).toMatchObject({ scope: 'all_quarantine', snapshotComplete: true, examined: 3, verifiedRetained: 2,
    rejectedMetadata: 1, resolved: 1, unresolved: 2, storedKeys: { env: 1, target: 1, otherKms: 0, malformed: 0, missing: 0 }, recovery: 'not_checked', retirementReady: false })
  expect(db.statements.map(call => call.sql)).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  expect(db.statements.map(call => call.sql)).toContain('SET LOCAL ROLE nexus_ebay_quarantine_maintenance')
  expect(db.statements.at(-1)?.sql).toBe('COMMIT')
  expect(JSON.stringify(report)).not.toContain('payloadKeyId')
  expect(JSON.stringify(report)).not.toContain('"id":')
})
it('reports a bounded partial traversal instead of claiming completeness', async () => {
  const db = database([record('a'), record('b'), record('c')])
  expect(await readQuarantineInventory(db as never, { pageSize: 2, maxRows: 2 })).toMatchObject({ examined: 2, snapshotComplete: false, retirementReady: false })
  expect(db.statements.filter(call => call.sql.includes('nexus_ebay_quarantine_inventory')).map(call => call.values)).toEqual([[null, 2], ['b', 1]])
})
it('uses a lookahead to distinguish an exactly-full final page from truncation', async () => {
  const db = database([record('a'), record('b')])
  expect(await readQuarantineInventory(db as never, { pageSize: 2, maxRows: 2 })).toMatchObject({ examined: 2, snapshotComplete: true })
})
it('bounds snapshot lifetime and reports an incomplete scan when its time budget expires', async () => {
  let now = 0
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const db = database([record('a'), record('b'), record('c')]), original = db.query.getMockImplementation()!
  db.query.mockImplementation(async (sql, values) => {
    const result = await original(sql, values)
    if (sql.includes('nexus_ebay_quarantine_inventory')) now = 60_001
    return result
  })
  expect(await readQuarantineInventory(db as never, { pageSize: 1 })).toMatchObject({ examined: 1, snapshotComplete: false, incompleteReason: 'time_limit' })
  expect(db.statements.filter(call => call.sql.includes('nexus_ebay_quarantine_inventory'))).toHaveLength(1)
})
it('labels metadata defects without confusing an apparently-targeted envelope with recoverability', async () => {
  const db = database([record('a', { payloadKeyId: null }), record('b', { payloadKeyId: 'malformed-private-text', apparentVersion: 'malformed' }),
    record('c', { payloadKeyId: FAKE_KMS_KEY_ID.replace('0f3d2a1c', '1f3d2a1c'), apparentVersion: 'v2' })])
  const report = await readQuarantineInventory(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })
  expect(report).toMatchObject({ storedKeys: { missing: 1, malformed: 1, otherKms: 1 }, apparentFormats: { malformed: 1 }, recovery: 'not_checked', retirementReady: false })
  expect(JSON.stringify(report)).not.toContain('malformed-private-text')
})
it('fails closed on denied global authority and rolls back instead of emitting an empty success', async () => {
  const db = database([])
  db.query.mockImplementation(async sql => { if (sql.startsWith('SET LOCAL ROLE')) throw Object.assign(new Error('private connection details'), { code: '42501' }); return { rows: [] } })
  await expect(readQuarantineInventory(db as never)).rejects.toMatchObject({ code: 'authority_denied', message: 'Quarantine inventory could not be completed.' })
  expect(db.query).toHaveBeenLastCalledWith('ROLLBACK')
})
it('refuses a failed page without returning partial success or provider details', async () => {
  const db = database([]), original = db.query.getMockImplementation()!
  db.query.mockImplementation(async (sql, values) => { if (sql.includes('nexus_ebay_quarantine_inventory')) throw new Error('private connection details'); return original(sql, values) })
  await expect(readQuarantineInventory(db as never)).rejects.toMatchObject({ code: 'inventory_failed', message: 'Quarantine inventory could not be completed.' })
  expect(db.query).toHaveBeenLastCalledWith('ROLLBACK')
})
it.each([{ readOnly: 'off', isolation: 'repeatable read' }, { readOnly: 'on', isolation: 'read committed' }])('checks the actual transaction mode before returning a census: %j', async mode => {
  const db = database([]), original = db.query.getMockImplementation()!
  db.query.mockImplementation(async (sql, values) => sql.includes('transaction_timestamp()')
    ? { rows: [{ asOf: receivedAt, ...mode }] } : original(sql, values))
  await expect(readQuarantineInventory(db as never)).rejects.toMatchObject({ code: 'inventory_failed' })
  expect(db.statements.some(call => call.sql.includes('nexus_ebay_quarantine_inventory'))).toBe(false)
  expect(db.query).toHaveBeenLastCalledWith('ROLLBACK')
})
it.each([{ maxRows: 0 }, { maxRows: 100_001 }, { maxRows: 1.5 }, { pageSize: 0 }, { pageSize: 101 }, { targetKeyArn: 'alias/mutable' }])('refuses invalid bounds/targets before database access: %j', async options => {
  const db = database([])
  await expect(readQuarantineInventory(db as never, options)).rejects.toThrow()
  expect(db.query).not.toHaveBeenCalled()
})
