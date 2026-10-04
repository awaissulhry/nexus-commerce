/**
 * 4c (review 4.8, 4.10) — an Amazon Ads rule's create and edit refuse a scope it can never fire in, with a 400 and a
 * plain sentence that says how to fix it: picks outside the rule's market, a market no active Amazon Ads connection
 * serves, and picks on a Placement rule that are not Sponsored Products. The binding mirror keeps only in-market picks.
 *
 * Live case (L7): "Reclaim idle budget — DE" picks campaigns in DE, ES, FR and IT. Its next scope save is refused until
 * the picks outside DE are removed; a toggle still saves, and a refusal writes nothing, so the stored rule keeps
 * running exactly as stored.
 *
 * The database is a stub; the binding mirror is the real one, on the same stub.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Camp { id: string; name: string; marketplace: string | null; type: string; adProduct: string | null }
const CAMPAIGNS: Camp[] = [
  { id: 'de1', name: 'GALE DE AUTO', marketplace: 'DE', type: 'SP', adProduct: 'SPONSORED_PRODUCTS' },
  { id: 'de2', name: 'GALE DE BROAD', marketplace: 'DE', type: 'SP', adProduct: null },
  { id: 'it1', name: 'ZZ_e2e_single_wwq7s', marketplace: 'IT', type: 'SP', adProduct: 'SPONSORED_PRODUCTS' },
  { id: 'es1', name: 'GALE ES AUTO', marketplace: 'ES', type: 'SP', adProduct: 'SPONSORED_PRODUCTS' },
  { id: 'fr1', name: 'GALE FR AUTO', marketplace: 'FR', type: 'SP', adProduct: 'SPONSORED_PRODUCTS' },
  { id: 'deSb', name: 'GALE DE BRAND', marketplace: 'DE', type: 'SB', adProduct: 'SPONSORED_BRANDS' },
  { id: 'deSd', name: 'GALE DE DISPLAY', marketplace: 'DE', type: 'SD', adProduct: null },
]

const db = vi.hoisted(() => ({
  automationRule: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  advertisingActionLog: { create: vi.fn(async () => ({})) },
  campaign: { findMany: vi.fn() },
  campaignRuleAssignment: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  $transaction: vi.fn(),
}))
const profiles = vi.hoisted(() => ({ adsProfileFor: vi.fn() }))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('@nexus/database', () => ({ Prisma: {} }))
vi.mock('./ads-profile-resolver.js', () => profiles)

const { createAdsRule, updateAdsRule } = await import('./ads-rule-crud.service.js')
const { syncRuleCampaignBinding } = await import('./rule-campaign-binding.service.js')

const picks = (ids: string[]) => ids.map((id) => ({ id, name: `C ${id}` }))
const group = { match: 'all', conditions: [{ metric: 'Spend', op: 'gte', value: '5' }], action: { op: 'decPct', value: '10' } }
const budgetRule = (ids: string[], scopeMarketplace?: string | null) => ({
  name: 'Reclaim idle budget — DE', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
  actions: [{ type: 'budget', campaigns: picks(ids), budgetFloor: 1, budgetCeiling: 30 }],
  conditions: [group], ...(scopeMarketplace !== undefined ? { scopeMarketplace } : {}),
})
const placementRule = (ids: string[]) => ({
  name: 'Trim ToS', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
  actions: [{ type: 'placement', campaigns: picks(ids), placeFloor: 0, placeCeiling: 900 }],
  conditions: [{ match: 'all', conditions: [{ metric: 'ACOS', op: 'gte', value: '40' }], action: { op: 'decPct', value: '10' } }],
})
/** The live rule as stored: a DE market, picks across four markets, and the column links the mirror made for them. */
const STORED = {
  id: 'r-de', domain: 'advertising', ...budgetRule(['de1', 'de2', 'it1', 'es1', 'fr1'], 'DE'),
  enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', maxDailyAdSpendCentsEur: 10000,
}
const STORED_LINKS = ['de1', 'de2', 'it1', 'es1', 'fr1'].map((campaignId) => ({ id: `l-${campaignId}`, campaignId }))

const refusal = (out: unknown) => (out as { ok: false; status: number; body: { error: string; problems: string[] } })

