import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { Pool, type PoolClient } from 'pg'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { encryptCredentials, __cryptoTest, __test } from '../../../lib/crypto.js'
import { FakeKms, FAKE_KMS_KEY_ID } from '../../../test-support/fake-kms.js'
import { reencryptEbayQuarantine } from './ebay-quarantine-crypto.js'
import { readQuarantineInventory } from './ebay-quarantine-inventory.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>, operators: Pool
let operatorUrl: string
const operator = `q_operator_${randomBytes(6).toString('hex')}`
const writer = 'nexus_ebay_quarantine_writer', maintenance = 'nexus_ebay_quarantine_maintenance'
const functionSql = 'SELECT public.nexus_rewrap_ebay_quarantine($1,$2,$3,$4,$5,$6,$7::uuid) AS changed'
async function seed(id = randomUUID()) {
  const rawBody = Buffer.from('synthetic verified future-topic body')
  const digest = createHash('sha256').update(rawBody).digest('hex')
  const binding = { environment: 'production', signatureOk: true, externalId: id, topic: 'FUTURE_TOPIC', subjectHash: null, payloadDigest: digest }
  const old = await encryptCredentials({ version: 1, binding, rawBody: rawBody.toString('base64'), header: 'synthetic-signature' })
  const replacement = await reencryptEbayQuarantine({ ...binding, payloadEnc: old.blob, payloadKeyId: old.keyId }, FAKE_KMS_KEY_ID)
  await database.pool.query(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"signatureOk","externalId",topic,"payloadEnc","payloadKeyId","payloadDigest",reason)
    VALUES ($1,'production',true,$1,'FUTURE_TOPIC',$2,$3,$4,'subject_or_topic_unresolved')`, [id, old.blob, old.keyId, digest])
  return { id, old, replacement, args: [id, old.blob, old.keyId, digest, replacement.blob, replacement.keyId, randomUUID()] }
}
async function asOperator<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await operators.connect()
  try { await client.query(`SET ROLE ${maintenance}`); return await work(client) }
  finally { await client.query('RESET ROLE'); client.release() }
}
const rewrap = (args: unknown[]) => asOperator(async c => (await c.query(functionSql, args)).rows[0].changed)
const row = async (id: string) => (await database.pool.query('SELECT * FROM "EbayNoticeQuarantine" WHERE id=$1', [id])).rows[0]
const audits = async (id: string) => (await database.pool.query('SELECT * FROM "EbayQuarantineMaintenanceAudit" WHERE "quarantineId"=$1', [id])).rows
const sharedSql = () => readFileSync(new URL('../../../../../../packages/database/workspaces/ebay-quarantine.sql', import.meta.url), 'utf8')
async function blockedRewraps(count: number) {
  const until = Date.now() + 5_000
  while (Date.now() < until) {
    const result = await operators.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock' AND query LIKE 'SELECT public.nexus_rewrap_ebay_quarantine%'")
    if (result.rows[0].n === count) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Expected ${count} overlapping blocked rewrap transactions`)
}

