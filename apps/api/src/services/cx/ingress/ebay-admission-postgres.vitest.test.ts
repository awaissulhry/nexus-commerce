import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
let beforeQuarantineInsert: ((tx: any) => Promise<void>) | undefined
let beforeReceiptInsert: ((tx: any) => Promise<void>) | undefined
let failReceiptWrite = false
const verifier = vi.fn(async () => ({ ok: true, reason: 'ok', kid: 'synthetic-public-key' }))
vi.mock('./ebay-signature.js', () => ({ verifyEbayNotification: verifier }))
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => {
  if (key !== '$transaction') return (database.client as any)[key]
  return (work: any, options: any) => database.client.$transaction((tx: any) => work(new Proxy(tx, { get: (target, model) => {
    const delegate = target[model]
    if (model !== 'ebayNoticeQuarantine' && model !== 'webhookEvent') return delegate
    return new Proxy(delegate, { get: (object, method) => {
      const original = object[method]
      if (model === 'ebayNoticeQuarantine' && method === 'create') return async (args: any) => {
        if (beforeQuarantineInsert) await beforeQuarantineInsert(tx)
        return original.call(object, args)
      }
      if (model === 'webhookEvent' && method === 'createMany') return async (args: any) => {
        if (beforeReceiptInsert) await beforeReceiptInsert(tx)
        const result = await original.call(object, args)
        if (failReceiptWrite) { failReceiptWrite = false; throw new Error('Synthetic failure after receipt insertion') }
        return result
      }
      return original
    } })
  } })), options)
} }) }))

const admission = await import('./ebay-admission.js')
const crypto = await import('../../../lib/crypto.js')
const OWNER = 'nexus_legacy_workspace', OTHER = randomUUID()
const context = (workspaceId: string, actorUserId: string | null = null) => ({ workspaceId, actorUserId, membershipId: actorUserId ? `${workspaceId}:${actorUserId}` : null, roleKeys: [] })
const inProfile = <T>(workspaceId: string, work: () => Promise<T>, actor: string | null = null) => withWorkspace(context(workspaceId, actor), work)
const inOwner = <T>(work: () => Promise<T>, actor: string | null = null) => inProfile(OWNER, work, actor)
const payload = (userId = randomUUID(), notificationId = randomUUID()) => ({ metadata: { topic: 'AUTHORIZATION_REVOCATION', schemaVersion: '1.0' },
  notification: { notificationId, publishDate: '2026-09-23T01:02:05Z', publishAttemptCount: 1,
    data: { userId, username: 'synthetic-private-name', revocationDate: '2026-09-23T01:02:03Z' } } })
const receive = (body: unknown, environment: 'production' | 'sandbox' = 'production') => admission.receiveEbayNotice({ rawBody: Buffer.from(JSON.stringify(body)), header: 'synthetic-signature', environment })
async function seed(userId: string, workspaceId = OWNER, isActive = true, environment = 'production') {
  const id = randomUUID()
  await database.pool.query('INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","managedBy","authStatus","isActive","connectionMetadata","updatedAt") VALUES ($1,$2,\'EBAY\',$3,\'oauth\',\'disconnected\',$4,$5,now())', [id, workspaceId, userId, isActive, JSON.stringify({ environment })])
  return id
}
async function quarantine(id: string) { return inOwner(() => database.client.ebayNoticeQuarantine.findUniqueOrThrow({ where: { id } })) }
async function events(workspaceId = OWNER) { return inProfile(workspaceId, () => database.client.webhookEvent.findMany({ orderBy: { createdAt: 'asc' } })) }
async function transfer(connectionId: string) {
  return inOwner(() => database.client.$transaction(async tx => {
    const [preview] = await tx.$queryRaw<Array<{ result: any }>>`SELECT nexus_assign_channel_account(${connectionId},${OTHER},NULL) AS result`
    if (!preview.result.eligible) return preview.result
    return (await tx.$queryRaw<Array<{ result: any }>>`SELECT nexus_assign_channel_account(${connectionId},${OTHER},${preview.result.version}) AS result`)[0].result
  }), 'operator')
}

