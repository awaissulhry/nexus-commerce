import { expect, it, vi } from 'vitest'
import { readEbayDeletionCensus } from './ebay-deletion-census.js'
const at = new Date('2026-09-25T00:00:00Z')
const row = (environment: string, extra = {}) => ({ environment, notices: 2, deliveries: 3, unresolved: 2, reviewRequired: 1, legacyReason: 1, otherReason: 0, oldestReceivedAt: at, ...extra })
function client(rows = [row('production'), row('sandbox')]) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('transaction_timestamp()')) return { rows: [{ asOf: at, readOnly: 'on', isolation: 'repeatable read' }] }
    return { rows: sql.includes('nexus_ebay_deletion_quarantine_census') ? rows : [] }
  })
  return { query }
}
it('returns only named aggregate fields and a dated read-only snapshot, never unexpected private columns', async () => {
  const db = client([row('production', { payloadEnc: 'private', subjectHash: 'private-hash' }), row('sandbox')])
  const report = await readEbayDeletionCensus(db as never)
  expect(report).toMatchObject({ scope: 'verified_ebay_account_deletion_quarantine', asOf: at.toISOString(), snapshotComplete: true, disposition: 'review_required_no_erasure' })
  expect(report.byEnvironment[0]).toEqual({ environment: 'production', notices: 2, deliveries: 3, unresolved: 2, reviewRequired: 1, legacyReason: 1, otherReason: 0, oldestReceivedAt: at.toISOString() })
  expect(JSON.stringify(report)).not.toContain('private')
  expect(db.query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  expect(db.query).toHaveBeenCalledWith('SET LOCAL ROLE nexus_ebay_quarantine_maintenance')
  expect(db.query).toHaveBeenLastCalledWith('COMMIT')
})
it.each([[], [row('production')], [row('production'), row('sandbox'), row('production')], [row('sandbox'), row('production')], [row('production', { notices: -1 }), row('sandbox')],
  [row('production', { deliveries: undefined }), row('sandbox')], [row('production', { notices: 3 }), row('sandbox')]].map(rows => ({ rows })))('refuses incomplete or inconsistent census rows', async ({ rows }) => {
  const db = client(rows)
  await expect(readEbayDeletionCensus(db as never)).rejects.toMatchObject({ code: 'census_failed' })
  expect(db.query).toHaveBeenLastCalledWith('ROLLBACK')
})
it.each(['42501', 'XX000'])('reports a static refusal for database failure %s instead of empty success or private error text', async code => {
  const db = client()
  db.query.mockRejectedValue(Object.assign(new Error('private connection details'), { code }))
  await expect(readEbayDeletionCensus(db as never)).rejects.toMatchObject({ code: code === '42501' ? 'authority_denied' : 'census_failed', message: 'The eBay deletion census could not be completed.' })
})
