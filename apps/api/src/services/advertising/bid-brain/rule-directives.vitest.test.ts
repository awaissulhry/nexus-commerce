/**
 * BID BRAIN BB-9 — rules become inputs (design §2 "Rules become inputs"): what each rule action asks the brain for, how
 * the brain applies it (lowest ceiling, highest floor, a share floor up to hi × 1.25, a rule's goal, a lane's cap and
 * floor), and that only a campaign the brain owns turns a rule's action into an input. Values are made up (public repo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const live = { ceiling: true, owned: new Set<string>(['c-owned']) }
vi.mock('./live.js', () => ({
  BRAIN_ACTOR: 'automation:bid-brain',
  brainLiveCeiling: () => live.ceiling,
  brainOwnedCampaignIds: vi.fn(async (ids?: readonly string[]) => new Set((ids ?? []).filter((id) => live.owned.has(id)))),
}))
const strategy = vi.fn(async () => new Map())
vi.mock('./load.js', () => ({ loadStrategy: (...a: unknown[]) => strategy(...(a as [])) }))
const owner = { byCampaign: new Map<string, unknown>(), accountDefaultPct: 30 as unknown }
vi.mock('../ads-target-acos-resolver.js', async (importOriginal) => ({ ...(await importOriginal<object>()), readOwnerTargets: vi.fn(async () => owner) }))

const db = {
  adTarget: { findUnique: vi.fn(), findMany: vi.fn() },
  adGroup: { findUnique: vi.fn(), findMany: vi.fn(async () => [{ id: 'g-1' }]) },
  campaign: { findUnique: vi.fn(async () => ({ marketplace: 'IT', dynamicBidding: null })) },
  bidDirective: { deleteMany: vi.fn((a: unknown) => ({ op: 'deleteMany', a })), createMany: vi.fn((a: unknown) => ({ op: 'createMany', a })) },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
}
vi.mock('../../../db.js', () => ({ default: db }))

const { directivesFor, parseWouldChange, ruleBrainInput, DIRECTIVE_DAYS } = await import('./rule-directives.js')
const { decide } = await import('./decide.js')
const { directiveInputs } = await import('./facts.js')
const { applyDirectives, applyLaneDirectives } = await import('./recipe.js')

const T = (id: string, bidCents: number) => ({ id, bidCents })

describe('what each rule action asks the brain for (pure)', () => {
  it('bid_down → a ceiling at today’s bid less its percent; bid_up → a floor; a share-of-voice raise → a share floor', () => {
    expect(directivesFor({ action: { type: 'bid_down', percent: 20 }, targets: [T('k1', 50)] }).drafts).toEqual([{ targetId: 'k1', lane: null, kind: 'CEILING', valueCents: 40, valuePct: null, reason: 'bid_down −20%' }])
    expect(directivesFor({ action: { type: 'bid_up' }, targets: [T('k1', 40)] }).drafts[0]).toMatchObject({ kind: 'FLOOR', valueCents: 46 })
    expect(directivesFor({ action: { type: 'bid_up', percent: 10 }, trigger: 'SOV_BID', targets: [T('k1', 40)] }).drafts[0]).toMatchObject({ kind: 'SHARE_FLOOR', valueCents: 44 })
    expect(directivesFor({ action: { type: 'bid_down', percent: 90 }, targets: [T('k1', 20)] }).drafts[0].valueCents).toBe(5) // the engine floor
  })

  it('lower_bid_to_floor → a ceiling at its floor; rank defense → a share floor on every keyword in scope', () => {
    expect(directivesFor({ action: { type: 'lower_bid_to_floor', floorCents: 3 }, targets: [T('k1', 50)] }).drafts[0]).toMatchObject({ kind: 'CEILING', valueCents: 5 })
    const rank = directivesFor({ action: { type: 'raise_bids_for_rank_defense', percent: 80 }, targets: [T('k1', 40), T('k2', 20)] })
    expect(rank.drafts.map((d) => [d.kind, d.valueCents])).toEqual([['SHARE_FLOOR', 60], ['SHARE_FLOOR', 30]]) // capped at +50 % like the handler
    expect(rank.words).toBe(`a share floor on 2 keywords (rank defense +50%), for ${DIRECTIVE_DAYS} days`)
  })

  it('the target-ACoS actions → a goal for their scope, nothing without a target of their own', () => {
    expect(directivesFor({ action: { type: 'bid_to_target_acos', targetAcos: 0.2 } }).drafts).toEqual([{ targetId: null, lane: null, kind: 'GOAL', valueCents: null, valuePct: 20, reason: 'bid_to_target_acos 20%' }])
    expect(directivesFor({ action: { type: 'bid_to_target_acos' } }).drafts).toEqual([])
    expect(directivesFor({ action: { type: 'bid_apply', op: 'targetAcos', value: 25 }, targets: [T('k1', 40)] }).drafts).toEqual([{ targetId: 'k1', lane: null, kind: 'GOAL', valueCents: null, valuePct: 25, reason: 'bid_apply targetAcos 25%' }])
    expect(directivesFor({ action: { type: 'bid_apply', op: 'curBidTargetAcos' }, targets: [T('k1', 40)] }).drafts).toEqual([])
  })

  it('another bid_apply op → a ceiling when it lowers, a floor when it raises, nothing when it keeps the bid', () => {
    const ask = (from: number, to: number, trigger?: string) => directivesFor({ action: { type: 'bid_apply', op: 'decPct' }, trigger, targets: [T('k1', from)], asked: { from, to } }).drafts
    expect(ask(60, 48)[0]).toMatchObject({ kind: 'CEILING', valueCents: 48 })
    expect(ask(40, 50)[0]).toMatchObject({ kind: 'FLOOR', valueCents: 50 })
    expect(ask(40, 50, 'SOV_BID')[0]).toMatchObject({ kind: 'SHARE_FLOOR', valueCents: 50 })
    expect(ask(40, 40)).toEqual([])
  })

  it('placement rules → a lane cap when they lower it, a lane floor when they raise it', () => {
    expect(directivesFor({ action: { type: 'set_placement_multiplier', placement: 'PLACEMENT_TOP', percentage: 50 }, lanePctNow: 150 }).drafts).toEqual([{ targetId: null, lane: 'TOP_OF_SEARCH', kind: 'CEILING', valueCents: 50, valuePct: null, reason: 'set_placement_multiplier 150% → 50%' }])
    expect(directivesFor({ action: { type: 'placement_apply', placement: 'PLACEMENT_PRODUCT_PAGE' }, asked: { from: 0, to: 30 } }).drafts[0]).toMatchObject({ lane: 'PRODUCT_PAGE', kind: 'FLOOR', valueCents: 30 })
    expect(directivesFor({ action: { type: 'placement_apply', placement: 'PLACEMENT_SOMEWHERE' }, asked: { from: 0, to: 30 } }).drafts).toEqual([])
  })

  it('reads every dry-run wording of the handlers', () => {
    expect(parseWouldChange('60¢ → 48¢')).toEqual({ from: 60, to: 48 })
    expect(parseWouldChange('120→96 cents')).toEqual({ from: 120, to: 96 })
    expect(parseWouldChange('40% → 60%')).toEqual({ from: 40, to: 60 })
    expect(parseWouldChange(3)).toBeNull()
  })
})

describe('the brain applies them (pure)', () => {
  it('a share floor may reach its own cap (hi × 1.25); a plain floor stops at the band top', () => {
    expect(applyDirectives(10, [{ kind: 'FLOOR', cents: 40, source: 'rule:F' }], 20, 25)).toMatchObject({ cents: 20 })
    expect(applyDirectives(10, [{ kind: 'SHARE_FLOOR', cents: 40, source: 'rule:S' }], 20, 25)).toMatchObject({ cents: 25, applied: ['share floor 25¢ (rule:S)'] })
    // A ceiling below a share floor still wins (the floor drops out, the bid stays under the ceiling), and the clash is said.
    expect(applyDirectives(10, [{ kind: 'SHARE_FLOOR', cents: 24, source: 'rule:S' }, { kind: 'CEILING', cents: 18, source: 'rule:C' }], 20, 25)).toEqual({ cents: 10, applied: [], clash: 'rule:S share floor 24¢ is above rule:C ceiling 18¢ — the ceiling wins' })
  })

  it("a lane's lowest cap and highest floor win; a floor above a cap loses; a floor adds a lane the plan does not shape", () => {
    const lanes = applyLaneDirectives([{ lane: 'TOP_OF_SEARCH', planPct: 150 }], [
      { lane: 'TOP_OF_SEARCH', kind: 'CEILING', pct: 80, source: 'a' }, { lane: 'TOP_OF_SEARCH', kind: 'CEILING', pct: 60, source: 'b' },
      { lane: 'TOP_OF_SEARCH', kind: 'FLOOR', pct: 70, source: 'c' }, { lane: 'PRODUCT_PAGE', kind: 'FLOOR', pct: 20, source: 'd' },
      { lane: 'REST_OF_SEARCH', kind: 'CEILING', pct: 10, source: 'e' },
    ])
    expect(lanes).toEqual([{ lane: 'TOP_OF_SEARCH', planPct: 60 }, { lane: 'PRODUCT_PAGE', planPct: 20 }])
    expect(applyLaneDirectives(undefined, [])).toEqual([])
  })

  /** The GALE example's rates (design §7): goal 20 % in an 18–28 % band → a goal bid of about 16¢. */
  const facts = (extra: Record<string, unknown> = {}) => ({
    targetId: 'k1', currentCents: 14, dataDay: '2026-10-05', listPriceCents: 8990, parentCpcRatio: 0.88,
    chain: [{ level: 'target' as const, evidence: { clicks: 1, orders: 0, salesCents: 0, costCents: 30 } }, { level: 'product' as const, evidence: { clicks: 2300, orders: 20, salesCents: 162_300, costCents: 69_000 } }],
    goal: { target: { kind: 'ACOS' as const, pct: 20 }, band: { loPct: 18, hiPct: 28 }, phase: 'PROFIT' as const },
    limits: { maxBidCents: 80, maxChangePct: 100 },
    ...extra,
  })

  it('a share floor lifts the GALE goal bid above the band top, up to hi × 1.25; a plain floor only to the band top', () => {
    const plain = decide(facts({ directives: [{ kind: 'FLOOR', cents: 60, source: 'rule "GALE IT — rank"' }] }))
    const share = decide(facts({ directives: [{ kind: 'SHARE_FLOOR', cents: 60, source: 'rule "GALE IT — share of voice"' }] }))
    expect(plain.why).toMatch(/floor 22¢ \(rule "GALE IT — rank"\)/)
    expect(share.why).toMatch(/share floor 28¢ \(rule "GALE IT — share of voice"\)/)
    expect(share.bidCents).toBeGreaterThan(plain.bidCents)
  })

  it("a rule's ceiling or floor binds like a limit: a bid inside the band but outside it is brought inside it at once", () => {
    const inBand = decide(facts({ currentCents: 22 }))
    expect(inBand.layer).toBe('band')
    const cut = decide(facts({ currentCents: 22, directives: [{ kind: 'CEILING', cents: 18, source: 'rule "Lower bids on clicks without sales"' }] }))
    expect(cut).toMatchObject({ action: 'write', layer: 'limit', bidCents: 18 })
    expect(cut.why).toMatch(/^rule input: 22¢ is outside the ceiling 18¢ \(rule "Lower bids on clicks without sales"\) → 18¢ \(/)
    // A floor raises to itself, held to the band top (22¢ here): never past the ACoS the band allows.
    expect(decide(facts({ currentCents: 14, directives: [{ kind: 'FLOOR', cents: 40, source: 'rule "Rising star"' }] }))).toMatchObject({ action: 'write', layer: 'limit', bidCents: 22 })
  })

  it("a rule's goal is named in the why", () => {
    expect(decide(facts({ goal: { target: { kind: 'ACOS', pct: 30 }, band: null, phase: 'PROFIT' }, goalBy: 'rule "Bids to 30%"' })).why).toMatch(/ \(the goal of rule "Bids to 30%"\)/)
  })

  it("the placement rules' caps shape the lanes the brain sets", () => {
    const d = decide(facts({ currentCents: 30, lanes: [{ lane: 'TOP_OF_SEARCH', planPct: 150 }], laneDirectives: [{ lane: 'TOP_OF_SEARCH', kind: 'CEILING', pct: 40, source: 'rule "ToS cap"' }] }))
    expect(d.placements).toEqual([{ lane: 'TOP_OF_SEARCH', planPct: 40, pct: 40, held: null }])
  })
})

