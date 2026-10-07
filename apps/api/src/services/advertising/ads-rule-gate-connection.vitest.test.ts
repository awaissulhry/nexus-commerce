/**
 * The graduation gate judges the Amazon Ads connection a rule's writes actually go through.
 *
 * Live case (2026-10-07): the business has nine Amazon Ads profiles — IT, DE, FR, ES production with writes on; UK, NL,
 * PL, SE, BE sandbox. The gate read `amazonAdsConnection.findFirst({ where: { isActive: true } })`, with no market and
 * no order, got a sandbox row, and showed every rule (an IT rule, a DE rule) "mode = sandbox (must be production)" and
 * "writes enabled: false" — so no Amazon ads rule could reach AUTO although IT bids were written live every 6 hours.
 *
 * Proven here on the gate status (the screen), the graduate route and the level dial (Claude's turn-up-automation):
 *   · an IT rule passes the connection checks on the IT profile, even with a sandbox UK row first in the table;
 *   · a rule in a sandbox market fails them;
 *   · a whole-account rule passes when at least one market Nexus reads is production with writes on, and the detail
 *     names the profile it judged and the markets its writes stay refused in;
 *   · a rule with no market but bound to one campaign, a portfolio, a product or its picked campaigns is judged on the
 *     market those campaigns are in (a UK sandbox campaign fails), across its own markets when they are several, and
 *     fails when its scope reaches no campaign.
 *
 * The database is a stub; the resolver (`adsProfileFor`, on its legacy-row path) and the market lists are the real ones.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

interface ConnRow { profileId: string; marketplace: string; isActive: boolean; mode: string; writesEnabledAt: Date | null; region: string; lastWriteAt: Date | null }
const ON = new Date('2026-09-01T08:00:00.000Z')
const row = (marketplace: string, profileId: string, mode: 'production' | 'sandbox', writes: boolean): ConnRow =>
  ({ profileId, marketplace, isActive: true, mode, writesEnabledAt: writes ? ON : null, region: 'EU', lastWriteAt: null })
/** Insertion order = the order a `findFirst` with no `orderBy` returns: the sandbox UK row comes first. */
const NINE: ConnRow[] = [
  row('UK', '1000000000000001', 'sandbox', false),
  row('IT', '3000000000000003', 'production', true),
  row('DE', '2000000000000002', 'production', true),
  row('FR', '4000000000000004', 'production', true),
  row('ES', '5000000000000005', 'production', true),
  row('NL', '6000000000000006', 'sandbox', false),
  row('PL', '7000000000000007', 'sandbox', false),
  row('SE', '8000000000000008', 'sandbox', false),
  row('BE', '9000000000000009', 'sandbox', false),
]
let connections: ConnRow[] = NINE

function matches(r: ConnRow, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v)
}
function ordered(rows: ConnRow[], orderBy?: { profileId?: 'asc' | 'desc' }): ConnRow[] {
  if (!orderBy?.profileId) return rows
  const s = [...rows].sort((a, b) => a.profileId.localeCompare(b.profileId))
  return orderBy.profileId === 'asc' ? s : s.reverse()
}

/** Campaigns, product ads and product lines for the scoped rules (the whole-account rules never read them). */
interface Camp { id: string; marketplace: string | null; portfolioId: string | null; status: string }
const CAMPAIGNS: Camp[] = [
  { id: 'c-it-1', marketplace: 'IT', portfolioId: 'pf-it', status: 'ENABLED' },
  { id: 'c-it-2', marketplace: 'IT', portfolioId: 'pf-it', status: 'ENABLED' },
  { id: 'c-uk-1', marketplace: 'UK', portfolioId: 'pf-uk', status: 'ENABLED' },
  { id: 'c-uk-2', marketplace: 'UK', portfolioId: 'pf-uk', status: 'ENABLED' },
  { id: 'c-de-1', marketplace: 'DE', portfolioId: null, status: 'ENABLED' },
  { id: 'c-nl-1', marketplace: 'NL', portfolioId: null, status: 'ENABLED' },
]
/** `p-line` is a parent: its children `p-a`, `p-b` are advertised in DE only. */
const PRODUCTS = [{ id: 'p-a', parentId: 'p-line' }, { id: 'p-b', parentId: 'p-line' }]
const ADS = [
  { productId: 'p-a', adGroup: { campaignId: 'c-de-1' } },
  { productId: 'p-b', adGroup: { campaignId: 'c-de-1' } },
  { productId: 'p-mixed', adGroup: { campaignId: 'c-it-1' } },
  { productId: 'p-mixed', adGroup: { campaignId: 'c-uk-1' } },
  { productId: 'p-sandbox', adGroup: { campaignId: 'c-uk-2' } },
  { productId: 'p-sandbox', adGroup: { campaignId: 'c-nl-1' } },
]

