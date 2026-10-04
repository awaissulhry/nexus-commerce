/**
 * G.4 — `updatePlacementBidding` reads Amazon's current placement array before the PUT and merges onto
 * it, driven for real with mocked I/O:
 *  - the read happens BEFORE the PUT, through the same client (and so the same gateway path);
 *  - a lane the write only carried from the local copy goes out at Amazon's value, and the local copy
 *    becomes what was sent;
 *  - a failed read refuses the write: no PUT, no local change, a FAILED audit row and the refused shape
 *    (`ok:false`, `mode:'blocked'`, `deniedAt:'placement_read'`, a sentence);
 *  - a gate denial still costs no read; sandbox sends the array as given without a read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as string[],
  mode: 'live' as 'live' | 'sandbox',
  findUnique: vi.fn(),
  campaignUpdate: vi.fn(),
  historyCreateMany: vi.fn(),
  actionLogCreate: vi.fn(),
  connFindFirst: vi.fn(),
  listCampaignsV3: vi.fn(),
  updateCampaign: vi.fn(),
  checkAdsWriteGate: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    campaign: { findUnique: h.findUnique, update: h.campaignUpdate },
    campaignBidHistory: { createMany: h.historyCreateMany },
    advertisingActionLog: { create: h.actionLogCreate },
    amazonAdsConnection: { findFirst: h.connFindFirst },
  },
}))
vi.mock('./ads-api-client.js', () => ({
  adsMode: () => h.mode,
  listCampaignsV3: h.listCampaignsV3,
  updateCampaign: h.updateCampaign,
}))
vi.mock('./ads-write-gate.js', () => ({ checkAdsWriteGate: h.checkAdsWriteGate }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: h.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { updatePlacementBidding } from './ads-create.service.js'

const TOP = 'PLACEMENT_TOP', PP = 'PLACEMENT_PRODUCT_PAGE', REST = 'PLACEMENT_REST_OF_SEARCH'
const LOCAL = [{ placement: TOP, percentage: 50 }, { placement: PP, percentage: 0 }]
const pmap = (arr: Array<{ placement: string; percentage: number }>) => Object.fromEntries(arr.map((x) => [x.placement, x.percentage]))
const sentArray = () => (h.updateCampaign.mock.calls[0][2] as { placementBidding: Array<{ placement: string; percentage: number }> }).placementBidding
const storedArray = () => (h.campaignUpdate.mock.calls[0][0] as { data: { dynamicBidding: { placementBidding: Array<{ placement: string; percentage: number }> } } }).data.dynamicBidding.placementBidding
const auditRow = () => (h.actionLogCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data

beforeEach(() => {
  vi.clearAllMocks()
  h.calls.length = 0
  h.mode = 'live'
  h.findUnique.mockResolvedValue({ externalCampaignId: 'EXT-1', marketplace: 'IT', dynamicBidding: { strategy: 'LEGACY_FOR_SALES', placementBidding: LOCAL } })
  h.campaignUpdate.mockResolvedValue({})
  h.historyCreateMany.mockResolvedValue({ count: 0 })
  h.actionLogCreate.mockResolvedValue({})
  h.connFindFirst.mockResolvedValue({ profileId: 'P1', region: 'EU' })
  h.checkAdsWriteGate.mockImplementation(async () => { h.calls.push('gate'); return { allowed: true } })
  // Amazon now: the console raised Product pages to 40 since the last sync.
  h.listCampaignsV3.mockImplementation(async () => {
    h.calls.push('read')
    return [{ campaignId: 'EXT-1', dynamicBidding: { strategy: 'LEGACY_FOR_SALES', placementBidding: [{ placement: TOP, percentage: 50 }, { placement: PP, percentage: 40 }] } }]
  })
  h.updateCampaign.mockImplementation(async () => { h.calls.push('put'); return { ok: true, mode: 'live', rawResponse: {} } })
})

describe('updatePlacementBidding — read Amazon before every placement PUT (G.4)', () => {
  it('reads the campaign\'s current settings first, then PUTs the merged array (console edit to Product pages survives)', async () => {
    // a Top move built from the local copy: carries Product 0
    const r = await updatePlacementBidding({ campaignId: 'c1', adjustments: [{ placement: TOP, percentage: 80 }, { placement: PP, percentage: 0 }], actor: 'automation:rank-defend-s1' })

    expect(h.calls).toEqual(['gate', 'read', 'put'])
    expect(h.listCampaignsV3).toHaveBeenCalledWith({ profileId: 'P1', region: 'EU' }, { campaignIds: ['EXT-1'] })
    expect(pmap(sentArray())).toEqual({ [TOP]: 80, [PP]: 40 })
    // the local copy becomes what was sent, and the result says what was sent
    expect(pmap(storedArray())).toEqual({ [TOP]: 80, [PP]: 40 })
    expect(r).toMatchObject({ ok: true, mode: 'live' })
    expect(pmap(r.adjustments)).toEqual({ [TOP]: 80, [PP]: 40 })
    // drift is logged and kept on the audit row
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('placement drift'), expect.objectContaining({ drift: [{ placement: PP, local: 0, amazon: 40 }] }))
    expect((auditRow().payloadAfter as { drift?: unknown }).drift).toEqual([{ placement: PP, local: 0, amazon: 40 }])
    // history: one row, the lane that actually changed on Amazon, old value = Amazon's
    const rows = (h.historyCreateMany.mock.calls[0][0] as { data: Array<{ field: string; oldValue: string | null; newValue: string }> }).data
    expect(rows).toEqual([expect.objectContaining({ field: TOP, oldValue: '50', newValue: '80' })])
    // the undo snapshot is Amazon's array before the write, not the stale local copy
    expect(pmap((auditRow().payloadBefore as { adjustments: Array<{ placement: string; percentage: number }> }).adjustments)).toEqual({ [TOP]: 50, [PP]: 40 })
  })

  it('a failed read refuses the write: no PUT, no local change, a retryable sentence', async () => {
    h.listCampaignsV3.mockImplementation(async () => { h.calls.push('read'); throw new Error('[ADS-LIVE] POST /sp/campaigns/list → 503: unavailable') })

    const r = await updatePlacementBidding({ campaignId: 'c1', adjustments: [{ placement: TOP, percentage: 80 }, { placement: PP, percentage: 0 }] })

    expect(h.calls).toEqual(['gate', 'read'])
    expect(h.updateCampaign).not.toHaveBeenCalled()
    expect(h.campaignUpdate).not.toHaveBeenCalled()
    expect(h.historyCreateMany).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
    expect(r.mode).toBe('blocked')
    expect(r.deniedAt).toBe('placement_read')
    expect(r.reason).toMatch(/could not be read.*nothing was sent.*safe to try again/i)
    expect(r.adjustments).toEqual(LOCAL)
    expect(auditRow().amazonResponseStatus).toBe('FAILED')
  })

  it('Amazon not returning the campaign, or returning it without placement settings, is a failed read too', async () => {
    h.listCampaignsV3.mockResolvedValueOnce([])
    const a = await updatePlacementBidding({ campaignId: 'c1', adjustments: [{ placement: TOP, percentage: 80 }] })
    h.listCampaignsV3.mockResolvedValueOnce([{ campaignId: 'EXT-1', state: 'ENABLED' }])
    const b = await updatePlacementBidding({ campaignId: 'c1', adjustments: [{ placement: TOP, percentage: 80 }] })

    for (const r of [a, b]) expect(r).toMatchObject({ ok: false, mode: 'blocked', deniedAt: 'placement_read' })
    expect(h.updateCampaign).not.toHaveBeenCalled()
    expect(h.campaignUpdate).not.toHaveBeenCalled()
  })

  it('Amazon reporting no lanes at all (placementBidding left out) is a real answer: lanes the write does not set stay at 0', async () => {
    h.listCampaignsV3.mockResolvedValueOnce([{ campaignId: 'EXT-1', dynamicBidding: { strategy: 'LEGACY_FOR_SALES' } }])
    await updatePlacementBidding({ campaignId: 'c1', adjustments: [{ placement: TOP, percentage: 50 }, { placement: REST, percentage: 30 }] })
    // Top carried at its local 50 → Amazon's 0 (absent, so not listed); Rest set → 30
    expect(sentArray()).toEqual([{ placement: REST, percentage: 30 }])
  })

  it('resend (the failed-write sweep) sends its values over Amazon\'s', async () => {
    h.findUnique.mockResolvedValueOnce({ externalCampaignId: 'EXT-1', marketplace: 'IT', dynamicBidding: { placementBidding: [{ placement: TOP, percentage: 80 }] } })
    await updatePlacementBidding({ campaignId: 'c1', adjustments: [{ placement: TOP, percentage: 80 }], resend: true })
    expect(pmap(sentArray())).toEqual({ [TOP]: 80, [PP]: 40 })
  })

  it('a gate denial costs no read', async () => {
    h.checkAdsWriteGate.mockResolvedValueOnce({ allowed: false, reason: 'pinned', deniedAt: 'authority_pin' })
    const r = await updatePlacementBidding({ campaignId: 'c1', adjustments: [{ placement: TOP, percentage: 80 }] })
    expect(h.listCampaignsV3).not.toHaveBeenCalled()
    expect(h.updateCampaign).not.toHaveBeenCalled()
    expect(r).toMatchObject({ ok: false, deniedAt: 'authority_pin' })
  })

  it('sandbox has no Amazon to read: no read, the array goes as given', async () => {
    h.mode = 'sandbox'
    h.updateCampaign.mockResolvedValueOnce({ ok: true, mode: 'sandbox', rawResponse: {} })
    await updatePlacementBidding({ campaignId: 'c1', adjustments: [{ placement: TOP, percentage: 80 }, { placement: PP, percentage: 0 }] })
    expect(h.listCampaignsV3).not.toHaveBeenCalled()
    expect(sentArray()).toEqual([{ placement: TOP, percentage: 80 }, { placement: PP, percentage: 0 }])
  })
})
