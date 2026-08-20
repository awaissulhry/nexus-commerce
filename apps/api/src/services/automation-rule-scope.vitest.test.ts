/**
 * ACR.7 — the scope predicate that makes drag-to-scope real.
 *
 * The property under test is the one the old code lacked: a scoped rule NEVER fires outside
 * its scope. Before this, scopeMarketplace was a skip-optimisation — the evaluation call ran
 * every enabled rule for the trigger, so a DE-scoped rule fired on IT contexts whenever any
 * rule passed the check.
 */
import { describe, it, expect } from 'vitest'
import { ruleMatchesScope, contextIdentity } from './automation-rule-scope.js'

const unscoped = { scopeMarketplace: null, scopePortfolioId: null, scopeCampaignId: null }

describe('ruleMatchesScope', () => {
  it('an unscoped rule fires everywhere — today\'s behaviour, unchanged', () => {
    expect(ruleMatchesScope(unscoped, { marketplace: 'IT', campaignId: 'c1', portfolioId: 'p1' })).toBe(true)
    expect(ruleMatchesScope(unscoped, { marketplace: null, campaignId: null, portfolioId: null })).toBe(true)
  })

  it('a marketplace-scoped rule never fires on another marketplace', () => {
    const de = { ...unscoped, scopeMarketplace: 'DE' }
    expect(ruleMatchesScope(de, { marketplace: 'IT', campaignId: 'c1', portfolioId: null })).toBe(false)
    expect(ruleMatchesScope(de, { marketplace: 'DE', campaignId: 'c1', portfolioId: null })).toBe(true)
  })

  it('a portfolio-scoped rule fires only inside that portfolio', () => {
    const r = { ...unscoped, scopePortfolioId: 'ext-gale' }
    expect(ruleMatchesScope(r, { marketplace: 'IT', campaignId: 'c1', portfolioId: 'ext-gale' })).toBe(true)
    expect(ruleMatchesScope(r, { marketplace: 'IT', campaignId: 'c2', portfolioId: 'ext-other' })).toBe(false)
  })

  it('a campaign-scoped rule fires only on that campaign', () => {
    const r = { ...unscoped, scopeCampaignId: 'c1' }
    expect(ruleMatchesScope(r, { marketplace: 'IT', campaignId: 'c1', portfolioId: null })).toBe(true)
    expect(ruleMatchesScope(r, { marketplace: 'IT', campaignId: 'c2', portfolioId: null })).toBe(false)
  })

  it('a campaign/portfolio-scoped rule does NOT fire on contexts with no campaign identity', () => {
    // An FBA-age or account-level context belongs to no campaign; "only my campaign's events"
    // cannot honestly match it. This is the branch that keeps scoped rules out of global sweeps.
    const byCampaign = { ...unscoped, scopeCampaignId: 'c1' }
    const byPortfolio = { ...unscoped, scopePortfolioId: 'ext-gale' }
    const anonymous = { marketplace: 'IT', campaignId: null, portfolioId: null }
    expect(ruleMatchesScope(byCampaign, anonymous)).toBe(false)
    expect(ruleMatchesScope(byPortfolio, anonymous)).toBe(false)
    expect(ruleMatchesScope(unscoped, anonymous)).toBe(true)
  })

  it('scopes compose — marketplace AND portfolio must both match', () => {
    const r = { scopeMarketplace: 'IT', scopePortfolioId: 'ext-gale', scopeCampaignId: null }
    expect(ruleMatchesScope(r, { marketplace: 'IT', campaignId: 'c1', portfolioId: 'ext-gale' })).toBe(true)
    expect(ruleMatchesScope(r, { marketplace: 'DE', campaignId: 'c1', portfolioId: 'ext-gale' })).toBe(false)
  })
})

describe('contextIdentity', () => {
  const ext = new Map([['12345', 'local-1']])
  const pf = new Map<string, string | null>([['local-1', 'ext-gale'], ['local-2', null]])

  it('reads campaign-grain contexts directly', () => {
    expect(contextIdentity({ marketplace: 'IT', campaign: { id: 'local-1' } }, ext, pf))
      .toEqual({ marketplace: 'IT', campaignId: 'local-1', portfolioId: 'ext-gale' })
  })

  it('translates search-term contexts through the external id', () => {
    expect(contextIdentity({ marketplace: 'IT', searchTerm: { externalCampaignId: '12345' } }, ext, pf))
      .toEqual({ marketplace: 'IT', campaignId: 'local-1', portfolioId: 'ext-gale' })
  })

  it('a campaign outside any portfolio resolves portfolioId null, not undefined', () => {
    expect(contextIdentity({ marketplace: 'IT', campaign: { id: 'local-2' } }, ext, pf).portfolioId).toBeNull()
  })

  it('an anonymous context stays anonymous', () => {
    expect(contextIdentity({ marketplace: 'DE' }, ext, pf))
      .toEqual({ marketplace: 'DE', campaignId: null, portfolioId: null })
  })
})

