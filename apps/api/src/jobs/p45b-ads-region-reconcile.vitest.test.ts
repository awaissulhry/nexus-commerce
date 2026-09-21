/**
 * P4.5b — the Amazon Ads region is one fact, and the money path can see every profile.
 *
 * Measured on the development database 2026-09-21:
 *   ConnectionScope (what discovery found) → 14 profiles: 9 EU, 3 NA, 2 FE
 *   AmazonAdsConnection (what 25+ jobs read) → 9, all EU
 * Five real advertising profiles — US, CA, MX, AU, JP — are invisible to every ads job.
 *
 * And the region is load-bearing: `ads-api-client.ts` picks its API host from the row's
 * `region`, while the connect callback wrote `'EU'` for every profile it saved.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADS_REGION_HOSTS, ADS_REGIONS, adsHostFor, asAdsRegion } from '../services/ads-core/ads-regions.js'

const SRC = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

// ── 1. One region map, refusing rather than guessing ───────────────────────
describe('ads-regions (P4.5b — one accessor for region → host)', () => {
  it('knows exactly the three Amazon Ads regions', () => {
    expect(ADS_REGIONS).toEqual(['EU', 'NA', 'FE'])
    expect(Object.keys(ADS_REGION_HOSTS).sort()).toEqual(['EU', 'FE', 'NA'])
  })

  it('each region has its OWN host — the drift that made NA calls go to the EU host', () => {
    const hosts = Object.values(ADS_REGION_HOSTS)
    expect(new Set(hosts).size).toBe(3)
    expect(ADS_REGION_HOSTS.NA).toBe('https://advertising-api.amazon.com')
    expect(ADS_REGION_HOSTS.EU).toBe('https://advertising-api-eu.amazon.com')
    expect(ADS_REGION_HOSTS.FE).toBe('https://advertising-api-fe.amazon.com')
  })

  it('REFUSES an unknown region instead of falling back to EU', () => {
    // P4.4a's rule: an accessor for a fact that lives in data refuses. A silent EU
    // fallback is exactly what a NA profile got for as long as this map had two shapes.
    expect(() => adsHostFor('US')).toThrow(/not an Amazon Ads region/)
    expect(() => adsHostFor(null)).toThrow(/not an Amazon Ads region/)
    expect(() => adsHostFor('')).toThrow(/not an Amazon Ads region/)
    expect(adsHostFor('na')).toBe(ADS_REGION_HOSTS.NA) // case is not the question
  })

  it('asAdsRegion answers null for a non-region rather than inventing one', () => {
    expect(asAdsRegion('EU')).toBe('EU')
    expect(asAdsRegion('fe')).toBe('FE')
    expect(asAdsRegion('GLOBAL')).toBeNull()
    expect(asAdsRegion(undefined)).toBeNull()
  })
})

// ── 2. The census: no file re-states the host map ──────────────────────────
describe('census (P4.5b — the host map is not written out a sixth time)', () => {
  const FILES = [
    'services/advertising/ads-api-client.ts',
    'services/advertising/ads-debug-probe.service.ts',
    'services/cx/connectors/amazon-ads/spec.ts',
    'routes/amazon-ads-auth.routes.ts',
  ]

  it('none of the four former copies still spells a regional host as a literal', () => {
    const offenders: string[] = []
    for (const f of FILES) {
      for (const line of read(f).split('\n')) {
        // Comments may quote the host — they are documentation, not a second map.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
        if (/'https:\/\/advertising-api(-eu|-fe)?\.amazon\.com/.test(line)) offenders.push(`${f}: ${line.trim()}`)
      }
    }
    expect(offenders, `these re-state the region map:\n${offenders.join('\n')}`).toEqual([])
  })

  it('positive control: the accessor itself DOES spell them out', () => {
    // Without this, the census above passes just as well if the pattern rots.
    const acc = read('services/ads-core/ads-regions.ts')
    const hits = acc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /'https:\/\/advertising-api/.test(l))
    expect(hits.length).toBe(3)
  })
})

// ── 3. The connect callback records the region it answered in ──────────────
describe('connect callback (P4.5b — the region is measured, not assumed)', () => {
  const route = read('routes/amazon-ads-auth.routes.ts')

  it('no longer writes a constant region onto every saved PROFILE row', () => {
    // Scoped to the AmazonAdsConnection upsert. The two other `region: 'EU'` in this
    // file are the ChannelConnection's own home region — one grant, one connection,
    // and EU really is where it lives. Per-profile region is what was wrong.
    const upsert = route.slice(
      route.indexOf('await prisma.amazonAdsConnection.upsert('),
      route.indexOf('      saved.push('),
    )
    expect(upsert.length).toBeGreaterThan(200) // the slice actually found the block
    expect(upsert).not.toContain("region: 'EU'")
    expect(upsert).toContain('region: profile.region,')
  })

  it('sweeps every region when the variable is on, and EU alone when it is not', () => {
    expect(route).toContain("const regions: AdsRegion[] = allRegions() ? ADS_REGIONS : ['EU']")
    expect(route).toContain("process.env.NEXUS_ADS_ALL_REGIONS === '1'")
  })

  it('a non-EU region that does not answer does NOT fail the connect', () => {
    // An account with no Far-East profiles is the normal case. EU is the exception:
    // it is where this grant lives, so its failure stays the connect's failure.
    expect(route).toContain("if (region === 'EU') throw new Error(`GET /v2/profiles failed")
  })

  it('P4.5h — stores the COUNTRY CODE, not Amazon\'s marketplace id', () => {
    /**
     * 🔴 The column every reader matches on holds a country code:
     *   AmazonAdsConnection.marketplace = IT, DE, FR, ES, NL, PL, SE, UK, IE (9 rows)
     *   Campaign.marketplace            = IT (150), DE (38), FR (22), ES (10)
     *   ads-profile-resolver.fromRow    = where: { marketplace, isActive: true }
     *
     * The callback wrote `marketplaceStringId` (APJ6JRA9NG5V4). The FIRST reconnect
     * would have rewritten all nine rows to Amazon's ids, after which
     * adsProfileFor('IT') finds nothing and the Ads write gate refuses every market
     * with "no active Amazon Ads profile for marketplace=IT".
     *
     * `country` is computed three lines above the upsert and was already used for the
     * scope label — the right value was in hand and the wrong one was stored.
     */
    const upsert = route.slice(
      route.indexOf('await prisma.amazonAdsConnection.upsert('),
      route.indexOf('      saved.push('),
    )
    expect(upsert.length).toBeGreaterThan(200)
    const code = upsert.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    expect(code.filter((l) => l.includes('marketplace: country,'))).toHaveLength(2) // create + update
    expect(code.filter((l) => l.includes('marketplace: marketplaceStringId'))).toEqual([])
  })

  it('P4.5h — the marketplace id is still recorded, on the SCOPE where it belongs', () => {
    // Amazon's id is a real fact and is not lost: it goes into the scope metadata as
    // `marketplaceStringId`, beside the country code. One column, one meaning.
    expect(route).toContain('marketplaceStringId,')
  })

  it('a reconnect no longer reasserts isActive over the operator', () => {
    // CX.3a already learned this once for scope metadata: discovery must not
    // overwrite what discovery cannot see. A reconnect is a credential event.
    const update = route.slice(route.indexOf('        update: {'), route.indexOf('      })\n\n      saved.push'))
    expect(update).toContain('region: profile.region,')
    expect(update).not.toContain('isActive: true,')
  })
})

