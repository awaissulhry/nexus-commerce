/**
 * AX2.5 — replication planning + the self-competition gate.
 * The gate is the reason this phase exists; most of these tests are about it.
 */
import { describe, it, expect } from 'vitest'
import { extractBlueprint, type SourceCampaign } from './ads-blueprint.js'
import { planApplication, materialise, applyNaming, type ExistingTarget } from './ads-blueprint-apply.js'

const kw = (expressionValue: string, expressionType = 'EXACT', isNegative = false, bidCents: number | null = 30) => ({
  kind: 'KEYWORD', expressionType, expressionValue, bidCents, isNegative, negativeLevel: isNegative ? 'AD_GROUP' : null,
})

const source = (): SourceCampaign[] => [
  {
    name: 'IT-AIREON-SP-Brand-Exact', dailyBudget: 10, biddingStrategy: 'LEGACY_FOR_SALES', placementBidding: [],
    adGroups: [{ name: 'IT-AIREON-SP-Brand-Exact Ad Group', defaultBidCents: 30, asins: ['B0AIREON1'], targets: [kw('aireon'), kw('giacca aireon')] }],
  },
  {
    name: 'IT-AIREON-SP-Category-Exact', dailyBudget: 15, biddingStrategy: 'LEGACY_FOR_SALES', placementBidding: [],
    adGroups: [{ name: 'IT-AIREON-SP-Category-Exact Ad Group', defaultBidCents: 30, asins: ['B0AIREON1'],
      targets: [kw('giacca moto'), kw('abbigliamento moto'), kw('casco moto', 'EXACT', true)] }],
  },
]
const doc = extractBlueprint(source(), { productToken: 'AIREON' })
const gale = { productToken: 'GALE', asins: ['B0GALE0001', 'B0GALE0002'] }

describe('materialise', () => {
  it('substitutes the target product into a pattern', () => {
    expect(materialise('IT-{{product}}-SP-Brand-Exact', 'GALE')).toBe('IT-GALE-SP-Brand-Exact')
    expect(materialise('giacca {{product}}', 'GALE')).toBe('giacca GALE')
  })
  it('leaves a pattern without the token alone', () => {
    expect(materialise('giacca moto', 'GALE')).toBe('giacca moto')
  })
})

describe('planApplication — the plan', () => {
  it('materialises names and brand keywords for the new product', () => {
    const p = planApplication(doc, gale, [])
    expect(p.campaigns.map((c) => c.name)).toEqual(['IT-GALE-SP-Brand-Exact', 'IT-GALE-SP-Category-Exact'])
    const brand = p.campaigns[0]!.adGroups[0]!.targets.map((t) => t.expression)
    expect(brand).toEqual(['GALE', 'giacca GALE'])
    expect(JSON.stringify(p)).not.toContain('AIREON')
  })

  it('attaches the TARGET product ASINs, never the source ones', () => {
    const p = planApplication(doc, gale, [])
    expect(p.campaigns[0]!.adGroups[0]!.asins).toEqual(['B0GALE0001', 'B0GALE0002'])
    expect(JSON.stringify(p)).not.toContain('B0AIREON1')
  })

  it('totals the daily budget the replication commits', () => {
    const p = planApplication(doc, gale, [])
    expect(p.totals.dailyBudgetTotal).toBe(25)
    expect(p.totals.campaigns).toBe(2)
    expect(p.totals.productAds).toBe(4) // 2 ad groups × 2 ASINs
  })

  it('is allowed when nothing collides', () => {
    const p = planApplication(doc, gale, [])
    expect(p.allowed).toBe(true)
    expect(p.conflicts).toEqual([])
  })
})

