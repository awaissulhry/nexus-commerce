import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => (database.client as any)[key] }) }))
vi.mock('../apps.service.js', () => ({ getChannelApp: async () => ({ clientId: 'synthetic-app', clientSecret: 'synthetic-secret' }) }))
vi.mock('../../monitoring/alert.service.js', () => ({ alertService: { createAlert: vi.fn() }, AlertType: { CONNECTION_HEALTH: 'CONNECTION_HEALTH' } }))
vi.mock('../../../lib/cron/clustered.js', () => ({ default: {} }))
vi.mock('../../../utils/cron-observability.js', () => ({ recordCronRun: vi.fn() }))
const { storeGrant } = await import('../token.service.js')
const { recordInbound, replayInbound, completeInbound, deadLetterInbound } = await import('./ledger.js')
const { claimEbayInbound } = await import('./ebay-claims.js')
const { processEbayInbound, dueEbayInboundEvents } = await import('./ebay-processing.js')
const { runInboundRetrySweep } = await import('../../../jobs/inbound-retry.job.js')
const OWNER = 'nexus_legacy_workspace'
const inOwner = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: OWNER, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const response = (active = false) => new Response(JSON.stringify({ active }), { status: 200 })
const fetchMock = vi.fn(async (..._args: unknown[]) => response())
async function seed(state = 'connected') {
  const id = randomUUID()
  await database.pool.query('INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","managedBy","externalAccountId","isActive","authStatus","grantVersion","updatedAt") VALUES ($1,$2,\'EBAY\',\'oauth\',$1,false,$3,0,now())', [id, OWNER, state])
  if (state === 'connected') await inOwner(() => storeGrant(id, { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresInSec: 7200, grantedScopes: [], identity: { userId: id } }, { kind: 'operator' }, 'grant'))
  return id
}
async function queued(connectionId: string, verified = true) {
  const notificationId = randomUUID()
  const result = await inOwner(() => recordInbound({ channel: 'EBAY', eventType: 'AUTHORIZATION_REVOCATION', externalId: `ebay:production:${notificationId}`, connectionId,
    signatureOk: verified, verifiedBy: 'ebay_ecdsa', queueForRetry: true, payload: { metadata: { topic: 'AUTHORIZATION_REVOCATION', schemaVersion: '1.0' },
      notification: { notificationId, data: { userId: connectionId, revocationDate: '2026-09-23T01:02:03Z' } } } }))
  return result.id!
}
const process = (id: string) => inOwner(() => processEbayInbound(id))
const stored = (id: string) => inOwner(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id } }))
const account = (id: string) => inOwner(() => database.client.channelConnection.findUniqueOrThrow({ where: { id } }))
const due = (id: string) => database.pool.query('UPDATE "WebhookEvent" SET "nextAttemptAt"=clock_timestamp()-interval \'1 second\',"leaseUntil"=CASE WHEN "leaseToken" IS NULL THEN NULL ELSE clock_timestamp()-interval \'1 second\' END WHERE id=$1', [id])
const warnings = (id: string) => inOwner(() => database.client.notification.findMany({ where: { entityId: id, type: 'channel-notification-unresolved' } }))

