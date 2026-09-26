import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>, workspaceId: string
let afterReplayRead: (() => Promise<void>) | undefined
let beforeArchiveWrite: (() => Promise<void>) | undefined
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => {
  if (key === '$transaction') return (work: any, options: any) => database.client.$transaction((tx: any) => work(new Proxy(tx, { get: (target, model) => {
    if (model !== 'webhookEvent') return target[model]
    return new Proxy(target.webhookEvent, { get: (delegate, method) => {
      if (method !== 'updateMany') return delegate[method]
      return async (args: any) => {
        if (args.data.archivedAt && beforeArchiveWrite) { const pause = beforeArchiveWrite; beforeArchiveWrite = undefined; await pause() }
        return delegate.updateMany(args)
      }
    } })
  } })), options)
  if (key !== 'webhookEvent') return (database.client as any)[key]
  return new Proxy(database.client.webhookEvent, { get: (target, method) => {
    if (method !== 'findUnique') return (target as any)[method]
    return async (args: any) => {
      const row = await target.findUnique(args)
      if (args.select?.status && afterReplayRead) { const pause = afterReplayRead; afterReplayRead = undefined; await pause() }
      return row
    }
  } })
} }) }))
const { archiveCompletedInbound, INBOUND_ARCHIVE_BATCH } = await import('./archive.js')
const { replayInbound, recordInbound } = await import('./ledger.js')
const inProfile = <T>(id: string, work: () => Promise<T>) => withWorkspace({ workspaceId: id, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const inOwner = <T>(work: () => Promise<T>) => inProfile(workspaceId, work)
const stored = (id: string) => inOwner(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id } }))
async function receipt(extra: Record<string, unknown> = {}, owner = workspaceId) {
  const id = randomUUID()
  return inProfile(owner, () => database.client.webhookEvent.create({ data: {
    id, channel: 'SHOPIFY', eventType: 'product/update', externalId: id, payload: { original: 'retained history' },
    status: 'done', isProcessed: true, signatureOk: true, verifiedBy: 'shopify_hmac', attempts: 2, deliveries: 4,
    createdAt: new Date('2020-01-01T00:00:00Z'), processedAt: new Date('2020-01-02T00:00:00Z'), ...extra,
  } as any }))
}
async function newProfile() {
  const id = randomUUID()
  await database.pool.query('INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ($1,\'Archive fixture\',\'test\',$1,now())', [id])
  return id
}
async function waitForBlocked(pid: number) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if ((await database.pool.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

describe.skipIf(!concurrentDatabaseUrl())('inbound archive and replay races in PostgreSQL', () => {
  beforeAll(async () => { vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '1'); vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1'); database = await concurrentDatabase({ maxConnections: 10 }) }, 180_000)
  beforeEach(async () => { workspaceId = await newProfile(); afterReplayRead = undefined; beforeArchiveWrite = undefined })
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('archives completed history in place and preserves every identity, payload and proof field', async () => {
    const row = await receipt(), before = await stored(row.id)
    const fakeClock = vi.spyOn(Date, 'now').mockReturnValue(0)
    try { expect(await inOwner(() => archiveCompletedInbound(90))).toEqual({ archived: 1, limitReached: false }) }
    finally { fakeClock.mockRestore() }
    const after = await stored(row.id)
    expect(after.archivedAt).toBeInstanceOf(Date)
    expect(after.archivedAt!.getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime())
    expect({ ...after, archivedAt: before.archivedAt, updatedAt: before.updatedAt }).toEqual(before)
  })

  it('leaves unfinished work, dead letters, schedules, leases and recent completion untouched', async () => {
    const changes = [{ status: 'pending' }, { status: 'failed' }, { status: 'dlq' }, { isProcessed: false },
      { nextAttemptAt: new Date() }, { leaseToken: 'active-owner', leaseUntil: new Date('2099-01-01T00:00:00Z') },
      { processedAt: new Date() }, { processedAt: null }]
    const rows = await Promise.all(changes.map(change => receipt(change)))
    expect(await inOwner(() => archiveCompletedInbound(90))).toEqual({ archived: 0, limitReached: false })
    for (const row of rows) expect(await stored(row.id)).toEqual(row)
  })

  it('cannot archive another business profile', async () => {
    const other = await newProfile(), row = await receipt({}, other)
    expect((await inOwner(() => archiveCompletedInbound(90))).archived).toBe(0)
    expect(await inProfile(other, () => database.client.webhookEvent.findUniqueOrThrow({ where: { id: row.id } }))).toEqual(row)
  })

  it('bounds concurrent archivers and counts each receipt only once', async () => {
    const ids = Array.from({ length: INBOUND_ARCHIVE_BATCH + 1 }, () => randomUUID())
    await inOwner(() => database.client.webhookEvent.createMany({ data: ids.map(id => ({ id, channel: 'SHOPIFY', eventType: 'product/update',
      externalId: id, payload: {}, status: 'done', isProcessed: true, processedAt: new Date('2020-01-01T00:00:00Z') })) }))
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    beforeArchiveWrite = async () => { entered(); await held }
    const first = inOwner(() => archiveCompletedInbound(90))
    await Promise.race([ready, first.then(() => { throw new Error('Archiver completed before its controlled write') })])
    let second: Awaited<ReturnType<typeof archiveCompletedInbound>>
    try { second = await inOwner(() => archiveCompletedInbound(90)) } finally { release() }
    const results = [await first, second]
    expect(second.archived).toBe(1)
    expect(results[0].archived).toBe(INBOUND_ARCHIVE_BATCH)
    expect(results.every(result => result.archived <= INBOUND_ARCHIVE_BATCH)).toBe(true)
    expect(results.reduce((sum, result) => sum + result.archived, 0)).toBe(ids.length)
    expect(results.some(result => result.limitReached)).toBe(true)
    expect(await inOwner(() => database.client.webhookEvent.count({ where: { archivedAt: { not: null } } }))).toBe(ids.length)
  })

  it.each(['SHOPIFY', 'EBAY'])('refuses %s replay when archiving wins after the initial replay read', async channel => {
    const row = await receipt({ channel, verifiedBy: channel === 'EBAY' ? 'ebay_ecdsa' : 'shopify_hmac' })
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    afterReplayRead = async () => { entered(); await held }
    const replay = inOwner(() => replayInbound({ id: row.id }))
    await Promise.race([ready, replay.then(() => { throw new Error('Replay completed before controlled read') })])
    try { expect((await inOwner(() => archiveCompletedInbound(90))).archived).toBe(1) } finally { release() }
    expect(await replay).toEqual({ ok: false, reason: 'archived' })
    expect(await stored(row.id)).toMatchObject({ status: 'done', isProcessed: true, nextAttemptAt: null, attempts: 2 })
  })

  it.each(['SHOPIFY', 'EBAY'])('skips a %s receipt while replay holds its write lock, then preserves queued work', async channel => {
    const row = await receipt({ channel, verifiedBy: channel === 'EBAY' ? 'ebay_ecdsa' : 'shopify_hmac' }), blocker = await database.pool.connect()
    await database.pool.query(`CREATE FUNCTION archive_replay_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id=TG_ARGV[0] AND NEW.status='pending' THEN PERFORM pg_advisory_xact_lock(83409271); END IF; RETURN NEW; END $$`)
    await database.pool.query(`CREATE TRIGGER archive_replay_barrier AFTER UPDATE ON "WebhookEvent" FOR EACH ROW EXECUTE FUNCTION archive_replay_barrier('${row.id}')`)
    await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock(83409271)')
    const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const replay = inOwner(() => replayInbound({ id: row.id }))
    let blocked = false
    try {
      blocked = await waitForBlocked(pid)
      expect((await inOwner(() => archiveCompletedInbound(90))).archived).toBe(0)
    } finally { await blocker.query('COMMIT'); blocker.release() }
    try {
      expect(await replay).toMatchObject({ ok: true })
      expect(blocked).toBe(true)
      expect(await stored(row.id)).toMatchObject({ status: 'pending', archivedAt: null, isProcessed: false })
    } finally {
      await database.pool.query('DROP TRIGGER archive_replay_barrier ON "WebhookEvent"')
      await database.pool.query('DROP FUNCTION archive_replay_barrier()')
    }
  })

  it('retains delivery identity on redelivery without reopening archived work', async () => {
    const row = await receipt()
    await inOwner(() => archiveCompletedInbound(90))
    expect(await inOwner(() => recordInbound({ channel: row.channel, eventType: row.eventType, externalId: row.externalId,
      connectionId: null, signatureOk: true, verifiedBy: 'shopify_hmac', payload: { later: 'must not replace the original' } }))).toMatchObject({ id: row.id, duplicate: true, existingStatus: 'done' })
    const after = await stored(row.id)
    expect(after).toMatchObject({ payload: row.payload, deliveries: 5, status: 'done', isProcessed: true, nextAttemptAt: null })
    expect(after.archivedAt).not.toBeNull()
  })

  it.each(['SQL deletion', 'ORM deletion', 'truncation'])('refuses %s without losing any history', async operation => {
    const row = await receipt()
    if (operation === 'SQL deletion') await expect(database.pool.query('DELETE FROM "WebhookEvent" WHERE id=$1', [row.id])).rejects.toMatchObject({ code: '42501' })
    if (operation === 'ORM deletion') await expect(inOwner(() => database.client.webhookEvent.deleteMany({ where: { id: row.id } }))).rejects.toThrow()
    if (operation === 'truncation') await expect(database.pool.query('TRUNCATE "WebhookEvent" CASCADE')).rejects.toMatchObject({ code: '42501' })
    expect(await stored(row.id)).toEqual(row)
  })

  it.each(['deletion', 'truncation'])('also prevents privileged quarantine %s', async operation => {
    const id = randomUUID()
    await database.pool.query(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"externalId",topic,"payloadDigest",reason)
      VALUES ($1,'production',$1,'unclassified',$2,'signature_mismatch')`, [id, '0'.repeat(64)])
    if (operation === 'deletion') await expect(database.pool.query('DELETE FROM "EbayNoticeQuarantine" WHERE id=$1', [id])).rejects.toMatchObject({ code: '42501' })
    // Reach the history trigger despite referencing review records; the exact message excludes their independent guard.
    else await expect(database.pool.query('TRUNCATE "EbayNoticeQuarantine" CASCADE')).rejects.toMatchObject({ code: '42501', message: 'Inbound delivery history must be archived, never deleted or truncated' })
    expect((await database.pool.query('SELECT count(*)::int AS n FROM "EbayNoticeQuarantine" WHERE id=$1', [id])).rows[0].n).toBe(1)
  })
})