describe.skipIf(!concurrentDatabaseUrl())('eBay admission, ownership and private quarantine in PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
    vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No live request is allowed in admission tests') }))
    database = await concurrentDatabase({ maxConnections: 10 })
    // Exercise the deployed migration, including its policies, over the previous schema.
    // The current review table references retained quarantine; rebuild it after replaying the historical table.
    await database.pool.query('DROP TABLE "ErasureRequest"')
    await database.pool.query('DROP TABLE "EbayNoticeQuarantine"')
    await database.pool.query(readFileSync(new URL('../../../../../../packages/database/prisma/migrations/20260923c_cx_ebay_quarantine/migration.sql', import.meta.url), 'utf8'))
    await database.pool.query(readFileSync(new URL('../../../../../../packages/database/prisma/migrations/20260923e_cx_inbound_archive/migration.sql', import.meta.url), 'utf8'))
    // Reinstall the current guard/policies after replaying the historical table migration.
    await database.pool.query(readFileSync(new URL('../../../../../../packages/database/workspaces/ebay-quarantine.sql', import.meta.url), 'utf8'))
    await database.pool.query(readFileSync(new URL('../../../../../../packages/database/prisma/migrations/20260926t_cx_ebay_erasure_review/migration.sql', import.meta.url), 'utf8'))
    await database.pool.query('INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ($1,\'Admission other business\',\'test\',$1,now())', [OTHER])
    await database.pool.query('INSERT INTO "Role" (id,key,name,permissions,"updatedAt") VALUES (\'admission-owner-role\',\'OWNER\',\'Owner\',ARRAY[]::text[],now()) ON CONFLICT (key) DO NOTHING')
    const role = (await database.pool.query('SELECT id FROM "Role" WHERE key=\'OWNER\'')).rows[0].id
    for (const user of ['operator', 'a-owner', 'b-owner', 'member']) {
      await database.pool.query('INSERT INTO "UserProfile" (id,email,"displayName",status,"updatedAt") VALUES ($1,$2,$1,\'active\',now())', [user, `${user}@test.local`])
      for (const workspace of user === 'operator' ? [OWNER, OTHER] : [user === 'b-owner' ? OTHER : OWNER]) {
        const id = `${workspace}:${user}`
        await database.pool.query('INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,\'active\',now())', [id, workspace, user])
        if (user !== 'member') await database.pool.query('INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)', [id, role])
      }
    }
  }, 180_000)
  afterAll(async () => { beforeQuarantineInsert = undefined; await database?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() }, 60_000)
  afterEach(() => { beforeQuarantineInsert = undefined; beforeReceiptInsert = undefined; failReceiptWrite = false })

  it('routes the immutable subject to its owner, ignoring the ambient profile', async () => {
    const body = payload(), connectionId = await seed(body.notification.data.userId)
    const result = await inProfile(OTHER, () => receive(body), 'b-owner')
    expect(result).toMatchObject({ kind: 'accepted', workspaceId: OWNER, duplicate: false })
    if (result.kind !== 'accepted') throw new Error('Expected owned receipt')
    const row = await inOwner(() => database.client.webhookEvent.findUnique({ where: { id: result.receiptId } }))
    expect(row).toMatchObject({ workspaceId: OWNER, connectionId, payload: body, status: 'pending', isProcessed: false, signatureOk: true, verifiedBy: 'ebay_ecdsa', deliveries: 1 })
    expect(row!.nextAttemptAt).toBeNull()
    expect(row!.externalId).toBe(`ebay:production:${body.notification.notificationId}`)
    expect((await database.pool.query('SELECT count(*)::int AS n FROM "EbayNoticeQuarantine" WHERE "externalId"=$1', [body.notification.notificationId])).rows[0].n).toBe(0)
  })

  it('chooses one exact active account over its inactive duplicate without sweeping accounts', async () => {
    const body = payload()
    await seed(body.notification.data.userId, OWNER, false)
    const active = await seed(body.notification.data.userId)
    const result = await receive(body)
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') throw new Error('Expected owned receipt')
    expect(await inOwner(() => database.client.webhookEvent.findUnique({ where: { id: result.receiptId } }))).toMatchObject({ connectionId: active })
  })

  it('preserves the first payload/account across a changed retry and an inactive routing index', async () => {
    const body = payload(), connectionId = await seed(body.notification.data.userId)
    const first = await receive(body)
    await inOwner(() => database.client.channelConnection.update({ where: { id: connectionId }, data: { isActive: false } }))
    expect(await inOwner(() => database.client.channelAccountRoute.findUnique({ where: { connectionId } }))).toBeNull()
    const retry = { ...body, notification: { ...body.notification, publishAttemptCount: 2, publishDate: '2026-09-23T01:03:05Z' } }
    const second = await receive(retry)
    expect(second).toMatchObject({ kind: 'accepted', receiptId: (first as any).receiptId, duplicate: true })
    const row = await inOwner(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id: (first as any).receiptId } }))
    expect(row).toMatchObject({ payload: body, deliveries: 2, connectionId })
  })

  it('stores an unknown owner encrypted, with no ordinary business ledger row', async () => {
    const body = payload(), before = (await events()).length
    const result = await receive(body)
    expect(result).toMatchObject({ kind: 'quarantined', reason: 'owner_unknown' })
    if (result.kind !== 'quarantined') throw new Error('Expected quarantine')
    const row = await quarantine(result.quarantineId)
    expect(row).toMatchObject({ signatureOk: true, firstOwnerWorkspaceId: null, deliveries: 1, resolvedReceiptId: null })
    expect(crypto.isCredentialsBlob(row.payloadEnc)).toBe(true)
    expect(JSON.stringify(row)).not.toContain('synthetic-private-name')
    expect(JSON.stringify(row)).not.toContain(body.notification.data.userId)
    expect((await events()).length).toBe(before)
  })

  it('does not fall back to usernames or unrelated sole accounts', async () => {
    const body = payload(); delete (body.notification.data as any).userId
    const result = await receive(body)
    expect(result).toMatchObject({ kind: 'quarantined', reason: 'subject_or_topic_unresolved' })
    if (result.kind !== 'quarantined') throw new Error('Expected quarantine')
    expect(await quarantine(result.quarantineId)).toMatchObject({ subjectHash: null, firstOwnerWorkspaceId: null })
  })

  it('keeps unverified private bodies out of every tenant ledger and cannot promote them', async () => {
    const body = payload(); await seed(body.notification.data.userId)
    const before = (await events()).length
    verifier.mockResolvedValueOnce({ ok: false, reason: 'signature_mismatch', kid: 'synthetic-public-key' })
    const encrypt = vi.spyOn(crypto, 'encryptCredentials')
    const result = await receive(body)
    expect(encrypt).not.toHaveBeenCalled()
    encrypt.mockRestore()
    expect(result).toMatchObject({ kind: 'rejected', reason: 'signature_mismatch' })
    if (result.kind !== 'rejected') throw new Error('Expected rejection')
    const row = await quarantine(result.quarantineId)
    expect(row.signatureOk).toBe(false)
    expect(row.payloadEnc).toBeNull()
    expect(row.payloadKeyId).toBeNull()
    expect(row.subjectHash).toBeNull()
    expect(JSON.stringify(row)).not.toContain('synthetic-private-name')
    expect((await events()).length).toBe(before)
    await expect(database.pool.query('UPDATE "EbayNoticeQuarantine" SET "signatureOk"=true WHERE id=$1', [row.id])).rejects.toMatchObject({ code: '23514' })
  })

  it('denies tenant reads and deletes, and prevents source/identity changes even to system writers', async () => {
    const result = await receive(payload())
    if (result.kind !== 'quarantined') throw new Error('Expected quarantine')
    expect(await inOwner(() => database.client.ebayNoticeQuarantine.findUnique({ where: { id: result.quarantineId } }), 'a-owner')).toBeNull()
    await expect(inOwner(() => database.client.$queryRaw`SELECT * FROM nexus_ebay_notice_workspace('production', 'private-notice')`, 'a-owner')).rejects.toThrow()
    await expect(inOwner(() => database.client.$queryRaw`SELECT * FROM nexus_lock_ebay_notice_owner('production', 'private-user')`, 'a-owner')).rejects.toThrow()
    await expect(inOwner(() => database.client.ebayNoticeQuarantine.delete({ where: { id: result.quarantineId } }))).rejects.toThrow()
    await expect(inOwner(() => database.client.ebayNoticeQuarantine.update({ where: { id: result.quarantineId }, data: { payloadEnc: 'different' } }))).rejects.toThrow()
    await expect(database.pool.query('UPDATE "EbayNoticeQuarantine" SET "externalId"=\'different\' WHERE id=$1', [result.quarantineId])).rejects.toMatchObject({ code: '23514' })
  })

  it('requires explicit owner adoption after a previously unknown subject becomes connected', async () => {
    const body = payload(), result = await receive(body)
    if (result.kind !== 'quarantined') throw new Error('Expected quarantine')
    const connectionId = await seed(body.notification.data.userId)
    expect(await receive(body)).toMatchObject({ kind: 'quarantined', quarantineId: result.quarantineId })
    await expect(inOwner(() => admission.adoptEbayQuarantine(result.quarantineId, connectionId), 'member')).rejects.toMatchObject({ reason: 'adoption_forbidden' })
    const resolved = await inOwner(() => admission.adoptEbayQuarantine(result.quarantineId, connectionId), 'a-owner')
    const row = await inOwner(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id: resolved.receiptId } }))
    expect(row).toMatchObject({ payload: body, connectionId, deliveries: 2, signatureOk: true, status: 'pending' })
    expect(row.createdAt).toEqual((await quarantine(result.quarantineId)).receivedAt)
    expect(await receive({ ...body, notification: { ...body.notification, publishAttemptCount: 3 } })).toMatchObject({ kind: 'accepted', receiptId: row.id })
    expect((await inOwner(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id: row.id } }))).deliveries).toBe(3)
  })

  it('gives simultaneous owner handoffs one business receipt and one destination pointer', async () => {
    const body = payload(), result = await receive(body)
    if (result.kind !== 'quarantined') throw new Error('Expected quarantine')
    const connectionId = await seed(body.notification.data.userId)
    const outcomes = await Promise.all([1, 2].map(() => inOwner(() => admission.adoptEbayQuarantine(result.quarantineId, connectionId), 'a-owner')))
    expect(outcomes[0]).toEqual(outcomes[1])
    expect((await database.pool.query('SELECT count(*)::int AS n FROM "WebhookEvent" WHERE "externalId"=$1', [admission.ebayReceiptExternalId('production', body.notification.notificationId)])).rows[0].n).toBe(1)
    expect((await quarantine(result.quarantineId)).resolvedReceiptId).toBe(outcomes[0].receiptId)
  })

  it('rolls a failed handoff back without losing ciphertext or leaving a partial receipt', async () => {
    const body = payload(), result = await receive(body)
    if (result.kind !== 'quarantined') throw new Error('Expected quarantine')
    const connectionId = await seed(body.notification.data.userId), before = await quarantine(result.quarantineId)
    failReceiptWrite = true
    await expect(inOwner(() => admission.adoptEbayQuarantine(result.quarantineId, connectionId), 'a-owner')).rejects.toThrow()
    expect(await quarantine(result.quarantineId)).toEqual(before)
    expect((await database.pool.query('SELECT count(*)::int AS n FROM "WebhookEvent" WHERE "externalId"=$1', [admission.ebayReceiptExternalId('production', body.notification.notificationId)])).rows[0].n).toBe(0)
  })

  it('serializes unknown-owner admission against a newly routable concurrent delivery', async () => {
    const body = payload()
    let entered!: () => void, release!: () => void, pid = 0
    const ready = new Promise<void>(r => { entered = r }), held = new Promise<void>(r => { release = r })
    beforeQuarantineInsert = async tx => {
      beforeQuarantineInsert = undefined
      pid = (await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid
      entered(); await held
    }
    const first = receive(body)
    await Promise.race([ready, first.then(() => { throw new Error('Admission finished before its controlled insert.') })])
    await seed(body.notification.data.userId)
    const second = receive({ ...body, notification: { ...body.notification, publishAttemptCount: 2 } })
    let blocked = false
    try {
      const deadline = Date.now() + 3_000
      while (!blocked && Date.now() < deadline) {
        blocked = (await database.pool.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked
        if (!blocked) await new Promise(r => setTimeout(r, 20))
      }
    } finally { release() }
    const [a, b] = await Promise.all([first, second])
    expect(blocked).toBe(true)
    expect(a.kind).toBe('quarantined'); expect(b).toEqual(a)
    if (a.kind !== 'quarantined') throw new Error('Expected quarantine')
    const row = await quarantine(a.quarantineId)
    expect(row.deliveries).toBe(2)
    const saved = await crypto.decryptCredentials(row.payloadEnc!)
    expect(JSON.parse(Buffer.from(String(saved.rawBody), 'base64').toString('utf8'))).toEqual(body)
    expect((await database.pool.query('SELECT count(*)::int AS n FROM "WebhookEvent" WHERE "externalId"=$1', [admission.ebayReceiptExternalId('production', body.notification.notificationId)])).rows[0].n).toBe(0)
  })

  it('keeps environment routing distinct while honoring deployed active-account uniqueness', async () => {
    const body = payload()
    await seed(body.notification.data.userId, OWNER, true, 'production')
    // The deployed legacy index does not include environment. Two active copies
    // of this exact identity are currently refused; retained inactive history is valid.
    await expect(seed(body.notification.data.userId, OTHER, true, 'sandbox')).rejects.toMatchObject({ code: '23505', constraint: 'ChannelConnection_active_account_key' })
    await seed(body.notification.data.userId, OTHER, false, 'sandbox')
    expect(await receive(body)).toMatchObject({ kind: 'accepted', workspaceId: OWNER })
    expect(await receive(body, 'sandbox')).toMatchObject({ kind: 'accepted', workspaceId: OTHER })
  })

  it('refuses encryption failure without acknowledging durable quarantine', async () => {
    const body = payload()
    const spy = vi.spyOn(crypto, 'encryptCredentials').mockRejectedValueOnce(new Error('synthetic sensitive key failure'))
    try { await expect(receive(body)).rejects.toMatchObject({ reason: 'cipher_unavailable', message: 'The eBay notice could not be accepted or routed safely.' }) }
    finally { spy.mockRestore() }
    expect((await database.pool.query('SELECT count(*)::int AS n FROM "EbayNoticeQuarantine" WHERE "externalId"=$1', [body.notification.notificationId])).rows[0].n).toBe(0)
  })

  it('retains the captured owner through a later account transfer while quarantined', async () => {
    const body = payload(), connectionId = await seed(body.notification.data.userId, OWNER, false)
    const duplicate = await seed(body.notification.data.userId, OWNER, false)
    const result = await receive(body)
    if (result.kind !== 'quarantined') throw new Error('Expected ambiguous quarantine')
    expect((await quarantine(result.quarantineId)).firstOwnerWorkspaceId).toBe(OWNER)
    await database.pool.query('DELETE FROM "ChannelConnection" WHERE id=$1', [duplicate])
    const assigned = await transfer(connectionId)
    expect(assigned.assigned).toBe(true)
    await expect(inProfile(OTHER, () => admission.adoptEbayQuarantine(result.quarantineId, assigned.connectionId), 'b-owner')).rejects.toMatchObject({ reason: 'adoption_forbidden' })
    expect(await inProfile(OTHER, () => admission.listOwnEbayQuarantine(assigned.connectionId), 'b-owner')).toEqual({ items: [], nextCursor: null })
    expect((await quarantine(result.quarantineId)).resolvedReceiptId).toBeNull()
  })

  it('blocks supported transfer once a verified receipt is bound, including after completion/archive', async () => {
    const body = payload(), connectionId = await seed(body.notification.data.userId, OWNER, false)
    const accepted = await receive(body)
    if (accepted.kind !== 'accepted') throw new Error('Expected bound receipt')
    await inOwner(() => database.client.webhookEvent.update({ where: { id: accepted.receiptId }, data: { status: 'done', isProcessed: true, archivedAt: new Date() } }))
    const result = await transfer(connectionId)
    expect(result.eligible).toBe(false)
    expect(result.references).toContain('WebhookEvent')
    expect((await database.pool.query('SELECT "workspaceId" FROM "ChannelAccountOwnership" WHERE "channelType"=\'EBAY\' AND "externalAccountId"=$1', [body.notification.data.userId])).rows[0].workspaceId).toBe(OWNER)
  })

  it('serializes a real account transfer behind first admission and then refuses it', async () => {
    const body = payload(), connectionId = await seed(body.notification.data.userId, OWNER, false)
    let entered!: () => void, release!: () => void, pid = 0
    const ready = new Promise<void>(r => { entered = r }), held = new Promise<void>(r => { release = r })
    beforeReceiptInsert = async tx => {
      beforeReceiptInsert = undefined
      pid = (await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid
      entered(); await held
    }
    const receiving = receive(body)
    await Promise.race([ready, receiving.then(() => { throw new Error('Receipt finished before its controlled insertion') })])
    const assigning = transfer(connectionId)
    let blocked = false
    try {
      const deadline = Date.now() + 3_000
      while (!blocked && Date.now() < deadline) {
        blocked = (await database.pool.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked
        if (!blocked) await new Promise(r => setTimeout(r, 20))
      }
    } finally { release() }
    const [accepted, assigned] = await Promise.all([receiving, assigning])
    expect(blocked).toBe(true)
    expect(accepted.kind).toBe('accepted')
    expect(assigned).toMatchObject({ eligible: false })
    expect(assigned.references).toContain('WebhookEvent')
  })

  it('acknowledges archived duplicates without restoring payload or rescheduling work', async () => {
    const body = payload(); await seed(body.notification.data.userId)
    const first = await receive(body)
    if (first.kind !== 'accepted') throw new Error('Expected receipt')
    await inOwner(() => database.client.webhookEvent.update({ where: { id: first.receiptId }, data: { status: 'done', isProcessed: true, archivedAt: new Date(), payload: {}, nextAttemptAt: null } }))
    expect(await receive(body)).toMatchObject({ kind: 'accepted', receiptId: first.receiptId, duplicate: true })
    expect(await inOwner(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id: first.receiptId } }))).toMatchObject({ payload: {}, status: 'done', deliveries: 2, nextAttemptAt: null })
    const forgedReuse = { ...body, notification: { ...body.notification, data: { ...body.notification.data, userId: randomUUID() } } }
    await expect(receive(forgedReuse)).rejects.toMatchObject({ reason: 'identity_conflict' })
  })

  it('refuses a swapped encrypted binding and preserves the recoverable quarantine', async () => {
    const body = payload(), result = await receive(body)
    if (result.kind !== 'quarantined') throw new Error('Expected quarantine')
    const connectionId = await seed(body.notification.data.userId), before = await quarantine(result.quarantineId)
    const plain = await crypto.decryptCredentials(before.payloadEnc!)
    const spy = vi.spyOn(crypto, 'decryptCredentials').mockResolvedValueOnce({ ...plain, binding: { ...(plain.binding as object), environment: 'sandbox' } })
    try { await expect(inOwner(() => admission.adoptEbayQuarantine(result.quarantineId, connectionId), 'a-owner')).rejects.toMatchObject({ reason: 'cipher_unavailable' }) }
    finally { spy.mockRestore() }
    expect(await quarantine(result.quarantineId)).toEqual(before)
  })

  it('rechecks owner authority after decryption, before making a handoff', async () => {
    const body = payload(), result = await receive(body)
    if (result.kind !== 'quarantined') throw new Error('Expected quarantine')
    const connectionId = await seed(body.notification.data.userId), original = crypto.decryptCredentials
    const spy = vi.spyOn(crypto, 'decryptCredentials').mockImplementationOnce(async blob => {
      await database.pool.query('UPDATE "WorkspaceMembership" SET status=\'inactive\' WHERE id=$1', [`${OWNER}:a-owner`])
      return original(blob)
    })
    try { await expect(inOwner(() => admission.adoptEbayQuarantine(result.quarantineId, connectionId), 'a-owner')).rejects.toMatchObject({ reason: 'adoption_forbidden' }) }
    finally {
      spy.mockRestore()
      await database.pool.query('UPDATE "WorkspaceMembership" SET status=\'active\' WHERE id=$1', [`${OWNER}:a-owner`])
    }
    expect((await quarantine(result.quarantineId)).resolvedReceiptId).toBeNull()
  })

  it('refuses reuse of a known delivery ID by a different profile or an unresolved subject', async () => {
    const body = payload(); await seed(body.notification.data.userId)
    const first = await receive(body)
    if (first.kind !== 'accepted') throw new Error('Expected receipt')
    const otherUser = randomUUID(); await seed(otherUser, OTHER)
    const changed = { ...body, notification: { ...body.notification, data: { ...body.notification.data, userId: otherUser } } }
    await expect(receive(changed)).rejects.toMatchObject({ reason: 'identity_conflict' })
    delete (changed.notification.data as any).userId
    await expect(receive(changed)).rejects.toMatchObject({ reason: 'identity_conflict' })
    expect((await database.pool.query('SELECT count(*)::int AS n FROM "WebhookEvent" WHERE "externalId"=$1', [admission.ebayReceiptExternalId('production', body.notification.notificationId)])).rows[0].n).toBe(1)
    expect((await database.pool.query('SELECT count(*)::int AS n FROM "EbayNoticeQuarantine" WHERE "externalId"=$1', [body.notification.notificationId])).rows[0].n).toBe(0)
  })

  it('refuses an ambiguous preexisting cross-profile delivery binding', async () => {
    const body = payload(); await seed(body.notification.data.userId)
    await receive(body)
    await inProfile(OTHER, () => database.client.webhookEvent.create({ data: {
      channel: 'EBAY', externalId: admission.ebayReceiptExternalId('production', body.notification.notificationId),
      eventType: 'AUTHORIZATION_REVOCATION', payload: {}, signatureOk: true, verifiedBy: 'ebay_ecdsa', deliveries: 1,
    } }))
    await expect(receive(body)).rejects.toMatchObject({ reason: 'identity_conflict' })
    expect((await database.pool.query('SELECT deliveries FROM "WebhookEvent" WHERE "externalId"=$1', [admission.ebayReceiptExternalId('production', body.notification.notificationId)])).rows.map(r => r.deliveries)).toEqual([1, 1])
  })

  it('owns a byte snapshot even if the caller changes its buffer during verification', async () => {
    const body = payload(); await seed(body.notification.data.userId)
    const raw = Buffer.from(JSON.stringify(body))
    verifier.mockImplementationOnce(async () => { raw.fill(' '); return { ok: true, reason: 'ok', kid: 'synthetic-public-key' } })
    const result = await admission.receiveEbayNotice({ rawBody: raw, header: 'synthetic-signature' })
    if (result.kind !== 'accepted') throw new Error('Expected receipt')
    expect(await inOwner(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id: result.receiptId } }))).toMatchObject({ payload: body })
  })

  it('retains the original binding while its business profile is archived', async () => {
    const body = payload(); await seed(body.notification.data.userId, OTHER)
    const first = await receive(body)
    if (first.kind !== 'accepted') throw new Error('Expected receipt')
    await database.pool.query('UPDATE "Workspace" SET status=\'archived\' WHERE id=$1', [OTHER])
    try {
      await expect(receive(body)).rejects.toMatchObject({ reason: 'owner_unavailable' })
      expect((await database.pool.query('SELECT count(*)::int AS n FROM "EbayNoticeQuarantine" WHERE "externalId"=$1', [body.notification.notificationId])).rows[0].n).toBe(0)
      expect((await database.pool.query('SELECT deliveries FROM "WebhookEvent" WHERE id=$1', [first.receiptId])).rows[0].deliveries).toBe(1)
    } finally { await database.pool.query('UPDATE "Workspace" SET status=\'active\' WHERE id=$1', [OTHER]) }
    expect(await receive(body)).toMatchObject({ kind: 'accepted', receiptId: first.receiptId, duplicate: true })
  })

  it('refuses a handoff conflicting with an existing receipt in another business', async () => {
    const body = payload(), result = await receive(body)
    if (result.kind !== 'quarantined') throw new Error('Expected quarantine')
    const connectionId = await seed(body.notification.data.userId)
    await inProfile(OTHER, () => database.client.webhookEvent.create({ data: {
      channel: 'EBAY', externalId: admission.ebayReceiptExternalId('production', body.notification.notificationId),
      eventType: 'AUTHORIZATION_REVOCATION', payload: {}, signatureOk: true, verifiedBy: 'ebay_ecdsa', deliveries: 1,
    } }))
    await expect(inOwner(() => admission.adoptEbayQuarantine(result.quarantineId, connectionId), 'a-owner')).rejects.toMatchObject({ reason: 'identity_conflict' })
    expect((await quarantine(result.quarantineId)).resolvedReceiptId).toBeNull()
    expect((await database.pool.query('SELECT count(*)::int AS n FROM "WebhookEvent" WHERE "externalId"=$1', [admission.ebayReceiptExternalId('production', body.notification.notificationId)])).rows[0].n).toBe(1)
  })

  it('lists only matching unresolved metadata, never decrypts it, and removes adopted notices from recovery', async () => {
    const body = payload(), own = await receive(body), foreignBody = payload()
    await receive(foreignBody)
    const connectionId = await seed(body.notification.data.userId)
    await seed(foreignBody.notification.data.userId, OTHER)
    const decrypt = vi.spyOn(crypto, 'decryptCredentials')
    try {
      const view = await inOwner(() => admission.listOwnEbayQuarantine(connectionId), 'a-owner')
      expect(view.nextCursor).toBeNull()
      expect(view.items).toHaveLength(1)
      expect(view.items[0]).toMatchObject({ id: (own as any).quarantineId, externalId: body.notification.notificationId,
        topic: 'AUTHORIZATION_REVOCATION', environment: 'production', deliveries: 1, reason: 'owner_unknown' })
      expect(Object.keys(view.items[0]).sort()).toEqual(['id', 'externalId', 'topic', 'environment', 'receivedAt', 'lastReceivedAt', 'deliveries', 'reason'].sort())
      expect(decrypt).not.toHaveBeenCalled()
      expect(JSON.stringify(view)).not.toMatch(/synthetic-private-name|payloadEnc|payloadDigest|subjectHash|verificationKeyId/)
    } finally { decrypt.mockRestore() }
    await inOwner(() => admission.adoptEbayQuarantine((own as any).quarantineId, connectionId), 'a-owner')
    expect(await inOwner(() => admission.listOwnEbayQuarantine(connectionId), 'a-owner')).toEqual({ items: [], nextCursor: null })
  })

  it('bounds metadata pages to fifty and uses a stable cursor without dropping a receipt', async () => {
    const userId = randomUUID(), ids = []
    for (let index = 0; index < 51; index++) {
      const result = await receive(payload(userId))
      if (result.kind !== 'quarantined') throw new Error('Expected unassigned receipt')
      ids.push(result.quarantineId)
    }
    const connectionId = await seed(userId)
    const first = await inOwner(() => admission.listOwnEbayQuarantine(connectionId, { take: 100 }), 'a-owner')
    expect(first.items.map(row => row.id)).toEqual(ids.sort().slice(0, 50))
    expect(first.nextCursor).toBe(first.items[49].id)
    const last = await inOwner(() => admission.listOwnEbayQuarantine(connectionId, { after: first.nextCursor! }), 'a-owner')
    expect(last.items.map(row => row.id)).toEqual(ids.slice(50))
    expect(last.nextCursor).toBeNull()
  })

  it('refuses anonymous, member, foreign-profile and missing-account recovery reads', async () => {
    const body = payload(); await receive(body)
    const connectionId = await seed(body.notification.data.userId)
    for (const actor of [null, 'member', 'b-owner']) {
      await expect(inOwner(() => admission.listOwnEbayQuarantine(connectionId), actor)).rejects.toMatchObject({ reason: 'adoption_forbidden' })
    }
    await expect(inProfile(OTHER, () => admission.listOwnEbayQuarantine(connectionId), 'b-owner')).rejects.toMatchObject({ reason: 'adoption_forbidden' })
    await expect(inOwner(() => admission.listOwnEbayQuarantine(randomUUID()), 'a-owner')).rejects.toMatchObject({ reason: 'adoption_forbidden' })
    expect((await inOwner(() => admission.listOwnEbayQuarantine(connectionId), 'a-owner')).items).toHaveLength(1)
  })

  it('keeps the same provider subject isolated across production and sandbox recovery', async () => {
    const body = payload(), production = await receive(body), sandbox = await receive(body, 'sandbox')
    const prodAccount = await seed(body.notification.data.userId), sandboxAccount = await seed(body.notification.data.userId, OTHER, false, 'sandbox')
    expect((await inOwner(() => admission.listOwnEbayQuarantine(prodAccount), 'a-owner')).items.map(row => row.id)).toEqual([(production as any).quarantineId])
    expect((await inProfile(OTHER, () => admission.listOwnEbayQuarantine(sandboxAccount), 'b-owner')).items.map(row => row.id)).toEqual([(sandbox as any).quarantineId])
  })

  it.each(['metadata', 'resolved adoption'])('rechecks owner authority for %s after membership revocation wins its workspace lock', async operation => {
    const body = payload(), retained = await receive(body)
    if (retained.kind !== 'quarantined') throw new Error('Expected quarantine')
    const connectionId = await seed(body.notification.data.userId), blocker = await database.pool.connect()
    if (operation === 'resolved adoption') await inOwner(() => admission.adoptEbayQuarantine(retained.quarantineId, connectionId), 'a-owner')
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM "Workspace" WHERE id=$1 FOR UPDATE', [OWNER])
    await blocker.query('UPDATE "WorkspaceMembership" SET status=\'inactive\' WHERE "workspaceId"=$1 AND "userId"=\'a-owner\'', [OWNER])
    const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const reading = Promise.resolve().then(() => inOwner(() => operation === 'metadata'
      ? admission.listOwnEbayQuarantine(connectionId)
      : admission.adoptEbayQuarantine(retained.quarantineId, connectionId), 'a-owner'))
      .then(value => ({ value }), error => ({ error }))
    let blocked = false
    try {
      const deadline = Date.now() + 3_000
      while (!blocked && Date.now() < deadline) {
        blocked = (await database.pool.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 20))
      }
    } finally { await blocker.query('COMMIT'); blocker.release() }
    const result = await reading
    await database.pool.query('UPDATE "WorkspaceMembership" SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=\'a-owner\'', [OWNER])
    expect(blocked).toBe(true)
    expect(result).toMatchObject({ error: { reason: 'adoption_forbidden' } })
  })

  it('refuses idempotent adoption into a different same-seller account and preserves the original binding', async () => {
    const body = payload(), retained = await receive(body)
    if (retained.kind !== 'quarantined') throw new Error('Expected quarantine')
    const first = await seed(body.notification.data.userId, OWNER, false), second = await seed(body.notification.data.userId, OWNER, false)
    const assigned = await inOwner(() => admission.adoptEbayQuarantine(retained.quarantineId, first), 'a-owner')
    const before = await quarantine(retained.quarantineId)
    await expect(inOwner(() => admission.adoptEbayQuarantine(retained.quarantineId, second), 'a-owner')).rejects.toMatchObject({ reason: 'identity_conflict' })
    expect(await inOwner(() => admission.adoptEbayQuarantine(retained.quarantineId, first), 'a-owner')).toEqual(assigned)
    expect(await quarantine(retained.quarantineId)).toEqual(before)
    expect(await inOwner(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id: assigned.receiptId } }))).toMatchObject({ connectionId: first })
  })

  it('gives concurrent adoption requests for different accounts exactly one truthful success', async () => {
    const body = payload(), retained = await receive(body)
    if (retained.kind !== 'quarantined') throw new Error('Expected quarantine')
    const targets = [await seed(body.notification.data.userId, OWNER, false), await seed(body.notification.data.userId, OWNER, false)]
    const results = await Promise.allSettled(targets.map(id => inOwner(() => admission.adoptEbayQuarantine(retained.quarantineId, id), 'a-owner')))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const index = results.findIndex(result => result.status === 'fulfilled'), success = results[index]
    if (success.status !== 'fulfilled') throw new Error('Expected one adoption')
    const failure = results[1 - index]
    expect(failure).toMatchObject({ status: 'rejected', reason: { reason: 'identity_conflict' } })
    expect(await inOwner(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id: success.value.receiptId } })))
      .toMatchObject({ connectionId: targets[index] })
    expect((await quarantine(retained.quarantineId)).resolvedReceiptId).toBe(success.value.receiptId)
  })
})
