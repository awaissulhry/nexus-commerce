import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const doubles = vi.hoisted(() => ({
  broker: { name: 'role-test' },
  configured: vi.fn(),
  startRelay: vi.fn(),
  stopRelay: vi.fn(),
  starts: Array.from({ length: 9 }, () => vi.fn()),
  stops: Array.from({ length: 9 }, () => vi.fn()),
  startWatchdog: vi.fn(),
  stopWatchdog: vi.fn(),
}))

vi.mock('../lib/events/index.js', () => ({
  getBroker: () => doubles.broker,
  isRedisConfigured: doubles.configured,
  startRelay: doubles.startRelay,
  stopRelay: doubles.stopRelay,
  outboxStats: async () => ({ pending: 0, pendingBlocked: 0, oldestPendingAgeMs: null }),
}))
vi.mock('../services/listing-events.service.js', () => ({ startListingEventIntake: doubles.starts[0], stopListingEventIntake: doubles.stops[0] }))
vi.mock('../services/inbound-events.service.js', () => ({ startInboundEventIntake: doubles.starts[1], stopInboundEventIntake: doubles.stops[1] }))
vi.mock('../services/outbound-events.service.js', () => ({ startOutboundEventIntake: doubles.starts[2], stopOutboundEventIntake: doubles.stops[2] }))
vi.mock('../services/sync-logs-events.service.js', () => ({ startSyncLogEventIntake: doubles.starts[3], stopSyncLogEventIntake: doubles.stops[3] }))
vi.mock('../services/po-events.service.js', () => ({ startPoEventIntake: doubles.starts[4], stopPoEventIntake: doubles.stops[4] }))
vi.mock('../services/order-events.service.js', () => ({ startOrderEventIntake: doubles.starts[5], stopOrderEventIntake: doubles.stops[5] }))
vi.mock('../services/marketing-events.service.js', () => ({ startMarketingEventIntake: doubles.starts[6], stopMarketingEventIntake: doubles.stops[6] }))
vi.mock('../services/review-events.service.js', () => ({ startReviewEventIntake: doubles.starts[7], stopReviewEventIntake: doubles.stops[7] }))
vi.mock('../services/ads-execution-events.service.js', () => ({ startAdsExecutionEventIntake: doubles.starts[8], stopAdsExecutionEventIntake: doubles.stops[8] }))
vi.mock('../services/inventory-oversell-watchdog.service.js', () => ({ startOversellWatchdog: doubles.startWatchdog }))

import { startEventInfrastructure, stopEventInfrastructure } from './event-relay.worker.js'

const API = { relay: false, intake: true, watchdog: false }
const WORKER = { relay: true, intake: false, watchdog: true }

beforeEach(async () => {
  await stopEventInfrastructure()
  vi.resetAllMocks()
  vi.stubEnv('NEXUS_DISABLE_OVERSELL_WATCHDOG', '0')
  doubles.configured.mockReturnValue(true)
  for (const start of doubles.starts) start.mockResolvedValue(undefined)
  for (const stop of doubles.stops) stop.mockResolvedValue(undefined)
  doubles.stopWatchdog.mockResolvedValue(undefined)
  doubles.startWatchdog.mockResolvedValue(doubles.stopWatchdog)
})

afterEach(async () => {
  await stopEventInfrastructure()
  vi.unstubAllEnvs()
})

describe('event infrastructure process roles', () => {
  it('starts all nine API broadcast intakes once, without relay or watchdog', async () => {
    await startEventInfrastructure(API)
    await startEventInfrastructure(API)

    for (const start of doubles.starts) expect(start).toHaveBeenCalledTimes(1)
    expect(doubles.startRelay).not.toHaveBeenCalled()
    expect(doubles.startWatchdog).not.toHaveBeenCalled()
  })

  it('starts the worker relay and watchdog once, without API broadcast intakes', async () => {
    await startEventInfrastructure(WORKER)
    await startEventInfrastructure(WORKER)

    expect(doubles.startRelay).toHaveBeenCalledExactlyOnceWith(doubles.broker)
    expect(doubles.startWatchdog).toHaveBeenCalledExactlyOnceWith(doubles.broker)
    for (const start of doubles.starts) expect(start).not.toHaveBeenCalled()
  })

  it('stops only the resources owned by API intake and makes repeated cleanup harmless', async () => {
    await startEventInfrastructure(API)
    await stopEventInfrastructure()
    await stopEventInfrastructure()

    for (const stop of doubles.stops) expect(stop).toHaveBeenCalledTimes(1)
    expect(doubles.stopRelay).not.toHaveBeenCalled()
    expect(doubles.stopWatchdog).not.toHaveBeenCalled()
  })

  it('stops only the worker relay and watchdog when intakes were never started', async () => {
    await startEventInfrastructure(WORKER)
    await stopEventInfrastructure()
    await stopEventInfrastructure()

    expect(doubles.stopRelay).toHaveBeenCalledTimes(1)
    expect(doubles.stopWatchdog).toHaveBeenCalledTimes(1)
    for (const stop of doubles.stops) expect(stop).not.toHaveBeenCalled()
  })

  it('permits worker startup to retry after the watchdog failed to attach', async () => {
    doubles.startWatchdog.mockRejectedValueOnce(new Error('consumer attachment failed'))

    await expect(startEventInfrastructure(WORKER)).rejects.toThrow('consumer attachment failed')
    await startEventInfrastructure(WORKER)

    expect(doubles.startWatchdog).toHaveBeenCalledTimes(2)
    await stopEventInfrastructure()
    expect(doubles.stopWatchdog).toHaveBeenCalledTimes(1)
  })

  it('permits intake startup to retry after one bus fails', async () => {
    doubles.starts[4].mockRejectedValueOnce(new Error('purchase-order intake unavailable'))

    await expect(startEventInfrastructure(API)).rejects.toThrow('purchase-order intake unavailable')
    await startEventInfrastructure(API)

    expect(doubles.starts[4]).toHaveBeenCalledTimes(2)
    expect(doubles.startRelay).not.toHaveBeenCalled()
    expect(doubles.startWatchdog).not.toHaveBeenCalled()
  })

  it('can start later when Redis was not configured on the first call', async () => {
    doubles.configured.mockReturnValueOnce(false)

    await startEventInfrastructure(WORKER)
    await startEventInfrastructure(WORKER)

    expect(doubles.startRelay).toHaveBeenCalledTimes(1)
    expect(doubles.startWatchdog).toHaveBeenCalledTimes(1)
  })
})
