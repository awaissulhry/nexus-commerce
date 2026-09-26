/**
 * P3b S1 (docs/attributes/PLAN.md §10.9) — the channel footprint: one rule, a unit table, the web scope bar's answer
 * where the two agree (and the two deliberate differences named), and the four scope fixtures on PostgreSQL with two
 * businesses kept apart.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
import { withWorkspace } from '../lib/workspace-context.js'
import { createScopeFixtures, type ScopeFixture, type ScopeFixtureKey } from '../test-support/attribute-scope-fixtures.js'
import { channelFootprint, footprintFrom, type FootprintConnection, type FootprintMarket } from './channel-footprint.service.js'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'

const acct = (id: string, channelType: string, extra: Partial<FootprintConnection> = {}): FootprintConnection =>
  ({ id, channelType, isActive: true, managedBy: 'oauth', isPrimary: false, authStatus: 'connected', ...extra })
const mk = (channel: string, code: string, participationStatus: string | null = null): FootprintMarket => ({ channel, code, participationStatus })
const MARKETS: FootprintMarket[] = [
  mk('AMAZON', 'DE'), mk('AMAZON', 'IT'), mk('EBAY', 'DE'), mk('EBAY', 'IT'), mk('SHOPIFY', 'GLOBAL'), mk('ETSY', 'GLOBAL'), mk('WOOCOMMERCE', 'GLOBAL'),
]
const channelMarkets = (f: ReturnType<typeof footprintFrom>) => Object.fromEntries(f.channels.map(c => [c.channel, c.markets]))

/**
 * The web scope bar's rule, today (`apps/web/.../_studio/studio-data.ts:94-123` + `scopes.ts:128`), kept here as the
 * reference: every oauth/env connection row counts, active or not (`GET /api/connections?all=true`), and every
 * switched-on market of a channel with at least one such row is in the bar.
 */
function webScopeBar(connections: readonly FootprintConnection[], markets: readonly FootprintMarket[]): Record<string, string[]> {
  const withAccounts = new Set(connections.filter(c => c.managedBy === 'oauth' || c.managedBy === 'env').map(c => c.channelType))
  const out: Record<string, string[]> = {}
  for (const m of markets) if (withAccounts.has(m.channel)) out[m.channel] = [...new Set([...(out[m.channel] ?? []), m.code])].sort()
  return out
}

