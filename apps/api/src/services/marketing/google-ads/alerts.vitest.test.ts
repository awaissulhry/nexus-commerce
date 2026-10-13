/**
 * Google Ads step 1b — the alert rules (alerts.ts), pure: no database. Proven here: each rule fires on what was read
 * and only then; a check whose days or reads Nexus lacks is in `notChecked` with a reason, never passed; the occurrence
 * keys make the bell ring once a day, a month, a streak or a set; thresholds follow their env overrides; no title or
 * body names an amount; and `numbers` uses only the agreed keys. Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import {
  GOOGLE_ALERT_COUNT_KEYS,
  GOOGLE_ALERT_MONEY_KEYS,
  alertDaysFrom,
  evaluateGoogleAdsAlerts,
  googleAdsAlertThresholds,
  isByGoogle,
  isWatchedChange,
  whoOf,
  type AlertDay,
  type GoogleAdsAlertSnapshot,
} from './alerts.js'
import { addDays, daysOf } from './dates.js'

/** 08:30 in Rome on 13 Oct: the account's yesterday is 12 Oct. */
const NOW = new Date('2026-10-13T06:30:00Z')
const T = googleAdsAlertThresholds({})
const READ_AT = new Date('2026-10-13T06:00:00Z')

const snapshot = (extra: Partial<GoogleAdsAlertSnapshot> = {}): GoogleAdsAlertSnapshot => ({
  customerId: '1234567890',
  timeZone: 'Europe/Rome',
  now: NOW,
  metricsRead: { from: '2026-08-01', to: '2026-10-12' },
  campaigns: [{ googleCampaignId: '111', status: 'ENABLED', removed: false, dailyBudgetMicros: 10_000_000n, broadMatchMigratedAt: null }],
  days: [],
  adPolicyReadAt: READ_AT,
  productStatusReadAt: READ_AT,
  autoApplyReadAt: READ_AT,
  settingsReadAt: READ_AT,
  issues: [],
  autoApply: [],
  changesReadThrough: READ_AT,
  changes: [],
  ...extra,
})
const d = (day: string, cost: number, clicks = 0, conversions = 0, googleCampaignId = '111'): AlertDay =>
  ({ googleCampaignId, day, costMicros: BigInt(cost), clicks, conversions4: BigInt(Math.round(conversions * 10_000)) })
const kinds = (s: GoogleAdsAlertSnapshot, t = T) => evaluateGoogleAdsAlerts(s, t).items.map((a) => a.kind)

describe('thresholds', () => {
  it('defaults, and env overrides that are numbers in range (anything else keeps the default)', () => {
    expect(T).toEqual({
      spendPaceRatio: 1.5, monthPaceRatio: 1.2, zeroConversionDays: 7, zeroConversionClicks: 20, priorDays: 28,
      campaignPriorConversions: 3, accountStopDays: 3, accountPriorConversions: 5, changeDays: 7,
    })
    const t = googleAdsAlertThresholds({ NEXUS_GOOGLE_ADS_SPEND_PACE_RATIO: '2', NEXUS_GOOGLE_ADS_ZERO_CONVERSION_CLICKS: 'many', NEXUS_GOOGLE_ADS_MONTH_PACE_RATIO: '0.5', NEXUS_GOOGLE_ADS_ZERO_CONVERSION_DAYS: '10.7' })
    expect([t.spendPaceRatio, t.zeroConversionClicks, t.monthPaceRatio, t.zeroConversionDays]).toEqual([2, 20, 1.2, 10])
  })

  it('the snapshot reaches back to the month\'s first day or the longest streak with its prior days', () => {
    expect(alertDaysFrom('Europe/Rome', NOW, T)).toEqual({ from: addDays('2026-10-12', -34), to: '2026-10-12' })
    expect(alertDaysFrom('Europe/Rome', new Date('2026-12-31T10:00:00Z'), T)).toEqual({ from: '2026-11-26', to: '2026-12-30' })
  })
})

