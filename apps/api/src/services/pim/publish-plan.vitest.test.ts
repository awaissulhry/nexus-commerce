import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Sheet publish parity, build shape v2, P6 — the mixed-plan Publish on the real schema and tenant policies (PGlite).
 * The waiting values, their states and the listing-action engine's plan are real; the studio's content review is a
 * stand-in that saves a review row as the real one does (the content engine has its own tests). Nothing calls a channel.
 */
const fixture = vi.hoisted(() => ({ database: null as any, events: [] as any[], queued: [] as string[], previews: [] as any[] }))

vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: fixture.database.client, prisma: fixture.database.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn(),
  publicationBatchQueue: { add: async (_name: string, data: { batchId: string }) => { fixture.queued.push(data.batchId) } } }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: (event: unknown) => { fixture.events.push(event) } }))

import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { CONTENT_HELD_FOR_DELETE, CONTENT_HELD_FOR_END } from '@nexus/shared/publish-actions'
import { deletedPublishSkip, deletedShort, deletedStatusReason, NOT_LISTED_LEFT_OUT, NOT_LISTED_MAIN_HELD } from '@nexus/shared/listing-actions'
import { ROLE_CANNOT_END_OR_DELETE, publishPlanCounts, type PublishPlan } from '@nexus/shared/publish-plan'
import type { StudioPublishChange, StudioPublishReview, StudioPublishScope } from '@nexus/shared/studio-publication'
import { readPublishActions, writePublishActions, type PublishActionActor } from '../listings/publish-action.service.js'
import { afterContentSettled, heldContent, parsePlanRowId, planRowId, reviewPublishPlan, settleLifecycleValues } from './publish-plan.js'
import { createPublicationBatch, readPublicationBatch } from './publication-batch.service.js'
import { LIFECYCLE_KIND } from './publication-batch.processor.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
const publisher = (userId = ids.anna): PublishActionActor => ({ userId, can: permission => permission === 'products.publish' })
const owner = (userId = ids.anna): PublishActionActor => ({ userId, can: () => true })

async function family(prefix: string, sizes: string[]) {
  const root = await prisma.product.create({ data: { sku: prefix, name: prefix, basePrice: 10, isParent: true, fulfillmentMethod: 'FBM' } as never })
  const children: Record<string, string> = {}
  for (const size of sizes) children[size] = (await prisma.product.create({ data: { sku: `${prefix}-${size}`, name: `${prefix} ${size}`, basePrice: 10, parentId: root.id, fulfillmentMethod: 'FBM' } as never })).id
  return { root: root.id, children }
}

