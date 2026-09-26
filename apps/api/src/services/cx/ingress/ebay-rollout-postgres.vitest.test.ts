import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>, workspaceId: string
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => (database.client as any)[key] }) }))
vi.mock('./ebay-signature.js', () => ({ verifyEbayNotification: async () => ({ ok: true, reason: 'ok', kid: 'synthetic-key' }) }))
vi.mock('../apps.service.js', () => ({ getChannelApp: async () => ({ clientId: 'synthetic-app', clientSecret: 'synthetic-secret' }) }))
vi.mock('../../monitoring/alert.service.js', () => ({ alertService: { createAlert: vi.fn() }, AlertType: { CONNECTION_HEALTH: 'CONNECTION_HEALTH' } }))
const { receiveEbayNotice, adoptEbayQuarantine } = await import('./ebay-admission.js')
const { processEbayInbound, dueEbayInboundEvents } = await import('./ebay-processing.js')
const { queueEbayReplay, claimEbayInbound } = await import('./ebay-claims.js')
const { storeGrant } = await import('../token.service.js')
const inOwner = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: 'rollout-owner', membershipId: `${workspaceId}:owner`, roleKeys: [] }, work)
const stored = (id: string) => inOwner(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id } }))
const payload = (userId: string) => ({ metadata: { topic: 'AUTHORIZATION_REVOCATION', schemaVersion: '1.0' },
  notification: { notificationId: randomUUID(), data: { userId, revocationDate: '2026-09-23T01:02:03Z' } } })
const receive = (body: unknown) => receiveEbayNotice({ rawBody: Buffer.from(JSON.stringify(body)), header: 'synthetic-signature', environment: 'production' })
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ active: false }), { status: 200 }))
async function seed(id = randomUUID()) {
  await database.pool.query('INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","managedBy","authStatus","isActive","connectionMetadata","updatedAt") VALUES ($1,$2,\'EBAY\',$1,\'oauth\',\'connected\',true,\'{"environment":"production"}\',now())', [id, workspaceId])
  await inOwner(() => storeGrant(id, { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresInSec: 3600, grantedScopes: [], identity: { userId: id } }, { kind: 'operator' }, 'grant'))
  return id
}
async function admitted() {
  const body = payload(await seed()), result = await inOwner(() => receive(body))
  if (result.kind !== 'accepted') throw new Error('Expected a bound receipt')
  return { id: result.receiptId, body }
}
// Exact old0a selector and missing-handler effect. Use direct SQL so the new helper
// cannot accidentally make this compatibility test pass by filtering for us.
async function oldWorkerSweep() {
  const rows = (await database.pool.query(`SELECT id FROM "WebhookEvent" WHERE "workspaceId"=$1
    AND status IN ('failed','pending') AND "archivedAt" IS NULL
    AND "nextAttemptAt" IS NOT NULL AND "nextAttemptAt"<=clock_timestamp()
    ORDER BY "nextAttemptAt" LIMIT 200`, [workspaceId])).rows
  for (const { id } of rows) await database.pool.query(`UPDATE "WebhookEvent" SET status='dlq',"nextAttemptAt"=NULL,
    "lastError"='No replay handler registered' WHERE id=$1`, [id])
  return rows
}

