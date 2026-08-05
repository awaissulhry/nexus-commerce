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