describe("a keyword's inputs from its campaign's directives (facts)", () => {
  const row = (kind: string, extra: Record<string, unknown> = {}) => ({ targetId: null, lane: null, kind, valueCents: null, valuePct: null, label: `rule "${kind}"`, ...extra })
  it("its own and the campaign's bids and lanes; another keyword's rows are not its", () => {
    const got = directiveInputs([
      row('CEILING', { targetId: 'k1', valueCents: 30 }), row('FLOOR', { valueCents: 10 }), row('SHARE_FLOOR', { targetId: 'k2', valueCents: 50 }),
      row('FLOOR', { lane: 'TOP_OF_SEARCH', valueCents: 40 }), row('CEILING', { lane: 'NOWHERE', valueCents: 40 }),
    ], 'k1', 20)
    expect(got.directives).toEqual([{ kind: 'CEILING', cents: 30, source: 'rule "CEILING"' }, { kind: 'FLOOR', cents: 10, source: 'rule "FLOOR"' }])
    expect(got.laneDirectives).toEqual([{ lane: 'TOP_OF_SEARCH', kind: 'FLOOR', pct: 40, source: 'rule "FLOOR"' }])
    expect(got.goal).toBeNull()
  })

  it("a goal: the keyword's own before the campaign's, the lowest of several, none when it equals the goal in force", () => {
    const goals = [row('GOAL', { valuePct: 25, label: 'rule "campaign 25"' }), row('GOAL', { targetId: 'k1', valuePct: 40, label: 'rule "own 40"' }), row('GOAL', { targetId: 'k1', valuePct: 30, label: 'rule "own 30"' })]
    expect(directiveInputs(goals, 'k1', 20).goal).toEqual({ pct: 30, by: 'rule "own 30"' })
    expect(directiveInputs(goals, 'k2', 20).goal).toEqual({ pct: 25, by: 'rule "campaign 25"' })
    expect(directiveInputs(goals, 'k2', 25).goal).toBeNull()
  })
})

