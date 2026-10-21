/**
 * Meta ads step 44 (master IN-102) — the Meta anomaly signal and detect-anomalies' Meta part. The account's days and the
 * notices are stand-ins (no database, no Meta call); the computation is real. Made-up ids and names only.
 *
 *   day breaks   a day 2 standard deviations and 20 % away from the earlier days, with IH.9's severities; spend moving
 *                is "changed", a cost-per-purchase rise or a ROAS fall "worse", a click-through-rate fall "worse"
 *   shifts       the checked days together moving 25 % or more (50 %: critical), with enough volume on both sides
 *   honesty      an unread day is never a zero (named, left out); too little history is said per metric; a purchase-based
 *                worsening in Meta's restated days says so; no amount in a sentence
 *   volume       (review fix) a day below 40 % of the median spend day is left out of cost per purchase and ROAS, in the
 *                history and in the checked days; earlier days with no spread are said, not skipped
 *   loader       not connected / no ad account in words; Meta's own pushes once per subject; the account's status
 *   the tool     channel alerts keeps the old answer; meta needs the ads view permission; money under money keys only,
 *                gone for a person without the ad-spend permission; (review fix) any error of the Meta part leaves the
 *                alerts standing with channel all
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  overview: null as null | Record<string, unknown>,
  overviewArgs: [] as unknown[],
  notices: [] as Array<Record<string, unknown>>,
  noticeWhere: [] as unknown[],
  alerts: [] as Array<Record<string, unknown>>,
  overviewError: null as null | Error,
}))
vi.mock('../../../db.js', () => ({
  default: {
    notification: { findMany: vi.fn(async (q: { where: unknown }) => { h.noticeWhere.push(q.where); return h.notices }) },
    alertEvent: { findMany: vi.fn(async () => h.alerts) },
  },
}))
// The visibleTo check loads the tool door (call-tool.ts), which reaches the queues: no Redis in a unit test.
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('./read.service.js', async (importActual) => ({
  ...(await importActual<typeof import('./read.service.js')>()),
  metaAdsOverview: vi.fn(async (input: unknown) => { h.overviewArgs.push(input); if (h.overviewError) throw h.overviewError; return h.overview }),
}))

import { metaAnomaliesOf, metaAnomalySignal, META_ANOMALY_HISTORY_DAYS } from './anomaly-signal.js'
import type { MetaAdsDay } from './read.service.js'
import { addDays } from './dates.js'

type Numbers = { spendCents: number; impressions: number; clicks: number; purchases: number; purchaseValueCents: number }
/** One read day as the daily read's overview gives it (ratios from its own numbers). */
function day(date: string, n: Numbers, provisional = false): MetaAdsDay {
  return {
    date, provisional, read: true, reach: null, impressions: n.impressions, clicks: n.clicks, linkClicks: n.clicks,
    spendCents: n.spendCents, purchases: n.purchases, purchaseValueCents: n.purchaseValueCents,
    ctr: n.impressions > 0 ? n.clicks / n.impressions : null,
    cpcCents: n.clicks > 0 ? Math.round(n.spendCents / n.clicks) : null,
    cpmCents: n.impressions > 0 ? Math.round((n.spendCents * 1000) / n.impressions) : null,
    roas: n.spendCents > 0 ? n.purchaseValueCents / n.spendCents : null,
    costPerPurchaseCents: n.purchases > 0 ? Math.round(n.spendCents / n.purchases) : null,
  }
}
const unread = (date: string): MetaAdsDay => ({ date, provisional: false, read: false, impressions: null, clicks: null, linkClicks: null, spendCents: null, purchases: null, purchaseValueCents: null, ctr: null, cpcCents: null, cpmCents: null, roas: null, costPerPurchaseCents: null, reach: null })

const START = '2026-08-01'
/** A steady history: a small weekly wobble (it sums to zero over 7 days) around 10.00 spend, 2,000 impressions, 40 clicks, 2 purchases worth 50.00. */
function history(count: number, from = START): MetaAdsDay[] {
  return Array.from({ length: count }, (_, i) => {
    const w = [0, 1, -1, 2, -2, 1, -1][i % 7]
    return day(addDays(from, i), { spendCents: 1000 + w * 20, impressions: 2000 + w * 30, clicks: 40 + w, purchases: 2, purchaseValueCents: 5000 + w * 150 })
  })
}
const normal = (date: string, provisional = false) => day(date, { spendCents: 1000, impressions: 2000, clicks: 40, purchases: 2, purchaseValueCents: 5000 }, provisional)

