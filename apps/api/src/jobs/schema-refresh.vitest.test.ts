// apps/api/src/jobs/schema-refresh.vitest.test.ts
import { afterEach, describe, it, expect, vi } from 'vitest'

const cron = vi.hoisted(() => ({ schedule: vi.fn(() => ({ stop: vi.fn() })) }))
vi.mock('../lib/cron/clustered.js', () => ({ default: cron }))
import { collectInUseSchemaTargets, startSchemaRefreshCron, REFRESHED_CHANNELS } from './schema-refresh.job.js'

describe('collectInUseSchemaTargets', () => {
  it('returns distinct (channel, marketplace, productType) targets from cached schemas', async () => {
    const prisma = {
      categorySchema: {
        findMany: vi.fn().mockResolvedValue([
          { channel: 'AMAZON', marketplace: 'IT', productType: 'COAT' },
          { channel: 'AMAZON', marketplace: 'IT', productType: 'PANTS' },
          { channel: 'AMAZON', marketplace: 'IT', productType: 'COAT' }, // duplicate — should be removed
          { channel: 'EBAY', marketplace: 'IT', productType: '177104' },
          { channel: 'ETSY', marketplace: 'GLOBAL', productType: '1429' },
        ]),
      },
    } as any
    const out = await collectInUseSchemaTargets(prisma)
    expect(out).toEqual([
      { channel: 'AMAZON', marketplace: 'IT', productType: 'COAT' },
      { channel: 'AMAZON', marketplace: 'IT', productType: 'PANTS' },
      { channel: 'EBAY', marketplace: 'IT', productType: '177104' },
      { channel: 'ETSY', marketplace: 'GLOBAL', productType: '1429' },
    ])
  })

  it('defaults a null Amazon marketplace to IT and a null Etsy one to GLOBAL', async () => {
    const prisma = {
      categorySchema: {
        findMany: vi.fn().mockResolvedValue([
          { channel: 'AMAZON', marketplace: null, productType: 'SHOE' },
          { channel: 'AMAZON', marketplace: 'DE', productType: 'SHOE' },
          { channel: 'ETSY', marketplace: null, productType: '1429' },
        ]),
      },
    } as any
    const out = await collectInUseSchemaTargets(prisma)
    expect(out).toEqual([
      { channel: 'AMAZON', marketplace: 'IT', productType: 'SHOE' },
      { channel: 'AMAZON', marketplace: 'DE', productType: 'SHOE' },
      { channel: 'ETSY', marketplace: 'GLOBAL', productType: '1429' },
    ])
  })

  it('returns empty array when no active schemas exist', async () => {
    const prisma = { categorySchema: { findMany: vi.fn().mockResolvedValue([]) } } as any
    expect(await collectInUseSchemaTargets(prisma)).toEqual([])
  })

  it('asks for every refreshed channel, and never the Shopify store rows', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    const prisma = { categorySchema: { findMany } } as any
    await collectInUseSchemaTargets(prisma)
    expect(findMany).toHaveBeenCalledWith({
      where: { channel: { in: ['AMAZON', 'EBAY', 'ETSY'] }, isActive: true },
      select: { channel: true, marketplace: true, productType: true },
      orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { productType: 'asc' }],
    })
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
