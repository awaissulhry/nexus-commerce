/**
 * ONE BRAIN AB-18 — the off-Amazon lane (brain/off-amazon.ts), pure: the labels, the share, the verdicts, the line for the
 * Owner and the view's money. A made-up product A in IT over the settled window 2026-09-18 → 2026-10-01 (two weeks), its
 * band top 25 %: campaign A1 (off Amazon above the band in both weeks), A2 (in band), a campaign shared with another
 * product and one the Owner excluded (both listed, never summed). Every value is made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { FIELDS } from '@nexus/shared/permissions'
import { financialPayloadCopy } from '../../../lib/auth/field-filter.js'
import { ADS_BRAIN_TOOLS } from '../../agents/tools/ads-brain.tools.js'
import { OFF_AMAZON } from '../ams-grain.js'
import {
  decideOffAmazon, isOffAmazon, laneOf, OFF_AMAZON_CAPABILITY, offAmazonShare, offAmazonView,
  type LaneCampaign, type OffAmazonInput, type PlacementRow,
} from './off-amazon.js'
import { BUSINESS_LABEL, OFF_AMAZON_LABEL } from './__fixtures__/off-amazon-report.js'

const WINDOW = { from: '2026-09-18', to: '2026-10-01' }
const DAYS = Array.from({ length: 14 }, (_, i) => new Date(Date.parse(`${WINDOW.from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10))
const WEEK2 = '2026-09-25'

type Off = { cost: number; sales: number; orders?: number }
/** One campaign's days: the on-Amazon placements as in the fixture, and its off-Amazon row from `off(day)`. */
function campaignRows(campaignId: string, off: (day: string) => Off | null, opts: { orders?: boolean } = {}): PlacementRow[] {
  const o = opts.orders ?? true
  return DAYS.flatMap((day) => {
    const rows: PlacementRow[] = [
      { campaignId, day, label: 'Top of Search on-Amazon', costCents: 400, salesCents: 1_600, orders: o ? 2 : 0, clicks: 10 },
      { campaignId, day, label: 'Other on-Amazon', costCents: 200, salesCents: 800, orders: o ? 1 : 0, clicks: 5 },
      { campaignId, day, label: 'Detail Page on-Amazon', costCents: 200, salesCents: 0, orders: 0, clicks: 5 },
      { campaignId, day, label: BUSINESS_LABEL, costCents: 50, salesCents: 0, orders: 0, clicks: 1 },
    ]
    const x = off(day)
    if (x) rows.push({ campaignId, day, label: OFF_AMAZON_LABEL, costCents: x.cost, salesCents: x.sales, orders: x.orders ?? (o && x.sales > 0 ? 1 : 0), clicks: 4 })
    return rows
  })
}

const CAMPAIGNS: LaneCampaign[] = [
  { campaignId: 'a1', name: 'Campaign A1', owner: 'product', excluded: false },
  { campaignId: 'a2', name: 'Campaign A2', owner: 'product', excluded: false },
  { campaignId: 'sh', name: 'Campaign AB shared', owner: 'shared', excluded: false },
  { campaignId: 'ex', name: 'Campaign A excluded', owner: 'product', excluded: true },
]
const week = (day: string) => (day < WEEK2 ? 1 : 2)
/** A1 above the band in both weeks (week 1 no sales, week 2 an ACoS of 100 %); A2 at 12.5 %; the shared and excluded ones far above. */
const ABOVE: PlacementRow[] = [
  ...campaignRows('a1', (d) => ({ cost: 100, sales: week(d) === 1 ? 0 : 100 })),
  ...campaignRows('a2', () => ({ cost: 50, sales: 400 })),
  ...campaignRows('sh', () => ({ cost: 5_000, sales: 0 })),
  ...campaignRows('ex', () => ({ cost: 5_000, sales: 0 })),
]

const input = (over: Partial<OffAmazonInput> = {}): OffAmazonInput => ({
  productId: 'prod-a', name: 'Product A', market: 'IT', currency: 'EUR', window: WINDOW,
  campaigns: CAMPAIGNS, rows: ABOVE, stream: null,
  bandTop: { hi: 0.25, words: 'target ACoS 20 %, band up to 25 %' },
  lever: { effective: 'OBSERVE', lock: null },
  ...over,
})

