/**
 * The PRICING_UPDATE preview shows the numbers the run writes, for every mode (2026-10-01).
 *
 * 🔴 WHAT THIS GUARDS. A PRICING_UPDATE item is a Product, and the run prices it from `Product.basePrice`. The
 * preview read `variation.price` — a column a Product row does not have — so every mode showed the current price as
 * "NaN", and PERCENT and DELTA showed the new price as "NaN" too. It also printed the raw computed price, while the
 * master price write stores its cents: a 15% rise on 1.30 previewed 1.49 and wrote 1.50. Now the preview and the run
 * call one rule on the same column (`bulk-action/pricing-update.ts`).
 *
 * Each arm: preview, check nothing was written, run the same job, and compare the preview with what the run wrote.
 * Two skips every mode shares, preview and run alike (2026-10-01): a price that would be stored as 0 or below, and a
 * price outside the PRODUCT's own floor / ceiling (`Product.minPrice` / `maxPrice`) — the push refuses such a price
 * after Nexus stored it, so Nexus and the channel would disagree (the agent price tools' rule, #225).
 * Real PostgreSQL in-process (PGlite): these arms test what a write stores, not a race.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

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
import { BulkActionService } from './bulk-action.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const service = new BulkActionService(prisma as never)
afterAll(async () => { await state.db?.close() }, 60_000)

const price = async (id: string) => Number((await prisma.product.findUniqueOrThrow({ where: { id } })).basePrice).toFixed(2)

/**
 * Preview the job, then run it. Returns, per product: the preview's current price, new price, status and reason,
 * and the price before, the price the run wrote, the run's item status and the item's message.
 */
type Seed = number | { basePrice: number; minPrice?: number; maxPrice?: number }
async function previewThenRun(prices: Record<string, Seed>, actionPayload: Record<string, unknown>) {
  for (const [id, seed] of Object.entries(prices)) {
    const row = typeof seed === 'number' ? { basePrice: seed } : seed
    await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, totalStock: 3, ...row } })
  }
  const ids = Object.keys(prices)
  const before = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await price(id)])))
  const input = { jobName: 'preview then run', actionType: 'PRICING_UPDATE' as const, actionPayload, targetProductIds: ids, createdBy: 'person-1' }

  const preview = await service.previewJob(input)
  // The preview writes nothing.
  for (const id of ids) expect(await price(id), id).toBe(before[id])

  const job = await service.createJob(input)
  const result = await service.processJob(job.id)
  const items = await prisma.bulkActionItem.findMany({ where: { jobId: job.id } })
  const rows: Record<string, { preview: unknown[]; run: unknown[] }> = {}
  for (const id of ids) {
    const s = preview.sampleItems.find((x) => x.id === id)!
    const item = items.find((i) => i.productId === id)!
    rows[id] = {
      preview: [s.currentValue, s.newValue, s.status, s.reason ?? null],
      run: [before[id], await price(id), item.status === 'SUCCEEDED' ? 'processed' : item.status === 'SKIPPED' ? 'skipped' : item.status, item.errorMessage],
    }
  }
  return { result, rows }
}

