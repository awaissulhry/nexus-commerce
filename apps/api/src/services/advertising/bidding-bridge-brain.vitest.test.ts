/**
 * ONE BRAIN AB-6 — the external bidding engine writes to Amazon itself (it bypasses the write gate, list-automations A18),
 * so the bridge is its only check:
 *   owned     a keyword of a campaign the bid brain owns (the bids lever) is never handed out; counted in the log
 *   free      every other keyword exactly as before
 *   unread    the owner cannot be read under a live ceiling: no keyword at all this cycle (fail closed — never one that may
 *             be the brain's), the engine's next cycle asks again; it never crashes the engine's call
 *   applied   a report on a keyword the brain took in the meantime is still recorded (Nexus's copy matches Amazon) and
 *             said loudly
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  targets: vi.fn(), connections: vi.fn(), targetFindUnique: vi.fn(), targetUpdate: vi.fn(), logCreate: vi.fn(),
  owned: vi.fn(), live: { on: true }, warn: vi.fn(), info: vi.fn(),
}))
vi.mock('../../db.js', () => ({
  default: {
    adTarget: { findMany: h.targets, findUnique: h.targetFindUnique, update: h.targetUpdate },
    amazonAdsConnection: { findMany: h.connections },
    advertisingActionLog: { create: h.logCreate },
  },
}))
vi.mock('./ads-api-client.js', () => ({ adsMode: () => 'live' }))
vi.mock('./bid-brain/live.js', () => ({ brainLiveCeiling: () => h.live.on, brainOwnedCampaignIds: (...a: unknown[]) => h.owned(...a) }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: (...a: unknown[]) => h.warn(...a), info: (...a: unknown[]) => h.info(...a), debug: vi.fn(), error: vi.fn() } }))

const { getBidContexts, recordAppliedBid } = await import('./bidding-bridge.service.js')

const target = (id: string, campaignId: string) => ({
  id, externalTargetId: `EXT-${id}`, bidCents: 40, clicks: 20, spendCents: 800, salesCents: 4000, ordersCount: 2,
  adGroup: { campaignId, campaign: { marketplace: 'IT', dynamicBidding: {} } },
})

beforeEach(() => {
  vi.clearAllMocks()
  h.live.on = true
  h.targets.mockResolvedValue([target('t-gale', 'c-gale'), target('t-gale2', 'c-gale'), target('t-misano', 'c-misano')])
  h.connections.mockResolvedValue([{ marketplace: 'IT', profileId: 'P-IT' }])
  h.owned.mockResolvedValue(new Set())
  h.targetUpdate.mockResolvedValue({})
  h.logCreate.mockResolvedValue({})
})
afterEach(() => vi.unstubAllEnvs())

describe('getBidContexts — the bids lever of a bid brain campaign', () => {
  it('its keywords are never handed out; the rest as before; the keywords left out are counted', async () => {
    h.owned.mockResolvedValue(new Set(['c-gale']))
    const contexts = await getBidContexts({ marketplace: 'IT' })
    expect(contexts.map((c) => c.bridgeId)).toEqual(['t-misano'])
    expect(h.owned).toHaveBeenCalledWith(['c-gale', 'c-misano'])
    expect(h.info).toHaveBeenCalledWith(expect.stringContaining('keywords of bid brain campaigns left out'), expect.objectContaining({ lever: 'bids', keywords: 2 }))
  })

  it('nothing owned: every keyword exactly as before, nothing logged', async () => {
    const contexts = await getBidContexts({ marketplace: 'IT' })
    expect(contexts.map((c) => c.bridgeId)).toEqual(['t-gale', 't-gale2', 't-misano'])
    expect(h.info).not.toHaveBeenCalled()
  })

  it('the owner cannot be read: no keyword this cycle (fail closed), said, and no crash', async () => {
    h.owned.mockRejectedValue(new Error('db blip'))
    await expect(getBidContexts({ marketplace: 'IT' })).resolves.toEqual([])
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('no keyword is handed out this cycle'), expect.objectContaining({ keywords: 3 }))
  })
})

describe('recordAppliedBid — a keyword the brain took in the meantime', () => {
  it('still records the bid Amazon has, and says loudly the engine moved a bid brain keyword', async () => {
    h.targetFindUnique.mockResolvedValue({ adGroup: { campaignId: 'c-gale' } })
    h.owned.mockResolvedValue(new Set(['c-gale']))
    await recordAppliedBid({ bridgeId: 't-gale', bidMinor: 55, prevBidMinor: 40, status: 'applied' })
    expect(h.targetUpdate).toHaveBeenCalledWith({ where: { id: 't-gale' }, data: { bidCents: 55 } })
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('moved a keyword of a bid brain campaign'), expect.objectContaining({ lever: 'bids', campaignId: 'c-gale' }))
  })

  it('a keyword no brain holds, a failed report, or the ceiling not live: no check said, the record as before', async () => {
    h.targetFindUnique.mockResolvedValue({ adGroup: { campaignId: 'c-misano' } })
    await recordAppliedBid({ bridgeId: 't-misano', bidMinor: 55, status: 'applied' })
    await recordAppliedBid({ bridgeId: 't-misano', bidMinor: 55, status: 'failed' })
    h.live.on = false
    await recordAppliedBid({ bridgeId: 't-misano', bidMinor: 55, status: 'applied' })
    expect(h.warn).not.toHaveBeenCalled()
    expect(h.targetFindUnique).toHaveBeenCalledTimes(1)
    expect(h.logCreate).toHaveBeenCalledTimes(3)
  })

  it('the check cannot be read: the record still lands', async () => {
    h.targetFindUnique.mockRejectedValue(new Error('db blip'))
    await recordAppliedBid({ bridgeId: 't-gale', bidMinor: 55, status: 'applied' })
    expect(h.targetUpdate).toHaveBeenCalledTimes(1)
    expect(h.logCreate).toHaveBeenCalledTimes(1)
  })
})
