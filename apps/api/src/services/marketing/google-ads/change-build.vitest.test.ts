/**
 * Google Ads changes, PR 6 (2026-10-15) — a whole build in ONE request (pure): temporary ids unique across the request
 * and each defined before it is used; every campaign PAUSED; shared budgets and lists made first and pointed at by ref;
 * Shopping ad groups with their product ad and a tree whose "everything else" is excluded; a copied tree made again
 * parent-first; RSAs and assets checked before Google; names Google keeps unique refused when taken.
 */
import { describe, expect, it } from 'vitest'
import { buildDraft, buildRecordAfterRun, type BuildSpec } from './change-build.js'
import { treeNodes } from './build-copy.js'
import type { LiveBudget, LiveCampaign } from './live.js'

const C = 'customers/1234567890'
const live = { campaigns: [] as LiveCampaign[], budgets: [] as LiveBudget[], lists: [] }
const AD = {
  headlines: [{ text: 'Waterproof jacket' }, { text: 'Armour level 2' }, { text: 'Free returns' }],
  descriptions: [{ text: 'A jacket for every season.' }, { text: 'Sizes S to 5XL.' }],
  path1: 'jackets', finalUrl: 'https://shop.example/p/jacket',
}
const SPEC: BuildSpec = {
  sharedBudgets: [{ ref: 'b', name: 'Shared Z', budgetCents: 1200 }],
  negativeLists: [{ ref: 'l', name: 'List Z', keywords: [{ text: 'cheap', matchType: 'PHRASE' }, { text: 'Cheap', matchType: 'PHRASE' }] }],
  campaigns: [
    {
      type: 'SHOPPING', name: 'Shop Z', budget: { ref: 'b' }, bidding: { strategy: 'MANUAL_CPC' }, shopping: { merchantId: '5', feedLabel: 'IT', priority: 'HIGH' },
      locations: [{ id: '2380' }], negativeLists: [{ ref: 'l' }], negatives: [{ text: 'used', matchType: 'PHRASE' }],
      adGroups: [{ name: 'All items', defaultBidCents: 25, productGroups: { itemIds: ['sku-1', 'SKU-1', 'sku-2'], bidCents: 25 } }],
    },
    {
      type: 'SEARCH', name: 'Search Z', budget: { dailyBudgetCents: 600 }, bidding: { strategy: 'MANUAL_CPC' }, locations: [{ id: '2380' }], languages: ['1004'],
      adGroups: [{ name: 'Jackets', defaultBidCents: 35, keywords: [{ text: 'motorcycle jacket', matchType: 'EXACT', bidCents: 45 }], negatives: [{ text: 'kids', matchType: 'PHRASE' }], ads: [AD] }],
      assets: { callouts: ['Free returns'], sitelinks: [{ linkText: 'Size guide', description1: 'Find your size', description2: 'S to 5XL', finalUrl: 'https://shop.example/sizes' }] },
    },
  ],
}

const ids = (ops: unknown[]) => JSON.stringify(ops).match(/\/(campaignBudgets|sharedSets|campaigns|adGroups|adGroupCriteria\/\d+~|adGroupCriteria\/-\d+~|assets)\/?-\d+/g) ?? []