describe('planApplication — the self-competition gate', () => {
  const existing: ExistingTarget[] = [
    { expression: 'giacca moto', campaignName: 'IT-AIREON-SP-Category-Exact', campaignId: 'c_aireon' },
  ]

  it('BLOCKS when a shared keyword is already run by another campaign', () => {
    const p = planApplication(doc, gale, existing)
    expect(p.allowed).toBe(false)
    expect(p.conflicts).toHaveLength(1)
    expect(p.conflicts[0]!.expression).toBe('giacca moto')
    expect(p.conflicts[0]!.resolution).toBe('UNRESOLVED')
    expect(p.blockers[0]).toMatch(/bid against campaigns you already run/)
    expect(p.blockers[0]).toMatch(/giacca moto/)
  })

  it('names the campaign it would fight, so the operator can judge', () => {
    const p = planApplication(doc, gale, existing)
    expect(p.conflicts[0]!.existing).toEqual([{ campaignName: 'IT-AIREON-SP-Category-Exact', campaignId: 'c_aireon' }])
  })

  it('SKIPPING a shared keyword removes it from the plan and unblocks', () => {
    const p = planApplication(doc, gale, existing, { skipSharedTargets: ['giacca moto'] })
    expect(p.allowed).toBe(true)
    expect(p.conflicts).toEqual([])
    const cat = p.campaigns.find((c) => c.role === 'Category-Exact')!
    expect(cat.adGroups[0]!.targets.map((t) => t.expression)).not.toContain('giacca moto')
    // the non-conflicting sibling survives
    expect(cat.adGroups[0]!.targets.map((t) => t.expression)).toContain('abbigliamento moto')
  })

  it('ACCEPTING keeps the keyword, records the decision, and unblocks', () => {
    const p = planApplication(doc, gale, existing, { acceptSharedTargets: ['giacca moto'] })
    expect(p.allowed).toBe(true)
    expect(p.conflicts[0]!.resolution).toBe('ACCEPTED')
    const cat = p.campaigns.find((c) => c.role === 'Category-Exact')!
    expect(cat.adGroups[0]!.targets.map((t) => t.expression)).toContain('giacca moto')
  })

  it('matching is case- and whitespace-insensitive', () => {
    const p = planApplication(doc, gale, [{ expression: '  GIACCA Moto ', campaignName: 'X', campaignId: 'x' }])
    expect(p.allowed).toBe(false)
    expect(p.conflicts[0]!.expression).toBe('giacca moto')
  })

  it('BRAND keywords never conflict — they parameterise per product', () => {
    // Someone already running "aireon" must not block GALE's own brand campaign.
    const p = planApplication(doc, gale, [{ expression: 'aireon', campaignName: 'IT-AIREON-SP-Brand-Exact', campaignId: 'c_a' }])
    expect(p.allowed).toBe(true)
  })

  it('a shared keyword that is only a NEGATIVE does not conflict', () => {
    // "casco moto" is a negative in the source; excluding the same traffic for
    // two products is harmless and must not be gated.
    const p = planApplication(doc, gale, [{ expression: 'casco moto', campaignName: 'Y', campaignId: 'y' }])
    expect(p.allowed).toBe(true)
    expect(p.conflicts).toEqual([])
  })
})

describe('planApplication — market awareness (AX2.7)', () => {
  const writable = { marketplace: 'IT', writable: true, everWritten: true }

  it('REFUSES a market with no writable production connection', () => {
    // UK/PL/SE/NL/IE are sandbox connections with no writesEnabledAt. Without
    // this the run creates the whole structure locally with null Amazon ids and
    // only reports PARTIAL afterwards — 11 orphaned campaigns.
    const p = planApplication(doc, gale, [], { market: { marketplace: 'UK', writable: false, everWritten: false } })
    expect(p.allowed).toBe(false)
    expect(p.blockers.some((b) => b.includes('UK') && b.includes('never reach Amazon'))).toBe(true)
  })

  it('WARNS, but allows, a writable market that has never been written to', () => {
    // FR and ES are production + writesEnabled but have zero AD_* queue rows:
    // a replication there would be the first write ever to reach that account.
    const p = planApplication(doc, gale, [], { market: { marketplace: 'FR', writable: true, everWritten: false } })
    expect(p.allowed).toBe(true)
    expect(p.warnings.some((w) => w.includes('FR') && w.includes('first'))).toBe(true)
  })

  it('a proven market produces neither blocker nor warning', () => {
    const p = planApplication(doc, gale, [], { market: writable })
    expect(p.allowed).toBe(true)
    expect(p.warnings).toEqual([])
  })

  it('omitting market context does not invent a blocker', () => {
    expect(planApplication(doc, gale, []).allowed).toBe(true)
  })
})

