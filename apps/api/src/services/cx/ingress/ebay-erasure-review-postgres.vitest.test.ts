import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { readFileSync } from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { withWorkspace } from '../../../lib/workspace-context.js'
import { inDatabaseTransaction } from '../../../lib/database-context.js'
import { encryptCredentials } from '../../../lib/crypto.js'
import * as crypto from './ebay-quarantine-crypto.js'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
const h = vi.hoisted(() => ({ beforeCreate: undefined as (() => Promise<void>) | undefined, failNoticeForUser: null as string | null, failAudit: false }))
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => {
  if (key !== '$transaction') return (database.client as any)[key]
  return (work: (tx: any) => unknown, options: any) => database.client.$transaction(tx => work(new Proxy(tx, { get: (target, model) => {
    const delegate = (target as any)[model]
    if (model !== 'erasureRequest' && model !== 'notification' && model !== 'workspaceAudit') return delegate
    return new Proxy(delegate, { get: (object, method) => {
      if (model === 'workspaceAudit' && method === 'create') return async (args: any) => {
        const result = await object.create(args)
        if (h.failAudit) { h.failAudit = false; throw new Error('Synthetic audit failure') }
        return result
      }
      if (model === 'erasureRequest' && method === 'create') return async (args: any) => { await h.beforeCreate?.(); return object.create(args) }
      if (model === 'notification' && method === 'createMany') return async (args: any) => {
        const result = await object.createMany(args)
        if (h.failNoticeForUser && args.data.some((row: any) => row.userId === h.failNoticeForUser)) { h.failNoticeForUser = null; throw new Error('Synthetic notice insert failure') }
        return result
      }
      return object[method]
    } })
  } })), options)
} }) }))
vi.mock('./ebay-signature.js', () => ({ verifyEbayNotification: vi.fn(async () => ({ ok: true, reason: 'ok', kid: 'synthetic-key' })), ebayChallengeResponse: () => 'synthetic-challenge' }))
vi.mock('../../connection-resolver.service.js', () => ({ listActiveConnections: async () => [] }))
const { reviewEbayDeletion, reviewPendingEbayDeletions, decideEbayErasureRequest, expireEbayDeletionNotices } = await import('./ebay-erasure-review.js') as any
const { verifyEbayNotification } = await import('./ebay-signature.js')
const { receiveEbayNotice } = await import('./ebay-admission.js')
const lib = await import('../../../lib/crypto.js')
const Fastify = (await import('fastify')).default
const routes = (await import('../../../routes/ebay-notification.routes.js')).default
/** The real receiver over real admission: what eBay's HTTP delivery actually gets back. */
async function post(payload: unknown) {
  const app = Fastify()
  await app.register(routes as any)
  try { return await app.inject({ method: 'POST', url: '/webhooks/ebay-notification', headers: { 'content-type': 'application/json', 'x-ebay-signature': 'synthetic-signature' }, payload: JSON.stringify(payload) }) }
  finally { await app.close() }
}
const migration = readFileSync(new URL('../../../../../../packages/database/prisma/migrations/20260926t_cx_ebay_erasure_review/migration.sql', import.meta.url), 'utf8')
const q = (sql: string, values: unknown[] = []) => database.pool.query(sql, values)
const receive = (payload: unknown) => receiveEbayNotice({ rawBody: Buffer.from(JSON.stringify(payload)), header: 'synthetic-signature' })
const body = (username: string, notificationId = randomUUID()) => ({ metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION', schemaVersion: '1.0' },
  notification: { notificationId, eventDate: '2026-09-25T00:00:00Z', publishDate: '2026-09-25T00:00:01Z',
    data: { userId: `immutable-${username}`, username, eiasToken: `eias-${username}` } } })
let ownerRole = ''
async function profile(id = randomUUID()) {
  const owner = randomUUID(), membership = randomUUID()
  await q(`INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,'active','test',$1,now())`, [id])
  await q(`INSERT INTO "UserProfile" (id,email,"displayName",status,"updatedAt") VALUES ($1,$2,'Synthetic owner','active',now())`, [owner, `${owner}@test.invalid`])
  await q(`INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,'active',now())`, [membership, id, owner])
  await q('INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)', [membership, ownerRole])
  return { id, owner }
}
async function order(workspaceId: string, username: string | null, customerName = 'Different display name', environment = 'production', accountChannel = 'EBAY', account = randomUUID()) {
  const id = randomUUID()
  await q(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","managedBy","authStatus","isActive","connectionMetadata","updatedAt")
    VALUES ($1,$2,$5,$3,'oauth','connected',true,$4::jsonb,now())`, [account, workspaceId, `seller-${account}`, JSON.stringify({ environment }), accountChannel])
  await q(`INSERT INTO "Order" (id,"workspaceId",channel,"channelOrderId","channelConnectionId","customerName","customerEmail","shippingAddress","totalPrice","ebayMetadata","updatedAt")
    VALUES ($1,$2,'EBAY',$1,$3,$4,'buyer@test.invalid','{}'::jsonb,10,$5::jsonb,now())`, [id, workspaceId, account, customerName, JSON.stringify(username === null ? {} : { buyer: { username } })])
  return { id, account }
}
const notices = async (workspaceId: string) => (await q('SELECT * FROM "Notification" WHERE "workspaceId"=$1 AND type=\'channel-privacy-review\'', [workspaceId])).rows

const requests = async (workspaceId: string) => (await q('SELECT * FROM "ErasureRequest" WHERE "workspaceId"=$1', [workspaceId])).rows
const reviewState = async (id: string) => (await q(`SELECT "reviewAttempts","reviewedAt","reviewOutcome",("reviewNextAt" IS NULL OR "reviewNextAt" <= (clock_timestamp() AT TIME ZONE 'UTC')) AS due
  FROM "EbayNoticeQuarantine" WHERE id=$1`, [id])).rows[0]
/** eBay's delivery, then the retry worker's later review of what was stored. */
async function receiveAndReview(payload: unknown) {
  const outcome = await receive(payload)
  await reviewPendingEbayDeletions()
  return outcome
}
const makeDue = (id: string) => q(`UPDATE "EbayNoticeQuarantine" SET "reviewNextAt"=(clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE id=$1`, [id])
const context = (workspaceId: string, actorUserId: string | null = null, apiKeyId?: string) => ({ workspaceId, actorUserId, membershipId: null, roleKeys: [], ...(apiKeyId ? { apiKeyId } : {}) })
async function retained(payload: ReturnType<typeof body>) {
  const outcome = await receive(payload)
  if (outcome.kind !== 'quarantined') throw new Error('Expected retained notice')
  expect((await q('SELECT count(*)::int AS n FROM "ErasureRequest" WHERE "quarantineId"=$1', [outcome.quarantineId])).rows[0].n).toBe(0)
  return outcome.quarantineId
}

const premigration = (client: Pick<PoolClient, 'query'>) => client.query(`DROP TABLE "ErasureRequest"; ALTER TABLE "EbayNoticeQuarantine"
  DROP COLUMN "reviewAttempts", DROP COLUMN "reviewNextAt", DROP COLUMN "reviewedAt", DROP COLUMN "reviewOutcome"`)
async function waiters(n: number) {
  const until = Date.now() + 5_000
  while (Date.now() < until) {
    if ((await q("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n >= n) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}
async function asRuntime<T>(workspaceId: string, actorUserId: string | null, work: (client: PoolClient) => Promise<T>, commit = false) {
  const client = await database.pool.connect()
  let done = false
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE nexus_workspace_runtime')
    await client.query("SELECT set_config('nexus.workspace_id',$1,true),set_config('nexus.actor_id',$2,true)", [workspaceId, actorUserId ?? ''])
    const result = await work(client)
    if (commit) { await client.query('COMMIT'); done = true }
    return result
  } finally { if (!done) await client.query('ROLLBACK'); client.release() }
}
/** An active person in the business holding a real role that is not OWNER. */
async function member(workspaceId: string) {
  const user = randomUUID(), membership = randomUUID()
  await q(`INSERT INTO "Role" (id,key,name,permissions,"updatedAt") VALUES ('privacy-staff-role','STAFF','Staff',ARRAY[]::text[],now()) ON CONFLICT DO NOTHING`)
  const role = (await q(`SELECT id FROM "Role" WHERE key='STAFF'`)).rows[0].id
  await q(`INSERT INTO "UserProfile" (id,email,"displayName",status,"updatedAt") VALUES ($1,$2,'Synthetic member','active',now())`, [user, `${user}@test.invalid`])
  await q(`INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,'active',now())`, [membership, workspaceId, user])
  await q('INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)', [membership, role])
  return user
}
/** A reviewed candidate: order, stored notice and its undecided request. */
async function candidate(a: { id: string }) {
  const subject = `candidate-${randomUUID()}`, source = await order(a.id, subject), id = await retained(body(subject))
  await reviewEbayDeletion(id)
  const [request] = await requests(a.id)
  return { id, source, request }
}
/** Only the retention layer is switched off, inside one transaction; the request guard stays on. */
async function withoutNoticeRetention<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await database.pool.connect()
  try {
    await client.query('BEGIN'); await client.query('ALTER TABLE "EbayNoticeQuarantine" DISABLE TRIGGER nexus_retain_inbound_history')
    const result = await work(client)
    await client.query('ALTER TABLE "EbayNoticeQuarantine" ENABLE TRIGGER nexus_retain_inbound_history'); await client.query('COMMIT')
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
const ageReview = (id: string, days: number, outcome?: string) => q(`UPDATE "EbayNoticeQuarantine" SET "reviewedAt"=(clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => $2::int)
  ${outcome ? ',"reviewOutcome"=$3' : ''} WHERE id=$1`, outcome ? [id, days, outcome] : [id, days])
const stored = async (id: string) => (await q('SELECT count(*)::int AS n FROM "EbayNoticeQuarantine" WHERE id=$1', [id])).rows[0].n === 1
/** A stored notice the worker reviewed and found nothing for, reviewed `days` ago. */
async function unmatched(days: number) {
  const id = await retained(body(`expiry-${randomUUID()}`))
  await reviewPendingEbayDeletions()
  expect(await reviewState(id)).toMatchObject({ reviewOutcome: 'unmatched' })
  await ageReview(id, days)
  return id
}
/** A verified deletion row inserted directly, reviewed as unmatched `days` ago (bulk fixtures). */
async function syntheticReviewed(days: number) {
  const id = randomUUID()
  await q(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"signatureOk","externalId",topic,"payloadEnc","payloadKeyId","payloadDigest",reason,"reviewAttempts","reviewedAt","reviewOutcome")
    VALUES ($1,'production',true,$1,'MARKETPLACE_ACCOUNT_DELETION','v1:synthetic','env',$2,'account_deletion_review_required',1,(clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => $3::int),'unmatched')`,
    [id, createHash('sha256').update(id).digest('hex'), days])
  return id
}
/** The restricted writer role itself, inside one rolled-back transaction: isolates the database layers. */
async function asWriter<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await database.pool.connect()
  try {
    await client.query('BEGIN'); await client.query('GRANT nexus_ebay_quarantine_writer TO CURRENT_USER WITH SET TRUE')
    await client.query('SET LOCAL ROLE nexus_ebay_quarantine_writer')
    return await work(client)
  } finally { await client.query('ROLLBACK'); client.release() }
}
const setStatus = (workspaceId: string, actor: string | null, requestId: string, status: string) =>
  asRuntime(workspaceId, actor, client => client.query('UPDATE "ErasureRequest" SET status=$2 WHERE id=$1', [requestId, status]), true)
