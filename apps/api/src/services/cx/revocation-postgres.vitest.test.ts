import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
const insideDomain = new AsyncLocalStorage<boolean>()
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_t, key) => {
  if (insideDomain.getStore()) throw new Error('Global database client used inside domain transaction')
  return (database.client as any)[key]
} }) }))
vi.mock('../monitoring/alert.service.js', () => ({ alertService: { createAlert: vi.fn() }, AlertType: { CONNECTION_HEALTH: 'CONNECTION_HEALTH' } }))
vi.mock('./apps.service.js', () => ({ getChannelApp: async () => ({ clientId: 'synthetic-app', clientSecret: 'synthetic-secret' }) }))
const lifecycle = await import('./account-lifecycle.service.js')
const { storeGrant, getAccessToken } = await import('./token.service.js')
const { recordInbound } = await import('./ingress/ledger.js')
const { claimEbayInbound, commitEbayInbound } = await import('./ingress/ebay-claims.js')
const OWNER = 'nexus_legacy_workspace', OTHER = randomUUID(), EMPTY = randomUUID()
const inProfile = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const inOwner = <T>(work: () => Promise<T>) => inProfile(OWNER, work)
const proof = (connectionId: string, grantVersion = 1, workspaceId = OWNER) => ({ kind: 'inspection' as const, connectionId, workspaceId, grantVersion, active: false })
async function seed(workspaceId = OWNER, state = 'connected') {
  const id = randomUUID()
  await database.pool.query('INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","authStatus","isActive","grantVersion","refreshLeaseOwner","refreshLeaseUntil","updatedAt") VALUES ($1,$2,\'EBAY\',$1,$3,true,1,\'refresh-in-flight\',now()+interval \'1 minute\',now())', [id, workspaceId, state])
  return id
}
async function queued(connectionId: string, workspaceId = OWNER) {
  return inProfile(workspaceId, async () => {
    const event = await recordInbound({ channel: 'EBAY', eventType: 'AUTHORIZATION_REVOCATION', externalId: randomUUID(), connectionId,
      signatureOk: true, verifiedBy: 'ebay_ecdsa', queueForRetry: true, payload: { notification: { data: { userId: connectionId } } } })
    return (await claimEbayInbound(event.id!))!
  })
}
async function account(id: string) { return (await database.pool.query('SELECT "authStatus","isActive","grantVersion","refreshLeaseOwner","refreshLeaseUntil" FROM "ChannelConnection" WHERE id=$1', [id])).rows[0] }
async function effects(id: string) {
  const notices = (await database.pool.query('SELECT id,"userId",type,"readAt" FROM "Notification" WHERE "entityId"=$1 ORDER BY "userId",id', [id])).rows
  const events = (await database.pool.query('SELECT type,detail FROM "ConnectionEvent" WHERE "connectionId"=$1 ORDER BY "createdAt"', [id])).rows
  return { notices, events }
}
type Claim = NonNullable<Awaited<ReturnType<typeof claimEbayInbound>>>
const applyRevocation = (claim: Claim, evidence: Parameters<typeof lifecycle.reconcileEbayRevocationInTx>[2]) => inProfile(claim.workspaceId, () => commitEbayInbound(claim,
  (tx, receipt) => insideDomain.run(true, () => lifecycle.reconcileEbayRevocationInTx(tx, receipt, evidence))))

function failingWrite(tx: Prisma.TransactionClient, model: string, method: string): Prisma.TransactionClient {
  return new Proxy(tx, { get(target, key) {
    const delegate = Reflect.get(target, key)
    if (key !== model) return delegate
    return new Proxy(delegate, { get(object, operation) {
      const original = Reflect.get(object, operation)
      if (operation !== method) return original
      return async (args: unknown) => { await original.call(object, args); throw new Error('Injected required-write failure') }
    } })
  } })
}