describe('ruleBrainInput — only a campaign the brain owns turns an action into an input', () => {
  const dryRun = vi.fn(async () => ({ ok: true, output: { dryRun: true, wouldChange: '60¢ → 48¢' } }))
  const meta = { ruleId: 'rule-1', trigger: 'KEYWORD_HIGH_ACOS', dryRun: false }
  const ctx = { adTarget: { id: 'k1', campaignId: 'c-owned' } }
  beforeEach(() => {
    live.ceiling = true
    vi.clearAllMocks()
    db.adTarget.findUnique.mockResolvedValue({ id: 'k1', bidCents: 60, adGroupId: 'g-1' })
    strategy.mockResolvedValue(new Map())
    owner.accountDefaultPct = 30
  })

  it('under a ceiling other than live: null, and nothing is read', async () => {
    live.ceiling = false
    expect(await ruleBrainInput({ type: 'bid_down' }, ctx, meta, dryRun)).toBeNull()
    expect(db.adTarget.findUnique).not.toHaveBeenCalled()
  })

  it('a campaign the brain does not own, an account-wide action, harvest or budget: null (the rule runs as before)', async () => {
    expect(await ruleBrainInput({ type: 'bid_down' }, { adTarget: { id: 'k9', campaignId: 'c-other' } }, meta, dryRun)).toBeNull()
    expect(await ruleBrainInput({ type: 'bid_to_target_acos', targetAcos: 0.2 }, {}, meta, dryRun)).toBeNull()
    expect(await ruleBrainInput({ type: 'harvest_and_negate' }, ctx, meta, dryRun)).toBeNull()
    expect(await ruleBrainInput({ type: 'adjust_ad_budget' }, ctx, meta, dryRun)).toBeNull()
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('bid_down on an owned campaign stores one ceiling for 7 days in place of the write, replacing its own row', async () => {
    const r = await ruleBrainInput({ type: 'bid_down', percent: 20 }, ctx, meta, dryRun)
    expect(r).toMatchObject({ ok: true, output: { campaignId: 'c-owned', bidBrain: { directives: 1, stored: 'a ceiling 48¢ on 1 keyword (bid_down −20%), for 7 days — the brain reads it on its next run' } } })
    expect(db.bidDirective.deleteMany).toHaveBeenCalledWith({ where: { campaignId: 'c-owned', source: 'rule:rule-1', OR: [{ targetId: 'k1', lane: null, kind: 'CEILING' }] } })
    const created = (db.bidDirective.createMany.mock.calls[0][0] as { data: Array<Record<string, unknown>> }).data[0]
    expect(created).toMatchObject({ campaignId: 'c-owned', targetId: 'k1', kind: 'CEILING', valueCents: 48, source: 'rule:rule-1', reason: 'bid_down −20%' })
    expect((created.until as Date).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000)
  })

  it('a dry run (PROPOSE, a preview) writes nothing and says what it would ask', async () => {
    const r = await ruleBrainInput({ type: 'bid_down', percent: 20 }, ctx, { ...meta, dryRun: true }, dryRun)
    expect(r).toMatchObject({ ok: true, output: { dryRun: true, wouldChange: 'a bid brain input: a ceiling 48¢ on 1 keyword (bid_down −20%), for 7 days' } })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it("bid_apply asks what its own handler's dry run says; a skip of the handler (a suppressed keyword) passes through", async () => {
    expect(await ruleBrainInput({ type: 'bid_apply', op: 'decPct', value: 20 }, ctx, meta, dryRun)).toMatchObject({ ok: true, output: { bidBrain: { sample: [{ kind: 'CEILING', valueCents: 48 }] } } })
    const skipped = vi.fn(async () => ({ ok: true, output: { skipped: 'suppressed_flag', adTargetId: 'k1' } }))
    expect(await ruleBrainInput({ type: 'bid_apply', op: 'decPct', value: 20 }, ctx, meta, skipped)).toEqual({ type: 'bid_apply', ok: true, output: { skipped: 'suppressed_flag', adTargetId: 'k1' } })
    expect(db.$transaction).toHaveBeenCalledTimes(1)
  })

  it('the hour factor and the price are the brain’s already: left to it, said', async () => {
    expect(await ruleBrainInput({ type: 'dayparting_apply', campaignId: 'c-owned' }, {}, meta, dryRun)).toEqual({ type: 'dayparting_apply', ok: true, output: { skipped: "left to the bid brain: the hourly plan is the brain's hour factor (it runs campaign c-owned; one writer per campaign)", campaignId: 'c-owned' } })
  })

  it('a goal equal to the one in force stores nothing; another goal is stored for the campaign', async () => {
    expect(await ruleBrainInput({ type: 'bid_to_target_acos', campaignId: 'c-owned', targetAcos: 0.3 }, {}, meta, dryRun)).toMatchObject({ ok: true, output: { noChange: true, bidBrain: expect.stringMatching(/the goal 30% ACoS is already the one in force/) } })
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(await ruleBrainInput({ type: 'bid_to_target_acos', campaignId: 'c-owned', targetAcos: 0.2 }, {}, meta, dryRun)).toMatchObject({ ok: true, output: { bidBrain: { sample: [{ kind: 'GOAL', valuePct: 20, targetId: null }] } } })
  })
})
