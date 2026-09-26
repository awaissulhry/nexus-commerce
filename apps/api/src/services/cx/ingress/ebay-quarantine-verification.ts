import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { PoolClient } from 'pg'
import { assertCredentialsMaintenanceKey, isCredentialsCancellation } from '../../../lib/crypto.js'
import { openEbayQuarantineBody, QuarantineCipherError, type QuarantineCipher } from './ebay-quarantine-crypto.js'
import { boundedQuarantineQuery, QuarantineDeadlineError, withQuarantineSnapshot } from './quarantine-snapshot.js'

interface ManifestEntry {
  id: string
  signatureOk: boolean
  payloadKeyId: string | null
  payloadDigest: string
  cipherDigest: string | null
  proofDigest: string
}
type CipherEntry = ManifestEntry & QuarantineCipher
type Client = Pick<PoolClient, 'query'>
export interface QuarantineVerificationOptions { targetKeyArn: string; maxRows?: number; budgetMs?: number; signal?: AbortSignal }
/** One operator-chosen wall budget; crypto stops 10 s before it so the final manifest fits. */
export function quarantineBudget(budgetMs = 60_000) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 60_000 || budgetMs > 1_800_000) throw new Error('Invalid maintenance budget.')
  const started = performance.now()
  return { started, deadline: started + budgetMs, cryptoDeadline: started + budgetMs - 10_000 }
}
/** Access = a key or KMS was unavailable to this operator; integrity = the envelope,
 * its binding or its digest did not verify (a wrong key also lands here). */