describe.skipIf(!concurrentDatabaseUrl())('private eBay quarantine maintenance authority and atomic audit in PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64')); vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    __test.resetKeyCache(); __cryptoTest.setKmsClient(new FakeKms() as never)
    database = await concurrentDatabase()
    await database.pool.query(`CREATE ROLE ${operator} LOGIN NOINHERIT PASSWORD 'disposable-test-only'`)
    await database.pool.query(`GRANT ${maintenance} TO ${operator} WITH INHERIT FALSE, SET TRUE`)
    const target = concurrentDatabaseUrl()!; target.pathname = `/${database.name}`; target.username = operator; target.password = 'disposable-test-only'
    operatorUrl = target.toString()
    operators = new Pool({ connectionString: target.toString(), max: 4 })
  }, 180_000)
  afterAll(async () => {
    await operators?.end()
    if (database) { await database.pool.query(`DROP ROLE IF EXISTS ${operator}`); await database.close() }
    vi.unstubAllEnvs()
  }, 60_000)

  it('gives the maintenance caller EXECUTE but no writer identity or direct table access', async () => {
    await asOperator(async c => {
      const privileges = (await c.query(`SELECT current_user AS role,
        pg_has_role(current_user,$1,'SET') AS writer_set,
        has_table_privilege(current_user,'"EbayNoticeQuarantine"','SELECT') AS direct_read,
        has_column_privilege(current_user,'"EbayNoticeQuarantine"','payloadEnc','UPDATE') AS direct_write`, [writer])).rows[0]
      expect(privileges).toEqual({ role: maintenance, writer_set: false, direct_read: false, direct_write: false })
      await expect(c.query('SELECT * FROM "EbayQuarantineMaintenanceAudit"')).rejects.toMatchObject({ code: '42501' })
      await expect(c.query(`SET ROLE ${writer}`)).rejects.toMatchObject({ code: '42501' })
      await expect(c.query('ALTER FUNCTION public.nexus_rewrap_ebay_quarantine(text,text,text,text,text,text,uuid) SECURITY INVOKER')).rejects.toMatchObject({ code: '42501' })
    })
  })
  it('denies runtime invocation and cipher writes even with spoofed maintenance GUCs', async () => {
    const fixture = await seed(), c = await database.pool.connect()
    try {
      await c.query('SET ROLE nexus_workspace_runtime')
      await c.query("SELECT set_config('nexus.actor_id','',false),set_config('nexus.quarantine_maintenance','1',false)")
      await expect(c.query(functionSql, fixture.args)).rejects.toMatchObject({ code: '42501' })
      await expect(c.query('UPDATE "EbayNoticeQuarantine" SET "payloadEnc"=$1 WHERE id=$2', [fixture.replacement.blob, fixture.id])).rejects.toMatchObject({ code: '42501' })
      await expect(c.query('SELECT * FROM "EbayQuarantineMaintenanceAudit"')).rejects.toMatchObject({ code: '42501' })
      await expect(c.query('INSERT INTO "EbayQuarantineMaintenanceAudit" ("operationId") VALUES ($1)', [randomUUID()])).rejects.toMatchObject({ code: '42501' })
    } finally { await c.query('RESET ROLE'); c.release() }
  })
  it('changes only ciphertext and key metadata, with one server-attributed audit', async () => {
    const fixture = await seed(), before = await row(fixture.id)
    expect(await rewrap(fixture.args)).toBe(true)
    const after = await row(fixture.id), audit = await audits(fixture.id)
    expect(after).toEqual({ ...before, payloadEnc: fixture.replacement.blob, payloadKeyId: FAKE_KMS_KEY_ID })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ operationId: fixture.args[6], quarantineId: fixture.id, sessionUser: operator, oldKeyId: 'env', newKeyId: FAKE_KMS_KEY_ID })
    expect(audit[0].oldCipherDigest).toBe(createHash('sha256').update(fixture.old.blob).digest('hex'))
    expect(audit[0].newCipherDigest).toBe(createHash('sha256').update(fixture.replacement.blob).digest('hex'))
    expect(JSON.stringify(audit)).not.toContain(fixture.old.blob)
    expect(JSON.stringify(audit)).not.toContain(fixture.replacement.blob)
  })
  it.each([1, 2, 3])('refuses a stale expected cipher/key/digest at argument %s without audit', async index => {
    const fixture = await seed(), before = await row(fixture.id), args = [...fixture.args]
    args[index] = index === 3 ? 'b'.repeat(64) : 'stale'
    expect(await rewrap(args)).toBe(false)
    expect(await row(fixture.id)).toEqual(before); expect(await audits(fixture.id)).toEqual([])
  })
  it('allows only one of two concurrent replacements of the same original', async () => {
    const fixture = await seed(), otherArgs = [...fixture.args]; otherArgs[6] = randomUUID()
    const blocker = await database.pool.connect()
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM "EbayNoticeQuarantine" WHERE id=$1 FOR UPDATE', [fixture.id])
      const outcomes = Promise.all([rewrap(fixture.args), rewrap(otherArgs)])
      await blockedRewraps(2)
      await blocker.query('COMMIT')
      expect((await outcomes).sort()).toEqual([false, true])
    } finally { await blocker.query('ROLLBACK'); blocker.release() }
    expect(await audits(fixture.id)).toHaveLength(1)
  })
  it('rolls ciphertext back when the mandatory audit insert fails', async () => {
    const fixture = await seed(), before = await row(fixture.id)
    await database.pool.query(`CREATE FUNCTION test_reject_quarantine_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$;
      CREATE TRIGGER test_reject_quarantine_audit BEFORE INSERT ON "EbayQuarantineMaintenanceAudit" FOR EACH ROW EXECUTE FUNCTION test_reject_quarantine_audit()`)
    try { await expect(rewrap(fixture.args)).rejects.toThrow('Synthetic audit failure') }
    finally { await database.pool.query('DROP TRIGGER test_reject_quarantine_audit ON "EbayQuarantineMaintenanceAudit"; DROP FUNCTION test_reject_quarantine_audit()') }
    expect(await row(fixture.id)).toEqual(before); expect(await audits(fixture.id)).toEqual([])
  })
  it('preserves concurrent redelivery counts and the original receipt metadata', async () => {
    const fixture = await seed(), before = await row(fixture.id), delivery = await database.pool.connect()
    try {
      await delivery.query('BEGIN'); await delivery.query('SET LOCAL ROLE nexus_workspace_runtime')
      await delivery.query('UPDATE "EbayNoticeQuarantine" SET deliveries=deliveries+1,"lastReceivedAt"=clock_timestamp() WHERE id=$1', [fixture.id])
      const changed = rewrap(fixture.args)
      await blockedRewraps(1)
      await delivery.query('COMMIT'); expect(await changed).toBe(true)
    } finally { await delivery.query('ROLLBACK'); delivery.release() }
    const after = await row(fixture.id)
    expect(after).toMatchObject({ deliveries: before.deliveries + 1, payloadDigest: before.payloadDigest, externalId: before.externalId, receivedAt: before.receivedAt })
    expect(await audits(fixture.id)).toHaveLength(1)
  })
  it('never gives a rejected signature a ciphertext body', async () => {
    const id = randomUUID(), fixture = await seed()
    await database.pool.query(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"signatureOk","externalId",topic,"payloadDigest",reason) VALUES ($1,'production',false,$1,'unclassified',$2,'invalid_signature')`, [id, 'a'.repeat(64)])
    fixture.args[0] = id
    expect(await rewrap(fixture.args)).toBe(false)
    expect((await row(id)).payloadEnc).toBeNull(); expect(await audits(id)).toEqual([])
  })
  it('keeps audits append-only even through owner SQL', async () => {
    const fixture = await seed(); await rewrap(fixture.args)
    await expect(database.pool.query('DELETE FROM "EbayQuarantineMaintenanceAudit" WHERE "quarantineId"=$1', [fixture.id])).rejects.toMatchObject({ code: '42501' })
    await expect(database.pool.query('UPDATE "EbayQuarantineMaintenanceAudit" SET "newKeyId"=\'changed\' WHERE "quarantineId"=$1', [fixture.id])).rejects.toMatchObject({ code: '42501' })
    await expect(database.pool.query('TRUNCATE "EbayQuarantineMaintenanceAudit"')).rejects.toMatchObject({ code: '42501' })
  })
  it('preserves an adoption pointer committed while rewrap is waiting', async () => {
    const fixture = await seed(), receiptId = randomUUID(), handoff = await database.pool.connect()
    try {
      await handoff.query('BEGIN')
      await handoff.query(`INSERT INTO "WebhookEvent" (id,"workspaceId",channel,"externalId","eventType",payload,"signatureOk","verifiedBy","updatedAt")
        VALUES ($1,'nexus_legacy_workspace','EBAY',$2,'FUTURE_TOPIC','{}',true,'ebay_ecdsa',now())`, [receiptId, `ebay:production:${fixture.id}`])
      await handoff.query(`UPDATE "EbayNoticeQuarantine" SET "resolvedWorkspaceId"='nexus_legacy_workspace',"resolvedReceiptId"=$2,"resolvedAt"=clock_timestamp() WHERE id=$1`, [fixture.id, receiptId])
      const changed = rewrap(fixture.args)
      await blockedRewraps(1)
      await handoff.query('COMMIT'); expect(await changed).toBe(true)
    } finally { await handoff.query('ROLLBACK'); handoff.release() }
    expect(await row(fixture.id)).toMatchObject({ resolvedWorkspaceId: 'nexus_legacy_workspace', resolvedReceiptId: receiptId, payloadEnc: fixture.replacement.blob })
    expect(await audits(fixture.id)).toHaveLength(1)
  })
  it('leaves migration administrators unable to inherit or SET the writer after installation', async () => {
    const result = (await database.pool.query(`SELECT pg_has_role(current_user,$1,'SET') AS can_set,
      pg_has_role(current_user,$1,'USAGE') AS inherits, has_schema_privilege($1,'public','CREATE') AS can_create`, [writer])).rows[0]
    expect(result).toEqual({ can_set: false, inherits: false, can_create: false })
    const fn = (await database.pool.query(`SELECT pg_get_userbyid(proowner) AS owner, prosecdef, proconfig
      FROM pg_proc WHERE oid='public.nexus_rewrap_ebay_quarantine(text,text,text,text,text,text,uuid)'::regprocedure`)).rows[0]
    // pg_temp last: a definer that omits it resolves caller-created temporary types first (C11f6b review).
    expect(fn).toEqual({ owner: writer, prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'] })
    const rights = (await database.pool.query(`SELECT has_table_privilege($1,'"EbayNoticeQuarantine"','SELECT') AS read,
      has_column_privilege($1,'"EbayNoticeQuarantine"','payloadEnc','UPDATE') AS cipher,
      has_column_privilege($1,'"EbayNoticeQuarantine"','deliveries','UPDATE') AS delivery,
      has_table_privilege($1,'"EbayQuarantineMaintenanceAudit"','INSERT') AS audit_insert,
      has_table_privilege($1,'"EbayQuarantineMaintenanceAudit"','UPDATE') AS audit_update`, [writer])).rows[0]
    expect(rights).toEqual({ read: true, cipher: true, delivery: false, audit_insert: true, audit_update: false })
  })
  it.each([[0, null], [3, 'invalid-digest'], [4, 'v1:invalid'], [5, 'alias/unsafe'], [6, null]])('rejects malformed maintenance arguments without changing data', async (index, value) => {
    const fixture = await seed(), before = await row(fixture.id), args: unknown[] = [...fixture.args]
    args[index as number] = value
    await expect(rewrap(args)).rejects.toMatchObject({ code: '22023' })
    expect(await row(fixture.id)).toEqual(before); expect(await audits(fixture.id)).toEqual([])
  })
  it('does not write a success audit for an identical envelope', async () => {
    const fixture = await seed(); expect(await rewrap(fixture.args)).toBe(true)
    const args = [...fixture.args]; args[1] = fixture.replacement.blob; args[2] = fixture.replacement.keyId
    expect(await rewrap(args)).toBe(false); expect(await audits(fixture.id)).toHaveLength(1)
  })
  it.each(['deliveries=deliveries+1', '"lastReceivedAt"="lastReceivedAt"+interval \'1 second\'',
    'reason=\'changed\'', '"subjectHash"=\'changed\'', '"resolvedWorkspaceId"=\'changed\''])('the trigger refuses other-field changes even if writer column rights regress: %s', async assignment => {
    const fixture = await seed(), before = await row(fixture.id), c = await database.pool.connect()
    try {
      // Disposable, rolled-back test capability: reach the trigger's independent
      // defense even if its outer two-column privilege boundary were regressed.
      await c.query('BEGIN')
      await c.query(`GRANT ${writer} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`)
      await c.query(`GRANT UPDATE ON "EbayNoticeQuarantine" TO ${writer}`)
      await c.query(`SET LOCAL ROLE ${writer}`)
      await expect(c.query(`UPDATE "EbayNoticeQuarantine" SET ${assignment} WHERE id=$1`, [fixture.id])).rejects.toMatchObject({ code: '23514' })
    } finally { await c.query('ROLLBACK'); c.release() }
    expect(await row(fixture.id)).toEqual(before)
  })
  it('reapplies the shared policy and the actual additive migration without privilege drift', async () => {
    await database.pool.query(sharedSql())
    await database.pool.query('DROP TABLE "EbayQuarantineMaintenanceAudit"')
    await database.pool.query(readFileSync(new URL('../../../../../../packages/database/prisma/migrations/20260923f_cx_quarantine_maintenance/migration.sql', import.meta.url), 'utf8'))
    const fixture = await seed(); expect(await rewrap(fixture.args)).toBe(true)
    expect(await audits(fixture.id)).toHaveLength(1)
  })
  it('supports concurrent database bootstraps sharing the dedicated cluster roles', async () => {
    const results = await Promise.allSettled([concurrentDatabase(), concurrentDatabase()])
    try { expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']) }
    finally { for (const result of results) if (result.status === 'fulfilled') await result.value.close() }
    const fixture = await seed(); expect(await rewrap(fixture.args)).toBe(true)
  }, 180_000)
  it('shows the complete global metadata census without exposing ciphertext or provider identity', async () => {
    // Exercise the actual additive inventory migration after historical F4 replay.
    await database.pool.query(readFileSync(new URL('../../../../../../packages/database/prisma/migrations/20260923g_cx_quarantine_inventory/migration.sql', import.meta.url), 'utf8'))
    // Resolved history must occur in both the initial and later keyset pages.
    // Random placement could let a one-branch history-filter regression survive.
    for (const id of ['00000000-0000-0000-0000-000000000001','ffffffff-ffff-ffff-ffff-ffffffffffff']) {
      const fixture = await seed(id), receiptId = randomUUID()
      await database.pool.query(`INSERT INTO "WebhookEvent" (id,"workspaceId",channel,"externalId","eventType",payload,"signatureOk","verifiedBy","updatedAt")
        VALUES ($1,'nexus_legacy_workspace','EBAY',$2,'FUTURE_TOPIC','{}',true,'ebay_ecdsa',now())`, [receiptId, `ebay:production:${fixture.id}`])
      await database.pool.query(`UPDATE "EbayNoticeQuarantine" SET "resolvedWorkspaceId"='nexus_legacy_workspace',"resolvedReceiptId"=$2,"resolvedAt"=clock_timestamp() WHERE id=$1`, [fixture.id, receiptId])
    }
    const rejected = randomUUID()
    await database.pool.query(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"signatureOk","externalId",topic,"payloadDigest",reason) VALUES ($1,'production',false,$1,'unclassified',$2,'invalid_signature')`, [rejected, 'a'.repeat(64)])
    const count = Number((await database.pool.query('SELECT count(*) FROM "EbayNoticeQuarantine"')).rows[0].count)
    const result = await asOperator(c => readQuarantineInventory(c, { pageSize: 3, maxRows: 1000, targetKeyArn: FAKE_KMS_KEY_ID }))
    expect(result).toMatchObject({ examined: count, snapshotComplete: true, recovery: 'not_checked', retirementReady: false })
    expect(result.resolved).toBeGreaterThan(0)
    expect(result.rejectedMetadata).toBeGreaterThan(0)
    const page = await asOperator(c => c.query('SELECT * FROM public.nexus_ebay_quarantine_inventory(NULL,100)'))
    expect(Object.keys(page.rows[0]).sort()).toEqual(['id','signatureOk','payloadPresent','payloadKeyId','apparentVersion','resolved','ownerKnown','receivedAt'].sort())
  })
  it('denies global inventory to the ordinary runtime even with system actor settings', async () => {
    const c = await database.pool.connect()
    try {
      await c.query('SET ROLE nexus_workspace_runtime'); await c.query("SELECT set_config('nexus.actor_id','',false)")
      await expect(c.query('SELECT * FROM public.nexus_ebay_quarantine_inventory(NULL,10)')).rejects.toMatchObject({ code: '42501' })
    } finally { await c.query('RESET ROLE'); c.release() }
  })
  it('keeps a snapshot stable while a new notice commits, then shows it in the next snapshot', async () => {
    await asOperator(async c => {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const before = (await c.query('SELECT * FROM public.nexus_ebay_quarantine_inventory(NULL,100)')).rows
      const inserted = await seed()
      const after = (await c.query('SELECT * FROM public.nexus_ebay_quarantine_inventory(NULL,100)')).rows
      expect(after).toEqual(before)
      expect(after.some(value => value.id === inserted.id)).toBe(false)
      await c.query('COMMIT')
      const next = (await c.query('SELECT * FROM public.nexus_ebay_quarantine_inventory(NULL,100)')).rows
      expect(next.some(value => value.id === inserted.id)).toBe(true)
    })
  })
  it.each([0,101,null])('refuses unbounded/invalid inventory page size %s', async limit => {
    await asOperator(async c => { await expect(c.query('SELECT * FROM public.nexus_ebay_quarantine_inventory(NULL,$1)', [limit])).rejects.toMatchObject({ code: '22023' }) })
  })
  it('runs the actual operator CLI and exits nonzero for an incomplete census', async () => {
    const env = { ...process.env, CX_QUARANTINE_MAINTENANCE_DATABASE_URL: operatorUrl, DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/do_not_fallback' }
    const run = (maxRows: string) => execFileSync(process.execPath, ['--import', 'tsx', 'src/scripts/cx-quarantine-inventory.ts', '--max-rows', maxRows, '--page-size', '3'], { env, encoding: 'utf8', timeout: 20_000 })
    expect(JSON.parse(run('1000'))).toMatchObject({ scope: 'all_quarantine', snapshotComplete: true, recovery: 'not_checked', retirementReady: false })
    try { run('1'); throw new Error('Expected partial inventory exit') }
    catch (error) {
      const result = error as { status: number; stdout: string }
      expect(result.status).toBe(2)
      expect(JSON.parse(result.stdout)).toMatchObject({ examined: 1, snapshotComplete: false, incompleteReason: 'row_limit' })
    }
  }, 45_000)
})
