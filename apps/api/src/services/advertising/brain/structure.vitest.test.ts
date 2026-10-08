/**
 * ONE BRAIN AB-16 — the structure lever's decisions, pure (brain/structure.ts):
 *
 *   SKC        the three reasons (15 % of the product's orders with 3 of its own, an hour curve of its own, the playbook's
 *              winners view) and their bars; a term without an exact home is the harvest's; an ASIN, a term in a campaign
 *              of its own already, a term a sibling leads are never built around; the builder (the playbook's hero, the
 *              Single Campaign builder) and its request; a winner of a playbook product is held (rule 2)
 *   caps       new campaigns per product per week, per market per week, single-keyword campaigns per product — what a
 *              held decision does not take, a shadow one does
 *   levels     OFF / excluded → nothing; LOCKED → recommendations only; OBSERVE → shadow; PROPOSE → asks only under the live
 *              ceiling; the kill switch → shadow
 *   split      one replicate per product: own SKUs, the terms its own campaigns buy left out, the rest accepted, its budget
 *              share held to the first-budget cap, the migration plan; every reason it is held
 *   portfolio  the target (the playbook's, else the one holding the product alone), the moves, the Owner's lock and choices
 *   records    a standing key is never decided again; an ended one waits its cooldown
 *   hours      the curve distance: none for the same curve, large for an opposite one with data, shrunk for a thin one
 *   go-live    D1 = B inside the caps; every reason it is outside
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import {
  COOLDOWN_DAYS, decideStructure, firstBudgetCap, goLiveVerdict, hourCurveDistance, MARKET_NEW_CAMPAIGNS_PER_WEEK, portfolioKey, skcCampaignName, skcKey, skcReasons,
  splitKey, templateOwners, type GoLiveFacts, type SharedCampaignFact, type SkcTermFact, type StructureProductFacts,
} from './structure.js'
import type { HourCell } from './hours-research.js'

const NOW = new Date('2026-10-12T05:40:00Z')
const DAY = 86_400_000

const term = (t: string, extra: Partial<SkcTermFact> = {}): SkcTermFact => ({
  term: t, isAsin: false, orders: 0, clicks: 100, spendCents: 1000, salesCents: 0,
  home: { campaignId: 'c-exact', campaignName: 'Jacket exact', adGroupId: 'g-exact', targetId: `t-${t}`, bidCents: 60, campaignPositives: 12 },
  ownCampaign: null, ledBy: null, hours: { measured: false, why: 'thin' }, winner: null, ...extra,
})

const facts = (extra: Partial<StructureProductFacts> = {}): StructureProductFacts => ({
  productId: 'jacket', market: 'IT', label: 'Jacket', level: 'PROPOSE', levelWhy: 'PROPOSE by the Owner\'s product override',
  ceiling: { live: true, why: 'live' }, killed: null,
  settings: { newCampaignsPerWeek: 2, skcMax: 20, skcOrderSharePct: 15, skcHourCurvePct: 30, ownPortfolio: true },
  windowDays: 30, productOrders: 20, terms: [], shared: [], own: [], portfolios: [], playbook: null,
  newCampaign: { skus: ['JACKET-M', 'JACKET-L'], dailyBudgetCents: 500, budgetWhy: '10 % of the day\'s share', takenNames: new Set() },
  newCampaignRefusal: null, portfolioLock: null,
  used: { campaignsThisWeek: 0, marketCampaignsThisWeek: 0, skcs: 0 },
  records: new Map(),
  ...extra,
})

const shared = (extra: Partial<SharedCampaignFact> = {}): SharedCampaignFact => ({
  campaignId: 'c-shared', name: 'Close match shared', status: 'ENABLED', dailyBudgetCents: 3000,
  products: [
    { productId: 'jacket', label: 'Jacket', skus: ['JACKET-M'], enrolled: true, structure: 'PROPOSE', structureWhy: 'PROPOSE', spendShare: 0.6, firstBudgetCapCents: 1000, ownBought: ['racing jacket'] },
    { productId: 'glove', label: 'Glove', skus: ['GLOVE-L'], enrolled: false, structure: 'NOT_ENROLLED', structureWhy: 'not enrolled', spendShare: 0.4, firstBudgetCapCents: null, ownBought: [] },
  ],
  unresolved: [], excluded: null, keywords: ['racing jacket', 'winter gloves', 'touring jacket'],
  counts: { keywords: 3, productTargets: 1, autoGroups: 0, negatives: 2 },
  ...extra,
})

const skcOf = (f: StructureProductFacts) => decideStructure(f, NOW).filter((d) => d.kind === 'SKC')

describe('AB-16 — single-keyword campaigns: the reasons and their bars', () => {
  it('orders: at least 15 % of the product\'s ad orders AND 3 of its own; the Owner\'s own share wins', () => {
    const f = facts({ productOrders: 20 })
    expect(skcReasons(term('racing jacket', { orders: 3 }), f).reasons).toEqual(['orders'])      // 15 %
    expect(skcReasons(term('racing jacket', { orders: 2 }), f).reasons).toEqual([])              // 10 %
    expect(skcReasons(term('rare', { orders: 2 }), facts({ productOrders: 4 })).reasons).toEqual([]) // 50 %, but 2 orders
    expect(skcReasons(term('racing jacket', { orders: 3 }), facts({ settings: { ...f.settings, skcOrderSharePct: 20 } })).reasons).toEqual([])
    expect(skcReasons(term('racing jacket', { orders: 3 }), f).words[0]).toMatch(/15 % of the product's ad orders \(3 orders of 20/)
  })

  it('hours: an hour curve of its own at the bar (30 points by default); unmeasured never counts', () => {
    const f = facts()
    expect(skcReasons(term('night term', { hours: { measured: true, distancePct: 30, part: 0, termOrders: 12, restOrders: 40, days: 28 } }), f).reasons).toEqual(['hours'])
    expect(skcReasons(term('night term', { hours: { measured: true, distancePct: 29.9, part: 0, termOrders: 12, restOrders: 40, days: 28 } }), f).reasons).toEqual([])
    expect(skcReasons(term('night term', { hours: { measured: false, why: 'no keyword grain' } }), f).reasons).toEqual([])
  })

  it('winner: the playbook\'s winners view names a campaign of its own as its next step', () => {
    expect(skcReasons(term('declining term', { winner: { state: 'declining', nextStep: 'ownCampaign', why: 'x' } }), facts()).reasons).toEqual(['winner'])
    expect(skcReasons(term('declining term', { winner: { state: 'declining', nextStep: 'placement', why: 'x' } }), facts()).reasons).toEqual([])
  })

  it('never built around: an ASIN, a term in a campaign of its own already, a term without an exact home (the harvest\'s)', () => {
    const f = facts({
      terms: [
        term('b0abcdefgh', { isAsin: true, orders: 9 }),
        term('alone term', { orders: 9, ownCampaign: 'Jacket | IT | SKC | alone term' }),
        term('homeless term', { orders: 9, home: null }),
      ],
    })
    expect(skcOf(f)).toEqual([])
  })

  it('a term a sibling product leads is held, named', () => {
    const [d] = skcOf(facts({ terms: [term('racing jacket', { orders: 6, ledBy: 'Glove' })] }))
    expect(d).toMatchObject({ act: 'none', heldBy: expect.stringMatching(/sibling product Glove/) })
  })
})

describe('AB-16 — single-keyword campaigns: the builder and its request', () => {
  it('no playbook: create-ad-campaign — one exact keyword at the bid it holds now, the product\'s SKUs, its first budget, down only', () => {
    const [d] = skcOf(facts({ terms: [term('racing jacket', { orders: 6 })] }))
    expect(d).toMatchObject({ kind: 'SKC', key: skcKey('jacket', 'racing jacket'), act: 'propose', level: 'PROPOSE', builder: 'create-ad-campaign', reasons: ['orders'] })
    expect(d.request).toEqual({
      tool: 'create-ad-campaign',
      args: {
        market: 'IT', name: 'Jacket | IT | SKC | racing jacket', skus: ['JACKET-M', 'JACKET-L'], dailyBudgetCents: 500, defaultBidCents: 60,
        keywords: [{ text: 'racing jacket', matchType: 'EXACT', bidCents: 60 }], biddingStrategy: 'down', why: expect.stringMatching(/^a campaign of its own for "racing jacket"/),
      },
    })
    // The template declares who owns each lever; the term keeps running where it runs.
    expect(Object.keys(d.owners!)).toEqual(expect.arrayContaining(['bids', 'budgets', 'state', 'negatives', 'portfolio', 'biddingStrategy', 'placementsAndHours', 'harvest', 'term']))
    expect(d.owners!.term).toMatch(/keeps running where it runs now/)
    expect(d.evidence).toMatchObject({ orders: 6, productOrders: 20, sharePct: 30, money: { dailyBudgetCents: 500, plannedBidCents: 60 } })
    expect(d.why).not.toMatch(/€|\d+\.\d\d/)
  })

  it('a playbook product: the playbook\'s hero (apply-ads-playbook op hero); a winner where it runs is held (PB-6c, rule 2)', () => {
    const playbook = { id: 'pb-1', enrolled: true, portfolioId: null }
    const [hero] = skcOf(facts({ playbook, terms: [term('declining term', { orders: 6, winner: { state: 'declining', nextStep: 'ownCampaign', why: 'x' } })] }))
    expect(hero).toMatchObject({ builder: 'apply-ads-playbook', reasons: ['orders', 'winner'], request: { tool: 'apply-ads-playbook', args: { op: 'hero', market: 'IT', productId: 'jacket', term: 'declining term' } } })
    const [winner] = skcOf(facts({ playbook, terms: [term('racing jacket', { orders: 6, winner: { state: 'winning', nextStep: 'none', why: 'x' } })] }))
    expect(winner).toMatchObject({ act: 'none', heldBy: expect.stringMatching(/wins where it runs: the playbook keeps a winner where it wins \(PB-6c, the Owner's rule 2\)/) })
  })

  it('cannot be built: no SKU, no bid to plan from — held with why', () => {
    expect(skcOf(facts({ newCampaign: null, newCampaignRefusal: 'its own campaigns advertise no SKU Nexus knows', terms: [term('racing jacket', { orders: 6 })] }))[0])
      .toMatchObject({ act: 'none', heldBy: expect.stringMatching(/no SKU Nexus knows/) })
    expect(skcOf(facts({ terms: [term('racing jacket', { orders: 6, home: { ...term('x').home!, bidCents: null } })] }))[0])
      .toMatchObject({ act: 'none', heldBy: expect.stringMatching(/no bid to plan from/) })
  })

  it('the name is new in the market', () => {
    expect(skcCampaignName('Jacket', 'IT', 'racing jacket', new Set(['jacket | it | skc | racing jacket']))).toBe('Jacket | IT | SKC | racing jacket (2)')
    expect(skcCampaignName('x'.repeat(200), 'IT', 't', new Set()).length).toBe(128)
  })
})

describe('AB-16 — caps (§2.9 / §5, shared with the harvest)', () => {
  const many = [term('a term', { orders: 9 }), term('b term', { orders: 8 }), term('c term', { orders: 7 })]

  it('at most 2 new campaigns per product per week: the third is held for a later week, winners and most orders first', () => {
    const out = skcOf(facts({ productOrders: 30, terms: many }))
    expect(out.map((d) => [d.term, d.act])).toEqual([['a term', 'propose'], ['b term', 'propose'], ['c term', 'none']])
    expect(out[2].heldBy).toMatch(/past this week's cap of 2 new campaigns for this product/)
  })

  it('this week\'s harvest and structure campaigns count; the market\'s cap of 6; the cap of 20 single-keyword campaigns', () => {
    expect(skcOf(facts({ productOrders: 30, terms: many, used: { campaignsThisWeek: 2, marketCampaignsThisWeek: 0, skcs: 0 } })).every((d) => d.act === 'none')).toBe(true)
    expect(skcOf(facts({ productOrders: 30, terms: many, used: { campaignsThisWeek: 0, marketCampaignsThisWeek: MARKET_NEW_CAMPAIGNS_PER_WEEK, skcs: 0 } }))[0].heldBy).toMatch(/6 new campaigns in IT/)
    expect(skcOf(facts({ productOrders: 30, terms: many, used: { campaignsThisWeek: 0, marketCampaignsThisWeek: 0, skcs: 20 } }))[0].heldBy).toMatch(/20 single-keyword campaigns/)
  })

  it('a held decision takes no slot; a shadow one does (the shadow is what the brain would do)', () => {
    const led = term('a term', { orders: 9, ledBy: 'Glove' })
    const out = skcOf(facts({ productOrders: 30, terms: [led, term('b term', { orders: 8 }), term('c term', { orders: 7 })] }))
    expect(out.map((d) => d.act)).toEqual(['none', 'propose', 'propose'])
    const shadow = skcOf(facts({ level: 'OBSERVE', productOrders: 30, terms: many }))
    expect(shadow.map((d) => d.act)).toEqual(['log', 'log', 'none'])
  })
})

describe('AB-16 — levels: AUTO never creates without a person', () => {
  const one = [term('racing jacket', { orders: 6 })]
  it('OFF, excluded, not enrolled: nothing decided', () => {
    for (const level of ['OFF', 'EXCLUDED', 'NOT_ENROLLED'] as const) expect(decideStructure(facts({ level, terms: one }), NOW)).toEqual([])
  })
  it('LOCKED: every proposal a recommendation only, nothing asked', () => {
    const [d] = skcOf(facts({ level: 'LOCKED', levelWhy: 'locked at the Owner\'s own value', terms: one }))
    expect(d).toMatchObject({ act: 'none', level: null, heldBy: expect.stringMatching(/recommendation only/) })
  })
  it('OBSERVE: shadow; PROPOSE under a shadow ceiling: shadow with why; PROPOSE live: asks; the kill switch: shadow', () => {
    expect(skcOf(facts({ level: 'OBSERVE', terms: one }))[0]).toMatchObject({ act: 'log', level: 'OBSERVE', heldBy: null })
    expect(skcOf(facts({ ceiling: { live: false, why: 'the structure\'s env ceiling NEXUS_ADS_BRAIN_STRUCTURE_MODE is shadow' }, terms: one }))[0])
      .toMatchObject({ act: 'log', level: 'PROPOSE', heldBy: expect.stringMatching(/NEXUS_ADS_BRAIN_STRUCTURE_MODE is shadow: it would ask a person/) })
    expect(skcOf(facts({ terms: one }))[0]).toMatchObject({ act: 'propose' })
    expect(skcOf(facts({ killed: 'stopped by the Owner', terms: one }))[0]).toMatchObject({ act: 'log', heldBy: expect.stringMatching(/stopped by the Owner/) })
  })
})

describe('AB-16 — the split of a shared campaign (D2 = A)', () => {
  it('one replicate per product: its own SKUs, the terms its own campaigns buy left out, the rest accepted, the migration plan', () => {
    const [d] = decideStructure(facts({ shared: [shared()] }), NOW)
    expect(d).toMatchObject({ kind: 'SPLIT', key: splitKey('c-shared'), campaignId: 'c-shared', act: 'propose', builder: 'replicate-ad-structure' })
    if (!d.request || !('plan' in d.request)) throw new Error('a change plan')
    expect(d.request.plan.steps.map((s) => [s.tool, s.args.skus, s.args.skipTerms ?? null, s.args.acceptTerms])).toEqual([
      ['replicate-ad-structure', ['GLOVE-L'], null, ['racing jacket', 'winter gloves', 'touring jacket']],
      ['replicate-ad-structure', ['JACKET-M'], ['racing jacket'], ['winter gloves', 'touring jacket']],
    ])
    const glove = d.request.plan.steps[0].args
    expect(glove).toMatchObject({ sourceMarket: 'IT', market: 'IT', campaignIds: ['c-shared'], sourceProductToken: 'Glove', productToken: 'Glove', naming: { suffix: ' | Glove' }, bidPolicy: { mode: 'copy' } })
    // Budgets: each product's share of the spend; an enrolled product's copy held to its first-budget cap.
    expect(d.request.plan.steps.map((s) => (s.args.budgetPolicy as { value: number }).value)).toEqual([1200, 1000])
    expect(d.migration!.join(' ')).toMatch(/History: Amazon cannot move a campaign's history/)
    expect(d.migration!.join(' ')).toMatch(/goes to low bids \(suppress-campaign/)
    expect(d.migration!.join(' ')).toMatch(/never paused or archived by the split/)
    expect(d.owners!.term).toMatch(/one owner per term/)
  })

  it('held: an ad Nexus cannot tie, the Owner\'s exclusion, an enrolled product\'s lever kept, a product with no SKU, too many keywords, the market\'s cap', () => {
    const held = (c: Partial<SharedCampaignFact>, f: Partial<StructureProductFacts> = {}) => decideStructure(facts({ shared: [shared(c)], ...f }), NOW)[0]
    expect(held({ unresolved: ['B0UNKNOWN1'] }).heldBy).toMatch(/cannot tie to a product \(B0UNKNOWN1\)/)
    expect(held({ excluded: 'by user:owner' }).heldBy).toMatch(/excluded "Close match shared"/)
    expect(held({ products: [{ ...shared().products[0] }, { ...shared().products[1], enrolled: true, structure: 'OFF', structureWhy: 'OFF by the Owner' }] }).heldBy).toMatch(/structure lever of Glove is OFF/)
    expect(held({ products: [{ ...shared().products[0] }, { ...shared().products[1], skus: [] }] }).heldBy).toMatch(/Glove has no SKU/)
    expect(held({ keywords: Array.from({ length: 251 }, (_, i) => `k${i}`) }).heldBy).toMatch(/more than one copy request carries \(250\)/)
    expect(held({}, { used: { campaignsThisWeek: 0, marketCampaignsThisWeek: 5, skcs: 0 } }).heldBy).toMatch(/2 copies would pass this week's cap of 6/)
  })

  it('a paused shared campaign is left; another enrolled product in shadow keeps the split in shadow; no report: an equal share', () => {
    expect(decideStructure(facts({ shared: [shared({ status: 'PAUSED' })] }), NOW)).toEqual([])
    const [obs] = decideStructure(facts({ shared: [shared({ products: [shared().products[0], { ...shared().products[1], enrolled: true, structure: 'OBSERVE', structureWhy: 'OBSERVE' }] })] }), NOW)
    expect(obs).toMatchObject({ act: 'log', level: 'OBSERVE', heldBy: expect.stringMatching(/in shadow/) })
    const [eq] = decideStructure(facts({ shared: [shared({ products: shared().products.map((p) => ({ ...p, spendShare: null, firstBudgetCapCents: null })) })] }), NOW)
    if (!eq.request || !('plan' in eq.request)) throw new Error('a change plan')
    expect(eq.request.plan.steps.map((s) => (s.args.budgetPolicy as { value: number }).value)).toEqual([1500, 1500])
  })
})

describe('AB-16 — the move into the product\'s one portfolio (N2)', () => {
  const own = [
    { campaignId: 'c1', name: 'Jacket auto', portfolioId: 'pf-mixed', left: null },
    { campaignId: 'c2', name: 'Jacket exact', portfolioId: 'pf-own', left: null },
    { campaignId: 'c3', name: 'Jacket broad', portfolioId: null, left: null },
    { campaignId: 'c4', name: 'Jacket mine', portfolioId: null, left: 'the Owner excluded it from the brain' },
  ]
  const portfolios = [{ portfolioId: 'pf-mixed', name: 'Mixed', own: ['c1'], others: 3 }, { portfolioId: 'pf-own', name: 'Jacket IT', own: ['c2'], others: 0 }]

  it('moves the own campaigns outside the portfolio that holds the product alone; the Owner\'s excluded campaign is left', () => {
    const d = decideStructure(facts({ own, portfolios }), NOW).find((x) => x.kind === 'PORTFOLIO')!
    expect(d).toMatchObject({ key: portfolioKey('jacket'), builder: 'set-campaign-settings', act: 'propose', request: { tool: 'set-campaign-settings', args: { campaigns: [{ campaignId: 'c1', portfolioId: 'pf-own' }, { campaignId: 'c3', portfolioId: 'pf-own' }] } } })
    expect(d.evidence.left).toEqual([{ campaignId: 'c4', name: 'Jacket mine', why: 'the Owner excluded it from the brain' }])
  })

  it('the playbook\'s portfolio first when it holds the product alone; none: held, named; the Owner\'s lock and ownPortfolio off', () => {
    const viaPlaybook = decideStructure(facts({ own, portfolios: [...portfolios, { portfolioId: 'pf-pb', name: 'Playbook', own: [], others: 0 }], playbook: { id: 'pb', enrolled: true, portfolioId: 'pf-pb' } }), NOW).find((x) => x.kind === 'PORTFOLIO')!
    expect((viaPlaybook.request as { args: { campaigns: Array<{ portfolioId: string }> } }).args.campaigns.map((c) => c.portfolioId)).toEqual(['pf-pb', 'pf-pb', 'pf-pb'])
    expect(decideStructure(facts({ own, portfolios: [portfolios[0]] }), NOW).find((x) => x.kind === 'PORTFOLIO')).toMatchObject({ act: 'none', heldBy: expect.stringMatching(/no portfolio holds this product alone yet/) })
    expect(decideStructure(facts({ own, portfolios, portfolioLock: 'locked by the Owner' }), NOW).find((x) => x.kind === 'PORTFOLIO')).toMatchObject({ act: 'none', heldBy: expect.stringMatching(/locked the portfolioCap lever/) })
    expect(decideStructure(facts({ own, portfolios, settings: { ...facts().settings, ownPortfolio: false } }), NOW).find((x) => x.kind === 'PORTFOLIO')).toBeUndefined()
    expect(decideStructure(facts({ own: [own[1]], portfolios }), NOW).find((x) => x.kind === 'PORTFOLIO')).toBeUndefined()
  })
})

describe('AB-16 — records: a campaign is built once', () => {
  const one = [term('racing jacket', { orders: 6 })]
  it('a standing proposal is never decided again; a declined one waits its cooldown', () => {
    const key = skcKey('jacket', 'racing jacket')
    for (const status of ['PROPOSED', 'BUILT', 'LIVE_PROPOSED', 'LIVE', 'DONE'] as const) expect(skcOf(facts({ terms: one, records: new Map([[key, { status, changedAt: NOW }]]) }))).toEqual([])
    expect(skcOf(facts({ terms: one, records: new Map([[key, { status: 'DECLINED', changedAt: new Date(NOW.getTime() - (COOLDOWN_DAYS - 1) * DAY) }]]) }))).toEqual([])
    expect(skcOf(facts({ terms: one, records: new Map([[key, { status: 'DECLINED', changedAt: new Date(NOW.getTime() - COOLDOWN_DAYS * DAY) }]]) }))).toHaveLength(1)
    // A shadow or held record is decided again (the run only stamps it when nothing changed).
    expect(skcOf(facts({ terms: one, records: new Map([[key, { status: 'SHADOW', changedAt: NOW }]]) }))).toHaveLength(1)
  })
})

describe('AB-16 — the hour-curve distance', () => {
  /** Four weeks of hours: `byPart[p]` clicks and orders in each 4-hour part of every day. */
  const curve = (byPart: Array<[number, number]>): HourCell[] => {
    const out: HourCell[] = []
    for (let d = 0; d < 28; d++) {
      const day = new Date(Date.UTC(2026, 8, 7 + d)).toISOString().slice(0, 10)
      byPart.forEach(([clicks, orders], p) => out.push({ day, hour: p * 4 + 1, impressions: clicks * 10, clicks, spendCents: clicks * 50, orders, salesCents: orders * 8000 }))
    }
    return out
  }
  it('the same curve: no distance; an opposite one with data: far; a thin one: shrunk toward the campaign', () => {
    const flat: Array<[number, number]> = [[10, 1], [10, 1], [10, 1], [10, 1], [10, 1], [10, 1]]
    expect(hourCurveDistance(curve(flat), curve(flat)).distancePct).toBeLessThan(1)
    const night: Array<[number, number]> = [[10, 3], [10, 0], [10, 0], [10, 0], [10, 0], [10, 0]]
    const day: Array<[number, number]> = [[10, 0], [10, 0], [10, 1], [10, 1], [10, 1], [10, 0]]
    const far = hourCurveDistance(curve(night), curve(day))
    expect(far.distancePct).toBeGreaterThan(100)
    expect(far.part).toBe(0)
    const thin = hourCurveDistance(curve(night).slice(0, 6), curve(day))
    expect(thin.distancePct).toBeLessThan(far.distancePct)
  })
})