describe('spend pace', () => {
  it('yesterday at 1.5 × the daily budget or more; once a day; money only in money', () => {
    const at = evaluateGoogleAdsAlerts(snapshot({ days: [d('2026-10-12', 15_000_000)] }))
    expect(at.items).toEqual([expect.objectContaining({
      kind: 'spend_pace', severity: 'warn', googleCampaignId: '111', since: '2026-10-12', occurrence: '2026-10-12',
      alertId: 'spend_pace~111~2026-10-12', money: { spendCents: 15_000_000n, dailyBudgetCents: 10_000_000n }, counts: { ratio: 1.5 },
    })])
    expect(at.items[0].body).toBe('Yesterday this campaign spent 1.5 times its daily budget or more.')
    expect(kinds(snapshot({ days: [d('2026-10-12', 14_999_999)] }))).toEqual([])
    // A removed campaign, or one with no daily budget (custom period), is not paced.
    expect(kinds(snapshot({ days: [d('2026-10-12', 99_000_000)], campaigns: [{ googleCampaignId: '111', status: 'ENABLED', removed: true, dailyBudgetMicros: 1n, broadMatchMigratedAt: null }] }))).toEqual([])
    expect(kinds(snapshot({ days: [d('2026-10-12', 99_000_000)], campaigns: [{ googleCampaignId: '111', status: 'ENABLED', removed: false, dailyBudgetMicros: null, broadMatchMigratedAt: null }] }))).toEqual([])
  })

  it('yesterday not read: not checked, with the reason', () => {
    const at = evaluateGoogleAdsAlerts(snapshot({ metricsRead: { from: '2026-08-01', to: '2026-10-11' }, days: [d('2026-10-12', 99_000_000)] }))
    expect(at.items.map((a) => a.kind)).not.toContain('spend_pace')
    expect(at.notChecked).toContainEqual({ kind: 'spend_pace', reason: 'Nexus has not read yesterday\'s numbers yet.' })
    expect(at.notChecked).toContainEqual({ kind: 'month_pace', reason: 'Nexus has not read every day of this month yet.' })
  })
})

describe('month pace', () => {
  it('above 1.2 × the pace of 30.4 days of budget over the days gone; once a month', () => {
    // 12 of 31 days: the pace is 30.4 × 10 × 12 / 31 × 1.2 ≈ 141.2 (currency units).
    const over = evaluateGoogleAdsAlerts(snapshot({ days: [d('2026-10-02', 142_000_000)] })).items
    expect(over).toEqual([expect.objectContaining({ kind: 'month_pace', occurrence: '2026-10', since: '2026-10-01', counts: { days: 12 } })])
    expect(over[0].money).toMatchObject({ monthSpendCents: 142_000_000n, monthBudgetCents: 304_000_000n, dailyBudgetCents: 10_000_000n })
    expect(kinds(snapshot({ days: [d('2026-10-02', 141_000_000)] }))).toEqual([])
  })

  it('on the month\'s first day there is no full day yet: nothing to check, and nothing missing', () => {
    const first = evaluateGoogleAdsAlerts(snapshot({ now: new Date('2026-11-01T10:00:00Z'), metricsRead: { from: '2026-08-01', to: '2026-10-31' } }))
    expect(first.notChecked.map((n) => n.kind)).not.toContain('month_pace')
  })
})

describe('zero conversions and tracking stopped', () => {
  const last7 = daysOf({ from: '2026-10-06', to: '2026-10-12' })

  it('spend, 20 clicks or more and no conversion in 7 days: warn, once a streak', () => {
    const days = last7.map((day) => d(day, 1_000_000, 3))
    const at = evaluateGoogleAdsAlerts(snapshot({ days })).items
    // Every read day back to the first read day had no conversion: the streak starts there.
    expect(at).toEqual([expect.objectContaining({ kind: 'zero_conversions', severity: 'warn', since: '2026-08-01', occurrence: '2026-08-01', counts: { clicks: 21, days: 7 } })])
    expect(kinds(snapshot({ days: last7.map((day) => d(day, 1_000_000, 2)) }))).toEqual([])
    // One conversion (half of one, under data-driven attribution) in the 7 days: no alert.
    expect(kinds(snapshot({ days: [...days, d('2026-10-09', 1_000_000, 3, 0.5)] }))).toEqual([])
    // A paused campaign is not asked to convert.
    expect(kinds(snapshot({ days, campaigns: [{ googleCampaignId: '111', status: 'PAUSED', removed: false, dailyBudgetMicros: null, broadMatchMigratedAt: null }] }))).toEqual([])
  })

  it('after 3 conversions or more in the 28 days before: tracking stopped (danger) instead; the streak starts after the last conversion', () => {
    const days = [...last7.map((day) => d(day, 1_000_000, 3)), d('2026-09-20', 1_000_000, 5, 3)]
    const at = evaluateGoogleAdsAlerts(snapshot({ days })).items
    expect(at).toEqual([expect.objectContaining({ kind: 'tracking_stopped', severity: 'danger', googleCampaignId: '111', since: '2026-09-21', counts: { clicks: 21, priorConversions: 3, days: 7 } })])
    expect(at[0].body).toContain('Check that conversion tracking still works.')
  })

  it('the account: spend on each of the last 3 days, no conversion, after 5 or more in the 28 days before', () => {
    const days = [d('2026-10-10', 1, 0, 0, '900'), d('2026-10-11', 1, 0, 0, '900'), d('2026-10-12', 1, 0, 0, '901'), d('2026-09-30', 1, 0, 5, '900')]
    const at = evaluateGoogleAdsAlerts(snapshot({ days })).items
    expect(at).toEqual([expect.objectContaining({ kind: 'tracking_stopped', googleCampaignId: null, since: '2026-10-01', counts: { priorConversions: 5, days: 3 } })])
    expect(kinds(snapshot({ days: days.filter((x) => x.day !== '2026-10-11') }))).toEqual([])
  })

  it('days not read: not checked, with the reason', () => {
    const at = evaluateGoogleAdsAlerts(snapshot({ metricsRead: { from: '2026-10-08', to: '2026-10-12' } }))
    expect(at.notChecked).toContainEqual({ kind: 'zero_conversions', reason: 'Nexus has not read every one of the last 7 days yet.' })
    expect(at.notChecked).toContainEqual({ kind: 'tracking_stopped', reason: 'Nexus has not read every one of the last 31 days yet.' })
  })
})

