import { beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ findMany: vi.fn(), run: vi.fn(), schedule: vi.fn(), errors: vi.fn(), record: vi.fn() }))
vi.mock('../db.js', () => ({ default: { channelListing: { findMany: fixture.findMany } } }))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule: fixture.schedule } }))
vi.mock('../services/shopify/linked-products.service.js', () => ({ AUTOMATION_KEY: '_nexusLinkedAutomation' }))
vi.mock('../services/shopify/linked-automation.service.js', () => ({ runLinkedAutomation: fixture.run }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: fixture.record }))
vi.mock('../utils/logger.js', () => ({ logger: { error: fixture.errors } }))
import { runShopifyLinkedAutomationCron, startShopifyLinkedAutomationCron } from './shopify-linked-automation.job'
beforeEach(() => { vi.clearAllMocks(); fixture.run.mockResolvedValue({}); fixture.findMany.mockResolvedValue([]); fixture.record.mockImplementation(async (_name, work) => work()) })
describe('server-owned Shopify automation lifecycle', () => {
  it('registers one clustered five-minute schedule without starting remote work at boot', () => {
    fixture.schedule.mockReturnValue({ stop() {} })
    startShopifyLinkedAutomationCron(); startShopifyLinkedAutomationCron()
    expect(fixture.schedule).toHaveBeenCalledTimes(1)
    expect(fixture.schedule.mock.calls[0][0]).toBe('*/5 * * * *')
    expect(fixture.run).not.toHaveBeenCalled()
  })
  it('paginates every enabled listing and retains each explicit account and listing scope', async () => {
    const rows = Array.from({ length: 26 }, (_, i) => ({ id: `listing-${i}`, productId: `family-${i}`, channelConnectionId: `account-${i}` }))
    fixture.findMany.mockResolvedValueOnce(rows.slice(0, 25)).mockResolvedValueOnce(rows.slice(25))
    await runShopifyLinkedAutomationCron()
    expect(fixture.run).toHaveBeenCalledTimes(26)
    expect(fixture.run).toHaveBeenLastCalledWith('family-25', { accountId: 'account-25', listingId: 'listing-25', market: 'GLOBAL' })
    expect(fixture.findMany.mock.calls[1][0].cursor).toEqual({ id: 'listing-24' })
  })
  it('continues other stores when one listing fails', async () => {
    fixture.findMany.mockResolvedValueOnce([{ id: 'a', productId: 'family-a', channelConnectionId: 'A' }, { id: 'b', productId: 'family-b', channelConnectionId: 'B' }])
    fixture.run.mockRejectedValueOnce(new Error('Disconnected store'))
    await runShopifyLinkedAutomationCron()
    expect(fixture.run).toHaveBeenCalledTimes(2); expect(fixture.errors).toHaveBeenCalledTimes(1)
  })
  it('prevents overlapping local ticks while a store is slow', async () => {
    let release!: (rows: never[]) => void
    fixture.findMany.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const first = runShopifyLinkedAutomationCron()
    await runShopifyLinkedAutomationCron()
    expect(fixture.findMany).toHaveBeenCalledTimes(1)
    release([]); await first
  })
})
