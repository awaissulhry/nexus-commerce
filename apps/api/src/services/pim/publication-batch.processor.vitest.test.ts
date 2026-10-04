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
import { BATCH_HEARTBEAT_MS, BATCH_KIND, LIFECYCLE_KIND, LIFECYCLE_LEASE_MS, runPublicationBatch } from './publication-batch.processor.js'
import { LIFECYCLE_UNKNOWN } from '@nexus/shared/publish-plan'
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

beforeAll(async () => { await scoped(() => prisma.bulkOperation.count()) }, 120_000)
afterAll(async () => { await fixture.database?.close?.() })
beforeEach(() => { fixture.published.length = 0; fixture.dispatched.length = 0 })

describe('publication batch sender', () => {

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

/**
 * Build shape v2, P6 — a mixed Publish: content children (studio publications) and lifecycle children (listing-action
 * previews) in one batch. Per channel account: Resume and Relist, the content, Pause, End, Delete. A lifecycle child is
 * sent only from PREVIEW (the engine claims it PREVIEW → RUNNING), after a lease; one RUNNING past its lease is UNKNOWN.
 */
describe('lifecycle children (mixed Publish)', () => {
  type Child = { kind: 'content' | 'lifecycle'; action?: string; channel: string; account: string; market: string; status?: string; nextCheckAt?: Date | null }

  async function mixedBatch(children: Child[], header: { status?: string; nextCheckAt?: Date | null } = {}) {
    const batchId = `mixed-${++counter}`
    const ids: string[] = []
    for (const [at, child] of children.entries()) {
      const id = `${batchId}-${at}-${child.action ?? 'content'}-${child.market}`
      ids.push(id)
      const destination = { channel: child.channel, marketplace: child.market, accountId: child.account, aliasKey: '' }
      const changes = child.kind === 'content'
        ? { kind: 'studio-publication', productId: 'family-member', publicationKey: id, scope: { channel: child.channel, marketplace: child.market, accountId: child.account },
          batch: { batchId, body: { selectionToken: `token-${id}` } } }
        : { kind: LIFECYCLE_KIND, action: child.action, requested: ['p1'], preview: { consequence: `${child.action} on ${child.market}` },
          batch: { batchId, step: child.action, familyId: 'family', destination, values: [{ listingId: `listing-${id}`, productId: 'p1', column: 'status', setAt: '2026-10-04T10:00:00.000Z' }] } }
      await prisma.bulkOperation.create({ data: { id, userId: USER, status: child.status ?? 'PREVIEW', productCount: 1, changeCount: 1,
        kind: child.kind === 'content' ? 'studio-publication' : LIFECYCLE_KIND, productId: 'family', channel: child.channel, marketplace: child.market,
        channelConnectionId: child.account, aliasKey: '', batchId, expiresAt: new Date(Date.now() + 3_600_000), nextCheckAt: child.nextCheckAt ?? null, changes } as never })
    }
    await prisma.bulkOperation.create({ data: { id: batchId, userId: USER, status: header.status ?? 'QUEUED', kind: BATCH_KIND, productCount: ids.length, changeCount: 0,
      checkCount: 0, nextCheckAt: header.nextCheckAt === undefined ? new Date(Date.now() + BATCH_HEARTBEAT_MS) : header.nextCheckAt,
      changes: { kind: BATCH_KIND, stage: 'send', children: ids, cancelRequestedAt: null } } as never })
    return { batchId, ids }
  }

  /** Behaves like `executeListingAction` at its edges: claims PREVIEW → RUNNING (else 409), then stores the run's status. */
  function recordingExecute(options: { outcome?: Record<string, string>; throwBefore?: Set<string>; throwAfter?: Set<string>; during?: (id: string) => Promise<void> } = {}) {
    const calls: string[] = []
    const execute = async (previewId: string, opts: { actorUserId: string | null }) => {
      calls.push(previewId)
      expect(opts.actorUserId).toBe(USER)
      if (options.throwBefore?.has(previewId)) throw Object.assign(new Error('This change no longer exists. Open it again.'), { statusCode: 404 })
      const claimed = await prisma.bulkOperation.updateMany({ where: { id: previewId, status: 'PREVIEW' }, data: { status: 'RUNNING' } })
      if (!claimed.count) throw Object.assign(new Error('This change was already sent. Open it again to see its result.'), { statusCode: 409 })
      await options.during?.(previewId)
      if (options.throwAfter?.has(previewId)) throw new Error('database went away')
      const status = options.outcome?.[previewId] ?? 'DONE'
      await prisma.bulkOperation.update({ where: { id: previewId }, data: { status, completedAt: new Date(), summary: { message: status } } })
      return { previewId, action: 'pause' as const, status: status as 'DONE', message: status, rows: [] }
    }
    return { calls, execute }
  }

  const settled: any[] = []
  const settleValues = async (input: unknown) => { settled.push(input) }
  const live = () => null
  beforeEach(() => { settled.length = 0 })

  it('sends each channel account in the send order: Resume and Relist, the content, Pause, End, Delete', () => scoped(async () => {
    const { batchId, ids } = await mixedBatch([
      { kind: 'lifecycle', action: 'pause', channel: 'AMAZON', account: 'a', market: 'IT' },
      { kind: 'content', channel: 'AMAZON', account: 'a', market: 'IT' },
      { kind: 'lifecycle', action: 'delete', channel: 'AMAZON', account: 'a', market: 'IT' },
      { kind: 'lifecycle', action: 'resume', channel: 'AMAZON', account: 'a', market: 'DE' },
      { kind: 'content', channel: 'AMAZON', account: 'a', market: 'DE' },
      { kind: 'lifecycle', action: 'end', channel: 'EBAY', account: 'e', market: 'IT' },
      { kind: 'lifecycle', action: 'relist', channel: 'EBAY', account: 'e', market: 'DE' },
      { kind: 'content', channel: 'EBAY', account: 'e', market: 'FR' },
    ])
    const order: string[] = []
    const { submit } = recordingSubmit({ during: async id => { order.push(id) } })
    const { execute } = recordingExecute({ during: async id => { order.push(id) } })
    const summary = await runPublicationBatch(batchId, { submit, execute, gate: live, settleValues })
    expect(summary).toMatchObject({ claimed: true, submitted: 3, lifecycle: 5, notSent: 0, skipped: 0 })
    const amazon = order.filter(id => ids.indexOf(id) < 5)
    const ebay = order.filter(id => ids.indexOf(id) >= 5)
    expect(amazon).toEqual([ids[3], ids[1], ids[4], ids[0], ids[2]])
    expect(ebay).toEqual([ids[6], ids[7], ids[5]])
    expect(await statuses(ids)).toEqual(['DONE', 'ACCEPTED', 'DONE', 'DONE', 'ACCEPTED', 'DONE', 'DONE', 'ACCEPTED'])
    // Each lifecycle child hands its values and its result to the clear step; the lease is released.
    expect(settled).toHaveLength(5)
    expect(settled[0]).toMatchObject({ familyId: 'family', values: [expect.objectContaining({ column: 'status' })], result: expect.objectContaining({ status: 'DONE' }) })
    expect(await prisma.bulkOperation.count({ where: { id: { in: ids }, nextCheckAt: { not: null } } })).toBe(0)
    expect(await prisma.bulkOperation.findUnique({ where: { id: batchId } })).toMatchObject({ status: 'SENT' })
    expect(fixture.published).toEqual(expect.arrayContaining([expect.objectContaining({ publicationId: ids[0], status: 'DONE', terminal: true, batchId })]))
  }))

  it('a failed lifecycle child keeps going; a gated channel is NOT_SENT with its sentence; a refusal before the claim is NOT_SENT', () => scoped(async () => {
    const { batchId, ids } = await mixedBatch([
      { kind: 'lifecycle', action: 'pause', channel: 'AMAZON', account: 'a', market: 'IT' },
      { kind: 'lifecycle', action: 'resume', channel: 'AMAZON', account: 'a', market: 'DE' },
      { kind: 'lifecycle', action: 'pause', channel: 'SHOPIFY', account: 's', market: 'GLOBAL' },
    ])
    const { calls, execute } = recordingExecute({ outcome: { [ids[0]]: 'FAILED' }, throwBefore: new Set([ids[1]]) })
    const gate = (channel: string) => channel === 'SHOPIFY' ? 'Shopify changes are switched off on this server (publish mode: gated). Nothing was changed.' : null
    const summary = await runPublicationBatch(batchId, { execute, gate, settleValues })
    expect(calls.sort()).toEqual([ids[0], ids[1]].sort())
    expect(summary).toMatchObject({ lifecycle: 1, notSent: 2 })
    expect(await statuses(ids)).toEqual(['FAILED', 'NOT_SENT', 'NOT_SENT'])
    expect((await prisma.bulkOperation.findUnique({ where: { id: ids[2] } }))!.summary).toMatchObject({ message: 'Nothing was sent. Shopify changes are switched off on this server (publish mode: gated). Nothing was changed.' })
    expect((await prisma.bulkOperation.findUnique({ where: { id: ids[1] } }))!.summary).toMatchObject({ message: 'Nothing was sent. This change no longer exists. Open it again.' })
    // The failed child still hands its result over (the clear step keeps a failed row's value).
    expect(settled.map(s => s.result.status)).toEqual(['FAILED'])
  }))

  it('never sends a lifecycle child twice: one already run is skipped; one another run holds is waited for, then UNKNOWN', () => scoped(async () => {
    const lease = new Date(Date.now() + 10 * 60_000)
    const { batchId, ids } = await mixedBatch([
      { kind: 'lifecycle', action: 'pause', channel: 'AMAZON', account: 'a', market: 'IT', status: 'DONE' },
      { kind: 'lifecycle', action: 'pause', channel: 'AMAZON', account: 'a', market: 'DE', status: 'RUNNING', nextCheckAt: lease },
      { kind: 'lifecycle', action: 'delete', channel: 'AMAZON', account: 'a', market: 'FR' },
    ], { status: 'RUNNING', nextCheckAt: new Date(Date.now() - 1_000) })
    const { calls, execute } = recordingExecute()
    const first = await runPublicationBatch(batchId, { execute, gate: live, settleValues })
    expect(first).toMatchObject({ claimed: true, lifecycle: 1, skipped: 1 })
    expect(calls).toEqual([ids[2]])
    // The child another run holds is inside its lease: the batch is not finished, it looks again when the lease ends.
    expect(await prisma.bulkOperation.findUnique({ where: { id: batchId } })).toMatchObject({ status: 'RUNNING', nextCheckAt: lease })
    expect(await statuses(ids)).toEqual(['DONE', 'RUNNING', 'DONE'])
    expect(await runPublicationBatch(batchId, { execute, gate: live, settleValues })).toMatchObject({ claimed: false })
    // After the lease: the run that stopped never answered — UNKNOWN, never sent again, its values keep waiting.
    const later = new Date(lease.getTime() + 1_000)
    const second = await runPublicationBatch(batchId, { execute, gate: live, settleValues, now: () => later })
    expect(second).toMatchObject({ claimed: true, unknown: 1 })
    expect(second.lifecycle).toBeUndefined()
    expect(calls).toEqual([ids[2]])
    const unknown = await prisma.bulkOperation.findUnique({ where: { id: ids[1] } })
    expect(unknown).toMatchObject({ status: 'UNKNOWN', nextCheckAt: null, summary: { message: LIFECYCLE_UNKNOWN, unknown: true } })
    expect(settled.map(s => s.values[0].listingId)).toEqual([`listing-${ids[2]}`])
    expect(await prisma.bulkOperation.findUnique({ where: { id: batchId } })).toMatchObject({ status: 'SENT', nextCheckAt: null })
    const { batchView } = await import('./publication-batch.service.js')
    const view = batchView((await prisma.bulkOperation.findUnique({ where: { id: batchId } }))! as never, (await prisma.bulkOperation.findMany({ where: { batchId } })) as never)
    expect(view).toMatchObject({ done: true, outcome: 'PARTIAL', counts: { succeeded: 2, unknown: 1 } })
  }))

  it('a child that stopped after the engine claimed it is not sent again: the batch waits for its lease', () => scoped(async () => {
    const { batchId, ids } = await mixedBatch([{ kind: 'lifecycle', action: 'end', channel: 'EBAY', account: 'e', market: 'IT' }])
    const { execute } = recordingExecute({ throwAfter: new Set([ids[0]]) })
    const before = Date.now()
    await runPublicationBatch(batchId, { execute, gate: live, settleValues })
    const child = await prisma.bulkOperation.findUnique({ where: { id: ids[0] } })
    expect(child!.status).toBe('RUNNING')
    expect(child!.nextCheckAt!.getTime()).toBeGreaterThanOrEqual(before + LIFECYCLE_LEASE_MS - 1_000)
    expect(await prisma.bulkOperation.findUnique({ where: { id: batchId } })).toMatchObject({ status: 'RUNNING', nextCheckAt: child!.nextCheckAt })
    expect(settled).toEqual([])
  }))

  it('a cancel stops before the next child: lifecycle children not started are CANCELLED', () => scoped(async () => {
    const { batchId, ids } = await mixedBatch([
      { kind: 'lifecycle', action: 'resume', channel: 'EBAY', account: 'e', market: 'IT' },
      { kind: 'content', channel: 'EBAY', account: 'e', market: 'IT' },
      { kind: 'lifecycle', action: 'end', channel: 'EBAY', account: 'e', market: 'IT' },
    ])
    const { execute } = recordingExecute({ during: async () => {
      await prisma.bulkOperation.updateMany({ where: { id: batchId, status: 'RUNNING' }, data: { status: 'CANCELLING' } })
    } })
    const { calls, submit } = recordingSubmit()
    const summary = await runPublicationBatch(batchId, { execute, submit, gate: live, settleValues })
    expect(calls).toEqual([])
    expect(summary).toMatchObject({ lifecycle: 1, cancelled: 2 })
    expect(await statuses(ids)).toEqual(['DONE', 'CANCELLED', 'CANCELLED'])
  }))

  it('the lifecycle kind is the listing-action engine\'s', async () => {
    const { LISTING_ACTION_KIND } = await import('../listings/listing-action.service.js')
    expect(LIFECYCLE_KIND).toBe(LISTING_ACTION_KIND)
  })
})
