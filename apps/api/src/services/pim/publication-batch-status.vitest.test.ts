import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Build shape v2, P11 — the products list's Publish… window sets one Status on many products × markets, on the real
 * schema and tenant policies.
 *
 * The request: a Status target (active, inactive, ended; never Delete), with or without the content; Ended is refused
 * to a role without products.delete and never goes with content. The review stage: one listing-action preview per
 * family × market × action, stamped as the batch's lifecycle child (send order, 2-hour life); a pair whose listings
 * need nothing keeps one child marked "nothing to send" with the reason; a pair the engine cannot read is recorded as
 * not reviewed; Active keeps only the action that sends (Resume or Relist); a relist holds that pair's content; a
 * resumed run reviews only what is missing. The submit: the "nothing to send" children are removed, the rest are
 * queued; Ended needs products.delete and the typed COUNT of listings it ends. The send: in the send order, through
 * the engine's seam; a channel switched off ends "Not sent".
 */
const fixture = vi.hoisted(() => ({ database: null as any, published: [] as any[], queued: [] as unknown[] }))

vi.mock('@nexus/database', async () => {
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../test-support/concurrent-database.js')
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  return { default: fixture.database.client }
})
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: (event: unknown) => { fixture.published.push(event) } }))
vi.mock('../../lib/queue.js', () => ({ publicationBatchQueue: { add: async (_name: string, data: unknown) => { fixture.queued.push(data) } } }))

import type { ListingAction, ListingActionPlanRow, ListingActionPreview, StatusTarget } from '@nexus/shared/listing-actions'
import { CONTENT_HELD_FOR_RELIST } from '@nexus/shared/publish-plan'
import type { StudioPublishReview, StudioPublishScope } from '@nexus/shared/studio-publication'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { BATCH_KIND, LIFECYCLE_KIND, manyOptionsOf, runPublicationBatch, statusPairKey, type BatchRunDeps } from './publication-batch.processor.js'
import { createPublicationBatch, readPublicationBatch, submitReviewedBatch } from './publication-batch.service.js'
import { keptStatusPreviews, reviewStatusPair, statusNothingMessage, type PublishPlanActor } from './publish-plan.js'
import { WorkspaceScopeError } from './workspace-destination.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const USER = 'status-user'
const PUBLISHER: PublishPlanActor = { userId: USER, can: permission => permission === 'products.publish' }
const OWNER: PublishPlanActor = { userId: USER, can: () => true }
const ids: Record<string, string> = {}
const AMAZON_IT: StudioPublishScope = { channel: 'AMAZON', marketplace: 'IT', accountId: 'amazon-a' }
const AMAZON_DE: StudioPublishScope = { channel: 'AMAZON', marketplace: 'DE', accountId: 'amazon-a' }
const EBAY_IT: StudioPublishScope = { channel: 'EBAY', marketplace: 'IT', accountId: 'ebay-a' }

type PlanOf = (familyId: string, action: ListingAction, scope: StudioPublishScope) => 'throw' | ListingActionPlanRow[]
const send = (sku: string, sentence = 'Stops selling here.'): ListingActionPlanRow => ({ productId: ids[sku] ?? sku, listingId: `l-${sku}`, sku, plan: 'send', sentence })
const skip = (sku: string, sentence: string): ListingActionPlanRow => ({ productId: ids[sku] ?? sku, listingId: `l-${sku}`, sku, plan: 'skip', sentence })
const refuse = (sku: string, sentence: string): ListingActionPlanRow => ({ productId: ids[sku] ?? sku, listingId: `l-${sku}`, sku, plan: 'refused', sentence })

/** A listing-action preview saved the way the engine saves it (kind 'listing-action', PREVIEW, 15 minutes, no batch). */
function fakeListingPreview(plan: PlanOf) {
  const calls: Array<{ familyId: string; action: ListingAction; scope: StudioPublishScope }> = []
  const preview = async (familyId: string, action: ListingAction, body: unknown, userId: string | null): Promise<ListingActionPreview> => {
    const scope = (body as { scope: StudioPublishScope }).scope
    calls.push({ familyId, action, scope })
    const rows = plan(familyId, action, scope)
    if (rows === 'throw') throw new WorkspaceScopeError('This account is not connected to this business.', 404)
    const previewId = `lp-${calls.length}-${action}-${scope.marketplace}-${Math.random().toString(36).slice(2, 8)}`
    const destination = { channel: scope.channel, marketplace: scope.marketplace, accountId: scope.accountId, aliasKey: '' }
    const sendCount = rows.filter(row => row.plan === 'send').length
    const made: ListingActionPreview = { previewId, action, destination, model: scope.channel === 'AMAZON' ? 'amazon' : 'ebay-trading', reach: 'row',
      consequence: `${scope.channel} · ${scope.marketplace}: ${action} ${sendCount}.`, checkedAtSend: null, confirm: { kind: 'checkbox', expected: null, token: null },
      rows, sendCount, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }
    await prisma.bulkOperation.create({ data: { id: previewId, userId, status: 'PREVIEW', productCount: rows.length, changeCount: sendCount,
      expiresAt: new Date(Date.now() + 15 * 60_000), kind: LIFECYCLE_KIND, productId: familyId, channel: scope.channel, marketplace: scope.marketplace,
      channelConnectionId: scope.accountId, aliasKey: '', changes: { kind: LIFECYCLE_KIND, action, requested: null, preview: made, reason: 'Publish' } as never } as never })
    return made
  }
  return { preview, calls }
}

