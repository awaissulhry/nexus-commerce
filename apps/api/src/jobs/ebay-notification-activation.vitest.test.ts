import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const scheduled = vi.hoisted(() => vi.fn())
vi.mock('../lib/cron/clustered.js', () => ({ default: { validate: () => true }, schedulePlatform: scheduled }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); scheduled.mockReturnValue({}) })
afterEach(() => vi.unstubAllEnvs())

it.each([undefined, '', '0', 'true', 'false', 'yes'])('does not arm provisioning without explicit enablement: %s', async value => {
  vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', value)
  vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', 'AUTHORIZATION_REVOCATION')
  const { startEbayNotificationReconcileCron } = await import('./ebay-notification-reconcile.job.js')
  startEbayNotificationReconcileCron()
  expect(scheduled).not.toHaveBeenCalled()
})

// Review 2026-09-26: a scheduler that still holds NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP=1 from
// before 2026-09-22 must not start creating eBay destinations at 03:55 after this deploy.
it.each([undefined, '', 'ORDER_CONFIRMATION', 'MARKETPLACE_ACCOUNT_DELETION', 'AUTHORIZATION_REVOCATION,ITEM_AVAILABILITY'])(
  'schedules nothing when the old switch is 1 but the armed-topic list is %j', async armed => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
    vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', armed)
    const { startEbayNotificationReconcileCron } = await import('./ebay-notification-reconcile.job.js')
    startEbayNotificationReconcileCron()
    expect(scheduled).not.toHaveBeenCalled()
  })

it('arms exactly one reconcile when the switch is 1 and the Owner named the topic', async () => {
  vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
  vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', 'AUTHORIZATION_REVOCATION')
  const { startEbayNotificationReconcileCron } = await import('./ebay-notification-reconcile.job.js')
  startEbayNotificationReconcileCron()
  startEbayNotificationReconcileCron()
  expect(scheduled).toHaveBeenCalledOnce()
})