describe('buildDraft', () => {
  it('one request: budgets and lists first, campaigns PAUSED, refs resolved, temp ids unique and defined before use', () => {
    const d = buildDraft(C, 'EUR', SPEC, live)
    if ('refusal' in d) throw new Error(d.refusal)
    const ops = d.operations as Array<Record<string, any>>
    expect(Object.keys(ops[0])).toEqual(['campaignBudgetOperation'])
    expect(Object.keys(ops[1])).toEqual(['sharedSetOperation'])
    // The list's keyword once (duplicates by case are one keyword).
    expect(ops.filter((o) => o.sharedCriterionOperation)).toHaveLength(1)
    const creates = ops.map((o) => Object.values(o)[0].create).filter(Boolean)
    const campaigns = creates.filter((c) => c.advertisingChannelType)
    expect(campaigns.map((c) => c.status)).toEqual(['PAUSED', 'PAUSED'])
    expect(campaigns[0].campaignBudget).toBe(ops[0].campaignBudgetOperation.create.resourceName)
    // Every temporary id is made once, before anything points at it.
    const made = new Set<string>()
    for (const c of creates) {
      for (const ref of Object.values(c).filter((v) => typeof v === 'string' && /\/-\d+$/.test(v)) as string[]) {
        if (ref !== c.resourceName) expect(made.has(ref), `${ref} used before it is made`).toBe(true)
      }
      if (c.listingGroup?.parentAdGroupCriterion) expect(made.has(c.listingGroup.parentAdGroupCriterion)).toBe(true)
      if (c.resourceName) { expect(made.has(c.resourceName)).toBe(false); made.add(c.resourceName) }
    }
    expect(ids(ops).length).toBeGreaterThan(0)
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings[0]).toBe('Every campaign is made PAUSED: nothing spends until a person enables one (set-google-status, SPENDS MONEY). Once enabled, their daily budgets add up to EUR 18.00.')
  })

  it('a Shopping ad group: its product ad, and a tree whose "everything else" is EXCLUDED (item ids once, without case)', () => {
    const d = buildDraft(C, 'EUR', SPEC, live)
    if ('refusal' in d) throw new Error(d.refusal)
    const creates = (d.operations as Array<Record<string, any>>).map((o) => o.adGroupCriterionOperation?.create ?? o.adGroupAdOperation?.create).filter(Boolean)
    expect(creates).toContainEqual(expect.objectContaining({ ad: { shoppingProductAd: {} } }))
    const tree = creates.filter((c) => c.listingGroup)
    expect(tree).toHaveLength(1 + 1 + 2)
    expect(tree[0].listingGroup).toEqual({ type: 'SUBDIVISION' })
    expect(tree[1]).toMatchObject({ negative: true, listingGroup: { type: 'UNIT', caseValue: { productItemId: {} } } })
    expect(tree[1].cpcBidMicros).toBeUndefined()
    expect(tree.slice(2).map((t) => t.listingGroup.caseValue.productItemId.value)).toEqual(['sku-1', 'sku-2'])
  })

  it('refused before Google: a taken name, a broad keyword, an RSA too long, a Shopping ad group with keywords, an unknown ref', () => {
    const taken = buildDraft(C, 'EUR', SPEC, { ...live, campaigns: [{ campaignId: '9', name: 'shop z' } as LiveCampaign] })
    expect(taken).toMatchObject({ refusal: expect.stringContaining('A campaign named "Shop Z" already exists') })
    const bad: BuildSpec = { campaigns: [{
      type: 'SEARCH', name: 'S', budget: { ref: 'nope' }, bidding: { strategy: 'MANUAL_CPC' },
    }, {
      type: 'SEARCH', name: 'T', budget: { dailyBudgetCents: 100 }, bidding: { strategy: 'MANUAL_CPC' },
      adGroups: [{ name: 'G', keywords: [{ text: 'jacket', matchType: 'BROAD' }], ads: [{ ...AD, headlines: [{ text: 'x'.repeat(31) }, ...AD.headlines] }] }],
    }, {
      type: 'SHOPPING', name: 'U', budget: { dailyBudgetCents: 100 }, bidding: { strategy: 'MANUAL_CPC' }, shopping: { merchantId: '5' },
      adGroups: [{ name: 'G', keywords: [{ text: 'jacket', matchType: 'EXACT' }] }],
    }] }
    const r = buildDraft(C, 'EUR', bad, live)
    expect(r).toMatchObject({ refusal: expect.stringContaining('budget ref "nope" is not a budget of the build') })
    const text = (r as { refusal: string }).refusal
    expect(text).toContain('is BROAD (refused unless allowBroad)')
    expect(text).toContain('headline 1')
    expect(text).toContain('a Shopping ad group has no keywords or text ads')
  })

  it('a copied tree is made again parent-first; an open "everything else" is said', () => {
    const nodes = treeNodes([
      { criterionId: '3', parentId: '1', kind: 'UNIT', caseValue: { productItemId: { value: 'sku-1' } }, dimension: 'productItemId', value: 'sku-1', excluded: false, bidCents: 25 },
      { criterionId: '1', parentId: null, kind: 'SUBDIVISION', caseValue: null, dimension: null, value: null, excluded: false, bidCents: null },
      { criterionId: '2', parentId: '1', kind: 'UNIT', caseValue: { productItemId: {} }, dimension: 'productItemId', value: null, excluded: false, bidCents: 10 },
    ])
    expect(nodes.map((n) => n.parent)).toEqual([null, 0, 0])
    const d = buildDraft(C, 'EUR', { campaigns: [{ type: 'SHOPPING', name: 'Copy', budget: { dailyBudgetCents: 100 }, bidding: { strategy: 'MANUAL_CPC' }, shopping: { merchantId: '5' }, adGroups: [{ name: 'G', productGroups: { nodes } }] }] }, live)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.warnings).toContain('campaign 1 "Copy": 1 product group leave "everything else" OPEN: once enabled it can advertise every other product of the feed.')
  })

  it('after the run: Google\'s ids by the operation that made each', () => {
    const d = buildDraft(C, 'EUR', SPEC, live)
    if ('refusal' in d) throw new Error(d.refusal)
    const after = d.after as ReturnType<typeof buildRecordAfterRun>
    const responses = d.operations.map((_, i) => ({ campaignResult: { resourceName: `${C}/campaigns/${100 + i}` }, campaignBudgetResult: { resourceName: `${C}/campaignBudgets/${200 + i}` }, sharedSetResult: { resourceName: `${C}/sharedSets/${300 + i}` } }))
    const made = buildRecordAfterRun(after, responses)
    expect(made.sharedBudgets[0].budgetId).toBe('200')
    expect(made.negativeLists[0].listId).toBe('301')
    expect(made.campaigns.map((c) => c.campaignId)).toEqual(after.campaigns.map((c) => String(100 + c.op)))
  })
})