async function listing(productId: string, channel: string, marketplace: string, account: string, extra: Record<string, unknown> = {}) {
  return (await prisma.channelListing.create({ data: {
    productId, channel, marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`, channelConnectionId: account, aliasKey: '',
    fulfillmentMethod: 'FBM', listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'EXT', quantity: 5, price: 10, ...extra,
  } as never })).id
}

const stored = (id: string) => prisma.channelListing.findUnique({ where: { id }, select: { publishAction: true, publishActionAt: true, sellingTarget: true, sellingTargetAt: true } })
const amazonIT = (): StudioPublishScope => ({ channel: 'AMAZON', marketplace: 'IT', accountId: ids.amazon })
const ebayIT = (): StudioPublishScope => ({ channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay })

/** A stand-in for the studio's review: one title change per variation (a Full update row: two locked changes), saved as the real one saves it. */
async function fakePreview(productId: string, scope: StudioPublishScope, userId: string | null, options: { fullProductIds?: string[] }): Promise<StudioPublishReview> {
  fixture.previews.push({ productId, scope, options })
  const seed = (await prisma.product.findUnique({ where: { id: productId }, select: { id: true, parentId: true } }))!
  const familyId = seed.parentId ?? seed.id
  const products = await prisma.product.findMany({ where: { OR: [{ id: familyId }, { parentId: familyId }] }, select: { id: true, sku: true, parentId: true }, orderBy: { sku: 'asc' } })
  const full = new Set(options.fullProductIds ?? [])
  const change = (p: { id: string; sku: string }, field: string): StudioPublishChange => ({ id: `${p.id}:${field}`, productId: p.id, sku: p.sku, field, label: field,
    current: { state: 'value', value: 'new' }, lastAccepted: { state: 'value', value: 'old' }, channel: { state: 'value', value: 'old' }, status: 'SEND',
    localChanged: true, channelChanged: false, selectable: true, selectedByDefault: true, reason: 'Changed in Nexus', operation: 'replace',
    ...(full.has(p.id) ? { locked: true } : {}) })
  const changes = products.filter(p => p.parentId).flatMap(p => full.has(p.id) ? [change(p, 'item_name'), change(p, 'bullet_point')] : [change(p, 'item_name')])
  const id = randomUUID()
  const expiresAt = new Date(Date.now() + 15 * 60_000)
  const review: StudioPublishReview = { id, productId, scope, accountLabel: 'acc', aliasLabel: '', mode: 'live', action: 'update', excluded: 0, issues: [],
    expiresAt: expiresAt.toISOString(), changes,
    rows: products.map(p => ({ productId: p.id, sku: p.sku, title: p.sku, existing: true, mode: full.has(p.id) ? 'full' as const : 'partial' as const })) }
  await prisma.bulkOperation.create({ data: { id, userId, status: 'PREVIEW', productCount: products.length, changeCount: 0, kind: 'studio-publication', productId: familyId,
    channel: scope.channel, marketplace: scope.marketplace, channelConnectionId: scope.accountId, aliasKey: '', expiresAt,
    changes: { kind: 'studio-publication', publicationKey: `key-${id}`, productId, scope, revision: 'r1', changeVersion: 1, changePlan: { kind: 'amazon-changes', changes }, review,
      ...(full.size ? { fullProductIds: [...full].sort() } : {}) } } as never })
  return review
}

/** What the tick route would store: the token and the ticked ids. */
async function tick(reviewId: string, selectedIds: string[]) {
  const row = (await prisma.bulkOperation.findUnique({ where: { id: reviewId } }))!
  const token = `token-${reviewId}`
  await prisma.bulkOperation.update({ where: { id: reviewId }, data: { changes: { ...(row.changes as object), selection: { token, selectedIds } } as never } })
  return token
}

const lifecycleOf = (plan: PublishPlan, sku: string) => plan.destinations.flatMap(d => d.lifecycle).find(row => row.sku === sku)!

beforeAll(async () => {
  await scoped(async () => {
    for (const [channel, code] of [['AMAZON', 'IT'], ['EBAY', 'IT']] as const)
      await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never })
    ids.amazon = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'pp-amazon', isActive: true, isPrimary: true } as never })).id
    ids.ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'pp-ebay', externalAccountId: 'pp-ebay-1', isActive: true, isPrimary: true } as never })).id
    ids.anna = (await prisma.userProfile.create({ data: { displayName: 'Anna', email: 'anna@publish-plan.test' } })).id
    ids.bruno = (await prisma.userProfile.create({ data: { displayName: 'Bruno', email: 'bruno@publish-plan.test' } })).id
  })
}, 120_000)
beforeEach(() => { fixture.events.length = 0; fixture.queued.length = 0; fixture.previews.length = 0 })
afterAll(async () => { delete process.env.ENABLE_QUEUE_WORKERS; await fixture.database?.close() })

/** Amazon IT: S Full update, M Delete, L Inactive (mine), X Inactive (Bruno's: stale), O Inactive but already paused (outgrown). */
async function amazonMix(prefix: string) {
  const f = await family(prefix, ['L', 'M', 'O', 'S', 'X'])
  const l: Record<string, string> = { root: await listing(f.root, 'AMAZON', 'IT', ids.amazon) }
  for (const size of ['L', 'M', 'O', 'S', 'X']) l[size] = await listing(f.children[size], 'AMAZON', 'IT', ids.amazon)
  await writePublishActions(f.root, { listingIds: [l.S], change: { column: 'send', mode: 'full' } }, publisher())
  await writePublishActions(f.root, { listingIds: [l.M], change: { column: 'send', mode: 'delete' } }, owner())
  await writePublishActions(f.root, { listingIds: [l.L, l.O], change: { column: 'status', target: 'inactive' } }, publisher())
  await writePublishActions(f.root, { listingIds: [l.X], change: { column: 'status', target: 'inactive' } }, publisher(ids.bruno))
  await prisma.channelListing.update({ where: { id: l.O }, data: { offerClosedAt: new Date(), offerCloseReason: 'sheet-pause' } })
  return { f, l }
}

describe('the review of one Publish', () => {
  it('mixes Full, Partial, Delete and Status rows: Delete holds that row\'s content, stale values start unticked, outgrown values are listed', () => scoped(async () => {
    const { f, l } = await amazonMix('PP-MIX')
    const plan = await reviewPublishPlan(f.children.S, { destinations: [amazonIT()] }, owner(), { preview: fakePreview })
    expect(plan).toMatchObject({ familyId: f.root, familySku: 'PP-MIX', canDelete: true, confirm: { expected: 'PP-MIX', rows: 1 } })
    const d = plan.destinations[0]
    expect(d).toMatchObject({ label: 'Amazon · IT', destination: { channel: 'AMAZON', marketplace: 'IT', accountId: ids.amazon, aliasKey: '' }, error: null,
      fullProductIds: [f.children.S], contentHeld: [{ productId: f.children.M, sku: 'PP-MIX-M', reason: CONTENT_HELD_FOR_DELETE }] })
    // The content review was made with the Full update rows; the held row cannot be ticked, there and in the saved review.
    expect(fixture.previews).toEqual([{ productId: f.children.S, scope: amazonIT(), options: { fullProductIds: [f.children.S] } }])
    const heldChange = d.review!.changes!.find(c => c.productId === f.children.M)!
    expect(heldChange).toMatchObject({ selectable: false, selectedByDefault: false, reason: CONTENT_HELD_FOR_DELETE })
    expect(d.review!.rows.find(r => r.productId === f.children.M)).toMatchObject({ blocked: CONTENT_HELD_FOR_DELETE })
    const saved = (await prisma.bulkOperation.findUnique({ where: { id: d.review!.id! } }))!.changes as any
    expect(saved.changePlan.changes.find((c: any) => c.productId === f.children.M)).toMatchObject({ selectable: false, reason: CONTENT_HELD_FOR_DELETE })
    expect(saved.review.changes.find((c: any) => c.productId === f.children.M)).toMatchObject({ selectable: false })
    // One lifecycle row per waiting value, in the send order (pause before delete).
    expect(d.lifecycle.map(r => [r.sku, r.action, r.step])).toEqual([['PP-MIX-L', 'pause', 'pause'], ['PP-MIX-X', 'pause', 'pause'], ['PP-MIX-M', 'delete', 'delete']])
    expect(lifecycleOf(plan, 'PP-MIX-L')).toMatchObject({ listingId: l.L, column: 'status', value: 'inactive', state: 'active', stale: false, tickedByDefault: true,
      needsTypedConfirm: false, refused: null, sentence: 'Stops selling here.', consequence: expect.stringMatching(/^Amazon · IT stops selling 2 SKUs/), setByName: 'Anna' })
    expect(lifecycleOf(plan, 'PP-MIX-X')).toMatchObject({ stale: true, tickedByDefault: false, setByName: 'Bruno', refused: null })
    expect(lifecycleOf(plan, 'PP-MIX-M')).toMatchObject({ column: 'send', value: 'delete', needsTypedConfirm: true, tickedByDefault: true, consequence: expect.stringMatching(/cannot be undone/) })
    expect(parsePlanRowId(lifecycleOf(plan, 'PP-MIX-L').id)).toMatchObject({ column: 'status', listingId: l.L, action: 'pause' })
    expect(d.outgrown).toEqual([expect.objectContaining({ listingId: l.O, sku: 'PP-MIX-O', column: 'status', value: 'inactive', reason: 'Already inactive.' })])
    // The summary with the default ticks: M's content is held, X is unticked.
    expect(plan.counts).toEqual({ partial: 3, fields: 3, full: 1, delete: 1, active: 0, inactive: 1, ended: 0 })
    expect(plan.summary).toBe('3 partial updates (3 fields) · 1 full update · 1 inactive · 1 delete')
    // Ticking X and unticking the delete counts again.
    expect(publishPlanCounts(plan, { lifecycle: [lifecycleOf(plan, 'PP-MIX-L').id, lifecycleOf(plan, 'PP-MIX-X').id] })).toMatchObject({ inactive: 2, delete: 0 })
  }))

  it('S11 follow-up — an End or Delete row is named by the SKU the channel holds for that listing, not the product SKU', () => scoped(async () => {
    const f = await family('PP-OWN', ['L', 'M'])
    await listing(f.root, 'AMAZON', 'IT', ids.amazon)
    const lL = await listing(f.children.L, 'AMAZON', 'IT', ids.amazon)
    const lM = await listing(f.children.M, 'AMAZON', 'IT', ids.amazon, { channelSku: 'PP-OWN-M-IT', liveChannelSku: 'PP-OWN-M-IT' })
    await writePublishActions(f.root, { listingIds: [lL, lM], change: { column: 'send', mode: 'delete' } }, owner())
    const plan = await reviewPublishPlan(f.root, { destinations: [amazonIT()] }, owner(), { preview: fakePreview })
    expect(plan.destinations[0].lifecycle.map(r => [r.listingId, r.sku, r.action])).toEqual([[lL, 'PP-OWN-L', 'delete'], [lM, 'PP-OWN-M-IT', 'delete']])
    // The typed confirmation stays the family SKU (one phrase for the whole Publish).
    expect(plan.confirm).toEqual({ expected: 'PP-OWN', rows: 2 })
  }))

  it('eBay End holds every row\'s content: no review is made (no channel read), the End row says what eBay does', () => scoped(async () => {
    const f = await family('PP-END', ['M', 'S'])
    const root = await listing(f.root, 'EBAY', 'IT', ids.ebay, { externalListingId: '1234' })
    await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '1234' })
    await listing(f.children.M, 'EBAY', 'IT', ids.ebay, { externalListingId: '1234' })
    await writePublishActions(f.root, { listingIds: [root], change: { column: 'status', target: 'ended' } }, owner())
    const plan = await reviewPublishPlan(f.root, { destinations: [ebayIT()] }, owner(), { preview: fakePreview })
    const d = plan.destinations[0]
    expect(fixture.previews).toEqual([])
    expect(d.review).toBeNull()
    expect(d.contentHeld.map(r => [r.sku, r.reason])).toEqual([['PP-END', CONTENT_HELD_FOR_END], ['PP-END-M', CONTENT_HELD_FOR_END], ['PP-END-S', CONTENT_HELD_FOR_END]])
    expect(d.lifecycle).toEqual([expect.objectContaining({ listingId: root, isParent: true, action: 'end', step: 'end', needsTypedConfirm: true, tickedByDefault: true,
      sentence: expect.stringMatching(/eBay ends PP-END and all 2 variations on eBay · IT/) })])
    expect(plan.summary).toBe('1 ended')
  }))

  it('a role without products.delete: Delete is refused and keeps waiting, so it holds no content; nothing to confirm', () => scoped(async () => {
    const f = await family('PP-ROLE', ['L', 'M'])
    await listing(f.root, 'AMAZON', 'IT', ids.amazon)
    const lL = await listing(f.children.L, 'AMAZON', 'IT', ids.amazon)
    const lM = await listing(f.children.M, 'AMAZON', 'IT', ids.amazon)
    await writePublishActions(f.root, { listingIds: [lM], change: { column: 'send', mode: 'delete' } }, owner())
    await writePublishActions(f.root, { listingIds: [lL], change: { column: 'status', target: 'inactive' } }, publisher())
    const plan = await reviewPublishPlan(f.root, { destinations: [amazonIT()] }, publisher(), { preview: fakePreview })
    expect(plan).toMatchObject({ canDelete: false, confirm: null })
    expect(plan.destinations[0].contentHeld).toEqual([])
    expect(lifecycleOf(plan, 'PP-ROLE-M')).toMatchObject({ refused: ROLE_CANNOT_END_OR_DELETE, tickedByDefault: false })
    expect(lifecycleOf(plan, 'PP-ROLE-L')).toMatchObject({ refused: null, tickedByDefault: true })
    expect(plan.counts).toMatchObject({ delete: 0, inactive: 1 })
  }))

  it('refuses a malformed request, and names a destination it cannot resolve without failing the others', () => scoped(async () => {
    const f = await family('PP-BAD', ['S'])
    await expect(reviewPublishPlan(f.root, { destinations: [] }, owner(), { preview: fakePreview })).rejects.toMatchObject({ statusCode: 400 })
    await expect(reviewPublishPlan(f.root, { destinations: [amazonIT(), amazonIT()] }, owner(), { preview: fakePreview })).rejects.toMatchObject({ statusCode: 400 })
    const plan = await reviewPublishPlan(f.root, { destinations: [amazonIT(), { channel: 'AMAZON', marketplace: 'ZZ', accountId: ids.amazon }] }, owner(), { preview: fakePreview })
    expect(plan.destinations[0].error).toBeNull()
    expect(plan.destinations[1]).toMatchObject({ review: null, error: expect.stringMatching(/unavailable in the selected market/) })
  }))
})

describe('heldContent (pure)', () => {
  const products = [{ productId: 'root', sku: 'F' }, { productId: 's', sku: 'F-S' }, { productId: 'm', sku: 'F-M' }]
  it('Amazon holds only the rows being deleted, every row when it is the main row; a refused value holds nothing', () => {
    expect(heldContent('AMAZON', 'root', [{ productId: 's', action: 'delete' }, { productId: 'm', action: 'pause' }], products)).toEqual([{ productId: 's', sku: 'F-S', reason: CONTENT_HELD_FOR_DELETE }])
    expect(heldContent('AMAZON', 'root', [{ productId: 'root', action: 'delete' }], products)).toHaveLength(3)
    expect(heldContent('AMAZON', 'root', [{ productId: 's', action: 'delete', refused: 'no' }], products)).toEqual([])
  })
  it('eBay and Shopify hold the whole listing for End, Delete or Relist, never for Pause or Resume', () => {
    expect(heldContent('EBAY', 'root', [{ productId: 'root', action: 'relist' }], products).map(r => r.productId)).toEqual(['root', 's', 'm'])
    expect(heldContent('SHOPIFY', 'root', [{ productId: 's', action: 'pause' }, { productId: 'm', action: 'resume' }], products)).toEqual([])
    expect(heldContent('EBAY', 'root', [{ productId: 'root', action: 'end' }, { productId: 'root', action: 'delete' }], products)[0].reason).toBe(CONTENT_HELD_FOR_DELETE)
  })
  it('row ids pin the value: column, listing, when it was set and the action', () => {
    const at = '2026-10-04T10:00:00.000Z'
    expect(parsePlanRowId(planRowId('send', 'cl1', at, 'delete'))).toEqual({ column: 'send', listingId: 'cl1', setAt: new Date(at), action: 'delete' })
    expect(parsePlanRowId(planRowId('status', 'cl1', at, null))).toMatchObject({ action: null })
    expect(parsePlanRowId('v1:status:cl1:nope:pause')).toBeNull()
    expect(parsePlanRowId('v2:status:cl1:1:pause')).toBeNull()
  })
})

describe('the send: one batch header with content and lifecycle children', () => {
  beforeAll(() => { process.env.ENABLE_QUEUE_WORKERS = '1' })

  it('stamps the review and one lifecycle child per destination × action, in the send order; clears the outgrown values; queues once', () => scoped(async () => {
    const { f, l } = await amazonMix('PP-SEND')
    const plan = await reviewPublishPlan(f.root, { destinations: [amazonIT()] }, owner(), { preview: fakePreview })
    const d = plan.destinations[0]
    const token = await tick(d.review!.id!, d.review!.changes!.filter(c => c.selectable).map(c => c.id))
    const lifecycle = [lifecycleOf(plan, 'PP-SEND-L').id, lifecycleOf(plan, 'PP-SEND-M').id]
    const { batchId } = await createPublicationBatch({ plan: { productId: f.root, destinations: [{ scope: amazonIT(), reviewId: d.review!.id, selectionToken: token }],
      lifecycle, outgrown: d.outgrown.map(o => o.id), confirmText: ' PP-SEND ' } }, ids.anna, owner())
    expect(fixture.queued).toEqual([batchId])
    const children = await prisma.bulkOperation.findMany({ where: { batchId }, orderBy: { createdAt: 'asc' } })
    const pause = children.find(c => c.kind === LIFECYCLE_KIND && (c.changes as any).action === 'pause')!
    const del = children.find(c => c.kind === LIFECYCLE_KIND && (c.changes as any).action === 'delete')!
    const header = (await prisma.bulkOperation.findUnique({ where: { id: batchId } }))!
    expect(header).toMatchObject({ kind: 'publication-batch', status: 'QUEUED', productId: f.root, userId: ids.anna })
    expect((header.changes as any).children).toEqual([d.review!.id, pause.id, del.id])
    expect(children.find(c => c.id === d.review!.id)).toMatchObject({ status: 'PREVIEW', changes: expect.objectContaining({ batch: { batchId, body: { selectionToken: token } } }) })
    expect(pause).toMatchObject({ status: 'PREVIEW', userId: ids.anna, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: ids.amazon,
      changes: expect.objectContaining({ requested: [f.children.L], batch: { batchId, step: 'pause', familyId: f.root, destination: plan.destinations[0].destination,
        values: [{ listingId: l.L, productId: f.children.L, column: 'status', setAt: (await stored(l.L))!.sellingTargetAt!.toISOString() }] } }) })
    expect(del).toMatchObject({ status: 'PREVIEW', changes: expect.objectContaining({ requested: [f.children.M], batch: expect.objectContaining({ step: 'delete' }) }) })
    // The unticked stale value (X) is not a child and keeps waiting; the outgrown value (O) is cleared; the sent ones wait for their result.
    expect(children.filter(c => c.kind === LIFECYCLE_KIND)).toHaveLength(2)
    expect(await stored(l.X)).toMatchObject({ sellingTarget: 'INACTIVE' })
    expect(await stored(l.O)).toMatchObject({ sellingTarget: null })
    expect(await stored(l.L)).toMatchObject({ sellingTarget: 'INACTIVE' })
    expect(await stored(l.M)).toMatchObject({ publishAction: 'DELETE' })
    const view = await readPublicationBatch(batchId, ids.anna)
    expect(view.children.map(c => [c.kind, c.action, c.step, c.status])).toEqual([['content', null, 'content', 'PREVIEW'], ['lifecycle', 'pause', 'pause', 'PREVIEW'], ['lifecycle', 'delete', 'delete', 'PREVIEW']])
    expect(view.children[1].message).toMatch(/^Amazon · IT stops selling 1 SKU/)
    expect(view.counts).toMatchObject({ total: 3, waiting: 3, unknown: 0 })
  }))

  it('refuses a ticked row whose value changed since the review, and Ended or Delete without the typed SKU', () => scoped(async () => {
    const { f, l } = await amazonMix('PP-REFUSE')
    const plan = await reviewPublishPlan(f.root, { destinations: [amazonIT()] }, owner(), { preview: fakePreview })
    const body = (lifecycle: string[], confirmText?: string) => ({ plan: { productId: f.root, destinations: [{ scope: amazonIT() }], lifecycle, confirmText } })
    await expect(createPublicationBatch(body([lifecycleOf(plan, 'PP-REFUSE-M').id]), ids.anna, owner())).rejects.toMatchObject({ statusCode: 400, code: 'confirm_required', message: 'Type PP-REFUSE to end or delete listings.' })
    await expect(createPublicationBatch(body([lifecycleOf(plan, 'PP-REFUSE-M').id], 'PP-OTHER'), ids.anna, owner())).rejects.toMatchObject({ code: 'confirm_required' })
    await new Promise(resolve => setTimeout(resolve, 5))
    await writePublishActions(f.root, { listingIds: [l.L], change: { column: 'status', target: 'inactive' } }, publisher(ids.bruno))
    await expect(createPublicationBatch(body([lifecycleOf(plan, 'PP-REFUSE-L').id]), ids.anna, owner())).rejects.toMatchObject({ statusCode: 409, code: 'changed', message: expect.stringMatching(/PP-REFUSE-L: its waiting value changed since the review \(Bruno\)/) })
    await expect(createPublicationBatch(body([]), ids.anna, owner())).rejects.toMatchObject({ statusCode: 400 })
    await expect(createPublicationBatch({ plan: { productId: f.root, destinations: [{ scope: ebayIT() }], lifecycle: [lifecycleOf(plan, 'PP-REFUSE-X').id] } }, ids.anna, owner()))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/not in this Publish/) })
    expect(await prisma.bulkOperation.count({ where: { kind: 'publication-batch', productId: f.root } })).toBe(0)
  }))

  it('without products.delete, the Delete child is recorded NOT_SENT and keeps its value; the rest still goes', () => scoped(async () => {
    const { f, l } = await amazonMix('PP-NODEL')
    const plan = await reviewPublishPlan(f.root, { destinations: [amazonIT()] }, owner(), { preview: fakePreview })
    const { batchId } = await createPublicationBatch({ plan: { productId: f.root, destinations: [{ scope: amazonIT() }],
      lifecycle: [lifecycleOf(plan, 'PP-NODEL-L').id, lifecycleOf(plan, 'PP-NODEL-M').id] } }, ids.anna, publisher())
    const children = await prisma.bulkOperation.findMany({ where: { batchId } })
    expect(children.map(c => [(c.changes as any).action, c.status]).sort()).toEqual([['delete', 'NOT_SENT'], ['pause', 'PREVIEW']])
    expect(children.find(c => (c.changes as any).action === 'delete')!.summary).toMatchObject({ message: ROLE_CANNOT_END_OR_DELETE })
    expect(await stored(l.M)).toMatchObject({ publishAction: 'DELETE' })
    expect((await readPublicationBatch(batchId, ids.anna)).counts).toMatchObject({ waiting: 1, notSent: 1 })
  }))

  it('refuses a content review that ticks a row being deleted (a review made outside the plan)', () => scoped(async () => {
    const { f } = await amazonMix('PP-HELD')
    const review = await fakePreview(f.root, amazonIT(), ids.anna, {})
    const token = await tick(review.id!, review.changes!.map(c => c.id))
    await expect(createPublicationBatch({ plan: { productId: f.root, destinations: [{ scope: amazonIT(), reviewId: review.id, selectionToken: token }], lifecycle: [] } }, ids.anna, owner()))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/PP-HELD-M: This listing is being deleted/) })
    expect(await prisma.bulkOperation.findUnique({ where: { id: review.id! } })).toMatchObject({ batchId: null, status: 'PREVIEW' })
  }))
})

describe('after a child: clear what was done, keep what failed', () => {
  it('a lifecycle child clears the values it did and those the listing outgrew; a failure keeps its value', () => scoped(async () => {
    const f = await family('PP-SETTLE', ['L', 'X'])
    const lL = await listing(f.children.L, 'AMAZON', 'IT', ids.amazon)
    const lX = await listing(f.children.X, 'AMAZON', 'IT', ids.amazon)
    await writePublishActions(f.root, { listingIds: [lL, lX], change: { column: 'status', target: 'inactive' } }, publisher())
    const value = async (listingId: string, productId: string) => ({ listingId, productId, column: 'status' as const, setAt: (await stored(listingId))!.sellingTargetAt!.toISOString() })
    const values = [await value(lL, f.children.L), await value(lX, f.children.X)]
    // The engine paused L (it wrote the hold); X failed on the channel.
    await prisma.channelListing.update({ where: { id: lL }, data: { offerClosedAt: new Date(), offerCloseReason: 'sheet-pause' } })
    const result = { previewId: 'p', action: 'pause' as const, status: 'PARTIAL' as const, message: '', rows: [
      { productId: f.children.L, listingId: lL, sku: 'PP-SETTLE-L', outcome: 'DONE' as const, message: 'Paused' },
      { productId: f.children.X, listingId: lX, sku: 'PP-SETTLE-X', outcome: 'FAILED' as const, message: 'Amazon refused' }] }
    const destination = { channel: 'AMAZON', marketplace: 'IT', accountId: ids.amazon, aliasKey: '' }
    expect(await settleLifecycleValues({ familyId: f.root, destination, values, result })).toEqual({ cleared: [lL], kept: [lX] })
    expect(await stored(lL)).toMatchObject({ sellingTarget: null })
    expect(await stored(lX)).toMatchObject({ sellingTarget: 'INACTIVE' })
    // UNKNOWN (no result): nothing is cleared.
    expect(await settleLifecycleValues({ familyId: f.root, destination, values: [values[1]], result: null })).toEqual({ cleared: [], kept: [lX] })
  }))

  it('Full update resets when the channel accepted that row; a failed row, or a value set after the review, keeps it', () => scoped(async () => {
    const f = await family('PP-FULL', ['M', 'N', 'S'])
    const lS = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon)
    const lM = await listing(f.children.M, 'AMAZON', 'IT', ids.amazon)
    const lN = await listing(f.children.N, 'AMAZON', 'IT', ids.amazon)
    await writePublishActions(f.root, { listingIds: [lS, lM], change: { column: 'send', mode: 'full' } }, publisher())
    await new Promise(resolve => setTimeout(resolve, 5))
    const publicationId = randomUUID()
    const data = { kind: 'studio-publication', productId: f.root, scope: amazonIT(), delivery: { aliasKey: '', productIds: [f.children.S, f.children.M, f.children.N] },
      fullProductIds: [f.children.M, f.children.N, f.children.S] }
    await prisma.bulkOperation.create({ data: { id: publicationId, userId: ids.anna, status: 'PARTIAL', productCount: 3, changeCount: 3, kind: 'studio-publication',
      productId: f.root, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: ids.amazon, aliasKey: '', changes: data } as never })
    await new Promise(resolve => setTimeout(resolve, 5))
    // N is set to Full after the review: someone's new choice.
    await writePublishActions(f.root, { listingIds: [lN], change: { column: 'send', mode: 'full' } }, publisher())
    for (const [listingId, outcome] of [[lS, 'ACCEPTED'], [lM, 'FAILED'], [lN, 'ACCEPTED']] as const)
      await prisma.channelListingSnapshot.create({ data: { channelListingId: listingId, channel: 'AMAZON', marketplace: 'IT', aliasKey: '', reason: 'publish',
        publishEventId: publicationId, outcome, payload: {} } as never })
    expect(await afterContentSettled(publicationId, data, { status: 'PARTIAL' })).toEqual([lS])
    expect(await stored(lS)).toMatchObject({ publishAction: null })
    expect(await stored(lM)).toMatchObject({ publishAction: 'FULL_UPDATE' })
    expect(await stored(lN)).toMatchObject({ publishAction: 'FULL_UPDATE' })
    // A publication reviewed without Full update rows does nothing.
    expect(await afterContentSettled(publicationId, { ...data, fullProductIds: undefined }, { status: 'ACCEPTED' })).toEqual([])
  }))

  it('eBay keeps the whole item\'s Full update on the main row: it resets when the publication as a whole is accepted', () => scoped(async () => {
    const f = await family('PP-EBFULL', ['S'])
    const root = await listing(f.root, 'EBAY', 'IT', ids.ebay, { externalListingId: '4321' })
    await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '4321' })
    await writePublishActions(f.root, { listingIds: [root], change: { column: 'send', mode: 'full' } }, publisher())
    await new Promise(resolve => setTimeout(resolve, 5))
    const publicationId = randomUUID()
    const data = { kind: 'studio-publication', productId: f.root, scope: ebayIT(), delivery: { aliasKey: '' }, fullProductIds: [f.root] }
    await prisma.bulkOperation.create({ data: { id: publicationId, userId: ids.anna, status: 'ACCEPTED', productCount: 2, changeCount: 2, kind: 'studio-publication',
      productId: f.root, channel: 'EBAY', marketplace: 'IT', channelConnectionId: ids.ebay, aliasKey: '', changes: data } as never })
    expect(await afterContentSettled(publicationId, data, { status: 'UNVERIFIED' })).toEqual([])
    expect(await afterContentSettled(publicationId, data, { status: 'ACCEPTED' })).toEqual([root])
  }))
})

/**
 * Delete and relist (Owner 2026-10-04, simplified the same day) — a row Nexus deleted is a row not on the channel: its
 * Status reads Not listed (its default), every Publish holds it; Status Active or Inactive lists it again (whole,
 * ticked); it reads Active once the channel accepted it. The delete itself is the engine's (its own tests); here its
 * record and draft shape.
 */
describe('delete and relist', () => {
  /** What the engine's accepted Delete leaves: the draft shape and its audit record (old ASIN in the evidence). */
  async function deleted(listingId: string, at: Date, oldReference: string, channel = 'AMAZON') {
    await prisma.channelListing.update({ where: { id: listingId }, data: { listingStatus: 'DRAFT', isPublished: false, externalListingId: null, syncPaused: true } })
    await prisma.channelListingSnapshot.create({ data: { channelListingId: listingId, channel, marketplace: 'IT', aliasKey: '', reason: 'delete', publishEventId: randomUUID(),
      outcome: 'ACCEPTED', acceptedAt: at, payload: { kind: 'listing-action', action: 'delete', evidence: { oldExternalListingId: oldReference } } } as never })
  }
  const cellOf = async (productId: string, listingId: string) => (await readPublishActions(productId)).find(c => c.listingId === listingId)!

  it('reads Not listed and every Publish holds it; Status Active lists it again (ticked); Not listed keeps it off; the Shared scope refuses', () => scoped(async () => {
    const f = await family('PP-DEL', ['M', 'S'])
    await listing(f.root, 'AMAZON', 'IT', ids.amazon)
    const lS = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon, { externalListingId: 'B0SSSS0001' })
    await listing(f.children.M, 'AMAZON', 'IT', ids.amazon)
    // A Status and a Full update set BEFORE the delete belong to the listing that was deleted.
    await writePublishActions(f.root, { listingIds: [lS], change: { column: 'status', target: 'inactive' } }, publisher())
    await writePublishActions(f.root, { listingIds: [lS], change: { column: 'send', mode: 'full' } }, publisher())
    await new Promise(resolve => setTimeout(resolve, 5))
    const at = new Date()
    await deleted(lS, at, 'B0SSSS0001')
    const where = { where: 'Amazon · IT', at: at.toISOString() }
    let cell = await cellOf(f.root, lS)
    expect(cell).toMatchObject({ state: 'not_listed', stateReason: deletedStatusReason(where),
      deleted: { at: at.toISOString(), where: 'Amazon · IT', oldReference: 'B0SSSS0001', relistChosenAt: null, sentence: deletedShort(where) },
      create: { target: 'not_listed', source: 'default', defaultTarget: 'not_listed' } })
    expect(cell.statusOptions.map(o => [o.target, o.offered])).toEqual([['active', true], ['inactive', true], ['not_listed', true]])
    expect(cell.sendOptions.map(o => [o.mode, o.offered])).toEqual([['partial', false], ['full', true], ['delete', false]])
    expect(cell.status.noLongerApplies).toMatch(/^Set before the delete on /)
    expect(cell.send.noLongerApplies).toMatch(/^Set before the delete on /)
    // A plain Publish holds it (no create, never ticked) and clears the values it outgrew.
    let plan = await reviewPublishPlan(f.root, { destinations: [amazonIT()] }, owner(), { preview: fakePreview })
    let d = plan.destinations[0]
    expect(d.contentHeld).toEqual([{ productId: f.children.S, sku: 'PP-DEL-S', reason: deletedPublishSkip(where), deleted: true }])
    expect(d.review!.changes!.find(c => c.productId === f.children.S)).toMatchObject({ selectable: false, selectedByDefault: false, reason: deletedPublishSkip(where) })
    expect(d.lifecycle).toEqual([])
    expect(d.outgrown.map(o => [o.column, o.value])).toEqual([['send', 'full'], ['status', 'inactive']])
    expect(fixture.previews[0].options).toEqual({})
    // Status Active after the delete: stored as the row's choice; the next Publish lists it again, ticked.
    await prisma.channelListing.update({ where: { id: lS }, data: { publishAction: null, publishActionAt: null, publishActionById: null, sellingTarget: null, sellingTargetAt: null, publishActionBasis: Prisma.DbNull } })
    expect(await writePublishActions(f.root, { listingIds: [lS], change: { column: 'status', target: 'active' } }, publisher())).toMatchObject({ applied: [lS] })
    cell = await cellOf(f.root, lS)
    expect(cell).toMatchObject({ state: 'not_listed', status: { target: 'active', setByName: 'Anna', noLongerApplies: null }, create: { target: 'active', source: 'own' } })
    fixture.previews.length = 0
    plan = await reviewPublishPlan(f.root, { destinations: [amazonIT()] }, owner(), { preview: fakePreview })
    d = plan.destinations[0]
    expect(d.contentHeld).toEqual([])
    expect(d.lifecycle).toEqual([])
    expect(d.review!.changes!.find(c => c.productId === f.children.S)).toMatchObject({ selectable: true, selectedByDefault: true })
    // Status Not listed keeps it off: held again.
    await writePublishActions(f.root, { listingIds: [lS], change: { column: 'status', target: 'not_listed' } }, publisher())
    plan = await reviewPublishPlan(f.root, { destinations: [amazonIT()] }, owner(), { preview: fakePreview })
    expect(plan.destinations[0].contentHeld).toEqual([{ productId: f.children.S, sku: 'PP-DEL-S', reason: deletedPublishSkip(where), deleted: true }])
    // The Shared scope never lists a deleted market again: that choice is made in its own market.
    const refusal = { listingId: lS, reason: 'Deleted on Amazon · IT. To list it again, set its Status in the Amazon · IT sheet.' }
    expect(await writePublishActions(f.children.S, { allCoordinates: true, change: { column: 'status', target: 'active' } }, owner()))
      .toMatchObject({ applied: [], refused: [refusal] })
    // The same when the Shared scope names the listings itself (it sends `allCoordinates` beside its `listingIds`).
    expect(await writePublishActions(f.root, { listingIds: [lS], allCoordinates: true, change: { column: 'status', target: 'inactive' } }, owner()))
      .toMatchObject({ applied: [], refused: [refusal] })
    expect(await stored(lS)).toMatchObject({ sellingTarget: 'NOT_LISTED' })
  }))

  it('once the channel accepted the relist the Status choice clears and it reads Active by itself; a failed relist keeps waiting', () => scoped(async () => {
    const f = await family('PP-RELIST', ['M', 'S'])
    const lS = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon, { externalListingId: 'B0SSSS0002' })
    const lM = await listing(f.children.M, 'AMAZON', 'IT', ids.amazon, { externalListingId: 'B0MMMM0002' })
    const at = new Date(Date.now() - 60_000)
    await deleted(lS, at, 'B0SSSS0002')
    await deleted(lM, at, 'B0MMMM0002')
    await writePublishActions(f.root, { listingIds: [lS, lM], change: { column: 'status', target: 'active' } }, publisher())
    await new Promise(resolve => setTimeout(resolve, 5))
    const publicationId = randomUUID()
    const data = { kind: 'studio-publication', productId: f.root, scope: amazonIT(), delivery: { aliasKey: '', productIds: [f.children.S, f.children.M] },
      relistProductIds: [f.children.M, f.children.S], createChoiceProductIds: [f.children.M, f.children.S] }
    await prisma.bulkOperation.create({ data: { id: publicationId, userId: ids.anna, status: 'PARTIAL', productCount: 2, changeCount: 2, kind: 'studio-publication',
      productId: f.root, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: ids.amazon, aliasKey: '', changes: data } as never })
    for (const [listingId, outcome] of [[lS, 'ACCEPTED'], [lM, 'FAILED']] as const)
      await prisma.channelListingSnapshot.create({ data: { channelListingId: listingId, channel: 'AMAZON', marketplace: 'IT', aliasKey: '', reason: 'publish',
        publishEventId: publicationId, outcome, acceptedAt: outcome === 'ACCEPTED' ? new Date() : null, payload: {} } as never })
    // The settle core promotes the accepted draft (Amazon), then clears the choice of what was accepted.
    await prisma.channelListing.update({ where: { id: lS }, data: { listingStatus: 'ACTIVE', isPublished: true, syncPaused: false } })
    expect(await afterContentSettled(publicationId, data, { status: 'PARTIAL' })).toEqual([lS])
    expect(await stored(lS)).toMatchObject({ sellingTarget: null, sellingTargetAt: null })
    expect(await stored(lM)).toMatchObject({ sellingTarget: 'ACTIVE', sellingTargetAt: expect.any(Date) })
    expect(await cellOf(f.root, lS)).toMatchObject({ state: 'active', deleted: null, create: null })
    // M was refused (e.g. Amazon still removing it): still Not listed, its Status Active still waits for the next Publish.
    expect(await cellOf(f.root, lM)).toMatchObject({ state: 'not_listed', create: { target: 'active', source: 'own' } })
  }))

  it('an OLDER relist choice (Partial update after the delete, the first build) reads as Status Active and clears once accepted', () => scoped(async () => {
    const f = await family('PP-OLD', ['S'])
    const lS = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon, { externalListingId: 'B0SSSS0003' })
    const at = new Date(Date.now() - 60_000)
    await deleted(lS, at, 'B0SSSS0003')
    await prisma.channelListing.update({ where: { id: lS }, data: { publishAction: null, publishActionAt: new Date(at.getTime() + 1_000), publishActionById: ids.anna } })
    expect(await cellOf(f.root, lS)).toMatchObject({ create: { target: 'active', source: 'own' }, send: { mode: 'full', setAt: null } })
    const plan = await reviewPublishPlan(f.root, { destinations: [amazonIT()] }, owner(), { preview: fakePreview })
    expect(plan.destinations[0].contentHeld).toEqual([])
    const publicationId = randomUUID()
    const data = { kind: 'studio-publication', productId: f.root, scope: amazonIT(), delivery: { aliasKey: '', productIds: [f.children.S] }, relistProductIds: [f.children.S] }
    await prisma.bulkOperation.create({ data: { id: publicationId, userId: ids.anna, status: 'ACCEPTED', productCount: 1, changeCount: 1, kind: 'studio-publication',
      productId: f.root, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: ids.amazon, aliasKey: '', changes: data } as never })
    await prisma.channelListingSnapshot.create({ data: { channelListingId: lS, channel: 'AMAZON', marketplace: 'IT', aliasKey: '', reason: 'publish',
      publishEventId: publicationId, outcome: 'ACCEPTED', acceptedAt: new Date(), payload: {} } as never })
    expect(await afterContentSettled(publicationId, data, { status: 'ACCEPTED' })).toEqual([lS])
    expect(await stored(lS)).toMatchObject({ publishAction: null, publishActionAt: null })
  }))

  it('eBay lists a whole listing: it stays off while its main row is Not listed (no review is made); the main row\'s Active lists all of it', () => scoped(async () => {
    const f = await family('PP-EBDEL', ['S'])
    const root = await listing(f.root, 'EBAY', 'IT', ids.ebay, { externalListingId: '5150' })
    const lS = await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '5150' })
    const at = new Date(Date.now() - 60_000)
    await deleted(root, at, '5150', 'EBAY')
    await deleted(lS, at, '5150', 'EBAY')
    fixture.previews.length = 0
    let plan = await reviewPublishPlan(f.root, { destinations: [ebayIT()] }, owner(), { preview: fakePreview })
    expect(plan.destinations[0]).toMatchObject({ review: null, contentHeld: [{ productId: f.root, deleted: true }, { productId: f.children.S, deleted: true }] })
    expect(fixture.previews).toEqual([])
    // A variation's own Active alone cannot list it: its main row is still Not listed.
    await writePublishActions(f.root, { listingIds: [lS], change: { column: 'status', target: 'active' } }, publisher())
    plan = await reviewPublishPlan(f.root, { destinations: [ebayIT()] }, owner(), { preview: fakePreview })
    expect(plan.destinations[0].review).toBeNull()
    await writePublishActions(f.root, { listingIds: [root], change: { column: 'status', target: 'active' } }, publisher())
    expect((await readPublishActions(f.root)).map(c => c.create?.target)).toEqual(['active', 'active'])
    plan = await reviewPublishPlan(f.root, { destinations: [ebayIT()] }, owner(), { preview: fakePreview })
    expect(plan.destinations[0].contentHeld).toEqual([])
    expect(fixture.previews).toHaveLength(1)
  }))
})

describe('New listings: a row not on the channel holds its create choice, never a lifecycle change', () => {
  const draft = (productId: string) => listing(productId, 'AMAZON', 'IT', ids.amazon, { listingStatus: 'DRAFT', isPublished: false, externalListingId: null })

  it('Active / Inactive on a draft is a create choice (not "Already …"); a variation set Not listed is left out; the review is still made', () => scoped(async () => {
    const f = await family('PP-NEW', ['M', 'S'])
    const root = await draft(f.root), s = await draft(f.children.S), m = await draft(f.children.M)
    await writePublishActions(f.root, { listingIds: [root, s], change: { column: 'status', target: 'inactive' } }, publisher())
    await writePublishActions(f.root, { listingIds: [m], change: { column: 'status', target: 'not_listed' } }, publisher())
    const plan = await reviewPublishPlan(f.root, { destinations: [amazonIT()] }, owner(), { preview: fakePreview })
    const d = plan.destinations[0]
    expect(d.lifecycle).toEqual([])
    expect(d.outgrown).toEqual([])
    expect(d.contentHeld).toEqual([{ productId: f.children.M, sku: 'PP-NEW-M', reason: NOT_LISTED_LEFT_OUT, notListed: true }])
    expect(d.review).not.toBeNull()
    expect(plan.summary).not.toMatch(/inactive/)
    // The stored choices stay for the content review (nothing clears them before Publish).
    expect(await stored(s)).toMatchObject({ sellingTarget: 'INACTIVE' })
  }))

  it('a main row set Not listed holds the whole family: no content review is made', () => scoped(async () => {
    const f = await family('PP-NEWMAIN', ['S'])
    const root = await draft(f.root)
    await draft(f.children.S)
    await writePublishActions(f.root, { listingIds: [root], change: { column: 'status', target: 'not_listed' } }, publisher())
    const plan = await reviewPublishPlan(f.root, { destinations: [amazonIT()] }, owner(), { preview: fakePreview })
    expect(plan.destinations[0].contentHeld).toEqual([
      { productId: f.root, sku: 'PP-NEWMAIN', reason: NOT_LISTED_MAIN_HELD, notListed: true },
      { productId: f.children.S, sku: 'PP-NEWMAIN-S', reason: NOT_LISTED_MAIN_HELD, notListed: true }])
    expect(plan.destinations[0].review).toBeNull()
    expect(fixture.previews).toEqual([])
  }))

  it('once the channel accepted the create, the row\'s own choice clears; a failed row keeps it', () => scoped(async () => {
    const f = await family('PP-NEWSETTLE', ['M', 'S'])
    const s = await draft(f.children.S), m = await draft(f.children.M)
    await writePublishActions(f.root, { listingIds: [s, m], change: { column: 'status', target: 'inactive' } }, publisher())
    await new Promise(resolve => setTimeout(resolve, 5))
    const publicationId = randomUUID()
    const data = { kind: 'studio-publication', productId: f.root, scope: amazonIT(), delivery: { aliasKey: '', productIds: [f.children.S, f.children.M] },
      createChoiceProductIds: [f.children.M, f.children.S] }
    await prisma.bulkOperation.create({ data: { id: publicationId, userId: ids.anna, status: 'PARTIAL', productCount: 2, changeCount: 2, kind: 'studio-publication',
      productId: f.root, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: ids.amazon, aliasKey: '', changes: data } as never })
    for (const [listingId, outcome] of [[s, 'ACCEPTED'], [m, 'FAILED']] as const)
      await prisma.channelListingSnapshot.create({ data: { channelListingId: listingId, channel: 'AMAZON', marketplace: 'IT', aliasKey: '', reason: 'publish',
        publishEventId: publicationId, outcome, payload: {} } as never })
    expect(await afterContentSettled(publicationId, data, { status: 'PARTIAL' })).toEqual([s])
    expect(await stored(s)).toMatchObject({ sellingTarget: null })
    expect(await stored(m)).toMatchObject({ sellingTarget: 'INACTIVE' })
  }))
})

describe('the review route', () => {
  it('is a /studio-publication path: products.publish, no new manifest rule', async () => {
    const { permissionForRoute } = await import('../../lib/auth/permissions-manifest.js')
    expect(permissionForRoute('POST', '/api/products/:id/studio-publication/plan')).toBe('products.publish')
    expect(permissionForRoute('POST', '/api/publication-batches')).toBe('products.publish')
  })
})
