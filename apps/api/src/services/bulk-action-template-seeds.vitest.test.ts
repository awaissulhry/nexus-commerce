/**
 * The built-in bulk templates: one retired, one made to do what it says (2026-10-01, approved by the Owner).
 *
 * 🔴 WHAT THIS GUARDS.
 *   1. "Pause listings (Amazon DE)" set `isPublished=false` on every Amazon listing (no DE scope at all). Nexus then
 *      skipped every push while the Amazon offer stayed live, so stock stopped reaching Amazon. Since #206 the payload
 *      is refused. The seeder re-created the row at every scheduler start and nothing could remove it; it now deletes
 *      the retired built-in, and only that row: an operator's copy, a schedule that names it and the job history stay.
 *   2. "Round prices to .99" said "Sets to the next .99 below current" and sent `ABSOLUTE ${target}` (default 99.99):
 *      every price in scope became one number. It now sends the ROUND_DOWN_TO_99 mode, and the seeder's update by
 *      name gives an existing row the new payload.
 * Real PostgreSQL in-process (PGlite): these arms test what the seeder and a job store, not a race.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('./outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => undefined) }))
vi.mock('./product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('./product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { BUILTIN_TEMPLATES, RETIRED_BUILTIN_TEMPLATES, seedBulkActionTemplates } from './bulk-action-template-seeds.js'
import { BulkActionTemplateService } from './bulk-action-template.service.js'
import { BulkActionService, marketplaceOverridePlan } from './bulk-action.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const service = new BulkActionService(prisma as never)
const templates = new BulkActionTemplateService(prisma as never)

const PAUSE = 'Pause listings (Amazon DE)'
const ROUND = 'Round prices to .99'
/** The two rows exactly as the seeder before this change stored them. */
const OLD_PAUSE = { name: PAUSE, actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'AMAZON', category: 'channel', actionPayload: { isPublished: false }, parameters: [] }
const OLD_ROUND = {
  name: ROUND, actionType: 'PRICING_UPDATE', category: 'pricing', actionPayload: { adjustmentType: 'ABSOLUTE', value: '${target}' },
  parameters: [{ name: 'target', label: 'Target price (€)', type: 'number', defaultValue: 99.99, required: true, min: 0 }],
}

let account = ''
beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'AMAZON IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'round-amazon', isActive: true } })).id
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

/** Every key of a JSON value, at any depth. */
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf)
    : value && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)])
      : []

describe('the seed list itself', () => {
  it('no retired template is still in the list (it would be re-created and deleted at every start)', () => {
    const names = new Set(BUILTIN_TEMPLATES.map((t) => t.name))
    expect(RETIRED_BUILTIN_TEMPLATES.map((r) => r.name)).toEqual([PAUSE])
    for (const r of RETIRED_BUILTIN_TEMPLATES) expect(names.has(r.name), r.name).toBe(false)
  })

  it('🔴 no built-in carries the publish flag, and every built-in override passes the job\'s own payload check', () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(keysOf(t.actionPayload), t.name).not.toContain('isPublished')
      if (t.actionType === 'MARKETPLACE_OVERRIDE_UPDATE') expect(() => marketplaceOverridePlan(t.actionPayload), t.name).not.toThrow()
    }
  })

  it('build shape v2: no built-in pauses, resumes, closes or reopens an offer (that is the product sheet\'s Status column)', () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.name, t.name).not.toMatch(/\b(pause|resume|close|reopen)\b/i)
      for (const key of ['offerClosedAt', 'offerActive', 'offerCloseReason', 'syncPaused']) expect(keysOf(t.actionPayload), t.name).not.toContain(key)
      expect(JSON.stringify(t.actionPayload), t.name).not.toMatch(/CLOSE_OFFER|REOPEN_OFFER/)
    }
  })

  it('"Round prices to .99" asks for the rounding mode, with no target price to type', () => {
    const round = BUILTIN_TEMPLATES.find((t) => t.name === ROUND)!
    expect(round).toMatchObject({ actionType: 'PRICING_UPDATE', actionPayload: { adjustmentType: 'ROUND_DOWN_TO_99' } })
    expect(round.parameters ?? []).toEqual([])
    expect(keysOf(round.actionPayload)).not.toContain('value')
  })
})