describe('planApplication — other blockers', () => {
  it('refuses when the replication exceeds the daily budget cap', () => {
    const p = planApplication(doc, gale, [], { dailyBudgetCapEur: 20 })
    expect(p.allowed).toBe(false)
    expect(p.blockers.some((b) => b.includes('€25.00/day') && b.includes('€20.00 cap'))).toBe(true)
  })
  it('allows exactly at the cap', () => {
    expect(planApplication(doc, gale, [], { dailyBudgetCapEur: 25 }).allowed).toBe(true)
  })
  it('refuses with no ASINs — campaigns with nothing to advertise', () => {
    const p = planApplication(doc, { productToken: 'GALE', asins: [] }, [])
    expect(p.allowed).toBe(false)
    expect(p.blockers.some((b) => b.includes('no ASINs'))).toBe(true)
  })
  it('refuses with a blank productToken', () => {
    const p = planApplication(doc, { productToken: '  ', asins: ['B0X'] }, [])
    expect(p.allowed).toBe(false)
    expect(p.blockers.some((b) => b.includes('productToken is required'))).toBe(true)
  })
  it('reports every blocker at once rather than one at a time', () => {
    const p = planApplication(doc, { productToken: 'GALE', asins: [] }, [
      { expression: 'giacca moto', campaignName: 'A', campaignId: 'a' },
    ], { dailyBudgetCapEur: 1 })
    expect(p.blockers.length).toBe(3)
  })
})

// ── AX3.0 — name collisions ───────────────────────────────────────────────
describe('planApplication — the name-collision gate', () => {
  // Most of this account does NOT put the product token in the campaign name:
  // IT_Auto_Close, BMM_Misano, Auto_Loose_Moss. materialise() only rewrites a
  // name containing the token, so those replicate to a byte-identical name.
  const untokenised = (): SourceCampaign[] => [{
    name: 'IT_Auto_Close', dailyBudget: 5, biddingStrategy: null, placementBidding: [],
    adGroups: [{ name: 'IT_Auto_Close Ad Group', defaultBidCents: 30, asins: ['B0MOSS0001'], targets: [kw('giacca moto')] }],
  }]

  it('BLOCKS a plan whose name already exists live in the destination market', () => {
    const d = extractBlueprint(untokenised(), { productToken: 'MOSS' })
    const p = planApplication(d, gale, [], { existingCampaignNames: ['IT_Auto_Close', 'IT-AIREON-SP-Auto'] })
    expect(p.campaigns[0]!.name).toBe('IT_Auto_Close') // the token was never in the name
    expect(p.allowed).toBe(false)
    expect(p.blockers.some((b) => b.includes('already exist') && b.includes('IT_Auto_Close'))).toBe(true)
  })

  it('matches names case- and whitespace-insensitively', () => {
    const d = extractBlueprint(untokenised(), { productToken: 'MOSS' })
    expect(planApplication(d, gale, [], { existingCampaignNames: ['  it_AUTO_close '] }).allowed).toBe(false)
  })

  it('allows when the name carries the token and therefore actually changes', () => {
    const p = planApplication(doc, gale, [], { existingCampaignNames: ['IT-AIREON-SP-Brand-Exact', 'IT-AIREON-SP-Category-Exact'] })
    expect(p.campaigns.map((c) => c.name)).toEqual(['IT-GALE-SP-Brand-Exact', 'IT-GALE-SP-Category-Exact'])
    expect(p.allowed).toBe(true)
  })

  it('BLOCKS a plan that would collide with ITSELF', () => {
    // Two source campaigns differing only by the product token collapse onto one
    // name once it is substituted out.
    const twins: SourceCampaign[] = [
      { name: 'GALE-SP-Auto', dailyBudget: 5, biddingStrategy: null, placementBidding: [], adGroups: [{ name: 'a', defaultBidCents: 30, asins: [], targets: [] }] },
      { name: 'gale-SP-Auto', dailyBudget: 5, biddingStrategy: null, placementBidding: [], adGroups: [{ name: 'b', defaultBidCents: 30, asins: [], targets: [] }] },
    ]
    const p = planApplication(extractBlueprint(twins, { productToken: 'GALE' }), gale, [], {})
    expect(p.allowed).toBe(false)
    expect(p.blockers.some((b) => b.includes('duplicate campaign name'))).toBe(true)
  })

  it('does not invent a blocker when no names are supplied', () => {
    expect(planApplication(doc, gale, []).allowed).toBe(true)
  })

  it('an ARCHIVED name is not a collision — the caller excludes them, so this stays a pure check', () => {
    const d = extractBlueprint(untokenised(), { productToken: 'MOSS' })
    expect(planApplication(d, gale, [], { existingCampaignNames: [] }).allowed).toBe(true)
  })
})