// ── RA.GRAIN — the product grain, and composition ─────────────────────────────────────────
describe('ruleMatchesScope — product grain', () => {
  const line = { ...unscoped, scopeProductIds: ['parent', 'childA', 'childB'] }

  it('fires when the context advertises any product in the scope', () => {
    expect(ruleMatchesScope(line, { marketplace: 'IT', campaignId: 'c1', portfolioId: null, productIds: ['childA'] })).toBe(true)
    expect(ruleMatchesScope(line, { marketplace: 'IT', campaignId: 'c1', portfolioId: null, productIds: ['zzz', 'childB'] })).toBe(true)
  })

  it('does not fire when the context advertises none of them', () => {
    expect(ruleMatchesScope(line, { marketplace: 'IT', campaignId: 'c1', portfolioId: null, productIds: ['other'] })).toBe(false)
  })

  it('does NOT fire on a context with no product identity', () => {
    // An FBA-age or account-level context knows of no products. "Only this product's events"
    // cannot honestly match one that belongs to no product — the same rule campaign- and
    // portfolio-scoped rules already follow, not a new exception.
    expect(ruleMatchesScope(line, { marketplace: 'IT', campaignId: null, portfolioId: null, productIds: [] })).toBe(false)
    expect(ruleMatchesScope(line, { marketplace: 'IT', campaignId: 'c1', portfolioId: null })).toBe(false)
  })

  it('an EMPTY scope array is not a scope — it must not silence the rule', () => {
    // The expansion returning nothing (a deleted product, say) must not turn into "matches
    // everything" NOR into "matches nothing without saying so". Empty means unscoped here; the
    // reach line is what tells the operator the binding resolves to zero campaigns.
    const empty = { ...unscoped, scopeProductIds: [] }
    expect(ruleMatchesScope(empty, { marketplace: 'IT', campaignId: 'c1', portfolioId: null, productIds: [] })).toBe(true)
  })

  it('every existing caller keeps working without the new fields', () => {
    expect(ruleMatchesScope(unscoped, { marketplace: 'IT', campaignId: 'c1', portfolioId: null })).toBe(true)
  })
})

describe('ruleMatchesScope — dimensions AND together', () => {
  it('market + product: the case that earns composition', () => {
    // Measured on prod: 106 of 250 advertised ASINs span >1 market, and the GALE line runs in all
    // four (IT 32 · DE 22 · FR 14 · ES 9). "GALE in DE only" is a real scope.
    const galeInDe = { ...unscoped, scopeMarketplace: 'DE', scopeProductIds: ['gale', 'gale-m'] }
    expect(ruleMatchesScope(galeInDe, { marketplace: 'DE', campaignId: 'c1', portfolioId: null, productIds: ['gale-m'] })).toBe(true)
    // Right product, wrong market — the whole point of composing.
    expect(ruleMatchesScope(galeInDe, { marketplace: 'IT', campaignId: 'c2', portfolioId: null, productIds: ['gale-m'] })).toBe(false)
    // Right market, wrong product.
    expect(ruleMatchesScope(galeInDe, { marketplace: 'DE', campaignId: 'c3', portfolioId: null, productIds: ['moss'] })).toBe(false)
  })

  it('a contradictory combination matches nothing, which is why the route refuses to store one', () => {
    const impossible = { ...unscoped, scopeMarketplace: 'DE', scopeCampaignId: 'it-campaign' }
    expect(ruleMatchesScope(impossible, { marketplace: 'IT', campaignId: 'it-campaign', portfolioId: null })).toBe(false)
    expect(ruleMatchesScope(impossible, { marketplace: 'DE', campaignId: 'it-campaign', portfolioId: null })).toBe(true)
  })
})

