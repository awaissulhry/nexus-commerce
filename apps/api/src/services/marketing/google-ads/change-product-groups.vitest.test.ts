/**
 * Google Ads changes (2026-10-15) — a Shopping ad group's product groups, built from a request and the live tree (pure):
 * the exact Google operations (temporary ids, the old root removed first, "everything else" EXCLUDED unless asked, a unit
 * made again to exclude or include it), what spends money, what is refused before anything is sent, and the record undo
 * reads (a rebuild of a tree split by item ID, or the old bids).
 */
import { describe, expect, it } from 'vitest'
import {
  productGroupChangeDraft, productGroupRecordAfterRun, productGroupRecordNow, productGroupUndoArgs, treeOf, type ProductGroupChangeRecord,
  type ProductGroupRequest,
} from './change-product-groups.js'
import { productGroupNodeOf, type ProductGroupLiveState, type ShoppingAdGroupLive } from './live-product-groups.js'
import type { GoogleChangeDraft } from './change-draft.js'

const C = 'customers/1234567890'
const AGC = `${C}/adGroupCriteria/51~`
const adGroup = (status = 'ENABLED', campaign: Partial<ShoppingAdGroupLive['campaign']> = {}): ShoppingAdGroupLive => ({
  adGroupId: '51', name: 'Group A', status, type: 'SHOPPING_PRODUCT_ADS',
  campaign: { campaignId: '21', name: 'Shop A', status: 'ENABLED', type: 'SHOPPING', bidding: 'MANUAL_CPC', ...campaign },
})
/** One listing group as Google's GAQL row has it. */
const node = (id: string, parent: string | null, type: 'UNIT' | 'SUBDIVISION', caseValue: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
  productGroupNodeOf({
    adGroup: { id: '51' },
    adGroupCriterion: { criterionId: id, listingGroup: { type, ...(parent ? { parentAdGroupCriterion: `${AGC}${parent}` } : {}), ...(caseValue ? { caseValue } : {}) }, ...extra },
  })
const bid = (cents: number) => ({ cpcBidMicros: String(cents * 10_000) })
const NEG = { negative: true }

/** "All products" alone at EUR 0.50. */
const ALL = [node('600', null, 'UNIT', null, bid(50))]
/** "All products" by item ID: sku-1 at EUR 0.30, sku-2 excluded, everything else excluded. */
const ITEMS = [
  node('601', null, 'SUBDIVISION', null),
  node('602', '601', 'UNIT', { productItemId: { value: 'sku-1' } }, bid(30)),
  node('603', '601', 'UNIT', { productItemId: { value: 'sku-2' } }, NEG),
  node('604', '601', 'UNIT', { productItemId: {} }, NEG),
]
/** By brand: Brand A at EUR 0.40, Brand B excluded, everything else ADVERTISED at EUR 0.20 (Google sent no case value for it). */
const BRANDS = [
  node('701', null, 'SUBDIVISION', null),
  node('702', '701', 'UNIT', { productBrand: { value: 'Brand A' } }, bid(40)),
  node('703', '701', 'UNIT', null, bid(20)),
  node('704', '701', 'UNIT', { productBrand: { value: 'Brand B' } }, NEG),
]
const live = (nodes: ReturnType<typeof node>[], group: ShoppingAdGroupLive | null = adGroup()): ProductGroupLiveState => ({ adGroup: group, nodes })
const ask = (extra: Partial<ProductGroupRequest>): ProductGroupRequest => ({ campaignId: '21', adGroupId: '51', ...extra })
const draft = (request: ProductGroupRequest, state: ProductGroupLiveState): GoogleChangeDraft => {
  const d = productGroupChangeDraft(C, 'EUR', request, state)
  if ('refusal' in d) throw new Error(d.refusal)
  return d
}

describe('reading a tree', () => {
  it('none, "All products" alone, a split by item ID (its "everything else" read by its siblings when Google sends no case value), anything else', () => {
    expect(treeOf([])).toEqual({ kind: 'none' })
    expect(treeOf(ALL)).toEqual({ kind: 'all', bidCents: 50, excluded: false })
    expect(treeOf(ITEMS)).toEqual({
      kind: 'items',
      items: [{ itemId: 'sku-1', bidCents: 30, excluded: false }, { itemId: 'sku-2', bidCents: null, excluded: true }],
      everythingElse: { bidCents: null, excluded: true },
    })
    const bare = ITEMS.map((n) => (n.criterionId === '604' ? node('604', '601', 'UNIT', null, NEG) : n))
    expect(treeOf(bare)).toEqual(treeOf(ITEMS))
    expect(treeOf(BRANDS)).toEqual({ kind: 'other', groups: 4, units: 3 })
  })

  it('a node of a dimension live.ts does not read (condition) has its value: it is not "everything else"', () => {
    const used = node('801', '800', 'UNIT', { productCondition: { condition: 'USED' } }, NEG)
    expect(used).toMatchObject({ dimension: 'productCondition', value: 'USED', excluded: true, parentId: '800' })
    expect(node('802', '800', 'UNIT', { productType: { level: 'LEVEL1' } })).toMatchObject({ dimension: 'productType:LEVEL1', value: null })
  })
})

describe('rebuild: "All products" split by item ID', () => {
  it('a new tree: one request, the root and its children by temporary ids, "everything else" EXCLUDED by default', () => {
    const d = draft(ask({ itemIds: ['SKU-1', 'sku-2', 'Sku-1'], bidCents: 30, itemBids: [{ itemId: 'sku-2', bidCents: 45 }] }), live([]))
    expect(d.operations).toEqual([
      { adGroupCriterionOperation: { create: { resourceName: `${AGC}-1`, status: 'ENABLED', listingGroup: { type: 'SUBDIVISION' } } } },
      { adGroupCriterionOperation: { create: { resourceName: `${AGC}-2`, status: 'ENABLED', listingGroup: { type: 'UNIT', parentAdGroupCriterion: `${AGC}-1`, caseValue: { productItemId: {} } }, negative: true } } },
      { adGroupCriterionOperation: { create: { resourceName: `${AGC}-3`, status: 'ENABLED', listingGroup: { type: 'UNIT', parentAdGroupCriterion: `${AGC}-1`, caseValue: { productItemId: { value: 'SKU-1' } } }, cpcBidMicros: '300000' } } },
      { adGroupCriterionOperation: { create: { resourceName: `${AGC}-4`, status: 'ENABLED', listingGroup: { type: 'UNIT', parentAdGroupCriterion: `${AGC}-1`, caseValue: { productItemId: { value: 'sku-2' } } }, cpcBidMicros: '450000' } } },
    ])
    expect(d.skipped).toEqual(['"Sku-1" is named twice in itemIds (item ids are compared without case): it gets one product group.'])
    expect(d.spendsMoney).toEqual(['Advertises 2 items in "Group A" that were not advertised there before, at EUR 0.30–EUR 0.45 a click: "SKU-1", "sku-2".'])
    expect(d.warnings).toEqual([])
    expect(d.totals).toEqual({ operations: 4, units: 3, excluded: 1, itemsWithBid: 2 })
    expect(d.changes).toMatchObject({
      'product groups of "Group A"': { from: 'no product groups (the ad group shows no products)', to: '"All products" split by item ID: 2 items; everything else excluded' },
      '"everything else" (every other product of the feed)': { from: 'not advertised (no product groups)', to: 'excluded' },
      'item "SKU-1"': { from: 'not advertised (no product groups)', to: 'EUR 0.30 a click' },
    })
    expect(d.summary).toBe('Google Ads product groups of "Group A": make "All products" split by item ID — 2 items with a bid, everything else excluded.')
    expect(d.after).toEqual({
      campaignId: '21', adGroupId: '51',
      tree: { kind: 'items', items: [{ itemId: 'SKU-1', bidCents: 30, excluded: false }, { itemId: 'sku-2', bidCents: 45, excluded: false }], everythingElse: { bidCents: null, excluded: true } },
    })
  })

  it('"All products" alone is replaced in the same request (removing a lone unit is not recursive); a raise over it spends, paused campaign noted', () => {
    const d = draft(ask({ itemIds: ['sku-1', 'sku-3'], itemBids: [{ itemId: 'sku-1', bidCents: 60 }], bidCents: 30, excludeItemIds: ['sku-9'] }), live(ALL, adGroup('ENABLED', { status: 'PAUSED' })))
    expect(d.operations[0]).toEqual({ adGroupCriterionOperation: { remove: `${AGC}600` } })
    expect(d.operations[1]).toEqual({ adGroupCriterionOperation: { create: { resourceName: `${AGC}-1`, status: 'ENABLED', listingGroup: { type: 'SUBDIVISION' } } } })
    expect(d.operations[5]).toEqual({ adGroupCriterionOperation: { create: { resourceName: `${AGC}-5`, status: 'ENABLED', listingGroup: { type: 'UNIT', parentAdGroupCriterion: `${AGC}-1`, caseValue: { productItemId: { value: 'sku-9' } } }, negative: true } } })
    expect(d.operations).toHaveLength(6)
    expect(d.spendsMoney).toEqual(['Raises the bid of 1 item in "Group A": "sku-1" EUR 0.50 → EUR 0.60 (the campaign is paused: nothing spends until it is enabled).'])
    expect(d.warnings).toEqual([
      'After this change only the items named here can be advertised in "Group A": everything else is excluded.',
      'Replaces "All products" of "Group A" with the new tree in the same request: the new product groups get new ids, so their own statistics in Google Ads start from zero.',
    ])
    expect(d.changes['item "sku-3"']).toEqual({ from: 'in "All products", EUR 0.50 a click', to: 'EUR 0.30 a click' })
    expect(d.totals).toMatchObject({ units: 4, excluded: 2, itemsWithBid: 2 })
    expect(d.totals).not.toHaveProperty('keepTheirIds')
    expect(d.before).toEqual({ campaignId: '21', adGroupId: '51', tree: { kind: 'all', bidCents: 50, excluded: false } })
  })

  it('includeEverythingElse on a split by item ID: only "everything else" is made again (under the real root) — SPENDS MONEY in plain words, and the warning that it is NOT excluded', () => {
    const d = draft(ask({ itemIds: ['sku-1'], bidCents: 30, excludeItemIds: ['sku-2'], includeEverythingElse: { bidCents: 10 } }), live(ITEMS))
    expect(d.operations).toEqual([
      { adGroupCriterionOperation: { remove: `${AGC}604` } },
      { adGroupCriterionOperation: { create: { resourceName: `${AGC}-1`, status: 'ENABLED', listingGroup: { type: 'UNIT', parentAdGroupCriterion: `${AGC}601`, caseValue: { productItemId: {} } }, cpcBidMicros: '100000' } } },
    ])
    expect(d.spendsMoney).toEqual(['Advertises every other product of the feed in "Group A" at EUR 0.10 a click: every product of the campaign\'s Merchant Center feed that this tree does not name can be advertised.'])
    expect(d.warnings).toEqual([
      '"Everything else" in "Group A" is NOT excluded: every product of the feed that the tree does not name can be advertised.',
      '1 product group switches between advertised and excluded: Google cannot switch one, so it is removed and made again in the same request (a new id; its own statistics in Google Ads start from zero). The product groups that stay keep their ids and statistics.',
    ])
    expect(d.changes).toMatchObject({ '"everything else" (every other product of the feed)': { from: 'excluded', to: 'EUR 0.10 a click' } })
    expect(d.totals).toMatchObject({ itemsUnchanged: 2, keepTheirIds: 3 })
  })

  it('a split by item ID is changed in place, never removed (Google refuses to remove a split while the request makes one): updates, then removes, then creates under the real root', () => {
    const d = draft(ask({ itemIds: ['sku-1', 'sku-3'], itemBids: [{ itemId: 'sku-1', bidCents: 40 }], bidCents: 30 }), live(ITEMS))
    expect(d.operations).toEqual([
      { adGroupCriterionOperation: { update: { resourceName: `${AGC}602`, cpcBidMicros: '400000' }, updateMask: 'cpc_bid_micros' } },
      { adGroupCriterionOperation: { remove: `${AGC}603` } },
      { adGroupCriterionOperation: { create: { resourceName: `${AGC}-1`, status: 'ENABLED', listingGroup: { type: 'UNIT', parentAdGroupCriterion: `${AGC}601`, caseValue: { productItemId: { value: 'sku-3' } } }, cpcBidMicros: '300000' } } },
    ])
    expect(JSON.stringify(d.operations)).not.toContain(`"remove":"${AGC}601"`)
    expect(d.spendsMoney).toEqual([
      'Advertises 1 item in "Group A" that was not advertised there before, at EUR 0.30 a click: "sku-3".',
      'Raises the bid of 1 item in "Group A": "sku-1" EUR 0.30 → EUR 0.40.',
    ])
    expect(d.changes['item "sku-2"']).toEqual({ from: 'excluded', to: 'not named: under everything else (excluded)' })
    expect(d.warnings).toEqual([])
    expect(d.summary).toBe('Google Ads product groups of "Group A": change the tree to "All products" split by item ID — 2 items with a bid, everything else excluded.')
    expect(d.totals).toMatchObject({ operations: 3, keepTheirIds: 3 })
  })

  it('items that leave the split fall under an advertised "everything else": SPENDS MONEY when they were excluded or had a lower bid', () => {
    const tree = [...ITEMS, node('605', '601', 'UNIT', { productItemId: { value: 'sku-4' } }, bid(5)), node('606', '601', 'UNIT', { productItemId: { value: 'sku-5' } }, bid(80))]
    const d = draft(ask({ itemIds: ['sku-1'], bidCents: 30, includeEverythingElse: { bidCents: 10 } }), live(tree))
    expect(d.spendsMoney).toEqual([
      'Advertises every other product of the feed in "Group A" at EUR 0.10 a click: every product of the campaign\'s Merchant Center feed that this tree does not name can be advertised.',
      '2 items leave the tree of "Group A" and are advertised under "everything else" at EUR 0.10 a click: "sku-2" excluded → EUR 0.10, "sku-4" EUR 0.05 → EUR 0.10.',
    ])
  })

  it('a deeper tree, or a split by another dimension, is refused: Nexus never removes a split', () => {
    const deep = [
      node('801', null, 'SUBDIVISION', null),
      node('802', '801', 'SUBDIVISION', { productBrand: { value: 'Brand A' } }),
      node('803', '801', 'UNIT', { productBrand: {} }, NEG),
      node('804', '802', 'UNIT', { productItemId: { value: 'sku-1' } }, bid(30)),
      node('805', '802', 'UNIT', { productItemId: {} }, NEG),
    ]
    expect(productGroupChangeDraft(C, 'EUR', ask({ itemIds: ['sku-1'], bidCents: 30 }), live(deep))).toEqual({
      refusal: 'The product groups of "Group A" have more than one level (5 product groups). Google cannot remove a split in the request that makes the new one, so Nexus does not rebuild this tree: remove it first in Google Ads, then build it here with itemIds.',
    })
    expect(productGroupChangeDraft(C, 'EUR', ask({ itemIds: ['sku-1'], bidCents: 30 }), live(BRANDS))).toEqual({
      refusal: 'The tree of "Group A" splits by brand, not by item ID: remove it first in Google Ads, or change its product groups as they are (bids, exclude, include).',
    })
  })

  it('the tree asked is already there: nothing to change (item ids compared without case)', () => {
    expect(productGroupChangeDraft(C, 'EUR', ask({ itemIds: ['SKU-1'], bidCents: 30, excludeItemIds: ['Sku-2'] }), live(ITEMS))).toEqual({
      refusal: 'Nothing to change: the product groups of "Group A" are already exactly this tree ("All products" split by item ID: 2 items (1 excluded); everything else excluded).',
    })
  })

  it('a bid strategy that is not Manual CPC: said', () => {
    const d = draft(ask({ itemIds: ['sku-1'], bidCents: 30 }), live([], adGroup('ENABLED', { bidding: 'TARGET_ROAS' })))
    expect(d.warnings).toContain('The campaign bids with TARGET_ROAS, not Manual CPC: Google may not use the bids set here.')
  })
})

describe('units: bids, exclude, include on the tree as it is', () => {
  it('a bid change is an update of cpc_bid_micros; a raise spends; the record keeps the old and new bids', () => {
    const d = draft(ask({ bids: [{ criterionId: '602', bidCents: 40 }] }), live(ITEMS))
    expect(d.operations).toEqual([{ adGroupCriterionOperation: { update: { resourceName: `${AGC}602`, cpcBidMicros: '400000' }, updateMask: 'cpc_bid_micros' } }])
    expect(d.spendsMoney).toEqual(['Raises the bid of item "sku-1" in "Group A" from EUR 0.30 to EUR 0.40 a click.'])
    expect(d.changes).toEqual({ 'item "sku-1"': { from: 'EUR 0.30 a click', to: 'EUR 0.40 a click' } })
    expect(d.before).toMatchObject({ bids: [{ criterionId: '602', bidCents: 30 }] })
    expect(d.after).toMatchObject({ bids: [{ criterionId: '602', bidCents: 40 }], tree: { kind: 'items', items: [{ itemId: 'sku-1', bidCents: 40, excluded: false }, { itemId: 'sku-2', bidCents: null, excluded: true }] } })
    const cut = draft(ask({ bids: [{ criterionId: '602', bidCents: 20 }] }), live(ITEMS))
    expect(cut.spendsMoney).toEqual([])
  })

  it('exclude / include: the unit is removed and made again (negative is immutable), same case value and parent; "everything else" without a case value takes its siblings\' dimension', () => {
    const d = draft(ask({ exclude: ['703'], include: [{ criterionId: '704', bidCents: 25 }] }), live(BRANDS, adGroup('PAUSED')))
    expect(d.operations).toEqual([
      { adGroupCriterionOperation: { remove: `${AGC}703` } },
      { adGroupCriterionOperation: { remove: `${AGC}704` } },
      { adGroupCriterionOperation: { create: { resourceName: `${AGC}-1`, status: 'ENABLED', listingGroup: { type: 'UNIT', parentAdGroupCriterion: `${AGC}701`, caseValue: { productBrand: {} } }, negative: true } } },
      { adGroupCriterionOperation: { create: { resourceName: `${AGC}-2`, status: 'ENABLED', listingGroup: { type: 'UNIT', parentAdGroupCriterion: `${AGC}701`, caseValue: { productBrand: { value: 'Brand B' } } }, cpcBidMicros: '250000' } } },
    ])
    expect(d.spendsMoney).toEqual(['Advertises brand "Brand B" in "Group A" again, at EUR 0.25 a click (the ad group is paused: nothing spends until it is enabled).'])
    expect(d.changes).toEqual({
      '"everything else" (every other product of the feed)': { from: 'EUR 0.20 a click', to: 'excluded' },
      'brand "Brand B"': { from: 'excluded', to: 'EUR 0.25 a click' },
    })
    expect(d.warnings).toEqual(['Google cannot switch a product group between advertised and excluded, so these 2 are removed and made again in the same request: they get new ids and their own statistics in Google Ads start from zero.'])
    expect(d.totals).toMatchObject({ units: 3, excluded: 1, newlyExcluded: 1, newlyIncluded: 1 })
    // Each one made again is recorded with the operation whose result gives its new id (undo switches it back by that id).
    expect(d.before).toMatchObject({ bids: [], switched: [{ criterionId: '703', excluded: false, bidCents: 20 }, { criterionId: '704', excluded: true, bidCents: null }] })
    expect(d.after).toMatchObject({ bids: [], switched: [{ criterionId: 'op:2', excluded: true, bidCents: null }, { criterionId: 'op:3', excluded: false, bidCents: 25 }] })
    const ran = productGroupRecordAfterRun(d.after as ProductGroupChangeRecord, [{}, {}, { adGroupCriterionResult: { resourceName: `${AGC}901` } }, { adGroupCriterionResult: { resourceName: `${AGC}902` } }])
    expect(ran.switched).toEqual([{ criterionId: '901', excluded: true, bidCents: null }, { criterionId: '902', excluded: false, bidCents: 25 }])
  })

  it('"All products" alone can be excluded and advertised again (a lone unit, made again with no parent): advertising it is every product of the feed', () => {
    const off = draft(ask({ exclude: ['600'] }), live(ALL))
    expect(off.operations).toEqual([
      { adGroupCriterionOperation: { remove: `${AGC}600` } },
      { adGroupCriterionOperation: { create: { resourceName: `${AGC}-1`, status: 'ENABLED', listingGroup: { type: 'UNIT' }, negative: true } } },
    ])
    expect(off.warnings).toContain('Nothing can be advertised in "Group A" after this change: every product group of the tree is excluded.')
    const excludedAll = [node('600', null, 'UNIT', null, NEG)]
    const on = draft(ask({ include: [{ criterionId: '600', bidCents: 40 }] }), live(excludedAll))
    expect(on.operations[1]).toEqual({ adGroupCriterionOperation: { create: { resourceName: `${AGC}-1`, status: 'ENABLED', listingGroup: { type: 'UNIT' }, cpcBidMicros: '400000' } } })
    expect(on.spendsMoney).toEqual(['Advertises every product of the feed in "Group A" ("All products") at EUR 0.40 a click.'])
  })

  it('including "everything else" says it advertises every other product of the feed, and warns it is NOT excluded', () => {
    const d = draft(ask({ include: [{ criterionId: '604', bidCents: 5 }] }), live(ITEMS))
    expect(d.spendsMoney).toEqual(['Advertises every other product of the feed in "Group A" at EUR 0.05 a click: every product of the campaign\'s Merchant Center feed that the tree does not name can be advertised.'])
    expect(d.warnings[0]).toBe('"Everything else" in "Group A" is NOT excluded: every product of the feed that the tree does not name can be advertised.')
  })

  it('an "everything else" left advertised by an earlier change is warned about even when the change is only a bid', () => {
    const d = draft(ask({ bids: [{ criterionId: '702', bidCents: 35 }] }), live(BRANDS))
    expect(d.warnings).toEqual(['"Everything else" in "Group A" is NOT excluded: every product of the feed that the tree does not name can be advertised.'])
    expect(d.skipped).toEqual([])
  })
})

describe('refused before anything is sent', () => {
  const refusal = (request: ProductGroupRequest, state: ProductGroupLiveState = live(ITEMS)) => {
    const d = productGroupChangeDraft(C, 'EUR', request, state)
    return 'refusal' in d ? d.refusal : null
  }
  it('the ad group and its campaign', () => {
    expect(refusal(ask({ itemIds: ['a'], bidCents: 1 }), live([], null))).toMatch(/not in this account/)
    expect(refusal(ask({ campaignId: '22', itemIds: ['a'], bidCents: 1 }))).toBe('Ad group "Group A" (51) belongs to campaign "Shop A" (21), not to campaign 22.')
    expect(refusal(ask({ itemIds: ['a'], bidCents: 1 }), live([], adGroup('ENABLED', { type: 'SEARCH' })))).toMatch(/is a SEARCH campaign: product groups belong to Standard Shopping/)
    expect(refusal(ask({ itemIds: ['a'], bidCents: 1 }), live([], { ...adGroup(), type: 'SEARCH_STANDARD' }))).toMatch(/only a Standard Shopping ad group/)
  })
  it('what is asked', () => {
    expect(refusal(ask({}))).toMatch(/^Say what to change/)
    expect(refusal(ask({ itemIds: ['a'], bidCents: 1, bids: [{ criterionId: '602', bidCents: 2 }] }))).toMatch(/not both/)
    expect(refusal(ask({ itemIds: ['  '], bidCents: 1 }))).toBe('itemIds: an item id is empty.')
    expect(refusal(ask({ itemIds: ['x'.repeat(51)], bidCents: 1 }))).toMatch(/has 51 characters/)
    expect(refusal(ask({ itemIds: ['a==b'], bidCents: 1 }))).toMatch(/"==" or "&\+"/)
    expect(refusal(ask({ itemIds: ['a'], excludeItemIds: ['A'], bidCents: 1 }))).toMatch(/both in itemIds/)
    expect(refusal(ask({ itemIds: ['a'], itemBids: [{ itemId: 'b', bidCents: 1 }] }))).toBe('itemBids names "b", which is not in itemIds.')
    expect(refusal(ask({ itemIds: ['a', 'b'], itemBids: [{ itemId: 'a', bidCents: 1 }] }))).toBe('Give bidCents (the bid of every item) or a bid for each item in itemBids: "b" has none.')
    expect(refusal(ask({ itemIds: ['a'], bidCents: 1.5 }))).toMatch(/whole number of cents/)
    expect(refusal(ask({ itemIds: Array.from({ length: 200 }, (_, i) => `a${i}`), excludeItemIds: Array.from({ length: 51 }, (_, i) => `b${i}`), bidCents: 1 }))).toBe('251 item ids: at most 250 in one request.')
    expect(refusal(ask({ bidCents: 5 }))).toMatch(/^Name at least one item id/)
  })
  it('the product groups named', () => {
    expect(refusal(ask({ bids: [{ criterionId: '999', bidCents: 2 }] }))).toMatch(/Product group 999 is not in ad group "Group A"/)
    expect(refusal(ask({ bids: [{ criterionId: '601', bidCents: 2 }] }))).toMatch(/is a subdivision/)
    expect(refusal(ask({ bids: [{ criterionId: '603', bidCents: 2 }] }))).toMatch(/is excluded: it has no bid\. Use include/)
    expect(refusal(ask({ exclude: ['602'], include: [{ criterionId: '602', bidCents: 3 }] }))).toBe('Product group 602 is named twice (exclude and include).')
    expect(refusal(ask({ exclude: ['603', '604'] }))).toBe('Nothing to change: item "sku-2" is already excluded. "everything else" (every other product of the feed) is already excluded.')
  })
})

describe('undo', () => {
  const tree = (items: Array<[string, number | null]>, rest: number | null = null) => ({
    kind: 'items' as const,
    items: items.map(([itemId, bidCents]) => ({ itemId, bidCents, excluded: bidCents === null })),
    everythingElse: { bidCents: rest, excluded: rest === null },
  })
  const rec = (t: ProductGroupChangeRecord['tree'], bids?: ProductGroupChangeRecord['bids']): ProductGroupChangeRecord => ({ campaignId: '21', adGroupId: '51', tree: t, ...(bids ? { bids } : {}) })

  it('a rebuild puts the old tree split by item ID back, through the same tool', () => {
    expect(productGroupUndoArgs({ before: rec(tree([['sku-1', 30], ['sku-2', null]], 10)), after: rec(tree([['sku-3', 40]])) })).toEqual({
      args: { campaignId: '21', adGroupId: '51', itemIds: ['sku-1'], itemBids: [{ itemId: 'sku-1', bidCents: 30 }], excludeItemIds: ['sku-2'], includeEverythingElse: { bidCents: 10 } },
    })
  })
  it('a change of bids only puts the old bids back (a bid does not change a product group\'s id)', () => {
    const before = rec({ kind: 'other', groups: 4, units: 3 }, [{ criterionId: '702', bidCents: 40 }])
    const after = rec({ kind: 'other', groups: 4, units: 3 }, [{ criterionId: '702', bidCents: 35 }])
    expect(productGroupUndoArgs({ before, after })).toEqual({ args: { campaignId: '21', adGroupId: '51', bids: [{ criterionId: '702', bidCents: 40 }] } })
  })
  it('exclude / include put back by the ids Google gave the product groups they made again; bids by the same ids', () => {
    const before = rec({ kind: 'other', groups: 4, units: 3 }, [{ criterionId: '702', bidCents: 40 }])
    before.switched = [{ criterionId: '703', excluded: false, bidCents: 20 }, { criterionId: '704', excluded: true, bidCents: null }]
    const after = rec({ kind: 'other', groups: 4, units: 3 }, [{ criterionId: '702', bidCents: 35 }])
    after.switched = [{ criterionId: '901', excluded: true, bidCents: null }, { criterionId: '902', excluded: false, bidCents: 25 }]
    expect(productGroupUndoArgs({ before, after })).toEqual({
      args: { campaignId: '21', adGroupId: '51', bids: [{ criterionId: '702', bidCents: 40 }], exclude: ['902'], include: [{ criterionId: '901', bidCents: 20 }] },
    })
    after.switched[0].criterionId = null
    expect(productGroupUndoArgs({ before, after })).toMatchObject({ refusal: expect.stringContaining('does not record the ids Google gave') })
  })

  it('"All products" alone comes back as the whole tree in two steps (a unit where a split stands); no old tree: the tree is removed; any other old tree by hand', () => {
    expect(productGroupUndoArgs({ before: rec({ kind: 'all', bidCents: 50, excluded: false }), after: rec(tree([['a', 1]])) })).toEqual({ args: { campaignId: '21', adGroupId: '51', tree: [{ bidCents: 50 }], inTwoSteps: true } })
    expect(productGroupUndoArgs({ before: rec({ kind: 'all', bidCents: null, excluded: true }), after: rec(tree([['a', 1]])) })).toEqual({ args: { campaignId: '21', adGroupId: '51', tree: [{ excluded: true }], inTwoSteps: true } })
    expect(productGroupUndoArgs({ before: rec({ kind: 'other', groups: 4, units: 3 }), after: rec(tree([['a', 1]])) })).toMatchObject({ refusal: expect.stringContaining('not a single split by item ID: put them back by hand in Google Ads') })
    expect(productGroupUndoArgs({ before: rec({ kind: 'none' }), after: rec(tree([['a', 1]])) })).toEqual({ args: { campaignId: '21', adGroupId: '51', removeTree: true } })
  })
  it('what Google holds now reads in the shape of the record: an id Google answers in another case is the same item', () => {
    const after = rec(tree([['SKU-1', 30], ['sku-2', null]]))
    expect(productGroupRecordNow(after, ITEMS)).toEqual(after)
    const moved = ITEMS.map((n) => (n.criterionId === '602' ? node('602', '601', 'UNIT', { productItemId: { value: 'sku-1' } }, bid(31)) : n))
    expect(productGroupRecordNow(after, moved)).not.toEqual(after)
  })
})
