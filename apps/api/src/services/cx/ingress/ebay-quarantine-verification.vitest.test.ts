import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { FakeKms, FAKE_KMS_KEY_ID } from '../../../test-support/fake-kms.js'
import { __cryptoTest, CredentialsDecryptError } from '../../../lib/crypto.js'
import { QuarantineCipherError } from './ebay-quarantine-crypto.js'

const open = vi.hoisted(() => vi.fn())
vi.mock('./ebay-quarantine-crypto.js', async importOriginal => ({ ...await importOriginal<object>(), openEbayQuarantineBody: open }))
const { verifyQuarantine } = await import('./ebay-quarantine-verification.js')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const row = (id: string, key = 'env') => ({ id, signatureOk: true, payloadKeyId: key, payloadDigest: hash('body'),
  payloadEnc: `synthetic-cipher-${id}`, cipherDigest: hash(`synthetic-cipher-${id}`), proofDigest: hash(`proof-${id}`),
  environment: 'production', externalId: 'synthetic-private-notification', topic: 'FUTURE_TOPIC', subjectHash: null })
function database(initial: ReturnType<typeof row>[]) {
  let transaction = false, manifestReads = 0
  const state = { final: initial, cipherRows: initial, returnAllCipherRows: false, statements: [] as string[], cryptoInTransaction: false, onFinalManifest: undefined as (() => void) | undefined }
  open.mockImplementation(async () => { state.cryptoInTransaction ||= transaction; return Buffer.from('synthetic-private-body') })
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    state.statements.push(sql)
    if (sql.startsWith('BEGIN')) transaction = true
    if (sql === 'COMMIT' || sql === 'ROLLBACK') transaction = false
    if (sql.includes('transaction_timestamp()')) return { rows: [{ asOf: new Date(), readOnly: 'on', isolation: 'repeatable read' }] }
    if (sql.includes('nexus_ebay_quarantine_manifest')) {
      if (!values?.[0]) manifestReads++
      if (manifestReads > 1) state.onFinalManifest?.()
      return { rows: (manifestReads === 1 ? initial : state.final).filter(row => !values?.[0] || row.id > String(values[0])).slice(0, Number(values?.[1])) }
    }
    if (sql.includes('nexus_ebay_quarantine_cipher_batch')) return { rows: state.returnAllCipherRows ? state.cipherRows : state.cipherRows.filter(row => (values?.[0] as string[]).includes(row.id)) }
    return { rows: [] }
  })
  return { query, state }
}
beforeEach(() => { open.mockReset(); __cryptoTest.setKmsClient(new FakeKms() as never) })
afterEach(() => vi.restoreAllMocks())