// ── AX3.0 — fidelity carried into the plan ────────────────────────────────
describe('planApplication — what the plan now carries into creation', () => {
  const autoSrc = (): SourceCampaign[] => [{
    name: 'IT-AIREON-SP-Auto', dailyBudget: 10, biddingStrategy: 'LEGACY_FOR_SALES',
    placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 75 }], targetingType: 'AUTO',
    adGroups: [{
      name: 'IT-AIREON-SP-Auto Ad Group', defaultBidCents: 2, asins: ['B0AIREON1'],
      targets: [
        { kind: 'AUTO', expressionType: 'SEARCH_CLOSE_MATCH', expressionValue: '', bidCents: 2, isNegative: false, negativeLevel: null },
        { kind: 'AUTO', expressionType: 'SEARCH_RELATED_TO_YOUR_BRAND', expressionValue: '', bidCents: 2, isNegative: false, negativeLevel: null },
        { kind: 'PRODUCT', expressionType: 'ASIN', expressionValue: 'B0RIVAL001', bidCents: 40, isNegative: false, negativeLevel: null },
      ],
    }],
  }]
  const p = () => planApplication(extractBlueprint(autoSrc(), { productToken: 'AIREON' }), gale, [])

  it('carries targetingType so the replica is created AUTO', () => {
    expect(p().campaigns[0]!.targetingType).toBe('AUTO')
  })

  it('carries the placement modifier that used to be captured and thrown away', () => {
    expect(p().campaigns[0]!.placementBidding).toEqual([{ placement: 'PLACEMENT_TOP', percentage: 75 }])
  })

  it('carries the identified auto clause so it can actually be created', () => {
    const targets = p().campaigns[0]!.adGroups[0]!.targets
    expect(targets.find((t) => t.expressionType === 'SEARCH_CLOSE_MATCH')!.autoClause).toBe('CLOSE_MATCH')
  })

  it('WARNS about an auto clause it cannot re-create instead of dropping it silently', () => {
    const plan = p()
    expect(plan.allowed).toBe(true)
    expect(plan.warnings.some((w) => w.includes('auto-targeting clause') && w.includes('not be created'))).toBe(true)
  })

  it('keeps PRODUCT targets in the plan — the PAT campaign used to land empty', () => {
    const targets = p().campaigns[0]!.adGroups[0]!.targets
    expect(targets.some((t) => t.kind === 'PRODUCT' && t.expression === 'B0RIVAL001')).toBe(true)
  })

  it('an auto clause is never counted as a conflict, whoever else runs one', () => {
    // Every Auto campaign in the account has all four clauses; treating them as
    // shared keywords would block every replication that includes an Auto role.
    const plan = planApplication(extractBlueprint(autoSrc(), { productToken: 'AIREON' }), gale, [
      { expression: '', campaignName: 'IT_Auto_Close', campaignId: 'c1' },
      { expression: 'close', campaignName: 'IT_Auto_Close', campaignId: 'c1' },
    ])
    expect(plan.conflicts).toEqual([])
    expect(plan.allowed).toBe(true)
  })
})

