/**
 * Ads wave 4c (F3) — the one list of Amazon Ads markets, and the one profile per market (CM-29 / CC-30).
 *
 * The Owner's rule: Nexus READS every account he switches on and SPENDS only where the write gate lets a write through.
 * The fixture is today's account plus one more market: IT, DE, FR and ES production with writes on, and UK switched
 * on for reading in sandbox mode. UK's data must show, UK's writes must be refused with the reason, and the four must
 * come out exactly as before.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const rows: Array<Record<string, unknown>> = []
const scopes: Array<Record<string, unknown>> = []
const connections: Array<Record<string, unknown>> = [{ id: 'conn_ads', channelType: 'AMAZON_ADS', isActive: true, isPrimary: true }]

const prismaMock = {
  channelConnection: {
    findMany: vi.fn(async () => connections),
    findFirst: vi.fn(async () => connections[0] ?? null),
  },
  connectionScope: {
    findMany: vi.fn(async () => scopes),
    findFirst: vi.fn(async () => null),
  },
  amazonAdsConnection: {
    findMany: vi.fn(async () => rows),
    findFirst: vi.fn(async ({ where }: { where: { marketplace: string } }) =>
      rows.filter((r) => r.marketplace === where.marketplace && r.isActive)
        .sort((a, b) => String(a.profileId).localeCompare(String(b.profileId)))[0] ?? null),
    findUnique: vi.fn(async ({ where }: { where: { workspace_profileId: { profileId: string } } }) =>
      rows.find((r) => r.profileId === where.workspace_profileId.profileId) ?? null),
  },
  amazonAdsProfile: { findUnique: vi.fn(async () => null) },
}
vi.mock('../../db.js', () => ({ default: prismaMock }))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./ads-api-client.js', () => ({ adsMode: () => 'live' }))
vi.mock('./ads-automation-state.service.js', () => ({
  getAutomationState: async () => ({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false }),
}))

const { adsMarketLists, adsMarketListsOf, adsReadMarkets, marketParamRefusal, READING_ONLY_REASON } = await import('./ads-markets.service.js')
const { adsProfileFor, adsClientContextFor, adsProfilesForMarkets, __adsResolverTest } = await import('./ads-profile-resolver.js')

const ON = new Date('2026-08-01T00:00:00Z')

function account(profileId: string, marketplace: string, mode: string, writes: boolean, isActive = true) {
  rows.push({ profileId, marketplace, isActive, mode, writesEnabledAt: writes ? ON : null, region: 'EU', lastWriteAt: null })
  scopes.push({ externalId: profileId, region: 'EU', metadata: { marketplace, mode, writesEnabledAt: writes ? ON.toISOString() : null } })
}

beforeEach(() => {
  rows.length = 0
  scopes.length = 0
  __adsResolverTest.clearConnectionCache()
  delete process.env.NEXUS_CX_ADS_RESOLVER
  // Ids are made up for the test; the four live markets, then UK reading only.
  account('p-it', 'IT', 'production', true)
  account('p-de', 'DE', 'production', true)
  account('p-fr', 'FR', 'production', true)
  account('p-es', 'ES', 'production', true)
  account('p-uk', 'UK', 'sandbox', false)
})

describe('the market lists come from the connections', () => {
  it('🔴 IT/DE/FR/ES production + UK reading only: UK is read, the four are read and written', async () => {
    const lists = await adsMarketLists()
    // The Owner's order: the live four as the console always listed them, then the reading-only market.
    expect(lists.read).toEqual(['IT', 'DE', 'ES', 'FR', 'UK'])
    expect(lists.write).toEqual(['IT', 'DE', 'ES', 'FR'])
    const uk = lists.markets.find((m) => m.code === 'UK')!
    expect(uk).toMatchObject({ read: true, write: false, state: 'reading_only', mode: 'sandbox', writesEnabled: false })
    expect(uk.whyNoWrite).toContain(READING_ONLY_REASON)
    const it = lists.markets.find((m) => m.code === 'IT')!
    expect(it).toMatchObject({ read: true, write: true, state: 'live_writes_on', limitsKnown: true, currency: 'EUR', whyNoWrite: null })
  })

  it('with today\'s four accounts only, the lists are exactly the four', async () => {
    rows.splice(rows.findIndex((r) => r.marketplace === 'UK'), 1)
    const lists = await adsMarketLists()
    expect(lists.read).toEqual(['IT', 'DE', 'ES', 'FR'])
    expect(lists.write).toEqual(['IT', 'DE', 'ES', 'FR'])
    expect(await adsReadMarkets()).toEqual(['IT', 'DE', 'ES', 'FR'])
  })

  it('an account switched off is not read, and not written even with writes on', () => {
    const lists = adsMarketListsOf(
      [{ profileId: 'p-nl', marketplace: 'NL', isActive: false, mode: 'production', writesEnabledAt: ON }],
      new Map([['NL', { mode: 'production', writesEnabledAt: ON }]]),
    )
    expect(lists.read).toEqual([])
    expect(lists.write).toEqual([])
    expect(lists.markets[0].whyNoWrite).toMatch(/does not read the NL Amazon Ads account/)
  })

  it('production with writes on but no known Amazon limits: read, writes refused with "not known yet"', () => {
    const lists = adsMarketListsOf(
      [{ profileId: 'p-se', marketplace: 'SE', isActive: true, mode: 'production', writesEnabledAt: ON }],
      new Map([['SE', { mode: 'production', writesEnabledAt: ON }]]),
    )
    expect(lists.read).toEqual(['SE'])
    expect(lists.write).toEqual([])
    expect(lists.markets[0].whyNoWrite).toBe(`${READING_ONLY_REASON}: Amazon's bid and budget limits for SE are not known yet.`)
  })

  it('an Amazon marketplace id on a row reads as its two-letter market, once', () => {
    const lists = adsMarketListsOf(
      [
        { profileId: 'a', marketplace: 'APJ6JRA9NG5V4', isActive: true, mode: 'production', writesEnabledAt: ON },
        { profileId: 'b', marketplace: 'IT', isActive: true, mode: 'production', writesEnabledAt: ON },
      ],
      new Map([['IT', { mode: 'production', writesEnabledAt: ON }]]),
    )
    expect(lists.read).toEqual(['IT'])
  })

  it('🔴 order: writable markets first (IT, DE, ES, FR, then any other writable one), then reading-only alphabetically', () => {
    const on = { mode: 'production', writesEnabledAt: ON }
    const row = (code: string, isActive = true) => ({ profileId: `p-${code}`, marketplace: code, isActive, mode: 'production', writesEnabledAt: ON })
    const lists = adsMarketListsOf(
      [row('UK'), row('SE'), row('FR'), row('BE'), row('ES'), row('DE'), row('IT'), row('NL', false)],
      new Map([['IT', on], ['DE', on], ['ES', on], ['FR', on], ['UK', { mode: 'sandbox', writesEnabledAt: null }], ['SE', { mode: 'sandbox', writesEnabledAt: null }], ['BE', { mode: 'sandbox', writesEnabledAt: null }]]),
    )
    expect(lists.markets.map((m) => m.code)).toEqual(['IT', 'DE', 'ES', 'FR', 'BE', 'SE', 'UK', 'NL'])
    expect(lists.read).toEqual(['IT', 'DE', 'ES', 'FR', 'BE', 'SE', 'UK'])
  })

  it('a `?market=` is checked against the read list', () => {
    const read = ['DE', 'ES', 'FR', 'IT', 'UK']
    expect(marketParamRefusal('UK', read, { allowAll: false })).toBeNull()
    expect(marketParamRefusal('all', read, { allowAll: true })).toBeNull()
    expect(marketParamRefusal('all', read, { allowAll: false })).toMatch(/must be one of DE\/ES\/FR\/IT\/UK/)
    expect(marketParamRefusal('PL', read, { allowAll: true })).toBe('market must be one of DE/ES/FR/IT/UK or "all"')
  })
})

describe('the write gate refuses UK with the reason; IT is unchanged', () => {
  it('🔴 UK reading only: refused at the connection; IT allowed with its own profile', async () => {
    const { checkAdsWriteGate } = await import('./ads-write-gate.js')
    const uk = await checkAdsWriteGate({ marketplace: 'UK', payloadValueCents: 50 })
    expect(uk).toEqual({ allowed: false, deniedAt: 'connection', reason: 'Amazon Ads connection mode=sandbox (needs production)' })
    const it = await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 50 })
    expect(it).toEqual({ allowed: true, mode: 'live', profileId: 'p-it' })
  })
})

describe('CM-29 / CC-30 — one profile per market, whoever asks', () => {
  it('🔴 two profiles for one market: the gate, a create and the market list pick the same one, in any row order', async () => {
    // A second Italian profile whose scope comes back FIRST from the database.
    scopes.unshift({ externalId: 'p-it-0', region: 'EU', metadata: { marketplace: 'IT', mode: 'sandbox', writesEnabledAt: null } })
    scopes.push({ externalId: 'p-it-z', region: 'EU', metadata: { marketplace: 'IT', mode: 'production', writesEnabledAt: ON.toISOString() } })
    const gateRef = await adsProfileFor('IT')
    const createCtx = await adsClientContextFor('IT')
    const listed = (await adsProfilesForMarkets(['IT'])).get('IT')
    expect(gateRef?.profileId).toBe('p-it')
    expect(createCtx).toEqual({ profileId: 'p-it', region: 'EU' })
    expect(listed?.profileId).toBe('p-it')
    scopes.reverse()
    __adsResolverTest.clearConnectionCache()
    expect((await adsProfileFor('IT'))?.profileId).toBe('p-it')
  })

  it('🔴 CC-30 — a live negative goes to the profile the gate approved, never to one the caller named', async () => {
    const { __negativeKwTest } = await import('./ads-negative-kw.service.js')
    expect(await __negativeKwTest.clientContext('IT', 'p-it', 'p-other')).toEqual({ profileId: 'p-it', region: 'EU' })
    // Not live (sandbox deploy): the caller's id, else the market's profile from the same resolver.
    expect(await __negativeKwTest.clientContext('IT', null, null)).toEqual({ profileId: 'p-it', region: 'EU' })
  })

  it('a market no profile serves has no context (a refusal upstream, never a guess)', async () => {
    expect(await adsClientContextFor('PL')).toBeNull()
  })
})

describe('🔴 guard — no fixed market list and no second profile resolver in the ads code', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = join(here, '..', '..')
  const read = (rel: string) => readFileSync(join(src, rel), 'utf8')

  it('the ten API files that carried IT/DE/ES/FR read the connections instead', () => {
    const files = [
      'services/advertising/bid-grid.service.ts',
      'services/advertising/budget-grid.service.ts',
      'services/advertising/negatives.service.ts',
      'services/advertising/placement-grid.service.ts',
      'services/advertising/share-of-voice.service.ts',
      'services/advertising/keyword-tracker.service.ts',
      'services/advertising/keyword-watchlist.service.ts',
      'services/advertising/keyword-harvest.service.ts',
      'services/advertising/ads-reporting-views.service.ts',
      'routes/keyword-actions.routes.ts',
      'routes/advertising-intel.routes.ts',
    ]
    const fixedList = /\[\s*'(IT|DE|ES|FR)'\s*,\s*'(IT|DE|ES|FR)'\s*,\s*'(IT|DE|ES|FR)'\s*,\s*'(IT|DE|ES|FR)'\s*\]|new Set\(\[\s*'all'\s*,\s*'IT'/
    for (const f of files) expect(read(f), f).not.toMatch(fixedList)
  })

  it('creates, negatives, settings refreshes and read-backs ask the gate\'s resolver, not AmazonAdsConnection by market', () => {
    const files = [
      'services/advertising/ads-create.service.ts',
      'services/advertising/ads-negative-kw.service.ts',
      'services/advertising/ads-campaign-settings-sync.service.ts',
      'services/advertising/ads-launch-verify.service.ts',
      'services/advertising/ads-eligibility.service.ts',
      'services/advertising/automation-action-handlers.ts',
      'routes/advertising.routes.ts',
    ]
    const byMarket = /amazonAdsConnection\.findFirst\(\{\s*where:\s*\{\s*marketplace/
    for (const f of files) expect(read(f), f).not.toMatch(byMarket)
  })
})