it('cold-opens all final ciphertexts outside transactions and keeps key-retirement claims disabled', async () => {
  const db = database([row('a'), row('b', FAKE_KMS_KEY_ID)])
  const result = await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })
  expect(result).toMatchObject({ status: 'verified_observed_state', complete: true, verified: 2, envVerified: 1, kmsVerified: 1,
    atTarget: 1, retirementReady: false, unchangedObservedState: true })
  expect(db.state.cryptoInTransaction).toBe(false)
  expect(open).toHaveBeenCalledTimes(2)
  for (const call of open.mock.calls) expect(call[1]).toMatchObject({ bypassKmsCache: true, signal: expect.any(AbortSignal) })
  expect(JSON.stringify(result)).not.toContain('synthetic-private')
  expect(db.state.statements.some(sql => /rewrap|INSERT|UPDATE|DELETE/i.test(sql))).toBe(false)
})
it.each(['new-row', 'cipher-change', 'proof-change', 'count-preserving-id-change'])('refuses full verification after final manifest %s', async change => {
  const first = row('a'), db = database([first])
  db.state.final = change === 'new-row' ? [first, row('b')] : change === 'cipher-change' ? [{ ...first, cipherDigest: hash('changed') }]
    : change === 'proof-change' ? [{ ...first, proofDigest: hash('changed') }] : [row('b')]
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })).toMatchObject({ complete: false, unchangedObservedState: false, incompleteReason: 'state_changed' })
})
it('does not invalidate decryption proof when only delivery/adoption history changes', async () => {
  const first = row('a'), db = database([first])
  db.state.final = [{ ...first, deliveries: 2, resolvedReceiptId: 'synthetic-receipt' } as typeof first]
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })).toMatchObject({ complete: true, verified: 1 })
})
it('refuses a truncated initial manifest before any crypto', async () => {
  const db = database([row('a'), row('b')])
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID, maxRows: 1 })).toMatchObject({ complete: false, verified: 0, incompleteReason: 'manifest_incomplete' })
  expect(open).not.toHaveBeenCalled()
})
it.each(['missing','duplicate','unexpected','mismatched'])('refuses a %s encrypted batch before any crypto', async kind => {
  const first = row('a'), db = database([first])
  db.state.returnAllCipherRows = true
  db.state.cipherRows = kind === 'missing' ? [] : kind === 'duplicate' ? [first, first] : kind === 'unexpected' ? [first, row('b')] : [{ ...first, payloadEnc: 'changed' }]
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })).toMatchObject({ complete: false, verified: 0, incompleteReason: 'state_changed' })
  expect(open).not.toHaveBeenCalled()
})
it('returns an empty census without inventing a positive KMS proof', async () => {
  const db = database([])
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })).toMatchObject({ status: 'empty', complete: true, verified: 0, kmsVerified: 0, retirementReady: false })
  expect(open).not.toHaveBeenCalled()
})
it('distinguishes unreadable ciphertext from cancellation and keeps private failures out of output', async () => {
  const db = database([row('a')])
  open.mockRejectedValue(new Error('synthetic-private-provider-error'))
  const result = await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })
  expect(result).toMatchObject({ complete: false, failed: 1, verified: 0, incompleteReason: 'verification_failed' })
  expect(JSON.stringify(result)).not.toContain('synthetic-private')
})
it('stops after cancellation without labelling the envelope unreadable', async () => {
  const db = database([row('a'), row('b')])
  open.mockRejectedValue(new CredentialsDecryptError('cancelled', 'Credential operation was cancelled'))
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })).toMatchObject({ complete: false, failed: 0, verified: 0, incompleteReason: 'cancelled' })
  expect(open).toHaveBeenCalledTimes(1)
})
it('cannot accept a final SQL response that returns after the overall deadline', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const db = database([row('a')]); db.state.onFinalManifest = () => { now = 60_001 }
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })).toMatchObject({ complete: false, incompleteReason: 'time_limit' })
})
it('cannot count crypto that settles after its record deadline before timer delivery', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const db = database([row('a')]); open.mockImplementation(async () => { now = 10_001; return Buffer.from('body') })
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })).toMatchObject({ complete: false, verified: 0, incompleteReason: 'time_limit' })
})
it('caps a final statement timeout by the remaining monotonic budget', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const db = database([row('a')]), query = db.query.getMockImplementation()!
  db.query.mockImplementation(async (sql, values) => {
    if (sql.includes('transaction_timestamp()') && open.mock.calls.length) now = 59_995
    return query(sql, values)
  })
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })).toMatchObject({ complete: true })
  const limits = db.query.mock.calls.filter(([sql]) => sql.includes("set_config('statement_timeout'"))
  expect(limits.at(-1)?.[1]).toEqual(['5ms'])
})
it('does not report success when the final COMMIT acknowledgement crosses the deadline', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const db = database([row('a')]), query = db.query.getMockImplementation()!
  db.query.mockImplementation(async (sql, values) => {
    const result = await query(sql, values)
    if (sql === 'COMMIT' && open.mock.calls.length) now = 60_001
    return result
  })
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })).toMatchObject({ complete: false, incompleteReason: 'time_limit' })
})
it('stops on a late crypto failure even if its cancellation timer has not fired', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const db = database([row('a'),row('b')])
  open.mockImplementation(async () => { now = 10_001; throw new Error('synthetic private late failure') })
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })).toMatchObject({ complete: false, failed: 0, incompleteReason: 'time_limit' })
  expect(open).toHaveBeenCalledTimes(1)
})
it('downgrades success if final comparison consumes the remaining overall budget', async () => {
  let now = 0, finalProofReads = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const first = row('a'), db = database([first]), final = { ...first }
  Object.defineProperty(final, 'proofDigest', { enumerable: true, get() {
    // The manifest validates this field before the final comparison. Simulate
    // time spent in that comparison without relying on a wall-clock sleep.
    if (++finalProofReads > 1) now = 60_001
    return first.proofDigest
  } })
  db.state.final = [final]
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })).toMatchObject({ complete: false, status: 'incomplete', incompleteReason: 'time_limit', elapsedMs: 60_001 })
})
// Regression, not a guard: the snapshot's own post-read deadline check already
// supplies this label (an early-exit mutation of the manifest loop is equivalent).
it('labels a manifest that runs out of time as time_limit, not as a row-bound manifest', async () => {
  let now = 0, reads = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const first = row('a'), timed = { ...first }
  Object.defineProperty(timed, 'proofDigest', { enumerable: true, get() {
    // Time passes while the page is validated, after the read's own deadline check.
    if (++reads === 1) now = 50_001
    return first.proofDigest
  } })
  const db = database([timed])
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID, maxRows: 1 })).toMatchObject({ complete: false, verified: 0, incompleteReason: 'time_limit' })
  expect(open).not.toHaveBeenCalled()
})
it('reports denied maintenance authority separately and without the database message', async () => {
  const db = database([row('a')]), query = db.query.getMockImplementation()!
  db.query.mockImplementation(async (sql, values) => {
    if (sql.startsWith('SET LOCAL ROLE')) throw Object.assign(new Error('synthetic-private-permission-text'), { code: '42501' })
    return query(sql, values)
  })
  const failure = await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID }).catch(error => error)
  expect(failure).toMatchObject({ name: 'QuarantineVerificationError', code: 'authority_denied' })
  expect(String(failure.message)).not.toContain('synthetic-private')
  expect(open).not.toHaveBeenCalled()
})
it('opens every retained body exactly once across partial batches', async () => {
  const ids = Array.from({ length: 11 }, (_, i) => `r${String(i).padStart(2, '0')}`), db = database(ids.map(id => row(id)))
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })).toMatchObject({ complete: true, verified: 11, examined: 11 })
  expect(open.mock.calls.map(call => call[0].id)).toEqual(ids)
})
it('reads bodies only under the custodian role and manifests under metadata authority', async () => {
  const db = database([row('a')])
  await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })
  const roleBefore = (marker: string) => db.state.statements.slice(0, db.state.statements.findIndex(sql => sql.includes(marker))).filter(sql => sql.startsWith('SET LOCAL ROLE')).at(-1)
  expect(roleBefore('nexus_ebay_quarantine_cipher_batch')).toBe('SET LOCAL ROLE nexus_ebay_quarantine_custodian')
  expect(roleBefore('nexus_ebay_quarantine_manifest')).toBe('SET LOCAL ROLE nexus_ebay_quarantine_maintenance')
})
it('refuses a batch whose immutable proof changed even when its ciphertext is identical', async () => {
  const first = row('a'), db = database([first])
  db.state.returnAllCipherRows = true; db.state.cipherRows = [{ ...first, proofDigest: hash('changed binding') }]
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })).toMatchObject({ complete: false, incompleteReason: 'state_changed', unchangedObservedState: null })
  expect(open).not.toHaveBeenCalled()
})
it('completes an exactly full manifest through its empty lookahead', async () => {
  const db = database([row('a'), row('b')])
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID, maxRows: 2 })).toMatchObject({ complete: true, verified: 2 })
})
it('separates access failures from integrity failures without echoing either', async () => {
  const db = database([row('a'), row('b')])
  open.mockRejectedValueOnce(new QuarantineCipherError('access')).mockRejectedValueOnce(new QuarantineCipherError())
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })).toMatchObject({ complete: false, failed: 2, failedAccess: 1, failedIntegrity: 1, incompleteReason: 'verification_failed' })
})
it('reports an operator stop as cancelled, distinct from a time limit', async () => {
  const operator = new AbortController(), db = database([row('a'), row('b')])
  let reached: boolean | undefined
  open.mockImplementation(async (_row, options: { signal: AbortSignal }) => { operator.abort(); reached = options.signal.aborted; return Buffer.from('body') })
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID, signal: operator.signal })).toMatchObject({ complete: false, verified: 0, incompleteReason: 'cancelled' })
  expect(reached).toBe(true)
  expect(open).toHaveBeenCalledTimes(1)
})
it('extends crypto work only within an explicit bounded operator budget', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  // Seven 9-second opens (63 s) exceed the default 50-second crypto window.
  const db = database(Array.from({ length: 7 }, (_, i) => row(`r${i}`)))
  open.mockImplementation(async () => { now += 9_000; return Buffer.from('body') })
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID, budgetMs: 120_000 })).toMatchObject({ complete: true, verified: 7 })
  now = 0
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID })).toMatchObject({ complete: false, incompleteReason: 'time_limit' })
  for (const budgetMs of [59_999, 1_800_001]) await expect(verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID, budgetMs })).rejects.toThrow('Invalid maintenance budget.')
})
it('leaves the unchanged-state claim unmeasured when it stops before the final manifest', async () => {
  const db = database([row('a'), row('b')])
  expect(await verifyQuarantine(db as never, { targetKeyArn: FAKE_KMS_KEY_ID, maxRows: 1 })).toMatchObject({ unchangedObservedState: null, incompleteReason: 'manifest_incomplete' })
})