// ── AX3.3 — bulk rename ───────────────────────────────────────────────────
describe('applyNaming', () => {
  it('adds a prefix and a suffix', () => {
    expect(applyNaming('IT-GALE-SP-Auto', { prefix: 'Q1-', suffix: '-v2' })).toBe('Q1-IT-GALE-SP-Auto-v2')
  })
  it('find-and-replaces literally and case-insensitively, every occurrence', () => {
    expect(applyNaming('IT-GALE-SP-GALE', { replacements: [{ from: 'gale', to: 'VENTRA' }] })).toBe('IT-VENTRA-SP-VENTRA')
  })
  it('treats the needle as text, not a pattern — operators type names, not regexes', () => {
    expect(applyNaming('GALE | IT | Auto', { replacements: [{ from: ' | ', to: '-' }] })).toBe('GALE-IT-Auto')
    expect(applyNaming('A.B', { replacements: [{ from: '.', to: '_' }] })).toBe('A_B')
  })
  it('applies replacements before the prefix and suffix', () => {
    expect(applyNaming('OLD-Auto', { prefix: 'OLD-', replacements: [{ from: 'OLD-', to: '' }] })).toBe('OLD-Auto')
  })
  it('is a no-op with no rules', () => {
    expect(applyNaming('IT-GALE-SP-Auto', undefined)).toBe('IT-GALE-SP-Auto')
    expect(applyNaming('IT-GALE-SP-Auto', {})).toBe('IT-GALE-SP-Auto')
  })
})

describe('planApplication — naming is part of the plan, not a preview', () => {
  it('renames campaigns AND their ad groups', () => {
    const p = planApplication(doc, gale, [], { naming: { prefix: 'Q1-' } })
    expect(p.campaigns[0]!.name).toBe('Q1-IT-GALE-SP-Brand-Exact')
    expect(p.campaigns[0]!.adGroups[0]!.name).toBe('Q1-IT-GALE-SP-Brand-Exact Ad Group')
  })
  it('the collision gate checks the RENAMED name, so a rename can clear a block', () => {
    const untokenised = extractBlueprint([{
      name: 'IT_Auto_Close', dailyBudget: 5, biddingStrategy: null, placementBidding: [],
      adGroups: [{ name: 'ag', defaultBidCents: 30, asins: [], targets: [kw('giacca moto')] }],
    }], { productToken: 'MOSS' })
    const live = { existingCampaignNames: ['IT_Auto_Close'] }
    expect(planApplication(untokenised, gale, [], live).allowed).toBe(false)
    expect(planApplication(untokenised, gale, [], { ...live, naming: { prefix: 'GALE-' } }).allowed).toBe(true)
  })
})

