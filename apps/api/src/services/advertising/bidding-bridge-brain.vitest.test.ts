/**
 * ONE BRAIN AB-6 — the external bidding engine writes to Amazon itself (it bypasses the write gate, list-automations A18),
 * so the bridge is its only check:
 *   owned     a keyword of a campaign the bid brain owns (the bids lever) is never handed out — left out IN the query, so
 *             it never takes a place in the engine's batch (follow-up of #527) — and counted in the log in the bid brain's
 *             own words; the batch has a stable order (oldest keyword first)
 *   free      every other keyword exactly as before
 *   unread    the owner cannot be read under a live ceiling: no keyword at all this cycle (fail closed — never one that may
 *             be the brain's), the engine's next cycle asks again; it never crashes the engine's call
 *   applied   a report on a keyword the brain took in the meantime is still recorded (Nexus's copy matches Amazon) and
 *             said loudly
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  targets: vi.fn(), count: vi.fn(), connections: vi.fn(), targetFindUnique: vi.fn(), targetUpdate: vi.fn(), logCreate: vi.fn(),
  owned: vi.fn(), live: { on: true }, warn: vi.fn(), info: vi.fn(),
}))
vi.mock('../../db.js', () => ({
  default: {
    adTarget: { findMany: h.targets, count: h.count, findUnique: h.targetFindUnique, update: h.targetUpdate },
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
  const where = () => (h.targets.mock.calls[0][0] as { where: Record<string, any> }).where

  it('its keywords are left out IN the query — they never take a place in the batch — and counted in the bid brain\'s words', async () => {
    h.owned.mockResolvedValue(new Set(['c-gale']))
    h.targets.mockResolvedValue([target('t-misano', 'c-misano')])
    h.count.mockResolvedValue(2)
    const contexts = await getBidContexts({ marketplace: 'IT', limit: 1 })
    expect(contexts.map((c) => c.bridgeId)).toEqual(['t-misano'])
    expect(h.owned).toHaveBeenCalledWith() // every campaign the bid brain owns, read once, before the batch
    expect(where().adGroup).toEqual({ campaign: { marketplace: 'IT', liveBidWritesEnabled: true }, campaignId: { notIn: ['c-gale'] } })
    expect(h.targets.mock.calls[0][0]).toMatchObject({ take: 1, orderBy: { id: 'asc' } })
    expect((h.count.mock.calls[0][0] as { where: Record<string, any> }).where.adGroup).toEqual({ campaign: { marketplace: 'IT', liveBidWritesEnabled: true }, campaignId: { in: ['c-gale'] } })
    expect(h.info).toHaveBeenCalledWith('bidding bridge: keywords of bid brain campaigns left out — the bid brain runs their keyword bids (one owner per lever)', expect.objectContaining({ lever: 'bids', keywords: 2, bidBrainCampaigns: 1 }))
  })

  it('nothing owned: the same query as before (no exclusion), a stable order, no count, nothing logged', async () => {
    const contexts = await getBidContexts({ marketplace: 'IT' })
    expect(contexts.map((c) => c.bridgeId)).toEqual(['t-gale', 't-gale2', 't-misano'])
    expect(where().adGroup).toEqual({ campaign: { marketplace: 'IT', liveBidWritesEnabled: true } })
    expect(h.targets.mock.calls[0][0]).toMatchObject({ orderBy: { id: 'asc' } })
    expect(h.count).not.toHaveBeenCalled()
    expect(h.info).not.toHaveBeenCalled()
  })

  it('the owner cannot be read: no keyword this cycle (fail closed), said, no query, and no crash', async () => {
    h.owned.mockRejectedValue(new Error('db blip'))
    await expect(getBidContexts({ marketplace: 'IT' })).resolves.toEqual([])
    expect(h.targets).not.toHaveBeenCalled()
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('no keyword is handed out this cycle'), expect.objectContaining({ error: 'db blip' }))
  })

  it('a failed count is only not said: the batch is handed out as read', async () => {
    h.owned.mockResolvedValue(new Set(['c-gale']))
    h.targets.mockResolvedValue([target('t-misano', 'c-misano')])
    h.count.mockRejectedValue(new Error('db blip'))
    expect((await getBidContexts({ marketplace: 'IT' })).map((c) => c.bridgeId)).toEqual(['t-misano'])
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
