import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import { activeDatabaseTransaction, inDatabaseTransaction } from '../../lib/database-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => (database.client as any)[key] }) }))
vi.mock('../monitoring/alert.service.js', () => ({ alertService: { createAlert: vi.fn() }, AlertType: { CONNECTION_HEALTH: 'CONNECTION_HEALTH' } }))
const token = await import('./token.service.js')
const crypto = await import('../../lib/crypto.js')
const { recordInbound } = await import('./ingress/ledger.js')
const { claimEbayInbound, commitEbayInbound } = await import('./ingress/ebay-claims.js')
const { reconcileEbayRevocationInTx } = await import('./account-lifecycle.service.js')
const OWNER = 'nexus_legacy_workspace'
const inOwner = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: OWNER, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const grant = (userId: string) => ({ accessToken: 'synthetic-new-access', refreshToken: 'synthetic-new-refresh', expiresInSec: 7200, grantedScopes: [], identity: { userId } })
const actor = { kind: 'operator' as const }
async function seed(userId: string, isActive = false, environment = 'production') {
  const id = randomUUID()
  await database.pool.query('INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","managedBy","externalAccountId","authStatus","isActive","grantVersion","connectionMetadata","updatedAt") VALUES ($1,$2,\'EBAY\',\'oauth\',$3,\'disconnected\',$4,1,$5,now())', [id, OWNER, userId, isActive, JSON.stringify({ environment })])
  return id
}
async function queued(connectionId: string, userId: string) {
  return inOwner(async () => {
    const notificationId = randomUUID()
    const event = await recordInbound({ channel: 'EBAY', eventType: 'AUTHORIZATION_REVOCATION', externalId: `ebay:production:${notificationId}`, connectionId,
      signatureOk: true, verifiedBy: 'ebay_ecdsa', queueForRetry: true,
      payload: { metadata: { topic: 'AUTHORIZATION_REVOCATION', schemaVersion: '1.0' }, notification: { notificationId, data: { userId, revocationDate: '2026-09-23T01:02:03Z' } } } })
    return (await claimEbayInbound(event.id!))!
  })
}
type Claim = Awaited<ReturnType<typeof queued>>
const evidence = (id: string) => ({ kind: 'terminal' as const, workspaceId: OWNER, connectionId: id, grantVersion: 1, authStatus: 'disconnected' as const })
const apply = (claim: Claim) => inOwner(() => commitEbayInbound(claim, (tx, receipt) => reconcileEbayRevocationInTx(tx, receipt, evidence(receipt.connectionId!))))
async function waitForBlocked(pid: number) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if ((await database.pool.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}
function barrier() {
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  return { ready, held, entered: () => entered(), release: () => release() }
}

describe.skipIf(!concurrentDatabaseUrl())('eBay immutable-seller grant fence in PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1')
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
    vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No live vendor request in identity race tests') }))
    database = await concurrentDatabase({ maxConnections: 8 })
    await import('./connectors/ebay/spec.js')
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals() }, 60_000)

  it('leaves an old terminal receipt unresolved when a sibling owns the current grant', async () => {
    const userId = randomUUID(), old = await seed(userId), current = await seed(userId)
    const claim = await queued(old, userId)
    await inOwner(() => token.storeGrant(current, grant(userId), actor, 'reconsent'))
    await expect(apply(claim)).rejects.toMatchObject({ reason: 'grant_changed' })
    expect((await database.pool.query('SELECT status FROM "WebhookEvent" WHERE id=$1', [claim.id])).rows[0].status).toBe('pending')
    expect((await database.pool.query('SELECT "isActive","authStatus" FROM "ChannelConnection" WHERE id=$1', [current])).rows[0]).toMatchObject({ isActive: true, authStatus: 'connected' })
  })

  it('waits for a concurrent sibling grant then reevaluates the committed current identity', async () => {
    const userId = randomUUID(), old = await seed(userId), current = await seed(userId), claim = await queued(old, userId)
    const hold = barrier(); let pid = 0
    const reconnect = inOwner(() => token.storeGrant(current, grant(userId), actor, 'reconsent', async tx => {
      pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid
      hold.entered(); await hold.held
    }))
    await Promise.race([hold.ready, reconnect.then(() => { throw new Error('Grant finished before controlled persistence') })])
    const processing = apply(claim).then(value => ({ value }), error => ({ error }))
    let blocked = false
    try { blocked = await waitForBlocked(pid) } finally { hold.release() }
    await reconnect
    expect(blocked).toBe(true)
    expect(await processing).toMatchObject({ error: { reason: 'grant_changed' } })
  })

  it('allows a legitimate sibling reconnect only after the earlier revocation commit', async () => {
    const userId = randomUUID(), old = await seed(userId), current = await seed(userId), claim = await queued(old, userId)
    const hold = barrier(); let pid = 0
    const processing = inOwner(() => commitEbayInbound(claim, async (tx, receipt) => {
      await reconcileEbayRevocationInTx(tx, receipt, evidence(old))
      pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid
      hold.entered(); await hold.held
    }))
    await Promise.race([hold.ready, processing.then(() => { throw new Error('Receipt finished before controlled commit') })])
    const reconnect = inOwner(() => token.storeGrant(current, grant(userId), actor, 'reconsent'))
    let blocked = false
    try { blocked = await waitForBlocked(pid) } finally { hold.release() }
    expect(await processing).toMatchObject({ committed: true })
    await reconnect
    expect(blocked).toBe(true)
    expect((await database.pool.query('SELECT "authStatus","isActive" FROM "ChannelConnection" WHERE id=$1', [current])).rows[0]).toMatchObject({ authStatus: 'connected', isActive: true })
  })

  it('fences a grant placed on a newly inserted row, before that row is visible to the receipt', async () => {
    const userId = randomUUID(), old = await seed(userId), claim = await queued(old, userId)
    const hold = barrier(); let pid = 0, createdId = ''
    const reconnect = inOwner(() => token.withEbayGrantTransaction({ grant: grant(userId), environment: 'production' }, async persist => {
      const tx = activeDatabaseTransaction()!
      const created = await tx.channelConnection.create({ data: { channelType: 'EBAY', managedBy: 'oauth', isActive: false, authStatus: 'unknown', connectionMetadata: { environment: 'production' } } })
      createdId = created.id
      await persist(created.id, actor, 'grant')
      pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid
      hold.entered(); await hold.held
    }))
    await Promise.race([hold.ready, reconnect.then(() => { throw new Error('New grant finished before its controlled commit') })])
    expect((await database.pool.query('SELECT count(*)::int AS n FROM "ChannelConnection" WHERE id=$1', [createdId])).rows[0].n).toBe(0)
    const processing = apply(claim).then(value => ({ value }), error => ({ error }))
    let blocked = false
    try { blocked = await waitForBlocked(pid) } finally { hold.release() }
    await reconnect
    expect(blocked).toBe(true)
    expect(await processing).toMatchObject({ error: { reason: 'grant_changed' } })
  })

  it('refuses standalone activation of a second current grant even across marketplaces', async () => {
    const userId = randomUUID(), first = await seed(userId), second = await seed(userId)
    await database.pool.query('UPDATE "ChannelConnection" SET marketplace=CASE WHEN id=$1 THEN \'EBAY_IT\' ELSE \'EBAY_DE\' END WHERE id IN ($1,$2)', [first, second])
    await inOwner(() => token.storeGrant(first, grant(userId), actor, 'grant'))
    await expect(inOwner(() => token.storeGrant(second, grant(userId), actor, 'grant'))).rejects.toMatchObject({ reason: 'grant_changed' })
    expect((await database.pool.query('SELECT "isActive","grantVersion" FROM "ChannelConnection" WHERE id=$1', [second])).rows[0]).toEqual({ isActive: false, grantVersion: 1 })
  })

  it('prepares outside transactions and freezes caller input before saving the grant', async () => {
    const userId = randomUUID(), id = await seed(userId), input = grant(userId), original = crypto.encryptCredentials
    const encrypt = vi.spyOn(crypto, 'encryptCredentials').mockImplementation(async fields => {
      expect(activeDatabaseTransaction()).toBeUndefined()
      return original(fields)
    })
    let escaped: Parameters<Parameters<typeof token.withEbayGrantTransaction>[1]>[0] | undefined
    try {
      await inOwner(() => token.withEbayGrantTransaction({ grant: input, environment: 'production' }, async persist => {
        escaped = persist
        input.identity.userId = randomUUID(); input.refreshToken = 'caller-mutated-token'
        await persist(id, actor, 'grant')
      }))
      expect(encrypt).toHaveBeenCalledTimes(1)
      const row = await inOwner(() => database.client.channelConnection.findUniqueOrThrow({ where: { id } }))
      expect(row.externalAccountId).toBe(userId)
      expect(await crypto.decryptCredentials(row.credentialsEnc!)).toMatchObject({ refreshToken: 'synthetic-new-refresh' })
      await expect(inOwner(() => escaped!(id, actor, 'reconsent'))).rejects.toMatchObject({ reason: 'grant_changed' })
    } finally { encrypt.mockRestore() }
  })

  it('rejects nested grant preparation before encryption, even inside ReadCommitted', async () => {
    const userId = randomUUID(), id = await seed(userId), encrypt = vi.spyOn(crypto, 'encryptCredentials')
    try {
      await expect(inOwner(() => inDatabaseTransaction(database.client as any,
        () => token.storeGrant(id, grant(userId), actor, 'grant'), { isolationLevel: 'ReadCommitted' }))).rejects.toThrow('own ordered transaction')
      expect(encrypt).not.toHaveBeenCalled()
    } finally { encrypt.mockRestore() }
  })

  it('preserves verified identity metadata when an existing account receives a grant without new identity', async () => {
    const userId = randomUUID(), id = await seed(userId)
    const identity = { userId, username: 'synthetic-seller', storeName: 'Synthetic Store', storeUrl: 'https://example.test/store' }
    await database.pool.query('UPDATE "ChannelConnection" SET identity=$2 WHERE id=$1', [id, JSON.stringify(identity)])
    await inOwner(() => token.storeGrant(id, { ...grant(userId), identity: null }, actor, 'reconsent'))
    expect(await inOwner(() => database.client.channelConnection.findUniqueOrThrow({ where: { id } }))).toMatchObject({ identity, externalAccountId: userId, grantVersion: 2, isActive: true })
  })

  it.each(['subject', 'environment'])('refuses a stored receipt whose %s differs from its bound account', async mismatch => {
    const userId = randomUUID(), id = await seed(userId), claim = await queued(id, userId)
    if (mismatch === 'subject') await database.pool.query('UPDATE "WebhookEvent" SET payload=jsonb_set(payload,\'{notification,data,userId}\',to_jsonb($2::text)) WHERE id=$1', [claim.id, randomUUID()])
    else await database.pool.query('UPDATE "WebhookEvent" SET "externalId"=replace("externalId",\'ebay:production:\',\'ebay:sandbox:\') WHERE id=$1', [claim.id])
    await expect(apply(claim)).rejects.toMatchObject({ reason: 'grant_changed' })
    expect((await database.pool.query('SELECT status FROM "WebhookEvent" WHERE id=$1', [claim.id])).rows[0].status).toBe('pending')
  })
})