/** One-click O5 — every family listed in every market (the presence read is tested in publication-batch-families). */
const listedEverywhere = async (families: string[], destinations: StudioPublishScope[] | null) => ({
  pairs: new Map(families.flatMap(family => (destinations ?? []).map(d => [statusPairKey(family, d), { presence: 'listed' as const, familySku: 'X' }]))),
  destinations: destinations ?? [] })

const statusDeps = (plan: PlanOf, extra: BatchRunDeps = {}) => {
  const fake = fakeListingPreview(plan)
  const deps: BatchRunDeps = { ...extra, statusReview: (batchId, pair, target, userId, ttlMs) => reviewStatusPair(batchId, pair, target, userId, ttlMs, { preview: fake.preview }) }
  return { deps, calls: fake.calls }
}

async function statusBatch(target: StatusTarget, destinations: StudioPublishScope[], families = [ids.coat, ids.glove], actor = OWNER, content?: boolean) {
  const { batchId } = await createPublicationBatch({ productIds: families, destinations, options: { status: target, ...(content !== undefined ? { content } : {}) } }, USER, actor)
  return batchId
}

describe('many products × markets with one Status (P11)', () => {
  beforeAll(async () => {
    await scoped(async () => {
      ids.coat = (await prisma.product.create({ data: { sku: 'SCOAT', name: 'Status coat', basePrice: 10, isParent: true } as never })).id
      ids['SCOAT-S'] = (await prisma.product.create({ data: { sku: 'SCOAT-S', name: 'Coat S', basePrice: 10, parentId: ids.coat } as never })).id
      ids['SCOAT-M'] = (await prisma.product.create({ data: { sku: 'SCOAT-M', name: 'Coat M', basePrice: 10, parentId: ids.coat } as never })).id
      ids.glove = (await prisma.product.create({ data: { sku: 'SGLOVE', name: 'Status glove', basePrice: 10 } as never })).id
      ids.SGLOVE = ids.glove
      ids.boot = (await prisma.product.create({ data: { sku: 'SBOOT', name: 'Status boot', basePrice: 10 } as never })).id
      ids.SBOOT = ids.boot
    })
    process.env.ENABLE_QUEUE_WORKERS = '1'
  }, 120_000)
  afterAll(async () => { delete process.env.ENABLE_QUEUE_WORKERS; await fixture.database?.close?.() })
  beforeEach(() => { fixture.published.length = 0; fixture.queued.length = 0 })

  it('the request: a Status without content by default; Ended needs products.delete and never goes with content; no Delete', () => scoped(async () => {
    const batchId = await statusBatch('inactive', [AMAZON_IT, AMAZON_DE], [ids['SCOAT-S'], ids.glove], PUBLISHER)
    const header = await prisma.bulkOperation.findUnique({ where: { id: batchId } })
    expect(header).toMatchObject({ kind: BATCH_KIND, status: 'QUEUED', productCount: 2 })
    expect((header!.changes as any).request).toMatchObject({ families: [ids.coat, ids.glove], options: { status: 'inactive', content: false, keepChannelValues: false } })
    // One-click O5 — Nexus wins by default; Keep channel values (or the older replaceDiffers: false) keeps the channel's values.
    expect(manyOptionsOf({})).toEqual({ keepChannelValues: false, status: null, content: true, startAs: null })
    expect(manyOptionsOf({ keepChannelValues: true }).keepChannelValues).toBe(true)
    expect(manyOptionsOf({ replaceDiffers: false }).keepChannelValues).toBe(true)
    expect(manyOptionsOf({ replaceDiffers: true }).keepChannelValues).toBe(false)
    expect(manyOptionsOf({ startAs: 'inactive' })).toMatchObject({ content: true, startAs: 'inactive' })
    expect(manyOptionsOf({ startAs: 'ended' }).startAs).toBeNull()
    expect(manyOptionsOf({ status: 'active', content: true })).toMatchObject({ status: 'active', content: true })
    await expect(statusBatch('ended', [AMAZON_IT], [ids.glove], PUBLISHER)).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('cannot end listings') })
    await expect(statusBatch('ended', [AMAZON_IT], [ids.glove], OWNER, true)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('gets no changes') })
    await expect(createPublicationBatch({ productIds: [ids.glove], destinations: [AMAZON_IT], options: { status: 'delete' } }, USER, OWNER)).rejects.toMatchObject({ statusCode: 400 })
    await expect(createPublicationBatch({ productIds: [ids.glove], destinations: [AMAZON_IT], options: { content: false } }, USER, OWNER)).rejects.toMatchObject({ statusCode: 400 })
  }))

  it('reviews every family × market with the engine\'s plan: one child per action, refusals kept, nothing-to-send marked, unreadable recorded', () => scoped(async () => {
    const batchId = await statusBatch('inactive', [AMAZON_IT, AMAZON_DE], [ids.coat, ids.glove, ids.boot])
    const { deps, calls } = statusDeps((family, _action, scope) => {
      if (family === ids.boot && scope.marketplace === 'DE') return 'throw'
      if (family === ids.coat) return [skip('SCOAT', 'The main product follows its variations.'), send('SCOAT-S'), refuse('SCOAT-M', 'Not available here.')]
      if (scope.marketplace === 'DE') return [skip(family === ids.glove ? 'SGLOVE' : 'SBOOT', 'Already inactive.')]
      return [send(family === ids.glove ? 'SGLOVE' : 'SBOOT')]
    })
    const summary = await runPublicationBatch(batchId, deps)
    expect(summary).toMatchObject({ claimed: true, reviewed: 5, notSent: 1 })
    expect(calls.every(call => call.action === 'pause')).toBe(true)
    expect(calls).toHaveLength(6)
    expect((await prisma.bulkOperation.findUnique({ where: { id: batchId } }))?.status).toBe('REVIEWED')
    const lifecycle = await prisma.bulkOperation.findMany({ where: { batchId, kind: LIFECYCLE_KIND } })
    expect(lifecycle).toHaveLength(5)
    for (const child of lifecycle) {
      expect(child).toMatchObject({ status: 'PREVIEW', batchId })
      expect(child.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000)
      expect((child.changes as any).batch).toMatchObject({ batchId, step: 'pause', familyId: child.productId, values: [] })
    }
    const view = await readPublicationBatch(batchId, USER)
    expect(view).toMatchObject({ phase: 'REVIEWED', request: { families: 3, destinations: 2, reviews: 6, reviewed: 6 } })
    const row = (family: string, market: string) => view.children.find(c => c.productId === family && c.marketplace === market)!
    expect(row(ids.coat, 'IT')).toMatchObject({ kind: 'lifecycle', action: 'pause', step: 'pause', sendCount: 1, familySku: 'SCOAT', nothingToSend: false })
    expect(row(ids.coat, 'IT').planRows?.map(r => `${r.sku}:${r.plan}`)).toEqual(['SCOAT:skip', 'SCOAT-S:send', 'SCOAT-M:refused'])
    expect(row(ids.glove, 'DE')).toMatchObject({ kind: 'lifecycle', sendCount: 0, nothingToSend: true, message: statusNothingMessage('inactive', [skip('SGLOVE', 'Already inactive.')]) })
    expect(row(ids.boot, 'DE')).toMatchObject({ kind: 'content', status: 'NOT_SENT', message: expect.stringContaining('not connected') })
  }))

  it('Active keeps only the action that sends (Relist or Resume); a relist holds that pair\'s content; content still reviews elsewhere', () => scoped(async () => {
    const batchId = await statusBatch('active', [EBAY_IT, AMAZON_IT], [ids.coat, ids.glove], OWNER, true)
    const { deps, calls } = statusDeps((family, action, scope) => {
      if (scope.channel === 'EBAY' && family === ids.coat) return action === 'relist' ? [send('SCOAT-S', 'Listed here again.'), send('SCOAT-M', 'Listed here again.')] : [skip('SCOAT-S', 'Ended — use Relist.')]
      return action === 'resume' ? [send(family === ids.glove ? 'SGLOVE' : 'SCOAT-S', 'Sells here again.')] : [skip('X', 'Not ended.')]
    })
    const reviewed: string[] = []
    const preview = async (familyId: string, scope: StudioPublishScope, userId: string | null, options: { batchId: string; expiresInMs: number }) => {
      reviewed.push(`${familyId}:${scope.channel}`)
      const id = `cr-${reviewed.length}-${Math.random().toString(36).slice(2, 8)}`
      await prisma.bulkOperation.create({ data: { id, userId, status: 'PREVIEW', productCount: 1, changeCount: 0, kind: 'studio-publication', productId: familyId,
        channel: scope.channel, marketplace: scope.marketplace, channelConnectionId: scope.accountId, aliasKey: '', batchId: options.batchId,
        expiresAt: new Date(Date.now() + options.expiresInMs), changes: { kind: 'studio-publication', productId: familyId, scope, publicationKey: id, changeVersion: 1, changePlan: {}, review: {} } as never } as never })
      return { id, changes: [] } as unknown as StudioPublishReview
    }
    await runPublicationBatch(batchId, { ...deps, presence: listedEverywhere, preview, select: async () => ({}) as never })
    expect(calls.map(c => c.action).sort()).toEqual(['relist', 'relist', 'relist', 'relist', 'resume', 'resume', 'resume', 'resume'])
    const lifecycle = await prisma.bulkOperation.findMany({ where: { batchId, kind: LIFECYCLE_KIND } })
    const ebayCoat = lifecycle.filter(c => c.productId === ids.coat && c.channel === 'EBAY')
    expect(ebayCoat.map(c => (c.changes as any).action)).toEqual(['relist'])
    expect(lifecycle.filter(c => c.channel === 'AMAZON').map(c => (c.changes as any).action)).toEqual(['resume', 'resume'])
    // The unused previews (the Relists that would send nothing, the Resume of the relisted family) are removed, not left behind.
    expect(await prisma.bulkOperation.count({ where: { kind: LIFECYCLE_KIND, batchId: null, productId: { in: [ids.coat, ids.glove] }, userId: USER, status: 'PREVIEW' } })).toBe(0)
    expect(reviewed.sort()).toEqual([`${ids.coat}:AMAZON`, `${ids.glove}:AMAZON`, `${ids.glove}:EBAY`].sort())
    const held = await prisma.bulkOperation.findFirst({ where: { batchId, kind: 'studio-publication', productId: ids.coat, channel: 'EBAY' } })
    expect(held).toMatchObject({ status: 'NOT_SENT' })
    expect((held!.summary as any).message).toContain(CONTENT_HELD_FOR_RELIST)
  }))

  it('a resumed review makes only the Status reviews still missing', () => scoped(async () => {
    const batchId = await statusBatch('inactive', [AMAZON_IT], [ids.coat, ids.glove])
    let made = 0
    const first = statusDeps(() => [send('SGLOVE')])
    await runPublicationBatch(batchId, { statusReview: async (...args) => {
      made += 1
      const out = await first.deps.statusReview!(...args)
      if (made === 1) await prisma.bulkOperation.update({ where: { id: batchId }, data: { status: 'CANCELLING' } })
      return out
    } })
    await prisma.bulkOperation.update({ where: { id: batchId }, data: { status: 'RUNNING', nextCheckAt: new Date(Date.now() - 1), completedAt: null } })
    const second = statusDeps(() => [send('SGLOVE')])
    await runPublicationBatch(batchId, second.deps)
    expect(second.calls.map(c => c.familyId)).toEqual([ids.glove])
    expect((await prisma.bulkOperation.findUnique({ where: { id: batchId } }))?.status).toBe('REVIEWED')
  }))

  it('submit: removes what sends nothing, queues the rest in the batch; the send goes through the engine\'s seam and a switched-off channel is Not sent', () => scoped(async () => {
    const batchId = await statusBatch('inactive', [AMAZON_IT, AMAZON_DE], [ids.coat, ids.glove])
    const { deps } = statusDeps((family, _action, scope) => scope.marketplace === 'DE' && family === ids.glove ? [skip('SGLOVE', 'Already inactive.')]
      : family === ids.coat ? [send('SCOAT-S'), send('SCOAT-M')] : [send('SGLOVE')])
    await runPublicationBatch(batchId, deps)
    const before = await prisma.bulkOperation.findMany({ where: { batchId, kind: LIFECYCLE_KIND } })
    const nothing = before.find(c => c.changeCount === 0)!
    const view = await submitReviewedBatch(batchId, {}, USER, PUBLISHER)
    expect(view.phase).toBe('QUEUED')
    expect(await prisma.bulkOperation.findUnique({ where: { id: nothing.id } })).toBeNull()
    const header = await prisma.bulkOperation.findUnique({ where: { id: batchId } })
    expect((header!.changes as any).children.sort()).toEqual(before.filter(c => c.id !== nothing.id).map(c => c.id).sort())
    expect(fixture.queued).toEqual([{ batchId }, { batchId }])
    const executed: string[] = []
    const summary = await runPublicationBatch(batchId, {
      gate: channel => channel === 'AMAZON' && executed.length >= 1 ? 'Amazon changes are switched off on this server (publish mode: dry-run). Nothing was changed.' : null,
      execute: async previewId => { executed.push(previewId); await prisma.bulkOperation.update({ where: { id: previewId }, data: { status: 'DONE' } })
        return { previewId, action: 'pause', status: 'DONE', message: 'done', rows: [] } },
      settleValues: async () => undefined,
    })
    expect(executed).toHaveLength(1)
    expect(summary).toMatchObject({ lifecycle: 1, notSent: 2 })
    const after = await readPublicationBatch(batchId, USER)
    expect(after).toMatchObject({ phase: 'SENT', done: true, counts: { succeeded: 1, notSent: 2 } })
    expect(after.children.filter(c => c.status === 'NOT_SENT').every(c => c.message?.includes('switched off'))).toBe(true)
  }))

  it('Ended: refused without products.delete; asks for the typed COUNT of listings it ends; then queues', () => scoped(async () => {
    const batchId = await statusBatch('ended', [EBAY_IT, AMAZON_IT], [ids.coat, ids.glove])
    const { deps } = statusDeps((family, _action, scope) => scope.channel === 'AMAZON' ? [refuse(family === ids.coat ? 'SCOAT-S' : 'SGLOVE', 'Amazon has no End. Set Inactive to pause this market, or Delete to remove the listing here.')]
      : family === ids.coat ? [send('SCOAT-S', 'Ends here.'), send('SCOAT-M', 'Ends here.'), send('SCOAT', 'Ends here.')] : [send('SGLOVE', 'Ends here.')])
    await runPublicationBatch(batchId, deps)
    const view = await readPublicationBatch(batchId, USER)
    expect(view.children.filter(c => c.channel === 'AMAZON').every(c => c.nothingToSend && c.message?.startsWith('Not possible here: Amazon has no End'))).toBe(true)
    await expect(submitReviewedBatch(batchId, { confirmText: '4' }, USER, PUBLISHER)).rejects.toMatchObject({ statusCode: 403 })
    await expect(submitReviewedBatch(batchId, {}, USER, OWNER)).rejects.toMatchObject({ statusCode: 400, code: 'confirm_required', message: 'Type 4 to end 4 listings.' })
    await expect(submitReviewedBatch(batchId, { confirmText: 'SCOAT' }, USER, OWNER)).rejects.toMatchObject({ code: 'confirm_required' })
    await expect(submitReviewedBatch(batchId, { confirmText: 3 }, USER, OWNER)).rejects.toMatchObject({ statusCode: 400 })
    // Nothing was marked or removed by a refused submit.
    expect(await prisma.bulkOperation.count({ where: { batchId, kind: LIFECYCLE_KIND, status: 'PREVIEW' } })).toBe(4)
    const sent = await submitReviewedBatch(batchId, { confirmText: ' 4 ' }, USER, OWNER)
    expect(sent.phase).toBe('QUEUED')
    expect(sent.children.map(c => `${c.channel}:${c.action}:${c.sendCount}`).sort()).toEqual(['EBAY:end:1', 'EBAY:end:3'])
  }))
})

describe('the Status review, pure parts', () => {
  it('keeps the previews that send; with none, the target\'s first action alone (it shows why)', () => {
    const p = (action: ListingAction, sendCount: number) => ({ action, sendCount })
    expect(keptStatusPreviews('active', [p('resume', 0), p('relist', 2)])).toEqual({ keep: [p('relist', 2)], drop: [p('resume', 0)] })
    expect(keptStatusPreviews('active', [p('resume', 3), p('relist', 2)]).keep).toHaveLength(2)
    expect(keptStatusPreviews('active', [p('resume', 0), p('relist', 0)])).toEqual({ keep: [p('resume', 0)], drop: [p('relist', 0)] })
    expect(keptStatusPreviews('inactive', [p('pause', 0)])).toEqual({ keep: [p('pause', 0)], drop: [] })
  })

  it('says why nothing changes: the first refusal, else already there', () => {
    expect(statusNothingMessage('inactive', [skip('A', 'Already inactive.'), refuse('B', 'Amazon has no End.')])).toBe('Not possible here: Amazon has no End.')
    expect(statusNothingMessage('ended', [skip('A', 'Already ended.')])).toBe('Nothing to change: every listing here is already ended, or not on the channel.')
  })
})
