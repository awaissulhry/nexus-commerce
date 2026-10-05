/**
 * Ads wave 4a — "Read this market's data" switches reading and nothing else, and a "reading only" account can never
 * spend: the write gate refuses every write for it, whichever resolver path answers (the connection core's scope, or
 * the legacy row).
 *
 * Runs the real service, the real resolver and the real write gate against an in-memory store, with the deploy in LIVE
 * mode — the mode production is in, where a wrong permission would reach Amazon.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = { profileId: string; marketplace: string; region: string; isActive: boolean; mode: string; writesEnabledAt: Date | null; lastWriteAt: Date | null }
const rows: Row[] = []
const scopes: Array<{ externalId: string; region: string; metadata: Record<string, unknown> }> = []
const updates: Array<{ profileId: string; data: Record<string, unknown> }> = []

const pick = (row: Row, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, (row as Record<string, unknown>)[k]])) : { ...row }
const byProfile = (where: { workspace_profileId: { profileId: string } }) => rows.find((r) => r.profileId === where.workspace_profileId.profileId)

const prismaMock = {
  channelConnection: {
    findMany: vi.fn(async () => [{ id: 'conn_ads', channelType: 'AMAZON_ADS', isActive: true, isPrimary: true }]),
    findFirst: vi.fn(async () => ({ id: 'conn_ads', channelType: 'AMAZON_ADS', isActive: true, isPrimary: true })),
  },
  connectionScope: {
    findMany: vi.fn(async () => scopes),
    findUnique: vi.fn(async () => null),
    update: vi.fn(async () => ({})),
  },
  amazonAdsConnection: {
    findUnique: vi.fn(async ({ where, select }: { where: { workspace_profileId: { profileId: string } }; select?: Record<string, boolean> }) => {
      const row = byProfile(where)
      return row ? pick(row, select) : null
    }),
    findFirst: vi.fn(async ({ where }: { where: { marketplace: string; isActive?: boolean } }) =>
      rows.find((r) => r.marketplace === where.marketplace && (where.isActive === undefined || r.isActive === where.isActive)) ?? null),
    findMany: vi.fn(async () => rows.map((r) => ({ ...r }))),
    update: vi.fn(async ({ where, data, select }: { where: { workspace_profileId: { profileId: string } }; data: Record<string, unknown>; select?: Record<string, boolean> }) => {
      const row = byProfile(where)
      if (!row) throw new Error('not found')
      updates.push({ profileId: row.profileId, data })
      Object.assign(row, data)
      return pick(row, select)
    }),
  },
  campaign: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
  adKeywordProtection: { findMany: vi.fn(async () => []) },
  adSpendCeiling: { findMany: vi.fn(async () => []) },
  adBidPolicy: { findMany: vi.fn(async () => []) },
  advertisingActionLog: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
  adProductAd: { findMany: vi.fn(async () => []) },
  adWriteRefusal: { create: vi.fn(async () => ({})) },
}
vi.mock('../../db.js', () => ({ default: prismaMock }))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./ads-api-client.js', () => ({ adsMode: () => 'live' }))
vi.mock('./ads-automation-state.service.js', () => ({
  getAutomationState: async () => ({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false }),
}))

const { setAdsProfileReading, adsAccountStateOf, adsAccountStatesByProfile, ADS_ACCOUNT_STATE_LABEL } = await import('./ads-read-switch.service.js')
const { checkAdsWriteGate } = await import('./ads-write-gate.js')
const { __adsResolverTest, adsProfileFor } = await import('./ads-profile-resolver.js')

const WRITES_ON = new Date('2026-08-29T00:00:00Z')
const row = (over: Partial<Row>): Row => ({ profileId: 'p', marketplace: 'IT', region: 'EU', isActive: false, mode: 'sandbox', writesEnabledAt: null, lastWriteAt: null, ...over })

beforeEach(() => {
  rows.length = 0
  scopes.length = 0
  updates.length = 0
  delete process.env.NEXUS_CX_ADS_RESOLVER
  __adsResolverTest.clearConnectionCache()
  rows.push(
    row({ profileId: 'p-us', marketplace: 'US', region: 'NA' }), // created by the reconcile: off + sandbox
    row({ profileId: 'p-uk', marketplace: 'UK', isActive: true }), // read today, sandbox
    row({ profileId: 'p-it', marketplace: 'IT', isActive: true, mode: 'production', writesEnabledAt: WRITES_ON }), // live
  )
})

describe('the state of an account', () => {
  it.each([
    [null, 'not_read'],
    [{ isActive: false, mode: 'production', writesEnabledAt: WRITES_ON }, 'not_read'],
    [{ isActive: true, mode: 'sandbox', writesEnabledAt: null }, 'reading_only'],
    [{ isActive: true, mode: 'production', writesEnabledAt: null }, 'reading_only'],
    [{ isActive: true, mode: 'sandbox', writesEnabledAt: WRITES_ON }, 'reading_only'],
    [{ isActive: true, mode: 'production', writesEnabledAt: WRITES_ON }, 'live_writes_on'],
  ] as const)('%o → %s', (fields, state) => {
    expect(adsAccountStateOf(fields)).toBe(state)
  })

  it('uses the words the screens show', () => {
    expect(ADS_ACCOUNT_STATE_LABEL).toEqual({ live_writes_on: 'Live · writes on', reading_only: 'Reading only', not_read: 'Not read' })
  })

  it('maps every account by profile id', async () => {
    expect(Object.fromEntries(await adsAccountStatesByProfile())).toEqual({ 'p-us': 'not_read', 'p-uk': 'reading_only', 'p-it': 'live_writes_on' })
  })
})

describe('switching reading on and off', () => {
  it('one press is one switch: the route keeps durable Idempotency-Key receipts', async () => {
    const { COMMAND_SCOPE_ROUTES } = await import('../../lib/command-idempotency.js')
    expect(COMMAND_SCOPE_ROUTES).toContain('/api/advertising/connection/set-active')
  })

  it('"Read this market\'s data" writes isActive and NOTHING else', async () => {
    const out = await setAdsProfileReading({ profileId: 'p-us', isActive: true }, 'user:owner')
    expect(out).toMatchObject({ ok: true, changed: true, connection: { profileId: 'p-us', isActive: true, mode: 'sandbox', writesEnabledAt: null, state: 'reading_only' } })
    expect(updates).toEqual([{ profileId: 'p-us', data: { isActive: true } }])
  })

  it('"Stop reading" writes isActive and nothing else', async () => {
    const out = await setAdsProfileReading({ profileId: 'p-uk', isActive: false }, 'user:owner')
    expect(out).toMatchObject({ ok: true, changed: true, connection: { isActive: false, state: 'not_read' } })
    expect(updates).toEqual([{ profileId: 'p-uk', data: { isActive: false } }])
  })

  it('asking for the state it is already in changes nothing', async () => {
    expect(await setAdsProfileReading({ profileId: 'p-uk', isActive: true }, 'user:owner')).toMatchObject({ ok: true, changed: false })
    expect(updates).toEqual([])
  })

  it('refuses to stop reading while writes are on, and changes nothing', async () => {
    const out = await setAdsProfileReading({ profileId: 'p-it', isActive: false }, 'user:owner')
    expect(out).toEqual({ ok: false, status: 409, error: 'writes_enabled', message: 'Writes are on for IT. Turn writes off first (Disable writes), then stop reading.' })
    expect(updates).toEqual([])
    expect(rows.find((r) => r.profileId === 'p-it')?.isActive).toBe(true)
  })

  it('an unknown account is a 404, a malformed request a 400', async () => {
    expect(await setAdsProfileReading({ profileId: 'nope', isActive: true }, 'user:owner')).toMatchObject({ ok: false, status: 404 })
    for (const bad of [{}, { profileId: 'p-us' }, { profileId: 'p-us', isActive: 'true' }, { profileId: ' ', isActive: true }, { profileId: 7, isActive: true }]) {
      expect(await setAdsProfileReading(bad, 'user:owner')).toMatchObject({ ok: false, status: 400 })
    }
    expect(updates).toEqual([])
  })
})

describe('🔴 a "reading only" account can never spend — the write gate refuses every write (deploy in LIVE mode)', () => {
  const WRITES = [
    { field: 'bid', payloadValueCents: 50, campaignId: 'c1', intendedValueCents: 50 },
    { field: 'dailyBudget', payloadValueCents: 500, campaignId: 'c1', intendedValueCents: 500 },
    { field: 'state', payloadValueCents: 0, campaignId: 'c1' },
    // A creation flow (no campaign to allowlist yet) is refused too.
    { field: null, payloadValueCents: 1000 },
  ]

  for (const resolver of ['scope', 'row'] as const) {
    it(`after "Read this market's data" (${resolver} path): refused at the connection, for a euro and a non-euro market`, async () => {
      if (resolver === 'row') process.env.NEXUS_CX_ADS_RESOLVER = '0'
      // The scope the heartbeat keeps for each profile: channel facts only, no recorded decision → the row decides.
      scopes.push({ externalId: 'p-us', region: 'NA', metadata: { marketplace: 'US', currencyCode: 'USD' } })
      rows.push(row({ profileId: 'p-de', marketplace: 'DE' }))
      scopes.push({ externalId: 'p-de', region: 'EU', metadata: { marketplace: 'DE', currencyCode: 'EUR' } })

      for (const profileId of ['p-us', 'p-de']) expect(await setAdsProfileReading({ profileId, isActive: true }, 'user:owner')).toMatchObject({ ok: true })
      // The path under test really answered (a failing core falls back to the row silently).
      expect((await adsProfileFor('US'))?.source).toBe(resolver)
      for (const marketplace of ['US', 'DE']) {
        for (const w of WRITES) {
          const decision = await checkAdsWriteGate({ marketplace, ...w })
          expect(decision, `${marketplace} ${w.field}`).toEqual({ allowed: false, deniedAt: 'connection', reason: 'Amazon Ads connection mode=sandbox (needs production)' })
        }
      }
    })
  }

  it('a production account that is read but has writes off is refused at writes (Promote alone never spends)', async () => {
    rows.push(row({ profileId: 'p-fr', marketplace: 'FR', isActive: true, mode: 'production' }))
    for (const w of WRITES) {
      expect(await checkAdsWriteGate({ marketplace: 'FR', ...w })).toMatchObject({ allowed: false, deniedAt: 'connection_writes' })
    }
  })

  it('control: the live account with writes on is not refused at the connection', async () => {
    const decision = await checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 1000 })
    expect(decision).toEqual({ allowed: true, mode: 'live', profileId: 'p-it' })
  })
})