describe.skipIf(!concurrentDatabaseUrl())('transactional account revocation in PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1')
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
    vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network request inside database-only revocation tests') }))
    database = await concurrentDatabase({ maxConnections: 8 })
    await import('./connectors/ebay/spec.js')
    for (const id of [OTHER, EMPTY]) await database.pool.query('INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ($1,\'Revocation fixture\',\'test\',$1,now())', [id])
    await database.pool.query('INSERT INTO "Role" (id,key,name,permissions,"updatedAt") VALUES (\'revocation-owner-role\',\'OWNER\',\'Owner\',ARRAY[]::text[],now()) ON CONFLICT (key) DO NOTHING')
    const roleId = (await database.pool.query('SELECT id FROM "Role" WHERE key=\'OWNER\'')).rows[0].id
    for (const [id, workspace, status] of [['owner-a', OWNER, 'active'], ['owner-b', OWNER, 'active'], ['inactive-owner', OWNER, 'inactive'], ['foreign-owner', OTHER, 'active'], ['ordinary-member', OWNER, 'active']]) {
      await database.pool.query('INSERT INTO "UserProfile" (id,email,"displayName",status,"updatedAt") VALUES ($1,$2,$1,$3,now())', [id, `${id}@test.local`, status])
      await database.pool.query('INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$1,\'active\',now())', [id, workspace])
      if (id !== 'ordinary-member') await database.pool.query('INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)', [id, roleId])
    }
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals() }, 60_000)

  it('commits inactive account, cleared refresh lease, audit, actual owner notices and receipt together', async () => {
    const id = await seed(), claim = await queued(id)
    expect(await applyRevocation(claim, proof(id))).toMatchObject({ committed: true })
    expect(await account(id)).toMatchObject({ authStatus: 'revoked', isActive: false, grantVersion: 1, refreshLeaseOwner: null, refreshLeaseUntil: null })
    const { notices, events } = await effects(id)
    expect(notices.map(n => n.userId)).toEqual(['owner-a', 'owner-b'])
    expect(notices.every(n => n.type === 'channel-authorization-revoked')).toBe(true)
    expect(events.filter(e => e.type === 'status_change')).toHaveLength(1)
    expect(events.find(e => e.type === 'revoke')?.detail).toMatchObject({ grantVersion: 1, notificationOutcome: 'delivered', recipients: 2 })
    expect(await inOwner(() => database.client.webhookEvent.findUnique({ where: { id: claim.id } }))).toMatchObject({ status: 'done', isProcessed: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['revoked', 'disconnected'] as const)('repairs a partial %s state without introspection or changing its terminal meaning', async status => {
    const id = await seed(OWNER, status), claim = await queued(id)
    const terminal = { kind: 'terminal' as const, connectionId: id, workspaceId: OWNER, grantVersion: 1, authStatus: status }
    expect(await applyRevocation(claim, terminal)).toMatchObject({ committed: true })
    expect(await account(id)).toMatchObject({ authStatus: status, isActive: false, refreshLeaseOwner: null, refreshLeaseUntil: null })
    expect((await effects(id)).events.filter(e => e.type === 'status_change')).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves a newer grant when reconnect wins before the revocation transaction', async () => {
    const id = await seed(), claim = await queued(id)
    await inOwner(() => storeGrant(id, { accessToken: 'synthetic-new-access', refreshToken: 'synthetic-new-refresh', expiresInSec: 7200, grantedScopes: [], identity: null }, { kind: 'operator' }, 'reconsent'))
    const before = await account(id), beforeEffects = await effects(id)
    await expect(applyRevocation(claim, proof(id))).rejects.toMatchObject({ reason: 'grant_changed' })
    expect(await account(id)).toEqual(before)
    expect(await effects(id)).toEqual(beforeEffects)
    expect(await inOwner(() => database.client.webhookEvent.findUnique({ where: { id: claim.id } }))).toMatchObject({ status: 'pending', leaseToken: claim.leaseToken })
  })

  it('does not revoke or complete a notice whose current refresh grant remains active', async () => {
    const id = await seed(), claim = await queued(id), before = await account(id)
    await expect(applyRevocation(claim, { ...proof(id), active: true })).rejects.toMatchObject({ reason: 'current_grant_active' })
    expect(await account(id)).toEqual(before)
    expect(await effects(id)).toEqual({ notices: [], events: [] })
    expect(await inOwner(() => database.client.webhookEvent.findUnique({ where: { id: claim.id } }))).toMatchObject({ status: 'pending' })
  })

  it('refuses proof for another profile, account or a stale terminal snapshot', async () => {
    const id = await seed(), claim = await queued(id), before = await account(id)
    for (const evidence of [{ ...proof(id), workspaceId: OTHER }, proof('another-account'),
      { kind: 'terminal' as const, connectionId: id, workspaceId: OWNER, grantVersion: 1, authStatus: 'revoked' as const }]) {
      await expect(applyRevocation(claim, evidence)).rejects.toThrow()
    }
    expect(await account(id)).toEqual(before)
    expect(await effects(id)).toEqual({ notices: [], events: [] })
  })

  it.each([['channelConnection', 'updateMany'], ['notification', 'createMany'], ['connectionEvent', 'create']])('rolls back all effects after required %s.%s write failure', async (model, method) => {
    const id = await seed(), claim = await queued(id), before = await account(id)
    await expect(inOwner(() => commitEbayInbound(claim, (tx, receipt) => insideDomain.run(true,
      () => lifecycle.reconcileEbayRevocationInTx(failingWrite(tx, model, method), receipt, proof(id)))))).rejects.toThrow('Injected required-write failure')
    expect(await account(id)).toEqual(before)
    expect(await effects(id)).toEqual({ notices: [], events: [] })
    expect(await inOwner(() => database.client.webhookEvent.findUnique({ where: { id: claim.id } }))).toMatchObject({ status: 'pending', leaseToken: claim.leaseToken })
  })

  it('rolls back revocation and notifications when final receipt completion loses its fence', async () => {
    const id = await seed(), claim = await queued(id), before = await account(id)
    await expect(inOwner(() => commitEbayInbound(claim, async (tx, receipt) => {
      await insideDomain.run(true, () => lifecycle.reconcileEbayRevocationInTx(tx, receipt, proof(id)))
      await tx.webhookEvent.update({ where: { id: claim.id }, data: { leaseToken: 'different-owner' } })
    }))).rejects.toMatchObject({ name: 'EbayInboundClaimLost' })
    expect(await account(id)).toEqual(before)
    expect(await effects(id)).toEqual({ notices: [], events: [] })
  })

  it('deduplicates each grant across notices and read-state changes, but not a later grant', async () => {
    const id = await seed()
    await applyRevocation(await queued(id), proof(id))
    const initial = (await effects(id)).notices.map(n => n.id)
    await database.pool.query('UPDATE "Notification" SET "readAt"=now() WHERE "entityId"=$1', [id])
    await applyRevocation(await queued(id), { kind: 'terminal', connectionId: id, workspaceId: OWNER, grantVersion: 1, authStatus: 'revoked' })
    expect((await effects(id)).notices.map(n => n.id)).toEqual(initial)
    await inOwner(() => storeGrant(id, { accessToken: 'synthetic-next-access', refreshToken: 'synthetic-next-refresh', expiresInSec: 7200, grantedScopes: [], identity: null }, { kind: 'operator' }, 'reconsent'))
    await applyRevocation(await queued(id), proof(id, 2))
    expect((await effects(id)).notices).toHaveLength(4)
  })

  it('records no active owners explicitly while still enforcing the security transition', async () => {
    const id = await seed(EMPTY), claim = await queued(id, EMPTY)
    expect(await applyRevocation(claim, proof(id, 1, EMPTY))).toMatchObject({ committed: true })
    expect(await account(id)).toMatchObject({ authStatus: 'revoked', isActive: false })
    const recorded = await effects(id)
    expect(recorded.notices).toHaveLength(0)
    expect(recorded.events.find(e => e.type === 'revoke')?.detail).toMatchObject({ notificationOutcome: 'no_active_owners', recipients: 0 })
  })

  it('does not add an ambient non-owner operator to the revocation recipients', async () => {
    const id = await seed(), claim = await queued(id)
    await withWorkspace({ workspaceId: OWNER, actorUserId: 'ordinary-member', membershipId: 'ordinary-member', roleKeys: [] },
      () => commitEbayInbound(claim, (tx, receipt) => insideDomain.run(true, () => lifecycle.reconcileEbayRevocationInTx(tx, receipt, proof(id)))))
    expect((await effects(id)).notices.map(n => n.userId)).toEqual(['owner-a', 'owner-b'])
  })

  it('refuses malformed activity evidence and legacy service mode before state changes', async () => {
    const id = await seed(), claim = await queued(id), before = await account(id)
    await expect(applyRevocation(claim, { ...proof(id), active: undefined } as any)).rejects.toThrow('incomplete')
    vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '0')
    try { await expect(applyRevocation(claim, proof(id))).rejects.toMatchObject({ reason: 'canonical_service_required' }) }
    finally { vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1') }
    expect(await account(id)).toEqual(before)
    expect(await effects(id)).toEqual({ notices: [], events: [] })
  })

  it('allows a reconnect waiting behind revocation to install a new active grant after commit', async () => {
    const id = await seed(), claim = await queued(id)
    let entered!: () => void, release!: () => void, pid = 0
    const ready = new Promise<void>(r => { entered = r }), held = new Promise<void>(r => { release = r })
    const committing = inOwner(() => commitEbayInbound(claim, (tx, receipt) => insideDomain.run(true, async () => {
      await lifecycle.reconcileEbayRevocationInTx(tx, receipt, proof(id))
      pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid
      entered(); await held
    })))
    await ready
    const reconnect = inOwner(() => storeGrant(id, { accessToken: 'synthetic-new-access', refreshToken: 'synthetic-new-refresh', expiresInSec: 7200, grantedScopes: [], identity: null }, { kind: 'operator' }, 'reconsent'))
    let blocked = false
    try {
      const deadline = Date.now() + 3_000
      while (!blocked && Date.now() < deadline) {
        blocked = (await database.pool.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked
        if (!blocked) await new Promise(r => setTimeout(r, 20))
      }
    } finally { release() }
    expect(await committing).toMatchObject({ committed: true })
    await reconnect
    expect(blocked).toBe(true)
    expect(await account(id)).toMatchObject({ authStatus: 'connected', isActive: true, grantVersion: 2 })
    expect((await effects(id)).notices).toHaveLength(2)
  })

  it('fences a refresh response that arrives after the revocation committed', async () => {
    const id = await seed()
    await inOwner(() => storeGrant(id, { accessToken: 'synthetic-expiring-access', refreshToken: 'synthetic-refresh', expiresInSec: 1, grantedScopes: [], identity: null }, { kind: 'operator' }, 'grant'))
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(r => { entered = r }), held = new Promise<void>(r => { release = r })
    vi.mocked(fetch).mockImplementationOnce(async () => {
      entered(); await held
      return new Response(JSON.stringify({ access_token: 'synthetic-late-access', expires_in: 7200 }), { status: 200 })
    })
    const refreshing = inOwner(() => getAccessToken(id, { forceRefresh: true }))
    const completed = refreshing.then(value => ({ value }), error => ({ error }))
    await Promise.race([ready, completed.then(() => { throw new Error('Refresh ended before the controlled HTTP request.') })])
    try { expect(await applyRevocation(await queued(id), proof(id, 2))).toMatchObject({ committed: true }) }
    finally { release() }
    expect(await completed).toMatchObject({ error: { name: 'RefreshContended' } })
    expect(await account(id)).toMatchObject({ authStatus: 'revoked', isActive: false, grantVersion: 2, refreshLeaseOwner: null })
  })
})