describe('footprintFrom — the rule', () => {
  it('an eBay-only business: eBay and its markets; the other channels are "not connected"', () => {
    const f = footprintFrom([acct('e1', 'EBAY')], MARKETS)
    expect(channelMarkets(f)).toEqual({ EBAY: ['DE', 'IT'] })
    expect(f.markets).toEqual({ DE: ['EBAY'], IT: ['EBAY'] })
    expect(f.notConnected.map(c => c.channel)).toEqual(['AMAZON', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'])
  })
  it('counts an expired token and an env-managed account; ignores a pending placeholder', () => {
    const f = footprintFrom([acct('a1', 'AMAZON', { managedBy: 'env', authStatus: null }), acct('e1', 'EBAY', { authStatus: 'needs_reauth' }), acct('s1', 'SHOPIFY', { managedBy: 'pending' })], MARKETS)
    expect(Object.keys(channelMarkets(f))).toEqual(['AMAZON', 'EBAY'])
  })
  it('leaves out a channel whose accounts are all disconnected (plan: a removed channel is hidden)', () => {
    const f = footprintFrom([acct('e-old', 'EBAY', { isActive: false }), acct('a1', 'AMAZON')], MARKETS)
    expect(Object.keys(channelMarkets(f))).toEqual(['AMAZON'])
    expect(f.notConnected.map(c => c.channel)).toContain('EBAY')
  })
  it('keeps an Amazon market unless Amazon said "not participating"; never-checked, suspended and unknown stay', () => {
    const markets = [mk('AMAZON', 'DE', 'PARTICIPATING'), mk('AMAZON', 'IT', null), mk('AMAZON', 'FR', 'SUSPENDED'), mk('AMAZON', 'ES', 'UNKNOWN'), mk('AMAZON', 'TR', 'NOT_PARTICIPATING'), mk('AMAZON', 'PL', 'ACCESS_DENIED')]
    const f = footprintFrom([acct('a1', 'AMAZON')], markets)
    expect(channelMarkets(f)).toEqual({ AMAZON: ['DE', 'ES', 'FR', 'IT', 'PL'] })
    expect(f.excludedMarkets).toEqual([{ channel: 'AMAZON', market: 'TR', reason: 'not participating' }])
  })
  it('ignores an account of a channel with no switched-on market (for example Amazon Ads)', () => {
    expect(footprintFrom([acct('ads', 'AMAZON_ADS'), acct('e1', 'EBAY')], MARKETS).channels.map(c => c.channel)).toEqual(['EBAY'])
  })
  it('lists the primary account first and orders channels like the scope bar', () => {
    const f = footprintFrom([acct('z', 'EBAY'), acct('b', 'EBAY', { isPrimary: true }), acct('s1', 'SHOPIFY'), acct('a1', 'AMAZON')], MARKETS)
    expect(f.channels.map(c => c.channel)).toEqual(['AMAZON', 'EBAY', 'SHOPIFY'])
    expect(f.channels[1].accounts.map(a => a.id)).toEqual(['b', 'z'])
  })
  it('no account at all: an empty footprint, every channel "not connected"', () => {
    const f = footprintFrom([], MARKETS)
    expect(f.channels).toEqual([])
    expect(f.markets).toEqual({})
    expect(f.notConnected).toHaveLength(5)
  })
})

describe('the same answer as the web scope bar, except the two named differences', () => {
  const cases: Array<[string, FootprintConnection[]]> = [
    ['eBay only', [acct('e1', 'EBAY')]], ['Amazon only', [acct('a1', 'AMAZON')]], ['none', []],
    ['eBay + Etsy (Motovento)', [acct('e1', 'EBAY'), acct('t1', 'ETSY')]],
    ['Amazon + Ads + eBay (one revoked, one live) + Shopify (Xavia Racing)', [acct('a1', 'AMAZON'), acct('ads', 'AMAZON_ADS'), acct('e-old', 'EBAY', { isActive: false }), acct('e1', 'EBAY'), acct('s1', 'SHOPIFY')]],
  ]
  for (const [name, connections] of cases) {
    it(`agrees: ${name}`, () => expect(channelMarkets(footprintFrom(connections, MARKETS))).toEqual(webScopeBar(connections, MARKETS)))
  }
  it('differs 1: a channel with only disconnected accounts is in the bar, not in the footprint', () => {
    const connections = [acct('e-old', 'EBAY', { isActive: false })]
    expect(webScopeBar(connections, MARKETS)).toEqual({ EBAY: ['DE', 'IT'] })
    expect(channelMarkets(footprintFrom(connections, MARKETS))).toEqual({})
  })
  it('differs 2: an Amazon market Amazon reports as not participating is in the bar, not in the footprint', () => {
    const markets = [mk('AMAZON', 'DE', 'PARTICIPATING'), mk('AMAZON', 'TR', 'NOT_PARTICIPATING')]
    expect(webScopeBar([acct('a1', 'AMAZON')], markets)).toEqual({ AMAZON: ['DE', 'TR'] })
    expect(channelMarkets(footprintFrom([acct('a1', 'AMAZON')], markets))).toEqual({ AMAZON: ['DE'] })
  })
})

describe('GET /api/channel-footprint — permission', () => {
  it('reads with "listings view" (like the market list); nothing else on the path is mapped, so a write is refused', () => {
    expect(permissionForRoute('GET', '/api/channel-footprint')).toBe('listings.view')
    expect(permissionForRoute('POST', '/api/channel-footprint')).toBeNull()
    expect(permissionForRoute('GET', '/api/channel-footprint-other')).toBeNull()
  })
})

describe('on PostgreSQL: the four scope fixtures, each business alone', () => {
  let fixtures: Record<ScopeFixtureKey, ScopeFixture>
  beforeAll(async () => { fixtures = await createScopeFixtures(state.db.client) }, 240_000)
  afterAll(async () => { await state.db?.close() }, 30_000)
  const footprintOf = (key: ScopeFixtureKey) => withWorkspace(fixtures[key].context, channelFootprint)

  it.each([['F1', ['EBAY']], ['F2', ['AMAZON']], ['F3', []], ['F4', ['EBAY', 'ETSY']]] as const)('%s has exactly its own connected channels', async (key, expected) => {
    const f = await footprintOf(key)
    expect(f.channels.map(c => c.channel)).toEqual(expected)
    // A connected channel shows its switched-on markets; nothing it did not connect appears.
    for (const c of f.channels) expect(c.markets.length).toBeGreaterThan(0)
    expect(f.notConnected.map(c => c.channel).filter(c => (expected as readonly string[]).includes(c))).toEqual([])
  })

  it('shows only SWITCHED-ON markets: F2\'s Amazon markets are exactly its active Amazon rows', async () => {
    const f2 = await footprintOf('F2')
    const rows = await withWorkspace(fixtures.F2.context, () => state.db.client.marketplace.findMany({ where: { channel: 'AMAZON' }, select: { code: true, isActive: true } }))
    expect(rows.some((r: { isActive: boolean }) => !r.isActive)).toBe(true)                  // the control: a switched-off Amazon market exists
    expect(f2.channels[0].markets).toEqual(rows.filter((r: { isActive: boolean }) => r.isActive).map((r: { code: string }) => r.code).sort())
  })

  it('keeps two businesses apart: F1 sees only its own account, never F2\'s Amazon account', async () => {
    const f1 = await footprintOf('F1')
    const f2 = await footprintOf('F2')
    const ids = (f: typeof f1) => f.channels.flatMap(c => c.accounts.map(a => a.id))
    expect(ids(f1)).toHaveLength(1)
    expect(ids(f2)).toHaveLength(1)
    expect(ids(f1).some(id => ids(f2).includes(id))).toBe(false)
    expect(f1.channels.some(c => c.channel === 'AMAZON')).toBe(false)
  })
})
