import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool, type PoolClient } from 'pg'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'
import { readEbayDeletionCensus } from './ebay-deletion-census.js'
import { withQuarantineSnapshot } from './quarantine-snapshot.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>, operators: Pool
const verifier = vi.fn(async () => ({ ok: true, reason: 'ok', kid: 'synthetic-key' }))
vi.mock('./ebay-signature.js', () => ({ verifyEbayNotification: verifier }))
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => (database.client as any)[key] }) }))
const { receiveEbayNotice } = await import('./ebay-admission.js')
const OWNER = 'nexus_legacy_workspace', maintenance = 'nexus_ebay_quarantine_maintenance'
const operator = `privacy_operator_${randomBytes(6).toString('hex')}`
const migration = readFileSync(new URL('../../../../../../packages/database/prisma/migrations/20260926s_cx_ebay_privacy_census/migration.sql', import.meta.url), 'utf8')
const censusSql = 'SELECT * FROM public.nexus_ebay_deletion_quarantine_census()'
const inOwner = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: OWNER, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const body = (id = randomUUID()) => ({ metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION', schemaVersion: '1.0' },
  notification: { notificationId: id, eventDate: '2026-09-25T00:00:00Z', publishDate: '2026-09-25T00:00:01Z',
    data: { userId: 'immutable-private-subject', username: 'private-username', eiasToken: 'private-eias-token' } } })
const receive = (payload: unknown, environment: 'production' | 'sandbox' = 'production') =>
  receiveEbayNotice({ rawBody: Buffer.from(JSON.stringify(payload)), header: 'synthetic-signature', environment })
