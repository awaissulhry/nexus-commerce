/**
 * Google Ads Shopping (2026-10-15, G4) — set-google-product-groups on a tree of ANY shape (pure): the exact operations
 * (temporary ids, parents first, what stays keeps its id), Google's listing group rules checked before anything is sent
 * (an "everything else" in every split, levels in order, no dimension twice on a path, valid values), a split never
 * removed in a request that makes anything (removals alone, or two steps), what spends money, and the records undo reads.
 */
import { describe, expect, it } from 'vitest'
import { productGroupChangeDraft, productGroupRecordAfterRun, productGroupRecordNow, productGroupUndoArgs, type ProductGroupChangeRecord, type ProductGroupRequest } from './change-product-groups.js'
import { productGroupNodeOf, type ProductGroupLiveState, type ShoppingAdGroupLive } from './live-product-groups.js'
import { snapshotOf, treeOfSpec, type TreeSpecNode } from './product-tree.js'
import type { GoogleChangeDraft } from './change-draft.js'

const C = 'customers/1234567890'
const AGC = `${C}/adGroupCriteria/51~`
const adGroup = (campaign: Partial<ShoppingAdGroupLive['campaign']> = {}): ShoppingAdGroupLive => ({
  adGroupId: '51', name: 'Group A', status: 'ENABLED', type: 'SHOPPING_PRODUCT_ADS',
  campaign: { campaignId: '21', name: 'Shop A', status: 'ENABLED', type: 'SHOPPING', bidding: 'MANUAL_CPC', ...campaign },
})
const node = (id: string, parent: string | null, type: 'UNIT' | 'SUBDIVISION', caseValue: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
  productGroupNodeOf({
    adGroup: { id: '51' },
    adGroupCriterion: { criterionId: id, listingGroup: { type, ...(parent ? { parentAdGroupCriterion: `${AGC}${parent}` } : {}), ...(caseValue ? { caseValue } : {}) }, ...extra },
  })
const bid = (cents: number) => ({ cpcBidMicros: String(cents * 10_000) })
const NEG = { negative: true }
const live = (nodes: ReturnType<typeof node>[], group: ShoppingAdGroupLive = adGroup()): ProductGroupLiveState => ({ adGroup: group, nodes })
const ask = (extra: Partial<ProductGroupRequest>): ProductGroupRequest => ({ campaignId: '21', adGroupId: '51', ...extra })
const draft = (request: ProductGroupRequest, state: ProductGroupLiveState): GoogleChangeDraft => {
  const d = productGroupChangeDraft(C, 'EUR', request, state)
  if ('refusal' in d) throw new Error(d.refusal)
  return d
}
const refusal = (request: ProductGroupRequest, state: ProductGroupLiveState) => {
  const d = productGroupChangeDraft(C, 'EUR', request, state)
  return 'refusal' in d ? d.refusal : null
}
const create = (id: number, parent: string | null, type: string, caseValue: Record<string, unknown> | null, unit: Record<string, unknown> = {}) =>
  ({ adGroupCriterionOperation: { create: { resourceName: `${AGC}${id}`, status: 'ENABLED', listingGroup: { type, ...(parent ? { parentAdGroupCriterion: parent } : {}), ...(caseValue ? { caseValue } : {}) }, ...unit } } })

/** By brand: Brand A at EUR 0.40, Brand B excluded, everything else excluded. */
const BRANDS = [
  node('701', null, 'SUBDIVISION', null),
  node('702', '701', 'UNIT', { productBrand: { value: 'Brand A' } }, bid(40)),
  node('703', '701', 'UNIT', { productBrand: { value: 'Brand B' } }, NEG),
  node('704', '701', 'UNIT', { productBrand: {} }, NEG),
]
/** By condition, "everything else" split by brand (Google's own example tree). */
const DEEP = [
  node('801', null, 'SUBDIVISION', null),
  node('802', '801', 'UNIT', { productCondition: { condition: 'NEW' } }, bid(20)),
  node('803', '801', 'UNIT', { productCondition: { condition: 'USED' } }, bid(10)),
  node('804', '801', 'SUBDIVISION', { productCondition: {} }),
  node('805', '804', 'UNIT', { productBrand: { value: 'CoolBrand' } }, bid(90)),
  node('806', '804', 'UNIT', { productBrand: {} }, NEG),
]
const BRAND_TREE: TreeSpecNode[] = [
  { split: 'BRAND' },
  { parent: 0, value: 'Brand A', split: 'ITEM_ID' },
  { parent: 1, value: 'sku-1', bidCents: 50 },
  { parent: 1, everythingElse: true, bidCents: 30 },
  { parent: 0, everythingElse: true, excluded: true },
]

describe('tree: the whole tree, any shape', () => {
  it('a new nested tree: one request, parents first, temporary ids, the case values Google takes', () => {
    const d = draft(ask({ tree: BRAND_TREE }), live([]))
    expect(d.operations).toEqual([
      create(-1, null, 'SUBDIVISION', null),
      create(-2, `${AGC}-1`, 'SUBDIVISION', { productBrand: { value: 'Brand A' } }),
      create(-3, `${AGC}-2`, 'UNIT', { productItemId: { value: 'sku-1' } }, { cpcBidMicros: '500000' }),
      create(-4, `${AGC}-2`, 'UNIT', { productItemId: {} }, { cpcBidMicros: '300000' }),
      create(-5, `${AGC}-1`, 'UNIT', { productBrand: {} }, { negative: true }),
    ])
    expect(d.spendsMoney).toEqual(['Advertises 2 product groups in "Group A" that were not advertised there before: brand "Brand A" › item "sku-1" at EUR 0.50, brand "Brand A" › everything else (by item ID) at EUR 0.30.'])
    expect(d.warnings).toEqual(['"Everything else" under brand "Brand A" in "Group A" is NOT excluded: every product there that the tree does not name can be advertised.'])
    expect(d.totals).toMatchObject({ operations: 5, productGroups: 5, units: 3, excluded: 1, made: 5, keepTheirIds: 0 })
    expect(d.summary).toBe('Google Ads product groups of "Group A": make 5 product groups — "All products" split by brand: 2 levels, 5 product groups (3 units, 1 excluded).')
    expect((d.after as ProductGroupChangeRecord).nodes!.map((n) => n.id)).toEqual(['op:0', 'op:1', 'op:2', 'op:3', 'op:4'])
  })

  it('every dimension takes the case value Google defines (levels, indexes, enums, category ids)', () => {
    const d = draft(ask({ tree: [
      { split: 'PRODUCT_TYPE_1' },
      { parent: 0, value: 'Jackets', split: 'PRODUCT_TYPE_2' },
      { parent: 1, value: 'Leather', split: 'CUSTOM_LABEL_3' },
      { parent: 2, value: 'top', split: 'CATEGORY_1' },
      { parent: 3, value: '166', split: 'CONDITION' },
      { parent: 4, value: 'used', split: 'CHANNEL' },
      { parent: 5, value: 'online', split: 'CHANNEL_EXCLUSIVITY' },
      { parent: 6, value: 'single_channel', bidCents: 5 },
      { parent: 6, everythingElse: true, excluded: true },
      { parent: 5, everythingElse: true, excluded: true },
      { parent: 4, everythingElse: true, excluded: true },
      { parent: 3, everythingElse: true, excluded: true },
      { parent: 2, everythingElse: true, excluded: true },
      { parent: 1, everythingElse: true, excluded: true },
      { parent: 0, everythingElse: true, excluded: true },
    ] }), live([]))
    const cases = d.operations.map((op) => (op as { adGroupCriterionOperation: { create: { listingGroup: { caseValue?: unknown } } } }).adGroupCriterionOperation.create.listingGroup.caseValue)
    expect(cases).toContainEqual({ productType: { level: 'LEVEL1', value: 'Jackets' } })
    expect(cases).toContainEqual({ productType: { level: 'LEVEL2', value: 'Leather' } })
    expect(cases).toContainEqual({ productCustomAttribute: { index: 'INDEX3', value: 'top' } })
    expect(cases).toContainEqual({ productCategory: { level: 'LEVEL1', categoryId: '166' } })
    expect(cases).toContainEqual({ productCondition: { condition: 'USED' } })
    expect(cases).toContainEqual({ productChannel: { channel: 'ONLINE' } })
    expect(cases).toContainEqual({ productChannelExclusivity: { channelExclusivity: 'SINGLE_CHANNEL' } })
    expect(cases).toContainEqual({ productType: { level: 'LEVEL2' } })
    expect(cases).toContainEqual({ productCustomAttribute: { index: 'INDEX3' } })
  })

  it('"All products" alone is replaced in the same request (removing a unit is not a recursive removal)', () => {
    const d = draft(ask({ tree: BRAND_TREE }), live([node('600', null, 'UNIT', null, bid(50))]))
    expect(d.operations[0]).toEqual({ adGroupCriterionOperation: { remove: `${AGC}600` } })
    expect(d.operations).toHaveLength(6)
    // sku-1 was in "All products" at 0.50: not a raise; everything else of Brand A at 0.30 is lower.
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings).toContain('1 product group is removed and made again (Google cannot switch a product group between advertised and excluded, nor turn one into a split): it gets a new id and its own statistics in Google Ads start from zero. The product groups that stay keep their ids and statistics.')
  })

  it('a tree already there is changed in place: what stays keeps its id; a bid is an update; a unit that becomes a split is removed and made again', () => {
    const d = draft(ask({ tree: [
      { split: 'BRAND' },
      { parent: 0, value: 'brand a', bidCents: 45 },
      { parent: 0, value: 'Brand B', split: 'ITEM_ID' },
      { parent: 2, value: 'sku-9', bidCents: 20 },
      { parent: 2, everythingElse: true, excluded: true },
      { parent: 0, value: 'Brand C', bidCents: 15 },
      { parent: 0, everythingElse: true, excluded: true },
    ] }), live(BRANDS))
    expect(d.operations).toEqual([
      { adGroupCriterionOperation: { update: { resourceName: `${AGC}702`, cpcBidMicros: '450000' }, updateMask: 'cpc_bid_micros' } },
      { adGroupCriterionOperation: { remove: `${AGC}703` } },
      create(-1, `${AGC}701`, 'SUBDIVISION', { productBrand: { value: 'Brand B' } }),
      create(-2, `${AGC}-1`, 'UNIT', { productItemId: { value: 'sku-9' } }, { cpcBidMicros: '200000' }),
      create(-3, `${AGC}-1`, 'UNIT', { productItemId: {} }, { negative: true }),
      create(-4, `${AGC}701`, 'UNIT', { productBrand: { value: 'Brand C' } }, { cpcBidMicros: '150000' }),
    ])
    expect(JSON.stringify(d.operations)).not.toContain(`remove":"${AGC}701`)
    expect(d.spendsMoney).toEqual([
      'Advertises 2 product groups in "Group A" that were not advertised there before: brand "Brand B" › item "sku-9" at EUR 0.20, brand "Brand C" at EUR 0.15.',
      'Raises the bid of 1 product group in "Group A": brand "Brand A" EUR 0.40 → EUR 0.45.',
    ])
    expect(d.totals).toMatchObject({ keepTheirIds: 3, made: 4, bidChanges: 1 })
    const after = d.after as ProductGroupChangeRecord
    expect(after.nodes!.find((n) => n.value === 'Brand A')).toMatchObject({ id: '702', bidCents: 45 })
  })

  it('a split whose children are all units changes dimension in place (it keeps its id)', () => {
    const d = draft(ask({ tree: [{ split: 'ITEM_ID' }, { parent: 0, value: 'sku-1', bidCents: 30 }, { parent: 0, everythingElse: true, excluded: true }] }), live(BRANDS))
    expect(d.operations).toEqual([
      { adGroupCriterionOperation: { remove: `${AGC}702` } },
      { adGroupCriterionOperation: { remove: `${AGC}703` } },
      { adGroupCriterionOperation: { remove: `${AGC}704` } },
      create(-1, `${AGC}701`, 'UNIT', { productItemId: { value: 'sku-1' } }, { cpcBidMicros: '300000' }),
      create(-2, `${AGC}701`, 'UNIT', { productItemId: {} }, { negative: true }),
    ])
  })

  it('a split that must go next to new product groups: refused, or two steps — step 1 only removes, the same request again makes the rest', () => {
    const tree: TreeSpecNode[] = [
      { split: 'CONDITION' },
      { parent: 0, value: 'NEW', bidCents: 20 },
      { parent: 0, value: 'USED', bidCents: 10 },
      { parent: 0, everythingElse: true, bidCents: 25 },
    ]
    expect(refusal(ask({ tree }), live(DEEP))).toMatch(/needs everything else \(by condition\) \(804\) removed first.*LISTING_GROUP_CANNOT_BE_REMOVED.*inTwoSteps: true/)
    // "everything else" cannot go alone: step 1 removes the nearest split above it that can — here the whole tree.
    const one = draft(ask({ tree, inTwoSteps: true }), live(DEEP))
    expect(one.operations).toEqual([{ adGroupCriterionOperation: { remove: `${AGC}801` } }])
    expect(one.summary).toMatch(/^Google Ads product groups of "Group A", step 1 of 2: remove "All products"/)
    expect(one.totals).toMatchObject({ step: 1, steps: 2, operations: 1, removedProductGroups: 6 })
    expect(one.spendsMoney).toEqual([])
    expect(one.warnings).toContain('Until step 2 runs, "Group A" has no product groups: it shows no products.')
    expect((one.after as ProductGroupChangeRecord).nodes).toEqual([])
    // Step 2: the same request on the tree as step 1 left it.
    const two = draft(ask({ tree, inTwoSteps: true }), live([]))
    expect(two.operations).toHaveLength(4)
    expect(two.operations.every((op) => 'create' in (op as { adGroupCriterionOperation: object }).adGroupCriterionOperation)).toBe(true)
  })

  it('a split by item ID of Brand A becomes a split by condition: its units go and the new ones are made under the same split, in one request', () => {
    const tree = [
      node('901', null, 'SUBDIVISION', null),
      node('902', '901', 'SUBDIVISION', { productBrand: { value: 'Brand A' } }),
      node('903', '902', 'UNIT', { productItemId: { value: 'sku-1' } }, bid(30)),
      node('904', '902', 'UNIT', { productItemId: {} }, NEG),
      node('905', '901', 'UNIT', { productBrand: {} }, bid(20)),
    ]
    const want: TreeSpecNode[] = [{ split: 'BRAND' }, { parent: 0, value: 'Brand A', split: 'CONDITION' }, { parent: 1, value: 'NEW', bidCents: 30 }, { parent: 1, everythingElse: true, excluded: true }, { parent: 0, everythingElse: true, bidCents: 20 }]
    const d = draft(ask({ tree: want }), live(tree))
    expect(d.operations).toEqual([
      { adGroupCriterionOperation: { remove: `${AGC}903` } },
      { adGroupCriterionOperation: { remove: `${AGC}904` } },
      create(-1, `${AGC}902`, 'UNIT', { productCondition: { condition: 'NEW' } }, { cpcBidMicros: '300000' }),
      create(-2, `${AGC}902`, 'UNIT', { productCondition: {} }, { negative: true }),
    ])
    // Brand A's items were not all at one bid: Nexus cannot say how the new condition groups were advertised before.
    expect(d.spendsMoney).toEqual(['Advertises 1 product group in "Group A" whose products Nexus cannot match to the old tree (they may not have been advertised, or at a lower bid): brand "Brand A" › condition new at EUR 0.30.'])
  })

  it('step 1 removes only the split that must go when it is not "everything else"; its products fall under an advertised "everything else": SPENDS MONEY', () => {
    const tree = [
      node('901', null, 'SUBDIVISION', null),
      node('902', '901', 'SUBDIVISION', { productBrand: { value: 'Brand A' } }),
      node('903', '902', 'UNIT', { productItemId: { value: 'sku-1' } }, bid(30)),
      node('904', '902', 'UNIT', { productItemId: {} }, NEG),
      node('905', '901', 'UNIT', { productBrand: {} }, bid(20)),
    ]
    const want: TreeSpecNode[] = [{ split: 'BRAND' }, { parent: 0, value: 'Brand A', bidCents: 30 }, { parent: 0, everythingElse: true, bidCents: 20 }]
    const one = draft(ask({ tree: want, inTwoSteps: true }), live(tree))
    expect(one.operations).toEqual([{ adGroupCriterionOperation: { remove: `${AGC}902` } }])
    expect(one.spendsMoney).toEqual(['Until step 2 runs, the products of brand "Brand A" fall under everything else (by brand) and are advertised at EUR 0.20 a click (some of them were excluded, or bid lower).'])
  })

  it('the same tree: nothing to change; a tree that breaks Google\'s rules: refused before anything is sent', () => {
    expect(refusal(ask({ tree: [{ split: 'BRAND' }, { parent: 0, value: 'BRAND A', bidCents: 40 }, { parent: 0, value: 'Brand B', excluded: true }, { parent: 0, everythingElse: true, excluded: true }] }), live(BRANDS))).toMatch(/^Nothing to change/)
    const bad = (tree: TreeSpecNode[]) => refusal(ask({ tree }), live([]))
    expect(bad([{ split: 'BRAND' }, { parent: 0, value: 'A', bidCents: 1 }])).toMatch(/without "everything else"/)
    expect(bad([{ split: 'BRAND' }, { parent: 0, everythingElse: true, bidCents: 1 }])).toMatch(/names no value/)
    expect(bad([{ split: 'PRODUCT_TYPE_2' }, { parent: 0, value: 'A', bidCents: 1 }, { parent: 0, everythingElse: true, excluded: true }])).toMatch(/needs a product group of level 1 with a value above it/)
    expect(bad([{ split: 'PRODUCT_TYPE_1' }, { parent: 0, value: 'A', bidCents: 1 }, { parent: 0, everythingElse: true, split: 'PRODUCT_TYPE_2' }, { parent: 2, value: 'B', bidCents: 1 }, { parent: 2, everythingElse: true, excluded: true }]))
      .toMatch(/tree\[2\]: cannot split by product type \(level 2\)/)
    expect(bad([{ split: 'BRAND' }, { parent: 0, value: 'A', split: 'BRAND' }])).toMatch(/already split by brand above it/)
    expect(bad([{ split: 'CONDITION' }, { parent: 0, value: 'broken', bidCents: 1 }])).toMatch(/not a condition Google knows \(NEW, USED, REFURBISHED\)/)
    expect(bad([{ split: 'CATEGORY_1' }, { parent: 0, value: 'Apparel', bidCents: 1 }])).toMatch(/Google's product category id/)
    expect(bad([{ split: 'ITEM_ID' }, { parent: 0, value: 'x'.repeat(51), bidCents: 1 }])).toMatch(/has 51 characters/)
    expect(bad([{ split: 'BRAND' }, { parent: 0, value: 'a', bidCents: 1 }, { parent: 0, value: 'A', bidCents: 1 }])).toMatch(/names "A" twice/)
    expect(bad([{ split: 'BRAND' }, { parent: 0, value: 'A' }])).toMatch(/give its bidCents/)
    expect(bad([{ split: 'BRAND', bidCents: 4 }])).toMatch(/a split has no bid/)
    expect(bad([{ parent: 0, value: 'x', bidCents: 1 }])).toMatch(/the first product group is the root/)
    expect(refusal(ask({ tree: BRAND_TREE, bids: [{ criterionId: '702', bidCents: 5 }] }), live(BRANDS))).toMatch(/give it alone/)
  })

  it('a tree as Google holds it and as a snapshot: the same tree, whatever order Google answers in', () => {
    const spec = treeOfSpec(BRAND_TREE)
    if ('refusal' in spec) throw new Error(spec.refusal)
    const a = snapshotOf(spec.root)
    expect(a.map((n) => n.value)).toEqual([null, 'Brand A', 'sku-1', null, null])
    expect(productGroupRecordNow({ campaignId: '21', adGroupId: '51', tree: { kind: 'none' }, nodes: [] }, [...DEEP].reverse()).nodes!.map((n) => n.id)).toEqual(['801', '802', '803', '804', '805', '806'])
  })
})

describe('the tree as it is: add, subdivide, remove, removeTree (with bids, exclude, include)', () => {
  it('add a unit under a split, subdivide a unit, a bid and an exclusion: one request', () => {
    const d = draft(ask({
      add: [{ parentId: '701', value: 'Brand C', bidCents: 25 }],
      subdivide: [{ criterionId: '702', split: 'ITEM_ID', children: [{ value: 'sku-1', bidCents: 60 }], everythingElse: { bidCents: 40 } }],
      include: [{ criterionId: '703', bidCents: 10 }],
    }), live(BRANDS))
    expect(d.operations).toEqual([
      { adGroupCriterionOperation: { remove: `${AGC}702` } },
      { adGroupCriterionOperation: { remove: `${AGC}703` } },
      create(-1, `${AGC}701`, 'SUBDIVISION', { productBrand: { value: 'Brand A' } }),
      create(-2, `${AGC}-1`, 'UNIT', { productItemId: { value: 'sku-1' } }, { cpcBidMicros: '600000' }),
      create(-3, `${AGC}-1`, 'UNIT', { productItemId: {} }, { cpcBidMicros: '400000' }),
      create(-4, `${AGC}701`, 'UNIT', { productBrand: { value: 'Brand B' } }, { cpcBidMicros: '100000' }),
      create(-5, `${AGC}701`, 'UNIT', { productBrand: { value: 'Brand C' } }, { cpcBidMicros: '250000' }),
    ])
    expect(d.spendsMoney).toEqual([
      'Advertises 2 product groups in "Group A" that were not advertised there before: brand "Brand B" at EUR 0.10, brand "Brand C" at EUR 0.25.',
      'Raises the bid of 1 product group in "Group A": brand "Brand A" › item "sku-1" EUR 0.40 → EUR 0.60.',
    ])
  })

  it('remove a unit: its products fall under "everything else" (excluded here: no money)', () => {
    const d = draft(ask({ remove: ['702'] }), live(BRANDS))
    expect(d.operations).toEqual([{ adGroupCriterionOperation: { remove: `${AGC}702` } }])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings).toContain('The products of brand "Brand A" fall under everything else (by brand), which is excluded: they are not advertised.')
  })

  it('remove a split: a request of its own (removals only); its products fall under an advertised "everything else": SPENDS MONEY', () => {
    const tree = [...BRANDS.slice(0, 3), node('704', '701', 'UNIT', { productBrand: {} }, bid(50)), node('705', '701', 'SUBDIVISION', { productBrand: { value: 'Brand C' } }), node('706', '705', 'UNIT', { productItemId: { value: 'sku-1' } }, bid(10)), node('707', '705', 'UNIT', { productItemId: {} }, NEG)]
    const d = draft(ask({ remove: ['705'] }), live(tree))
    expect(d.operations).toEqual([{ adGroupCriterionOperation: { remove: `${AGC}705` } }])
    expect(d.spendsMoney).toEqual(['The products of brand "Brand C" fall under everything else (by brand) and are advertised at EUR 0.50 a click (some of them were excluded, or bid lower).'])
    expect(refusal(ask({ remove: ['705'], add: [{ parentId: '701', value: 'Brand D', excluded: true }] }), live(tree))).toMatch(/must be a request of its own.*LISTING_GROUP_CANNOT_BE_REMOVED.*remove: \[705\] alone first/)
  })

  it('removeTree: the whole tree goes (the ad group shows no products); undo builds it again', () => {
    const d = draft(ask({ removeTree: true }), live(BRANDS))
    expect(d.operations).toEqual([{ adGroupCriterionOperation: { remove: `${AGC}701` } }])
    expect(d.summary).toBe('Google Ads product groups of "Group A": remove the whole tree (4 product groups) — the ad group shows no products until a tree is built again.')
    expect(productGroupUndoArgs({ before: d.before, after: d.after })).toEqual({
      args: { campaignId: '21', adGroupId: '51', inTwoSteps: true, tree: [{ split: 'BRAND' }, { parent: 0, value: 'Brand A', bidCents: 40 }, { parent: 0, value: 'Brand B', excluded: true }, { parent: 0, everythingElse: true, excluded: true }] },
    })
    expect(refusal(ask({ removeTree: true }), live([]))).toMatch(/Nothing to remove/)
  })

  it('refused before anything is sent: the root, an "everything else", a split named as a unit, a rule broken by a subdivide, a value there already', () => {
    expect(refusal(ask({ remove: ['701'] }), live(BRANDS))).toMatch(/is the root.*removeTree/)
    expect(refusal(ask({ remove: ['704'] }), live(BRANDS))).toMatch(/is "everything else": every split keeps one/)
    expect(refusal(ask({ remove: ['702', '703'] }), live(BRANDS))).toMatch(/would keep only "everything else"/)
    expect(refusal(ask({ subdivide: [{ criterionId: '701', split: 'ITEM_ID', children: [{ value: 'a', bidCents: 1 }], everythingElse: { excluded: true } }] }), live(BRANDS))).toMatch(/is a split: it is split already/)
    expect(refusal(ask({ subdivide: [{ criterionId: '702', split: 'BRAND', children: [{ value: 'a', bidCents: 1 }], everythingElse: { excluded: true } }] }), live(BRANDS))).toMatch(/already split by brand above it/)
    expect(refusal(ask({ add: [{ parentId: '701', value: 'brand a', bidCents: 3 }] }), live(BRANDS))).toMatch(/already has "brand a"/)
    expect(refusal(ask({ add: [{ parentId: '702', value: 'x', bidCents: 3 }] }), live(BRANDS))).toMatch(/is not a split: split it with subdivide/)
    expect(refusal(ask({ add: [{ parentId: '701', value: 'x', bidCents: 3 }] }), live([]))).toMatch(/has no product groups: build a tree first/)
  })
})

