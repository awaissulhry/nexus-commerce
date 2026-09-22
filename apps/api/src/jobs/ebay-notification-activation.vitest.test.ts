import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const scheduled = vi.hoisted(() => vi.fn())
vi.mock('../lib/cron/clustered.js', () => ({ default: { validate: () => true }, schedulePlatform: scheduled }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); scheduled.mockReturnValue({}) })
afterEach(() => vi.unstubAllEnvs())

it.each([undefined, '', '0', 'true', 'false', 'yes'])('does not arm provisioning without explicit enablement: %s', async value => {
  vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', value)
  const { startEbayNotificationReconcileCron } = await import('./ebay-notification-reconcile.job.js')
  startEbayNotificationReconcileCron()
  expect(scheduled).not.toHaveBeenCalled()
})

it('arms exactly one reconcile when explicitly enabled', async () => {
  vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
  const { startEbayNotificationReconcileCron } = await import('./ebay-notification-reconcile.job.js')
  startEbayNotificationReconcileCron()
  startEbayNotificationReconcileCron()
  expect(scheduled).toHaveBeenCalledOnce()
})