// ── AX3.3 — what to copy ──────────────────────────────────────────────────
describe('planApplication — copy scope', () => {
  const src = (): SourceCampaign[] => [{
    name: 'IT-AIREON-SP-Mixed', dailyBudget: 10, biddingStrategy: null,
    placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 75 }], targetingType: 'MANUAL',
    adGroups: [{
      name: 'ag', defaultBidCents: 30, asins: ['B0A'],
      targets: [
        kw('giacca aireon'), kw('casco moto', 'EXACT', true),
        { kind: 'PRODUCT', expressionType: 'ASIN', expressionValue: 'B0RIVAL', bidCents: 40, isNegative: false, negativeLevel: null },
        { kind: 'AUTO', expressionType: 'SEARCH_CLOSE_MATCH', expressionValue: '', bidCents: 20, isNegative: false, negativeLevel: null },
      ],
    }],
  }]
  const d = extractBlueprint(src(), { productToken: 'AIREON' })
  const kinds = (include: Record<string, boolean>) => {
    const p = planApplication(d, gale, [], { include })
    return { plan: p, kinds: p.campaigns[0]!.adGroups[0]!.targets.map((t) => `${t.kind}${t.isNegative ? ':neg' : ''}`) }
  }

  it('copies everything by default', () => {
    expect(kinds({}).kinds.sort()).toEqual(['AUTO', 'KEYWORD', 'KEYWORD:neg', 'PRODUCT'])
  })
  it('excluding keywords keeps the negatives, product targets and auto clauses', () => {
    const { kinds: k, plan } = kinds({ keywords: false })
    expect(k.sort()).toEqual(['AUTO', 'KEYWORD:neg', 'PRODUCT'])
    expect(plan.excluded.keywords).toBe(1)
  })
  it('excluding negatives keeps only the positives', () => {
    expect(kinds({ negatives: false }).kinds.sort()).toEqual(['AUTO', 'KEYWORD', 'PRODUCT'])
  })
  it('excluding product targets and auto clauses leaves the keywords', () => {
    expect(kinds({ productTargets: false, autoClauses: false }).kinds.sort()).toEqual(['KEYWORD', 'KEYWORD:neg'])
  })
  it('excluding placement modifiers empties them rather than copying them', () => {
    expect(planApplication(d, gale, [], { include: { placementBidding: false } }).campaigns[0]!.placementBidding).toEqual([])
    expect(planApplication(d, gale, []).campaigns[0]!.placementBidding).toHaveLength(1)
  })
  it('WARNS about everything the scope left behind — never silently', () => {
    const p = planApplication(d, gale, [], { include: { keywords: false, autoClauses: false } })
    expect(p.warnings.some((w) => w.includes('will NOT be copied') && w.includes('keyword') && w.includes('auto clause'))).toBe(true)
  })
  it('warns when a campaign would be created with no positive targeting at all', () => {
    const p = planApplication(d, gale, [], { include: { keywords: false, productTargets: false, autoClauses: false } })
    expect(p.warnings.some((w) => w.includes('no positive targeting'))).toBe(true)
  })
})

// ── AX3.3 — bid and budget policy ─────────────────────────────────────────
describe('planApplication — bid and budget policy', () => {
  it('copies verbatim by default', () => {
    const p = planApplication(doc, gale, [])
    expect(p.campaigns[0]!.dailyBudget).toBe(10)
    expect(p.campaigns[0]!.adGroups[0]!.targets[0]!.bidCents).toBe(30)
  })
  it('scales bids by a percentage', () => {
    const p = planApplication(doc, gale, [], { bidPolicy: { mode: 'scale', value: 50 } })
    expect(p.campaigns[0]!.adGroups[0]!.targets[0]!.bidCents).toBe(15)
    expect(p.campaigns[0]!.adGroups[0]!.defaultBidCents).toBe(15)
  })
  it('never scales a bid below Amazon’s 2c floor', () => {
    const p = planApplication(doc, gale, [], { bidPolicy: { mode: 'scale', value: 1 } })
    expect(p.campaigns[0]!.adGroups[0]!.targets[0]!.bidCents).toBe(2)
  })
  it('sets a flat bid', () => {
    const p = planApplication(doc, gale, [], { bidPolicy: { mode: 'fixed', value: 12 } })
    expect(p.campaigns[0]!.adGroups[0]!.targets[0]!.bidCents).toBe(12)
  })
  it('scales budgets, and the committed total follows', () => {
    const p = planApplication(doc, gale, [], { budgetPolicy: { mode: 'scale', value: 50 } })
    expect(p.totals.dailyBudgetTotal).toBe(13) // 10→5, 15→8 (rounded)
  })
  it('a scaled budget can bring a plan under the cap that blocked it', () => {
    expect(planApplication(doc, gale, [], { dailyBudgetCapEur: 20 }).allowed).toBe(false)
    expect(planApplication(doc, gale, [], { dailyBudgetCapEur: 20, budgetPolicy: { mode: 'scale', value: 50 } }).allowed).toBe(true)
  })
})