describe('records and undo of a change of any tree', () => {
  it('the run gives the ids of what it made; Google\'s tree now reads equal; undo asks for the old tree (two steps when a unit comes back where a split stands)', () => {
    const d = draft(ask({ subdivide: [{ criterionId: '702', split: 'ITEM_ID', children: [{ value: 'SKU-1', bidCents: 60 }], everythingElse: { bidCents: 40 } }] }), live(BRANDS))
    const ran = productGroupRecordAfterRun(d.after as ProductGroupChangeRecord, [{}, { adGroupCriterionResult: { resourceName: `${AGC}910` } }, { adGroupCriterionResult: { resourceName: `${AGC}911` } }, { adGroupCriterionResult: { resourceName: `${AGC}912` } }])
    expect(ran.nodes!.map((n) => n.id)).toEqual(['701', '910', '911', '912', '703', '704'])
    // Google answers the item id in lower case: still the same tree.
    const now = [BRANDS[0], node('910', '701', 'SUBDIVISION', { productBrand: { value: 'Brand A' } }), node('911', '910', 'UNIT', { productItemId: { value: 'sku-1' } }, bid(60)), node('912', '910', 'UNIT', { productItemId: {} }, bid(40)), BRANDS[2], BRANDS[3]]
    expect(productGroupRecordNow(ran, now)).toEqual(ran)
    expect(productGroupUndoArgs({ before: d.before, after: ran })).toEqual({
      args: { campaignId: '21', adGroupId: '51', inTwoSteps: true, tree: [{ split: 'BRAND' }, { parent: 0, value: 'Brand A', bidCents: 40 }, { parent: 0, value: 'Brand B', excluded: true }, { parent: 0, everythingElse: true, excluded: true }] },
    })
    // The undo itself: step 1 removes the new split of Brand A; its products fall under "everything else", excluded.
    const undo = draft(ask({ tree: [{ split: 'BRAND' }, { parent: 0, value: 'Brand A', bidCents: 40 }, { parent: 0, value: 'Brand B', excluded: true }, { parent: 0, everythingElse: true, excluded: true }], inTwoSteps: true }), live(now))
    expect(undo.operations).toEqual([{ adGroupCriterionOperation: { remove: `${AGC}910` } }])
    const two = draft(ask({ tree: [{ split: 'BRAND' }, { parent: 0, value: 'Brand A', bidCents: 40 }, { parent: 0, value: 'Brand B', excluded: true }, { parent: 0, everythingElse: true, excluded: true }], inTwoSteps: true }), live([BRANDS[0], BRANDS[2], BRANDS[3]]))
    expect(two.operations).toEqual([create(-1, `${AGC}701`, 'UNIT', { productBrand: { value: 'Brand A' } }, { cpcBidMicros: '400000' })])
  })

  it('a tree made where there was none: undo removes it; a tree Nexus cannot rebuild: said', () => {
    const d = draft(ask({ tree: BRAND_TREE }), live([]))
    expect(productGroupUndoArgs({ before: d.before, after: d.after })).toEqual({ args: { campaignId: '21', adGroupId: '51', removeTree: true } })
    const bidless = { campaignId: '21', adGroupId: '51', tree: { kind: 'all' as const, bidCents: null, excluded: false }, nodes: [{ id: '1', parent: null, dim: null, value: null, kind: 'UNIT' as const, split: null, excluded: false, bidCents: null }] }
    expect(productGroupUndoArgs({ before: bidless, after: d.after })).toMatchObject({ refusal: expect.stringContaining('no bid of its own') })
  })
})
