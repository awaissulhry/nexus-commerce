/**
 * Google Ads step 1b — what needs a look (R14), checked over what Nexus has STORED. Pure: no database, no Google call,
 * no clock unless the snapshot's `now`. alerts.service.ts loads the snapshot, answers R14 with it, and after each daily
 * read rings the bell (plan-1b-backend §6, PLAN-1B M5/M6).
 *
 * The rules (thresholds below, each with an env override):
 *   spend_pace         yesterday read; a campaign spent at least 1.5 × its daily budget              warn    once a day
 *   month_pace         every day of this month read; spend above 1.2 × the month's pace of 30.4 days warn    once a month
 *   zero_conversions   enabled; the last 7 days read; spend, at least 20 clicks, no conversion        warn    once a streak
 *   tracking_stopped   the same, after at least 3 conversions in the 28 days before (campaign);       danger  once a streak
 *                      or the account spent each of the last 3 days with no conversion after at least 5 in the 28 before
 *   ads_disapproved    an open DISAPPROVED ad in an enabled campaign                                  danger  once a set of ads
 *   products_not_eligible  an open NOT_ELIGIBLE product                                               warn    once a set of items
 *   ads_limited        an open APPROVED_LIMITED / AREA_OF_INTEREST_ONLY ad in an enabled campaign     info    (panel only)
 *   auto_apply_on      an auto-apply setting ENABLED                                                  warn    once a set of types
 *   changed_by_google  a change Google made by itself (recommendations, auto-apply), last 7 days      warn    once a day (M6)
 *   settings_changed   anyone changed a watched campaign setting, last 7 days                         info    (panel only)
 *   moved_to_ai_max    Google moved (or will move) a campaign to AI Max                               warn    once a date
 *
 * A check whose days or reads Nexus does not have is NOT passed: it goes to `notChecked` with the reason in words.
 * Titles and bodies never carry an amount (money is in `money`, in micros, which the service turns into minor units and
 * a person without the ad-spend permission never receives).
 */