async function withOperator<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await operators.connect()
  try { return await work(client) } finally { client.release() }
}
async function census() {
  const result = withOperator(client => withQuarantineSnapshot(client, async () => (await client.query(censusSql)).rows))
  await expect(result).resolves.toHaveLength(2)
  return result
}
async function seed(topic: string, signatureOk: boolean, reason: string, environment = 'sandbox') {
  const id = randomUUID()
  await database.pool.query(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"signatureOk","externalId",topic,"payloadEnc","payloadKeyId","payloadDigest",reason)
    VALUES ($1,$2,$3,$1,$4,$5,$6,$7,$8)`, [id, environment, signatureOk, topic, signatureOk ? 'v1:synthetic-private-ciphertext' : null, signatureOk ? 'env' : null, 'a'.repeat(64), reason])
  return id
}

describe.skipIf(!concurrentDatabaseUrl())('non-destructive eBay deletion quarantine and operator census in PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64')); vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No live calls allowed') }))
    database = await concurrentDatabase({ maxConnections: 10 })
    // Remove only the new function, then prove the actual additive migration reinstalls it.
    await database.pool.query('GRANT nexus_ebay_quarantine_writer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE')
    await database.pool.query('DROP FUNCTION public.nexus_ebay_deletion_quarantine_census()')
    await database.pool.query(migration)
    await database.pool.query(`CREATE ROLE ${operator} LOGIN NOINHERIT PASSWORD 'disposable-test-only'`)
    await database.pool.query(`GRANT ${maintenance} TO ${operator} WITH INHERIT FALSE, SET TRUE`)
    const target = concurrentDatabaseUrl()!; target.pathname = `/${database.name}`; target.username = operator; target.password = 'disposable-test-only'
    operators = new Pool({ connectionString: target.toString(), max: 3 })
  }, 180_000)
  afterAll(async () => {
    await operators?.end()
    if (database) { await database.pool.query(`DROP ROLE IF EXISTS ${operator}`); await database.close() }
    vi.unstubAllEnvs(); vi.unstubAllGlobals()
  }, 60_000)

  it('retains a verified deletion with an explicit review reason and no inferred seller owner', async () => {
    const payload = body(), connectionId = randomUUID()
    await database.pool.query(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","managedBy","authStatus","isActive","connectionMetadata","updatedAt")
      VALUES ($1,$2,'EBAY',$3,'oauth','connected',true,'{"environment":"production"}',now())`, [connectionId, OWNER, payload.notification.data.userId])
    const result = await receive(payload)
    expect(result).toMatchObject({ kind: 'quarantined', reason: 'account_deletion_review_required' })
    if (result.kind !== 'quarantined') throw new Error('Expected encrypted quarantine')
    const row = (await database.pool.query('SELECT * FROM "EbayNoticeQuarantine" WHERE id=$1', [result.quarantineId])).rows[0]
    expect(row).toMatchObject({ signatureOk: true, firstOwnerWorkspaceId: null, subjectHash: null, resolvedReceiptId: null })
    expect(row.payloadEnc).toMatch(/^v[12]:/)
    for (const privateValue of Object.values(payload.notification.data)) expect(JSON.stringify(row)).not.toContain(privateValue)
    expect(await inOwner(() => database.client.webhookEvent.count())).toBe(0)
    expect(await inOwner(() => database.client.notification.count())).toBe(0)
  })

  it('retains missing/ambiguous subject data under the deletion reason without username routing', async () => {
    const payload = { ...body(), notification: { ...body().notification, data: { username: 'private-username' } } }
    await expect(receive(payload)).resolves.toMatchObject({ kind: 'quarantined', reason: 'account_deletion_review_required' })
    expect(await inOwner(() => database.client.webhookEvent.count())).toBe(0)
  })

  it('keeps rejected signatures unclassified and body-free rather than accepting their claimed topic', async () => {
    verifier.mockResolvedValueOnce({ ok: false, reason: 'signature_mismatch', kid: 'synthetic-key' })
    const result = await receive(body())
    expect(result).toMatchObject({ kind: 'rejected', reason: 'signature_mismatch' })
    if (result.kind !== 'rejected') throw new Error('Expected rejection')
    expect((await database.pool.query('SELECT topic,"payloadEnc","subjectHash" FROM "EbayNoticeQuarantine" WHERE id=$1', [result.quarantineId])).rows)
      .toEqual([{ topic: 'unclassified', payloadEnc: null, subjectHash: null }])
  })

  it('keeps unrelated verified topics distinct from deletion review', async () => {
    const payload = body()
    payload.metadata.topic = 'FUTURE_TOPIC'
    await expect(receive(payload)).resolves.toMatchObject({ kind: 'quarantined', reason: 'subject_or_topic_unresolved' })
  })

  it('two overlapping deliveries retain one encrypted original and both delivery attempts', async () => {
    const payload = body(), blocker = await database.pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['nexus-ebay-ingress', 'production', true, payload.notification.notificationId])])
    const pending = Promise.all([receive(payload), receive(payload)])
    let waiters = 0
    try {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline && waiters < 2) {
        waiters = (await database.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n
        if (waiters < 2) await new Promise(resolve => setTimeout(resolve, 20))
      }
    } finally { await blocker.query('COMMIT'); blocker.release() }
    await expect(pending).resolves.toEqual([expect.objectContaining({ kind: 'quarantined' }), expect.objectContaining({ kind: 'quarantined' })])
    expect(waiters).toBe(2)
    expect((await database.pool.query('SELECT deliveries,reason FROM "EbayNoticeQuarantine" WHERE "externalId"=$1', [payload.notification.notificationId])).rows)
      .toEqual([{ deliveries: 2, reason: 'account_deletion_review_required' }])
  })

  it('counts verified deletion metadata, including legacy reasons, without subjects or arbitrary reason text', async () => {
    const beforeRows = await census()
    const before = beforeRows.find(row => row.environment === 'sandbox')!
    await seed('MARKETPLACE_ACCOUNT_DELETION', true, 'account_deletion_review_required')
    await seed('MARKETPLACE_ACCOUNT_DELETION', true, 'subject_or_topic_unresolved')
    await seed('MARKETPLACE_ACCOUNT_DELETION', true, 'private-reason-must-not-escape')
    await seed('MARKETPLACE_ACCOUNT_DELETION', false, 'signature_mismatch')
    await seed('AUTHORIZATION_REVOCATION', true, 'owner_unknown')
    await seed('MARKETPLACE_ACCOUNT_DELETION', true, 'account_deletion_review_required', 'production')
    const afterRows = await census()
    const after = afterRows.find(row => row.environment === 'sandbox')!
    expect(afterRows.find(row => row.environment === 'production')!.notices).toBe(beforeRows.find(row => row.environment === 'production')!.notices + 1)
    expect(after).toMatchObject({ notices: before.notices + 3, deliveries: before.deliveries + 3, unresolved: before.unresolved + 3,
      reviewRequired: before.reviewRequired + 1, legacyReason: before.legacyReason + 1, otherReason: before.otherReason + 1 })
    expect(after.oldestReceivedAt).toBeInstanceOf(Date)
    expect(Object.keys(after).sort()).toEqual(['deliveries','environment','legacyReason','notices','oldestReceivedAt','otherReason','reviewRequired','unresolved'].sort())
    expect(JSON.stringify(after)).not.toMatch(/private|ciphertext|payload|subjectHash|externalId/)
  })

  it('denies tenant/runtime census invocation even with spoofed maintenance GUCs', async () => {
    const client = await database.pool.connect()
    try {
      await client.query('SET ROLE nexus_workspace_runtime')
      await client.query("SELECT set_config('nexus.actor_id','',false),set_config('nexus.quarantine_maintenance','1',false)")
      await expect(client.query(censusSql)).rejects.toMatchObject({ code: '42501' })
    } finally { await client.query('RESET ROLE'); client.release() }
  })

  it('operator census does not give direct ciphertext access or allow claiming a maintenance identity', async () => {
    await withOperator(async client => {
      await client.query(`SET ROLE ${maintenance}`)
      try {
        await expect(client.query(censusSql)).resolves.toMatchObject({ rowCount: 2 })
        await expect(client.query('SELECT "payloadEnc" FROM "EbayNoticeQuarantine"')).rejects.toMatchObject({ code: '42501' })
        await expect(client.query('SET ROLE nexus_ebay_quarantine_writer')).rejects.toMatchObject({ code: '42501' })
      } finally { await client.query('RESET ROLE') }
    })
  })

  it('holds a read-only repeatable-read snapshot while a new deletion is admitted concurrently', async () => {
    await withOperator(client => withQuarantineSnapshot(client, async () => {
      const first = client.query(censusSql)
      await expect(first).resolves.toMatchObject({ rowCount: 2 })
      const before = (await first).rows
      expect((await client.query("SELECT current_setting('transaction_read_only') AS ro,current_setting('transaction_isolation') AS isolation")).rows)
        .toEqual([{ ro: 'on', isolation: 'repeatable read' }])
      await receive(body(), 'sandbox')
      expect((await client.query(censusSql)).rows).toEqual(before)
    }))
    expect((await census()).find(row => row.environment === 'sandbox')!.notices).toBeGreaterThan(0)
  })

  it('the operator service returns only aggregate metadata and changes no retained/domain rows', async () => {
    const snapshot = async () => Promise.all(['EbayNoticeQuarantine', 'WebhookEvent', 'Notification'].map(table =>
      database.pool.query(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY id`).then(result => result.rows)))
    const before = await snapshot()
    const pending = withOperator(client => readEbayDeletionCensus(client))
    await expect(pending).resolves.toMatchObject({ scope: 'verified_ebay_account_deletion_quarantine', snapshotComplete: true, disposition: 'review_required_no_erasure' })
    const report = await pending
    expect(report.byEnvironment.map(row => row.environment)).toEqual(['production', 'sandbox'])
    expect(report.byEnvironment.every(row => row.notices > 0)).toBe(true)
    expect(JSON.stringify(report)).not.toMatch(/private|ciphertext|subjectHash|externalId|payloadEnc/)
    expect(await snapshot()).toEqual(before)
    const client = await database.pool.connect()
    try { await expect(readEbayDeletionCensus(client)).rejects.toMatchObject({ code: 'authority_denied' }) }
    finally { client.release() }
  })

  it('the migration gives up behind a long reader after 5 seconds instead of queueing traffic', async () => {
    const reader = await database.pool.connect(), applier = await database.pool.connect()
    await reader.query('BEGIN')
    await reader.query('SELECT count(*) FROM "EbayNoticeQuarantine"')
    const started = Date.now()
    const applying = applier.query(migration).then(() => 'applied', error => error)
    let outcome: unknown
    try { outcome = await Promise.race([applying, new Promise(resolve => setTimeout(() => resolve('still waiting'), 9_000))]) }
    finally {
      await reader.query('ROLLBACK'); reader.release()
      await applying
      await applier.query('ROLLBACK'); applier.release()
    }
    expect(outcome).toMatchObject({ code: '55P03' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900)
  }, 20_000)

})