const db = vi.hoisted(() => ({
  automationRule: { findUnique: vi.fn(), update: vi.fn() },
  campaign: { findMany: vi.fn() },
  adProductAd: { findMany: vi.fn() },
  product: { findMany: vi.fn() },
  campaignRuleAssignment: { findMany: vi.fn(async () => []) },
  amazonAdsConnection: { findFirst: vi.fn(), findMany: vi.fn() },
  adKeywordProtection: { count: vi.fn(async () => 0) },
  advertisingActionLog: { create: vi.fn(async () => ({})), createMany: vi.fn(async () => ({})) },
}))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('@nexus/database', () => ({ Prisma: {} }))

const saved = { resolver: process.env.NEXUS_CX_ADS_RESOLVER, mode: process.env.NEXUS_AMAZON_ADS_MODE }
// The resolver's legacy-row path: the rows below ARE what it reads (the connection-core path is proven in its own tests).
process.env.NEXUS_CX_ADS_RESOLVER = '0'
process.env.NEXUS_AMAZON_ADS_MODE = 'live'
afterAll(() => {
  for (const [k, v] of [['NEXUS_CX_ADS_RESOLVER', saved.resolver], ['NEXUS_AMAZON_ADS_MODE', saved.mode]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const { adsRuleGateStatus, graduateAdsRule, adsRuleLevelRefusal, adsRuleWriteConnection } = await import('./ads-rule-crud.service.js')
const { isRefused } = await import('../automation/service-outcome.js')

const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
/** A rule that has earned the gate on evidence: only its market differs between the cases. */
const rule = (scopeMarketplace: string | null) => ({
  id: `r-${scopeMarketplace ?? 'all'}`, domain: 'advertising', name: `Lower bids ${scopeMarketplace ?? 'all markets'}`,
  enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', createdAt: OLD,
  evaluationCount: 40, matchCount: 6, executionCount: 6, scopeMarketplace,
  actions: [{ type: 'bid_down', target: 'ad_target', percent: 10 }], conditions: [{ field: 'adTarget.acos', op: 'gt', value: 0.5 }],
})
let current = rule('IT')

const check = (checks: { id: string; passed: boolean; detail: string }[], id: string) => checks.find((c) => c.id === id)!
async function gate() {
  const out = await adsRuleGateStatus(current.id)
  if (isRefused(out)) throw new Error(`gate status refused: ${JSON.stringify(out)}`)
  return out.value
}

beforeEach(() => {
  vi.clearAllMocks()
  connections = NINE
  db.automationRule.findUnique.mockImplementation(async () => current)
  db.automationRule.update.mockImplementation(async ({ data }: { data: object }) => ({ ...current, ...data }))
  db.amazonAdsConnection.findFirst.mockImplementation(async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: { profileId?: 'asc' | 'desc' } } = {}) =>
    ordered(connections.filter((r) => matches(r, where)), orderBy)[0] ?? null)
  db.amazonAdsConnection.findMany.mockImplementation(async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: { profileId?: 'asc' | 'desc' } } = {}) =>
    ordered(connections.filter((r) => matches(r, where)), orderBy))
  db.campaign.findMany.mockImplementation(async () => CAMPAIGNS)
  db.adProductAd.findMany.mockImplementation(async ({ where }: { where?: { productId?: { in?: string[] } } } = {}) =>
    ADS.filter((a) => !where?.productId?.in || where.productId.in.includes(a.productId)))
  db.product.findMany.mockImplementation(async ({ where }: { where?: { parentId?: { in?: string[] } } } = {}) =>
    PRODUCTS.filter((p) => where?.parentId?.in?.includes(p.parentId)))
  db.campaignRuleAssignment.findMany.mockImplementation(async () => [])
})

describe('the stub reproduces the bug', () => {
  it('a findFirst on isActive alone answers with the sandbox UK row', async () => {
    expect(await db.amazonAdsConnection.findFirst({ where: { isActive: true } })).toMatchObject({ marketplace: 'UK', mode: 'sandbox' })
  })
})

