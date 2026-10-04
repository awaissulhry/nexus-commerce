import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Sheet publish parity, step 5 (item 3) — the batch sender on the real schema and tenant policies.
 *
 * One channel account goes in the order the person chose; two accounts go side by side. A destination that fails, or
 * that the submit refuses before sending, does not stop the others. A destination not in PREVIEW (blocked, already
 * sent, cancelled) is never sent. A second run, or a resume after a crash, sends nothing twice. A cancel stops the
 * batch before its next destination. The resume job re-queues only batches whose heartbeat went stale.
 */
const fixture = vi.hoisted(() => ({ database: null as any, published: [] as any[], dispatched: [] as string[] }))

vi.mock('@nexus/database', async () => {
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../test-support/concurrent-database.js')
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  return { default: fixture.database.client }
})
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: (event: unknown) => { fixture.published.push(event) } }))
vi.mock('./publication-batch.service.js', async original => ({ ...await original<any>(), dispatchPublicationBatch: async (id: string) => { fixture.dispatched.push(id); return 'queued' } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { BATCH_HEARTBEAT_MS, BATCH_KIND, runPublicationBatch } from './publication-batch.processor.js'
import { runPublicationBatchResumeTick } from '../../jobs/publication-batch-resume.job.js'
import { WorkspaceScopeError } from './workspace-destination.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const USER = 'processor-user'
let counter = 0

async function batch(children: Array<{ channel: string; account: string; market: string; status?: string }>, header: { status?: string; nextCheckAt?: Date | null } = {}) {
  const batchId = `batch-${++counter}`
  const ids: string[] = []
  for (const child of children) {
    const id = `${batchId}-${child.channel}-${child.account}-${child.market}`
    ids.push(id)
    await prisma.bulkOperation.create({ data: { id, userId: USER, status: child.status ?? 'PREVIEW', productCount: 2, changeCount: 2,
      kind: 'studio-publication', productId: 'family', channel: child.channel, marketplace: child.market, channelConnectionId: child.account, aliasKey: '',
      batchId, expiresAt: new Date(Date.now() + 3_600_000),
      changes: { kind: 'studio-publication', productId: 'family-member', publicationKey: id, scope: { channel: child.channel, marketplace: child.market, accountId: child.account },
        batch: { batchId, body: { selectionToken: `token-${id}` } } } } as never })
  }
  await prisma.bulkOperation.create({ data: { id: batchId, userId: USER, status: header.status ?? 'QUEUED', kind: BATCH_KIND, productCount: ids.length, changeCount: 0,
    checkCount: 0, nextCheckAt: header.nextCheckAt === undefined ? new Date(Date.now() + BATCH_HEARTBEAT_MS) : header.nextCheckAt,
    changes: { kind: BATCH_KIND, children: ids, cancelRequestedAt: null } } as never })
  return { batchId, ids }
}

/** A submit that behaves like the real one at its edges: it claims the review (PREVIEW → ACCEPTED) and records the call. */
function recordingSubmit(options: { fail?: Set<string>; refuse?: Set<string>; during?: (id: string) => Promise<void> } = {}) {
  const calls: Array<{ productId: string; id: string; body: unknown; userId: string | null }> = []
  const submit = async (productId: string, id: string, body: unknown, userId: string | null) => {
    calls.push({ productId, id, body, userId })
    if (options.refuse?.has(id)) throw new WorkspaceScopeError('Saved information changed. Review the current values before publishing.')
    await options.during?.(id)
    const moved = await prisma.bulkOperation.updateMany({ where: { id, status: 'PREVIEW' }, data: { status: options.fail?.has(id) ? 'FAILED' : 'ACCEPTED' } })
    if (!moved.count) throw new Error('sent twice')
    return {}
  }
  return { calls, submit }
}

const statuses = async (ids: string[]) => (await prisma.bulkOperation.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } }))
  .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)).map(row => row.status)

