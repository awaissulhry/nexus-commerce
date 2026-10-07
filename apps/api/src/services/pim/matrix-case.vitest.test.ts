/**
 * Step 3 (cases, Owner D2 = B) — the Matrix read carries each row's case pack (`MatrixRowRead.pack`) for the Case column.
 *
 * The real Matrix read over a real PostgreSQL in-process (PGlite): a variation with a case pack reads its units per case,
 * its case size and weight as NUMBERS (Prisma returns Decimal; the wire carries numbers) and its FBA prep/label owners; a
 * variation without one reads `null`; the parent carries its own (none here, so null); an owner string the column does
 * not know reads as "not set". Sealed counts are not in the Matrix read.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => undefined) }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { casePackOf, getMatrixRead } from './matrix.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  await prisma.product.create({ data: { id: 'case-parent', sku: 'TEST-SKU-CASE-P', name: 'Case parent', basePrice: 10, isParent: true } })
  for (const [id, sku] of [['case-red', 'TEST-SKU-CASE-RED'], ['case-blue', 'TEST-SKU-CASE-BLUE'], ['case-odd', 'TEST-SKU-CASE-ODD']] as const) {
    await prisma.product.create({ data: { id, sku, name: sku, basePrice: 10, parentId: 'case-parent' } })
  }
  await prisma.productPackage.create({ data: {
    productId: 'case-red', unitsPerCase: 12, caseLengthCm: '60.5', caseWidthCm: '40.0', caseHeightCm: '35.2', caseWeightKg: '14.55',
    fbaPrepOwner: 'SELLER', fbaLabelOwner: 'AMAZON',
  } })
  // A row with only owners (no case size yet), one of them a word the column does not know.
  await prisma.productPackage.create({ data: { productId: 'case-odd', fbaPrepOwner: 'NONE', fbaLabelOwner: 'SELLER' } })
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

describe('the Matrix rows carry the case pack', () => {
  it('a variation with a pack: numbers on the wire; one without: null; the parent: its own (none); an unknown owner: not set', () => scoped(async () => {
    const read = await getMatrixRead({ productId: 'case-red', canEditPrice: true })
    const pack = (id: string) => read.rows.find((r) => r.id === id)!.pack
    expect(read.rows.map((r) => r.id)).toEqual(expect.arrayContaining(['case-parent', 'case-red', 'case-blue', 'case-odd']))
    expect(pack('case-red')).toEqual({
      unitsPerCase: 12, caseLengthCm: 60.5, caseWidthCm: 40, caseHeightCm: 35.2, caseWeightKg: 14.55, fbaPrepOwner: 'SELLER', fbaLabelOwner: 'AMAZON',
    })
    for (const key of ['caseLengthCm', 'caseWidthCm', 'caseHeightCm', 'caseWeightKg'] as const) expect(typeof pack('case-red')![key]).toBe('number')
    expect(pack('case-blue')).toBeNull()
    expect(pack('case-parent')).toBeNull()
    expect(pack('case-odd')).toEqual({ unitsPerCase: null, caseLengthCm: null, caseWidthCm: null, caseHeightCm: null, caseWeightKg: null, fbaPrepOwner: null, fbaLabelOwner: 'SELLER' })
    // The wire is plain JSON: no Decimal object survives a round trip as anything but its number.
    expect(JSON.parse(JSON.stringify(read.rows.find((r) => r.id === 'case-red')!.pack))).toEqual(pack('case-red'))
  }))

  it('casePackOf: Decimal-like values become numbers, nulls stay null', () => {
    const decimal = (v: string) => ({ toNumber: () => Number(v), toString: () => v })
    expect(casePackOf({ unitsPerCase: 6, caseLengthCm: decimal('63.5') as never, caseWidthCm: null, caseHeightCm: null, caseWeightKg: decimal('23.00') as never, fbaPrepOwner: 'AMAZON', fbaLabelOwner: null }))
      .toEqual({ unitsPerCase: 6, caseLengthCm: 63.5, caseWidthCm: null, caseHeightCm: null, caseWeightKg: 23, fbaPrepOwner: 'AMAZON', fbaLabelOwner: null })
  })
})