import { createHash } from 'node:crypto'
import { accountToday, addDays, dayCount, dayIn, daysOf, type DayWindow } from './dates.js'
import { GOOGLE_ALERT_KINDS, type GoogleAlertKind, type GoogleAlertSeverity, type GoogleChangeWho } from './read-types.js'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** A day (YYYY-MM-DD) in words a person reads, e.g. "23 Sep 2026" (the account's day; never a raw ISO date in a sentence). */
export const dayWords = (day: string): string => {
  const [y, m, d] = day.split('-').map(Number)
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : day
}

// ── Thresholds ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Google may spend up to this many days of the daily budget in a month. */
export const DAYS_PER_BUDGET_MONTH = 30.4

const numberFrom = (raw: string | undefined, fallback: number, min: number): number => {
  const n = Number(raw)
  return raw != null && raw.trim() !== '' && Number.isFinite(n) && n >= min ? n : fallback
}
const wholeFrom = (raw: string | undefined, fallback: number, min: number): number => Math.trunc(numberFrom(raw, fallback, min))

export interface GoogleAdsAlertThresholds {
  spendPaceRatio: number
  monthPaceRatio: number
  zeroConversionDays: number
  zeroConversionClicks: number
  priorDays: number
  campaignPriorConversions: number
  accountStopDays: number
  accountPriorConversions: number
  changeDays: number
}

export function googleAdsAlertThresholds(env: NodeJS.ProcessEnv = process.env): GoogleAdsAlertThresholds {
  return {
    spendPaceRatio: numberFrom(env.NEXUS_GOOGLE_ADS_SPEND_PACE_RATIO, 1.5, 1),
    monthPaceRatio: numberFrom(env.NEXUS_GOOGLE_ADS_MONTH_PACE_RATIO, 1.2, 1),
    zeroConversionDays: wholeFrom(env.NEXUS_GOOGLE_ADS_ZERO_CONVERSION_DAYS, 7, 1),
    zeroConversionClicks: wholeFrom(env.NEXUS_GOOGLE_ADS_ZERO_CONVERSION_CLICKS, 20, 1),
    priorDays: wholeFrom(env.NEXUS_GOOGLE_ADS_PRIOR_DAYS, 28, 1),
    campaignPriorConversions: numberFrom(env.NEXUS_GOOGLE_ADS_CAMPAIGN_PRIOR_CONVERSIONS, 3, 0),
    accountStopDays: wholeFrom(env.NEXUS_GOOGLE_ADS_ACCOUNT_STOP_DAYS, 3, 1),
    accountPriorConversions: numberFrom(env.NEXUS_GOOGLE_ADS_ACCOUNT_PRIOR_CONVERSIONS, 5, 0),
    changeDays: wholeFrom(env.NEXUS_GOOGLE_ADS_CHANGE_DAYS, 7, 1),
  }
}

/** The first day the snapshot's daily numbers must reach back to (month to date, the zero streak and the prior days). */
export function alertDaysFrom(timeZone: string | null, now: Date, t: GoogleAdsAlertThresholds): DayWindow {
  const today = todayIn(timeZone, now)
  const yesterday = addDays(today, -1)
  const back = Math.max(t.zeroConversionDays + t.priorDays, t.accountStopDays + t.priorDays)
  const longest = addDays(yesterday, -(back - 1))
  const monthStart = `${today.slice(0, 8)}01`
  return { from: monthStart < longest ? monthStart : longest, to: yesterday }
}

// ── Who changed something, and which changes are watched ───────────────────────────────────────────────────────────

const WHO: Readonly<Record<string, GoogleChangeWho>> = {
  GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION: 'google_auto_apply',
  GOOGLE_ADS_RECOMMENDATIONS: 'google_recommendation',
  GOOGLE_ADS_AUTOMATED_RULE: 'your_google_rules_or_scripts',
  GOOGLE_ADS_SCRIPTS: 'your_google_rules_or_scripts',
  GOOGLE_ADS_WEB_CLIENT: 'person',
  GOOGLE_ADS_BULK_UPLOAD: 'person',
  GOOGLE_ADS_EDITOR: 'person',
  GOOGLE_ADS_MOBILE_APP: 'person',
  GOOGLE_ADS_API: 'api',
}

/** Who made a change, from Google's client_type. */
export const whoOf = (clientType: string | null | undefined): GoogleChangeWho => (clientType && WHO[clientType]) || 'other'

/** A change Google made by itself: auto-apply, or a recommendation it applied. */
export const isByGoogle = (clientType: string | null | undefined): boolean => {
  const who = whoOf(clientType)
  return who === 'google_auto_apply' || who === 'google_recommendation'
}

/** The campaign settings by which Google spends more, or shows ads in more places (snake_case path parts). */
const WATCHED_FIELDS = new Set([
  'amount_micros', 'delivery_method', 'status', 'bidding_strategy', 'bidding_strategy_type', 'target_cpa', 'target_cpa_micros',
  'target_roas', 'target_spend', 'maximize_conversions', 'maximize_conversion_value', 'manual_cpc', 'network_settings',
  'target_google_search', 'target_search_network', 'target_content_network', 'target_partner_search_network', 'ai_max_setting',
  'enable_ai_max', 'keyword_match_type', 'asset_automation_settings', 'dynamic_search_ads_setting', 'domain_name',
  'url_expansion_opt_out',
])

/** Whether a change touched a watched campaign or budget setting. */
export function isWatchedChange(resourceType: string, changedFields: string[]): boolean {
  if (resourceType !== 'CAMPAIGN' && resourceType !== 'CAMPAIGN_BUDGET') return false
  return changedFields.some((path) => path.split('.').some((part) => WATCHED_FIELDS.has(part)))
}

// ── The snapshot ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface AlertCampaign {
  googleCampaignId: string
  /** ENABLED | PAUSED | REMOVED as Google last said. */
  status: string
  removed: boolean
  /** The average daily amount; null for a custom-period budget (no day pace to hold it to). */
  dailyBudgetMicros: bigint | null
  broadMatchMigratedAt: Date | null
}

