import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { FAKE_KMS_KEY_ID } from '../../../test-support/fake-kms.js'
import { CredentialsDecryptError } from '../../../lib/crypto.js'
import { QuarantineCipherError } from './ebay-quarantine-crypto.js'

const reencrypt = vi.hoisted(() => vi.fn())
vi.mock('./ebay-quarantine-crypto.js', async importOriginal => ({ ...await importOriginal<object>(), reencryptEbayQuarantine: reencrypt, openEbayQuarantineBody: vi.fn() }))
const { rewrapQuarantine } = await import('./ebay-quarantine-rewrap.js')
const TARGET = FAKE_KMS_KEY_ID, OLD = 'arn:aws:kms:eu-west-1:123456789012:key/00000000-0000-4000-8000-000000000000'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
type Row = { id: string; signatureOk: boolean; payloadKeyId: string | null; payloadDigest: string; payloadEnc: string | null
  environment: string; externalId: string; topic: string; subjectHash: string | null }
const row = (id: string, key: string | null = 'env'): Row => ({ id, signatureOk: key !== null, payloadKeyId: key, payloadDigest: hash('body'),
  payloadEnc: key === null ? null : `synthetic-cipher-${id}-${key}`, environment: 'production', externalId: 'synthetic-private-notification', topic: 'FUTURE_TOPIC', subjectHash: null })
const manifestOf = (r: Row) => ({ id: r.id, signatureOk: r.signatureOk, payloadKeyId: r.payloadKeyId, payloadDigest: r.payloadDigest,
  cipherDigest: r.payloadEnc === null ? null : hash(r.payloadEnc), proofDigest: hash(`proof-${r.id}`) })

function database(initial: Row[]) {
  const rows = new Map(initial.map(r => [r.id, { ...r }]))
  let transaction = false, pending: { id: string; payloadEnc: string; payloadKeyId: string } | null = null
  const state = { rows, statements: [] as string[], cas: [] as unknown[][], kmsInTransaction: false, commitFails: false,
    changeBatch: undefined as ((batch: Row[]) => Row[]) | undefined, onCas: undefined as ((id: string) => void) | undefined, casThrows: undefined as unknown, lockHeld: false }
  reencrypt.mockImplementation(async (r: Row, target: string) => { state.kmsInTransaction ||= transaction; return { blob: `v2:synthetic-replacement-${r.id}`, keyId: target, mode: 'kms' } })
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    state.statements.push(sql)
    if (sql.startsWith('BEGIN')) transaction = true
    if (sql === 'ROLLBACK') { transaction = false; pending = null }
    if (sql === 'COMMIT') {
      transaction = false
      if (!pending) return { command: 'COMMIT', rows: [] }
      if (pending && state.commitFails) { const change = pending; pending = null; Object.assign(rows.get(change.id)!, change); throw new Error('synthetic lost acknowledgement') }
      Object.assign(rows.get(pending.id)!, pending)
      pending = null
      return { command: 'COMMIT', rows: [] }
    }
    if (sql.includes('pg_try_advisory_lock')) { const free = !state.lockHeld; state.lockHeld = true; return { rows: [{ locked: free }] } }
    if (sql.includes('pg_advisory_unlock')) { state.lockHeld = false; return { rows: [{ pg_advisory_unlock: true }] } }
    if (sql.includes('transaction_timestamp()')) return { rows: [{ asOf: new Date(), readOnly: 'on', isolation: 'repeatable read' }] }
    if (sql.includes('nexus_ebay_quarantine_manifest')) {
      const all = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)).filter(r => !values?.[0] || r.id > String(values[0]))
      return { rows: all.slice(0, Number(values?.[1])).map(manifestOf) }
    }
    if (sql.includes('nexus_ebay_quarantine_cipher_batch')) {
      const batch = [...rows.values()].filter(r => r.signatureOk && (values?.[0] as string[]).includes(r.id)).map(r => ({ ...r, ...manifestOf(r) }))
      return { rows: state.changeBatch ? state.changeBatch(batch) : batch }
    }
    if (sql.includes('nexus_rewrap_ebay_quarantine')) {
      state.cas.push(values!)
      const [id, cipher, key, digest, replacement, target] = values as string[]
      state.onCas?.(id)
      if (state.casThrows) throw state.casThrows
      const current = rows.get(id)
      if (!current || current.payloadEnc !== cipher || current.payloadKeyId !== key || current.payloadDigest !== digest) return { rows: [{ changed: false }] }
      pending = { id, payloadEnc: replacement, payloadKeyId: target }
      return { rows: [{ changed: true }] }
    }
    return { rows: [] }
  })
  return { query, state }
}
beforeEach(() => { reencrypt.mockReset() })
afterEach(() => vi.restoreAllMocks())

