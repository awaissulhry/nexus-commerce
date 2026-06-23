/**
 * S.1 — Suggestions navigation resolver unit tests.
 *
 * resolveSourceLink is the pure core: given a suggestion row + pre-fetched lookups,
 * it returns the deep-link the Suggestions page navigates to. We cover all four
 * entityType→href cases plus graceful degradation when the entity is gone. The DB
 * batching (attachSourceLinks) is exercised live on prod; this protects the mapping.
 */
import { describe, it, expect } from 'vitest'
import { resolveSourceLink, type SourceLookups, type SourceRow } from './ads-suggestions.service.js'

const lookups = (over: Partial<SourceLookups> = {}): SourceLookups => ({
  campaign: new Map(),
  adTarget: new Map(),
  extCampaign: new Map(),
  ...over,
})

const row = (over: Partial<SourceRow>): SourceRow => ({
  entityType: 'CAMPAIGN', entityId: 'x', entityName: null, marketplace: 'IT', ...over,
})

describe('resolveSourceLink', () => {
  it('CAMPAIGN → /campaigns/{id} with the campaign name as label', () => {
    const lk = lookups({ campaign: new Map([['camp_1', { id: 'camp_1', name: 'Xavia · Auto IT' }]]) })
    const s = resolveSourceLink(row({ entityType: 'CAMPAIGN', entityId: 'camp_1', entityName: 'Xavia · Auto IT' }), lk)
    expect(s.href).toBe('/marketing/ads/campaigns/camp_1')
    expect(s.label).toBe('Xavia · Auto IT')
    expect(s.campaignId).toBe('camp_1')
    expect(s.marketplace).toBe('IT')
  })

  it('CAMPAIGN unresolved → href null, falls back to entityName', () => {
    const s = resolveSourceLink(row({ entityType: 'CAMPAIGN', entityId: 'gone', entityName: 'Deleted campaign' }), lookups())
    expect(s.href).toBeNull()
    expect(s.label).toBe('Deleted campaign')
  })

  it('SEARCH_TERM → /campaigns/{id}?tab=search-terms, keyword = query, disambiguated by marketplace', () => {
    const lk = lookups({
      extCampaign: new Map([
        ['AMZ123|IT', { id: 'camp_it', name: 'IT campaign' }],
        ['AMZ123|DE', { id: 'camp_de', name: 'DE campaign' }],
        ['AMZ123', { id: 'camp_it', name: 'IT campaign' }],
      ]),
    })
    const s = resolveSourceLink(row({ entityType: 'SEARCH_TERM', entityId: 'AMZ123:casco moto', entityName: 'casco moto', marketplace: 'DE' }), lk)
    expect(s.href).toBe('/marketing/ads/campaigns/camp_de?tab=search-terms')
    expect(s.keyword).toBe('casco moto')
    expect(s.campaignId).toBe('camp_de')
  })

  it('SEARCH_TERM falls back to the bare-ext key when marketplace does not match', () => {
    const lk = lookups({ extCampaign: new Map([['AMZ123', { id: 'camp_any', name: 'Any' }]]) })
    const s = resolveSourceLink(row({ entityType: 'SEARCH_TERM', entityId: 'AMZ123:guanti', entityName: 'guanti', marketplace: 'FR' }), lk)
    expect(s.href).toBe('/marketing/ads/campaigns/camp_any?tab=search-terms')
    expect(s.keyword).toBe('guanti')
  })

  it('SEARCH_TERM preserves a query containing a colon (splits on the first only)', () => {
    const lk = lookups({ extCampaign: new Map([['AMZ9', { id: 'c9', name: 'C9' }]]) })
    const s = resolveSourceLink(row({ entityType: 'SEARCH_TERM', entityId: 'AMZ9:size: large', entityName: 'size: large', marketplace: 'IT' }), lk)
    expect(s.keyword).toBe('size: large')
  })

  it('SEARCH_TERM unresolved → href null, keeps the query as label', () => {
    const s = resolveSourceLink(row({ entityType: 'SEARCH_TERM', entityId: 'AMZX:stivali', entityName: 'stivali' }), lookups())
    expect(s.href).toBeNull()
    expect(s.label).toBe('stivali')
    expect(s.keyword).toBe('stivali')
  })

  it('AD_TARGET → /campaigns/{id}/ad-groups/{agId}?tab=targets, label = keyword text (fixes the null-name bug)', () => {
    const lk = lookups({
      adTarget: new Map([['tgt_1', {
        expressionValue: 'casco integrale', expressionType: 'EXACT', adGroupId: 'ag_1',
        adGroupName: 'Helmets', campaignId: 'camp_7', campaignName: 'Xavia Helmets',
      }]]),
    })
    // entityName is null in storage for AD_TARGET — the resolver must still produce a human label.
    const s = resolveSourceLink(row({ entityType: 'AD_TARGET', entityId: 'tgt_1', entityName: null }), lk)
    expect(s.href).toBe('/marketing/ads/campaigns/camp_7/ad-groups/ag_1?tab=targets')
    expect(s.label).toBe('casco integrale')
    expect(s.keyword).toBe('casco integrale')
    expect(s.matchType).toBe('EXACT')
    expect(s.adGroupId).toBe('ag_1')
    expect(s.campaignId).toBe('camp_7')
  })

  it('AD_TARGET unresolved → href null, falls back to entityId (no name available)', () => {
    const s = resolveSourceLink(row({ entityType: 'AD_TARGET', entityId: 'tgt_gone', entityName: null }), lookups())
    expect(s.href).toBeNull()
    expect(s.label).toBe('tgt_gone')
  })

  it('MARKETPLACE → the Ad Manager grid, label = marketplace code', () => {
    const s = resolveSourceLink(row({ entityType: 'MARKETPLACE', entityId: 'IT', entityName: 'IT', marketplace: 'IT' }), lookups())
    expect(s.href).toBe('/marketing/ads/campaigns')
    expect(s.label).toBe('IT')
    expect(s.marketplace).toBe('IT')
  })

  it('unknown entityType → href null, never throws', () => {
    const s = resolveSourceLink(row({ entityType: 'WIDGET', entityId: 'w1', entityName: 'Widget' }), lookups())
    expect(s.href).toBeNull()
    expect(s.label).toBe('Widget')
  })
})