describe('AB-16 — going live (D1 = B)', () => {
  const g = (extra: Partial<GoLiveFacts> = {}): GoLiveFacts => ({ kind: 'SKC', status: 'BUILT', enrolled: true, structure: 'PROPOSE', structureWhy: 'PROPOSE', budgetCents: 500, budgetCapCents: 500, liveSkcs: 0, skcMax: 20, brake: 'none', killed: null, ceiling: { live: true, why: 'live' }, ...extra })
  it('inside the caps: a normal approval', () => {
    expect(goLiveVerdict(g())).toEqual({ inside: true, why: expect.stringMatching(/a person's normal approval sends it \(D1 = B\)/) })
    expect(goLiveVerdict(g({ status: 'LIVE_PROPOSED' })).inside).toBe(true)
  })
  it('outside: each reason named — the approver\'s code, as before', () => {
    const out = (extra: Partial<GoLiveFacts>) => goLiveVerdict(g(extra))
    expect(out({ enrolled: false })).toMatchObject({ inside: false, why: expect.stringMatching(/not enrolled/) })
    expect(out({ structure: 'OFF', structureWhy: 'OFF by the Owner' }).why).toMatch(/structure lever is OFF/)
    expect(out({ budgetCents: 501 }).why).toMatch(/above the first-budget cap/)
    expect(out({ budgetCents: null }).why).toMatch(/does not know its daily budget/)
    expect(out({ liveSkcs: 20 }).why).toMatch(/skcMax 20/)
    expect(out({ kind: 'SPLIT', liveSkcs: 20 }).inside).toBe(true)
    expect(out({ brake: 'hold_raises' }).why).toMatch(/money brake holds every raise/)
    expect(out({ status: 'LIVE' }).why).toMatch(/not built and waiting to go live/)
    expect(out({ brake: 'cut_bids' }).why).toMatch(/authenticator code/)
    expect(out({ structure: 'OBSERVE', structureWhy: 'back to shadow' }).why).toMatch(/structure lever is OBSERVE, not PROPOSE/)
    expect(out({ killed: 'stopped by the Owner' }).why).toMatch(/kill switch is on \(stopped by the Owner\)/)
    expect(out({ ceiling: { live: false, why: 'the structure\'s env ceiling NEXUS_ADS_BRAIN_STRUCTURE_MODE is shadow' } }).why).toMatch(/NEXUS_ADS_BRAIN_STRUCTURE_MODE is shadow/)
  })
  it('the first-budget cap: the day\'s share of the envelope, at least Amazon\'s lowest', () => {
    expect(firstBudgetCap(300_000, '2026-10', 10)).toMatchObject({ cents: 967 })
    expect(firstBudgetCap(1000, '2026-10', 10)).toMatchObject({ cents: 100, why: expect.stringMatching(/raised to Amazon's lowest/) })
    expect(firstBudgetCap(null, null, 10)).toMatchObject({ cents: 100, why: expect.stringMatching(/planned no envelope/) })
  })
  it('both templates declare an owner for every lever of the new campaign', () => {
    for (const kind of ['SKC', 'SPLIT'] as const) expect(Object.keys(templateOwners(kind)).sort()).toEqual(['biddingStrategy', 'bids', 'budgets', 'harvest', 'negatives', 'placementsAndHours', 'portfolio', 'state', 'term'])
  })
})