export interface AlertDay {
  googleCampaignId: string
  day: string
  costMicros: bigint
  clicks: number
  /** Conversions in ten-thousandths. */
  conversions4: bigint
}

export interface AlertIssue {
  kind: 'AD' | 'PRODUCT'
  entityKey: string
  googleCampaignId: string | null
  itemId: string | null
  status: string
  firstSeenAt: Date
}

export interface AlertAutoApply {
  type: string
  status: string
  since: Date | null
}

export interface AlertChange {
  changedAt: Date
  clientType: string | null
  googleCampaignId: string | null
  resourceType: string
  changedFields: string[]
}

export interface GoogleAdsAlertSnapshot {
  customerId: string
  timeZone: string | null
  now: Date
  /** The contiguous days of campaign numbers Nexus read, or null. */
  metricsRead: DayWindow | null
  campaigns: AlertCampaign[]
  /** Campaign days (every campaign of the account, also those without a settings row) from `alertDaysFrom`. */
  days: AlertDay[]
  /** When each part was last read with success (null = never). */
  adPolicyReadAt: Date | null
  productStatusReadAt: Date | null
  autoApplyReadAt: Date | null
  settingsReadAt: Date | null
  /** Open issues (not resolved). */
  issues: AlertIssue[]
  /** Auto-apply settings Google still returns. */
  autoApply: AlertAutoApply[]
  /** Where Nexus's reading of the change history stopped; null = never read. */
  changesReadThrough: Date | null
  /** Changes of the last `changeDays` days. */
  changes: AlertChange[]
}

/** The only keys R14's `numbers` carries (PLAN-1B, lead 2026-10-13): …Cents is money in the account's currency. */
export const GOOGLE_ALERT_MONEY_KEYS = ['spendCents', 'dailyBudgetCents', 'monthSpendCents', 'monthBudgetCents', 'limitCents', 'conversionValueCents', 'costPerConversionCents'] as const
export const GOOGLE_ALERT_COUNT_KEYS = ['clicks', 'impressions', 'conversions', 'priorConversions', 'ratio', 'roas', 'ctr', 'days'] as const
export type GoogleAlertMoneyKey = (typeof GOOGLE_ALERT_MONEY_KEYS)[number]
export type GoogleAlertCountKey = (typeof GOOGLE_ALERT_COUNT_KEYS)[number]

export interface EvaluatedAlert {
  alertId: string
  kind: GoogleAlertKind
  severity: GoogleAlertSeverity
  title: string
  /** Never an amount. */
  body: string
  /** Google's campaign id; null = the whole account. */
  googleCampaignId: string | null
  /** A day (YYYY-MM-DD) or an instant (ISO). */
  since: string | null
  /** Money, in MICROS of the account currency, under the key it is answered with (…Cents). */
  money: Partial<Record<GoogleAlertMoneyKey, bigint | null>>
  /** Not money (a count stays in the body; these are the numbers the web prints beside it). */
  counts: Partial<Record<GoogleAlertCountKey, number | null>>
  /** The bell's occurrence: one notification per alert and occurrence. */
  occurrence: string
}

export interface EvaluatedAlerts {
  items: EvaluatedAlert[]
  notChecked: { kind: GoogleAlertKind; reason: string }[]
}

// ── The evaluation ─────────────────────────────────────────────────────────────────────────────────────────────────

function todayIn(timeZone: string | null, now: Date): string {
  if (timeZone) {
    try { return accountToday(timeZone, now) } catch { /* below */ }
  }
  return accountToday('UTC', now)
}

function dayOf(at: Date, timeZone: string | null): string {
  if (timeZone) {
    try { return dayIn(at, timeZone) } catch { /* below */ }
  }
  return dayIn(at, 'UTC')
}