beforeEach(() => {
  vi.clearAllMocks()
  db.campaign.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    CAMPAIGNS.filter((c) => where.id.in.includes(c.id)))
  db.automationRule.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 'new', ...data }))
  db.automationRule.findUnique.mockResolvedValue(STORED)
  db.automationRule.update.mockImplementation(async ({ data }: { data: object }) => ({ ...STORED, ...data }))
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ campaignRuleAssignment: db.campaignRuleAssignment }))
  db.campaignRuleAssignment.findMany.mockResolvedValue([])
  db.campaignRuleAssignment.deleteMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => ({ count: where.id.in.length }))
  db.campaignRuleAssignment.createMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }))
  profiles.adsProfileFor.mockImplementation(async (m: string) => (['IT', 'DE', 'ES', 'FR'].includes(m) ? { profileId: `P-${m}`, marketplace: m } : null))
})

describe('4c — picks outside the rule’s market', () => {
  it('🔴 a DE rule picking ES/FR/IT campaigns is refused: how many, which markets, and what to remove', async () => {
    const out = await createAdsRule(budgetRule(['de1', 'it1', 'es1', 'fr1'], 'DE'), 'user:test')
    const sentence = 'This rule runs in DE only, but 3 of its 4 picked campaigns are in other markets (1 in ES, 1 in FR, 1 in IT), so it can never change them. Remove the 3 picks outside DE.'
    expect(out).toEqual({ ok: false, status: 400, body: { error: sentence, problems: [sentence] } })
    expect(db.automationRule.create).not.toHaveBeenCalled()
    expect(db.campaignRuleAssignment.createMany).not.toHaveBeenCalled()
  })

  it('one pick outside reads in the singular', async () => {
    const out = refusal(await createAdsRule(budgetRule(['de1', 'de2', 'it1'], 'DE'), 'user:test'))
    expect(out.body.problems).toEqual([
      'This rule runs in DE only, but 1 of its 3 picked campaigns is in another market (1 in IT), so it can never change it. Remove the pick outside DE.',
    ])
  })

  it('in-market picks save, and the mirror binds exactly them', async () => {
    const out = await createAdsRule(budgetRule(['de1', 'de2'], 'DE'), 'user:test')
    expect(out.ok).toBe(true)
    expect(db.automationRule.create).toHaveBeenCalledTimes(1)
    const data = db.campaignRuleAssignment.createMany.mock.calls[0][0].data as Array<{ campaignId: string }>
    expect(data.map((d) => d.campaignId).sort()).toEqual(['de1', 'de2'])
  })

  it('a rule on All markets may pick across markets, and asks nothing of the campaigns or connections', async () => {
    const out = await createAdsRule(budgetRule(['de1', 'it1', 'es1'], null), 'user:test')
    expect(out.ok).toBe(true)
    expect(profiles.adsProfileFor).not.toHaveBeenCalled()
    // The mirror's own read only — the check made none.
    expect(db.campaign.findMany).toHaveBeenCalledTimes(1)
  })
})