describe.skipIf(!concurrentDatabaseUrl())('eBay mixed-version admission and activation in PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64')); vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    vi.stubGlobal('fetch', fetchMock)
    database = await concurrentDatabase({ maxConnections: 10 })
    await import('../connectors/ebay/spec.js')
    await database.pool.query('INSERT INTO "UserProfile" (id,email,"displayName",status,"updatedAt") VALUES (\'rollout-owner\',\'rollout@test.local\',\'Owner\',\'active\',now())')
    await database.pool.query('INSERT INTO "Role" (id,key,name,permissions,"updatedAt") VALUES (\'rollout-role\',\'OWNER\',\'Owner\',ARRAY[]::text[],now()) ON CONFLICT (key) DO NOTHING')
  }, 180_000)
  beforeEach(async () => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '0'); vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1'); fetchMock.mockClear()
    workspaceId = randomUUID()
    await database.pool.query('INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ($1,\'Rollout fixture\',\'test\',$1,now())', [workspaceId])
    await database.pool.query('INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,\'rollout-owner\',\'active\',now())', [`${workspaceId}:owner`, workspaceId])
    await database.pool.query('INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") SELECT $1,id FROM "Role" WHERE key=\'OWNER\'', [`${workspaceId}:owner`])
  })
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals() }, 60_000)

  it('keeps new admission and redelivery invisible to the old worker while held', async () => {
    const { id, body } = await admitted()
    await inOwner(() => receive(body))
    const before = await stored(id)
    expect(await oldWorkerSweep()).toEqual([])
    expect(before).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: null, leaseToken: null, deliveries: 2 })
    expect(await stored(id)).toEqual(before)
  })

  it('keeps quarantine handoff and later redelivery invisible to the old worker', async () => {
    const userId = randomUUID(), body = payload(userId), result = await inOwner(() => receive(body))
    if (result.kind !== 'quarantined') throw new Error('Expected private quarantine')
    await seed(userId)
    const { receiptId } = await inOwner(() => adoptEbayQuarantine(result.quarantineId, userId))
    await inOwner(() => receive(body))
    const before = await stored(receiptId)
    expect(await oldWorkerSweep()).toEqual([])
    expect(before).toMatchObject({ nextAttemptAt: null, attempts: 0, deliveries: 2 })
    expect(await stored(receiptId)).toEqual(before)
  })

  it.each(['processing', 'canonical'])('leaves held receipts unchanged when %s readiness is off, including direct replay', async prerequisite => {
    const { id } = await admitted(), before = await stored(id)
    if (prerequisite === 'canonical') { vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '1'); vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '0') }
    expect(await inOwner(() => dueEbayInboundEvents())).toEqual([])
    expect(await inOwner(() => processEbayInbound(id))).toMatchObject({ kind: 'held' })
    expect(await inOwner(() => claimEbayInbound(id))).toBeNull()
    expect(await inOwner(() => queueEbayReplay({ id }))).toMatchObject({ ok: false, reason: 'processing_held' })
    expect(await stored(id)).toEqual(before)
    expect(await oldWorkerSweep()).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('activates held work with one concurrent claim and one atomic revocation effect', async () => {
    const { id } = await admitted(), before = await stored(id)
    vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '1')
    expect(await inOwner(() => dueEbayInboundEvents())).toEqual([{ id, workspaceId }])
    const results = await Promise.all([1, 2].map(() => inOwner(() => processEbayInbound(id))))
    expect(results.map(r => r.kind).sort()).toEqual(['done', 'not_claimed'])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(await stored(id)).toMatchObject({ status: 'done', attempts: 1, externalId: before.externalId, connectionId: before.connectionId, payload: before.payload })
    expect(await inOwner(() => database.client.notification.count({ where: { entityId: before.connectionId! } }))).toBe(1)
  })

  it('positively reproduces the old missing-handler DLQ when a receipt is scheduled', async () => {
    const { id } = await admitted()
    await database.pool.query('UPDATE "WebhookEvent" SET "nextAttemptAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1', [id])
    expect(await oldWorkerSweep()).toEqual([{ id }])
    expect(await stored(id)).toMatchObject({ status: 'dlq', lastError: 'No replay handler registered', attempts: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('bounds held selection to four and preserves each unscheduled receipt until claimed', async () => {
    const rows = []
    for (let i = 0; i < 6; i++) rows.push(await admitted())
    vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '1')
    expect((await inOwner(() => dueEbayInboundEvents(100))).map(row => row.id)).toEqual(rows.map(row => row.id).sort().slice(0, 4))
    for (const { id } of rows) expect(await stored(id)).toMatchObject({ nextAttemptAt: null, attempts: 0, leaseToken: null })
  })

  it('uses database time when atomically activating and leasing a held receipt', async () => {
    const { id } = await admitted()
    vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '1')
    const before = (await database.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
    try { expect(await inOwner(() => claimEbayInbound(id))).toMatchObject({ attempt: 1 }) } finally { clock.mockRestore() }
    const row = await stored(id), after = (await database.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
    expect(row.leaseUntil!.getTime()).toBeGreaterThanOrEqual(before.getTime() + 180_000)
    expect(row.leaseUntil!.getTime()).toBeLessThanOrEqual(after.getTime() + 180_000)
    expect(row.nextAttemptAt).toEqual(row.leaseUntil)
  })

  it('never automatically reactivates historical, incomplete, terminal, attempted, leased or delayed work', async () => {
    const variants = [{ externalId: 'historical-inline-notice' }, { externalId: 'ebay:production:' }, { signatureOk: false }, { verifiedBy: 'none' },
      { archivedAt: new Date() }, { status: 'done', isProcessed: true }, { status: 'failed' }, { status: 'dlq' },
      { attempts: 1 }, { leaseToken: 'existing-worker', leaseUntil: new Date('2099-01-01T00:00:00Z') },
      { nextAttemptAt: new Date('2099-01-01T00:00:00Z') }, { connectionId: null }, { isProcessed: true }, { processedAt: new Date() }]
    const snapshots = []
    for (const change of variants) {
      const { id } = await admitted()
      await inOwner(() => database.client.webhookEvent.update({ where: { id }, data: change }))
      snapshots.push(await stored(id))
    }
    vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '1')
    expect(await inOwner(() => dueEbayInboundEvents())).toEqual([])
    for (const before of snapshots) {
      expect(await inOwner(() => processEbayInbound(before.id))).toEqual({ kind: 'not_claimed' })
      expect(await stored(before.id)).toEqual(before)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