describe('a rule with a market is judged on that market’s profile', () => {
  it('🔴 an IT rule passes both connection checks on the IT profile, though a sandbox UK row comes first', async () => {
    current = rule('IT')
    const g = await gate()
    expect(check(g.checks, 'CONNECTION_PRODUCTION')).toMatchObject({ passed: true })
    expect(check(g.checks, 'CONNECTION_PRODUCTION').detail).toBe("IT (the rule's market, profile 3000000000000003): AmazonAdsConnection.mode = production")
    expect(check(g.checks, 'WRITES_ENABLED')).toMatchObject({
      passed: true, detail: "IT (the rule's market, profile 3000000000000003): Writes enabled at 2026-09-01T08:00:00.000Z",
    })
    expect(g.gateOpen).toBe(true)
  })

  it('a DE rule is judged on DE', async () => {
    current = rule('DE')
    const g = await gate()
    expect(check(g.checks, 'CONNECTION_PRODUCTION').detail).toContain("DE (the rule's market, profile 2000000000000002)")
    expect(g.gateOpen).toBe(true)
  })

  it('🔴 a rule in a sandbox market fails both connection checks, naming that market', async () => {
    current = rule('UK')
    const g = await gate()
    expect(check(g.checks, 'CONNECTION_PRODUCTION')).toMatchObject({
      passed: false, detail: "UK (the rule's market, profile 1000000000000001): AmazonAdsConnection.mode = sandbox (must be production)",
    })
    expect(check(g.checks, 'WRITES_ENABLED')).toMatchObject({
      passed: false, detail: "UK (the rule's market, profile 1000000000000001): Run /advertising/connection/preview-writes + /enable-writes first",
    })
    expect(g.gateOpen).toBe(false)
  })

  it('a production market whose writes are off fails only the writes check', async () => {
    connections = NINE.map((r) => (r.marketplace === 'FR' ? { ...r, writesEnabledAt: null } : r))
    current = rule('FR')
    const g = await gate()
    expect(check(g.checks, 'CONNECTION_PRODUCTION').passed).toBe(true)
    expect(check(g.checks, 'WRITES_ENABLED').passed).toBe(false)
  })

  it('a market no profile serves fails, and says so', async () => {
    current = rule('JP')
    const g = await gate()
    expect(check(g.checks, 'CONNECTION_PRODUCTION')).toMatchObject({
      passed: false, detail: "No Amazon Ads profile serves JP (the rule's market): AmazonAdsConnection.mode = none (must be production)",
    })
    expect(check(g.checks, 'WRITES_ENABLED').passed).toBe(false)
  })
})

describe('a whole-account rule (no market)', () => {
  it('🔴 passes when at least one market is production with writes on: judged on IT, the refused markets listed', async () => {
    current = rule(null)
    const g = await gate()
    expect(check(g.checks, 'CONNECTION_PRODUCTION')).toMatchObject({
      passed: true,
      detail: 'Whole account, judged on IT, profile 3000000000000003: AmazonAdsConnection.mode = production. ' +
        'Live (production, writes on): IT, DE, ES, FR. Not live, so the write gate refuses this rule\'s writes there: BE, NL, PL, SE, UK',
    })
    expect(check(g.checks, 'WRITES_ENABLED')).toMatchObject({
      passed: true, detail: 'Whole account, judged on IT, profile 3000000000000003: Writes enabled at 2026-09-01T08:00:00.000Z',
    })
    expect(g.gateOpen).toBe(true)
  })

  it('fails when no market is production with writes on (a production market with writes off is the one judged)', async () => {
    connections = NINE.map((r) => (r.mode === 'production' && r.marketplace !== 'DE' ? { ...r, mode: 'sandbox' } : r))
      .map((r) => (r.marketplace === 'DE' ? { ...r, writesEnabledAt: null } : r))
    current = rule(null)
    const g = await gate()
    expect(check(g.checks, 'CONNECTION_PRODUCTION').passed).toBe(true)
    expect(check(g.checks, 'CONNECTION_PRODUCTION').detail).toContain('Whole account, judged on DE')
    expect(check(g.checks, 'CONNECTION_PRODUCTION').detail).toContain('Live (production, writes on): none')
    expect(check(g.checks, 'WRITES_ENABLED').passed).toBe(false)
    expect(g.gateOpen).toBe(false)
  })

  it('fails with every market in sandbox', async () => {
    connections = NINE.map((r) => ({ ...r, mode: 'sandbox', writesEnabledAt: null }))
    current = rule(null)
    const g = await gate()
    expect(check(g.checks, 'CONNECTION_PRODUCTION').passed).toBe(false)
    expect(check(g.checks, 'WRITES_ENABLED').passed).toBe(false)
  })

  it('a market Nexus does not read is never the one judged', async () => {
    connections = NINE.map((r) => (r.mode === 'production' ? { ...r, isActive: false } : r))
    const conn = await adsRuleWriteConnection({ scopeMarketplace: null })
    expect(conn.liveMarkets).toEqual([])
    expect(conn.judged?.mode).toBe('sandbox')
  })

  it('with no connection at all it keeps the words it always had', async () => {
    connections = []
    current = rule(null)
    const g = await gate()
    expect(check(g.checks, 'CONNECTION_PRODUCTION')).toMatchObject({ passed: false, detail: 'AmazonAdsConnection.mode = none (must be production)' })
    expect(check(g.checks, 'WRITES_ENABLED')).toMatchObject({ passed: false, detail: 'Run /advertising/connection/preview-writes + /enable-writes first' })
  })
})