async function insertRequest(workspaceId: string, quarantineId: string, orderId: string, fields: Record<string, unknown> = {}, client: Pick<PoolClient, 'query'> = database.pool) {
  const values = { channel: 'EBAY', environment: 'production', matchBasis: 'username', status: 'REVIEW_REQUIRED', decidedAt: null, ...fields }
  return client.query(`INSERT INTO "ErasureRequest" (id,"workspaceId","quarantineId","evidenceOrderId",channel,environment,"matchBasis",status,"decidedAt")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), workspaceId, quarantineId, orderId, values.channel, values.environment, values.matchBasis, values.status, values.decidedAt])
}

async function syntheticRetained(payload: ReturnType<typeof body>, patch: Record<string, unknown> = {}) {
  const raw = Buffer.from(JSON.stringify(payload)), id = randomUUID()
  const binding = { environment: 'production', signatureOk: true, externalId: payload.notification.notificationId,
    topic: 'MARKETPLACE_ACCOUNT_DELETION', subjectHash: null, payloadDigest: createHash('sha256').update(raw).digest('hex'), ...patch }
  const sealed = await encryptCredentials({ version: 1, binding, rawBody: raw.toString('base64'), header: 'synthetic-signature' })
  await q(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"signatureOk","externalId",topic,"payloadEnc","payloadKeyId","payloadDigest",reason)
    VALUES ($1,$2,true,$3,$4,$5,$6,$7,'account_deletion_review_required')`, [id,binding.environment,binding.externalId,binding.topic,sealed.blob,sealed.keyId,binding.payloadDigest])
  return id
}

