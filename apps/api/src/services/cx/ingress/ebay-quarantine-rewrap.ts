import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { PoolClient } from 'pg'
import { assertCredentialsMaintenanceKey, isCredentialsCancellation } from '../../../lib/crypto.js'
import { reencryptEbayQuarantine } from './ebay-quarantine-crypto.js'
import { quarantineBudget, quarantineFailureClass, readQuarantineCipherBatch, readQuarantineManifest } from './ebay-quarantine-verification.js'
import { boundedQuarantineQuery, QuarantineDeadlineError } from './quarantine-snapshot.js'

type Client = Pick<PoolClient, 'query'>
export interface QuarantineRewrapOptions { targetKeyArn: string; maxRows?: number; operationId?: string; budgetMs?: number; signal?: AbortSignal }
export class QuarantineRewrapError extends Error {
  constructor(readonly code: 'rewrap_unavailable' | 'authority_denied' | 'rewrap_in_progress' = 'rewrap_unavailable') {
    super('Quarantine rewrap could not be completed.'); this.name = 'QuarantineRewrapError'
  }
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** A server-reported SQLSTATE. A client-side timeout or a dropped socket has none,
 * and leaves the server transaction's fate unknown to this process. */
const sqlState = (error: unknown) => {
  const { code, severity } = (error ?? {}) as { code?: unknown; severity?: unknown }
  return typeof severity === 'string' && typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null
}
class AuthorityDenied extends Error {}
class UnknownRollback extends Error {}

/**
 * Definite outcomes only when the server said so. 'unknown': COMMIT was sent without
 * an acknowledgement, or the transaction could not be proven rolled back (a client
 * timeout queues the ROLLBACK behind a statement the server may still be running).
 */
async function compareAndSwap(client: Client, row: { id: string; payloadEnc: string | null; payloadKeyId: string | null; payloadDigest: string },
  replacement: { blob: string; keyId: string }, operationId: string, deadline: number): Promise<'applied' | 'contended' | 'not_applied' | 'unknown'> {
  let commitSent = false
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE nexus_ebay_quarantine_maintenance')
    // A suspended operator must not hold the row lock admission/adoption need.
    await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'")
    await client.query("SET LOCAL lock_timeout='5s'")
    const changed = (await boundedQuarantineQuery<{ changed: boolean }>(client,
      'SELECT public.nexus_rewrap_ebay_quarantine($1,$2,$3,$4,$5,$6,$7::uuid) AS changed',
      [row.id, row.payloadEnc, row.payloadKeyId, row.payloadDigest, replacement.blob, replacement.keyId, operationId], deadline)).rows[0]?.changed
    if (changed !== true) {
      await client.query('ROLLBACK').catch(() => { throw new UnknownRollback() })
      return 'contended'
    }
    commitSent = true
    const commit = await client.query('COMMIT')
    return (commit as { command?: string }).command === 'COMMIT' ? 'applied' : 'not_applied'
  } catch (error) {
    if (commitSent || error instanceof UnknownRollback) return 'unknown'
    const state = sqlState(error)
    if (state === null && !(error instanceof QuarantineDeadlineError)) return 'unknown'
    try { await client.query('ROLLBACK') } catch { return 'unknown' }
    if (state === '42501') throw new AuthorityDenied()
    if (state === '55P03') return 'contended' // lock_timeout: another writer holds the row
    if (error instanceof QuarantineDeadlineError) throw error
    return 'not_applied'
  }
}

/** Moves every verified retained body to one resolved KMS key through the reviewed
 * helper and the audited database CAS. Never holds a transaction across KMS work.
 * Its complete state is key metadata only; the separate verify command proves reads.
 * After the first CAS attempt every failure returns a report (with operationId) rather
 * than throwing, so a partial run is never mistaken for "nothing changed". */