describe('reviews, auto-apply, changes and AI Max', () => {
  it('disapproved ads per enabled campaign (danger), limited ones (info); the occurrence is the set of ads', () => {
    const issue = (entityKey: string, status: string, googleCampaignId = '111') =>
      ({ kind: 'AD' as const, entityKey, googleCampaignId, itemId: null, status, firstSeenAt: new Date('2026-10-10T00:00:00Z') })
    const one = evaluateGoogleAdsAlerts(snapshot({ issues: [issue('1~1', 'DISAPPROVED'), issue('1~2', 'APPROVED_LIMITED'), issue('1~3', 'DISAPPROVED', '999')] })).items
    expect(one.map((a) => [a.kind, a.severity, a.body])).toEqual([
      ['ads_disapproved', 'danger', 'Google disapproved 1 ad in this campaign. It does not show.'],
      ['ads_limited', 'info', 'Google shows 1 ad in this campaign only in some places or to some people.'],
    ])
    const two = evaluateGoogleAdsAlerts(snapshot({ issues: [issue('1~1', 'DISAPPROVED'), issue('1~4', 'DISAPPROVED')] })).items
    expect(two[0].occurrence).not.toBe(one[0].occurrence)
    expect(evaluateGoogleAdsAlerts(snapshot({ adPolicyReadAt: null })).notChecked.map((n) => n.kind)).toEqual(expect.arrayContaining(['ads_disapproved', 'ads_limited']))
  })

  it('products not eligible: one alert for the account, items counted once over their feeds', () => {
    const product = (entityKey: string, itemId: string, status = 'NOT_ELIGIBLE') =>
      ({ kind: 'PRODUCT' as const, entityKey, googleCampaignId: null, itemId, status, firstSeenAt: new Date('2026-10-10T00:00:00Z') })
    const at = evaluateGoogleAdsAlerts(snapshot({ issues: [product('1~a~en~IT~X1', 'X1'), product('1~a~en~DE~x1', 'x1'), product('1~a~en~IT~X2', 'X2', 'ELIGIBLE_LIMITED')] })).items
    expect(at.map((a) => [a.kind, a.body, a.money, a.counts])).toEqual([['products_not_eligible', 'Google will not show 1 product in its ads.', {}, {}]])
    expect(evaluateGoogleAdsAlerts(snapshot({ productStatusReadAt: null })).notChecked).toContainEqual({ kind: 'products_not_eligible', reason: 'Nexus has not read the product statuses yet.' })
  })

  it('auto-apply on: the occurrence is the set of types', () => {
    const on = (types: string[]) => evaluateGoogleAdsAlerts(snapshot({ autoApply: [...types.map((type) => ({ type, status: 'ENABLED', since: null })), { type: 'X', status: 'PAUSED', since: null }] })).items
    expect(on(['KEYWORD', 'CAMPAIGN_BUDGET'])[0]).toMatchObject({ kind: 'auto_apply_on', body: 'Auto-apply is on for 2 kinds of recommendation. Google changes the account without asking.' })
    expect(on(['KEYWORD', 'CAMPAIGN_BUDGET'])[0].occurrence).toBe(on(['CAMPAIGN_BUDGET', 'KEYWORD'])[0].occurrence)
    expect(on([])).toEqual([])
  })

  it('changes by Google: once a day per account (M6), the day of the newest; watched settings by anyone (info)', () => {
    const change = (at: string, clientType: string, resourceType = 'CAMPAIGN', changedFields = ['name']) =>
      ({ changedAt: new Date(at), clientType, googleCampaignId: '111', resourceType, changedFields })
    const at = evaluateGoogleAdsAlerts(snapshot({
      changes: [
        change('2026-10-11T23:30:00Z', 'GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION'), // 12 Oct in Rome
        change('2026-10-10T10:00:00Z', 'GOOGLE_ADS_RECOMMENDATIONS', 'CAMPAIGN_BUDGET', ['amount_micros']),
        change('2026-10-12T09:00:00Z', 'GOOGLE_ADS_WEB_CLIENT', 'CAMPAIGN', ['network_settings.target_content_network']),
        change('2026-09-30T10:00:00Z', 'GOOGLE_ADS_RECOMMENDATIONS'), // older than 7 days
      ],
    })).items
    expect(at.map((a) => [a.kind, a.occurrence, a.since, a.body])).toEqual([
      ['changed_by_google', '2026-10-12', '2026-10-10T10:00:00.000Z', 'Google made 2 changes on its own in the last 7 days.'],
      ['settings_changed', '2026-10-12', '2026-10-10T10:00:00.000Z', 'Budgets, bids, networks or AI settings changed 2 times in the last 7 days.'],
    ])
    expect(evaluateGoogleAdsAlerts(snapshot({ changesReadThrough: null })).notChecked.map((n) => n.kind)).toEqual(expect.arrayContaining(['changed_by_google', 'settings_changed']))
    expect([whoOf('GOOGLE_ADS_EDITOR'), whoOf('GOOGLE_ADS_SCRIPTS'), whoOf('INTERNAL_TOOL'), whoOf(null)]).toEqual(['person', 'your_google_rules_or_scripts', 'other', 'other'])
    expect([isByGoogle('GOOGLE_ADS_RECOMMENDATIONS'), isByGoogle('GOOGLE_ADS_API')]).toEqual([true, false])
    expect([isWatchedChange('AD_GROUP', ['status']), isWatchedChange('CAMPAIGN', ['name']), isWatchedChange('CAMPAIGN', ['ai_max_setting.enable_ai_max'])]).toEqual([false, false, true])
  })

  it('moved to AI Max: done or planned, once a date; not checked before the settings were read', () => {
    const at = (when: string) => evaluateGoogleAdsAlerts(snapshot({ campaigns: [{ googleCampaignId: '111', status: 'PAUSED', removed: false, dailyBudgetMicros: null, broadMatchMigratedAt: new Date(when) }] })).items
    expect(at('2026-10-01T08:00:00Z')[0]).toMatchObject({ kind: 'moved_to_ai_max', title: 'Moved to AI Max', occurrence: '2026-10-01' })
    expect(at('2026-11-01T08:00:00Z')[0]).toMatchObject({ title: 'Moving to AI Max', body: 'Google will move this campaign to AI Max on 1 Nov 2026. Its ads may then show for more searches.' })
    expect(evaluateGoogleAdsAlerts(snapshot({ settingsReadAt: null })).notChecked).toContainEqual({ kind: 'moved_to_ai_max', reason: 'Nexus has not read the campaign settings yet.' })
  })
})