describe('the graduate route and the level dial read the same answer', () => {
  it('🔴 an IT rule graduates to AUTO with a sandbox UK row first', async () => {
    current = rule('IT')
    const out = await graduateAdsRule(current.id, 'user:test')
    expect(out.ok).toBe(true)
    expect(db.automationRule.update).toHaveBeenCalledWith(expect.objectContaining({ data: { dryRun: false, autonomyLevel: 'AUTO' } }))
  })

  it('🔴 a UK rule is refused with the two connection failures', async () => {
    current = rule('UK')
    const out = await graduateAdsRule(current.id, 'user:test')
    expect(out).toMatchObject({ ok: false, status: 409, body: { error: 'gate_not_open', failures: ['CONNECTION_PRODUCTION', 'WRITES_ENABLED'] } })
    expect(db.automationRule.update).not.toHaveBeenCalled()
  })

  it('a whole-account rule graduates while IT, DE, FR, ES are live', async () => {
    current = rule(null)
    expect((await graduateAdsRule(current.id, 'user:test')).ok).toBe(true)
  })

  it('🔴 the level dial (turn-up-automation) lets an IT rule to AUTO and refuses a UK rule', async () => {
    current = rule('IT')
    expect((await adsRuleLevelRefusal(current.id, 'AUTO')).ok).toBe(true)
    current = rule('UK')
    expect(await adsRuleLevelRefusal(current.id, 'AUTO')).toMatchObject({
      ok: false, status: 409, body: { error: 'gate_not_open', failures: ['CONNECTION_PRODUCTION', 'WRITES_ENABLED'] },
    })
  })
})

