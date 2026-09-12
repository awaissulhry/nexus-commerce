import { beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ parent: null as any, children: [] as any[], lateChildren: null as any[] | null, created: [] as any[], transaction: vi.fn() }))
vi.mock('../../db.js', () => {
  const product = {
    findFirst: vi.fn(async () => structuredClone(fixture.parent)),
    findUniqueOrThrow: vi.fn(async () => structuredClone(fixture.parent)),
    findMany: vi.fn(async ({ where }: any) => where.parentId ? structuredClone(fixture.children) : []),
  }
  return { default: { product, $transaction: async (run: any) => {
    fixture.transaction()
    return run({ product: { ...product,
      findMany: async ({ where }: any) => where.parentId ? structuredClone(fixture.lateChildren ?? fixture.children) : [],
      create: async ({ data }: any) => { fixture.created.push(data); return { id: 'new', sku: data.sku } },
      update: async () => ({}),
    } })
  } } }
})
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: vi.fn() } }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emitTx: vi.fn() } }))
import { generateCombinations, type GenerateDryRun } from './family-generate.service.js'

beforeEach(() => {
  fixture.parent = { id: 'parent', parentId: null, sku: 'P', name: 'Parent', version: 4, isParent: true, variationAxes: ['Colore', 'Taglia'] }
  fixture.children = [{ id: 'child', sku: 'P-NERO-M', name: 'Child', version: 1, categoryAttributes: { color: 'Nero', size: 'M', variations: { Color: 'Nero', Size: 'M' } }, variantAttributes: { Color: 'Nero', Size: 'M' } }]
  fixture.lateChildren = null; fixture.created = []; fixture.transaction.mockClear()
})
const input = () => ({ productId: 'parent', version: 4, axisValues: { Colore: ['Nero'], Taglia: ['M', 'L'] }, skuPattern: '{parent}-{Colore.code}-{Taglia.code}', dryRun: true })

it('creates exactly the reviewed new combination as DRAFT, with coherent axis stores and no listing creation', async () => {
  const preview = await generateCombinations(input()) as GenerateDryRun
  expect(preview.counts.willCreate).toBe(1)
  expect(fixture.transaction).not.toHaveBeenCalled()
  await generateCombinations({ ...input(), dryRun: false, previewToken: preview.previewToken })
  expect(fixture.created).toHaveLength(1)
  expect(fixture.created[0]).toMatchObject({ status: 'DRAFT', sku: 'P-NERO-L', parentId: 'parent',
    categoryAttributes: { color: 'Nero', size: 'L', variations: { Color: 'Nero', Size: 'L' } }, variantAttributes: { Color: 'Nero', Size: 'L' } })
  expect(fixture.created[0]).not.toHaveProperty('channelListings')
})

it('rejects a child edit after preview even when the parent version did not change', async () => {
  const preview = await generateCombinations(input()) as GenerateDryRun
  fixture.children[0].version++
  await expect(generateCombinations({ ...input(), dryRun: false, previewToken: preview.previewToken })).rejects.toThrow('changed after preview')
  expect(fixture.transaction).not.toHaveBeenCalled()
  expect(fixture.created).toEqual([])
})

it('rejects a changed plan and rechecks membership within the transaction', async () => {
  const preview = await generateCombinations(input()) as GenerateDryRun
  await expect(generateCombinations({ ...input(), skuPattern: 'different-{Taglia}', dryRun: false, previewToken: preview.previewToken })).rejects.toThrow('changed after preview')
  fixture.lateChildren = []
  await expect(generateCombinations({ ...input(), dryRun: false, previewToken: preview.previewToken })).rejects.toThrow('variant changed')
  expect(fixture.created).toEqual([])
})
