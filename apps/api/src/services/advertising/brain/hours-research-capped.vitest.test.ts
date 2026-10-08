/**
 * Batch 2 fix — the hour research's loader reads the grain's capped days (ams-grain.service.ts loadPlacementHours
 * `cappedDays`): on a UTC data day whose ad group × placement grain the ingest capped (kind `rows`), every hour comes from
 * the campaign grain instead, so an incomplete hour never reads low; a capped hour neither source holds is counted as
 * missing (the research then lowers its confidence: hours-research.vitest.test.ts). A capped `arrivals` day (rows whole,
 * only the arrival log short) changes nothing. The grain and the campaign grain are mocked. Every value is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  grain: { cells: [] as Array<Record<string, unknown>>, cappedDays: [] as Array<{ date: string; kind: string; cap: number; refusedAtLeast: number }> },
  campaignRows: [] as Array<Record<string, unknown>>,
}))
vi.mock('../ams-grain.service.js', () => ({
  loadPlacementHours: vi.fn(async () => ({ timeZone: 'Europe/Rome', today: '2026-10-08', days: [], cells: h.grain.cells, lastArrivalAt: null, lateStartCells: 0, negativeCells: 0, unlinked: [], cappedDays: h.grain.cappedDays })),
}))
vi.mock('../../../db.js', () => ({ default: { $queryRaw: vi.fn(async () => h.campaignRows) } }))

const { loadCampaignHours, utcDayOfLocalHour } = await import('./hours-research.js')

const NOW = new Date('2026-10-08T10:00:00Z')
const DAYS = ['2026-10-05', '2026-10-06', '2026-10-07']
const cell = (day: string, hour: number, clicks: number) => ({ campaignId: 'c1', placement: 'TOP_OF_SEARCH', day, hour, impressions: clicks * 10, clicks, spendCents: clicks * 50, orders1d: 0, orders7d: 0, sales1dCents: 0, sales7dCents: 0, lateStart: false })
/** A campaign-grain row at a UTC date and hour (Rome is UTC+2 in October). */
const row = (date: string, hour: number, clicks: number) => ({ entityId: 'EXT-1', date: new Date(`${date}T00:00:00Z`), hour, impressions: BigInt(clicks * 10), clicks: BigInt(clicks), costMicros: BigInt(clicks * 500_000), orders: 0n, sales: 0n })

beforeEach(() => { h.grain.cells = []; h.grain.cappedDays = []; h.campaignRows = [] })

describe('batch 2 fix — capped grain days in the hour research', () => {
  it('a local hour\'s UTC date (Rome in summer time, and UTC itself)', () => {
    expect(utcDayOfLocalHour('2026-10-06', 1, 'Europe/Rome')).toBe('2026-10-05')
    expect(utcDayOfLocalHour('2026-10-06', 2, 'Europe/Rome')).toBe('2026-10-06')
    expect(utcDayOfLocalHour('2026-10-06', 23, 'UTC')).toBe('2026-10-06')
  })

  it('nothing capped: the grain where it holds the hour, the campaign grain elsewhere — as before', async () => {
    h.grain.cells = [cell('2026-10-06', 14, 4)]
    h.campaignRows = [row('2026-10-06', 12, 9), row('2026-10-06', 13, 3)] // local 14:00 (the grain holds it) and 15:00
    const out = await loadCampaignHours([{ id: 'c1', externalCampaignId: 'EXT-1' }], DAYS, NOW, 'Europe/Rome')
    expect(out).toMatchObject({ placementGrainHours: 1, campaignGrainHours: 1, cappedDays: [], cappedGrainHours: 0, cappedUnfilledHours: 0 })
    expect(out.cells.get('c1')!.get('2026-10-06|14')!.clicks).toBe(4)
    expect(out.cells.get('c1')!.get('2026-10-06|15')!.clicks).toBe(3)
  })

  it('a capped day: its grain hours left out, the campaign grain read for every hour of it; a hour neither holds is counted', async () => {
    h.grain.cappedDays = [{ date: '2026-10-06', kind: 'rows', cap: 1000, refusedAtLeast: 5 }]
    // Local 14:00 and 16:00 on the 6th fall on UTC 2026-10-06 (capped); local 01:00 on the 6th is UTC the 5th (not capped).
    h.grain.cells = [cell('2026-10-06', 14, 4), cell('2026-10-06', 16, 2), cell('2026-10-06', 1, 7)]
    h.campaignRows = [row('2026-10-06', 12, 9)] // local 14:00 only: 16:00 is in neither source once the grain is left out
    const out = await loadCampaignHours([{ id: 'c1', externalCampaignId: 'EXT-1' }], DAYS, NOW, 'Europe/Rome')
    expect(out.cells.get('c1')!.get('2026-10-06|14')!.clicks).toBe(9) // the campaign grain's, never the incomplete grain's
    expect(out.cells.get('c1')!.get('2026-10-06|16')).toBeUndefined()
    expect(out.cells.get('c1')!.get('2026-10-06|1')!.clicks).toBe(7)
    expect(out).toMatchObject({ placementGrainHours: 1, campaignGrainHours: 1, cappedDays: ['2026-10-06'], cappedGrainHours: 2, cappedUnfilledHours: 1 })
  })

  it('a capped day of the window none of these campaigns\' grain hours fell on still counts (its refused records may be theirs); an `arrivals` cap changes nothing', async () => {
    h.grain.cappedDays = [{ date: '2026-10-07', kind: 'rows', cap: 1000, refusedAtLeast: 1 }, { date: '2026-10-05', kind: 'arrivals', cap: 1000, refusedAtLeast: 1 }]
    h.grain.cells = [cell('2026-10-05', 14, 4)]
    const out = await loadCampaignHours([{ id: 'c1', externalCampaignId: 'EXT-1' }], DAYS, NOW, 'Europe/Rome')
    expect(out).toMatchObject({ placementGrainHours: 1, cappedDays: ['2026-10-07'], cappedGrainHours: 0, cappedUnfilledHours: 0 })
    // A capped day outside the window is not this research's.
    h.grain.cappedDays = [{ date: '2026-09-01', kind: 'rows', cap: 1000, refusedAtLeast: 1 }]
    expect((await loadCampaignHours([{ id: 'c1', externalCampaignId: 'EXT-1' }], DAYS, NOW, 'Europe/Rome')).cappedDays).toEqual([])
  })
})