it('moves env and other-KMS bodies to the target outside transactions under one operation id and skips rows already there', async () => {
  const db = database([row('a'), row('b', OLD), row('c', TARGET)])
  const originals = [db.state.rows.get('a')!, db.state.rows.get('b')!].map(r => ({ ...r }))
  const result = await rewrapQuarantine(db as never, { targetKeyArn: TARGET })
  expect(result).toMatchObject({ complete: true, status: 'rewrapped_observed_state', candidates: 2, rewrapped: 2, contended: 0,
    remainingOffTarget: 0, retirementReady: false, incompleteReason: null })
  expect(reencrypt).toHaveBeenCalledTimes(2)
  for (const call of reencrypt.mock.calls) expect(call.slice(1)).toEqual([TARGET, { signal: expect.any(AbortSignal) }])
  expect(db.state.kmsInTransaction).toBe(false)
  expect(db.state.cas.map(values => values.slice(0, 4))).toEqual(originals.map(r => [r.id, r.payloadEnc, r.payloadKeyId, r.payloadDigest]))
  expect(new Set(db.state.cas.map(values => values[6]))).toEqual(new Set([result.operationId]))
  expect([...db.state.rows.values()].map(r => r.payloadKeyId)).toEqual([TARGET, TARGET, TARGET])
  expect(JSON.stringify(result)).not.toMatch(/synthetic-(cipher|replacement|private)/)
})
it('refuses a truncated manifest before any KMS work or write', async () => {
  const db = database([row('a'), row('b')])
  expect(await rewrapQuarantine(db as never, { targetKeyArn: TARGET, maxRows: 1 })).toMatchObject({ complete: false, incompleteReason: 'manifest_incomplete', rewrapped: 0 })
  expect(reencrypt).not.toHaveBeenCalled(); expect(db.state.cas).toHaveLength(0)
})
it('refuses a changed encrypted batch before any KMS work or write', async () => {
  const db = database([row('a')]); db.state.changeBatch = batch => batch.map(r => ({ ...r, payloadEnc: 'changed' }))
  expect(await rewrapQuarantine(db as never, { targetKeyArn: TARGET })).toMatchObject({ complete: false, incompleteReason: 'state_changed' })
  expect(reencrypt).not.toHaveBeenCalled(); expect(db.state.cas).toHaveLength(0)
})
it('counts a lost CAS as contention and judges completion from the final state only', async () => {
  const db = database([row('a')])
  db.state.onCas = id => Object.assign(db.state.rows.get(id)!, { payloadEnc: 'v2:other-operator', payloadKeyId: TARGET })
  expect(await rewrapQuarantine(db as never, { targetKeyArn: TARGET })).toMatchObject({ complete: true, rewrapped: 0, contended: 1, remainingOffTarget: 0 })
  const moved = database([row('a')])
  moved.state.onCas = id => Object.assign(moved.state.rows.get(id)!, { payloadEnc: 'v2:other-operator', payloadKeyId: OLD })
  expect(await rewrapQuarantine(moved as never, { targetKeyArn: TARGET })).toMatchObject({ complete: false, contended: 1, remainingOffTarget: 1, incompleteReason: 'off_target_remaining' })
})
it('stops at an unacknowledged COMMIT without another write or a success claim', async () => {
  const db = database([row('a'), row('b')]); db.state.commitFails = true
  expect(await rewrapQuarantine(db as never, { targetKeyArn: TARGET })).toMatchObject({ complete: false, unknownOutcome: 1, rewrapped: 0, incompleteReason: 'unknown_outcome' })
  expect(db.state.cas).toHaveLength(1)
  // Nothing but the session-lock release may follow the unacknowledged COMMIT.
  const tail = db.state.statements.slice(db.state.statements.lastIndexOf('COMMIT') + 1)
  expect(tail).toEqual(["SELECT pg_advisory_unlock(hashtext('nexus:ebay-quarantine-rewrap'))"])
})
it('treats a failure before COMMIT as a definite no-change and continues', async () => {
  const db = database([row('a'), row('b')])
  db.state.onCas = id => { db.state.casThrows = id === 'a' ? Object.assign(new Error('synthetic-private-sql-failure'), { code: '22023', severity: 'ERROR' }) : undefined }
  const result = await rewrapQuarantine(db as never, { targetKeyArn: TARGET })
  expect(result).toMatchObject({ complete: false, failed: 1, rewrapped: 1, remainingOffTarget: 1, incompleteReason: 'rewrap_failed' })
  expect(db.state.rows.get('a')!.payloadKeyId).toBe('env')
  expect(db.state.statements).toContain('ROLLBACK')
  expect(JSON.stringify(result)).not.toContain('synthetic-private')
})
it('discards a replacement prepared after its record deadline', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const db = database([row('a')])
  reencrypt.mockImplementation(async (r: Row, target: string) => { now = 15_001; return { blob: `v2:late-${r.id}`, keyId: target, mode: 'kms' } })
  expect(await rewrapQuarantine(db as never, { targetKeyArn: TARGET })).toMatchObject({ complete: false, rewrapped: 0, incompleteReason: 'time_limit' })
  expect(db.state.cas).toHaveLength(0)
})
it('rolls back a CAS whose response arrives after the overall deadline', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const db = database([row('a')]); db.state.onCas = () => { now = 60_001 }
  expect(await rewrapQuarantine(db as never, { targetKeyArn: TARGET })).toMatchObject({ complete: false, rewrapped: 0, incompleteReason: 'time_limit' })
  expect(db.state.rows.get('a')!.payloadKeyId).toBe('env')
  expect(db.state.statements.slice(db.state.statements.findIndex(sql => sql.includes('nexus_rewrap_ebay_quarantine')))).not.toContain('COMMIT')
})
it('stops on cancellation and keeps provider failures private', async () => {
  const cancelled = database([row('a'), row('b')])
  reencrypt.mockRejectedValue(new CredentialsDecryptError('cancelled', 'Credential operation was cancelled'))
  expect(await rewrapQuarantine(cancelled as never, { targetKeyArn: TARGET })).toMatchObject({ complete: false, failed: 0, incompleteReason: 'cancelled' })
  expect(reencrypt).toHaveBeenCalledTimes(1)
  const broken = database([row('a')])
  reencrypt.mockRejectedValue(new Error('synthetic-private-provider-error'))
  const result = await rewrapQuarantine(broken as never, { targetKeyArn: TARGET })
  expect(result).toMatchObject({ complete: false, failed: 1, incompleteReason: 'rewrap_failed' })
  expect(broken.state.cas).toHaveLength(0); expect(JSON.stringify(result)).not.toContain('synthetic-private')
})
it('reports denied authority separately and without the database message', async () => {
  const db = database([row('a')]), query = db.query.getMockImplementation()!
  db.query.mockImplementation(async (sql, values) => {
    if (sql.startsWith('SET LOCAL ROLE')) throw Object.assign(new Error('synthetic-private-permission-text'), { code: '42501' })
    return query(sql, values)
  })
  const failure = await rewrapQuarantine(db as never, { targetKeyArn: TARGET }).catch(error => error)
  expect(failure).toMatchObject({ name: 'QuarantineRewrapError', code: 'authority_denied' })
  expect(String(failure.message)).not.toContain('synthetic-private'); expect(reencrypt).not.toHaveBeenCalled()
})
it('does not call the run complete when a body arrives under the old key during the run', async () => {
  const db = database([row('a')]); db.state.onCas = () => { db.state.rows.set('z', row('z', OLD)) }
  expect(await rewrapQuarantine(db as never, { targetKeyArn: TARGET })).toMatchObject({ complete: false, rewrapped: 1, remainingOffTarget: 1, incompleteReason: 'off_target_remaining' })
})
it('reports nothing to do without KMS when every verified body already carries the target', async () => {
  const db = database([row('c', TARGET), row('r', null)])
  expect(await rewrapQuarantine(db as never, { targetKeyArn: TARGET })).toMatchObject({ complete: true, status: 'nothing_to_do', candidates: 0, examined: 2, remainingOffTarget: 0 })
  expect(reencrypt).not.toHaveBeenCalled(); expect(db.state.cas).toHaveLength(0)
})
it.each([[{ maxRows: 0 }], [{ maxRows: 10_001 }], [{ operationId: 'not-a-uuid' }], [{ targetKeyArn: 'alias/mutable' }]])('refuses invalid bounds before any database work: %j', async override => {
  const db = database([row('a')])
  await expect(rewrapQuarantine(db as never, { targetKeyArn: TARGET, ...override })).rejects.toThrow()
  expect(db.query).not.toHaveBeenCalled()
})
it('rewraps every candidate across partial batches, reading bodies as custodian and writing as maintenance', async () => {
  const ids = Array.from({ length: 11 }, (_, i) => `r${String(i).padStart(2, '0')}`), db = database(ids.map(id => row(id, OLD)))
  expect(await rewrapQuarantine(db as never, { targetKeyArn: TARGET })).toMatchObject({ complete: true, candidates: 11, rewrapped: 11, remainingOffTarget: 0 })
  expect(reencrypt.mock.calls.map(call => call[0].id)).toEqual(ids)
  const statements = db.state.statements
  for (const [i, sql] of statements.entries()) {
    if (sql.includes('nexus_ebay_quarantine_cipher_batch')) expect(statements.slice(0, i).filter(s => s.startsWith('SET LOCAL ROLE')).at(-1)).toBe('SET LOCAL ROLE nexus_ebay_quarantine_custodian')
    if (sql.includes('nexus_rewrap_ebay_quarantine')) expect(statements.slice(0, i).filter(s => s.startsWith('SET LOCAL ROLE')).at(-1)).toBe('SET LOCAL ROLE nexus_ebay_quarantine_maintenance')
  }
})
it('stops on an operator signal without storing the replacement it had prepared', async () => {
  const operator = new AbortController(), db = database([row('a'), row('b')])
  let reached: boolean | undefined
  reencrypt.mockImplementation(async (r: Row, target: string, opts: { signal: AbortSignal }) => {
    operator.abort(); reached = opts.signal.aborted // the operator's signal reaches KMS work
    return { blob: `v2:late-${r.id}`, keyId: target, mode: 'kms' }
  })
  expect(await rewrapQuarantine(db as never, { targetKeyArn: TARGET, signal: operator.signal })).toMatchObject({ complete: false, rewrapped: 0, incompleteReason: 'cancelled' })
  expect(reached).toBe(true)
  expect(db.state.cas).toHaveLength(0)
})
it('separates access failures from integrity failures', async () => {
  const db = database([row('a'), row('b')])
  reencrypt.mockRejectedValueOnce(new QuarantineCipherError('access')).mockRejectedValueOnce(new QuarantineCipherError())
  expect(await rewrapQuarantine(db as never, { targetKeyArn: TARGET })).toMatchObject({ complete: false, failed: 2, failedAccess: 1, failedIntegrity: 1, incompleteReason: 'rewrap_failed' })
})
it('treats a client-side failure inside the CAS transaction as unknown and stops before any further KMS work', async () => {
  const db = database([row('a'), row('b')])
  db.state.onCas = id => { db.state.casThrows = id === 'a' ? new Error('Query read timeout') : undefined }
  const result = await rewrapQuarantine(db as never, { targetKeyArn: TARGET })
  expect(result).toMatchObject({ complete: false, unknownOutcome: 1, failed: 0, incompleteReason: 'unknown_outcome' })
  expect(reencrypt).toHaveBeenCalledTimes(1); expect(db.state.cas).toHaveLength(1)
  expect(db.state.statements.slice(db.state.statements.findIndex(sql => sql.includes('nexus_rewrap_ebay_quarantine')))).not.toContain('COMMIT')
})
it('treats an unproven ROLLBACK after a server error as unknown', async () => {
  const db = database([row('a'), row('b')]), query = db.query.getMockImplementation()!
  db.state.onCas = () => { db.state.casThrows = Object.assign(new Error('synthetic'), { code: '40001', severity: 'ERROR' }) }
  db.query.mockImplementation(async (sql, values) => { if (sql === 'ROLLBACK' && db.state.cas.length) throw new Error('Query read timeout'); return query(sql, values) })
  expect(await rewrapQuarantine(db as never, { targetKeyArn: TARGET })).toMatchObject({ unknownOutcome: 1, incompleteReason: 'unknown_outcome' })
  expect(db.state.cas).toHaveLength(1)
})
it('rolls back instead of committing a CAS that changed nothing', async () => {
  const db = database([row('a')])
  db.state.onCas = id => Object.assign(db.state.rows.get(id)!, { payloadEnc: 'v2:other-operator', payloadKeyId: TARGET })
  await rewrapQuarantine(db as never, { targetKeyArn: TARGET })
  const after = db.state.statements.slice(db.state.statements.findIndex(sql => sql.includes('nexus_rewrap_ebay_quarantine')))
  const ownTransaction = after.slice(0, after.findIndex((sql, i) => i > 0 && sql.startsWith('BEGIN')))
  expect(ownTransaction).toEqual([expect.stringContaining('nexus_rewrap_ebay_quarantine'), 'ROLLBACK'])
})
it('rolls back the late CAS itself before reporting the time limit', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const db = database([row('a')]); db.state.onCas = () => { now = 60_001 }
  expect(await rewrapQuarantine(db as never, { targetKeyArn: TARGET })).toMatchObject({ incompleteReason: 'time_limit' })
  const after = db.state.statements.slice(db.state.statements.findIndex(sql => sql.includes('nexus_rewrap_ebay_quarantine')))
  expect(after[1]).toBe('ROLLBACK')
})
it('returns a report with its operation id when authority is lost after a write', async () => {
  const db = database([row('a'), row('b')])
  db.state.onCas = id => { db.state.casThrows = id === 'b' ? Object.assign(new Error('synthetic-private'), { code: '42501', severity: 'ERROR' }) : undefined }
  const run = rewrapQuarantine(db as never, { targetKeyArn: TARGET })
  await expect(run).resolves.toMatchObject({ complete: false, rewrapped: 1, incompleteReason: 'authority_denied', operationId: expect.stringMatching(/^[0-9a-f-]{36}$/) })
  expect(JSON.stringify(await run)).not.toContain('synthetic-private')
})
it('counts a lock timeout as contention, never as a write', async () => {
  const db = database([row('a')])
  db.state.onCas = () => { db.state.casThrows = Object.assign(new Error('lock timeout'), { code: '55P03', severity: 'ERROR' }) }
  expect(await rewrapQuarantine(db as never, { targetKeyArn: TARGET })).toMatchObject({ contended: 1, rewrapped: 0, remainingOffTarget: 1, incompleteReason: 'off_target_remaining' })
})
it('refuses to start while another rewrap run holds the session lock', async () => {
  const db = database([row('a')]); db.state.lockHeld = true
  await expect(rewrapQuarantine(db as never, { targetKeyArn: TARGET })).rejects.toMatchObject({ code: 'rewrap_in_progress' })
  expect(reencrypt).not.toHaveBeenCalled()
})