// ── 4. The reconcile job ───────────────────────────────────────────────────
const created: any[] = []
const updated: any[] = []
let scopeRows: any[] = []
let connRows: any[] = []

vi.mock('../db.js', () => ({
  default: {
    connectionScope: { findMany: async () => scopeRows },
    amazonAdsConnection: {
      findMany: async () => connRows,
      create: async (a: any) => { created.push(a.data); return a.data },
      update: async (a: any) => { updated.push(a); return {} },
    },
  },
}))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: async (_n: string, f: any) => f() }))
vi.mock('../services/connection-resolver.service.js', () => ({
  tryResolveConnection: async () => ({ id: 'ads-conn-1', channelType: 'AMAZON_ADS' }),
}))

const { reconcileAdsRegions } = await import('./p45b-ads-region-reconcile.job.js')

describe('reconcileAdsRegions (P4.5b)', () => {
  beforeEach(() => {
    created.length = 0
    updated.length = 0
    delete process.env.NEXUS_ADS_ALL_REGIONS
    // The measured shape: 9 EU rows, 14 scopes.
    scopeRows = [
      { externalId: 'p-eu', region: 'EU', label: 'XAVIA · IT', metadata: { marketplace: 'IT', accountName: 'XAVIA' } },
      { externalId: 'p-us', region: 'NA', label: 'Xavia Racing Usa · US', metadata: { marketplace: 'US', accountName: 'Xavia Racing Usa' } },
      { externalId: 'p-jp', region: 'FE', label: 'XAVIA · JP', metadata: { marketplace: 'JP', accountName: 'XAVIA' } },
      { externalId: 'p-nil', region: null, label: 'no region', metadata: {} },
    ]
    connRows = [{ profileId: 'p-eu', region: 'EU', marketplace: 'IT' }]
  })

  it('with the variable OFF it creates nothing and SAYS how many it left', async () => {
    const r = await reconcileAdsRegions()
    expect(created).toEqual([])
    // Not silence: the count is the whole point, so "nothing to do" and "two
    // profiles waiting on a variable" cannot look the same.
    expect(r.createsSkippedOff).toBe(2)
    expect(r.scopes).toBe(4)
  })

  it('with the variable ON it records the missing profiles, INACTIVE and sandbox', async () => {
    process.env.NEXUS_ADS_ALL_REGIONS = '1'
    const r = await reconcileAdsRegions()
    expect(r.created).toBe(2)
    expect(created.map((c) => c.profileId).sort()).toEqual(['p-jp', 'p-us'])
    for (const row of created) {
      expect(row.isActive).toBe(false)
      expect(row.mode).toBe('sandbox')
      // A secret is not copied onto five more rows — the core already holds it.
      expect(row.credentialsEncrypted).toBeUndefined()
    }
    expect(created.find((c) => c.profileId === 'p-us')).toMatchObject({ region: 'NA', marketplace: 'US' })
    expect(created.find((c) => c.profileId === 'p-jp')).toMatchObject({ region: 'FE', marketplace: 'JP' })
  })

  it('a scope with no region is skipped, never guessed into EU', async () => {
    process.env.NEXUS_ADS_ALL_REGIONS = '1'
    await reconcileAdsRegions()
    expect(created.map((c) => c.profileId)).not.toContain('p-nil')
  })

  it('corrects a row stranded on the wrong host — with the variable OFF', async () => {
    // The region repair is pure correctness and costs no API call, so it is not
    // behind the spend variable. Today it corrects nothing, which is exactly why
    // it should ship before the first NA row exists rather than after.
    connRows = [{ profileId: 'p-eu', region: 'NA', marketplace: 'IT' }]
    const r = await reconcileAdsRegions()
    expect(r.regionCorrected).toBe(1)
    expect(updated[0].data).toEqual({ region: 'EU' })
  })

  it('touches nothing when every row already agrees (control)', async () => {
    scopeRows = [{ externalId: 'p-eu', region: 'EU', label: 'x', metadata: { marketplace: 'IT' } }]
    connRows = [{ profileId: 'p-eu', region: 'EU', marketplace: 'IT' }]
    const r = await reconcileAdsRegions()
    expect(r).toMatchObject({ scopes: 1, created: 0, regionCorrected: 0, marketCorrected: 0, unchanged: 1, createsSkippedOff: 0 })
    expect(created).toEqual([])
    expect(updated).toEqual([])
  })

  // ── P4.5h — the stored market, self-healing ──────────────────────────────
  it('corrects a row stored under the WRONG market, from Amazon\'s own answer', async () => {
    // The measured case: profile 4392237479209848 is `IE` in AmazonAdsConnection and
    // `BE` in its scope. Amazon says BE (AMEN7PMS3EDWL, Europe/Brussels), and
    // utils/marketplace-code.ts was corrected on 2026-08-29 — the stored row never was.
    // This is what repairs it on production without a manual UPDATE.
    scopeRows = [{ externalId: 'p-be', region: 'EU', label: 'XAVIA · BE', metadata: { marketplace: 'BE' } }]
    connRows = [{ profileId: 'p-be', region: 'EU', marketplace: 'IE' }]
    const r = await reconcileAdsRegions()
    expect(r.marketCorrected).toBe(1)
    expect(r.regionCorrected).toBe(0)
    expect(updated[0].data).toEqual({ marketplace: 'BE' })
  })

  it('corrects region and market in ONE update when both disagree', async () => {
    scopeRows = [{ externalId: 'p-us', region: 'NA', label: 'US', metadata: { marketplace: 'US' } }]
    connRows = [{ profileId: 'p-us', region: 'EU', marketplace: 'IT' }]
    const r = await reconcileAdsRegions()
    expect(updated).toHaveLength(1)
    expect(updated[0].data).toEqual({ region: 'NA', marketplace: 'US' })
    expect(r).toMatchObject({ regionCorrected: 1, marketCorrected: 1 })
  })

  it('a scope with no market in its metadata corrects nothing', async () => {
    // Absence is not evidence. Blanking a working market because discovery did not
    // report one would be the P4.3b mistake: "we could not check" is not "it is wrong".
    scopeRows = [
      { externalId: 'p-a', region: 'EU', label: 'a', metadata: {} },
      { externalId: 'p-b', region: 'EU', label: 'b', metadata: { marketplace: '   ' } },
      { externalId: 'p-c', region: 'EU', label: 'c', metadata: { marketplace: 42 } },
    ]
    connRows = [
      { profileId: 'p-a', region: 'EU', marketplace: 'IT' },
      { profileId: 'p-b', region: 'EU', marketplace: 'DE' },
      { profileId: 'p-c', region: 'EU', marketplace: 'FR' },
    ]
    const r = await reconcileAdsRegions()
    expect(updated).toEqual([])
    expect(r.marketCorrected).toBe(0)
    expect(r.unchanged).toBe(3)
  })

  it('is scheduled, not registry-only (P4.2d)', () => {
    const job = read('jobs/p45b-ads-region-reconcile.job.ts')
    expect(job).toContain("import cron from '../lib/cron/clustered.js'")
    expect(read('index.ts')).toContain('startAdsRegionReconcileCron();')
  })
})
