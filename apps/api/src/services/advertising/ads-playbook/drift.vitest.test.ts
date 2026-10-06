/**
 * ADS PLAYBOOK PB-10 — drift, pure (drift.ts findDrift). Made-up values (public repo).
 *
 *   slots          a slot with no campaign, or whose campaign a person archived (keep: skipSlots only for an optional
 *                  slot), paused, of the wrong targeting, a name that differs (a warning), the portfolio
 *   placements     drift only where the hourly plans do not own the slot: an adopted campaign against what it held when
 *                  adopted, a built one against the playbook's; adopted before a baseline was kept: ONE item with one
 *                  keep; a person's own change offered as keep or revert (set-placement-multipliers); a built slot before
 *                  START unchecked
 *   ads, keywords  a child not advertised, a keyword the terms feed that is missing (with its planned bid), one a
 *                  person archived (keep: out of the terms), a term the product's own outside campaign holds (rule 2)
 *   misplaced      a brand keyword in the category slot goes to its right slot; one that wins stays (rule 2)
 *   negatives      isolation, source and product negatives; the lock, a protected term and a winner hold one back; a
 *                  negative a person lifted is his (keep or revert); nothing outside the product's own scope (rule 3)
 *   artifacts      missing, changed (re-saved), hours a re-save keeps (fix none, keep into overrides.rank), the Owner's
 *                  own plan holding a campaign (listed as held, never drift); bids and budgets are never drift
 */
import { describe, expect, it } from 'vitest'
import { templateDoc } from '../../../test-support/ads-playbook-fixtures.js'
import { findDrift, type DriftCampaign, type DriftFacts, type DriftSlotFacts, type ExpectedSlot } from './drift.js'
import { planIsolation, type PlannedNegative } from './isolation.js'
import type { Positive } from '../ads-winner-lock.js'

const doc = templateDoc()
const slotOf = (key: string) => doc.structure.slots.find((s) => s.key === key)!
const camp = (id: string, name: string, extra: Partial<DriftCampaign> = {}): DriftCampaign => ({
  id, name, status: 'ENABLED', targetingType: 'MANUAL', portfolioId: 'pf-1', liveWrites: true, placements: { top: 0, productPage: 0, restOfSearch: 0 }, ...extra,
})
const pos = (adGroupId: string, text: string, match: Positive['match'], id = `t-${adGroupId}-${text}`): Positive => ({ adTargetId: id, adGroupId, text, match, live: true })

