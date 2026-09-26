import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Pool, type PoolClient } from 'pg'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { FakeKms, FAKE_KMS_KEY_ID } from '../../../test-support/fake-kms.js'
import { __cryptoTest, __test, encryptCredentials, encryptSecret } from '../../../lib/crypto.js'
import { reencryptEbayQuarantine } from './ebay-quarantine-crypto.js'
import { rewrapQuarantine } from './ebay-quarantine-rewrap.js'
import { verifyQuarantine } from './ebay-quarantine-verification.js'

const TARGET = FAKE_KMS_KEY_ID, OLD = 'arn:aws:kms:eu-west-1:123456789012:key/00000000-0000-4000-8000-000000000000'
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
let database: Awaited<ReturnType<typeof concurrentDatabase>>, operators: Pool, fake: FakeKms, operator: string, operatorUrl: string
/** env: v1 environment key; old/target: v2 envelopes whose KMS key metadata names that resource. */
async function seed(mode: 'env' | 'old' | 'target' = 'env') {
  const id = randomUUID(), raw = Buffer.from(`synthetic verified opaque body ${id}`)
  const binding = { environment: 'production', signatureOk: true, externalId: `provider-${randomUUID()}`, topic: 'FUTURE_TOPIC',
    subjectHash: null, payloadDigest: createHash('sha256').update(raw).digest('hex') }
  const sealed = { version: 1, binding, rawBody: raw.toString('base64'), header: 'synthetic-signature' }
  let cipher: { blob: string; keyId: string }
  if (mode === 'env') cipher = { blob: encryptSecret(JSON.stringify(sealed)), keyId: 'env' }
  else { fake.keyId = mode === 'old' ? OLD : TARGET; cipher = await encryptCredentials(sealed); fake.keyId = TARGET }
  await database.pool.query(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"signatureOk","externalId",topic,"payloadEnc","payloadKeyId","payloadDigest",reason)
    VALUES ($1,'production',true,$2,'FUTURE_TOPIC',$3,$4,$5,'owner_unknown')`, [id, binding.externalId, cipher.blob, cipher.keyId, binding.payloadDigest])
  return { ...binding, id, payloadEnc: cipher.blob, payloadKeyId: cipher.keyId }
}
async function useOperator<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await operators.connect()
  try { return await run(client) } finally { client.release() }
}
const rewrap = () => useOperator(client => rewrapQuarantine(client, { targetKeyArn: TARGET }))
const allRows = async () => (await database.pool.query('SELECT * FROM "EbayNoticeQuarantine" ORDER BY id')).rows
const audits = async () => (await database.pool.query('SELECT * FROM "EbayQuarantineMaintenanceAudit" ORDER BY "quarantineId"')).rows
/** Runs `during` once, at the first KMS request, while recording whether the operator
 * connection had a transaction open at every KMS request. */
function watchKms(pid: number, states: Array<Date | null>, during?: () => Promise<void>) {
  const send = fake.send.bind(fake)
  let ran = false
  vi.spyOn(fake, 'send').mockImplementation(async command => {
    // Same login as the watched session: pg_stat_activity hides another user's
    // xact_start from a non-superuser, which would make this check vacuous.
    states.push((await operators.query('SELECT xact_start FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0].xact_start)
    if (during && !ran) { ran = true; await during() }
    return send(command)
  })
}

describe.skipIf(!concurrentDatabaseUrl())('operator quarantine rewrap through the audited PostgreSQL CAS', () => {
  beforeEach(async () => {
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64')); vi.stubEnv('NEXUS_KMS_KEY_ID', 'alias/test')
    __test.resetKeyCache(); __cryptoTest.resetDekCache(); fake = new FakeKms(TARGET); __cryptoTest.setKmsClient(fake as never)
    database = await concurrentDatabase()
    operator = `rewrap_operator_${randomBytes(6).toString('hex')}`
    await database.pool.query(`CREATE ROLE ${operator} LOGIN NOINHERIT PASSWORD 'disposable-test-only'; GRANT nexus_ebay_quarantine_maintenance TO ${operator} WITH INHERIT FALSE, SET TRUE;
      GRANT nexus_ebay_quarantine_custodian TO ${operator} WITH INHERIT FALSE, SET TRUE`)
    const url = concurrentDatabaseUrl()!; url.pathname = `/${database.name}`; url.username = operator; url.password = 'disposable-test-only'; operatorUrl = url.toString()
    operators = new Pool({ connectionString: operatorUrl, max: 4 })
  }, 180_000)
  afterEach(async () => {
    vi.restoreAllMocks(); await operators?.end()
    if (database) { await database.pool.query(`DROP ROLE IF EXISTS ${operator}`); await database.close() }
    vi.unstubAllEnvs()
  }, 60_000)

  it('moves env and other-key bodies under one audited operation, never across an open transaction, and verify then proves them', async () => {
    const env = await seed('env'), old = await seed('old'), done = await seed('target')
    const rejected = randomUUID()
    await database.pool.query(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"signatureOk","externalId",topic,"payloadDigest",reason) VALUES ($1,'production',false,$1,'unclassified',$2,'bad_signature')`, [rejected, 'a'.repeat(64)])
    const before = new Map((await allRows()).map(r => [r.id, r])), states: Array<Date | null> = []
    const result = await useOperator(async client => {
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      // Positive control: this probe can see the watched session's open transaction.
      await client.query('BEGIN'); await client.query('SELECT 1')
      expect((await operators.query('SELECT xact_start FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0].xact_start).not.toBeNull()
      await client.query('ROLLBACK')
      watchKms(pid, states)
      return rewrapQuarantine(client, { targetKeyArn: TARGET })
    })
    expect(result).toMatchObject({ complete: true, status: 'rewrapped_observed_state', examined: 4, candidates: 2, rewrapped: 2, contended: 0, failed: 0, remainingOffTarget: 0, retirementReady: false })
    expect(states.length).toBeGreaterThanOrEqual(4); expect(new Set(states)).toEqual(new Set([null]))
    const after = new Map((await allRows()).map(r => [r.id, r]))
    for (const source of [env, old]) {
      const { payloadEnc, payloadKeyId, ...unchanged } = after.get(source.id)
      const { payloadEnc: _enc, payloadKeyId: _key, ...original } = before.get(source.id)
      expect(payloadKeyId).toBe(TARGET); expect(payloadEnc).not.toBe(source.payloadEnc); expect(unchanged).toEqual(original)
    }
    expect(after.get(done.id)).toEqual(before.get(done.id)); expect(after.get(rejected)).toEqual(before.get(rejected))
    expect((await audits()).map(a => ({ ...a, recordedAt: undefined }))).toEqual([env, old].sort((a, b) => a.id.localeCompare(b.id)).map(source => ({
      operationId: result.operationId, quarantineId: source.id, recordedAt: undefined, sessionUser: operator, oldKeyId: source.payloadKeyId, newKeyId: TARGET,
      oldCipherDigest: sha(source.payloadEnc), newCipherDigest: sha(after.get(source.id).payloadEnc) })))
    __cryptoTest.resetDekCache()
    expect(await useOperator(client => verifyQuarantine(client, { targetKeyArn: TARGET }))).toMatchObject({ complete: true, verified: 3, atTarget: 3, envVerified: 0, rejectedMetadata: 1 })
    expect(JSON.stringify(result)).not.toContain('synthetic verified')
  })
  it('is idempotent: a second run has nothing to do, makes no KMS request and writes no audit', async () => {
    await seed('env'); await seed('old')
    expect(await rewrap()).toMatchObject({ complete: true, rewrapped: 2 })
    const before = await allRows(), audited = await audits()
    fake.generateCalls = []; fake.decryptCalls = []
    expect(await rewrap()).toMatchObject({ complete: true, status: 'nothing_to_do', candidates: 0, rewrapped: 0 })
    expect(fake.generateCalls).toHaveLength(0); expect(fake.decryptCalls).toHaveLength(0)
    expect(await allRows()).toEqual(before); expect(await audits()).toEqual(audited)
  })
  it('loses a race to a concurrent operator rewrap without overwriting it or duplicating its audit', async () => {
    const source = await seed('old')
    const result = await useOperator(async client => {
      watchKms((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, [], async () => {
        const replacement = await reencryptEbayQuarantine(source, TARGET)
        await useOperator(async other => {
          await other.query('SET ROLE nexus_ebay_quarantine_maintenance')
          try { expect((await other.query('SELECT public.nexus_rewrap_ebay_quarantine($1,$2,$3,$4,$5,$6,$7::uuid) AS changed', [source.id, source.payloadEnc, source.payloadKeyId, source.payloadDigest, replacement.blob, replacement.keyId, randomUUID()])).rows[0].changed).toBe(true) }
          finally { await other.query('RESET ROLE') }
        })
      })
      return rewrapQuarantine(client, { targetKeyArn: TARGET })
    })
    expect(result).toMatchObject({ complete: true, rewrapped: 0, contended: 1, remainingOffTarget: 0 })
    const stored = (await allRows())[0], audited = await audits()
    expect(audited).toHaveLength(1); expect(audited[0].operationId).not.toBe(result.operationId)
    expect(audited[0].newCipherDigest).toBe(sha(stored.payloadEnc))
  })
  it('stays incomplete when a body is admitted under the old key during the run; a rerun completes it', async () => {
    await seed('old')
    const result = await useOperator(async client => {
      watchKms((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, [], async () => { await seed('env') })
      return rewrapQuarantine(client, { targetKeyArn: TARGET })
    })
    expect(result).toMatchObject({ complete: false, rewrapped: 1, remainingOffTarget: 1, incompleteReason: 'off_target_remaining' })
    vi.restoreAllMocks()
    expect(await rewrap()).toMatchObject({ complete: true, rewrapped: 1, remainingOffTarget: 0 })
  })
  it('refuses a second concurrent run instead of moving rows back and forth', async () => {
    await seed('old')
    await useOperator(async holder => {
      await holder.query("SELECT pg_advisory_lock(hashtext('nexus:ebay-quarantine-rewrap'))")
      try { await expect(rewrap()).rejects.toMatchObject({ code: 'rewrap_in_progress' }) }
      finally { await holder.query("SELECT pg_advisory_unlock(hashtext('nexus:ebay-quarantine-rewrap'))") }
    })
    expect(await audits()).toEqual([])
    expect(await rewrap()).toMatchObject({ complete: true, rewrapped: 1 })
  })
  it('gives up on a row another writer keeps locked instead of waiting across the run', async () => {
    const source = await seed('old'), holder = await database.pool.connect()
    try {
      await holder.query('BEGIN'); await holder.query('SELECT 1 FROM "EbayNoticeQuarantine" WHERE id=$1 FOR UPDATE', [source.id])
      const started = Date.now(), result = await rewrap()
      expect(result).toMatchObject({ complete: false, contended: 1, rewrapped: 0, remainingOffTarget: 1, incompleteReason: 'off_target_remaining' })
      expect(Date.now() - started).toBeLessThan(20_000)
    } finally { await holder.query('ROLLBACK'); holder.release() }
    expect(await audits()).toEqual([])
  }, 60_000)
  it('runs the real CLI with --apply through its dedicated connection and no application-URL fallback', async () => {
    await seed('target')
    const rejected = randomUUID()
    await database.pool.query(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"signatureOk","externalId",topic,"payloadDigest",reason) VALUES ($1,'production',false,$1,'unclassified',$2,'bad_signature')`, [rejected, 'a'.repeat(64)])
    const run = (args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', 'src/scripts/cx-quarantine-rewrap.ts', ...args], {
      env: { ...process.env, CX_QUARANTINE_MAINTENANCE_DATABASE_URL: operatorUrl, DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/no_application_fallback' }, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(() => run(['--target-key-arn', TARGET])).toThrow()
    expect(JSON.parse(run(['--apply', '--target-key-arn', TARGET]))).toMatchObject({ complete: true, status: 'nothing_to_do', examined: 2, candidates: 0, retirementReady: false })
    expect(await audits()).toEqual([])
  }, 45_000)
})