describe('AB-18 — the labels', () => {
  it('one classifier with the Marketing Stream: the managed lanes, a label naming off Amazon, and anything else kept by its own name', () => {
    expect(laneOf('Top of Search on-Amazon')).toBe('PLACEMENT_TOP')
    expect(laneOf('Other on-Amazon')).toBe('PLACEMENT_REST_OF_SEARCH')
    expect(laneOf('Detail Page on-Amazon')).toBe('PLACEMENT_PRODUCT_PAGE')
    for (const off of [OFF_AMAZON_LABEL, 'Off-Amazon', 'off amazon']) expect(laneOf(off)).toBe(OFF_AMAZON)
    // Amazon Business is on Amazon: never counted as the off-Amazon lane.
    expect(laneOf(BUSINESS_LABEL)).toBe(`OTHER:${BUSINESS_LABEL}`)
    expect(isOffAmazon(BUSINESS_LABEL)).toBe(false)
  })

  it('what Nexus could verify, said as such: the report keeps every label, the label and the setting could not be verified', () => {
    expect(OFF_AMAZON_CAPABILITY.report.how).toMatch(/Could not verify which label/)
    expect(OFF_AMAZON_CAPABILITY.setting).toMatchObject({ read: 'none', write: 'none' })
    expect(OFF_AMAZON_CAPABILITY.setting.how).toMatch(/^could not verify/)
  })
})

describe('AB-18 — the share and the verdict', () => {
  it('above the band top in both weeks: limit suggested on the campaign that is above, with a line for the Owner that names no amount', () => {
    const lane = decideOffAmazon(input())
    expect(lane).toMatchObject({ status: 'measured', verdict: 'limit_suggested', window: { from: WINDOW.from, to: WINDOW.to, days: 14 } })
    // Only A1 and A2 are summed: (100 + 50) × 14 days of off-Amazon spend against (950 + 900) × 14 of every placement's.
    expect(lane.product).toMatchObject({ campaigns: 2, offSpendCents: 2_100, offSalesCents: 6_300, spendCents: 25_900, sharePct: 8.11, offAcosPct: 33.33, offNoSales: false })
    expect(lane.halves.map((h) => [h.from, h.to, h.offAcosPct, h.above])).toEqual([['2026-09-18', '2026-09-24', 37.5, true], ['2026-09-25', '2026-10-01', 30, true]])
    expect(lane.limit).toEqual([{ campaignId: 'a1', name: 'Campaign A1' }])
    expect(lane.campaigns.map((c) => [c.campaignId, c.summed, c.above])).toEqual([['a1', true, true], ['a2', true, false], ['sh', false, true], ['ex', false, true]])
    expect(lane.ownerLine).toBe('Off-Amazon placements of Product A (IT) stayed above the band top for 14 settled days: set "Limit off-Amazon spend" in Amazon\'s console on "Campaign A1". Nexus could not verify an Amazon Ads API setting for it, so the brain cannot ask for it or write it.')
    expect(lane.ownerLine).not.toMatch(/€|\d+ ?%|\d+[.,]\d{2}/)
    expect(lane.why).toMatch(/stayed above the band top \(25 %\) in both weeks \(37\.5 %, 30 %\)/)
    expect(lane.labels).toEqual([
      { label: BUSINESS_LABEL, lane: `OTHER:${BUSINESS_LABEL}` }, { label: 'Detail Page on-Amazon', lane: 'PLACEMENT_PRODUCT_PAGE' },
      { label: OFF_AMAZON_LABEL, lane: OFF_AMAZON }, { label: 'Other on-Amazon', lane: 'PLACEMENT_REST_OF_SEARCH' }, { label: 'Top of Search on-Amazon', lane: 'PLACEMENT_TOP' },
    ])
  })

  it('above over the window but not in both weeks: above the band, watched, no line', () => {
    // Week 2: A1 sells 200 a day off Amazon, so that week sits exactly at the band top (not above); the window is still above.
    const rows = [...campaignRows('a1', (d) => ({ cost: 100, sales: week(d) === 1 ? 0 : 200 })), ...campaignRows('a2', () => ({ cost: 50, sales: 400 }))]
    const lane = decideOffAmazon(input({ rows }))
    expect(lane.halves.map((h) => h.above)).toEqual([true, false])
    expect(lane).toMatchObject({ verdict: 'above_band', limit: [], ownerLine: null })
    expect(lane.product.offAcosPct).toBe(30)
  })

  it('within the band top: in band, no line', () => {
    const rows = [...campaignRows('a1', () => ({ cost: 50, sales: 400 })), ...campaignRows('a2', () => ({ cost: 50, sales: 400 }))]
    expect(decideOffAmazon(input({ rows }))).toMatchObject({ verdict: 'in_band', ownerLine: null, product: { offAcosPct: 12.5 } })
  })

  it('too little to judge: below one order\'s worth at the band top, or no ad order in the window to price one', () => {
    const small = decideOffAmazon(input({ rows: [...campaignRows('a1', () => ({ cost: 1, sales: 0 })), ...campaignRows('a2', () => null)] }))
    expect(small).toMatchObject({ verdict: 'too_little', ownerLine: null })
    expect(small.gateCents).toBe(200) // order value 800 (2,400 cents of sales over 3 orders a day) × 25 %
    const unpriced = decideOffAmazon(input({ rows: [...campaignRows('a1', () => ({ cost: 100, sales: 0 }), { orders: false }), ...campaignRows('a2', () => null, { orders: false })] }))
    expect(unpriced).toMatchObject({ verdict: 'too_little', gateCents: null })
    expect(unpriced.why).toMatch(/no ad order in the window to price one order/)
  })

  it('no placement row at all: could not measure; rows naming no off-Amazon placement: none reported, never "no spend"', () => {
    expect(decideOffAmazon(input({ rows: [] }))).toMatchObject({ status: 'no_report', verdict: 'no_report', ownerLine: null })
    const none = decideOffAmazon(input({ rows: [...campaignRows('a1', () => null), ...campaignRows('a2', () => null)] }))
    expect(none).toMatchObject({ status: 'none_reported', verdict: 'none_reported', ownerLine: null })
    expect(none.why).toMatch(/could not verify the label Amazon gives it, so this is not "no spend"/)
    // Off-Amazon rows only on the shared and excluded campaigns: the product's own report names none.
    expect(decideOffAmazon(input({ rows: [...campaignRows('a1', () => null), ...campaignRows('sh', () => ({ cost: 900, sales: 0 }))] })).status).toBe('none_reported')
  })

  it('no ACoS goal: the band top is unknown, the lane is shown and not judged', () => {
    expect(decideOffAmazon(input({ bandTop: null }))).toMatchObject({ status: 'measured', verdict: 'no_band', gateCents: null, ownerLine: null })
  })
})

