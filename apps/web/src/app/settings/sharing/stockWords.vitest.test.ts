import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Grant, GrantImpact, ListingRule } from './stockPoolApi'
import { grantStatusWords, impactLines, lenderConsequence, listingName, previewRuleWords, warehousesWords } from './stockWords'

// The API owns the list of listing rules. Two copies drift, so this reads the API's source and compares.
const links = readFileSync(new URL('../../../../../api/src/services/stock-pool/pool-links.service.ts', import.meta.url), 'utf8')
const apiRules = [...(/rule:\s*((?:'[a-z-]+'\s*\|?\s*)+)/.exec(links)?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((m) => m[1])

const grant = (over: Partial<Grant> = {}): Grant => ({
  id: 'g1', side: 'lender', ownerWorkspaceId: 'a', ownerWorkspaceName: 'Lender A', workspaceId: 'b', workspaceName: 'Borrower B',
  status: 'active', version: 2, locations: [{ id: 'l1', code: 'IT-MAIN', name: 'Main', usable: true }], linkedProducts: 3,
  createdAt: '2026-09-19T08:00:00Z', respondedAt: '2026-09-19T09:00:00Z', pausedAt: null, endedAt: null, endedBySide: null, ...over,
})
const impact = (listings: Partial<GrantImpact['listings']> = {}, sharedVariants: Partial<GrantImpact['sharedVariants']> = {}, linkedProducts = 3): GrantImpact => ({
  grantId: 'g1', linkedProducts,
  listings: { toZero: 0, toOwn: 0, pinned: 0, paused: 0, closed: 0, fba: 0, ...listings },
  sharedVariants: { toZero: 0, toOwn: 0, excluded: 0, ...sharedVariants },
})

describe('shared stock words', () => {
  it('has words for every listing rule the API can send, and no others', () => {
    expect(apiRules.length).toBeGreaterThan(5) // positive control: the source was really read
    const ours: ListingRule[] = ['follows', 'fixed', 'paused', 'excluded', 'amazon-managed', 'offer-closed', 'not-counted']
    expect([...ours].sort()).toEqual([...apiRules].sort())
    for (const rule of ours) expect(previewRuleWords({ rule, willShow: 4 })).not.toMatch(/-|undefined/)
    expect(previewRuleWords({ rule: 'follows', willShow: 9 })).toBe('Shows 9')
  })

  it('the pause preview says exactly what happens, only the lines that apply, a listing never keeping an old number', () => {
    expect(impactLines(impact({ toZero: 12, pinned: 2, paused: 1 }), 'Borrower B')).toEqual([
      '12 listings go to 0.',
      '2 listings are on a Fixed number and keep it. A fixed number is not real stock.',
      '1 listing is Paused: nothing is sent, so the channel keeps its last number.',
    ])
    expect(impactLines(impact({ toOwn: 1 }, { toZero: 2, excluded: 1 }), 'Borrower B')).toEqual([
      '1 listing goes to Borrower B’s own stock.',
      '2 shared eBay variants go to 0.',
      '1 shared eBay variant is Excluded and stays as it is.',
    ])
    expect(impactLines(impact({}, {}, 0), 'Borrower B')).toEqual(['No product of Borrower B uses this stock. No listing changes.'])
    expect(impactLines(impact(), 'Borrower B')).toEqual(['No listing of these products is live, so no number changes.'])
  })

  it('each side reads the status from its own point of view; a closed warehouse is named', () => {
    expect(grantStatusWords(grant({ status: 'pending', respondedAt: null }), 'lender').detail).toMatch(/An owner of Borrower B must accept/)
    expect(grantStatusWords(grant({ status: 'pending', respondedAt: null }), 'borrower').label).toBe('Offer to review')
    expect(grantStatusWords(grant({ status: 'paused', pausedAt: '2026-09-19T10:00:00Z' }), 'borrower').detail).toMatch(/use your own stock until it resumes/)
    expect(grantStatusWords(grant({ status: 'revoked', endedBySide: 'borrower', endedAt: '2026-09-19T11:00:00Z' }), 'lender').detail).toMatch(/^Borrower B left/)
    expect(grantStatusWords(grant({ status: 'revoked', endedBySide: 'owner', respondedAt: null, endedAt: '2026-09-19T11:00:00Z' }), 'lender').detail).toMatch(/^You withdrew/)
    expect(warehousesWords(grant({ locations: [{ id: 'l1', code: 'IT-MAIN', name: 'Main', usable: true }, { id: 'l2', code: 'IT-OLD', name: 'Old', usable: false }] }))).toBe('IT-MAIN · IT-OLD (closed: lends 0)')
    expect(lenderConsequence(grant(), 'end')).toMatch(/3 products in Borrower B go back to their own stock/)
    expect(listingName({ channel: 'EBAY', marketplace: 'IT', itemId: '1234' })).toBe('eBay IT · listing 1234')
    // A lone listing needs no mark; the account is named when the listing has one.
    expect(listingName({ channel: 'EBAY', marketplace: 'IT', accountLabel: 'Main store', listingMark: null, aliasLabel: null })).toBe('eBay IT · Main store')
    // Two listings on one account and market: the main listing and its alias, told apart as the Media page does.
    expect(listingName({ channel: 'EBAY', marketplace: 'IT', accountLabel: 'Main store', listingMark: 0, aliasLabel: null })).toBe('eBay IT · Main store · ★ Main listing')
    expect(listingName({ channel: 'EBAY', marketplace: 'IT', accountLabel: 'Main store', listingMark: 1, aliasLabel: 'Winter listing' })).toBe('eBay IT · Main store · ① Winter listing')
    expect(listingName({ channel: 'EBAY', marketplace: 'IT', accountLabel: null, listingMark: 2, aliasLabel: null })).toBe('eBay IT · ② Listing alias 2')
  })
})