export const quarantineFailureClass = (error: unknown) => error instanceof QuarantineCipherError && error.reason === 'integrity' ? 'integrity' : 'access'
export class QuarantineVerificationError extends Error {
  constructor(readonly code: 'verification_unavailable' | 'authority_denied' = 'verification_unavailable') {
    super('Quarantine verification could not be completed.'); this.name = 'QuarantineVerificationError'
  }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const fingerprint = (row: ManifestEntry) => JSON.stringify([row.id, row.signatureOk, row.payloadKeyId, row.payloadDigest, row.cipherDigest, row.proofDigest])
const hashPattern = /^[a-f0-9]{64}$/

/** A manifest transaction ends before any ciphertext is decrypted. Hashes remain
 * private to this process and are never a claim of simultaneous/future KMS access. */
export async function readQuarantineManifest(client: Client, maxRows: number, deadline: number) {
  return withQuarantineSnapshot(client, async asOf => {
    const entries = new Map<string, ManifestEntry>()
    let after: string | null = null, complete = false
    while (entries.size < maxRows && performance.now() < deadline) {
      const take = Math.min(50, maxRows - entries.size)
      const rows = (await boundedQuarantineQuery<ManifestEntry>(client, 'SELECT * FROM public.nexus_ebay_quarantine_manifest($1,$2)', [after, take], deadline)).rows
      if (rows.length > take) throw new QuarantineVerificationError()
      for (const row of rows) {
        if (!row.id || entries.has(row.id) || !hashPattern.test(row.proofDigest) || !hashPattern.test(row.payloadDigest)
          || (row.signatureOk ? !row.cipherDigest || !hashPattern.test(row.cipherDigest) : row.cipherDigest !== null || row.payloadKeyId !== null)) throw new QuarantineVerificationError()
        entries.set(row.id, row); after = row.id
      }
      if (rows.length < take) { complete = true; break }
    }
    if (!complete && performance.now() < deadline) {
      complete = (await boundedQuarantineQuery<ManifestEntry>(client, 'SELECT * FROM public.nexus_ebay_quarantine_manifest($1,$2)', [after, 1], deadline)).rows.length === 0
    }
    return { asOf, entries, complete }
  }, deadline)
}

/** At most five manifest entries in one closed snapshot. Null rejects the whole
 * batch before crypto if it contains any substitution, duplicate, missing record,
 * changed proof or oversized/changed envelope. */
export async function readQuarantineCipherBatch(client: Client, batch: ManifestEntry[], deadline: number): Promise<CipherEntry[] | null> {
  if (batch.length < 1 || batch.length > 5) throw new QuarantineVerificationError()
  const ids = batch.map(row => row.id)
  const rows = await withQuarantineSnapshot(client, async () =>
    (await boundedQuarantineQuery<CipherEntry>(client, 'SELECT * FROM public.nexus_ebay_quarantine_cipher_batch($1::text[])', [ids], deadline)).rows, deadline, 'nexus_ebay_quarantine_custodian')
  const byId = new Map(rows.map(row => [row.id, row]))
  if (rows.length !== batch.length || byId.size !== batch.length || batch.some(entry => {
    const row = byId.get(entry.id)
    return !row || fingerprint(row) !== fingerprint(entry) || !row.payloadEnc || row.payloadEnc.length > 3_145_728 || digest(row.payloadEnc) !== entry.cipherDigest
  })) return null
  return batch.map(entry => byId.get(entry.id)!)
}

/** VERIFY has no CAS/GenerateDataKey path. Its positive claim is limited to final
 * observed ciphertexts successfully cold-opened during this bounded interval. */
export async function verifyQuarantine(client: Client, options: QuarantineVerificationOptions) {
  assertCredentialsMaintenanceKey(options.targetKeyArn)
  const maxRows = options.maxRows ?? 1_000
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 10_000) throw new Error('Invalid verification bound.')
  const { started, deadline, cryptoDeadline } = quarantineBudget(options.budgetMs)
  const report = { scope: 'all_quarantine' as const, targetKeyArn: options.targetKeyArn,
    verificationStartedAt: new Date().toISOString(), verificationEndedAt: '', elapsedMs: 0, finalSnapshotStartedAt: null as string | null,
    status: 'incomplete' as 'incomplete' | 'empty' | 'metadata_only' | 'verified_observed_state',
    complete: false, examined: 0, verified: 0, envVerified: 0, kmsVerified: 0, atTarget: 0, rejectedMetadata: 0,
    failed: 0, failedAccess: 0, failedIntegrity: 0,
    // Null until the final manifest is actually compared.
    unchangedObservedState: null as boolean | null, retirementReady: false as const,
    incompleteReason: null as 'manifest_incomplete' | 'state_changed' | 'verification_failed' | 'cancelled' | 'time_limit' | null }
  const finish = () => {
    const now = performance.now()
    if (report.complete && now >= deadline) {
      report.complete = false; report.status = 'incomplete'; report.incompleteReason = 'time_limit'
    }
    return { ...report, verificationEndedAt: new Date().toISOString(), elapsedMs: Math.ceil(now - started) }
  }
  try {
    const before = await readQuarantineManifest(client, maxRows, cryptoDeadline)
    report.examined = before.entries.size
    if (!before.complete) { report.incompleteReason = 'manifest_incomplete'; return finish() }
    const expected = [...before.entries.values()].filter(row => row.signatureOk)
    report.rejectedMetadata = before.entries.size - expected.length
    for (let offset = 0; offset < expected.length; offset += 5) {
      if (options.signal?.aborted) { report.incompleteReason = 'cancelled'; return finish() }
      if (performance.now() >= cryptoDeadline) { report.incompleteReason = 'time_limit'; return finish() }
      const rows = await readQuarantineCipherBatch(client, expected.slice(offset, offset + 5), cryptoDeadline)
      if (!rows) { report.incompleteReason = 'state_changed'; return finish() }
      for (const row of rows) {
        const recordDeadline = Math.min(performance.now() + 10_000, cryptoDeadline), duration = recordDeadline - performance.now()
        if (duration <= 0) { report.incompleteReason = 'time_limit'; return finish() }
        // The record timer means time_limit; only the operator's own signal means cancelled.
        const timer = new AbortController(), timeout = setTimeout(() => timer.abort(), duration)
        const signal = options.signal ? AbortSignal.any([options.signal, timer.signal]) : timer.signal
        try {
          const body = await openEbayQuarantineBody(row, { bypassKmsCache: true, signal })
          body.fill(0) // Wipes this Buffer only; intermediate strings live until garbage collection.
          if (timer.signal.aborted || performance.now() >= recordDeadline) { report.incompleteReason = 'time_limit'; return finish() }
          if (options.signal?.aborted) { report.incompleteReason = 'cancelled'; return finish() }
          report.verified++
          if (row.payloadKeyId === 'env') report.envVerified++
          else report.kmsVerified++
          if (row.payloadKeyId === options.targetKeyArn) report.atTarget++
        } catch (error) {
          if (timer.signal.aborted || performance.now() >= recordDeadline) { report.incompleteReason = 'time_limit'; return finish() }
          if (options.signal?.aborted || isCredentialsCancellation(error)) { report.incompleteReason = 'cancelled'; return finish() }
          report.failed++
          if (quarantineFailureClass(error) === 'integrity') report.failedIntegrity++
          else report.failedAccess++
        } finally { clearTimeout(timeout) }
      }
    }
    if (performance.now() >= deadline) { report.incompleteReason = 'time_limit'; return finish() }
    const after = await readQuarantineManifest(client, maxRows, deadline)
    if (performance.now() >= deadline) { report.incompleteReason = 'time_limit'; return finish() }
    report.finalSnapshotStartedAt = after.asOf
    if (!after.complete) { report.incompleteReason = 'manifest_incomplete'; return finish() }
    report.unchangedObservedState = before.entries.size === after.entries.size
      && [...before.entries].every(([id, value]) => after.entries.has(id) && fingerprint(value) === fingerprint(after.entries.get(id)!))
    if (!report.unchangedObservedState) report.incompleteReason = 'state_changed'
    // Every retained verified body must have been opened exactly once, not merely none failed.
    else if (report.failed || report.verified !== expected.length) report.incompleteReason = 'verification_failed'
    else {
      report.complete = true
      report.status = before.entries.size === 0 ? 'empty' : expected.length === 0 ? 'metadata_only' : 'verified_observed_state'
    }
    return finish()
  } catch (error) {
    if (error instanceof QuarantineDeadlineError) { report.incompleteReason = 'time_limit'; return finish() }
    throw new QuarantineVerificationError((error as { code?: string } | null)?.code === '42501' ? 'authority_denied' : 'verification_unavailable')
  }
}