const hashOf = (parts: string[]): string => createHash('sha256').update([...parts].sort().join('\n')).digest('hex').slice(0, 16)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
/** A ratio in words: 1.5 → "1.5 times", 2 → "2 times". */
const times = (ratio: number) => `${Number(ratio.toFixed(2))} times`

const SEVERITY_RANK: Readonly<Record<GoogleAlertSeverity, number>> = { danger: 0, warn: 1, info: 2 }
const KIND_RANK = new Map(GOOGLE_ALERT_KINDS.map((kind, i) => [kind, i]))

interface Totals { cost: bigint; clicks: number; conv4: bigint }
const NONE: Totals = { cost: 0n, clicks: 0, conv4: 0n }
const plus = (a: Totals, d: AlertDay): Totals => ({ cost: a.cost + d.costMicros, clicks: a.clicks + d.clicks, conv4: a.conv4 + d.conversions4 })

export function evaluateGoogleAdsAlerts(s: GoogleAdsAlertSnapshot, t: GoogleAdsAlertThresholds = googleAdsAlertThresholds()): EvaluatedAlerts {
  const items: EvaluatedAlert[] = []
  const notChecked: EvaluatedAlerts['notChecked'] = []
  const skip = (kind: GoogleAlertKind, reason: string) => notChecked.push({ kind, reason })
  const add = (alert: Omit<EvaluatedAlert, 'alertId'>) =>
    items.push({ ...alert, alertId: `${alert.kind}~${alert.googleCampaignId ?? 'account'}~${alert.occurrence}` })

  const today = todayIn(s.timeZone, s.now)
  const yesterday = addDays(today, -1)
  const read = s.metricsRead
  const allRead = (w: DayWindow) => !!read && w.from <= w.to && w.from >= read.from && w.to <= read.to

  // Campaign → day → numbers; and the account's days (every campaign, also those Nexus has no settings row for).
  const byCampaign = new Map<string, Map<string, AlertDay>>()
  const account = new Map<string, Totals>()
  for (const d of s.days) {
    let days = byCampaign.get(d.googleCampaignId)
    if (!days) byCampaign.set(d.googleCampaignId, (days = new Map()))
    days.set(d.day, d)
    account.set(d.day, plus(account.get(d.day) ?? NONE, d))
  }
  const sumOf = (googleCampaignId: string, w: DayWindow): Totals =>
    daysOf(w).reduce((acc, day) => {
      const d = byCampaign.get(googleCampaignId)?.get(day)
      return d ? plus(acc, d) : acc
    }, NONE)
  const accountSum = (w: DayWindow): Totals =>
    daysOf(w).reduce((acc, day) => {
      const d = account.get(day)
      return d ? { cost: acc.cost + d.cost, clicks: acc.clicks + d.clicks, conv4: acc.conv4 + d.conv4 } : acc
    }, NONE)
  /** The first day of the run of read days with no conversion that ends yesterday. */
  const streakStart = (conv4On: (day: string) => bigint): string => {
    let start = yesterday
    while (read && addDays(start, -1) >= read.from && conv4On(addDays(start, -1)) === 0n) start = addDays(start, -1)
    return start
  }

  const live = s.campaigns.filter((c) => !c.removed && c.status !== 'REMOVED')
  const enabled = live.filter((c) => c.status === 'ENABLED')
  const enabledIds = new Set(enabled.map((c) => c.googleCampaignId))
  const withBudget = live.filter((c) => c.dailyBudgetMicros != null && c.dailyBudgetMicros > 0n)

  // spend_pace — yesterday against the daily budget.
  if (!allRead({ from: yesterday, to: yesterday })) skip('spend_pace', 'Nexus has not read yesterday\'s numbers yet.')
  else {
    const scaled = BigInt(Math.round(t.spendPaceRatio * 1000))
    for (const c of withBudget) {
      const spend = sumOf(c.googleCampaignId, { from: yesterday, to: yesterday }).cost
      if (spend * 1000n < c.dailyBudgetMicros! * scaled) continue
      add({
        kind: 'spend_pace', severity: 'warn', googleCampaignId: c.googleCampaignId, since: yesterday, occurrence: yesterday,
        title: 'Spent fast yesterday',
        body: `Yesterday this campaign spent ${times(t.spendPaceRatio)} its daily budget or more.`,
        money: { spendCents: spend, dailyBudgetCents: c.dailyBudgetMicros },
        counts: { ratio: Number((Number(spend) / Number(c.dailyBudgetMicros)).toFixed(2)) },
      })
    }
  }

  // month_pace — this month so far against the month's pace of the daily budget.
  const monthStart = `${today.slice(0, 8)}01`
  if (monthStart <= yesterday) {
    const month = { from: monthStart, to: yesterday }
    if (!allRead(month)) skip('month_pace', 'Nexus has not read every day of this month yet.')
    else {
      const elapsed = dayCount(month)
      const daysInMonth = dayCount({ from: monthStart, to: addDays(`${addDays(monthStart, 31).slice(0, 8)}01`, -1) })
      for (const c of withBudget) {
        const spend = sumOf(c.googleCampaignId, month).cost
        const monthBudget = DAYS_PER_BUDGET_MONTH * Number(c.dailyBudgetMicros)
        const pace = monthBudget * (elapsed / daysInMonth) * t.monthPaceRatio
        if (Number(spend) <= pace) continue
        add({
          kind: 'month_pace', severity: 'warn', googleCampaignId: c.googleCampaignId, since: monthStart, occurrence: monthStart.slice(0, 7),
          title: 'Spending fast this month',
          body: `This month this campaign spent more than ${Math.round((t.monthPaceRatio - 1) * 100)}% above the pace its daily budget allows.`,
          money: { monthSpendCents: spend, monthBudgetCents: BigInt(Math.round(monthBudget)), limitCents: BigInt(Math.round(pace)), dailyBudgetCents: c.dailyBudgetMicros },
          counts: { days: elapsed },
        })
      }
    }
  }

  // zero_conversions and tracking_stopped (a campaign) — the last days, and the days before them.
  const last = { from: addDays(yesterday, -(t.zeroConversionDays - 1)), to: yesterday }
  const prior = { from: addDays(last.from, -t.priorDays), to: addDays(last.from, -1) }
  const lastRead = allRead(last)
  if (!lastRead) skip('zero_conversions', `Nexus has not read every one of the last ${t.zeroConversionDays} days yet.`)
  else {
    const priorRead = allRead(prior)
    for (const c of enabled) {
      const now = sumOf(c.googleCampaignId, last)
      if (now.cost <= 0n || now.clicks < t.zeroConversionClicks || now.conv4 !== 0n) continue
      const start = streakStart((day) => byCampaign.get(c.googleCampaignId)?.get(day)?.conversions4 ?? 0n)
      const before = priorRead ? Number(sumOf(c.googleCampaignId, prior).conv4) / 10_000 : null
      if (before != null && before >= t.campaignPriorConversions) {
        add({
          kind: 'tracking_stopped', severity: 'danger', googleCampaignId: c.googleCampaignId, since: start, occurrence: start,
          title: 'Conversions stopped',
          body: `This campaign had conversions before and none in the last ${t.zeroConversionDays} days. Check that conversion tracking still works.`,
          money: { spendCents: now.cost }, counts: { clicks: now.clicks, priorConversions: before, days: t.zeroConversionDays },
        })
      } else {
        add({
          kind: 'zero_conversions', severity: 'warn', googleCampaignId: c.googleCampaignId, since: start, occurrence: start,
          title: `No conversions in ${t.zeroConversionDays} days`,
          body: `This campaign got ${t.zeroConversionClicks} clicks or more in the last ${t.zeroConversionDays} days, and no conversion.`,
          money: { spendCents: now.cost }, counts: { clicks: now.clicks, days: t.zeroConversionDays },
        })
      }
    }
  }

  // tracking_stopped (the account) — spend every one of the last days, no conversion, after conversions before.
  const stop = { from: addDays(yesterday, -(t.accountStopDays - 1)), to: yesterday }
  const stopPrior = { from: addDays(stop.from, -t.priorDays), to: addDays(stop.from, -1) }
  const accountChecked = allRead(stop) && allRead(stopPrior)
  if (accountChecked) {
    const spentEachDay = daysOf(stop).every((day) => (account.get(day)?.cost ?? 0n) > 0n)
    const now = accountSum(stop)
    const before = Number(accountSum(stopPrior).conv4) / 10_000
    if (spentEachDay && now.conv4 === 0n && before >= t.accountPriorConversions) {
      const start = streakStart((day) => account.get(day)?.conv4 ?? 0n)
      add({
        kind: 'tracking_stopped', severity: 'danger', googleCampaignId: null, since: start, occurrence: start,
        title: 'Conversions stopped for the account',
        body: `The account spent on each of the last ${t.accountStopDays} days and got no conversion, after conversions in the ${t.priorDays} days before. Check that conversion tracking still works.`,
        money: { spendCents: now.cost }, counts: { priorConversions: before, days: t.accountStopDays },
      })
    }
  }
  if (!accountChecked && !(lastRead && allRead(prior))) {
    skip('tracking_stopped', `Nexus has not read every one of the last ${t.accountStopDays + t.priorDays} days yet.`)
  }

  // ads_disapproved and ads_limited — open issues of ads in enabled campaigns, one alert per campaign.
  if (!s.adPolicyReadAt) {
    skip('ads_disapproved', 'Nexus has not read Google\'s review of the ads yet.')
    skip('ads_limited', 'Nexus has not read Google\'s review of the ads yet.')
  } else {
    const byCampaignIssues = (statuses: string[]) => {
      const out = new Map<string, AlertIssue[]>()
      for (const issue of s.issues) {
        if (issue.kind !== 'AD' || !issue.googleCampaignId || !enabledIds.has(issue.googleCampaignId) || !statuses.includes(issue.status)) continue
        const list = out.get(issue.googleCampaignId) ?? []
        list.push(issue)
        out.set(issue.googleCampaignId, list)
      }
      return out
    }
    const earliest = (issues: AlertIssue[]) => new Date(Math.min(...issues.map((i) => i.firstSeenAt.getTime()))).toISOString()
    for (const [googleCampaignId, issues] of byCampaignIssues(['DISAPPROVED'])) {
      add({
        kind: 'ads_disapproved', severity: 'danger', googleCampaignId, since: earliest(issues), occurrence: hashOf(issues.map((i) => i.entityKey)),
        title: 'Ads disapproved',
        body: `Google disapproved ${plural(issues.length, 'ad')} in this campaign. ${issues.length === 1 ? 'It does' : 'They do'} not show.`,
        money: {}, counts: {},
      })
    }
    for (const [googleCampaignId, issues] of byCampaignIssues(['APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY'])) {
      add({
        kind: 'ads_limited', severity: 'info', googleCampaignId, since: earliest(issues), occurrence: hashOf(issues.map((i) => i.entityKey)),
        title: 'Ads limited',
        body: `Google shows ${plural(issues.length, 'ad')} in this campaign only in some places or to some people.`,
        money: {}, counts: {},
      })
    }
  }

  // products_not_eligible — open product issues Google will not show the product for.
  if (!s.productStatusReadAt) skip('products_not_eligible', 'Nexus has not read the product statuses yet.')
  else {
    const items = new Map<string, Date>()
    for (const issue of s.issues) {
      if (issue.kind !== 'PRODUCT' || issue.status !== 'NOT_ELIGIBLE') continue
      const itemId = (issue.itemId ?? issue.entityKey.split('~').at(-1) ?? issue.entityKey).toLowerCase()
      const had = items.get(itemId)
      if (!had || issue.firstSeenAt < had) items.set(itemId, issue.firstSeenAt)
    }
    if (items.size) {
      add({
        kind: 'products_not_eligible', severity: 'warn', googleCampaignId: null,
        since: new Date(Math.min(...[...items.values()].map((d) => d.getTime()))).toISOString(), occurrence: hashOf([...items.keys()]),
        title: 'Products Google will not show',
        body: `Google will not show ${plural(items.size, 'product')} in its ads.`,
        money: {}, counts: {},
      })
    }
  }

  // auto_apply_on — Google applies a kind of recommendation by itself.
  if (!s.autoApplyReadAt) skip('auto_apply_on', 'Nexus has not read the auto-apply settings yet.')
  else {
    const on = s.autoApply.filter((a) => a.status === 'ENABLED')
    if (on.length) {
      const since = on.map((a) => a.since?.getTime()).filter((n): n is number => n != null)
      add({
        kind: 'auto_apply_on', severity: 'warn', googleCampaignId: null, since: since.length ? new Date(Math.min(...since)).toISOString() : null,
        occurrence: hashOf(on.map((a) => a.type)),
        title: 'Google applies changes on its own',
        body: `Auto-apply is on for ${plural(on.length, 'kind')} of recommendation. Google changes the account without asking.`,
        money: {}, counts: {},
      })
    }
  }

  // changed_by_google and settings_changed — the change history of the last days.
  if (!s.changesReadThrough) {
    skip('changed_by_google', 'Nexus has not read Google\'s change history yet.')
    skip('settings_changed', 'Nexus has not read Google\'s change history yet.')
  } else {
    const since = new Date(s.now.getTime() - t.changeDays * 86_400_000)
    const recent = s.changes.filter((c) => c.changedAt >= since).sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime())
    const byGoogle = recent.filter((c) => isByGoogle(c.clientType))
    if (byGoogle.length) {
      add({
        // One bell a day at most (M6): the occurrence is the day of the newest change by Google.
        kind: 'changed_by_google', severity: 'warn', googleCampaignId: null, since: byGoogle[0].changedAt.toISOString(),
        occurrence: dayOf(byGoogle.at(-1)!.changedAt, s.timeZone),
        title: 'Google changed the account',
        body: `Google made ${plural(byGoogle.length, 'change')} on its own in the last ${t.changeDays} days.`,
        money: {}, counts: {},
      })
    }
    const watched = recent.filter((c) => isWatchedChange(c.resourceType, c.changedFields))
    if (watched.length) {
      add({
        kind: 'settings_changed', severity: 'info', googleCampaignId: null, since: watched[0].changedAt.toISOString(),
        occurrence: dayOf(watched.at(-1)!.changedAt, s.timeZone),
        title: 'Campaign settings changed',
        body: `Budgets, bids, networks or AI settings changed ${plural(watched.length, 'time')} in the last ${t.changeDays} days.`,
        money: {}, counts: {},
      })
    }
  }

  // moved_to_ai_max — Google moved (or will move) a campaign to AI Max.
  if (!s.settingsReadAt) skip('moved_to_ai_max', 'Nexus has not read the campaign settings yet.')
  else {
    for (const c of live) {
      if (!c.broadMatchMigratedAt) continue
      const day = dayOf(c.broadMatchMigratedAt, s.timeZone)
      const done = c.broadMatchMigratedAt.getTime() <= s.now.getTime()
      add({
        kind: 'moved_to_ai_max', severity: 'warn', googleCampaignId: c.googleCampaignId, since: c.broadMatchMigratedAt.toISOString(), occurrence: day,
        title: done ? 'Moved to AI Max' : 'Moving to AI Max',
        body: done
          ? `Google moved this campaign to AI Max on ${dayWords(day)}. Its ads may now show for more searches.`
          : `Google will move this campaign to AI Max on ${dayWords(day)}. Its ads may then show for more searches.`,
        money: {}, counts: {},
      })
    }
  }

  items.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || (KIND_RANK.get(a.kind) ?? 0) - (KIND_RANK.get(b.kind) ?? 0)
    || (a.alertId < b.alertId ? -1 : a.alertId > b.alertId ? 1 : 0))
  return { items, notChecked }
}
