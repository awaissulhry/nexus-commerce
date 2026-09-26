import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { Pool, type PoolClient } from 'pg'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { FakeKms, FAKE_KMS_KEY_ID } from '../../../test-support/fake-kms.js'
import { __cryptoTest, __test, encryptCredentials, encryptSecret } from '../../../lib/crypto.js'
import { openEbayQuarantineBody, reencryptEbayQuarantine } from './ebay-quarantine-crypto.js'
import { verifyQuarantine } from './ebay-quarantine-verification.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>, operators: Pool, fake: FakeKms, operator: string, operatorUrl: string
async function seed(mode: 'env' | 'kms' = 'env', raw = Buffer.from('synthetic verified opaque body')) {
  const id = randomUUID(), binding = { environment: 'production', signatureOk: true, externalId: `provider-${randomUUID()}`, topic: 'FUTURE_TOPIC',
    subjectHash: null, payloadDigest: createHash('sha256').update(raw).digest('hex') }
  const sealed = { version: 1, binding, rawBody: raw.toString('base64'), header: 'synthetic-signature' }
  const cipher = mode === 'env' ? { blob: encryptSecret(JSON.stringify(sealed)), keyId: 'env' } : await encryptCredentials(sealed)
  await database.pool.query(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"signatureOk","externalId",topic,"payloadEnc","payloadKeyId","payloadDigest",reason)
    VALUES ($1,'production',true,$2,'FUTURE_TOPIC',$3,$4,$5,'owner_unknown')`, [id, binding.externalId, cipher.blob, cipher.keyId, binding.payloadDigest])
  return { ...binding, id, payloadEnc: cipher.blob, payloadKeyId: cipher.keyId }
}
async function useOperator<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await operators.connect()
  try { return await run(client) } finally { client.release() }
}
const verify = () => useOperator(client => verifyQuarantine(client, { targetKeyArn: FAKE_KMS_KEY_ID }))
const allRows = async () => (await database.pool.query('SELECT * FROM "EbayNoticeQuarantine" ORDER BY id')).rows
async function handoff(id: string) {
  const receiptId = randomUUID()
  const externalId = (await database.pool.query('SELECT "externalId" FROM "EbayNoticeQuarantine" WHERE id=$1', [id])).rows[0].externalId
  await database.pool.query(`INSERT INTO "WebhookEvent" (id,"workspaceId",channel,"externalId","eventType",payload,"signatureOk","verifiedBy","updatedAt")
    VALUES ($1,'nexus_legacy_workspace','EBAY',$2,'FUTURE_TOPIC','{}',true,'ebay_ecdsa',now())`, [receiptId, `ebay:production:${externalId}`])
  await database.pool.query(`UPDATE "EbayNoticeQuarantine" SET deliveries=deliveries+1,"lastReceivedAt"=clock_timestamp(),"resolvedWorkspaceId"='nexus_legacy_workspace',"resolvedReceiptId"=$2,"resolvedAt"=clock_timestamp() WHERE id=$1`, [id, receiptId])
}

describe.skipIf(!concurrentDatabaseUrl())('cold quarantine verification through private PostgreSQL authority', () => {
  beforeEach(async () => {
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64')); vi.stubEnv('NEXUS_KMS_KEY_ID', 'alias/test')
    __test.resetKeyCache(); __cryptoTest.resetDekCache(); fake = new FakeKms(); __cryptoTest.setKmsClient(fake as never)
    database = await concurrentDatabase()
    await database.pool.query(readFileSync(new URL('../../../../../../packages/database/prisma/migrations/20260923h_cx_quarantine_verification/migration.sql', import.meta.url), 'utf8'))
    operator = `verify_operator_${randomBytes(6).toString('hex')}`
    await database.pool.query(`CREATE ROLE ${operator} LOGIN NOINHERIT PASSWORD 'disposable-test-only'; GRANT nexus_ebay_quarantine_maintenance TO ${operator} WITH INHERIT FALSE, SET TRUE;
      GRANT nexus_ebay_quarantine_custodian TO ${operator} WITH INHERIT FALSE, SET TRUE`)
    const url = concurrentDatabaseUrl()!; url.pathname = `/${database.name}`; url.username = operator; url.password = 'disposable-test-only'; operatorUrl = url.toString()
    operators = new Pool({ connectionString: operatorUrl, max: 4 })
  }, 180_000)
  afterEach(async () => {
    vi.restoreAllMocks(); await operators?.end()
    if (database) { await database.pool.query(`DROP ROLE IF EXISTS ${operator}`); await database.pool.query(`DROP ROLE IF EXISTS ${operator}_metadata`); await database.close() }
    vi.unstubAllEnvs()
  }, 60_000)

  it('cold-opens env and KMS history with no database transaction across KMS and no data writes', async () => {
    await seed('env', Buffer.from('{malformed future JSON'))
    const kms = await seed('kms'); await handoff(kms.id)
    const before = await allRows(), states: Array<Date | null> = []
    fake.generateCalls = []; fake.decryptCalls = []
    const send = fake.send.bind(fake)
    const result = await useOperator(async client => {
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      vi.spyOn(fake, 'send').mockImplementation(async command => {
        states.push((await operators.query('SELECT xact_start FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0].xact_start)
        return send(command)
      })
      return verifyQuarantine(client, { targetKeyArn: FAKE_KMS_KEY_ID })
    })
    expect(result).toMatchObject({ complete: true, status: 'verified_observed_state', verified: 2, envVerified: 1, kmsVerified: 1, atTarget: 1, retirementReady: false })
    expect(states).toEqual([null]); expect(fake.generateCalls).toHaveLength(0); expect(fake.decryptCalls).toHaveLength(1)
    expect(await allRows()).toEqual(before)
    expect((await database.pool.query('SELECT count(*)::int AS n FROM "EbayQuarantineMaintenanceAudit"')).rows[0].n).toBe(0)
  })
  it('detects denied old-key access despite a working warm-cache positive control', async () => {
    const source = await seed('kms'); await openEbayQuarantineBody(source)
    const spy = vi.spyOn(fake, 'send').mockRejectedValue(Object.assign(new Error('synthetic-private-provider-text'), { name: 'AccessDeniedException' }))
    expect((await openEbayQuarantineBody(source)).length).toBeGreaterThan(0)
    const result = await verify()
    expect(result).toMatchObject({ complete: false, verified: 0, failed: 1, failedAccess: 1, failedIntegrity: 0, incompleteReason: 'verification_failed' })
    expect(spy).toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('synthetic-private')
  })
  it('allows delivery and handoff-pointer changes without confusing them with encryption changes', async () => {
    const source = await seed('kms'), send = fake.send.bind(fake)
    let changed = false
    vi.spyOn(fake, 'send').mockImplementation(async command => { if (!changed) { changed = true; await handoff(source.id) }; return send(command) })
    expect(await verify()).toMatchObject({ complete: true, unchangedObservedState: true, verified: 1 })
    expect((await allRows())[0]).toMatchObject({ deliveries: 2, resolvedWorkspaceId: 'nexus_legacy_workspace' })
  })
  it('refuses a full-current-state claim when a new notice commits during KMS work', async () => {
    await seed('kms'); const send = fake.send.bind(fake)
    let changed = false
    vi.spyOn(fake, 'send').mockImplementation(async command => { if (!changed) { changed = true; await seed('env') }; return send(command) })
    expect(await verify()).toMatchObject({ complete: false, verified: 1, unchangedObservedState: false, incompleteReason: 'state_changed' })
  })
  it('detects a real audited concurrent rewrap rather than trusting unchanged row counts', async () => {
    const source = await seed('kms'), replacement = await reencryptEbayQuarantine(source, FAKE_KMS_KEY_ID), send = fake.send.bind(fake)
    let changed = false
    vi.spyOn(fake, 'send').mockImplementation(async command => {
      if (!changed) {
        changed = true
        await useOperator(async client => {
          await client.query('SET ROLE nexus_ebay_quarantine_maintenance')
          try { await client.query('SELECT public.nexus_rewrap_ebay_quarantine($1,$2,$3,$4,$5,$6,$7::uuid)', [source.id,source.payloadEnc,source.payloadKeyId,source.payloadDigest,replacement.blob,replacement.keyId,randomUUID()]) }
          finally { await client.query('RESET ROLE') }
        })
      }
      return send(command)
    })
    expect(await verify()).toMatchObject({ complete: false, verified: 1, unchangedObservedState: false, incompleteReason: 'state_changed' })
    expect((await database.pool.query('SELECT count(*)::int AS n FROM "EbayQuarantineMaintenanceAudit"')).rows[0].n).toBe(1)
  })
  it('denies both maintenance read functions to the normal runtime despite system GUCs', async () => {
    const source = await seed(), client = await database.pool.connect()
    try {
      await client.query('SET ROLE nexus_workspace_runtime'); await client.query("SELECT set_config('nexus.actor_id','',false)")
      await expect(client.query('SELECT * FROM public.nexus_ebay_quarantine_manifest(NULL,10)')).rejects.toMatchObject({ code: '42501' })
      await expect(client.query('SELECT * FROM public.nexus_ebay_quarantine_cipher_batch($1::text[])', [[source.id]])).rejects.toMatchObject({ code: '42501' })
    } finally { await client.query('RESET ROLE'); client.release() }
  })
  it('refuses oversized ciphertext at the database door before returning its bytes', async () => {
    const id = randomUUID()
    await database.pool.query(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"signatureOk","externalId",topic,"payloadEnc","payloadKeyId","payloadDigest",reason)
      VALUES ($1,'production',true,$1,'FUTURE_TOPIC',$2,'env',$3,'owner_unknown')`, [id, 'v1:'+'x'.repeat(3_145_729), 'a'.repeat(64)])
    fake.decryptCalls = []
    await expect(verify()).rejects.toMatchObject({ code: 'verification_unavailable' })
    await useOperator(async client => {
      await client.query('SET ROLE nexus_ebay_quarantine_custodian')
      try { await expect(client.query('SELECT * FROM public.nexus_ebay_quarantine_cipher_batch($1::text[])', [[id]])).rejects.toMatchObject({ code: '22023', message: 'Quarantine ciphertext exceeds the maintenance read bound' }) }
      finally { await client.query('RESET ROLE') }
    })
    expect(fake.decryptCalls).toHaveLength(0)
  })
  it('bounds body batches and excludes rejected-signature bodies at the private door', async () => {
    const rejected = randomUUID()
    await database.pool.query(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"signatureOk","externalId",topic,"payloadDigest",reason) VALUES ($1,'production',false,$1,'unclassified',$2,'bad_signature')`, [rejected,'a'.repeat(64)])
    await useOperator(async client => {
      await client.query('SET ROLE nexus_ebay_quarantine_custodian')
      try {
        for (const ids of [[], [rejected,rejected], [null], Array.from({ length: 6 }, () => randomUUID()), [[rejected]]]) {
          await expect(client.query('SELECT * FROM public.nexus_ebay_quarantine_cipher_batch($1::text[])', [ids])).rejects.toMatchObject({ code: '22023' })
        }
        expect((await client.query('SELECT * FROM public.nexus_ebay_quarantine_cipher_batch($1::text[])', [[rejected]])).rows).toEqual([])
      } finally { await client.query('RESET ROLE') }
    })
    expect(await verify()).toMatchObject({ complete: true, status: 'metadata_only', rejectedMetadata: 1, verified: 0, kmsVerified: 0, retirementReady: false })
  })
  it('gives a maintenance operator no way to run code as the writer through its own temporary type', async () => {
    const source = await seed('env'), before = await allRows()
    const acl = async () => (await database.pool.query(`SELECT p.oid::regprocedure::text AS name, p.proacl::text AS acl, p.prosecdef, p.proconfig::text AS config
      FROM pg_proc p WHERE p.proname LIKE 'nexus%quarantine%' ORDER BY 1`)).rows
    const aclBefore = await acl()
    await useOperator(async client => {
      // PostgreSQL searches the caller's temporary schema first for type names
      // unless a definer's search_path names pg_temp (last).
      await client.query(`CREATE FUNCTION pg_temp.escalate(value pg_catalog.text) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
        -- Owner-only: any other caller gets 42501, so the control below is decisive.
        EXECUTE 'ALTER FUNCTION public.nexus_ebay_quarantine_cipher_batch(pg_catalog.text[]) SECURITY INVOKER';
        EXECUTE 'GRANT EXECUTE ON FUNCTION public.nexus_ebay_quarantine_cipher_batch(pg_catalog.text[]) TO PUBLIC';
        RETURN true; END $$`)
      await client.query('CREATE DOMAIN pg_temp.text AS pg_catalog.text CHECK (pg_temp.escalate(VALUE))')
      try {
        for (const [role, sql, values] of [['maintenance', 'SELECT * FROM public.nexus_ebay_quarantine_manifest(NULL,10)', []],
          ['maintenance', 'SELECT * FROM public.nexus_ebay_quarantine_inventory(NULL,10)', []],
          ['custodian', 'SELECT * FROM public.nexus_ebay_quarantine_cipher_batch($1::pg_catalog.text[])', [[source.id]]],
          // A stale expected cipher: the call runs but its CAS can never legitimately apply.
          ['maintenance', 'SELECT public.nexus_rewrap_ebay_quarantine($1,$2,$3,$4,$5,$6,$7::uuid)', [source.id, 'v1:stale', source.payloadKeyId, source.payloadDigest, 'v2:synthetic', FAKE_KMS_KEY_ID, randomUUID()]]] as const) {
          await client.query(`SET ROLE nexus_ebay_quarantine_${role}`)
          // Positive control: outside a definer the caller's temporary type IS resolved, and
          // its check runs with the caller's own (insufficient) rights.
          await expect(client.query("SELECT 'x'::text AS v")).rejects.toMatchObject({ code: '42501' })
          await client.query(sql, [...values]).catch(() => {})
        }
      } finally { await client.query('RESET ROLE'); await client.query('DISCARD TEMP') }
    })
    expect(await acl()).toEqual(aclBefore)
    expect(await allRows()).toEqual(before)
    expect((await database.pool.query('SELECT count(*)::int AS n FROM "EbayQuarantineMaintenanceAudit"')).rows[0].n).toBe(0)
  })
  it('keeps ciphertext from a metadata-only operator, from the bare login and from PUBLIC', async () => {
    const source = await seed('env'), metadata = `${operator}_metadata`
    await database.pool.query(`CREATE ROLE ${metadata} LOGIN NOINHERIT PASSWORD 'disposable-test-only'; GRANT nexus_ebay_quarantine_maintenance TO ${metadata} WITH INHERIT FALSE, SET TRUE`)
    const url = new URL(operatorUrl); url.username = metadata
    const limited = new Pool({ connectionString: url.toString(), max: 1 })
    try {
      const client = await limited.connect()
      try {
        await expect(verifyQuarantine(client, { targetKeyArn: FAKE_KMS_KEY_ID })).rejects.toMatchObject({ code: 'authority_denied' })
        await client.query('SET ROLE nexus_ebay_quarantine_maintenance')
        await expect(client.query('SELECT * FROM public.nexus_ebay_quarantine_cipher_batch($1::text[])', [[source.id]])).rejects.toMatchObject({ code: '42501' })
        expect((await client.query('SELECT count(*)::int AS n FROM public.nexus_ebay_quarantine_manifest(NULL,10)')).rows[0].n).toBe(1)
        await client.query('RESET ROLE')
      } finally { client.release() }
    } finally { await limited.end() }
    await useOperator(async client => {
      for (const sql of ['SELECT * FROM public.nexus_ebay_quarantine_manifest(NULL,10)', 'SELECT * FROM public.nexus_ebay_quarantine_cipher_batch($1::text[])']) {
        await expect(client.query(sql, sql.includes('$1') ? [[source.id]] : [])).rejects.toMatchObject({ code: '42501' })
      }
    })
    const acl = (await database.pool.query(`SELECT p.oid::regprocedure::text AS name, has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
      FROM pg_proc p WHERE p.proname IN ('nexus_ebay_quarantine_manifest','nexus_ebay_quarantine_cipher_batch','nexus_ebay_quarantine_inventory','nexus_rewrap_ebay_quarantine') ORDER BY 1`)).rows
    expect(acl).toHaveLength(4); expect(acl.every(row => row.public_execute === false)).toBe(true)
  })
  it('opens every retained body across several batches in one run', async () => {
    for (let i = 0; i < 7; i++) await seed(i % 2 ? 'kms' : 'env')
    fake.decryptCalls = []
    expect(await verify()).toMatchObject({ complete: true, verified: 7, envVerified: 4, kmsVerified: 3, atTarget: 3 })
    expect(fake.decryptCalls).toHaveLength(3)
  })
  it('runs the real CLI against env-only retained data without any AWS or application-URL fallback', async () => {
    await seed('env')
    const output = execFileSync(process.execPath, ['--import','tsx','src/scripts/cx-quarantine-verify.ts','--target-key-arn',FAKE_KMS_KEY_ID], {
      env: { ...process.env, CX_QUARANTINE_MAINTENANCE_DATABASE_URL: operatorUrl, DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/no_application_fallback' }, encoding: 'utf8', timeout: 20_000,
    })
    expect(JSON.parse(output)).toMatchObject({ complete: true, envVerified: 1, kmsVerified: 0, atTarget: 0, retirementReady: false })
    expect(output).not.toContain('synthetic verified opaque body')
  }, 45_000)
})