describe('AB-18 — the lever and the Owner', () => {
  it('OFF judges nothing; an excluded product is left', () => {
    expect(decideOffAmazon(input({ lever: { effective: 'OFF', lock: null } }))).toMatchObject({ verdict: 'off', ownerLine: null, limit: [], status: 'measured' })
    expect(decideOffAmazon(input({ lever: { effective: 'EXCLUDED', lock: null } }))).toMatchObject({ verdict: 'excluded', ownerLine: null })
  })

  it('the Owner\'s lock wins: at LIMIT the line asks him to check his console; otherwise a recommendation against his lock', () => {
    const limit = decideOffAmazon(input({ lever: { effective: 'LOCKED', lock: { value: 'LIMIT', by: 'user:owner' } } }))
    expect(limit.ownerLine).toBe('Off-Amazon placements of Product A (IT) stayed above the band top for 14 settled days; your lock holds the off-Amazon setting at LIMIT: check in Amazon\'s console that "Limit off-Amazon spend" is set on "Campaign A1" (Nexus cannot read it).')
    const reach = decideOffAmazon(input({ lever: { effective: 'LOCKED', lock: { value: 'INCREASE_REACH', by: 'user:owner' } } }))
    expect(reach.ownerLine).toMatch(/a recommendation against your lock \("Increase reach"\) — "Limit off-Amazon spend" on "Campaign A1" in Amazon's console; nothing changes unless you change it/)
    expect(reach.lever).toEqual({ effective: 'LOCKED', lockValue: 'INCREASE_REACH' })
  })

  it('a product not enrolled is decided as at the default level, and says so', () => {
    const lane = decideOffAmazon(input({ lever: { effective: 'NOT_ENROLLED', lock: null } }))
    expect(lane.verdict).toBe('limit_suggested')
    expect(lane.why).toMatch(/\(not enrolled: decided as at the default level, OBSERVE\)$/)
  })
})

describe('AB-18 — the view', () => {
  const tool = ADS_BRAIN_TOOLS[0]
  const ALL_FIELDS = Object.values(FIELDS)
  const view = offAmazonView(decideOffAmazon(input({ stream: { costCents: 2_000, salesCents: 6_000, orders: 7, hours: 120 } })))

  it('verdict, labels, the campaigns to limit and the line visible; every amount, ACoS and share under money', () => {
    expect(view).toMatchObject({ status: 'measured', verdict: 'limit_suggested', limit: [{ campaignId: 'a1' }], stream: { hours: 120 }, capability: OFF_AMAZON_CAPABILITY })
    // The gate: order value 700 (73,500 cents of sales over 105 orders) × 25 %.
    expect(view.money).toMatchObject({ currency: 'EUR', offSpendCents: 2_100, sharePct: 8.11, offAcosPct: 33.33, gateCents: 175 })
    const noMoney = { isOwner: false, permissions: new Set<string>(ALL_FIELDS.filter((f) => f !== FIELDS.financialsAdspendView && f !== FIELDS.financialsView)) }
    const text = JSON.stringify(financialPayloadCopy(view, noMoney, tool.restrictedFields))
    expect(text).toBe(JSON.stringify(view, (k, v) => (k === 'money' ? undefined : v)))
    for (const amount of ['€', '2100', '8.11', '33.33', '37.5', '6300', '175']) expect(text).not.toContain(amount)
    expect(text).toContain('Limit off-Amazon spend')
  })

  it('the market\'s share line: the status and, under money, the figures', () => {
    expect(offAmazonShare(decideOffAmazon(input()))).toEqual({ status: 'measured', money: { currency: 'EUR', spendCents: 25_900, offSpendCents: 2_100, sharePct: 8.11, offAcosPct: 33.33, offNoSales: false } })
  })
})