describe.skipIf(!concurrentDatabaseUrl())('stored eBay lifecycle processing in PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1')
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
    vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    vi.stubGlobal('fetch', fetchMock)
    database = await concurrentDatabase({ maxConnections: 8 })
    await import('../connectors/ebay/spec.js')
    await database.pool.query('INSERT INTO "UserProfile" (id,email,"displayName",status,"updatedAt") VALUES (\'processor-owner\',\'processor@test.local\',\'Processor Owner\',\'active\',now())')
    await database.pool.query('INSERT INTO "Role" (id,key,name,permissions,"updatedAt") VALUES (\'processor-role\',\'OWNER\',\'Owner\',ARRAY[]::text[],now()) ON CONFLICT (key) DO NOTHING')
    const role = (await database.pool.query('SELECT id FROM "Role" WHERE key=\'OWNER\'')).rows[0].id
    await database.pool.query('INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES (\'processor-membership\',$1,\'processor-owner\',\'active\',now())', [OWNER])
    await database.pool.query('INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES (\'processor-membership\',$1)', [role])
  }, 180_000)
  beforeEach(() => { vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '1'); vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1'); fetchMock.mockReset(); fetchMock.mockImplementation(async () => response()) })
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals() }, 60_000)

  it('holds processing until explicitly enabled without consuming a claim or calling eBay', async () => {
    const id = await queued(await seed())
    vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '0')
    expect(await process(id)).toEqual({ kind: 'held', reason: 'processing_disabled' })
    expect(await stored(id)).toMatchObject({ attempts: 0, leaseToken: null, status: 'pending' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('completes a terminal disconnected account without inspecting a provider grant', async () => {
    const connectionId = await seed('disconnected'), id = await queued(connectionId)
    expect(await process(id)).toEqual({ kind: 'done' })
    expect(await stored(id)).toMatchObject({ status: 'done', isProcessed: true, leaseToken: null, attempts: 1 })
    expect(await account(connectionId)).toMatchObject({ authStatus: 'disconnected', isActive: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('holds before claiming when the canonical token service is disabled', async () => {
    const id = await queued(await seed())
    vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '0')
    expect(await process(id)).toEqual({ kind: 'held', reason: 'canonical_service_required' })
    expect(await stored(id)).toMatchObject({ attempts: 0, leaseToken: null, status: 'pending' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('inspects the refresh grant and atomically revokes, notifies and completes its owned receipt', async () => {
    const connectionId = await seed(), id = await queued(connectionId)
    expect(await process(id)).toEqual({ kind: 'done' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.ebay.com/identity/v1/oauth2/token/introspect')
    expect(await account(connectionId)).toMatchObject({ authStatus: 'revoked', isActive: false })
    expect(await stored(id)).toMatchObject({ status: 'done', isProcessed: true })
    const notices = await inOwner(() => database.client.notification.findMany({ where: { entityId: connectionId } }))
    expect(notices.map(n => n.userId)).toEqual(['processor-owner'])
  })

  it('retries current-active uncertainty with a bounded budget and one durable owner warning', async () => {
    const connectionId = await seed(), id = await queued(connectionId)
    fetchMock.mockImplementation(async () => response(true))
    for (let attempt = 1; attempt <= 5; attempt++) {
      await due(id)
      expect(await process(id)).toEqual({ kind: attempt === 5 ? 'dead_letter' : 'retry' })
      expect((await stored(id)).attempts).toBe(attempt)
    }
    expect(await account(connectionId)).toMatchObject({ authStatus: 'connected', isActive: true })
    expect(await stored(id)).toMatchObject({ status: 'dlq', isProcessed: false, nextAttemptAt: null })
    expect(await warnings(id)).toHaveLength(1)
    expect(await inOwner(() => replayInbound({ id }))).toMatchObject({ ok: true })
    await due(id); expect(await process(id)).toEqual({ kind: 'retry' })
    expect(await warnings(id)).toHaveLength(1)
  })

  it('supplies the strict warning callback when abandoned claims exhaust the crash budget', async () => {
    const id = await queued(await seed())
    for (let attempt = 1; attempt <= 5; attempt++) {
      await due(id)
      expect(await inOwner(() => claimEbayInbound(id))).toMatchObject({ attempt })
    }
    await due(id)
    expect(await process(id)).toEqual({ kind: 'not_claimed' })
    expect(await stored(id)).toMatchObject({ status: 'dlq', attempts: 5 })
    expect(await warnings(id)).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('defers provider rate limits without spending an attempt or changing authorization', async () => {
    const connectionId = await seed(), id = await queued(connectionId)
    fetchMock.mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '7200' } }))
    const before = Date.now()
    expect(await process(id)).toEqual({ kind: 'deferred' })
    expect(await stored(id)).toMatchObject({ status: 'failed', attempts: 0, leaseToken: null })
    expect((await stored(id)).nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 7_200_000)
    expect(await account(connectionId)).toMatchObject({ authStatus: 'connected', isActive: true })
    expect(await warnings(id)).toHaveLength(0)
  })

  it('honors a provider maintenance retry date while retaining the bounded failure budget', async () => {
    const id = await queued(await seed()), before = Date.now()
    fetchMock.mockImplementation(async () => new Response('', { status: 503,
      headers: { Date: 'Wed, 23 Sep 2026 00:00:00 GMT', 'Retry-After': 'Wed, 23 Sep 2026 02:00:00 GMT' } }))
    expect(await process(id)).toEqual({ kind: 'retry' })
    expect(await stored(id)).toMatchObject({ status: 'failed', attempts: 1 })
    expect((await stored(id)).nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 7_200_000)
  })

  it.each(['unverified', 'wrong-subject', 'wrong-environment', 'wrong-delivery-id', 'archived'])('makes zero provider calls for %s stored work', async kind => {
    const connectionId = await seed(), id = await queued(connectionId, kind !== 'unverified')
    if (kind === 'wrong-subject') await database.pool.query('UPDATE "WebhookEvent" SET payload=jsonb_set(payload,\'{notification,data,userId}\',\'"different-seller"\') WHERE id=$1', [id])
    if (kind === 'wrong-environment') await database.pool.query('UPDATE "WebhookEvent" SET "externalId"=replace("externalId",\'ebay:production:\',\'ebay:sandbox:\') WHERE id=$1', [id])
    if (kind === 'wrong-delivery-id') await database.pool.query('UPDATE "WebhookEvent" SET "externalId"=\'ebay:production:different-delivery\' WHERE id=$1', [id])
    if (kind === 'archived') await database.pool.query('UPDATE "WebhookEvent" SET "archivedAt"=now() WHERE id=$1', [id])
    expect(await process(id)).toEqual({ kind: kind.startsWith('wrong-') ? 'dead_letter' : 'not_claimed' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await account(connectionId)).toMatchObject({ authStatus: 'connected', isActive: true })
  })

  it('allows only one worker to inspect a claimed receipt and fences a takeover during inspection', async () => {
    const connectionId = await seed(), id = await queued(connectionId)
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(r => { entered = r }), held = new Promise<void>(r => { release = r })
    fetchMock.mockImplementationOnce(async () => { entered(); await held; return response() })
    const first = process(id)
    await Promise.race([ready, first.then(() => { throw new Error('Processing ended before grant inspection') })])
    try {
      expect(await process(id)).toEqual({ kind: 'not_claimed' })
      await due(id)
      expect(await inOwner(() => claimEbayInbound(id))).toMatchObject({ attempt: 2 })
    } finally { release() }
    expect(await first).toEqual({ kind: 'not_claimed' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(await account(connectionId)).toMatchObject({ authStatus: 'connected', isActive: true })
    expect(await stored(id)).toMatchObject({ status: 'pending', attempts: 2, isProcessed: false })
  })

  it('refuses every legacy completion path for a verified eBay receipt', async () => {
    const id = await queued(await seed())
    await inOwner(() => claimEbayInbound(id))
    const before = await stored(id)
    await inOwner(() => completeInbound(id, true))
    await inOwner(() => completeInbound(id, false, 'legacy retry'))
    await inOwner(() => deadLetterInbound(id, 'legacy terminal'))
    expect(await stored(id)).toEqual(before)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('selects at most four due verified unleased receipts using the database clock', async () => {
    const workspaceId = randomUUID()
    await database.pool.query('INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ($1,\'Queue selection fixture\',\'test\',$1,now())', [workspaceId])
    await withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
      await database.client.webhookEvent.createMany({ data: Array.from({ length: 11 }, (_, index) => ({
        id: `${workspaceId}:${String(index).padStart(2, '0')}`, channel: 'EBAY', eventType: 'AUTHORIZATION_REVOCATION', externalId: `queue-${index}`,
        payload: {}, status: 'pending', nextAttemptAt: new Date('2020-01-01T00:00:00Z'), signatureOk: index !== 0, verifiedBy: 'ebay_ecdsa',
        leaseToken: index === 1 ? 'active-worker' : null, leaseUntil: index === 1 ? new Date('2099-01-01T00:00:00Z') : null,
        archivedAt: index === 2 ? new Date() : null,
      })) })
      const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
      try {
        expect((await dueEbayInboundEvents(50)).map(row => row.id)).toEqual([3, 4, 5, 6].map(index => `${workspaceId}:0${index}`))
      } finally { clock.mockRestore() }
    })
  })

  it('dead-letters scheduled unverified audit rows even while eBay business processing is disabled', async () => {
    const workspaceId = randomUUID()
    await database.pool.query('INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ($1,\'Rejected audit fixture\',\'test\',$1,now())', [workspaceId])
    vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '0')
    await withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
      const proofs = [[false, 'ebay_ecdsa'], [null, 'ebay_ecdsa'], [true, 'none'], [true, 'ebay_ecdsa']] as const
      await database.client.webhookEvent.createMany({ data: proofs.map(([signatureOk, verifiedBy], index) => ({
        id: `${workspaceId}:${index}`, channel: 'EBAY', eventType: 'AUTHORIZATION_REVOCATION', externalId: `audit-${index}`, payload: {},
        status: 'pending', nextAttemptAt: new Date('2020-01-01T00:00:00Z'), signatureOk, verifiedBy,
      })) })
      expect(await runInboundRetrySweep()).toMatchObject({ due: 3, unreplayable: 3, succeeded: 0 })
      const rows = await database.client.webhookEvent.findMany({ orderBy: { id: 'asc' } })
      expect(rows.map(row => row.status)).toEqual(['dlq', 'dlq', 'dlq', 'pending'])
      expect(rows.every(row => row.attempts === 0 && !row.isProcessed)).toBe(true)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
