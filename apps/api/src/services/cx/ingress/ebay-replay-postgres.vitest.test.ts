import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
let pauseAfterReplayRead: (() => Promise<void>) | undefined
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => {
  const value = (database.client as any)[key]
  if (key !== 'webhookEvent') return value
  return new Proxy(value, { get: (delegate, method) => {
    if (method !== 'findUnique') return delegate[method]
    return async (args: any) => {
      const row = await delegate.findUnique(args)
      if (pauseAfterReplayRead && args.select?.archivedAt && args.select?.nextAttemptAt) await pauseAfterReplayRead()
      return row
    }
  } })
} }) }))
const { recordInbound, replayInbound } = await import('./ledger.js')
const { claimEbayInbound, commitEbayInbound } = await import('./ebay-claims.js')
const OWNER = 'nexus_legacy_workspace', OTHER = randomUUID()
const inProfile = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const inOwner = <T>(work: () => Promise<T>) => inProfile(OWNER, work)
async function queued() {
  const receipt = await inOwner(() => recordInbound({ channel: 'EBAY', eventType: 'AUTHORIZATION_REVOCATION', externalId: randomUUID(),
    connectionId: 'replay-seller', signatureOk: true, verifiedBy: 'ebay_ecdsa', queueForRetry: true, payload: { retained: true } }))
  expect(receipt.id).toBeTruthy()
  return receipt.id!
}
async function stored(id: string) { return inOwner(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id } })) }
async function deadLetter(id: string) { await database.pool.query('UPDATE "WebhookEvent" SET status=\'dlq\',attempts=5,"nextAttemptAt"=NULL WHERE id=$1', [id]) }

describe.skipIf(!concurrentDatabaseUrl())('fenced manual eBay replay in PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    database = await concurrentDatabase({ maxConnections: 8 })
    await database.pool.query('INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ($1,\'Replay other business\',\'test\',$1,now())', [OTHER])
    await database.pool.query('INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","updatedAt") VALUES (\'replay-seller\',$1,\'EBAY\',\'replay-seller\',now())', [OWNER])
  }, 180_000)
  afterAll(async () => { pauseAfterReplayRead = undefined; vi.useRealTimers(); await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('schedules a new verified receipt with database time despite a receiver clock a year ahead', async () => {
    const before = (await database.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(before.getTime() + 365 * 86_400_000))
    let id: string
    try { id = await queued() } finally { vi.useRealTimers() }
    const after = (await database.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
    const row = await stored(id!)
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(row.nextAttemptAt!.getTime()).toBeLessThanOrEqual(after.getTime())
    expect(await inOwner(() => claimEbayInbound(id!))).toBeTruthy()
  })

  it('uses database time and preserves receipt identity when manually requeuing a dead letter', async () => {
    const id = await queued(); await deadLetter(id)
    const before = await stored(id)
    const clockBefore = (await database.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(clockBefore.getTime() + 365 * 86_400_000))
    try { expect(await inOwner(() => replayInbound({ id }))).toMatchObject({ ok: true }) } finally { vi.useRealTimers() }
    const after = await stored(id)
    expect(after).toMatchObject({ status: 'pending', attempts: 0, leaseToken: null, leaseUntil: null, externalId: before.externalId, connectionId: before.connectionId, payload: before.payload, deliveries: before.deliveries })
    const clockAfter = (await database.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
    expect(after.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(clockBefore.getTime())
    expect(after.nextAttemptAt!.getTime()).toBeLessThanOrEqual(clockAfter.getTime())
    expect(await inOwner(() => claimEbayInbound(id))).toBeTruthy()
  })

  it('refuses an active worker claim without changing any receipt field', async () => {
    const id = await queued(), claim = await inOwner(() => claimEbayInbound(id)), before = await stored(id)
    expect(claim).toBeTruthy()
    expect(await inOwner(() => replayInbound({ id }))).toMatchObject({ ok: false, reason: 'already_pending' })
    expect(await stored(id)).toEqual(before)
  })

  it('rechecks under lock when a worker claims after the operator first reads the row', async () => {
    const id = await queued()
    await database.pool.query('UPDATE "WebhookEvent" SET status=\'failed\' WHERE id=$1', [id])
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(r => { entered = r }), held = new Promise<void>(r => { release = r })
    pauseAfterReplayRead = async () => { pauseAfterReplayRead = undefined; entered(); await held }
    const replaying = inOwner(() => replayInbound({ id }))
    await ready
    let before!: Awaited<ReturnType<typeof stored>>
    try { expect(await inOwner(() => claimEbayInbound(id))).toBeTruthy(); before = await stored(id) } finally { release() }
    expect(await replaying).toMatchObject({ ok: false, reason: 'already_pending' })
    expect(await stored(id)).toEqual(before)
  })

  it('gives two simultaneous operator replays one reset, not two successful queue claims', async () => {
    const id = await queued(); await deadLetter(id)
    const blocker = await database.pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM "WebhookEvent" WHERE id=$1 FOR UPDATE', [id])
    let arrived = 0, release!: () => void
    const held = new Promise<void>(r => { release = r })
    pauseAfterReplayRead = async () => { arrived++; if (arrived === 2) { pauseAfterReplayRead = undefined; release() }; await held }
    const replays = Promise.all([inOwner(() => replayInbound({ id })), inOwner(() => replayInbound({ id }))])
    let waiting = 0
    try {
      const deadline = Date.now() + 3_000
      while (waiting < 2 && Date.now() < deadline) {
        waiting = Number((await database.pool.query('SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type=\'Lock\'')).rows[0].n)
        if (waiting < 2) await new Promise(r => setTimeout(r, 20))
      }
    } finally { await blocker.query('COMMIT'); blocker.release() }
    const results = await replays
    expect(waiting).toBe(2)
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => result.reason === 'already_pending')).toHaveLength(1)
    expect((await stored(id)).attempts).toBe(0)
  })

  it('fences an old claim after an actual manual replay reuses its attempt number', async () => {
    const id = await queued(), first = (await inOwner(() => claimEbayInbound(id)))!
    expect(await inOwner(() => commitEbayInbound(first, async () => null))).toMatchObject({ committed: true })
    expect(await inOwner(() => replayInbound({ id }))).toMatchObject({ ok: true })
    const second = (await inOwner(() => claimEbayInbound(id)))!
    expect(second.attempt).toBe(first.attempt)
    const staleEffect = vi.fn(async () => null)
    expect(await inOwner(() => commitEbayInbound(first, staleEffect))).toEqual({ committed: false })
    expect(staleEffect).not.toHaveBeenCalled()
    expect(await inOwner(() => commitEbayInbound(second, async () => null))).toMatchObject({ committed: true })
  })

  it('keeps archived, unverified and foreign-profile receipts unchanged', async () => {
    for (const change of [{ archivedAt: new Date() }, { signatureOk: false }, { verifiedBy: 'none' }]) {
      const id = await queued(); await deadLetter(id)
      await inOwner(() => database.client.webhookEvent.update({ where: { id }, data: change }))
      const before = await stored(id)
      expect((await inOwner(() => replayInbound({ id }))).ok).toBe(false)
      expect(await stored(id)).toEqual(before)
    }
    const id = await queued(); await deadLetter(id)
    const before = await stored(id)
    expect(await inProfile(OTHER, () => replayInbound({ id }))).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await inOwner(() => replayInbound({ id, workspaceId: OTHER }))).toMatchObject({ ok: false, reason: 'wrong_workspace' })
    expect(await stored(id)).toEqual(before)
  })
})