describe('metaAnomaliesOf — day breaks', () => {
  it('a steady week against a steady history: nothing', () => {
    const past = history(30)
    const week = Array.from({ length: 7 }, (_, i) => normal(addDays(START, 30 + i)))
    expect(metaAnomaliesOf(past, week)).toEqual({ anomalies: [], notChecked: [] })
  })
  it('a spend spike is "changed", critical past 3 standard deviations, with the value and the usual one under spendCents', () => {
    const past = history(28)
    const spike = day(addDays(START, 28), { spendCents: 3000, impressions: 6000, clicks: 120, purchases: 6, purchaseValueCents: 15000 })
    const { anomalies } = metaAnomaliesOf(past, [spike])
    const spend = anomalies.find((a) => a.kind === 'day' && a.metric === 'spend')!
    expect(spend).toMatchObject({ direction: 'up', reads: 'changed', severity: 'critical', date: spike.date, observed: { spendCents: 3000 }, usual: { spendCents: 1000 } })
    expect(spend.zScore).toBeGreaterThan(3)
    expect(spend.sentence).toMatch(/^Spend on 2026-08-29 was far above the account's usual day \(\d+(\.\d)? standard deviations; changed\)\.$/)
    // No amount in a sentence: neither the value nor the usual one.
    expect(spend.sentence).not.toMatch(/3000|1000|30\.00|10\.00/)
  })
  it('a purchase tracking that stopped: ROAS 0 on a day that spent is worse; inside Meta\'s restated days it says it can ease', () => {
    const past = history(30)
    const stopped = day(addDays(START, 30), { spendCents: 1000, impressions: 2000, clicks: 40, purchases: 0, purchaseValueCents: 0 }, true)
    const { anomalies } = metaAnomaliesOf(past, [stopped])
    const roas = anomalies.find((a) => a.metric === 'roas' && a.kind === 'day')!
    expect(roas).toMatchObject({ direction: 'down', reads: 'worse', observed: { roas: 0 }, provisional: true })
    expect(roas.sentence).toMatch(/late purchases/)
    // No purchase that day: its cost per purchase is not judged (never a zero or an infinity).
    expect(anomalies.some((a) => a.metric === 'costPerPurchase' && a.kind === 'day')).toBe(false)
  })
  it('a click-through-rate fall is worse; a day with too few impressions is not judged for it', () => {
    const past = history(30)
    const dull = day(addDays(START, 30), { spendCents: 1000, impressions: 2000, clicks: 10, purchases: 2, purchaseValueCents: 5000 })
    const tiny = day(addDays(START, 31), { spendCents: 1000, impressions: 100, clicks: 0, purchases: 2, purchaseValueCents: 5000 })
    const ctr = metaAnomaliesOf(past, [dull, tiny]).anomalies.filter((a) => a.metric === 'ctr' && a.kind === 'day')
    expect(ctr).toHaveLength(1)
    expect(ctr[0]).toMatchObject({ date: dull.date, direction: 'down', reads: 'worse' })
  })
  it('a cost-per-purchase fall is better', () => {
    const past = history(30)
    const cheap = day(addDays(START, 30), { spendCents: 1000, impressions: 2000, clicks: 40, purchases: 8, purchaseValueCents: 20000 })
    const cpa = metaAnomaliesOf(past, [cheap]).anomalies.find((a) => a.metric === 'costPerPurchase' && a.kind === 'day')!
    expect(cpa).toMatchObject({ direction: 'down', reads: 'better', observed: { costPerPurchaseCents: 125 } })
  })
  it('a move of less than 20 % is no break, however tight the history', () => {
    const flat = Array.from({ length: 20 }, (_, i) => day(addDays(START, i), { spendCents: 1000 + (i % 2), impressions: 2000, clicks: 40, purchases: 2, purchaseValueCents: 5000 }))
    const nudge = day(addDays(START, 20), { spendCents: 1100, impressions: 2000, clicks: 40, purchases: 2, purchaseValueCents: 5000 })
    expect(metaAnomaliesOf(flat, [nudge]).anomalies.filter((a) => a.kind === 'day')).toEqual([])
  })
})

describe('metaAnomaliesOf — shifts', () => {
  it('a week whose cost per purchase is 60 % up: a critical shift, worse, its days named', () => {
    const past = history(40)
    const week = Array.from({ length: 7 }, (_, i) => day(addDays(START, 40 + i), { spendCents: 1600, impressions: 2000, clicks: 40, purchases: 2, purchaseValueCents: 5000 }))
    const shift = metaAnomaliesOf(past, week).anomalies.find((a) => a.kind === 'shift' && a.metric === 'costPerPurchase')!
    expect(shift).toMatchObject({ direction: 'up', reads: 'worse', severity: 'critical', from: week[0].date, to: week[6].date, changePct: 60, observed: { costPerPurchaseCents: 800 }, usual: { costPerPurchaseCents: 500 } })
    expect(shift.sentence).toMatch(/^Cost per purchase from 2026-09-10 to 2026-09-16 is 60 % higher than in the 40 read days before \(worse\)\.$/)
  })
  it('too few purchases on a side: no cost-per-purchase or ROAS shift', () => {
    const past = history(30)
    const quiet = Array.from({ length: 2 }, (_, i) => day(addDays(START, 30 + i), { spendCents: 1000, impressions: 2000, clicks: 40, purchases: 1, purchaseValueCents: 1000 }))
    const out = metaAnomaliesOf(past, quiet).anomalies.filter((a) => a.kind === 'shift')
    expect(out.some((a) => a.metric === 'costPerPurchase' || a.metric === 'roas')).toBe(false)
  })
})

describe('metaAnomaliesOf — honest gaps', () => {
  it('an unread day is never a zero: left out of the history and of the checked days', () => {
    const past = [...history(20), unread(addDays(START, 20)), unread(addDays(START, 21))]
    const week = [normal(addDays(START, 22)), unread(addDays(START, 23))]
    expect(metaAnomaliesOf(past, week)).toEqual({ anomalies: [], notChecked: [] })
  })
  it('fewer than 14 earlier days for a metric: not checked, and why', () => {
    const { anomalies, notChecked } = metaAnomaliesOf(history(10), [normal(addDays(START, 10))])
    expect(anomalies).toEqual([])
    expect(notChecked).toEqual([
      'spend: 10 earlier days to compare with (14 needed)',
      'click-through rate: 10 earlier days to compare with (14 needed, each with 500 impressions)',
      'cost per purchase: 10 earlier days to compare with (14 needed, each with a purchase and spend of at least 40 % of the median spend day)',
      'ROAS: 10 earlier days to compare with (14 needed, each with spend of at least 40 % of the median spend day)',
    ])
  })
  it('earlier days that all had the same value: said in notChecked, the checked days together still compared', () => {
    const flat = Array.from({ length: 20 }, (_, i) => day(addDays(START, i), { spendCents: 1000 + (i % 2), impressions: 2000, clicks: 40, purchases: 2, purchaseValueCents: 5000 }))
    const week = Array.from({ length: 7 }, (_, i) => day(addDays(START, 20 + i), { spendCents: 1000, impressions: 2000, clicks: 10, purchases: 2, purchaseValueCents: 5000 }))
    const { anomalies, notChecked } = metaAnomaliesOf(flat, week)
    expect(notChecked).toEqual(['click-through rate: every earlier day had the same value, so no single day can be measured against them (the checked days together still are)'])
    expect(anomalies.filter((a) => a.metric === 'ctr').map((a) => a.kind)).toEqual(['shift'])
  })
  it('no checked day read: said once', () => {
    expect(metaAnomaliesOf(history(30), [unread('2026-09-01')])).toEqual({ anomalies: [], notChecked: ['every metric: Nexus has read none of the checked days yet'] })
  })
})

describe('metaAnomaliesOf — the volume floor of cost per purchase and ROAS (review fix)', () => {
  it('a 40-cent checked day with no sale is not flagged for ROAS or cost per purchase, and says why', () => {
    const past = history(30)
    const cents = day(addDays(START, 30), { spendCents: 40, impressions: 80, clicks: 2, purchases: 0, purchaseValueCents: 0 })
    const { anomalies, notChecked } = metaAnomaliesOf(past, [cents])
    expect(anomalies.filter((a) => a.metric === 'roas' || a.metric === 'costPerPurchase')).toEqual([])
    expect(notChecked).toEqual([
      'cost per purchase: no checked day spent at least 40 % of the median spend day, too little to judge',
      'ROAS: no checked day spent at least 40 % of the median spend day, too little to judge',
    ])
  })
  it('one tiny-spend earlier day with a big purchase no longer hides a real ROAS drop', () => {
    const past = history(30)
    past[10] = day(past[10].date, { spendCents: 50, impressions: 100, clicks: 2, purchases: 1, purchaseValueCents: 50000 })
    const drop = day(addDays(START, 30), { spendCents: 1000, impressions: 2000, clicks: 40, purchases: 1, purchaseValueCents: 1000 })
    const roas = metaAnomaliesOf(past, [drop]).anomalies.find((a) => a.metric === 'roas' && a.kind === 'day')!
    expect(roas).toMatchObject({ date: drop.date, direction: 'down', reads: 'worse', observed: { roas: 1 } })
    expect(roas.usual.roas).toBeGreaterThan(4.5)
    expect(roas.usual.roas).toBeLessThan(5.5)
  })
  it('a shift of the purchase metrics says how many earlier days were left out for too little spend', () => {
    const past = history(30)
    past[3] = day(past[3].date, { spendCents: 30, impressions: 60, clicks: 1, purchases: 0, purchaseValueCents: 0 })
    const week = Array.from({ length: 7 }, (_, i) => day(addDays(START, 30 + i), { spendCents: 1600, impressions: 2000, clicks: 40, purchases: 2, purchaseValueCents: 5000 }))
    const shift = metaAnomaliesOf(past, week).anomalies.find((a) => a.kind === 'shift' && a.metric === 'costPerPurchase')!
    expect(shift.sentence).toMatch(/than in the 29 read days before \(1 with too little spend left out\) \(worse\)\.$/)
  })
  it('after a budget cut the last 14 earlier days set the floor: a stopped purchase tracking is still judged', () => {
    // 28 days at the usual spend, then 14 days at 3.00 (a cut to 30 %): all 42 days' median alone would leave every new day out.
    const cut = Array.from({ length: 14 }, (_, i) => day(addDays(START, 28 + i), { spendCents: 300, impressions: 600, clicks: 12, purchases: 1, purchaseValueCents: 1500 }))
    const past = [...history(28), ...cut]
    const stopped = day(addDays(START, 42), { spendCents: 300, impressions: 600, clicks: 12, purchases: 0, purchaseValueCents: 0 })
    const { anomalies, notChecked } = metaAnomaliesOf(past, [stopped])
    expect(anomalies.find((a) => a.metric === 'roas' && a.kind === 'day')).toMatchObject({ date: stopped.date, direction: 'down', reads: 'worse' })
    expect(notChecked.filter((n) => n.startsWith('ROAS'))).toEqual([])
  })
})

describe('metaAnomalySignal — the loader', () => {
  const NOW = new Date('2026-10-21T10:00:00Z')
  const account = { adAccountId: '1234567890', name: 'Shop A ads', statusText: 'Active', accountStatus: 1, disableReason: 0 }
  const days = (n: number) => [...history(n - 7, '2026-08-08'), ...Array.from({ length: 7 }, (_, i) => normal(addDays('2026-08-08', n - 7 + i), true))]
  beforeEach(() => {
    h.overviewArgs = []
    h.noticeWhere = []
    h.notices = []
  })

  it('not connected / no ad account chosen: said in words, nothing else read', async () => {
    h.overview = { connection: null, account: null, days: [], currency: null, timeZone: null, dataAsOf: null, window: { from: '2026-08-12', to: '2026-10-20' } }
    expect(await metaAnomalySignal({}, NOW)).toMatchObject({ connected: false, anomalies: [], sentence: expect.stringMatching(/^Meta is not connected/) })
    h.overview = { ...h.overview, connection: { connectionId: 'm-1' } }
    expect(await metaAnomalySignal({}, NOW)).toMatchObject({ connected: true, adAccountId: null, sentence: expect.stringMatching(/^No Meta ad account is chosen/) })
    expect(h.noticeWhere).toEqual([])
  })

  it('reads the checked days plus 56 days of history; Meta\'s pushes once per subject, only this account\'s', async () => {
    const all = days(7 + META_ANOMALY_HISTORY_DAYS)
    h.overview = { connection: { connectionId: 'm-1' }, account, days: all, currency: 'EUR', timeZone: 'Europe/Rome', dataAsOf: '2026-10-21T04:00:00.000Z', window: { from: all[0].date, to: all.at(-1)!.date } }
    const at = new Date('2026-10-19T08:00:00Z')
    h.notices = [
      { type: 'meta-ads-creative-fatigue', severity: 'warn', title: "Meta: an ad's creative is wearing out (high)", body: 'Ad 120000000000003: its creative fatigue is now high.', entityId: '1234567890~120000000000003~fatigue~HIGH', createdAt: at },
      // The same notice to a second owner: one subject.
      { type: 'meta-ads-creative-fatigue', severity: 'warn', title: "Meta: an ad's creative is wearing out (high)", body: 'Ad 120000000000003: its creative fatigue is now high.', entityId: '1234567890~120000000000003~fatigue~HIGH', createdAt: at },
    ]
    const out = await metaAnomalySignal({ connectionId: 'm-1', days: 7 }, NOW)
    expect(h.overviewArgs).toEqual([{ connectionId: 'm-1', days: 7 + META_ANOMALY_HISTORY_DAYS }])
    expect(out).toMatchObject({ connected: true, adAccountId: '1234567890', currency: 'EUR', anomalies: [], notChecked: [] })
    expect(out.checked).toEqual({ from: all.at(-7)!.date, to: all.at(-1)!.date, daysRead: 7, notRead: [] })
    expect(out.history).toMatchObject({ daysRead: META_ANOMALY_HISTORY_DAYS })
    expect(out.metaSaid).toEqual([{ at: at.toISOString(), kind: 'meta-ads-creative-fatigue', severity: 'warn', title: "Meta: an ad's creative is wearing out (high)", body: 'Ad 120000000000003: its creative fatigue is now high.' }])
    expect(h.noticeWhere[0]).toMatchObject({ type: { in: ['meta-ads-creative-fatigue', 'meta-ads-account-status', 'meta-ads-object-issue'] }, entityId: { startsWith: '1234567890~' } })
    expect(out.sentence).toMatch(/No unusual swing in the 7 checked days .*Meta itself reported 1 thing .*no Meta call/)
  })

  it('an ad account Meta does not call active says so', async () => {
    const all = days(30)
    h.overview = { connection: { connectionId: 'm-1' }, account: { ...account, accountStatus: 2 }, days: all, currency: 'EUR', timeZone: 'Europe/Rome', dataAsOf: null, window: { from: all[0].date, to: all.at(-1)!.date } }
    const out = await metaAnomalySignal({}, NOW)
    expect(out.accountStatus).toBe('Disabled')
    expect(out.sentence).toMatch(/^The ad account is disabled at Meta\./)
  })
})

describe('detect-anomalies — the Meta part', () => {
  const ctx = (adsView: boolean) => ({ can: (p: string) => adsView || p !== 'ads.view', via: 'claude' as const })
  const tool = async () => (await import('../../agents/tools/analytics.tools.js')).ANALYTICS_TOOLS.find((t) => t.name === 'detect-anomalies')!

  beforeEach(() => {
    h.alerts = [{ value: 12, status: 'TRIGGERED', triggeredAt: new Date('2026-10-20T10:00:00Z'), rule: { name: 'Errors', metric: 'errorRate', operator: 'gt', threshold: 5 } }]
    h.overview = { connection: null, account: null, days: [], currency: null, timeZone: null, dataAsOf: null, window: { from: '2026-08-12', to: '2026-10-20' } }
    h.overviewError = null
    h.notices = []
  })

  it('review fix — an error of the Meta part that is not a Meta read refusal: channel all still answers the alerts; meta fails', async () => {
    const t = await tool()
    h.overviewError = new Error('the database is gone')
    const out = await t.handler(t.input.parse({}) as Record<string, unknown>, ctx(true))
    expect(out).toEqual({ ok: true, data: { count: 1, anomalies: [expect.objectContaining({ rule: 'Errors' })], meta: { shown: false, sentence: expect.stringMatching(/^Nexus could not read the Meta signal/) } } })
    await expect(t.handler(t.input.parse({ channel: 'meta' }) as Record<string, unknown>, ctx(true))).rejects.toThrow('the database is gone')
  })

  it('review fix — a person without the ad-spend money permission gets a Meta spend anomaly without its amounts (visibleTo)', async () => {
    const t = await tool()
    const { visibleTo } = await import('../../agents/call-tool.js')
    const { FEATURES, FIELDS } = await import('@nexus/shared/permissions')
    const all = [...history(56, '2026-08-01'), day(addDays('2026-08-01', 56), { spendCents: 3000, impressions: 6000, clicks: 120, purchases: 6, purchaseValueCents: 15000 }, true)]
    h.overview = { connection: { connectionId: 'm-1' }, account: { adAccountId: '1234567890', accountStatus: 1 }, days: all, currency: 'EUR', timeZone: 'Europe/Rome', dataAsOf: null, window: { from: all[0].date, to: all.at(-1)!.date } }
    const raw = await t.handler(t.input.parse({ channel: 'meta', days: 1 }) as Record<string, unknown>, ctx(true))
    const meta = (raw.data as { meta: { anomalies: Array<{ metric: string; observed: Record<string, unknown>; usual: Record<string, unknown> }> } }).meta
    expect(meta.anomalies.find((a) => a.metric === 'spend')).toMatchObject({ observed: { spendCents: 3000 }, usual: { spendCents: expect.any(Number) } })
    const person = (permissions: string[]) => ({ kind: 'user' as const, userId: 'u-1', label: 'Shop A operator', permissions: { isOwner: false, permissions: new Set(permissions) }, via: 'claude' as const })
    const everything = [...Object.values(FEATURES), ...Object.values(FIELDS)] as string[]
    // Every permission but the ad-spend money one (and the all-money one that includes it).
    const seen = visibleTo(person(everything.filter((p) => p !== FIELDS.financialsAdspendView && p !== FIELDS.financialsView)), t, raw)
    const text = JSON.stringify(seen)
    for (const key of ['spendCents', 'costPerPurchaseCents', 'roas']) expect(text).not.toContain(`"${key}"`)
    expect((seen.data as { meta: { anomalies: unknown[] } }).meta.anomalies.length).toBe(meta.anomalies.length)
    // With the permission, the amounts stay.
    expect(JSON.stringify(visibleTo(person(everything), t, raw))).toContain('"spendCents":3000')
  })

  it('channel alerts answers exactly as before: the triggered alerts, no Meta read', async () => {
    const t = await tool()
    h.overviewArgs = []
    const out = await t.handler(t.input.parse({ channel: 'alerts' }) as Record<string, unknown>, ctx(true))
    expect(out).toEqual({ ok: true, data: { count: 1, anomalies: [{ rule: 'Errors', metric: 'errorRate', operator: 'gt', threshold: 5, value: 12, triggeredAt: new Date('2026-10-20T10:00:00Z') }] } })
    expect(h.overviewArgs).toEqual([])
  })

  it('the default adds the Meta signal; without the ads view permission it is left out (meta: refused), in words', async () => {
    const t = await tool()
    const all = await t.handler(t.input.parse({}) as Record<string, unknown>, ctx(true))
    expect(all).toMatchObject({ ok: true, data: { count: 1, meta: { connected: false } } })
    const without = await t.handler(t.input.parse({}) as Record<string, unknown>, ctx(false))
    expect(without).toMatchObject({ ok: true, data: { count: 1, meta: { shown: false, sentence: expect.stringMatching(/ads view permission/) } } })
    expect(await t.handler(t.input.parse({ channel: 'META' }) as Record<string, unknown>, ctx(false))).toEqual({ ok: false, error: expect.stringMatching(/ads view permission/) })
  })

  it('states the Meta money keys as its own restricted fields, and bounds days', async () => {
    const t = await tool()
    expect(Object.keys(t.restrictedFields ?? {}).sort()).toEqual(['costPerPurchaseCents', 'roas', 'spendCents'])
    expect(() => t.input.parse({ days: 15 })).toThrow()
    expect(() => t.input.parse({ channel: 'google' })).toThrow()
    expect(t.readOnly).toBe(true)
  })
})
