/**
 * CX.3b — the Ads profile resolver.
 *
 * The dangerous field here is not `profileId`; it is `writesEnabledAt`. The write gate
 * turns it into permission to spend real money, so these tests are mostly about the
 * resolver never inventing that permission — from a stale snapshot, from a missing
 * value, or from a market it matched loosely.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const scopes: Array<Record<string, unknown>> = []
const rows: Array<Record<string, unknown>> = []
const connections: Array<Record<string, unknown>> = []
const scopeUpdates: Array<{ where: unknown; data: Record<string, unknown> }> = []
let scopeFindThrows: Error | null = null

const prismaMock = {
  channelConnection: {
    // The resolver reaches the connection through the MAP.3 resolver (declared, not
    // ambient), which lists the channel's active connections.
    findMany: vi.fn(async () => connections),
    findFirst: vi.fn(async () => connections[0] ?? null),
  },
  connectionScope: {
    findMany: vi.fn(async () => {
      if (scopeFindThrows) throw scopeFindThrows
      return scopes
    }),
    findUnique: vi.fn(async ({ where }: { where: { connectionId_kind_externalId: { externalId: string } } }) =>
      scopes.find((s) => s.externalId === where.connectionId_kind_externalId.externalId) ?? null),
    update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
      scopeUpdates.push(args)
      return args
    }),
  },
  amazonAdsConnection: {
    findFirst: vi.fn(async ({ where }: { where: { marketplace: string } }) =>
      rows.find((r) => r.marketplace === where.marketplace && r.isActive) ?? null),
    findUnique: vi.fn(async ({ where }: { where: { profileId: string } }) =>
      rows.find((r) => r.profileId === where.profileId) ?? null),
    findMany: vi.fn(async () => rows.filter((r) => r.isActive)),
  },
}
vi.mock('../../db.js', () => ({ default: prismaMock }))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { adsProfileFor, listAdsProfiles, recordOperatorDecision, __adsResolverTest } = await import('./ads-profile-resolver.js')

const ENABLED = new Date('2026-08-01T00:00:00Z')

beforeEach(() => {
  scopes.length = 0
  rows.length = 0
  connections.length = 0
  scopeUpdates.length = 0
  scopeFindThrows = null
  delete process.env.NEXUS_CX_ADS_RESOLVER
  connections.push({ id: 'conn_ads', channelType: 'AMAZON_ADS', isActive: true, isPrimary: true })
  __adsResolverTest.clearConnectionCache()
  scopes.push({
    externalId: '111',
    region: 'EU',
    metadata: { marketplace: 'IT', mode: 'production', writesEnabledAt: ENABLED.toISOString() },
  })
  rows.push({
    profileId: '111',
    region: 'EU',
    mode: 'production',
    writesEnabledAt: ENABLED,
    lastWriteAt: null,
    marketplace: 'IT',
    isActive: true,
  })
})

describe('adsProfileFor', () => {
  it('answers from the connection core and says so', async () => {
    const ref = await adsProfileFor('IT')
    expect(ref).toMatchObject({ profileId: '111', region: 'EU', mode: 'production', source: 'scope', connectionId: 'conn_ads' })
    expect(ref?.writesEnabledAt?.toISOString()).toBe(ENABLED.toISOString())
  })

  it('agrees with the legacy row on every field the write gate reads', async () => {
    const scoped = await adsProfileFor('IT')
    process.env.NEXUS_CX_ADS_RESOLVER = '0'
    const legacy = await adsProfileFor('IT')
    expect(legacy?.source).toBe('row')
    // The gate reads exactly these three. If they ever disagree, the conversion is
    // not a refactor — it is a change to who may spend money.
    expect(scoped?.profileId).toBe(legacy?.profileId)
    expect(scoped?.mode).toBe(legacy?.mode)
    expect(scoped?.writesEnabledAt?.toISOString()).toBe(legacy?.writesEnabledAt?.toISOString())
  })

  it('matches a market id against a market code through the canonical map', async () => {
    // The legacy column holds both shapes (the HB.8 sweep), and a caller may pass
    // either. Raw string comparison would resolve nothing for half the markets.
    scopes[0].metadata = { marketplace: 'APJ6JRA9NG5V4', mode: 'production', writesEnabledAt: ENABLED.toISOString() }
    expect((await adsProfileFor('IT'))?.profileId).toBe('111')
  })

  it('asks the row when the scope has recorded no decision — degrade to CORRECT, not to refusal', async () => {
    // Prod, 2026-08-29: heartbeats that ran before the metadata-merge fix erased the
    // seeded mode/writesEnabledAt. Defaulting to sandbox here would have made the gate
    // refuse every market and stopped Ads automation outright.
    scopes[0].metadata = { marketplace: 'IT', currencyCode: 'EUR' }
    const ref = await adsProfileFor('IT')
    expect(ref?.source).toBe('scope')
    expect(ref?.mode).toBe('production')
    expect(ref?.writesEnabledAt?.toISOString()).toBe(ENABLED.toISOString())
  })

  it('and only then falls to sandbox — when neither the scope nor a row records one', async () => {
    scopes[0].metadata = { marketplace: 'IT' }
    rows.length = 0
    const ref = await adsProfileFor('IT')
    expect(ref?.mode).toBe('sandbox')
    expect(ref?.writesEnabledAt).toBeNull()
  })

  it('never invents a profile for an unknown market', async () => {
    await expect(adsProfileFor('ZZ')).resolves.toBeNull()
    await expect(adsProfileFor(null)).resolves.toBeNull()
    await expect(adsProfileFor('')).resolves.toBeNull()
  })

  it('falls back to the row when the core has no scope for the market', async () => {
    scopes.length = 0
    rows.push({ profileId: '222', region: 'NA', mode: 'sandbox', writesEnabledAt: null, lastWriteAt: null, marketplace: 'US', isActive: true })
    expect(await adsProfileFor('US')).toMatchObject({ profileId: '222', source: 'row' })
  })

  it('falls back — and does not throw — when the core lookup fails', async () => {
    scopeFindThrows = new Error('connection refused')
    expect(await adsProfileFor('IT')).toMatchObject({ profileId: '111', source: 'row' })
  })

  it('NEXUS_CX_ADS_RESOLVER=0 is the revert, and only that exact value', async () => {
    process.env.NEXUS_CX_ADS_RESOLVER = '0'
    expect((await adsProfileFor('IT'))?.source).toBe('row')
    process.env.NEXUS_CX_ADS_RESOLVER = 'false'
    expect((await adsProfileFor('IT'))?.source).toBe('scope')
  })
})

describe('listAdsProfiles', () => {
  it('returns every profile, and can narrow to the ones cleared for production', async () => {
    scopes.push({ externalId: '333', region: 'NA', metadata: { marketplace: 'US', mode: 'sandbox' } })
    expect(await listAdsProfiles()).toHaveLength(2)
    const live = await listAdsProfiles({ activeOnly: true })
    expect(live).toHaveLength(1)
    expect(live[0].profileId).toBe('111')
  })
})

describe('recordOperatorDecision', () => {
  it('MERGES — the channel facts discovery wrote must survive an operator decision', async () => {
    scopes[0].metadata = { marketplace: 'IT', currencyCode: 'EUR', mode: 'sandbox', accountId: 'ENTITY1' }
    await recordOperatorDecision('111', { mode: 'production', writesEnabledAt: ENABLED })
    const data = scopeUpdates.at(-1)!.data as { metadata: Record<string, unknown>; isActive: boolean }
    expect(data.metadata).toMatchObject({
      marketplace: 'IT',
      currencyCode: 'EUR',
      accountId: 'ENTITY1',
      mode: 'production',
      writesEnabledAt: ENABLED.toISOString(),
    })
    expect(data.isActive).toBe(true)
  })

  it('writes a null through — disabling must reach the gate, it is the direction that costs money', async () => {
    await recordOperatorDecision('111', { writesEnabledAt: null })
    const data = scopeUpdates.at(-1)!.data as { metadata: Record<string, unknown> }
    expect(data.metadata.writesEnabledAt).toBeNull()
  })

  it('does not throw when the scope is missing — the operator action must still succeed', async () => {
    scopes.length = 0
    await expect(recordOperatorDecision('nope', { mode: 'production' })).resolves.toBeUndefined()
  })
})