/** Every slot linked and adopted, every ad group in scope, the product's two children advertised everywhere. */
function facts(over: Partial<DriftFacts> = {}): DriftFacts {
  const keys = doc.structure.slots.map((s) => s.key)
  const slots: DriftSlotFacts[] = keys.map((key) => ({ slot: slotOf(key), link: { campaignId: `c-${key}`, adGroupId: `g-${key}`, origin: 'adopted' }, lost: null }))
  const names: Record<string, string> = { auto: 'Auto', 'broad-category': 'Broad | Category', 'exact-category': 'Exact | Category', 'exact-brand': 'Exact | Brand', pat: 'PAT' }
  // As the playbook places them: PAT 10/15/0 (no rank role); the performance slots are rank's.
  const campaigns = new Map(keys.map((k) => [`c-${k}`, camp(`c-${k}`, `TESTTOK | IT | ${names[k]}`, k === 'auto' ? { targetingType: 'AUTO' } : k === 'pat' ? { placements: { top: 10, productPage: 15, restOfSearch: 0 } } : {})]))
  const expected = new Map<string, ExpectedSlot>([
    ['auto', { startBidCents: 40, keywords: [], productTargets: [] }],
    ['broad-category', { startBidCents: 36, keywords: [{ text: 'test jacket', match: 'BROAD', bidCents: 36, gated: true }, { text: 'test coat', match: 'BROAD', bidCents: 36, gated: true }], productTargets: [] }],
    ['exact-category', { startBidCents: 52, keywords: [{ text: 'test jacket', match: 'EXACT', bidCents: 52, gated: true }], productTargets: [] }],
    ['exact-brand', { startBidCents: 48, keywords: [{ text: 'testtok jacket', match: 'EXACT', bidCents: 48, gated: false }], productTargets: [] }],
    ['pat', { startBidCents: 44, keywords: [], productTargets: [{ asin: 'B0TESTRIV1', bidCents: 44 }] }],
  ])
  const positives = new Map<string, Positive[]>([
    ['g-broad-category', [pos('g-broad-category', 'test jacket', 'BROAD'), pos('g-broad-category', 'test coat', 'BROAD')]],
    ['g-exact-category', [pos('g-exact-category', 'test jacket', 'EXACT')]],
    ['g-exact-brand', [pos('g-exact-brand', 'testtok jacket', 'EXACT')]],
    ['g-pat', [pos('g-pat', 'B0TESTRIV1', 'PRODUCT')]],
  ])
  const ads = new Set(['B0TESTXX01', 'B0TESTXX02'])
  // The product's negative "test kids" (phrase) stands in every keyword and Auto slot.
  const standing = new Set(['auto', 'broad-category', 'exact-category', 'exact-brand'].map((k) => `g-${k}|PHRASE|test kids`))
  return {
    market: 'IT', product: { productId: 'p-1', sku: 'TEST-SKU' }, playbook: { id: 'pb-1', version: 4, state: 'RUNNING', scopeId: 'p-1' },
    doc, nameToken: 'TESTTOK',
    terms: { brand: ['testtok jacket'], category: [{ text: 'test jacket', exactAtStart: true }, { text: 'test coat', exactAtStart: false }], competitor: [], competitorAsins: ['B0TESTRIV1'], negatives: [{ text: 'test kids', match: 'PHRASE' }] },
    // Each adopted slot the hourly plans do not own, as its campaign held it when adopted.
    skipSlots: [], adoptedPlacements: { auto: { top: 0, productPage: 0, restOfSearch: 0 }, 'broad-category': { top: 0, productPage: 0, restOfSearch: 0 }, pat: { top: 10, productPage: 15, restOfSearch: 0 } },
    slots, campaigns,
    scope: new Set(keys.map((k) => `g-${k}`)), empty: new Set(), positives,
    archived: { positives: new Map(), negatives: new Map(), productAds: new Map() },
    standing, winners: new Map(), protections: new Map(),
    productAds: new Map(keys.map((k) => [`g-${k}`, ads])), expectedAds: [{ asin: 'B0TESTXX01', skus: ['TEST-V1'] }, { asin: 'B0TESTXX02', skus: ['TEST-V2'] }],
    expected, isolation: { adds: [] }, source: [], heldOutside: new Set(), outside: [], portfolioId: 'pf-1', personal: new Map(), liftedElsewhere: new Map(), hourlyPlans: new Map(),
    artifacts: { expectations: [], notChecked: [], held: [] }, notChecked: [],
    ...over,
  }
}
const kinds = (f: DriftFacts) => findDrift(f).items.map((i) => i.kind)
const one = (f: DriftFacts, kind: string) => findDrift(f).items.find((i) => i.kind === kind)

describe('a playbook that matches what is live', () => {
  it('has no drift; bids and budgets are never compared', () => {
    const r = findDrift(facts())
    expect(r.items).toEqual([])
    expect(r.counts).toMatchObject({ items: 0, bySync: 0 })
  })
})

