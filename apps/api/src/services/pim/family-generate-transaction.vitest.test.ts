import { beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ parent: null as any, children: [] as any[], lateChildren: null as any[] | null, created: [] as any[], transaction: vi.fn(),
  /** S9 — the SKUs another product's listing holds or sends as its channel SKU (`channelSkuHoldings`). */
  held: [] as Array<{ sku: string; productId: string; sentence: string }> }))
vi.mock('../listings/channel-sku-rename.js', () => ({ channelSkuHoldings: vi.fn(async (_db: unknown, skus: string[]) => fixture.held.filter(h => skus.includes(h.sku))) }))
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
  fixture.lateChildren = null; fixture.created = []; fixture.transaction.mockClear(); fixture.held = []
})
const input = () => ({ productId: 'parent', version: 4, axisValues: { Colore: ['Nero'], Taglia: ['M', 'L'] }, skuPattern: '{parent}-{Colore.code}-{Taglia.code}', dryRun: true })

it('creates exactly the reviewed new combination as DRAFT, with coherent axis stores and no listing creation', async () => {
  const preview = await generateCombinations(input()) as GenerateDryRun
  expect(preview.counts.willCreate).toBe(1)
  expect(fixture.transaction).not.toHaveBeenCalled()
  await generateCombinations({ ...input(), dryRun: false, previewToken: preview.previewToken })
  expect(fixture.created).toHaveLength(1)
  expect(fixture.created[0]).toMatchObject({ status: 'DRAFT', sku: 'P-NERO-L', parentId: 'parent',
    categoryAttributes: { color: 'Nero', size: 'L', variations: { Color: 'Nero', Size: 'L' } } })
  // R-23 (Step 2.6c-2) reversed this: the axis values go to the one store; the legacy bag is never written.
  expect(fixture.created[0]).not.toHaveProperty('variantAttributes')
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

// MCP full control (lead review, 2026-10-01) — a generated variation starts at stock 0. Copying the nearest sibling's
// `totalStock` wrote a stock count outside the stock ledger: units no location holds, which the cascade could then push to
// a channel. Stock arrives only through the stock doors (a count, a receipt, a transfer).
it('a new variation starts at stock 0, whatever its nearest sibling holds', async () => {
  fixture.children = [{ ...fixture.children[0], totalStock: 7, basePrice: 12 }]
  const preview = await generateCombinations(input()) as GenerateDryRun
  expect(preview.plan[0].copiesFrom).toMatchObject({ sku: 'P-NERO-M' })
  await generateCombinations({ ...input(), dryRun: false, previewToken: preview.previewToken })
  expect(fixture.created).toEqual([expect.objectContaining({ sku: 'P-NERO-L', totalStock: 0, basePrice: 12 })])
})

// S9 — a generated variation never takes a SKU another product's listing holds or sends as its channel SKU.
it('S9: a SKU another product\'s listing holds is skipped in the preview and refused at create, with the sentence', async () => {
  const sentence = 'P-NERO-L is the SKU of OTHER on Amazon · DE. One SKU names one product: choose another SKU.'
  fixture.held = [{ sku: 'P-NERO-L', productId: 'other', sentence }]
  const preview = await generateCombinations(input()) as GenerateDryRun
  expect(preview.counts.willCreate).toBe(0)
  expect(preview.skipped).toContainEqual(expect.objectContaining({ sku: 'P-NERO-L', reason: 'sku_collision' }))
  await expect(generateCombinations({ ...input(), dryRun: false, previewToken: preview.previewToken })).rejects.toThrow(`${sentence} Change the pattern`)
  // Held between the preview and the create: the transaction refuses it too, before anything is created.
  fixture.held = []
  const clean = await generateCombinations(input()) as GenerateDryRun
  fixture.held = [{ sku: 'P-NERO-L', productId: 'other', sentence }]
  await expect(generateCombinations({ ...input(), dryRun: false, previewToken: clean.previewToken })).rejects.toThrow(sentence)
  expect(fixture.created).toEqual([])
})