describe('contextIdentity — product resolution', () => {
  const ext = new Map<string, string>()
  const pf = new Map<string, string | null>([['c1', 'ext-gale']])

  it('resolves products at AD-GROUP grain when the context has one', () => {
    // A target-grain context carries adGroup: { id }. An ad group advertises far fewer products
    // than its campaign, so resolving there makes a product-scoped rule genuinely narrower.
    const byAdGroup = new Map([['ag1', ['childA']]])
    const byCampaign = new Map([['c1', ['childA', 'childB', 'childC']]])
    const id = contextIdentity({ marketplace: 'IT', campaign: { id: 'c1' }, adGroup: { id: 'ag1' } }, ext, pf, byAdGroup, byCampaign)
    expect(id.productIds).toEqual(['childA'])
  })

  it('falls back to CAMPAIGN grain when there is no ad group', () => {
    const byCampaign = new Map([['c1', ['childA', 'childB']]])
    const id = contextIdentity({ marketplace: 'IT', campaign: { id: 'c1' } }, ext, pf, new Map(), byCampaign)
    expect(id.productIds).toEqual(['childA', 'childB'])
  })

  it('is empty for a context with no campaign identity at all', () => {
    const id = contextIdentity({ marketplace: 'IT' }, ext, pf, new Map(), new Map([['c1', ['x']]]))
    expect(id.productIds).toEqual([])
    expect(id.campaignId).toBeNull()
  })

  it('costs nothing when no rule is product-scoped — and says so by OMITTING the key', () => {
    // Absent means "nothing asked, nothing resolved"; [] means "resolved, advertises nothing".
    // Collapsing the two would also have changed the returned shape for every pre-existing caller.
    const id = contextIdentity({ marketplace: 'IT', campaign: { id: 'c1' } }, ext, pf)
    expect(id.productIds).toBeUndefined()
    expect('productIds' in id).toBe(false)
    expect(id.portfolioId).toBe('ext-gale')
  })
})

/**
 * D1 (2026-08-20) — assignment. The three states are the feature, and the difference between
 * "absent" and "[]" is what makes "a budget rule does nothing until it is assigned" true.
 */
describe('ruleMatchesScope — assignment (D1)', () => {
  const ctx = { marketplace: 'IT', campaignId: 'c1', portfolioId: 'ext-gale' }
  const bare = { scopeMarketplace: null, scopePortfolioId: null, scopeCampaignId: null }

  it('ABSENT leaves every pre-D1 rule exactly as it was', () => {
    expect(ruleMatchesScope({ ...bare }, ctx)).toBe(true)
  })

  it('EMPTY matches nothing — assigned to no campaign means it acts on none', () => {
    expect(ruleMatchesScope({ ...bare, assignedCampaignIds: [] }, ctx)).toBe(false)
  })

  it('matches a campaign it is assigned to, and only that one', () => {
    expect(ruleMatchesScope({ ...bare, assignedCampaignIds: ['c1'] }, ctx)).toBe(true)
    expect(ruleMatchesScope({ ...bare, assignedCampaignIds: ['c2'] }, ctx)).toBe(false)
    expect(ruleMatchesScope({ ...bare, assignedCampaignIds: ['c2', 'c1'] }, ctx)).toBe(true)
  })

  it('does not match a context with no campaign identity', () => {
    // Same law the campaign/portfolio branches follow: "only my assigned campaigns' events"
    // cannot honestly match an event that belongs to no campaign.
    const acct = { marketplace: 'IT', campaignId: null, portfolioId: null }
    expect(ruleMatchesScope({ ...bare, assignedCampaignIds: ['c1'] }, acct)).toBe(false)
    expect(ruleMatchesScope({ ...bare, assignedCampaignIds: [] }, acct)).toBe(false)
  })

  it('is an AND with the scope columns, not a replacement for them', () => {
    // Assignment points campaign -> rule; scopeMarketplace still points rule -> market. A rule
    // assigned to c1 but scoped to DE must not fire on c1's IT context.
    expect(ruleMatchesScope({ ...bare, scopeMarketplace: 'DE', assignedCampaignIds: ['c1'] }, ctx)).toBe(false)
    expect(ruleMatchesScope({ ...bare, scopeMarketplace: 'IT', assignedCampaignIds: ['c1'] }, ctx)).toBe(true)
  })

  it('still honours a single-valued scopeCampaignId alongside an assignment', () => {
    expect(ruleMatchesScope({ ...bare, scopeCampaignId: 'c2', assignedCampaignIds: ['c1'] }, ctx)).toBe(false)
  })
})