describe('the slots and their campaigns', () => {
  it('a slot with no campaign is built by sync (adds spend); one a person archived is his: keep only for an optional slot', () => {
    const f = facts()
    f.slots = f.slots.map((s) => (s.slot.key === 'exact-brand' || s.slot.key === 'broad-category' ? { ...s, link: null, lost: { campaignId: `c-${s.slot.key}`, status: 'ARCHIVED' } } : s))
    f.personal = new Map([['c-exact-brand', [{ userId: 'user:u-owner', at: '2026-10-01T00:00:00.000Z', action: 'AD_ENTITY_STATE_UPDATE', changed: ['status'] }]], ['c-broad-category', [{ userId: 'user:u-owner', at: '2026-10-01T00:00:00.000Z', action: 'AD_ENTITY_STATE_UPDATE', changed: ['status'] }]]])
    const items = findDrift(f).items.filter((i) => i.kind === 'slot_missing')
    const brand = items.find((i) => i.slot === 'exact-brand')!
    expect(brand).toMatchObject({ fix: { by: 'sync', part: 'slots', addsSpend: true }, byPerson: { userId: 'user:u-owner' }, revert: { by: 'sync', part: 'slots' } })
    expect(brand.keep).toMatchObject({ tool: 'set-ads-playbook', args: { kind: 'playbook', market: 'IT', level: 'product', productId: 'p-1', values: { overrides: { skipSlots: ['exact-brand'] } }, expectVersion: 4 } })
    expect(items.find((i) => i.slot === 'broad-category')!.keep).toEqual({ note: expect.stringMatching(/not an optional slot/) })
  })

  it('paused (enable-ads), the wrong targeting (no fix: Amazon never changes it), a name (a warning), the portfolio', () => {
    const f = facts()
    f.campaigns.set('c-pat', camp('c-pat', 'Something else', { status: 'PAUSED', portfolioId: 'pf-other' }))
    f.campaigns.set('c-auto', camp('c-auto', 'TESTTOK | IT | Auto', { targetingType: 'MANUAL' }))
    const r = findDrift(f)
    expect(r.items.find((i) => i.kind === 'slot_paused')).toMatchObject({ slot: 'pat', fix: { by: 'tool', tool: 'enable-ads', args: { campaignIds: ['c-pat'] }, addsSpend: true } })
    expect(r.items.find((i) => i.kind === 'targeting_wrong')).toMatchObject({ slot: 'auto', fix: { by: 'none', note: expect.stringMatching(/never changes a campaign's targeting/) } })
    expect(r.items.find((i) => i.kind === 'name_differs')).toMatchObject({ slot: 'pat', warnOnly: true })
    expect(r.items.find((i) => i.kind === 'portfolio_membership')).toMatchObject({ slot: 'pat', fix: { by: 'none' } })
  })
})

describe('placements: only where the hourly plans do not own the slot', () => {
  it('an adopted research slot off its adopted baseline is drift (set-placement-multipliers); a performance slot never is', () => {
    const f = facts()
    f.campaigns.set('c-broad-category', camp('c-broad-category', 'TESTTOK | IT | Broad | Category', { placements: { top: 30, productPage: 0, restOfSearch: 0 } }))
    f.campaigns.set('c-exact-category', camp('c-exact-category', 'TESTTOK | IT | Exact | Category', { placements: { top: 400, productPage: 0, restOfSearch: 0 } }))
    const items = findDrift(f).items.filter((i) => i.kind === 'placement_differs')
    expect(items.map((i) => i.slot)).toEqual(['broad-category'])
    expect(items[0]).toMatchObject({ fix: { by: 'tool', tool: 'set-placement-multipliers', args: { campaignId: 'c-broad-category', topOfSearchPct: 0, productPagesPct: 0, restOfSearchPct: 0 }, addsSpend: false } })
    expect(items[0].byPerson).toBeUndefined()
    expect(items[0].says).toMatch(/when it was adopted they were 0\/0\/0 %/)
  })

  it('adopting never makes drift: the adopted baseline is what it held, whatever the playbook says', () => {
    const f = facts({ adoptedPlacements: { auto: { top: 0, productPage: 0, restOfSearch: 0 }, 'broad-category': { top: 40, productPage: 5, restOfSearch: 0 }, pat: { top: 10, productPage: 15, restOfSearch: 0 } } })
    f.campaigns.set('c-broad-category', camp('c-broad-category', 'TESTTOK | IT | Broad | Category', { placements: { top: 40, productPage: 5, restOfSearch: 0 } }))
    expect(kinds(f)).not.toContain('placement_differs')
  })

  it('a built slot is held to the playbook\'s placements; keep writes them into the placements section', () => {
    const f = facts()
    f.slots = f.slots.map((s) => (s.slot.key === 'pat' ? { ...s, link: { ...s.link!, origin: 'built' } } : s))
    f.campaigns.set('c-pat', camp('c-pat', 'TESTTOK | IT | PAT', { placements: { top: 10, productPage: 40, restOfSearch: 0 } }))
    f.personal = new Map([['c-pat', [{ userId: 'user:u-owner', at: '2026-10-02T00:00:00.000Z', action: 'update_placement_bidding' }]]])
    const item = one(f, 'placement_differs')!
    expect(item.says).toMatch(/the playbook says 10\/15\/0 %/)
    expect(item.keep).toMatchObject({ args: { values: { overrides: { placements: { pat: { top: 10, productPage: 40, restOfSearch: 0 } } } } } })
  })

  it('adopted before a baseline was kept: ONE item with one keep for all of them, never an alarm per slot', () => {
    const f = facts({ adoptedPlacements: {} })
    f.campaigns.set('c-broad-category', camp('c-broad-category', 'TESTTOK | IT | Broad | Category', { placements: { top: 30, productPage: 0, restOfSearch: 0 } }))
    const r = findDrift(f)
    expect(r.items.filter((i) => i.kind === 'placement_differs')).toEqual([])
    const missing = r.items.filter((i) => i.kind === 'placement_baseline_missing')
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({ slot: null, fix: { by: 'none' }, says: expect.stringMatching(/^3 adopted slots \("auto", "broad-category", "pat"\) have no placement baseline yet/) })
    expect(missing[0].keep).toMatchObject({ tool: 'set-ads-playbook', args: { values: { overrides: { adoptedPlacements: { auto: { top: 0 }, 'broad-category': { top: 30 }, pat: { top: 10, productPage: 15 } } } } } })
  })

  it("a person's own placement is offered as keep (written into the playbook) or revert — never put back by itself", () => {
    const f = facts()
    f.campaigns.set('c-pat', camp('c-pat', 'TESTTOK | IT | PAT', { placements: { top: 10, productPage: 40, restOfSearch: 0 } }))
    f.personal = new Map([['c-pat', [{ userId: 'user:u-owner', at: '2026-10-02T00:00:00.000Z', action: 'update_placement_bidding' }]]])
    const item = one(f, 'placement_differs')!
    expect(item).toMatchObject({ slot: 'pat', byPerson: { userId: 'user:u-owner', action: 'update_placement_bidding' }, revert: { by: 'tool', tool: 'set-placement-multipliers' } })
    expect(item.keep).toMatchObject({ tool: 'set-ads-playbook', args: { values: { overrides: { adoptedPlacements: { auto: { top: 0 }, pat: { top: 10, productPage: 40, restOfSearch: 0 } } } } } })
  })

  it("only the change that explains the drift is a person's: a budget edit is not a placement, a rule's switch is not its settings", () => {
    const f = facts()
    f.campaigns.set('c-broad-category', camp('c-broad-category', 'TESTTOK | IT | Broad | Category', { placements: { top: 30, productPage: 0, restOfSearch: 0 } }))
    f.personal = new Map([
      ['c-broad-category', [{ userId: 'user:u-owner', at: '2026-10-02T00:00:00.000Z', action: 'update_campaign', changed: ['dailyBudget'] }]],
      ['r-iso', [{ userId: 'user:u-approver', at: '2026-10-02T00:00:00.000Z', action: 'update_rule', changed: ['enabled'] }]],
    ])
    f.artifacts = { expectations: [{ kind: 'isolationRule', key: 'isolation', refId: 'r-iso', parts: { action: { expected: { a: 1 }, actual: { a: 2 } } } }], notChecked: [], held: [] }
    const r = findDrift(f)
    expect(r.items.find((i) => i.kind === 'placement_differs')!.byPerson).toBeUndefined()
    expect(r.items.find((i) => i.kind === 'artifact_changed')).toMatchObject({ fix: { by: 'sync' } })
    expect(r.items.find((i) => i.kind === 'artifact_changed')!.byPerson).toBeUndefined()
    f.personal = new Map([['r-iso', [{ userId: 'user:u-owner', at: '2026-10-03T00:00:00.000Z', action: 'update_rule', changed: ['actions'] }]]])
    expect(one(f, 'artifact_changed')).toMatchObject({ byPerson: { userId: 'user:u-owner' }, revert: { by: 'sync' }, keep: { note: expect.stringMatching(/Nothing to write/) } })
  })

  it('a campaign an hourly plan holds (the Owner\'s or the playbook\'s) is never compared: listed as held', () => {
    const f = facts({ hourlyPlans: new Map([['c-broad-category', 'the hourly plan "Owner plan"']]) })
    f.campaigns.set('c-broad-category', camp('c-broad-category', 'TESTTOK | IT | Broad | Category', { placements: { top: 300, productPage: 0, restOfSearch: 0 } }))
    const r = findDrift(f)
    expect(r.items.filter((i) => i.kind === 'placement_differs')).toEqual([])
    expect(r.heldBack).toContainEqual({ slot: 'broad-category', what: 'TESTTOK | IT | Broad | Category', why: expect.stringMatching(/held by the hourly plan "Owner plan"/) })
  })

  it('a full snapshot is a status change only when the status changed: a budget edit never explains an archive', () => {
    const f = facts()
    f.slots = f.slots.map((s) => (s.slot.key === 'exact-brand' ? { ...s, link: null, lost: { campaignId: 'c-exact-brand', status: 'ARCHIVED' } } : s))
    f.personal = new Map([['c-exact-brand', [{ userId: 'user:u-owner', at: '2026-10-01T00:00:00.000Z', action: 'AD_ENTITY_STATE_UPDATE', changed: ['dailyBudget'] }]]])
    expect(one(f, 'slot_missing')!.byPerson).toBeUndefined()
  })

  it('a built slot off the allowlist holds no placements until START: not checked, said', () => {
    const f = facts()
    f.slots = f.slots.map((s) => (s.slot.key === 'pat' ? { ...s, link: { ...s.link!, origin: 'built' } } : s))
    f.campaigns.set('c-pat', camp('c-pat', 'TESTTOK | IT | PAT', { liveWrites: false, placements: { top: 0, productPage: 0, restOfSearch: 0 } }))
    const r = findDrift(f)
    expect(r.items.filter((i) => i.kind === 'placement_differs')).toEqual([])
    expect(r.notChecked.join(' ')).toMatch(/Placements of "pat": a built campaign holds none until START/)
  })
})

describe('product ads and the keywords the terms feed', () => {
  it('a child not advertised is added by sync; an archived product ad is not', () => {
    const f = facts()
    f.productAds = new Map([...f.productAds].map(([g, s]) => [g, g === 'g-auto' ? new Set(['B0TESTXX01']) : s]))
    f.archived = { ...f.archived, productAds: new Map([['g-pat', new Set(['B0TESTXX02'])]]) }
    f.productAds.set('g-pat', new Set(['B0TESTXX01']))
    const r = findDrift(f)
    expect(r.items.find((i) => i.kind === 'product_ad_missing')).toMatchObject({ slot: 'auto', asin: 'B0TESTXX02', sku: 'TEST-V2', fix: { by: 'sync', part: 'productAds', addsSpend: true } })
    expect(r.items.find((i) => i.kind === 'product_ad_archived')).toMatchObject({ slot: 'pat', fix: { by: 'none' } })
  })

  it('a missing keyword carries its planned bid; a term the product\'s own outside campaign holds stays there (rule 2)', () => {
    const f = facts()
    f.positives.set('g-broad-category', [pos('g-broad-category', 'test jacket', 'BROAD')])
    f.positives.set('g-exact-brand', [])
    f.heldOutside = new Set(['test coat'])
    const r = findDrift(f)
    expect(r.items.filter((i) => i.kind === 'positive_missing')).toEqual([
      expect.objectContaining({ slot: 'exact-brand', term: 'testtok jacket', match: 'EXACT', startBidCents: 48, fix: { by: 'sync', part: 'positives', addsSpend: true } }),
    ])
    expect(r.heldBack).toContainEqual({ slot: 'broad-category', what: 'test coat', why: expect.stringMatching(/Owner rule 2/) })
  })

  it('a keyword a person archived is not added again; keep takes it out of the product\'s terms', () => {
    const f = facts()
    f.positives.set('g-exact-brand', [])
    f.archived = { ...f.archived, positives: new Map([['g-exact-brand', [{ id: 't-arch', text: 'testtok jacket', match: 'EXACT' }]]]) }
    f.personal = new Map([['t-arch', [{ userId: 'user:u-owner', at: '2026-10-03T00:00:00.000Z', action: 'AD_ENTITY_STATE_UPDATE', changed: ['status'] }]]])
    const item = one(f, 'positive_archived')!
    expect(item).toMatchObject({ fix: { by: 'none' }, byPerson: { userId: 'user:u-owner' } })
    expect(item.keep).toMatchObject({ tool: 'set-ads-playbook', args: { values: { terms: { brand: [] } } } })
    expect(kinds(f)).not.toContain('positive_missing')
  })

  it('a brand keyword in the category slot is added in its right slot (the misplaced one stays); a winner is never moved', () => {
    const f = facts()
    f.positives.set('g-exact-category', [pos('g-exact-category', 'test jacket', 'EXACT'), pos('g-exact-category', 'testtok coat', 'EXACT')])
    const moved = one(f, 'positive_misplaced')!
    expect(moved).toMatchObject({ slot: 'exact-category', term: 'testtok coat', into: { slot: 'exact-brand', adGroupId: 'g-exact-brand' }, startBidCents: 48, fix: { by: 'sync', part: 'positives' } })
    f.winners = new Map([['g-exact-category', new Set(['testtok coat'])]])
    expect(one(f, 'positive_misplaced')).toMatchObject({ fix: { by: 'none', note: expect.stringMatching(/Owner rule 2/) } })
  })
})

describe('negatives', () => {
  const iso = (over: Partial<PlannedNegative> = {}): PlannedNegative => ({
    kind: 'exactIntoResearch', text: 'test jacket', match: 'EXACT', adGroupId: 'g-auto', campaignId: 'c-auto', slot: 'auto',
    owner: { adTargetId: 't-owner', adGroupId: 'g-exact-category', slot: 'exact-category', text: 'test jacket' }, why: 'Kept apart.', ...over,
  })

  it('isolation, source and the product\'s own: each added by sync, lowering spend', () => {
    const f = facts({ isolation: { adds: [iso()] }, source: [iso({ text: 'test coat', adGroupId: 'g-broad-category', campaignId: 'c-broad-category', slot: 'broad-category' })] })
    f.standing = new Set([...f.standing].filter((k) => k !== 'g-exact-brand|PHRASE|test kids'))
    const neg = findDrift(f).items.filter((i) => i.kind === 'negative_missing')
    expect(neg.map((i) => [i.negative!.of, i.slot, i.term])).toEqual([['isolation', 'auto', 'test jacket'], ['source', 'broad-category', 'test coat'], ['product', 'exact-brand', 'test kids']])
    expect(neg.every((i) => i.fix.by === 'sync' && i.fix.part === 'negatives' && !i.fix.addsSpend)).toBe(true)
    expect(neg[0].negative).toMatchObject({ ownerTargetId: 't-owner', owner: 'test jacket' })
  })

  it('the lock, a protected term and a winner hold a product negative back', () => {
    const f = facts()
    f.terms = { ...f.terms, negatives: [{ text: 'test jacket', match: 'EXACT' }, { text: 'test vest', match: 'EXACT' }, { text: 'test glove', match: 'PHRASE' }] }
    f.standing = new Set()
    f.protections = new Map([['c-auto', [{ term: 'test vest', matchType: 'EXACT', source: 'test' } as never]]])
    f.winners = new Map([['g-auto', new Set(['test glove sale'])]])
    const r = findDrift(f)
    const whys = r.heldBack.filter((h) => h.slot === 'auto' || h.slot === 'exact-category').map((h) => `${h.slot}:${h.what}:${h.why.slice(0, 30)}`)
    expect(whys).toContainEqual(expect.stringMatching(/^exact-category:test jacket:It would block this slot's own/))
    expect(r.heldBack.find((h) => h.slot === 'auto' && h.what === 'test glove')?.why).toMatch(/wins here/)
    expect(r.items.some((i) => i.kind === 'negative_missing' && i.slot === 'exact-category' && i.term === 'test jacket')).toBe(false)
  })

  it("a negative a person lifted is his: keep (out of the product's negatives) or revert (sync), never silent", () => {
    const f = facts()
    f.standing = new Set([...f.standing].filter((k) => k !== 'g-auto|PHRASE|test kids'))
    f.archived = { ...f.archived, negatives: new Map([['g-auto|PHRASE|test kids', 'n-arch']]) }
    f.personal = new Map([['n-arch', [{ userId: 'user:u-owner', at: '2026-10-04T00:00:00.000Z', action: 'retire_negative' }]]])
    const item = one(f, 'negative_missing')!
    expect(item).toMatchObject({ slot: 'auto', byPerson: { userId: 'user:u-owner', action: 'retire_negative' }, revert: { by: 'sync', part: 'negatives' } })
    expect(item.keep).toMatchObject({ tool: 'set-ads-playbook', args: { values: { terms: { negatives: [] } } } })
  })

  it('lifted with no record of who (at Amazon, or a Nexus-only one deleted) is a person\'s change of unknown author', () => {
    const f = facts()
    f.standing = new Set([...f.standing].filter((k) => k !== 'g-auto|PHRASE|test kids' && k !== 'g-broad-category|PHRASE|test kids'))
    f.archived = { ...f.archived, negatives: new Map([['g-auto|PHRASE|test kids', 'n-arch']]) }
    const r = findDrift(f)
    const auto = r.items.find((i) => i.kind === 'negative_missing' && i.slot === 'auto')!
    expect(auto).toMatchObject({ byPerson: { unknownAuthor: true }, revert: { by: 'sync' }, keep: { tool: 'set-ads-playbook' }, says: expect.stringMatching(/by whom Nexus cannot tell/) })
    expect(r.items.find((i) => i.kind === 'negative_missing' && i.slot === 'broad-category')!.byPerson).toBeUndefined()
    f.liftedElsewhere = new Map([['PHRASE|test kids', null]])
    expect(findDrift(f).items.filter((i) => i.kind === 'negative_missing').every((i) => i.byPerson?.unknownAuthor)).toBe(true)
  })

  it('a home at the 2-cent floor (added by a sync, waiting for START) sends no search anywhere: nothing is negated', () => {
    const owner = (atFloor: boolean) => [{ adTargetId: 't-own', adGroupId: 'g-x', text: 'test jacket', match: 'EXACT' as const, live: true, ...(atFloor ? { atFloor: true } : {}) }]
    const scope = [
      { adGroupId: 'g-x', campaignId: 'c-x', slot: 'exact-category', role: 'exact' as const, match: 'EXACT' as const, intent: 'CATEGORY' as const },
      { adGroupId: 'g-r', campaignId: 'c-r', slot: 'broad-category', role: 'research' as const, match: 'BROAD' as const, intent: 'CATEGORY' as const },
    ]
    const plan = (atFloor: boolean) => planIsolation({ action: { exactIntoResearch: true, phraseIntoBroadAndAuto: false, brandPhrase: null, handover: 'proven' }, scope, positives: new Map([['g-x', owner(atFloor)]]), winners: new Map(), standing: new Set(), protections: new Map() })
    expect(plan(false).adds.map((a) => [a.adGroupId, a.text])).toEqual([['g-r', 'test jacket']])
    expect(plan(true).adds).toEqual([])
  })

  it('rule 3: an ad group outside the product\'s own scope gets nothing — no keyword, no ad, no negative', () => {
    const f = facts()
    f.scope = new Set([...f.scope].filter((g) => g !== 'g-auto'))
    f.standing = new Set()
    f.productAds.set('g-auto', new Set())
    const r = findDrift(f)
    expect(r.items.filter((i) => i.slot === 'auto')).toEqual([])
    expect(r.items.filter((i) => i.kind === 'negative_missing').map((i) => i.slot)).toEqual(['broad-category', 'exact-category', 'exact-brand'])
  })
})

describe('outside the playbook, and the compiled artifacts', () => {
  it('a campaign outside every slot is listed, never adopted by itself', () => {
    const f = facts({ outside: [{ campaignId: 'c-old', name: 'Old', status: 'ENABLED', inPlaybook: false }, { campaignId: 'c-theirs', name: 'Theirs', status: 'ENABLED', inPlaybook: true }] })
    const out = findDrift(f).items.filter((i) => i.kind === 'outside_campaign')
    expect(out.map((i) => i.fix.by)).toEqual(['tool', 'none'])
    expect(out[0].fix).toMatchObject({ tool: 'apply-ads-playbook', args: { op: 'adopt' } })
  })

  it('missing and changed artifacts are re-saved; hours a re-save keeps are fix none with keep into overrides.rank', () => {
    const f = facts({
      artifacts: {
        expectations: [
          { kind: 'harvestRule', key: 'harvest', refId: null, parts: { action: { expected: { a: 1 }, actual: null } } },
          { kind: 'isolationRule', key: 'isolation', refId: 'r-iso', parts: { action: { expected: { a: 1, b: 2 }, actual: { b: 2, a: 1 } }, name: { expected: 'x', actual: 'y' } } },
          {
            kind: 'rankGroup', key: 'rank:research', refId: 'g-rank',
            parts: { members: { expected: ['c-auto'], actual: ['c-auto'] }, windows: { expected: [], actual: [{ days: [1], startHour: 1, endHour: 2, targetKey: 'test-x' }], resave: false, note: 'Hours are kept.' } },
            changedBy: { userId: 'user:u-owner', at: '2026-10-05T00:00:00.000Z', action: 'save_rank_schedule_group' },
          },
        ],
        notChecked: [],
        held: [{ kind: 'rankGroup', campaignId: 'c-exact-category', name: 'TESTTOK | IT | Exact | Category', by: 'the hourly plan "Owner plan"' }],
      },
    })
    const r = findDrift(f)
    expect(r.items.find((i) => i.kind === 'artifact_missing')).toMatchObject({ artifact: { kind: 'harvestRule' }, fix: { by: 'sync', part: 'artifacts', addsSpend: false } })
    expect(r.items.find((i) => i.artifact?.kind === 'isolationRule')).toMatchObject({ kind: 'artifact_changed', artifact: { parts: ['name'] }, fix: { by: 'sync' } })
    const rank = r.items.find((i) => i.artifact?.kind === 'rankGroup')!
    expect(rank).toMatchObject({ kind: 'artifact_changed', artifact: { parts: ['windows'] }, fix: { by: 'none', note: 'Hours are kept.' }, byPerson: { userId: 'user:u-owner' } })
    expect(rank.keep).toMatchObject({ tool: 'set-ads-playbook', args: { values: { overrides: { rank: { roles: { research: { windows: [{ targetKey: 'test-x' }] } } } } } } })
    expect(rank.revert).toBeUndefined()
    expect(r.heldBack).toContainEqual({ slot: 'exact-category', what: 'TESTTOK | IT | Exact | Category', why: expect.stringMatching(/^Held by the Owner's plan/) })
    expect(r.items.some((i) => i.campaignId === 'c-exact-category')).toBe(false)
  })
})
