import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  scheduled: null as null | (() => Promise<void>), result: {} as any, statuses: [] as string[], summaries: [] as string[],
  sellers: { accounts: [] } as any, sellerScopes: [] as string[],
}))
vi.mock('../lib/cron/clustered.js', () => ({
  default: { validate: () => true },
  schedulePlatform: (_schedule: string, work: () => Promise<void>) => { state.scheduled = work; return {} },
}))
vi.mock('../services/cx/connectors/ebay/notifications.js', async original => ({
  ...await original<object>(), setupEbayNotifications: async () => state.result,
}))
vi.mock('../services/cx/connectors/ebay/seller-subscriptions.js', async original => ({
  ...await original<object>(),
  reconcileEbaySellersForSetup: async (_setup: unknown, scope: string) => { state.sellerScopes.push(scope); return state.sellers },
}))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))
vi.mock('../db.js', () => ({ default: { cronRun: {
  create: async () => ({ id: 'cron-run' }),
  update: async ({ data }: any) => { state.statuses.push(data.status); state.summaries.push(data.outputSummary ?? data.errorMessage ?? '') },
} } }))
vi.mock('../utils/trace-log.js', () => ({ logTraceEvent: vi.fn() }))
const { startEbayNotificationReconcileCron } = await import('./ebay-notification-reconcile.job.js')
beforeEach(() => {
  vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
  vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', 'AUTHORIZATION_REVOCATION')
  state.statuses = []
  state.summaries = []
  state.sellerScopes = []
  state.sellers = { skipped: 'ORDER_CONFIRMATION is not armed.', accounts: [] }
  state.result = { configured: true, armed: true, destinationId: 'd', notOffered: [], perTopic: [] }
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
it('records an unarmed result as a no-call run, not a failure', async () => {
  state.result.armed = false
  state.result.error = 'Setup is not armed.'
  await state.scheduled!()
  expect(state.statuses).toEqual(['SUCCESS'])
})

// GAP2 phase 2: after the app-level setup, every business's eBay accounts.
const seller = (status: string) => ({ connectionId: `conn-${status}`, topicId: 'ORDER_CONFIRMATION', status, signInName: null })
it('runs the seller step for every business after the app-level setup', async () => {
  state.result.perTopic = [{ topicId: 'AUTHORIZATION_REVOCATION', status: 'already_exists' }]
  await state.scheduled!()
  expect(state.sellerScopes).toEqual(['every_business'])
})
it('records reconnect needed as a successful run, with the count in the summary', async () => {
  state.result.sellerTopics = [{ topicId: 'ORDER_CONFIRMATION' }]
  state.sellers = { accounts: [seller('created'), seller('reconnect_needed')] }
  await state.scheduled!()
  expect(state.statuses).toEqual(['SUCCESS'])
  expect(state.summaries[0]).toContain('sellers: created=1 reconnect_needed=1')
})
it.each(['failed', 'not_offered'])('marks the run failed when a seller subscription is %s', async status => {
  state.result.sellerTopics = [{ topicId: 'ORDER_CONFIRMATION' }]
  state.sellers = { accounts: [seller('subscribed'), seller(status)] }
  await state.scheduled!()
  expect(state.statuses).toEqual(['FAILED'])
})
it('marks the run failed when the armed order topic is not in eBay\'s catalogue', async () => {
  state.result.notOffered = ['ORDER_CONFIRMATION']
  state.result.sellerTopics = []
  await state.scheduled!()
  expect(state.statuses).toEqual(['FAILED'])
})
