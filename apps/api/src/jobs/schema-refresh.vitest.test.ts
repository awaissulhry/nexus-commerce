// apps/api/src/jobs/schema-refresh.vitest.test.ts
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

const cron = vi.hoisted(() => ({ schedule: vi.fn(() => ({ stop: vi.fn() })) }))
const m = vi.hoisted(() => ({ targets: [] as unknown[], configured: true, getSchema: vi.fn(), refreshSchema: vi.fn(), refreshEnglishCopy: vi.fn() }))
vi.mock('../lib/cron/clustered.js', () => ({ default: cron }))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: (_job: string, handler: () => Promise<unknown>) => handler() }))
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class { isConfigured = async () => m.configured } }))
vi.mock('../services/categories/schema-sync.service.js', () => ({ CategorySchemaService: class { getSchema = m.getSchema; refreshSchema = m.refreshSchema; refreshEnglishCopy = m.refreshEnglishCopy } }))
// The target rules are proven on PGlite in schema-coverage.vitest.test.ts; here only the job's use of them.
vi.mock('../services/categories/schema-coverage.service.js', async (actual) => ({ ...(await actual<object>()), collectSchemaTargets: async () => m.targets }))
import { runSchemaRefresh, startSchemaRefreshCron, REFRESHED_CHANNELS } from './schema-refresh.job.js'

const t = (channel: string, marketplace: string, productType: string, status: string) => ({ channel, marketplace, productType, status, fetchedAt: null, expiresAt: null })

describe('runSchemaRefresh — P3: in-use targets, missing ones downloaded', () => {
  beforeEach(() => {
    m.getSchema.mockReset().mockImplementation(async (q: { channel: string }) => { if (q.channel === 'EBAY') throw new Error('eBay unavailable'); return {} })
    m.refreshSchema.mockReset().mockResolvedValue({})
    // W3 PR-A — the IT copy is stored; Amazon answers BE in Dutch (not stored, counted failed).
    m.refreshEnglishCopy.mockReset().mockImplementation(async (q: { marketplace: string }) => q.marketplace === 'IT' ? 'stored' : 'failed')
    m.targets = [t('AMAZON', 'BE', 'COAT', 'missing'), t('AMAZON', 'IT', 'OUTERWEAR', 'cached'), t('EBAY', 'IT', '177104', 'missing'), t('ETSY', 'GLOBAL', '1429', 'stale')]
  })

  it('downloads a missing pair, refreshes a cached or stale one, continues past a failure, and counts per channel', async () => {
    m.configured = true
    expect(await runSchemaRefresh()).toBe('targets=4 AMAZON: added=1 refreshed=1 failed=0 skipped=0 englishStored=1 englishFailed=1 · EBAY: added=0 refreshed=0 failed=1 skipped=0 · ETSY: added=0 refreshed=1 failed=0 skipped=0')
    expect(m.getSchema.mock.calls.map(c => c[0])).toEqual([{ channel: 'AMAZON', marketplace: 'BE', productType: 'COAT' }, { channel: 'EBAY', marketplace: 'IT', productType: '177104' }])
    expect(m.refreshSchema.mock.calls.map(c => c[0].productType)).toEqual(['OUTERWEAR', '1429'])
    expect(m.refreshEnglishCopy.mock.calls.map(c => `${c[0].marketplace} ${c[0].productType}`)).toEqual(['BE COAT', 'IT OUTERWEAR'])
  })

  it('skips every Amazon target when this business has no usable Amazon connection', async () => {
    m.configured = false
    expect(await runSchemaRefresh()).toContain('AMAZON: added=0 refreshed=0 failed=0 skipped=2 englishStored=0 englishFailed=0')
    expect(m.getSchema.mock.calls.every(c => c[0].channel !== 'AMAZON')).toBe(true)
    expect(m.refreshEnglishCopy).not.toHaveBeenCalled()
  })

  it('keeps every per-category channel, and never the Shopify store rows', () => {
    expect([...REFRESHED_CHANNELS]).toEqual(['AMAZON', 'EBAY', 'ETSY'])
    expect(REFRESHED_CHANNELS).not.toContain('SHOPIFY_STORE')
  })
})

describe('startSchemaRefreshCron — on by default (P4)', () => {
  afterEach(() => { delete process.env.NEXUS_ENABLE_SCHEMA_REFRESH_CRON; cron.schedule.mockClear() })

  it('schedules the daily run when the switch is not set, and stays off only on an explicit 0', async () => {
    delete process.env.NEXUS_ENABLE_SCHEMA_REFRESH_CRON
    startSchemaRefreshCron()
    expect(cron.schedule).toHaveBeenCalledTimes(1)
    expect(cron.schedule.mock.calls[0][0]).toBe('0 4 * * *')
    vi.resetModules()
    process.env.NEXUS_ENABLE_SCHEMA_REFRESH_CRON = '0'
    const fresh = await import('./schema-refresh.job.js')
    cron.schedule.mockClear()
    fresh.startSchemaRefreshCron()
    expect(cron.schedule).not.toHaveBeenCalled()
  })
})
