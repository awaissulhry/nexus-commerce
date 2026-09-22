import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ scheduled: null as null | (() => Promise<void>), result: {} as any, statuses: [] as string[] }))
vi.mock('../lib/cron/clustered.js', () => ({
  default: { validate: () => true },
  schedulePlatform: (_schedule: string, work: () => Promise<void>) => { state.scheduled = work; return {} },
}))
vi.mock('../services/cx/connectors/ebay/notifications.js', async original => ({
  ...await original<object>(), setupEbayNotifications: async () => state.result,
}))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))
vi.mock('../db.js', () => ({ default: { cronRun: {
  create: async () => ({ id: 'cron-run' }),
  update: async ({ data }: any) => { state.statuses.push(data.status) },
} } }))
vi.mock('../utils/trace-log.js', () => ({ logTraceEvent: vi.fn() }))
const { startEbayNotificationReconcileCron } = await import('./ebay-notification-reconcile.job.js')
beforeEach(() => {
  vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
  state.statuses = []
  state.result = { configured: true, destinationId: 'd', notOffered: [], perTopic: [] }
  if (!state.scheduled) startEbayNotificationReconcileCron()
})
afterEach(() => vi.unstubAllEnvs())
it.each(['failed', 'refused', 'not_offered'])('marks the scheduled run failed when a subscription is %s', async status => {
  state.result.perTopic = [{ topicId: 'AUTHORIZATION_REVOCATION', status }]
  await state.scheduled!()
  expect(state.statuses).toEqual(['FAILED'])
})
it('marks a remote read error failed', async () => {
  state.result.error = 'eBay topics returned 403'
  await state.scheduled!()
  expect(state.statuses).toEqual(['FAILED'])
})
it('keeps an unconfigured no-op distinct from a configured failure', async () => {
  state.result.configured = false
  await state.scheduled!()
  expect(state.statuses).toEqual(['SUCCESS'])
})
it('records success for verified existing subscriptions', async () => {
  state.result.perTopic = [{ topicId: 'AUTHORIZATION_REVOCATION', status: 'already_exists' }]
  await state.scheduled!()
  expect(state.statuses).toEqual(['SUCCESS'])
})