// ── AX3.4 — the review step's edits ───────────────────────────────────────
describe('planApplication — edits', () => {
  const ids = () => {
    const p = planApplication(doc, gale, [])
    return {
      c0: p.campaigns[0]!.id, c1: p.campaigns[1]!.id,
      g0: p.campaigns[0]!.adGroups[0]!.id, g1: p.campaigns[1]!.adGroups[0]!.id,
      t0: p.campaigns[0]!.adGroups[0]!.targets[0]!.id,
    }
  }

  it('gives every node a stable, deterministic id', () => {
    const a = planApplication(doc, gale, [])
    const b = planApplication(doc, gale, [])
    expect(a.campaigns.map((c) => c.id)).toEqual(['c0', 'c1'])
    expect(a.campaigns[0]!.adGroups[0]!.targets.map((t) => t.id)).toEqual(b.campaigns[0]!.adGroups[0]!.targets.map((t) => t.id))
  })

  it('removes a campaign, and the budget total follows', () => {
    const p = planApplication(doc, gale, [], {}, { removedCampaigns: [ids().c1] })
    expect(p.campaigns.map((c) => c.role)).toEqual(['Brand-Exact'])
    expect(p.totals.campaigns).toBe(1)
    expect(p.totals.dailyBudgetTotal).toBe(10) // was 25
  })

  it('removes a single keyword', () => {
    const p = planApplication(doc, gale, [], {}, { removedTargets: [ids().t0] })
    expect(p.campaigns[0]!.adGroups[0]!.targets.map((t) => t.expression)).toEqual(['giacca GALE'])
    expect(p.totals.positives).toBe(3) // the fixture has 4 positives
  })

  it('drops a campaign whose every ad group was emptied — an empty shell is worse than nothing', () => {
    const p0 = planApplication(doc, gale, [])
    const all = p0.campaigns[0]!.adGroups[0]!.targets.map((t) => t.id)
    const p = planApplication(doc, gale, [], {}, { removedTargets: all })
    expect(p.campaigns.map((c) => c.role)).toEqual(['Category-Exact'])
  })

  it('renames a campaign and an ad group', () => {
    const i = ids()
    const p = planApplication(doc, gale, [], {}, {
      renamedCampaigns: [{ id: i.c0, name: 'GALE Hero' }],
      renamedAdGroups: [{ id: i.g0, name: 'GALE Hero AG' }],
    })
    expect(p.campaigns[0]!.name).toBe('GALE Hero')
    expect(p.campaigns[0]!.adGroups[0]!.name).toBe('GALE Hero AG')
  })

  it('a rename is checked by the collision gate like any other name', () => {
    const i = ids()
    const p = planApplication(doc, gale, [], { existingCampaignNames: ['Taken'] }, {
      renamedCampaigns: [{ id: i.c0, name: 'Taken' }],
    })
    expect(p.allowed).toBe(false)
    expect(p.blockers.some((b) => b.includes('already exist'))).toBe(true)
  })

  it('edits budgets and bids, never below the floor', () => {
    const i = ids()
    const p = planApplication(doc, gale, [], {}, {
      campaignBudgets: [{ id: i.c0, dailyBudget: 3 }],
      adGroupBids: [{ id: i.g0, defaultBidCents: 1 }],
      targetBids: [{ id: i.t0, bidCents: 0 }],
    })
    expect(p.campaigns[0]!.dailyBudget).toBe(3)
    expect(p.totals.dailyBudgetTotal).toBe(18)
    expect(p.campaigns[0]!.adGroups[0]!.defaultBidCents).toBe(2)
    expect(p.campaigns[0]!.adGroups[0]!.targets[0]!.bidCents).toBe(2)
  })

  it('an edited budget can bring a plan back under the cap', () => {
    const i = ids()
    expect(planApplication(doc, gale, [], { dailyBudgetCapEur: 20 }).allowed).toBe(false)
    expect(planApplication(doc, gale, [], { dailyBudgetCapEur: 20 }, { campaignBudgets: [{ id: i.c0, dailyBudget: 4 }] }).allowed).toBe(true)
  })

  it('adds a keyword to an ad group', () => {
    const p = planApplication(doc, gale, [], {}, {
      addedTargets: [{ adGroupId: ids().g0, expression: 'giacca {{product}} estiva', expressionType: 'EXACT' }],
    })
    const added = p.campaigns[0]!.adGroups[0]!.targets.find((t) => t.added)!
    expect(added.expression).toBe('giacca GALE estiva') // materialised like any other
    expect(p.totals.positives).toBe(5)
  })

  // ── the part that must not have a hole in it ────────────────────────────
  it('an ADDED keyword is gated exactly like a copied one', () => {
    // Otherwise "add a keyword" in step 2 is a way to walk straight past the
    // self-competition check that the whole feature exists to enforce.
    const p = planApplication(doc, gale, [
      { expression: 'stivali moto', campaignName: 'IT-AIREON-SP-Category-Broad', campaignId: 'c_x' },
    ], {}, { addedTargets: [{ adGroupId: ids().g0, expression: 'stivali moto', expressionType: 'BROAD' }] })
    expect(p.allowed).toBe(false)
    expect(p.conflicts.map((c) => c.expression)).toContain('stivali moto')
  })

  it('an added BRAND keyword is not gated — it is about the new product', () => {
    const p = planApplication(doc, gale, [
      { expression: 'gale jacket', campaignName: 'Something', campaignId: 'c_y' },
    ], {}, { addedTargets: [{ adGroupId: ids().g0, expression: 'gale jacket', expressionType: 'EXACT' }] })
    expect(p.allowed).toBe(true)
  })

  it('an added NEGATIVE is never gated — a negative cannot compete', () => {
    const p = planApplication(doc, gale, [
      { expression: 'casco', campaignName: 'Z', campaignId: 'c_z' },
    ], {}, { addedTargets: [{ adGroupId: ids().g0, expression: 'casco', expressionType: 'EXACT', isNegative: true }] })
    expect(p.allowed).toBe(true)
    expect(p.conflicts).toEqual([])
  })

  it('BLOCKS a stale edit set rather than applying part of it', () => {
    // The operator went back and changed the source; their edits now address
    // nodes that do not exist. Applying the rest would create something nobody
    // approved.
    const p = planApplication(doc, gale, [], {}, { removedCampaigns: ['c99'] })
    expect(p.allowed).toBe(false)
    expect(p.blockers.some((b) => b.includes('no longer in this plan'))).toBe(true)
    // and nothing was removed
    expect(p.campaigns).toHaveLength(2)
  })

  it('a stale reference in ANY edit kind blocks', () => {
    expect(planApplication(doc, gale, [], {}, { targetBids: [{ id: 'c0.g0.t99', bidCents: 5 }] }).allowed).toBe(false)
    expect(planApplication(doc, gale, [], {}, { addedTargets: [{ adGroupId: 'c9.g9', expression: 'x', expressionType: 'EXACT' }] }).allowed).toBe(false)
  })

  it('no edits at all behaves exactly as before', () => {
    const a = planApplication(doc, gale, [])
    const b = planApplication(doc, gale, [], {}, {})
    expect(b.totals).toEqual(a.totals)
    expect(b.allowed).toBe(a.allowed)
  })
})

// ── AX3.6 — the re-run guard ──────────────────────────────────────────────
describe('planApplication — you have already replicated this', () => {
  it('WARNS when this product was already replicated into this market', () => {
    const p = planApplication(doc, gale, [], { priorRun: { when: '2026-07-20', status: 'APPLIED', campaigns: 11 } })
    expect(p.allowed).toBe(true) // a warning, not a block — re-running is legitimate
    expect(p.warnings.some((w) => w.includes('already replicated') && w.includes('2026-07-20') && w.includes('SECOND set'))).toBe(true)
  })
  it('says nothing when the earlier run was rolled back', () => {
    const p = planApplication(doc, gale, [], { priorRun: { when: '2026-07-20', status: 'ROLLED_BACK', campaigns: 11 } })
    expect(p.warnings.some((w) => w.includes('already replicated'))).toBe(false)
  })
  it('says nothing when there is no earlier run', () => {
    expect(planApplication(doc, gale, []).warnings.some((w) => w.includes('already replicated'))).toBe(false)
  })
})