describe('every alert', () => {
  it('danger first; no amount in a title or body; numbers only under the agreed keys', () => {
    const all = evaluateGoogleAdsAlerts(snapshot({
      days: [...daysOf({ from: '2026-10-01', to: '2026-10-12' }).map((day) => d(day, 16_000_000, 3)), d('2026-09-20', 1_000_000, 5, 4)],
      issues: [{ kind: 'AD', entityKey: '1~1', googleCampaignId: '111', itemId: null, status: 'DISAPPROVED', firstSeenAt: NOW }],
      autoApply: [{ type: 'KEYWORD', status: 'ENABLED', since: null }],
    })).items
    expect(all.map((a) => a.severity)).toEqual([...all.map((a) => a.severity)].sort((a, b) => ['danger', 'warn', 'info'].indexOf(a) - ['danger', 'warn', 'info'].indexOf(b)))
    expect(all.length).toBeGreaterThanOrEqual(5)
    for (const a of all) {
      expect(`${a.title} ${a.body}`).not.toMatch(/\d{4,}|€|EUR|\d+\.\d{2}\b/)
      for (const key of Object.keys(a.money)) expect(GOOGLE_ALERT_MONEY_KEYS).toContain(key)
      for (const key of Object.keys(a.counts)) expect(GOOGLE_ALERT_COUNT_KEYS).toContain(key)
    }
  })
})