describe('publication batch sender', () => {
  beforeAll(async () => { await scoped(() => prisma.bulkOperation.count()) }, 120_000)
  afterAll(async () => { await fixture.database?.close?.() })
  beforeEach(() => { fixture.published.length = 0; fixture.dispatched.length = 0 })

  it('sends one channel account in the order chosen, with each review\'s own body and its own submitter', () => scoped(async () => {
    const { batchId, ids } = await batch([{ channel: 'AMAZON', account: 'a', market: 'IT' }, { channel: 'AMAZON', account: 'a', market: 'DE' }, { channel: 'AMAZON', account: 'a', market: 'FR' }])
    const { calls, submit } = recordingSubmit()
    const summary = await runPublicationBatch(batchId, { submit })
    expect(summary).toMatchObject({ claimed: true, submitted: 3, notSent: 0, skipped: 0, cancelled: 0 })
    expect(calls.map(c => c.id)).toEqual(ids)
    expect(calls[0]).toEqual({ productId: 'family-member', id: ids[0], body: { selectionToken: `token-${ids[0]}` }, userId: USER })
    const header = await prisma.bulkOperation.findUnique({ where: { id: batchId } })
    expect(header).toMatchObject({ status: 'SENT', nextCheckAt: null, checkCount: 1 })
    expect(header!.completedAt).toBeInstanceOf(Date)
  }))

  it('runs two channel accounts side by side, each still in order', () => scoped(async () => {
    const { batchId, ids } = await batch([{ channel: 'AMAZON', account: 'a', market: 'IT' }, { channel: 'AMAZON', account: 'a', market: 'DE' },
      { channel: 'EBAY', account: 'e', market: 'IT' }, { channel: 'EBAY', account: 'e', market: 'DE' }])
    const events: string[] = []
    let inFlight = 0, most = 0
    const { submit } = recordingSubmit({ during: async id => {
      inFlight += 1; most = Math.max(most, inFlight); events.push(`start ${id}`)
      await new Promise(resolve => setTimeout(resolve, 20))
      inFlight -= 1; events.push(`end ${id}`)
    } })
    await runPublicationBatch(batchId, { submit })
    expect(most).toBe(2)
    const at = (entry: string) => events.indexOf(entry)
    expect(at(`end ${ids[0]}`)).toBeLessThan(at(`start ${ids[1]}`))
    expect(at(`end ${ids[2]}`)).toBeLessThan(at(`start ${ids[3]}`))
    expect(at(`start ${ids[2]}`)).toBeLessThan(at(`end ${ids[0]}`))
  }))

  it('keeps going when one destination fails or is refused, and records the refusal as NOT_SENT with its reason', () => scoped(async () => {
    const { batchId, ids } = await batch([{ channel: 'EBAY', account: 'e', market: 'IT' }, { channel: 'EBAY', account: 'e', market: 'DE' }, { channel: 'EBAY', account: 'e', market: 'FR' }])
    const { calls, submit } = recordingSubmit({ fail: new Set([ids[0]]), refuse: new Set([ids[1]]) })
    const summary = await runPublicationBatch(batchId, { submit })
    expect(calls).toHaveLength(3)
    expect(summary).toMatchObject({ submitted: 2, notSent: 1 })
    expect(await statuses(ids)).toEqual(['FAILED', 'NOT_SENT', 'ACCEPTED'])
    const refused = await prisma.bulkOperation.findUnique({ where: { id: ids[1] } })
    expect((refused!.summary as any).message).toBe('Nothing was sent. Saved information changed. Review the current values before publishing.')
    expect(refused!.completedAt).toBeInstanceOf(Date)
    expect(fixture.published).toEqual([expect.objectContaining({ publicationId: ids[1], status: 'NOT_SENT', terminal: true, batchId })])
  }))

  it('never sends a destination that is blocked, already sent or cancelled', () => scoped(async () => {
    const { batchId, ids } = await batch([{ channel: 'EBAY', account: 'e', market: 'IT', status: 'BLOCKED' }, { channel: 'EBAY', account: 'e', market: 'DE', status: 'SUBMITTED' },
      { channel: 'EBAY', account: 'e', market: 'FR', status: 'CANCELLED' }, { channel: 'EBAY', account: 'e', market: 'ES' }])
    const { calls, submit } = recordingSubmit()
    const summary = await runPublicationBatch(batchId, { submit })
    expect(calls.map(c => c.id)).toEqual([ids[3]])
    expect(summary).toMatchObject({ submitted: 1, skipped: 3 })
  }))

  it('sends nothing twice: a second run finds the batch finished, a concurrent one finds it claimed', () => scoped(async () => {
    const { batchId, ids } = await batch([{ channel: 'EBAY', account: 'e', market: 'IT' }, { channel: 'EBAY', account: 'e', market: 'DE' }])
    const { calls, submit } = recordingSubmit()
    expect((await runPublicationBatch(batchId, { submit })).claimed).toBe(true)
    expect(await runPublicationBatch(batchId, { submit })).toMatchObject({ claimed: false, submitted: 0 })
    expect(calls).toHaveLength(2)

    const running = await batch([{ channel: 'EBAY', account: 'e', market: 'NL' }], { status: 'RUNNING', nextCheckAt: new Date(Date.now() + BATCH_HEARTBEAT_MS) })
    expect(await runPublicationBatch(running.batchId, { submit })).toMatchObject({ claimed: false })
    expect(await statuses(running.ids)).toEqual(['PREVIEW'])
    expect(ids).toHaveLength(2)
  }))

  it('resumes a batch whose sender stopped: it sends only what was still waiting, never the destination caught mid-send', () => scoped(async () => {
    const { batchId, ids } = await batch([{ channel: 'AMAZON', account: 'a', market: 'IT', status: 'PUBLISHING' }, { channel: 'AMAZON', account: 'a', market: 'DE' }],
      { status: 'RUNNING', nextCheckAt: new Date(Date.now() - 1_000) })
    const { calls, submit } = recordingSubmit()
    const summary = await runPublicationBatch(batchId, { submit })
    expect(summary).toMatchObject({ claimed: true, submitted: 1, skipped: 1 })
    expect(calls.map(c => c.id)).toEqual([ids[1]])
    expect(await statuses(ids)).toEqual(['PUBLISHING', 'ACCEPTED'])
  }))

  it('stops before the next destination when the batch is cancelled while sending', () => scoped(async () => {
    const { batchId, ids } = await batch([{ channel: 'EBAY', account: 'e', market: 'IT' }, { channel: 'EBAY', account: 'e', market: 'DE' }, { channel: 'EBAY', account: 'e', market: 'FR' }])
    const { calls, submit } = recordingSubmit({ during: async id => {
      if (id === ids[0]) await prisma.bulkOperation.updateMany({ where: { id: batchId, status: 'RUNNING' }, data: { status: 'CANCELLING' } })
    } })
    const summary = await runPublicationBatch(batchId, { submit })
    expect(calls.map(c => c.id)).toEqual([ids[0]])
    expect(summary).toMatchObject({ submitted: 1, cancelled: 2 })
    expect(await statuses(ids)).toEqual(['ACCEPTED', 'CANCELLED', 'CANCELLED'])
    expect(await prisma.bulkOperation.findUnique({ where: { id: batchId } })).toMatchObject({ status: 'CANCELLED', nextCheckAt: null })
  }))

  it('keeps its heartbeat fresh while sending', () => scoped(async () => {
    const { batchId } = await batch([{ channel: 'EBAY', account: 'e', market: 'IT' }, { channel: 'EBAY', account: 'e', market: 'DE' }])
    const seen: Array<Date | null> = []
    const { submit } = recordingSubmit({ during: async () => { seen.push((await prisma.bulkOperation.findUnique({ where: { id: batchId } }))!.nextCheckAt) } })
    const before = Date.now()
    await runPublicationBatch(batchId, { submit })
    expect(seen).toHaveLength(2)
    for (const at of seen) expect(at!.getTime()).toBeGreaterThanOrEqual(before + BATCH_HEARTBEAT_MS - 1_000)
  }))

  it('the resume job re-queues only batches whose heartbeat went stale, and pushes a queued one back', () => scoped(async () => {
    const now = new Date()
    const staleQueued = await batch([{ channel: 'EBAY', account: 'e', market: 'IT' }], { status: 'QUEUED', nextCheckAt: new Date(now.getTime() - 1_000) })
    const staleRunning = await batch([{ channel: 'EBAY', account: 'e', market: 'DE' }], { status: 'RUNNING', nextCheckAt: new Date(now.getTime() - 1_000) })
    const fresh = await batch([{ channel: 'EBAY', account: 'e', market: 'FR' }], { status: 'RUNNING', nextCheckAt: new Date(now.getTime() + 60_000) })
    const finished = await batch([{ channel: 'EBAY', account: 'e', market: 'ES' }], { status: 'SENT', nextCheckAt: new Date(now.getTime() - 1_000) })
    const tick = await runPublicationBatchResumeTick(now)
    expect(fixture.dispatched).toEqual(expect.arrayContaining([staleQueued.batchId, staleRunning.batchId]))
    expect(fixture.dispatched).not.toContain(fresh.batchId)
    expect(fixture.dispatched).not.toContain(finished.batchId)
    expect(tick.requeued).toBeGreaterThanOrEqual(2)
    const queued = await prisma.bulkOperation.findUnique({ where: { id: staleQueued.batchId } })
    expect(queued!.nextCheckAt!.getTime()).toBe(now.getTime() + BATCH_HEARTBEAT_MS)
    const running = await prisma.bulkOperation.findUnique({ where: { id: staleRunning.batchId } })
    expect(running!.nextCheckAt!.getTime()).toBeLessThanOrEqual(now.getTime())
  }))
})