describe('🔴 a PRICING_UPDATE preview shows what the run then writes', () => {
  it('ABSOLUTE: the current price is the product\'s, and the new one is the cents the run stores', () => scoped(async () => {
    const { result, rows } = await previewThenRun({ 'abs-a': 25.4 }, { adjustmentType: 'ABSOLUTE', value: 1.045 })
    expect(result).toMatchObject({ status: 'COMPLETED', processedItems: 1, failedItems: 0 })
    expect(rows['abs-a']).toEqual({ preview: ['25.40', '1.05', 'processed', null], run: ['25.40', '1.05', 'processed', null] })
  }), 60_000)

  it('PERCENT: the computed price, in the cents the run stores; a price over maxPrice is skipped in both', () => scoped(async () => {
    const { result, rows } = await previewThenRun({ 'pct-a': 1.3, 'pct-b': 90 }, { adjustmentType: 'PERCENT', value: 15, maxPrice: 100 })
    expect(result).toMatchObject({ status: 'COMPLETED', processedItems: 1, skippedItems: 1, failedItems: 0 })
    expect(rows['pct-a']).toEqual({ preview: ['1.30', '1.50', 'processed', null], run: ['1.30', '1.50', 'processed', null] })
    const over = "Not changed: 103.50 is above this job's maximum price of 100.00."
    expect(rows['pct-b']).toEqual({ preview: ['90.00', '103.50', 'skipped', over], run: ['90.00', '90.00', 'skipped', over] })
  }), 60_000)

  it('DELTA: the computed price, in the cents the run stores; a price that would go below zero is skipped in both', () => scoped(async () => {
    const { result, rows } = await previewThenRun({ 'delta-a': 3.04, 'delta-b': 1 }, { adjustmentType: 'DELTA', value: -1.995 })
    expect(result).toMatchObject({ status: 'COMPLETED', processedItems: 1, skippedItems: 1, failedItems: 0 })
    expect(rows['delta-a']).toEqual({ preview: ['3.04', '1.05', 'processed', null], run: ['3.04', '1.05', 'processed', null] })
    const zero = 'Not changed: the new price would be -1.00, and a price must be above 0.'
    expect(rows['delta-b']).toEqual({ preview: ['1.00', '-1.00', 'skipped', zero], run: ['1.00', '1.00', 'skipped', zero] })
  }), 60_000)

  it('ROUND_DOWN_TO_99: the rounded price; already .99 is skipped in both', () => scoped(async () => {
    const { result, rows } = await previewThenRun({ 'round-a': 25.4, 'round-b': 25.99 }, { adjustmentType: 'ROUND_DOWN_TO_99' })
    expect(result).toMatchObject({ status: 'COMPLETED', processedItems: 1, skippedItems: 1, failedItems: 0 })
    expect(rows['round-a']).toEqual({ preview: ['25.40', '24.99', 'processed', null], run: ['25.40', '24.99', 'processed', null] })
    const already = 'Not changed: the price already ends in .99.'
    expect(rows['round-b']).toEqual({ preview: ['25.99', '25.99', 'skipped', already], run: ['25.99', '25.99', 'skipped', already] })
  }), 60_000)

  it('🔴 every mode: a price that would be stored as 0 or below is skipped in both — a bulk change never stores 0', () => scoped(async () => {
    const cases: Array<[string, number, Record<string, unknown>]> = [
      ['zero-absolute', 5, { adjustmentType: 'ABSOLUTE', value: 0 }],
      ['zero-delta', 5, { adjustmentType: 'DELTA', value: -5 }],
      ['zero-percent', 5, { adjustmentType: 'PERCENT', value: -100 }],
      // 10 × (1 − 99.9999 %) = 0.00001, stored as 0.00.
      ['zero-cents', 10, { adjustmentType: 'PERCENT', value: -99.9999 }],
    ]
    for (const [id, basePrice, payload] of cases) {
      const { result, rows } = await previewThenRun({ [id]: basePrice }, payload)
      expect(result, id).toMatchObject({ status: 'COMPLETED', processedItems: 0, skippedItems: 1, failedItems: 0 })
      const zero = 'Not changed: the new price would be 0.00, and a price must be above 0.'
      expect(rows[id], id).toEqual({ preview: [basePrice.toFixed(2), '0.00', 'skipped', zero], run: [basePrice.toFixed(2), basePrice.toFixed(2), 'skipped', zero] })
    }
  }), 60_000)

  it('🔴 every mode: a new price outside the product\'s own floor or ceiling is skipped in both; inside or on it is written', () => scoped(async () => {
    const { result, rows } = await previewThenRun({
      'bounds-floor': { basePrice: 50, minPrice: 46 },
      'bounds-ceiling': { basePrice: 50, maxPrice: 44 },
      'bounds-crossed': { basePrice: 50, minPrice: 60, maxPrice: 40 },
      'bounds-inside': { basePrice: 50, minPrice: 40, maxPrice: 60 },
      'bounds-on-floor': { basePrice: 50, minPrice: 45 },
    }, { adjustmentType: 'PERCENT', value: -10 })
    expect(result).toMatchObject({ status: 'COMPLETED', processedItems: 2, skippedItems: 3, failedItems: 0 })
    // The product bounds' own words (`masterPriceBoundsReason`).
    const floor = 'Not changed: 45.00 is below its pricing floor of 46.00.'
    const ceiling = 'Not changed: 45.00 is above its pricing ceiling of 44.00.'
    const crossed = 'Not changed: its pricing floor (60.00) is above its pricing ceiling (40.00).'
    expect(rows).toEqual({
      'bounds-floor': { preview: ['50.00', '45.00', 'skipped', floor], run: ['50.00', '50.00', 'skipped', floor] },
      'bounds-ceiling': { preview: ['50.00', '45.00', 'skipped', ceiling], run: ['50.00', '50.00', 'skipped', ceiling] },
      'bounds-crossed': { preview: ['50.00', '45.00', 'skipped', crossed], run: ['50.00', '50.00', 'skipped', crossed] },
      'bounds-inside': { preview: ['50.00', '45.00', 'processed', null], run: ['50.00', '45.00', 'processed', null] },
      'bounds-on-floor': { preview: ['50.00', '45.00', 'processed', null], run: ['50.00', '45.00', 'processed', null] },
    })
    for (const [id, actionPayload, seed, reason] of [
      ['bounds-absolute', { adjustmentType: 'ABSOLUTE', value: 12 }, { basePrice: 20, maxPrice: 10 }, 'Not changed: 12.00 is above its pricing ceiling of 10.00.'],
      ['bounds-delta', { adjustmentType: 'DELTA', value: 5 }, { basePrice: 20, maxPrice: 24 }, 'Not changed: 25.00 is above its pricing ceiling of 24.00.'],
      ['bounds-round', { adjustmentType: 'ROUND_DOWN_TO_99' }, { basePrice: 25.4, minPrice: 25 }, 'Not changed: 24.99 is below its pricing floor of 25.00.'],
    ] as const) {
      const one = await previewThenRun({ [id]: seed }, { ...actionPayload })
      expect(one.result, id).toMatchObject({ status: 'COMPLETED', processedItems: 0, skippedItems: 1, failedItems: 0 })
      expect(one.rows[id].preview.slice(2), id).toEqual(['skipped', reason])
      expect(one.rows[id].run, id).toEqual([seed.basePrice.toFixed(2), seed.basePrice.toFixed(2), 'skipped', reason])
    }
  }), 60_000)

  it('🔴 every skipped row says why, in the same words in the preview and on the job item', () => scoped(async () => {
    const cases: Array<[string, Seed, Record<string, unknown>, string]> = [
      ['why-zero', 5, { adjustmentType: 'ABSOLUTE', value: 0 }, 'Not changed: the new price would be 0.00, and a price must be above 0.'],
      ['why-floor', { basePrice: 50, minPrice: 46 }, { adjustmentType: 'PERCENT', value: -10 }, 'Not changed: 45.00 is below its pricing floor of 46.00.'],
      ['why-ceiling', { basePrice: 50, maxPrice: 54 }, { adjustmentType: 'DELTA', value: 5 }, 'Not changed: 55.00 is above its pricing ceiling of 54.00.'],
      ['why-job-min', 50, { adjustmentType: 'PERCENT', value: -10, minPrice: 46 }, "Not changed: 45.00 is below this job's minimum price of 46.00."],
      ['why-job-max', 50, { adjustmentType: 'ABSOLUTE', value: 60, maxPrice: 55 }, "Not changed: 60.00 is above this job's maximum price of 55.00."],
      // The job's bounds test the computed price, so the reason shows it unrounded when it is not whole cents.
      ['why-job-min-exact', 10, { adjustmentType: 'DELTA', value: -0.004, minPrice: 10 }, "Not changed: 9.996 is below this job's minimum price of 10.00."],
      ['why-already-99', 25.99, { adjustmentType: 'ROUND_DOWN_TO_99' }, 'Not changed: the price already ends in .99.'],
      ['why-below-099', 0.5, { adjustmentType: 'ROUND_DOWN_TO_99' }, 'Not changed: 0.50 is below 0.99, so there is no lower price ending in .99.'],
    ]
    for (const [id, seed, payload, reason] of cases) {
      const { result, rows } = await previewThenRun({ [id]: seed }, payload)
      expect(result, id).toMatchObject({ status: 'COMPLETED', processedItems: 0, skippedItems: 1, failedItems: 0 })
      const before = (typeof seed === 'number' ? seed : seed.basePrice).toFixed(2)
      expect(rows[id].preview.slice(2), id).toEqual(['skipped', reason])
      expect(rows[id].run, id).toEqual([before, before, 'skipped', reason])
    }
  }), 60_000)
})