export async function rewrapQuarantine(client: Client, options: QuarantineRewrapOptions) {
  assertCredentialsMaintenanceKey(options.targetKeyArn)
  const maxRows = options.maxRows ?? 1_000, operationId = options.operationId ?? randomUUID()
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 10_000 || !uuidPattern.test(operationId)) throw new Error('Invalid rewrap bounds.')
  const { started, deadline, cryptoDeadline } = quarantineBudget(options.budgetMs)
  const report = { scope: 'all_quarantine' as const, targetKeyArn: options.targetKeyArn, operationId,
    startedAt: new Date().toISOString(), endedAt: '', elapsedMs: 0, finalSnapshotStartedAt: null as string | null,
    status: 'incomplete' as 'incomplete' | 'nothing_to_do' | 'rewrapped_observed_state',
    complete: false, examined: 0, candidates: 0, rewrapped: 0, contended: 0, failed: 0, failedAccess: 0, failedIntegrity: 0, unknownOutcome: 0,
    remainingOffTarget: null as number | null, retirementReady: false as const,
    incompleteReason: null as 'manifest_incomplete' | 'state_changed' | 'rewrap_failed' | 'unknown_outcome' | 'off_target_remaining'
      | 'cancelled' | 'time_limit' | 'authority_denied' | 'database_unavailable' | null }
  const finish = () => {
    const now = performance.now()
    if (report.complete && now >= deadline) { report.complete = false; report.status = 'incomplete'; report.incompleteReason = 'time_limit' }
    return { ...report, endedAt: new Date().toISOString(), elapsedMs: Math.ceil(now - started) }
  }
  let writesAttempted = false, locked = false
  try {
    // One run at a time: two targets would move rows back and forth. Session-level,
    // so it holds no transaction or snapshot across KMS work.
    locked = (await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext('nexus:ebay-quarantine-rewrap')) AS locked")).rows[0]?.locked === true
    if (!locked) throw new QuarantineRewrapError('rewrap_in_progress')
    const before = await readQuarantineManifest(client, maxRows, cryptoDeadline)
    report.examined = before.entries.size
    if (!before.complete) { report.incompleteReason = 'manifest_incomplete'; return finish() }
    const candidates = [...before.entries.values()].filter(row => row.signatureOk && row.payloadKeyId !== options.targetKeyArn)
    report.candidates = candidates.length
    for (let offset = 0; offset < candidates.length; offset += 5) {
      if (options.signal?.aborted) { report.incompleteReason = 'cancelled'; return finish() }
      if (performance.now() >= cryptoDeadline) { report.incompleteReason = 'time_limit'; return finish() }
      const rows = await readQuarantineCipherBatch(client, candidates.slice(offset, offset + 5), cryptoDeadline)
      if (!rows) { report.incompleteReason = 'state_changed'; return finish() }
      for (const row of rows) {
        // Up to four cold Decrypts and one GenerateDataKey per v2 record.
        const recordDeadline = Math.min(performance.now() + 15_000, cryptoDeadline), duration = recordDeadline - performance.now()
        if (duration <= 0) { report.incompleteReason = 'time_limit'; return finish() }
        // The record timer means time_limit; only the operator's own signal means cancelled.
        const timer = new AbortController(), timeout = setTimeout(() => timer.abort(), duration)
        const signal = options.signal ? AbortSignal.any([options.signal, timer.signal]) : timer.signal
        let replacement: { blob: string; keyId: string }
        try {
          replacement = await reencryptEbayQuarantine(row, options.targetKeyArn, { signal })
        } catch (error) {
          if (timer.signal.aborted || performance.now() >= recordDeadline) { report.incompleteReason = 'time_limit'; return finish() }
          if (options.signal?.aborted || isCredentialsCancellation(error)) { report.incompleteReason = 'cancelled'; return finish() }
          report.failed++
          if (quarantineFailureClass(error) === 'integrity') report.failedIntegrity++
          else report.failedAccess++
          continue
        } finally { clearTimeout(timeout) }
        // A replacement prepared after its record deadline or an operator stop is discarded, never stored.
        if (timer.signal.aborted || performance.now() >= recordDeadline) { report.incompleteReason = 'time_limit'; return finish() }
        if (options.signal?.aborted) { report.incompleteReason = 'cancelled'; return finish() }
        writesAttempted = true
        const outcome = await compareAndSwap(client, row, replacement, operationId, deadline)
        if (outcome === 'applied') report.rewrapped++
        else if (outcome === 'contended') report.contended++
        else if (outcome === 'not_applied') report.failed++
        else { report.unknownOutcome++; report.incompleteReason = 'unknown_outcome'; return finish() }
      }
    }
    if (performance.now() >= deadline) { report.incompleteReason = 'time_limit'; return finish() }
    const after = await readQuarantineManifest(client, maxRows, deadline)
    report.finalSnapshotStartedAt = after.asOf
    if (!after.complete) { report.incompleteReason = 'manifest_incomplete'; return finish() }
    report.remainingOffTarget = [...after.entries.values()].filter(row => row.signatureOk && row.payloadKeyId !== options.targetKeyArn).length
    if (report.failed) report.incompleteReason = 'rewrap_failed'
    else if (report.remainingOffTarget) report.incompleteReason = 'off_target_remaining'
    else {
      report.complete = true
      report.status = candidates.length === 0 ? 'nothing_to_do' : 'rewrapped_observed_state'
    }
    return finish()
  } catch (error) {
    if (error instanceof QuarantineDeadlineError) { report.incompleteReason = 'time_limit'; return finish() }
    const denied = error instanceof AuthorityDenied || (error as { code?: string } | null)?.code === '42501'
    if (writesAttempted) { report.incompleteReason = denied ? 'authority_denied' : 'database_unavailable'; return finish() }
    if (error instanceof QuarantineRewrapError) throw error
    throw new QuarantineRewrapError(denied ? 'authority_denied' : 'rewrap_unavailable')
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('nexus:ebay-quarantine-rewrap'))").catch(() => {})
  }
}
