/**
 * P3 (docs/attributes/PLAN.md §4.1) — `computeMany` (the bulk completeness route) must give exactly the answer
 * `compute` gives per product, with a fixed number of queries.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
import prisma from '../db.js'
import { familyCompletenessService } from './family-completeness.service.js'
import { channelReadinessService } from './channel-readiness.service.js'

afterAll(async () => { await state.db?.close() })

beforeAll(async () => {
  const group = await prisma.attributeGroup.create({ data: { code: 'fcm-specs', label: 'Specs' } })
  const attr = (code: string, localizable = false) => prisma.customAttribute.create({ data: { code, label: code, groupId: group.id, type: 'text', localizable } })
  const [brand, color, care, ce] = await Promise.all([attr('fcm_brand'), attr('fcm_color'), attr('fcm_care', true), attr('fcm_ce')])
  const apparel = await prisma.productFamily.create({ data: { code: 'fcm-apparel', label: 'Apparel' } })
  const jackets = await prisma.productFamily.create({ data: { code: 'fcm-jackets', label: 'Jackets', parentFamilyId: apparel.id } })
  await prisma.familyAttribute.create({ data: { familyId: apparel.id, attributeId: brand.id, required: true, channels: [] } })
  await prisma.familyAttribute.create({ data: { familyId: apparel.id, attributeId: color.id, required: true, channels: ['AMAZON'] } })
  await prisma.familyAttribute.create({ data: { familyId: jackets.id, attributeId: care.id, required: true, channels: [] } })
  await prisma.familyAttribute.create({ data: { familyId: jackets.id, attributeId: ce.id, required: false, channels: [] } })
  const product = (id: string, familyId: string | null, categoryAttributes: Record<string, unknown>) =>
    prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 1, familyId, categoryAttributes: categoryAttributes as never } })
  await product('fcm-full', jackets.id, { fcm_brand: 'Xavia', fcm_color: 'Nero', fcm_care: 'Hand wash', fcm_ce: 'EN 17092' })
  await product('fcm-half', jackets.id, { fcm_brand: 'Xavia', fcm_color: '' })
  await product('fcm-apparel-only', apparel.id, { fcm_brand: '   ', fcm_color: ['Nero'] })
  await product('fcm-none', null, { fcm_brand: 'Xavia' })
}, 60_000)

it('equals compute() for every product, including a missing one and one without a family', async () => {
  const ids = ['fcm-full', 'fcm-half', 'fcm-apparel-only', 'fcm-none', 'fcm-missing']
  const many = await familyCompletenessService.computeMany(ids)
  for (const id of ids) {
    const single = await familyCompletenessService.compute(id).catch((error: Error) => ({ error: error.message }))
    expect(many.get(id)).toEqual(single)
  }
  // Positive control: the answers differ from each other, so equality is not two empty results agreeing.
  expect(many.get('fcm-full')).toMatchObject({ score: 100, filled: 3, totalRequired: 3 })
  expect(many.get('fcm-half')).toMatchObject({ filled: 1, totalRequired: 3 })
  expect(many.get('fcm-apparel-only')).toMatchObject({ filled: 1, totalRequired: 2 })
  expect(many.get('fcm-none')).toMatchObject({ familyId: null, score: -1 })
  expect(many.get('fcm-missing')).toEqual({ error: 'FamilyCompletenessService: product fcm-missing not found' })
})

it('channel readiness: computeMany() equals compute() for the family path, the fallback path and a missing product', async () => {
  await prisma.product.create({ data: { id: 'fcm-fallback', sku: 'FCM-FALLBACK', name: 'fallback', basePrice: 12, brand: 'Xavia', gtin: '8000000000001' } })
  const ids = ['fcm-full', 'fcm-half', 'fcm-none', 'fcm-fallback', 'fcm-missing']
  const many = await channelReadinessService.computeMany(ids)
  for (const id of ids) {
    const single = await channelReadinessService.compute(id).catch((error: Error) => ({ error: error.message }))
    expect(many.get(id)).toEqual(single)
  }
  // Positive control: both paths and real labels are present.
  expect(many.get('fcm-half')).toMatchObject({ familyDriven: true })
  expect((many.get('fcm-half') as { channels: Array<{ missing: Array<{ label: string }> }> }).channels[0].missing.map(m => m.label).sort()).toEqual(['fcm_care', 'fcm_color'])
  expect(many.get('fcm-fallback')).toMatchObject({ familyDriven: false })
  expect(many.get('fcm-missing')).toEqual({ error: 'ChannelReadinessService: product fcm-missing not found' })
})