describe('a rule with no market but a narrower scope is judged on the market its campaigns are in', () => {
  /** The evidence of `rule(null)`, bound below the market. */
  const scoped = (extra: Record<string, unknown>) => ({
    ...rule(null), id: 'r-scoped', scopePortfolioId: null, scopeCampaignId: null, scopeProductId: null, ...extra,
  })

  it('🔴 a rule bound to ONE UK (sandbox) campaign fails both connection checks, judged on UK', async () => {
    current = scoped({ scopeCampaignId: 'c-uk-1' })
    const g = await gate()
    expect(check(g.checks, 'CONNECTION_PRODUCTION')).toMatchObject({
      passed: false,
      detail: "UK (the market of the rule's campaign, profile 1000000000000001): AmazonAdsConnection.mode = sandbox (must be production)",
    })
    expect(check(g.checks, 'WRITES_ENABLED')).toMatchObject({
      passed: false,
      detail: "UK (the market of the rule's campaign, profile 1000000000000001): Run /advertising/connection/preview-writes + /enable-writes first",
    })
    expect(g.gateOpen).toBe(false)
  })

  it('🔴 the graduate route and the level dial refuse it too', async () => {
    current = scoped({ scopeCampaignId: 'c-uk-1' })
    expect(await graduateAdsRule(current.id, 'user:test')).toMatchObject({
      ok: false, status: 409, body: { error: 'gate_not_open', failures: ['CONNECTION_PRODUCTION', 'WRITES_ENABLED'] },
    })
    expect(await adsRuleLevelRefusal(current.id, 'AUTO')).toMatchObject({
      ok: false, status: 409, body: { error: 'gate_not_open', failures: ['CONNECTION_PRODUCTION', 'WRITES_ENABLED'] },
    })
    expect(db.automationRule.update).not.toHaveBeenCalled()
  })

  it('a rule bound to one IT campaign passes on the IT profile and graduates', async () => {
    current = scoped({ scopeCampaignId: 'c-it-2' })
    const g = await gate()
    expect(check(g.checks, 'CONNECTION_PRODUCTION').detail)
      .toBe("IT (the market of the rule's campaign, profile 3000000000000003): AmazonAdsConnection.mode = production")
    expect(g.gateOpen).toBe(true)
    expect((await graduateAdsRule(current.id, 'user:test')).ok).toBe(true)
  })

  it('a portfolio whose campaigns are all in UK is judged on UK', async () => {
    current = scoped({ scopePortfolioId: 'pf-uk' })
    const g = await gate()
    expect(check(g.checks, 'CONNECTION_PRODUCTION')).toMatchObject({ passed: false })
    expect(check(g.checks, 'CONNECTION_PRODUCTION').detail).toContain("UK (the market of the rule's portfolio, profile 1000000000000001)")
  })

  it('a product line (a parent, its children advertised in DE only) is judged on DE', async () => {
    current = scoped({ scopeProductId: 'p-line' })
    const conn = await adsRuleWriteConnection(current)
    expect(conn).toMatchObject({ market: 'DE', scope: { words: 'product', campaigns: 1, markets: ['DE'], derived: true } })
    expect((await gate()).gateOpen).toBe(true)
  })

  it('a product in IT and UK is judged across those two only: passes on IT, UK named as refused, no other market listed', async () => {
    current = scoped({ scopeProductId: 'p-mixed' })
    const g = await gate()
    expect(check(g.checks, 'CONNECTION_PRODUCTION')).toMatchObject({
      passed: true,
      detail: "The rule's scope (product) reaches 2 campaigns in IT, UK, judged on IT, profile 3000000000000003: " +
        'AmazonAdsConnection.mode = production. Live (production, writes on): IT. ' +
        "Not live, so the write gate refuses this rule's writes there: UK",
    })
  })

  it('🔴 a product only in sandbox markets (UK, NL) fails, though IT, DE, FR, ES are live elsewhere in the account', async () => {
    current = scoped({ scopeProductId: 'p-sandbox' })
    const g = await gate()
    expect(check(g.checks, 'CONNECTION_PRODUCTION').passed).toBe(false)
    expect(check(g.checks, 'CONNECTION_PRODUCTION').detail).toContain('Live (production, writes on): none')
    expect(check(g.checks, 'WRITES_ENABLED').passed).toBe(false)
    expect(g.gateOpen).toBe(false)
  })

  it('🔴 a builder rule whose picker holds only UK campaigns is judged on UK', async () => {
    current = scoped({ actions: [{ type: 'bid', campaigns: [{ id: 'c-uk-1' }, { id: 'c-uk-2' }] }] })
    const conn = await adsRuleWriteConnection(current)
    expect(conn).toMatchObject({ market: 'UK', scope: { words: 'picked campaigns', campaigns: 2, derived: true } })
    expect(check((await gate()).checks, 'CONNECTION_PRODUCTION').passed).toBe(false)
  })

  it('a scope that reaches no campaign fails both checks and says no market can be judged', async () => {
    current = scoped({ scopeProductId: 'p-not-advertised' })
    const g = await gate()
    expect(check(g.checks, 'CONNECTION_PRODUCTION')).toMatchObject({
      passed: false,
      detail: "The rule's scope (product) reaches no campaign today, so no market's connection can be judged: AmazonAdsConnection.mode = none (must be production)",
    })
    expect(check(g.checks, 'WRITES_ENABLED').passed).toBe(false)
  })

  it('a market on the rule wins over its scope (the scope is not read)', async () => {
    current = { ...scoped({ scopeCampaignId: 'c-uk-1' }), scopeMarketplace: 'IT' }
    expect((await adsRuleWriteConnection(current)).judged?.market).toBe('IT')
    expect(db.campaign.findMany).not.toHaveBeenCalled()
  })

  it('a whole-account rule reads no campaign at all', async () => {
    current = rule(null)
    await gate()
    expect(db.campaign.findMany).not.toHaveBeenCalled()
    expect(db.adProductAd.findMany).not.toHaveBeenCalled()
  })
})