describe.skipIf(!concurrentDatabaseUrl())('non-executable eBay erasure review candidates in PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64')); vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No live calls allowed') }))
    database = await concurrentDatabase({ maxConnections: 12 })
    await premigration(database.pool)
    await q(migration)
    await q(`INSERT INTO "Role" (id,key,name,permissions,"updatedAt") VALUES ('privacy-owner-role','OWNER','Owner',ARRAY[]::text[],now()) ON CONFLICT (key) DO NOTHING`)
    ownerRole = (await q('SELECT id FROM "Role" WHERE key=\'OWNER\'')).rows[0].id
  }, 180_000)
  beforeEach(() => vi.stubEnv('NEXUS_ENABLE_EBAY_PRIVACY_REVIEW', '1'))
  afterEach(async () => {
    h.beforeCreate = undefined; h.failNoticeForUser = null; h.failAudit = false; vi.restoreAllMocks()
    await q(`UPDATE "Workspace" SET status='paused' WHERE status='active' AND id <> 'nexus_legacy_workspace'`)
    await q(`UPDATE "EbayNoticeQuarantine" SET "reviewedAt"=(clock_timestamp() AT TIME ZONE 'UTC'),"reviewOutcome"='unmatched',"reviewNextAt"=NULL
      WHERE "signatureOk" AND topic='MARKETPLACE_ACCOUNT_DELETION' AND ("reviewedAt" IS NULL OR "reviewedAt" < (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 day')`)
  })
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals() }, 60_000)

  it('registers a workspace-scoped ErasureRequest model', async () => {
    expect((await q(`SELECT to_regclass('public."ErasureRequest"') IS NOT NULL AS present`)).rows[0].present).toBe(true)
  })

  it('stores and acknowledges a deletion notice without running the privacy review in the request', async () => {
    const a = await profile(), subject = `ack-${randomUUID()}`
    await order(a.id, subject)
    const open = vi.spyOn(crypto, 'openEbayQuarantineBody')
    await expect(receive(body(subject))).resolves.toMatchObject({ kind: 'quarantined', reason: 'account_deletion_review_required' })
    expect(open).not.toHaveBeenCalled()
    expect(await requests(a.id)).toEqual([]); expect(await notices(a.id)).toEqual([])
  })

  it.each(['review-failure', 'storage-failure'])('tells eBay 2xx once the notice is durable and 503 only before storage: %s', async failure => {
    const a = await profile(), subject = `http-${randomUUID()}`, payload = body(subject)
    await order(a.id, subject)
    if (failure === 'review-failure') h.failNoticeForUser = a.owner
    else vi.spyOn(lib, 'encryptCredentials').mockRejectedValueOnce(new Error('synthetic key failure'))
    const response = await post(payload)
    const stored = (await q('SELECT count(*)::int AS n FROM "EbayNoticeQuarantine" WHERE "externalId"=$1', [payload.notification.notificationId])).rows[0].n
    if (failure === 'review-failure') { expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ received: true }); expect(stored).toBe(1) }
    else { expect(response.statusCode).toBe(503); expect(stored).toBe(0) }
  })

  it('reviews stored notices later in the retry worker, backs off after a failure and finishes once', async () => {
    const a = await profile(), subject = `later-${randomUUID()}`
    await order(a.id, subject); const id = await retained(body(subject))
    h.failNoticeForUser = a.owner
    await expect(reviewPendingEbayDeletions()).resolves.toMatchObject({ kind: 'reviewed', claimed: 1, failed: 1 })
    expect(await reviewState(id)).toMatchObject({ reviewAttempts: 1, reviewedAt: null, reviewOutcome: null, due: false })
    expect(await requests(a.id)).toEqual([])
    await expect(reviewPendingEbayDeletions()).resolves.toMatchObject({ claimed: 0 })
    await makeDue(id)
    await expect(reviewPendingEbayDeletions()).resolves.toMatchObject({ claimed: 1, reviewed: 1, failed: 0 })
    const done = await reviewState(id)
    expect(done).toMatchObject({ reviewAttempts: 2, reviewOutcome: 'matched' }); expect(done.reviewedAt).not.toBeNull()
    expect(await requests(a.id)).toHaveLength(1); expect(await notices(a.id)).toHaveLength(1)
    await makeDue(id)
    await expect(reviewPendingEbayDeletions()).resolves.toMatchObject({ claimed: 0 })
  })

  it('claims each stored notice once when retry-worker ticks overlap', async () => {
    const a = await profile(), subject = `overlap-${randomUUID()}`
    await order(a.id, subject); const id = await retained(body(subject))
    let reached!: () => void, release!: () => void
    const paused = new Promise<void>(resolve => { reached = resolve }), resume = new Promise<void>(resolve => { release = resolve })
    h.beforeCreate = async () => { reached(); await resume }
    const first = reviewPendingEbayDeletions()
    expect(await Promise.race([paused.then(() => 'paused'), first.then(() => 'settled', () => 'settled')])).toBe('paused')
    // A second tick must return at once with nothing claimed, not queue behind the first review.
    const second = reviewPendingEbayDeletions()
    let early: unknown
    try { early = await Promise.race([second, new Promise(resolve => setTimeout(() => resolve('still waiting'), 3_000))]) }
    finally { release() }
    expect(early).toMatchObject({ kind: 'reviewed', claimed: 0 })
    await expect(first).resolves.toMatchObject({ claimed: 1, reviewed: 1 })
    await second
    expect(await reviewState(id)).toMatchObject({ reviewAttempts: 1, reviewOutcome: 'matched' })
    expect(await requests(a.id)).toHaveLength(1); expect(await notices(a.id)).toHaveLength(1)
  })

  it('lets exactly one of two ticks that saw the same due notice claim it', async () => {
    const a = await profile(), subject = `claim-race-${randomUUID()}`
    await order(a.id, subject); const id = await retained(body(subject))
    const blocker = await database.pool.connect()
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM "EbayNoticeQuarantine" WHERE id=$1 FOR UPDATE', [id])
    const both = Promise.all([reviewPendingEbayDeletions(), reviewPendingEbayDeletions()])
    let waited = false
    try { waited = await waiters(2) } finally { await blocker.query('COMMIT'); blocker.release() }
    const results = await both
    expect(waited).toBe(true)
    expect(results.map((result: any) => result.claimed).sort()).toEqual([0, 1])
    expect(await reviewState(id)).toMatchObject({ reviewAttempts: 1, reviewOutcome: 'matched' })
    expect(await requests(a.id)).toHaveLength(1)
  })

  it('never claims unverified, other-topic or handed-off notices', async () => {
    const a = await profile(), unverified: any = body(`sweep-unverified-${randomUUID()}`), other: any = body(`sweep-topic-${randomUUID()}`), handed = body(`sweep-handed-${randomUUID()}`)
    vi.mocked(verifyEbayNotification).mockResolvedValueOnce({ ok: false, reason: 'signature_mismatch', kid: 'synthetic-key' } as any)
    const rejected = await receive(unverified)
    other.metadata.topic = 'FUTURE_TOPIC'
    const future = await receive(other)
    const id = await retained(handed), receiptId = randomUUID()
    await q(`INSERT INTO "WebhookEvent" (id,"workspaceId",channel,"externalId","eventType",payload,"signatureOk","verifiedBy","updatedAt")
      VALUES ($1,$2,'EBAY',$3,'MARKETPLACE_ACCOUNT_DELETION',$4::jsonb,true,'ebay_ecdsa',now())`, [receiptId,a.id,`ebay:production:${handed.notification.notificationId}`,JSON.stringify(handed)])
    await q('UPDATE "EbayNoticeQuarantine" SET "resolvedReceiptId"=$2,"resolvedWorkspaceId"=$3,"resolvedAt"=now() WHERE id=$1', [id,receiptId,a.id])
    // A deletion row with the topic claimed but no signature exists only as rejected metadata.
    await q(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"signatureOk","externalId",topic,"payloadDigest",reason) VALUES ($1,'production',false,$1,'MARKETPLACE_ACCOUNT_DELETION',$2,'signature_mismatch')`, [randomUUID(), 'd'.repeat(64)])
    await expect(reviewPendingEbayDeletions()).resolves.toEqual({ kind: 'reviewed', claimed: 0, reviewed: 0, unsupported: 0, failed: 0 })
    for (const row of [rejected, future]) if (row.kind !== 'accepted') expect(await reviewState(row.quarantineId)).toMatchObject({ reviewAttempts: 0 })
    expect(await reviewState(id)).toMatchObject({ reviewAttempts: 0 })
  })

  it('bounds one tick to ten notices and reviews the rest on the next tick', async () => {
    const ids = [] as string[]
    for (let i = 0; i < 11; i++) ids.push(await retained(body(`batch-${randomUUID()}`)))
    await expect(reviewPendingEbayDeletions(50)).resolves.toMatchObject({ claimed: 10, reviewed: 10 })
    await expect(reviewPendingEbayDeletions()).resolves.toMatchObject({ claimed: 1, reviewed: 1 })
    for (const id of ids) expect(await reviewState(id)).toMatchObject({ reviewAttempts: 1, reviewOutcome: 'unmatched' })
  })

  it('keeps unreadable subject data unfinished and rechecks it daily instead of dropping it', async () => {
    const payload: any = body(`unsupported-${randomUUID()}`)
    payload.metadata.schemaVersion = '2.0'
    const id = await retained(payload)
    await expect(reviewPendingEbayDeletions()).resolves.toMatchObject({ claimed: 1, unsupported: 1 })
    expect(await reviewState(id)).toMatchObject({ reviewAttempts: 1, reviewedAt: null, reviewOutcome: 'unsupported', due: false })
    const next = (await q(`SELECT extract(epoch FROM "reviewNextAt" - (clock_timestamp() AT TIME ZONE 'UTC'))::int AS s FROM "EbayNoticeQuarantine" WHERE id=$1`, [id])).rows[0].s
    expect(next).toBeGreaterThan(86_300); expect(next).toBeLessThanOrEqual(86_400)
    await makeDue(id)
    await expect(reviewPendingEbayDeletions()).resolves.toMatchObject({ claimed: 1, unsupported: 1 })
  })

  it('backs off a failing review from one minute, doubling', async () => {
    const a = await profile(), subject = `backoff-${randomUUID()}`
    await order(a.id, subject); const id = await retained(body(subject))
    const seconds = async () => (await q(`SELECT extract(epoch FROM "reviewNextAt" - (clock_timestamp() AT TIME ZONE 'UTC'))::int AS s FROM "EbayNoticeQuarantine" WHERE id=$1`, [id])).rows[0].s
    for (const expected of [60, 120, 240]) {
      h.failNoticeForUser = a.owner
      await expect(reviewPendingEbayDeletions()).resolves.toMatchObject({ claimed: 1, failed: 1 })
      const wait = await seconds()
      expect(wait).toBeGreaterThan(expected - 10); expect(wait).toBeLessThanOrEqual(expected)
      await makeDue(id)
    }
    expect(await reviewState(id)).toMatchObject({ reviewAttempts: 3, reviewedAt: null })
  })

  it.each(['user', 'api-key'])('refuses direct %s authority for the retry-worker sweep before any claim', async authority => {
    const a = await profile(), id = await retained(body(`sweep-authority-${randomUUID()}`))
    await expect(withWorkspace(context(a.id, authority === 'user' ? a.owner : null, authority === 'api-key' ? 'synthetic-key' : undefined), () => reviewPendingEbayDeletions()))
      .rejects.toMatchObject({ code: 'authority_denied' })
    expect(await reviewState(id)).toMatchObject({ reviewAttempts: 0, due: true })
  })

  it.each([
    ['review state on another topic', `UPDATE "EbayNoticeQuarantine" SET "reviewAttempts"=1 WHERE id=$1`, 'revocation'],
    ['an unknown outcome', `UPDATE "EbayNoticeQuarantine" SET "reviewOutcome"='erased',"reviewedAt"=now() WHERE id=$1`, 'deletion'],
    ['a finished review without an outcome', `UPDATE "EbayNoticeQuarantine" SET "reviewedAt"=now() WHERE id=$1`, 'deletion'],
    ['an outcome without a finished review', `UPDATE "EbayNoticeQuarantine" SET "reviewOutcome"='unmatched' WHERE id=$1`, 'deletion'],
    ['an unsupported notice marked finished', `UPDATE "EbayNoticeQuarantine" SET "reviewOutcome"='unsupported',"reviewedAt"=now() WHERE id=$1`, 'deletion'],
  ])('the database refuses %s', async (_name, sql, topic) => {
    const payload: any = body(`state-check-${randomUUID()}`)
    if (topic === 'revocation') payload.metadata.topic = 'AUTHORIZATION_REVOCATION'
    const saved = await receive(payload)
    if (saved.kind === 'accepted') throw new Error('Expected retained metadata')
    await expect(q(sql, [saved.quarantineId])).rejects.toMatchObject({ code: '23514' })
  })

  it('records generic owner notices only for exact retained buyer-username candidates in the same environment', async () => {
    const subject = `buyer-${randomUUID()}`, a = await profile(), b = await profile(), c = await profile(), wrongEnvironment = await profile()
    await order(a.id, subject); await order(c.id, subject)
    await order(b.id, null, subject); await order(wrongEnvironment.id, subject, 'Different display name', 'sandbox')
    const payload = body(subject)
    await expect(receiveAndReview(payload)).resolves.toMatchObject({ kind: 'quarantined' })
    expect(await notices(a.id)).toHaveLength(1); expect(await notices(c.id)).toHaveLength(1)
    expect(await notices(b.id)).toEqual([]); expect(await notices(wrongEnvironment.id)).toEqual([])
    const text = JSON.stringify([await notices(a.id), await notices(c.id)])
    for (const value of Object.values(payload.notification.data)) expect(text).not.toContain(value)
  })

  it('matches the immutable user ID that eBay puts in the buyer username field, and records that rule', async () => {
    const a = await profile(), payload = body(`us-${randomUUID()}`)
    const source = await order(a.id, payload.notification.data.userId)
    await receiveAndReview(payload)
    expect(await requests(a.id)).toMatchObject([{ evidenceOrderId: source.id, matchBasis: 'user_id' }])
  })

  it('matches by the immutable user ID alone when the notice carries no username', async () => {
    const a = await profile(), payload: any = body(`id-only-${randomUUID()}`)
    delete payload.notification.data.username
    const source = await order(a.id, payload.notification.data.userId)
    await receiveAndReview(payload)
    expect(await requests(a.id)).toMatchObject([{ evidenceOrderId: source.id, matchBasis: 'user_id' }])
  })

  it('falls back to the username and records that rule', async () => {
    const a = await profile(), subject = `name-${randomUUID()}`, source = await order(a.id, subject)
    await receiveAndReview(body(subject))
    expect(await requests(a.id)).toMatchObject([{ evidenceOrderId: source.id, matchBasis: 'username' }])
  })

  it('prefers an immutable-ID match over a username match in the same business, whatever the account order', async () => {
    const a = await profile(), subject = `both-${randomUUID()}`, payload = body(subject), tail = randomUUID().slice(8)
    await order(a.id, subject, 'Different display name', 'production', 'EBAY', `00000000${tail}`)
    const byId = await order(a.id, payload.notification.data.userId, 'Different display name', 'production', 'EBAY', `ffffffff${tail}`)
    await receiveAndReview(payload)
    expect(await requests(a.id)).toMatchObject([{ evidenceOrderId: byId.id, matchBasis: 'user_id' }])
  })

  it('keeps the whole notice unreadable when a present identifier is malformed, even if another would match', async () => {
    const a = await profile(), payload: any = body(`malformed-name-${randomUUID()}`)
    payload.notification.data.username = ' spaced'
    await order(a.id, payload.notification.data.userId)
    const saved = await receiveAndReview(payload)
    if (saved.kind !== 'quarantined') throw new Error('Expected retained notice')
    expect(await reviewState(saved.quarantineId)).toMatchObject({ reviewOutcome: 'unsupported' })
    expect(await requests(a.id)).toEqual([])
  })

  it('keeps a notice with neither identifier unreadable and unmatched', async () => {
    const a = await profile(), subject = `anonymous-${randomUUID()}`, payload: any = body(subject)
    await order(a.id, subject); await order(a.id, payload.notification.data.userId)
    delete payload.notification.data.username; delete payload.notification.data.userId
    const saved = await receiveAndReview(payload)
    if (saved.kind !== 'quarantined') throw new Error('Expected retained notice')
    expect(await reviewState(saved.quarantineId)).toMatchObject({ reviewOutcome: 'unsupported', reviewedAt: null })
    expect(await requests(a.id)).toEqual([])
  })

  it('uses the first retained verified body when a duplicate delivery changes the subject', async () => {
    const firstSubject = `first-${randomUUID()}`, otherSubject = `second-${randomUUID()}`, a = await profile(), b = await profile()
    await order(a.id, firstSubject); await order(b.id, otherSubject)
    const first = body(firstSubject)
    await receive(first)
    await receiveAndReview(body(otherSubject, first.notification.notificationId))
    expect(await notices(a.id)).toHaveLength(1)
    expect(await notices(b.id)).toEqual([])
  })

  it.each([undefined, '', '0', 'true'])('defaults to no processing for switch=%s, before decryption or candidate writes', async value => {
    const a = await profile(), subject = `off-${randomUUID()}`
    await order(a.id, subject)
    vi.stubEnv('NEXUS_ENABLE_EBAY_PRIVACY_REVIEW', value)
    const open = vi.spyOn(crypto, 'openEbayQuarantineBody')
    await expect(receive(body(subject))).resolves.toMatchObject({ kind: 'quarantined' })
    await expect(reviewPendingEbayDeletions()).resolves.toEqual({ kind: 'held', reason: 'processing_disabled' })
    expect(open).not.toHaveBeenCalled()
    expect(await requests(a.id)).toEqual([]); expect(await notices(a.id)).toEqual([])
  })

  it.each(['user', 'api-key'])('refuses direct %s authority before reading the retained body', async authority => {
    const a = await profile(), subject = `authority-${randomUUID()}`
    await order(a.id, subject)
    const id = await retained(body(subject)), open = vi.spyOn(crypto, 'openEbayQuarantineBody')
    await expect(withWorkspace(context(a.id, authority === 'user' ? a.owner : null, authority === 'api-key' ? 'synthetic-key' : undefined), () => reviewEbayDeletion(id)))
      .rejects.toMatchObject({ code: 'authority_denied' })
    expect(open).not.toHaveBeenCalled(); expect(await requests(a.id)).toEqual([])
  })

  it('refuses an ambient domain transaction before decrypting or changing business context', async () => {
    const a = await profile(), id = await retained(body(`nested-${randomUUID()}`))
    const open = vi.spyOn(crypto, 'openEbayQuarantineBody')
    await expect(withWorkspace(context(a.id), () => inDatabaseTransaction(database.client, () => reviewEbayDeletion(id))))
      .rejects.toMatchObject({ code: 'authority_denied' })
    expect(open).not.toHaveBeenCalled(); expect(await requests(a.id)).toEqual([])
  })

  it.each(['unverified', 'other-topic'])('does not decrypt or process an %s retained notice', async kind => {
    const payload = body(`unsupported-${randomUUID()}`)
    if (kind === 'unverified') vi.mocked(verifyEbayNotification).mockResolvedValueOnce({ ok: false, reason: 'signature_mismatch', kid: 'synthetic-key' })
    else payload.metadata.topic = 'FUTURE_TOPIC'
    const saved = await receive(payload)
    if (saved.kind === 'accepted') throw new Error('Expected retained metadata')
    const open = vi.spyOn(crypto, 'openEbayQuarantineBody')
    await expect(reviewEbayDeletion(saved.quarantineId)).resolves.toMatchObject({ kind: 'held', reason: 'notice_unavailable' })
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['schema', 'missing-username', 'blank-username', 'spaced-username', 'bad-user-id', 'bad-eias-token'])('retains unsupported %s subject data without inferring another identifier', async defect => {
    const a = await profile(), subject = `malformed-${randomUUID()}`
    await order(a.id, subject)
    const payload: any = body(subject)
    if (defect === 'schema') payload.metadata.schemaVersion = '2.0'
    if (defect === 'missing-username') delete payload.notification.data.username
    if (defect === 'blank-username') payload.notification.data.username = ''
    if (defect === 'spaced-username') {
      payload.notification.data.username = ` ${subject}`
      await q('UPDATE "Order" SET "ebayMetadata"=$2::jsonb WHERE "workspaceId"=$1', [a.id, JSON.stringify({ buyer: { username: payload.notification.data.username } })])
    }
    if (defect === 'bad-user-id') payload.notification.data.userId = {}
    if (defect === 'bad-eias-token') payload.notification.data.eiasToken = []
    await expect(receiveAndReview(payload)).resolves.toMatchObject({ kind: 'quarantined' })
    expect(await requests(a.id)).toEqual([]); expect(await notices(a.id)).toEqual([])
  })

  it.each(['case', 'whitespace', 'numeric', 'no-account', 'wrong-channel', 'account-channel', 'legacy-account', 'missing-seller', 'bad-seller', 'implicit-environment', 'seller-only'])('does not guess a candidate from %s evidence', async defect => {
    const a = await profile(), subject = defect === 'numeric' ? '123' : `exact-${randomUUID()}`
    const source = await order(a.id, subject, 'Different display name', 'production', defect === 'account-channel' ? 'SHOPIFY' : 'EBAY')
    if (defect === 'case' || defect === 'whitespace' || defect === 'numeric' || defect === 'seller-only') {
      const username = defect === 'case' ? subject.toUpperCase() : defect === 'whitespace' ? `${subject} ` : defect === 'numeric' ? 123 : 'someone-else'
      await q('UPDATE "Order" SET "ebayMetadata"=$2::jsonb WHERE id=$1', [source.id, JSON.stringify({ buyer: { username } })])
    }
    if (defect === 'no-account') await q('UPDATE "Order" SET "channelConnectionId"=NULL WHERE id=$1', [source.id])
    if (defect === 'wrong-channel') await q(`UPDATE "Order" SET channel='SHOPIFY' WHERE id=$1`, [source.id])
    if (defect === 'legacy-account') await q(`UPDATE "ChannelConnection" SET "managedBy"='legacy' WHERE id=$1`, [source.account])
    if (defect === 'missing-seller') await q('UPDATE "ChannelConnection" SET "externalAccountId"=NULL WHERE id=$1', [source.account])
    if (defect === 'bad-seller') await q('UPDATE "ChannelConnection" SET "externalAccountId"=$2 WHERE id=$1', [source.account, ' malformed '])
    if (defect === 'implicit-environment') await q(`UPDATE "ChannelConnection" SET "connectionMetadata"='{}' WHERE id=$1`, [source.account])
    const payload = body(subject)
    if (defect === 'seller-only') await q('UPDATE "ChannelConnection" SET "externalAccountId"=$2 WHERE id=$1', [source.account, payload.notification.data.userId])
    await expect(receiveAndReview(payload)).resolves.toMatchObject({ kind: 'quarantined' })
    expect(await requests(a.id)).toEqual([]); expect(await notices(a.id)).toEqual([])
  })

  it('can flag retained data from an inactive account whose identity and explicit environment remain known', async () => {
    const a = await profile(), subject = `historical-${randomUUID()}`, source = await order(a.id, subject)
    await q(`UPDATE "ChannelConnection" SET "isActive"=false,"authStatus"='revoked' WHERE id=$1`, [source.account])
    await receiveAndReview(body(subject))
    expect(await requests(a.id)).toHaveLength(1); expect(await notices(a.id)).toHaveLength(1)
  })

  it('records only non-executable metadata and leaves retained proof, order and money unchanged', async () => {
    const a = await profile(), subject = `minimal-${randomUUID()}`, source = await order(a.id, subject)
    await q(`INSERT INTO "FinancialTransaction" (id,"workspaceId","orderId","transactionType","transactionDate",amount,"grossRevenue","netRevenue",status,"updatedAt")
      VALUES ($1,$2,$3,'Order',now(),10,10,10,'Completed',now())`, [randomUUID(), a.id, source.id])
    const payload = body(subject), id = await retained(payload)
    const snapshot = async () => Promise.all([
      q('SELECT to_jsonb(o) AS row FROM "Order" o WHERE id=$1', [source.id]),
      q('SELECT to_jsonb(f) AS row FROM "FinancialTransaction" f WHERE "orderId"=$1', [source.id]),
      q('SELECT to_jsonb(q) AS row FROM "EbayNoticeQuarantine" q WHERE id=$1', [id]),
    ]).then(results => results.map(result => result.rows))
    const before = await snapshot()
    await reviewEbayDeletion(id)
    expect(await snapshot()).toEqual(before)
    const [request] = await requests(a.id)
    expect(request).toMatchObject({ workspaceId: a.id, quarantineId: id, evidenceOrderId: source.id, channel: 'EBAY', environment: 'production', matchBasis: 'username', status: 'REVIEW_REQUIRED', decidedAt: null })
    const text = JSON.stringify([request, await notices(a.id)])
    for (const value of Object.values(payload.notification.data)) expect(text).not.toContain(value)
    expect(Object.keys(request).sort()).toEqual(['id','workspaceId','quarantineId','evidenceOrderId','channel','environment','matchBasis','status','createdAt','decidedAt'].sort())
  })


  it('uses the actual additive migration and bounds its wait behind a parent-table writer', async () => {
    const reader = await database.pool.connect(), applier = await database.pool.connect()
    // Rebuild the new table before holding its parent's conflicting write lock.
    await premigration(applier)
    await reader.query('BEGIN'); await reader.query('LOCK TABLE "Order" IN ROW EXCLUSIVE MODE')
    const applying = applier.query(migration).then(() => 'applied', error => error)
    let outcome: unknown
    try { outcome = await Promise.race([applying, new Promise(resolve => setTimeout(() => resolve('still waiting'), 9_000))]) }
    finally {
      await reader.query('ROLLBACK'); reader.release()
      await applying; await applier.query('ROLLBACK')
      if (!(await applier.query(`SELECT to_regclass('public."ErasureRequest"') IS NOT NULL AS present`)).rows[0].present) await applier.query(migration)
      applier.release()
    }
    expect(outcome).toMatchObject({ code: '55P03' })
  }, 20_000)

  it.each(['HELD', 'DISMISSED'])('lets an active owner move an undecided candidate to %s and stamps the decision in the database', async status => {
    const a = await profile(), { request } = await candidate(a)
    await expect(setStatus(a.id, a.owner, request.id, status)).resolves.toMatchObject({ rowCount: 1 })
    const [after] = await requests(a.id)
    expect(after).toMatchObject({ id: request.id, status, quarantineId: request.quarantineId, evidenceOrderId: request.evidenceOrderId })
    expect(after.decidedAt).toBeInstanceOf(Date)
  })

  it.each([
    ['a member without the owner role', 'member', 'DISMISSED', '42501'],
    ['a system writer deciding for the owner', 'system', 'HELD', '42501'],
    ['completion without the executor', 'owner', 'COMPLETED', '23514'],
    ['an unknown status', 'owner', 'ERASED', '23514'],
  ])('the database refuses %s', async (_name, who, status, code) => {
    const a = await profile(), { request } = await candidate(a)
    const actor = who === 'owner' ? a.owner : who === 'member' ? await member(a.id) : null
    await expect(setStatus(a.id, actor, request.id, status)).rejects.toMatchObject({ code })
    expect(await requests(a.id)).toMatchObject([{ status: 'REVIEW_REQUIRED', decidedAt: null }])
  })

  it('another business cannot see or decide a request', async () => {
    const a = await profile(), b = await profile(), { request } = await candidate(a)
    await expect(setStatus(b.id, b.owner, request.id, 'DISMISSED')).resolves.toMatchObject({ rowCount: 0 })
    expect(await requests(a.id)).toMatchObject([{ status: 'REVIEW_REQUIRED' }])
  })

  it('lets only the system executor complete a held request, and nothing moves a done request', async () => {
    const a = await profile(), { request } = await candidate(a)
    await setStatus(a.id, a.owner, request.id, 'HELD')
    await expect(setStatus(a.id, a.owner, request.id, 'COMPLETED')).rejects.toMatchObject({ code: '42501' })
    await expect(setStatus(a.id, a.owner, request.id, 'DISMISSED')).rejects.toMatchObject({ code: '23514' })
    await expect(setStatus(a.id, null, request.id, 'COMPLETED')).resolves.toMatchObject({ rowCount: 1 })
    for (const [actor, status] of [[null, 'HELD'], [a.owner, 'DISMISSED'], [null, 'REVIEW_REQUIRED']] as const)
      await expect(setStatus(a.id, actor, request.id, status)).rejects.toMatchObject({ code: '23514' })
    expect(await requests(a.id)).toMatchObject([{ status: 'COMPLETED' }])
  })

  it('lets the runtime change only the status column, never the decision time or evidence pointers', async () => {
    const a = await profile(), { request } = await candidate(a)
    for (const change of ['"decidedAt"=now()', '"evidenceOrderId"=NULL', '"quarantineId"=NULL', '"matchBasis"=\'user_id\''])
      await expect(asRuntime(a.id, a.owner, client => client.query(`UPDATE "ErasureRequest" SET ${change} WHERE id=$1`, [request.id]))).rejects.toMatchObject({ code: '42501' })
  })

  it.each(['REVIEW_REQUIRED', 'HELD'])('an open %s request keeps its order and notice, even against the table owner', async status => {
    const a = await profile(), { id, source, request } = await candidate(a)
    if (status === 'HELD') await setStatus(a.id, a.owner, request.id, 'HELD')
    await expect(q('DELETE FROM "Order" WHERE id=$1', [source.id])).rejects.toMatchObject({ code: '23503', message: 'An open erasure request keeps its notice and order evidence' })
    await expect(withoutNoticeRetention(client => client.query('DELETE FROM "EbayNoticeQuarantine" WHERE id=$1', [id])))
      .rejects.toMatchObject({ code: '23503', message: 'An open erasure request keeps its notice and order evidence' })
    expect(await requests(a.id)).toMatchObject([{ quarantineId: id, evidenceOrderId: source.id }])
  })

  it.each(['DISMISSED', 'COMPLETED'])('a done %s request releases its order and notice and stays as the record', async status => {
    const a = await profile(), { id, source, request } = await candidate(a)
    if (status === 'DISMISSED') await setStatus(a.id, a.owner, request.id, 'DISMISSED')
    else { await setStatus(a.id, a.owner, request.id, 'HELD'); await setStatus(a.id, null, request.id, 'COMPLETED') }
    const [decided] = await requests(a.id)
    await expect(q('DELETE FROM "Order" WHERE id=$1', [source.id])).resolves.toMatchObject({ rowCount: 1 })
    await expect(withoutNoticeRetention(client => client.query('DELETE FROM "EbayNoticeQuarantine" WHERE id=$1', [id]))).resolves.toMatchObject({ rowCount: 1 })
    expect(await requests(a.id)).toEqual([{ ...decided, quarantineId: null, evidenceOrderId: null }])
  })

  it('a done request can only clear its pointers, never move them to other evidence', async () => {
    const a = await profile(), { request } = await candidate(a), other = await candidate(a)
    await setStatus(a.id, a.owner, request.id, 'DISMISSED')
    for (const change of [['quarantineId', other.id], ['evidenceOrderId', other.source.id]])
      await expect(q(`UPDATE "ErasureRequest" SET "${change[0]}"=$2 WHERE id=$1`, [request.id, change[1]])).rejects.toMatchObject({ code: '23503' })
    expect((await requests(a.id)).find(row => row.id === request.id)).toMatchObject({ quarantineId: request.quarantineId, evidenceOrderId: request.evidenceOrderId })
  })

  it('an owner decision cannot carry any other change, even through the table owner', async () => {
    const a = await profile(), { request } = await candidate(a)
    const client = await database.pool.connect()
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('nexus.actor_id',$1,true)", [a.owner])
      await expect(client.query(`UPDATE "ErasureRequest" SET status='DISMISSED',"matchBasis"='user_id' WHERE id=$1`, [request.id]))
        .rejects.toMatchObject({ code: '23514', message: 'Only the review status of an erasure request may change' })
    } finally { await client.query('ROLLBACK'); client.release() }
  })

  it('rolls the decision back when its audit record cannot be written', async () => {
    const a = await profile(), { request } = await candidate(a)
    h.failAudit = true
    await expect(withWorkspace(context(a.id, a.owner), () => decideEbayErasureRequest(request.id, 'DISMISSED'))).rejects.toMatchObject({ code: 'review_unavailable' })
    expect(await requests(a.id)).toMatchObject([{ status: 'REVIEW_REQUIRED', decidedAt: null }])
  })

  it('the owner decision service records who decided and refuses everyone else', async () => {
    const a = await profile(), b = await profile(), { request } = await candidate(a), other = await candidate(b)
    const refuse = (ctx: ReturnType<typeof context>, id: string, decision: string, code: string) =>
      expect(withWorkspace(ctx, () => decideEbayErasureRequest(id, decision))).rejects.toMatchObject({ code })
    await refuse(context(a.id, await member(a.id)), request.id, 'DISMISSED', 'authority_denied')
    await refuse(context(a.id), request.id, 'DISMISSED', 'authority_denied')
    await refuse(context(a.id, a.owner, 'synthetic-key'), request.id, 'DISMISSED', 'authority_denied')
    await refuse(context(a.id, a.owner), other.request.id, 'DISMISSED', 'review_unavailable')
    await refuse(context(a.id, a.owner), request.id, 'COMPLETED', 'review_unavailable')
    expect(await requests(a.id)).toMatchObject([{ status: 'REVIEW_REQUIRED' }])
    await expect(withWorkspace(context(a.id, a.owner), () => decideEbayErasureRequest(request.id, 'HELD'))).resolves.toEqual({ id: request.id, status: 'HELD' })
    await refuse(context(a.id, a.owner), request.id, 'DISMISSED', 'review_unavailable')
    expect(await requests(a.id)).toMatchObject([{ status: 'HELD' }])
    expect(await requests(b.id)).toMatchObject([{ status: 'REVIEW_REQUIRED' }])
    expect((await q(`SELECT "actorUserId",action,"targetId",metadata FROM "WorkspaceAudit" WHERE "workspaceId"=$1`, [a.id])).rows)
      .toEqual([{ actorUserId: a.owner, action: 'ebay.erasure.decided', targetId: request.id, metadata: { status: 'HELD' } }])
  })

  it('expires a reviewed notice that matched nothing once its 30 days have passed, and keeps a younger one', async () => {
    const old = await unmatched(31), young = await unmatched(29)
    await expect(expireEbayDeletionNotices()).resolves.toEqual({ kind: 'expired', expired: 1, limitReached: false })
    expect(await stored(old)).toBe(false); expect(await stored(young)).toBe(true)
  })

  it('lets the system runtime expire through the database function alone', async () => {
    const old = await unmatched(31)
    await expect(asRuntime('nexus_legacy_workspace', null, client => client.query('SELECT nexus_expire_ebay_deletion_notices(30,10) AS n'), true)).resolves.toMatchObject({ rows: [{ n: 1 }] })
    expect(await stored(old)).toBe(false)
  })

  it('keeps a notice while any business still has an open request, and expires it once every request is done', async () => {
    const a = await profile(), b = await profile(), subject = `shared-${randomUUID()}`
    const sa = await order(a.id, subject), sb = await order(b.id, subject)
    const id = await retained(body(subject)); await reviewPendingEbayDeletions(); await ageReview(id, 31)
    expect(await reviewState(id)).toMatchObject({ reviewOutcome: 'matched' })
    const [ra] = await requests(a.id), [rb] = await requests(b.id)
    await expect(expireEbayDeletionNotices()).resolves.toMatchObject({ expired: 0 })
    await setStatus(a.id, a.owner, ra.id, 'DISMISSED'); await setStatus(b.id, b.owner, rb.id, 'HELD')
    await expect(expireEbayDeletionNotices()).resolves.toMatchObject({ expired: 0 })
    await setStatus(b.id, null, rb.id, 'COMPLETED')
    await expect(expireEbayDeletionNotices()).resolves.toMatchObject({ expired: 1 })
    expect(await stored(id)).toBe(false)
    expect(await requests(a.id)).toMatchObject([{ id: ra.id, status: 'DISMISSED', quarantineId: null, evidenceOrderId: sa.id }])
    expect(await requests(b.id)).toMatchObject([{ id: rb.id, status: 'COMPLETED', quarantineId: null, evidenceOrderId: sb.id }])
  })

  it('never expires unreviewed, unreadable or handed-off notices', async () => {
    const a = await profile(), handed = body(`expiry-handed-${randomUUID()}`), handedId = await retained(handed)
    await reviewPendingEbayDeletions()
    const receiptId = randomUUID()
    await q(`INSERT INTO "WebhookEvent" (id,"workspaceId",channel,"externalId","eventType",payload,"signatureOk","verifiedBy","updatedAt")
      VALUES ($1,$2,'EBAY',$3,'MARKETPLACE_ACCOUNT_DELETION',$4::jsonb,true,'ebay_ecdsa',now())`, [receiptId,a.id,`ebay:production:${handed.notification.notificationId}`,JSON.stringify(handed)])
    await q('UPDATE "EbayNoticeQuarantine" SET "resolvedReceiptId"=$2,"resolvedWorkspaceId"=$3,"resolvedAt"=now() WHERE id=$1', [handedId,receiptId,a.id])
    await ageReview(handedId, 400)
    const unreadable: any = body(`expiry-unreadable-${randomUUID()}`)
    unreadable.metadata.schemaVersion = '2.0'
    const unsupported = await retained(unreadable)
    await reviewPendingEbayDeletions()
    expect(await reviewState(unsupported)).toMatchObject({ reviewOutcome: 'unsupported', reviewedAt: null })
    const pending = await retained(body(`expiry-pending-${randomUUID()}`))
    await expect(expireEbayDeletionNotices()).resolves.toEqual({ kind: 'expired', expired: 0, limitReached: false })
    for (const id of [handedId, unsupported, pending]) expect(await stored(id)).toBe(true)
  })

  it('is dormant unless the privacy switch is exactly 1', async () => {
    const old = await unmatched(31)
    for (const value of [undefined, '', '0', 'true']) {
      vi.stubEnv('NEXUS_ENABLE_EBAY_PRIVACY_REVIEW', value)
      await expect(expireEbayDeletionNotices()).resolves.toEqual({ kind: 'held', reason: 'processing_disabled' })
    }
    expect(await stored(old)).toBe(true)
  })

  it.each(['user', 'api-key'])('refuses direct %s authority for expiry before any database call', async authority => {
    const a = await profile(), old = await unmatched(31)
    await expect(withWorkspace(context(a.id, authority === 'user' ? a.owner : null, authority === 'api-key' ? 'synthetic-key' : undefined), () => expireEbayDeletionNotices()))
      .rejects.toMatchObject({ code: 'authority_denied' })
    expect(await stored(old)).toBe(true)
  })

  it('bounds each database call and each run, and resumes on the next run', async () => {
    const ids = [] as string[]
    for (let i = 0; i < 21; i++) ids.push(await syntheticReviewed(31))
    await expect(expireEbayDeletionNotices(1)).resolves.toEqual({ kind: 'expired', expired: 20, limitReached: true })
    expect((await Promise.all(ids.map(stored))).filter(Boolean)).toHaveLength(1)
    await expect(expireEbayDeletionNotices(1)).resolves.toEqual({ kind: 'expired', expired: 1, limitReached: false })
    for (const id of ids) expect(await stored(id)).toBe(false)
  })

  it('refuses tenants, a shorter period and unbounded batches in the database, and deletion outside the expiry', async () => {
    const a = await profile(), old = await unmatched(31)
    await asRuntime(a.id, a.owner, async client => { await expect(client.query('SELECT nexus_expire_ebay_deletion_notices(30,10)')).rejects.toMatchObject({ code: '42501' }) })
    for (const [days, batch] of [[29, 10], [30, 0], [30, 501], [null, 10], [30, null]])
      await asRuntime(a.id, null, async client => { await expect(client.query('SELECT nexus_expire_ebay_deletion_notices($1,$2)', [days, batch])).rejects.toMatchObject({ code: '22023' }) })
    await asRuntime(a.id, null, async client => { await expect(client.query('DELETE FROM "EbayNoticeQuarantine" WHERE id=$1', [old])).rejects.toMatchObject({ code: '42501' }) })
    await expect(q('DELETE FROM "EbayNoticeQuarantine" WHERE id=$1', [old])).rejects.toMatchObject({ code: '42501', message: 'Inbound delivery history must be archived, never deleted or truncated' })
    await expect(q('TRUNCATE "EbayNoticeQuarantine" CASCADE')).rejects.toMatchObject({ code: '42501', message: 'Inbound delivery history must be archived, never deleted or truncated' })
    expect(await stored(old)).toBe(true)
  })

  it.each(['under the floor', 'unreviewed', 'unreadable', 'handed off'])('the retention trigger refuses even the writer a notice %s', async kind => {
    const payload: any = body(`writer-${randomUUID()}`)
    if (kind === 'unreadable') payload.metadata.schemaVersion = '2.0'
    const id = kind === 'under the floor' ? await unmatched(29) : await retained(payload)
    if (kind === 'unreadable') { await reviewPendingEbayDeletions(); await q(`UPDATE "EbayNoticeQuarantine" SET "reviewNextAt"=NULL WHERE id=$1`, [id]) }
    if (kind === 'handed off') {
      const a = await profile(), receiptId = randomUUID()
      await reviewPendingEbayDeletions(); await ageReview(id, 400)
      await q(`INSERT INTO "WebhookEvent" (id,"workspaceId",channel,"externalId","eventType",payload,"signatureOk","verifiedBy","updatedAt")
        VALUES ($1,$2,'EBAY',$3,'MARKETPLACE_ACCOUNT_DELETION',$4::jsonb,true,'ebay_ecdsa',now())`, [receiptId,a.id,`ebay:production:${payload.notification.notificationId}`,JSON.stringify(payload)])
      await q('UPDATE "EbayNoticeQuarantine" SET "resolvedReceiptId"=$2,"resolvedWorkspaceId"=$3,"resolvedAt"=now() WHERE id=$1', [id,receiptId,a.id])
    }
    await asWriter(async client => {
      await expect(client.query('DELETE FROM "EbayNoticeQuarantine" WHERE id=$1', [id])).rejects.toMatchObject({ code: '42501', message: 'Inbound delivery history must be archived, never deleted or truncated' })
    })
    expect(await stored(id)).toBe(true)
  })

  it('the writer may remove a finished review past the floor, but never while a request is open', async () => {
    const old = await unmatched(31)
    await asWriter(async client => { await expect(client.query('DELETE FROM "EbayNoticeQuarantine" WHERE id=$1', [old])).resolves.toMatchObject({ rowCount: 1 }) })
    const a = await profile(), { id } = await candidate(a)
    await ageReview(id, 31, 'matched')
    await asWriter(async client => {
      await expect(client.query('DELETE FROM "EbayNoticeQuarantine" WHERE id=$1', [id])).rejects.toMatchObject({ code: '23503', message: 'An open erasure request keeps its notice and order evidence' })
    })
    expect(await stored(id)).toBe(true); expect(await requests(a.id)).toMatchObject([{ quarantineId: id, status: 'REVIEW_REQUIRED' }])
  })

  it('isolates request reads by actual runtime RLS and rejects tenant inserts', async () => {
    const a = await profile(), b = await profile(), subject = `rls-${randomUUID()}`, source = await order(a.id, subject)
    const id = await retained(body(subject)); await reviewEbayDeletion(id)
    expect(await asRuntime(a.id, a.owner, client => client.query('SELECT id FROM "ErasureRequest"'))).toMatchObject({ rowCount: 1 })
    expect(await asRuntime(b.id, b.owner, client => client.query('SELECT id FROM "ErasureRequest"'))).toMatchObject({ rowCount: 0 })
    await asRuntime(a.id, a.owner, async client => { await expect(insertRequest(a.id, id, source.id, {}, client)).rejects.toMatchObject({ code: '42501' }) })
  })

  it('the restrictive INSERT policy rejects a tenant independently of the new domain trigger', async () => {
    const a = await profile(), subject = `insert-policy-${randomUUID()}`, source = await order(a.id, subject), id = await retained(body(subject))
    const client = await database.pool.connect()
    try {
      await client.query('BEGIN')
      // Isolate the RLS layer in this disposable transaction, then roll the DDL back in finally.
      await client.query('ALTER TABLE "ErasureRequest" DISABLE TRIGGER nexus_erasure_review')
      await client.query('SET LOCAL ROLE nexus_workspace_runtime')
      await client.query("SELECT set_config('nexus.workspace_id',$1,true),set_config('nexus.actor_id',$2,true)", [a.id, a.owner])
      await expect(insertRequest(a.id, id, source.id, {}, client)).rejects.toMatchObject({ code: '42501' })
    } finally { await client.query('ROLLBACK'); client.release() }
    expect(await requests(a.id)).toEqual([])
  })

  it('the database refuses a duplicate workspace/notice request even outside the processor', async () => {
    const a = await profile(), subject = `unique-${randomUUID()}`, source = await order(a.id, subject), id = await retained(body(subject))
    await reviewEbayDeletion(id)
    await expect(insertRequest(a.id, id, source.id)).rejects.toMatchObject({ code: '23505' })
    expect(await requests(a.id)).toHaveLength(1)
  })

  it('keeps every field but the status fixed, and the record against deletion and truncation, even for the table owner', async () => {
    const a = await profile(), subject = `immutable-${randomUUID()}`
    await order(a.id, subject); await receiveAndReview(body(subject))
    const before = await requests(a.id)
    for (const change of [`"createdAt"="createdAt"+interval '1 day'`, `"matchBasis"='user_id'`, `"environment"='sandbox'`, `"decidedAt"=now()`, `"workspaceId"='elsewhere'`])
      await expect(q(`UPDATE "ErasureRequest" SET ${change} WHERE "workspaceId"=$1`, [a.id])).rejects.toMatchObject({ code: '23514' })
    await expect(q('DELETE FROM "ErasureRequest" WHERE "workspaceId"=$1', [a.id])).rejects.toMatchObject({ code: '42501' })
    await expect(q('TRUNCATE "ErasureRequest"')).rejects.toMatchObject({ code: '42501' })
    expect(await requests(a.id)).toEqual(before)
  })

  it.each([{ status: 'HELD' }, { status: 'DISMISSED' }, { status: 'COMPLETED' }, { status: 'READY' }, { channel: 'SHOPIFY' }, { matchBasis: 'verified_user_id' }, { matchBasis: 'username_candidate' }, { decidedAt: new Date() }])('database rejects a new request that is not an undecided candidate: %j', async patch => {
    const a = await profile(), subject = `state-${randomUUID()}`, source = await order(a.id, subject), id = await retained(body(subject))
    await expect(insertRequest(a.id, id, source.id, patch)).rejects.toMatchObject({ code: '23514' })
    expect(await requests(a.id)).toEqual([])
  })

  it.each(['unverified', 'other-topic', 'wrong-environment'])('database rejects %s source evidence independently of the processor', async defect => {
    const a = await profile(), subject = `proof-${randomUUID()}`, source = await order(a.id, subject), payload = body(subject)
    if (defect === 'unverified') vi.mocked(verifyEbayNotification).mockResolvedValueOnce({ ok: false, reason: 'signature_mismatch', kid: 'synthetic-key' })
    if (defect === 'other-topic') payload.metadata.topic = 'FUTURE_TOPIC'
    const saved = await receiveEbayNotice({ rawBody: Buffer.from(JSON.stringify(payload)), header: 'synthetic-signature', environment: defect === 'wrong-environment' ? 'sandbox' : 'production' })
    if (saved.kind === 'accepted') throw new Error('Expected quarantine metadata')
    await expect(insertRequest(a.id, saved.quarantineId, source.id)).rejects.toMatchObject({ code: '23514' })
    expect(await requests(a.id)).toEqual([])
  })

  it.each(['foreign-workspace', 'wrong-channel'])('database rejects %s order evidence independently of the processor', async defect => {
    const a = await profile(), b = await profile(), subject = `order-proof-${randomUUID()}`
    const source = await order(defect === 'foreign-workspace' ? b.id : a.id, subject), id = await retained(body(subject))
    if (defect === 'wrong-channel') await q(`UPDATE "Order" SET channel='SHOPIFY' WHERE id=$1`, [source.id])
    await expect(insertRequest(a.id, id, source.id)).rejects.toMatchObject({ code: '23514' })
    expect(await requests(a.id)).toEqual([])
  })

  it('serializes overlapping reviews into exactly one request and notice, even after the notice is read', async () => {
    const a = await profile(), subject = `race-${randomUUID()}`
    await order(a.id, subject); const id = await retained(body(subject))
    let reached!: () => void, release!: () => void, calls = 0
    const paused = new Promise<void>(resolve => { reached = resolve }), resume = new Promise<void>(resolve => { release = resolve })
    h.beforeCreate = async () => { if (++calls === 1) { reached(); await resume } }
    const first = reviewEbayDeletion(id)
    expect(await Promise.race([paused.then(() => 'paused'), first.then(() => 'settled', () => 'settled')])).toBe('paused')
    const second = reviewEbayDeletion(id), pending = Promise.all([first, second])
    let waited = false
    try { waited = await waiters(1) } finally { release(); h.beforeCreate = undefined }
    await expect(pending).resolves.toEqual([expect.objectContaining({ kind: 'candidates_recorded' }), expect.objectContaining({ kind: 'candidates_recorded' })])
    expect(waited).toBe(true)
    expect(await requests(a.id)).toHaveLength(1); expect(await notices(a.id)).toHaveLength(1)
    await q('UPDATE "Notification" SET "readAt"=now() WHERE "workspaceId"=$1', [a.id])
    await reviewEbayDeletion(id)
    expect(await requests(a.id)).toHaveLength(1); expect(await notices(a.id)).toHaveLength(1)
  })

  it('rolls request and notice back together and resumes after a later workspace fails', async () => {
    const a = await profile(`a-${randomUUID()}`), b = await profile(`z-${randomUUID()}`), subject = `rollback-${randomUUID()}`
    await order(a.id, subject); await order(b.id, subject)
    const payload = body(subject)
    h.failNoticeForUser = b.owner
    // eBay already has its answer; the failure stays inside the retry worker's review.
    const saved = await receive(payload)
    if (saved.kind !== 'quarantined') throw new Error('Expected retained notice')
    await expect(reviewPendingEbayDeletions()).resolves.toMatchObject({ claimed: 1, failed: 1 })
    expect(await requests(a.id)).toHaveLength(1); expect(await notices(a.id)).toHaveLength(1)
    expect(await requests(b.id)).toEqual([]); expect(await notices(b.id)).toEqual([])
    const original = (await q('SELECT "payloadEnc","payloadDigest",deliveries FROM "EbayNoticeQuarantine" WHERE "externalId"=$1', [payload.notification.notificationId])).rows[0]
    await receive(payload)
    await makeDue(saved.quarantineId)
    await expect(reviewPendingEbayDeletions()).resolves.toMatchObject({ claimed: 1, reviewed: 1 })
    expect(await requests(a.id)).toHaveLength(1); expect(await notices(a.id)).toHaveLength(1)
    expect(await requests(b.id)).toHaveLength(1); expect(await notices(b.id)).toHaveLength(1)
    expect((await q('SELECT "payloadEnc","payloadDigest",deliveries FROM "EbayNoticeQuarantine" WHERE "externalId"=$1', [payload.notification.notificationId])).rows[0])
      .toEqual({ ...original, deliveries: 2 })
  })

  it.each(['workspace', 'account-environment', 'buyer-username'])('rechecks %s after a concurrent change wins its lock', async target => {
    const a = await profile(), subject = `changed-${randomUUID()}`, source = await order(a.id, subject), id = await retained(body(subject))
    const blocker = await database.pool.connect()
    await blocker.query('BEGIN')
    if (target === 'workspace') await blocker.query(`UPDATE "Workspace" SET status='paused' WHERE id=$1`, [a.id])
    if (target === 'account-environment') await blocker.query(`UPDATE "ChannelConnection" SET "connectionMetadata"='{"environment":"sandbox"}' WHERE id=$1`, [source.account])
    if (target === 'buyer-username') await blocker.query(`UPDATE "Order" SET "ebayMetadata"='{"buyer":{"username":"someone-else"}}' WHERE id=$1`, [source.id])
    const pending = reviewEbayDeletion(id)
    let waited = false
    try { waited = await waiters(1) } finally { await blocker.query('COMMIT'); blocker.release() }
    await expect(pending).resolves.toMatchObject({ requestsCreated: 0, noticesCreated: 0 })
    expect(waited).toBe(true)
    expect(await requests(a.id)).toEqual([]); expect(await notices(a.id)).toEqual([])
  })

  it('opens retained private bytes outside database transactions and wipes that byte buffer', async () => {
    const a = await profile(), subject = `decrypt-${randomUUID()}`
    await order(a.id, subject); const id = await retained(body(subject))
    const original = crypto.openEbayQuarantineBody
    let opened: Buffer | undefined
    vi.spyOn(crypto, 'openEbayQuarantineBody').mockImplementation(async (...args) => {
      expect((await q('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start IS NOT NULL')).rows[0].n).toBe(0)
      opened = await original(...args); return opened
    })
    await reviewEbayDeletion(id)
    expect(opened?.every(byte => byte === 0)).toBe(true)
  })

  it('records an ownerless candidate and notifies a subsequently active owner once', async () => {
    const a = await profile(), subject = `owner-${randomUUID()}`
    await order(a.id, subject); const id = await retained(body(subject))
    await q(`UPDATE "UserProfile" SET status='inactive' WHERE id=$1`, [a.owner])
    await reviewEbayDeletion(id)
    expect(await requests(a.id)).toHaveLength(1); expect(await notices(a.id)).toEqual([])
    await q(`UPDATE "UserProfile" SET status='active' WHERE id=$1`, [a.owner])
    await reviewEbayDeletion(id); await reviewEbayDeletion(id)
    expect(await requests(a.id)).toHaveLength(1); expect(await notices(a.id)).toHaveLength(1)
  })

  it('crosses workspace pages without broadcasting to profiles with no matching order', async () => {
    const a = await profile(`zz-${randomUUID()}`), subject = `paged-${randomUUID()}`
    await order(a.id, subject)
    for (let i = 0; i < 51; i++) await q(`INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,'active','test',$1,now())`, [`page-${String(i).padStart(2, '0')}-${randomUUID()}`])
    const id = await retained(body(subject))
    await expect(reviewEbayDeletion(id)).resolves.toMatchObject({ workspacesExamined: 53, requestsCreated: 1, noticesCreated: 1 })
    expect(await requests(a.id)).toHaveLength(1); expect(await notices(a.id)).toHaveLength(1)
  }, 20_000)


  it.each(['', ' invalid ', 'x'.repeat(1025)])('rejects an invalid internal quarantine identifier before private reads', async id => {
    const open = vi.spyOn(crypto, 'openEbayQuarantineBody')
    await expect(reviewEbayDeletion(id)).rejects.toMatchObject({ code: 'review_unavailable' })
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['notification-id', 'topic'])('refuses retained plaintext with a mismatched %s even when the cipher binding opens', async mismatch => {
    const a = await profile(), subject = `payload-${randomUUID()}`
    await order(a.id, subject)
    const payload = body(subject)
    if (mismatch === 'topic') payload.metadata.topic = 'FUTURE_TOPIC'
    const id = await syntheticRetained(payload, mismatch === 'notification-id' ? { externalId: randomUUID() } : {})
    await expect(reviewEbayDeletion(id)).resolves.toMatchObject({ kind: 'held', reason: 'subject_unavailable' })
    expect(await requests(a.id)).toEqual([]); expect(await notices(a.id)).toEqual([])
  })

  it('refuses corrupted retained payload proof without a domain write or private error text', async () => {
    const a = await profile(), subject = `corrupt-${randomUUID()}`
    await order(a.id, subject)
    const id = await syntheticRetained(body(subject), { payloadDigest: 'a'.repeat(64) })
    await expect(reviewEbayDeletion(id)).rejects.toMatchObject({ code: 'review_unavailable', message: 'The eBay privacy review could not be recorded.' })
    expect(await requests(a.id)).toEqual([]); expect(await notices(a.id)).toEqual([])
  })

  it('does not reinterpret an already handed-off quarantine row as a fresh privacy candidate', async () => {
    const a = await profile(), subject = `handed-off-${randomUUID()}`, payload = body(subject)
    await order(a.id, subject)
    const id = await retained(payload), receiptId = randomUUID()
    await q(`INSERT INTO "WebhookEvent" (id,"workspaceId",channel,"externalId","eventType",payload,"signatureOk","verifiedBy","updatedAt")
      VALUES ($1,$2,'EBAY',$3,'MARKETPLACE_ACCOUNT_DELETION',$4::jsonb,true,'ebay_ecdsa',now())`, [receiptId,a.id,`ebay:production:${payload.notification.notificationId}`,JSON.stringify(payload)])
    await q('UPDATE "EbayNoticeQuarantine" SET "resolvedReceiptId"=$2,"resolvedWorkspaceId"=$3,"resolvedAt"=now() WHERE id=$1', [id,receiptId,a.id])
    const open = vi.spyOn(crypto, 'openEbayQuarantineBody')
    await expect(reviewEbayDeletion(id)).resolves.toMatchObject({ kind: 'held', reason: 'notice_unavailable' })
    expect(open).not.toHaveBeenCalled(); expect(await requests(a.id)).toEqual([])
  })


  it('rejects an unverified row even when stored metadata claims the deletion topic', async () => {
    const id = randomUUID()
    await q(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"signatureOk","externalId",topic,"payloadDigest",reason)
      VALUES ($1,'production',false,$1,'MARKETPLACE_ACCOUNT_DELETION',$2,'signature_mismatch')`, [id, 'c'.repeat(64)])
    const open = vi.spyOn(crypto, 'openEbayQuarantineBody')
    await expect(reviewEbayDeletion(id)).resolves.toMatchObject({ kind: 'held', reason: 'notice_unavailable' })
    expect(open).not.toHaveBeenCalled()
  })

})