describe('4c — the live rule "Reclaim idle budget — DE" after merge', () => {
  it('🔴 its next scope save is refused, and the refusal writes nothing: the stored rule keeps running as stored', async () => {
    const out = refusal(await updateAdsRule('r-de', { actions: STORED.actions, conditions: STORED.conditions, scopeMarketplace: 'DE' }, 'user:owner'))
    expect(out.status).toBe(400)
    expect(out.body.problems).toEqual([
      'This rule runs in DE only, but 3 of its 5 picked campaigns are in other markets (1 in ES, 1 in FR, 1 in IT), so it can never change them. Remove the 3 picks outside DE.',
    ])
    expect(db.automationRule.update).not.toHaveBeenCalled()
    expect(db.advertisingActionLog.create).not.toHaveBeenCalled()
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('a scope-only edit is checked against the stored picks (the merged rule)', async () => {
    const out = refusal(await updateAdsRule('r-de', { scopeMarketplace: 'DE' }, 'user:owner'))
    expect(out.status).toBe(400)
    expect(db.automationRule.update).not.toHaveBeenCalled()
  })

  it('a toggle or rename still saves — switching it off is never refused', async () => {
    expect((await updateAdsRule('r-de', { enabled: false }, 'user:owner')).ok).toBe(true)
    expect((await updateAdsRule('r-de', { name: 'Reclaim idle budget — DE (old)' }, 'user:owner')).ok).toBe(true)
    expect(db.campaign.findMany).not.toHaveBeenCalled()
    expect(profiles.adsProfileFor).not.toHaveBeenCalled()
  })

  it('once the picks outside DE are removed it saves, and the column drops the IT, ES and FR links', async () => {
    db.campaignRuleAssignment.findMany.mockResolvedValue(STORED_LINKS)
    const trimmed = budgetRule(['de1', 'de2'], 'DE')
    const out = await updateAdsRule('r-de', { actions: trimmed.actions, scopeMarketplace: 'DE' }, 'user:owner')
    expect(out.ok).toBe(true)
    expect(db.campaignRuleAssignment.deleteMany.mock.calls[0][0].where.id.in.sort()).toEqual(['l-es1', 'l-fr1', 'l-it1'])
    expect(db.campaignRuleAssignment.createMany).not.toHaveBeenCalled()
  })
})

describe('4c — a market with no active Amazon Ads connection', () => {
  it('🔴 is refused at create, naming the market', async () => {
    const out = refusal(await createAdsRule(budgetRule([], 'NL'), 'user:test'))
    expect(out.status).toBe(400)
    expect(out.body.problems).toEqual([
      'Nexus has no active Amazon Ads connection for NL, so a rule there can never run. Choose a market Nexus is connected to, or All markets.',
    ])
    expect(profiles.adsProfileFor).toHaveBeenCalledWith('NL')
    expect(db.automationRule.create).not.toHaveBeenCalled()
  })

  it('is refused when an edit moves a rule there', async () => {
    db.automationRule.findUnique.mockResolvedValue({ ...STORED, actions: budgetRule([]).actions })
    const out = refusal(await updateAdsRule('r-de', { scopeMarketplace: 'PL' }, 'user:owner'))
    expect(out.body.problems[0]).toMatch(/^Nexus has no active Amazon Ads connection for PL/)
    expect(db.automationRule.update).not.toHaveBeenCalled()
  })

  it('a connected market saves', async () => {
    expect((await createAdsRule(budgetRule([], 'IT'), 'user:test')).ok).toBe(true)
  })
})

describe('4c — Placement rules are Sponsored Products only', () => {
  it('🔴 a Sponsored Brands or Display pick is refused, by its ad type', async () => {
    const out = refusal(await createAdsRule(placementRule(['de1', 'deSb', 'deSd']), 'user:test'))
    expect(out.status).toBe(400)
    expect(out.body.problems).toEqual([
      'Placement adjustments exist on Sponsored Products campaigns only, but 2 of this rule\'s picked campaigns are not (1 Sponsored Brands, 1 Sponsored Display), so it can never change them. Remove those 2 picks.',
    ])
    expect(db.automationRule.create).not.toHaveBeenCalled()
  })

  it('Sponsored Products picks save — the legacy type column counts when adProduct is empty', async () => {
    expect((await createAdsRule(placementRule(['de1', 'de2', 'it1']), 'user:test')).ok).toBe(true)
  })

  it('a Budget rule may pick a Sponsored Brands campaign (only placement is SP-only here)', async () => {
    expect((await createAdsRule(budgetRule(['de1', 'deSb'], 'DE'), 'user:test')).ok).toBe(true)
  })
})

describe('4c — the binding mirror keeps only in-market picks', () => {
  it('🔴 a DE rule binds its DE picks and removes links outside DE; ids that no longer exist are still "skipped"', async () => {
    db.campaignRuleAssignment.findMany.mockResolvedValue([{ id: 'l-it1', campaignId: 'it1' }])
    const r = await syncRuleCampaignBinding('r-de', budgetRule(['de1', 'it1', 'es1', 'ghost']).actions, 'tester', 'DE')
    expect(r).toEqual({ applied: true, created: 1, removed: 1, skipped: ['ghost'] })
    const data = db.campaignRuleAssignment.createMany.mock.calls[0][0].data as Array<{ campaignId: string }>
    expect(data.map((d) => d.campaignId)).toEqual(['de1'])
    expect(db.campaignRuleAssignment.deleteMany.mock.calls[0][0].where).toEqual({ id: { in: ['l-it1'] } })
  })

  it('without a market every known pick is bound, as before', async () => {
    const r = await syncRuleCampaignBinding('r-all', budgetRule(['de1', 'it1']).actions, 'tester', null)
    expect(r.created).toBe(2)
  })
})