describe('the seeder retires the built-in and only the built-in', () => {
  it('🔴 deletes the retired built-in; copies, schedules, job history and every other built-in survive; a second run deletes 0', () => scoped(async () => {
    // The world before this change: the old seeder's rows, an operator's copy of each kind, a schedule and a job.
    const oldPause = await prisma.bulkActionTemplate.create({ data: { ...OLD_PAUSE, userId: '__builtin', isBuiltin: true, createdBy: 'seed' } })
    const oldRound = await prisma.bulkActionTemplate.create({ data: { ...OLD_ROUND, userId: '__builtin', isBuiltin: true, createdBy: 'seed' } })
    const copy = await templates.duplicateTemplate(oldPause.id, { userId: 'person-1' })
    // "Duplicate" with an empty prefix keeps the very same name — still the operator's own row.
    const sameName = await templates.duplicateTemplate(oldPause.id, { userId: 'person-2', namePrefix: '' })
    const roundCopy = await templates.duplicateTemplate(oldRound.id, { userId: 'person-1' })
    const schedule = await prisma.scheduledBulkAction.create({ data: {
      name: 'weekly pause', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'AMAZON', actionPayload: { isPublished: false },
      cronExpression: '0 2 * * 1', templateId: oldPause.id,
    } })
    const job = await prisma.bulkActionJob.create({ data: {
      jobName: PAUSE, actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'AMAZON', targetProductIds: [], targetVariationIds: [],
      actionPayload: { isPublished: false }, status: 'FAILED', totalItems: 1,
    } })
    const untouched = await Promise.all([copy, sameName, roundCopy].map((r) => prisma.bulkActionTemplate.findUniqueOrThrow({ where: { id: r.id } })))

    const first = await seedBulkActionTemplates(prisma as never)
    expect(first).toEqual({ created: BUILTIN_TEMPLATES.length - 1, updated: 1, retired: 1 })

    expect(await prisma.bulkActionTemplate.findUnique({ where: { id: oldPause.id } })).toBeNull()
    // The operator's rows, exactly as they were — the copy of the old Round template keeps its old payload too.
    expect(await Promise.all(untouched.map((r) => prisma.bulkActionTemplate.findUniqueOrThrow({ where: { id: r.id } })))).toEqual(untouched)
    expect(untouched.map((r) => [r.name, r.isBuiltin])).toEqual([[`Copy of ${PAUSE}`, false], [PAUSE, false], [`Copy of ${ROUND}`, false]])
    // A schedule keeps its own payload and its soft link; the job history keeps its row.
    expect(await prisma.scheduledBulkAction.findUniqueOrThrow({ where: { id: schedule.id } })).toEqual(schedule)
    expect(await prisma.bulkActionJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(job)

    // Every built-in in the list exists once, as a built-in.
    const builtins = await prisma.bulkActionTemplate.findMany({ where: { userId: '__builtin' }, orderBy: { name: 'asc' } })
    expect(builtins.map((b) => b.name)).toEqual(BUILTIN_TEMPLATES.map((t) => t.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    expect(builtins.every((b) => b.isBuiltin)).toBe(true)

    // 🔴 The existing Round row is updated in place (same id) to the new payload — how production rows get it.
    const round = await prisma.bulkActionTemplate.findUniqueOrThrow({ where: { id: oldRound.id } })
    expect(round).toMatchObject({ name: ROUND, isBuiltin: true, actionType: 'PRICING_UPDATE', actionPayload: { adjustmentType: 'ROUND_DOWN_TO_99' }, parameters: [] })
    expect(round.description).toMatch(/24\.99/)

    const second = await seedBulkActionTemplates(prisma as never)
    expect(second).toEqual({ created: 0, updated: BUILTIN_TEMPLATES.length, retired: 0 })
    expect(await prisma.bulkActionTemplate.count({ where: { userId: '__builtin' } })).toBe(BUILTIN_TEMPLATES.length)
  }), 60_000)
})

describe('"Round prices to .99" through the real bulk PRICING_UPDATE (the template apply route\'s own calls)', () => {
  type Seeded = { id: string; listingId: string }
  async function seedProduct(id: string, basePrice: number): Promise<Seeded> {
    await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice, totalStock: 7, status: 'ACTIVE' } })
    const l = await prisma.channelListing.create({ data: {
      productId: id, channel: 'AMAZON', channelConnectionId: account, channelMarket: 'AMAZON_IT', marketplace: 'IT', region: 'EU',
      price: basePrice, masterPrice: basePrice, followMasterPrice: true, quantity: 5, listingStatus: 'ACTIVE', externalListingId: `OFFER-${id.toUpperCase()}`,
    } })
    return { id, listingId: l.id }
  }
  const product = (id: string) => prisma.product.findUniqueOrThrow({ where: { id } })
  const listing = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })
  const queueOf = (channelListingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId }, orderBy: { createdAt: 'asc' } })
  /** A product row without what a master price write itself moves. */
  const besidesPrice = ({ basePrice: _p, updatedAt: _u, ...rest }: Record<string, any>) => rest
  const listingPrice = (l: Record<string, any>) => ({ price: Number(l.price), masterPrice: Number(l.masterPrice), followMasterPrice: l.followMasterPrice, priceOverride: l.priceOverride, lastSyncStatus: l.lastSyncStatus })
  const besidesListingPrice = ({ price: _p, masterPrice: _m, updatedAt: _u, version: _v, lastSyncStatus: _s, syncStatus: _ss, ...rest }: Record<string, any>) => rest
  const rowShape = (row: Record<string, any>) => {
    const { productId: _p, productSku: _s, sku: _k, externalListingId: _e, idempotencyKey: _i, ...payload } = row.payload ?? {}
    return { targetChannel: row.targetChannel, targetRegion: row.targetRegion, syncStatus: row.syncStatus, syncType: row.syncType, channelConnectionId: row.channelConnectionId, payload }
  }

  it('🔴 each price becomes the largest X.99 at or below it; already .99 and under 0.99 are skipped; nothing else moves', () => scoped(async () => {
    await seedBulkActionTemplates(prisma as never)
    const down = await seedProduct('round-2540', 25.4)
    const whole = await seedProduct('round-2500', 25)
    const already = await seedProduct('round-2599', 25.99)
    const tiny = await seedProduct('round-0050', 0.5)
    const outsider = await seedProduct('round-outside', 25.4)
    const twin = await seedProduct('absolute-twin', 25.4)
    const scope = [down.id, whole.id, already.id, tiny.id]
    const before = Object.fromEntries(await Promise.all([...scope, outsider.id].map(async (id) => [id, await product(id)])))
    const listingsBefore = Object.fromEntries(await Promise.all([down, whole, already, tiny, outsider].map(async (s) => [s.listingId, await listing(s.listingId)])))

    // The apply route: substitute the template's parameters (none), then create and run the job.
    const template = await prisma.bulkActionTemplate.findFirstOrThrow({ where: { userId: '__builtin', name: ROUND } })
    const { actionPayload, filters } = templates.applyParameters(template, {}, undefined)
    expect(actionPayload).toEqual({ adjustmentType: 'ROUND_DOWN_TO_99' })
    const input = { jobName: ROUND, actionType: 'PRICING_UPDATE' as const, actionPayload, filters: filters ?? undefined, targetProductIds: scope, createdBy: 'person-1' }

    // The preview shows the run's numbers and writes nothing.
    const preview = await service.previewJob(input)
    expect(preview.affectedCount).toBe(4)
    expect(Object.fromEntries(preview.sampleItems.map((s) => [s.id, [s.currentValue, s.newValue, s.status]]))).toEqual({
      [down.id]: ['25.40', '24.99', 'processed'],
      [whole.id]: ['25.00', '24.99', 'processed'],
      [already.id]: ['25.99', '25.99', 'skipped'],
      [tiny.id]: ['0.50', '0.50', 'skipped'],
    })
    for (const id of scope) expect(await product(id), id).toEqual(before[id])

    const job = await service.createJob(input)
    const result = await service.processJob(job.id)
    expect(result).toMatchObject({ status: 'COMPLETED', processedItems: 2, skippedItems: 2, failedItems: 0 })
    const items = await prisma.bulkActionItem.findMany({ where: { jobId: job.id } })
    expect(Object.fromEntries(items.map((i) => [i.productId, [i.status, i.beforeState, i.afterState]]))).toEqual({
      [down.id]: ['SUCCEEDED', { basePrice: 25.4 }, { basePrice: 24.99 }],
      [whole.id]: ['SUCCEEDED', { basePrice: 25 }, { basePrice: 24.99 }],
      [already.id]: ['SKIPPED', { basePrice: 25.99 }, { basePrice: 25.99 }],
      [tiny.id]: ['SKIPPED', { basePrice: 0.5 }, { basePrice: 0.5 }],
    })

    // The prices, and nothing else on the product.
    expect(Number((await product(down.id)).basePrice)).toBe(24.99)
    expect(Number((await product(whole.id)).basePrice)).toBe(24.99)
    for (const id of scope) expect(besidesPrice(await product(id)), id).toEqual(besidesPrice(before[id]))
    // Skipped rows and the product outside the scope are untouched, and nothing is queued for them.
    for (const s of [already, tiny, outsider]) {
      expect(await product(s.id), s.id).toEqual(before[s.id])
      expect(await listing(s.listingId), s.id).toEqual(listingsBefore[s.listingId])
      expect(await queueOf(s.listingId), s.id).toEqual([])
    }

    // 🔴 The channel gets the rounded price through the SAME master price door as any PRICING_UPDATE: compared with
    // the existing ABSOLUTE mode setting 24.99 on a twin, the listing columns and the queued PRICE_UPDATE match.
    const absolute = await service.createJob({ jobName: 'absolute', actionType: 'PRICING_UPDATE', actionPayload: { adjustmentType: 'ABSOLUTE', value: 24.99 }, targetProductIds: [twin.id], createdBy: 'person-1' })
    expect(await service.processJob(absolute.id)).toMatchObject({ status: 'COMPLETED', processedItems: 1 })
    const [rounded, twinned] = [await listing(down.listingId), await listing(twin.listingId)]
    expect(listingPrice(rounded)).toEqual(listingPrice(twinned))
    expect(listingPrice(rounded)).toMatchObject({ price: 24.99, masterPrice: 24.99, followMasterPrice: true })
    expect(besidesListingPrice(rounded)).toEqual(besidesListingPrice(listingsBefore[down.listingId]))
    const [rq, tq] = [await queueOf(down.listingId), await queueOf(twin.listingId)]
    expect(rq).toHaveLength(1)
    expect(rq.map(rowShape)).toEqual(tq.map(rowShape))
    expect(rq[0]).toMatchObject({ syncType: 'PRICE_UPDATE', syncStatus: 'PENDING', payload: { source: 'MASTER_PRICE_CHANGE', price: 24.99, oldPrice: 25.4, masterPrice: 24.99, reason: 'bulk-pricing-job' } })

    // Undo puts the prices back from the job's own before-state.
    const undo = await service.rollbackBulkActionJob(job.id, 'person-1')
    expect(undo).toMatchObject({ succeeded: 2, failed: 0, skipped: 0 })
    expect(Number((await product(down.id)).basePrice)).toBe(25.4)
    expect(Number((await product(whole.id)).basePrice)).toBe(25)
  }), 60_000)

  it('the other modes keep their numbers: PERCENT and DELTA on the same price as before', () => scoped(async () => {
    const pct = await seedProduct('percent-keeps', 25.4)
    const delta = await seedProduct('delta-keeps', 25.4)
    for (const [s, actionPayload, expected] of [[pct, { adjustmentType: 'PERCENT', value: -10 }, 22.86], [delta, { adjustmentType: 'DELTA', value: 1.5 }, 26.9]] as const) {
      const job = await service.createJob({ jobName: 'keeps', actionType: 'PRICING_UPDATE', actionPayload: { ...actionPayload }, targetProductIds: [s.id], createdBy: 'person-1' })
      expect(await service.processJob(job.id)).toMatchObject({ status: 'COMPLETED', processedItems: 1 })
      expect(Number((await product(s.id)).basePrice), s.id).toBe(expected)
    }
    // A payload without a mode is still refused, as before.
    const bare = await service.createJob({ jobName: 'bare', actionType: 'PRICING_UPDATE', actionPayload: { value: 3 }, targetProductIds: [pct.id], createdBy: 'person-1' })
    expect(await service.processJob(bare.id)).toMatchObject({ processedItems: 0, failedItems: 1 })
  }), 60_000)
})
