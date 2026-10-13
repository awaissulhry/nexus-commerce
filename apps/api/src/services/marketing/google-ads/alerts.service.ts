/**
 * Google Ads step 1b — what needs a look: R14 (live, over what Nexus has stored) and the bell after each daily read
 * (plan-1b-backend §6). The rules are alerts.ts (pure); this file loads the snapshot and delivers.
 *
 * The bell: `raiseGoogleAdsAlerts(customerId)` runs after a read, never throws, and writes Notification rows to the
 * business's owners through raiseChannelAlertInTx, one per alert and occurrence (spend pace once a day, month pace once a
 * month, a zero-conversion streak once, a set of disapproved ads once, changes by Google once a day per account — M6).
 * Notifications carry no amount. Info alerts (ads limited, settings changed) stay on the page. Kill switch:
 * NEXUS_GOOGLE_ADS_ALERTS=off.
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { raiseChannelAlertInTx, type ChannelAlertKind } from '../../cx/channel-alerts.service.js'
import { dateToDay, dayToDate } from './dates.js'
import {
  alertDaysFrom,
  evaluateGoogleAdsAlerts,
  googleAdsAlertThresholds,
  type EvaluatedAlert,
  type GoogleAdsAlertSnapshot,
} from './alerts.js'
import {
  SUM_FIELDS,
  currencyExponent,
  customerOf,
  googleAdsAccount,
  googleCampaignDirectory,
  googleReadStates,
  microsToMinor,
  readRangeOf,
  toSums,
  type CustomerRow,
  type GoogleCampaignDirectory,
} from './read.service.js'
import { GOOGLE_ALERT_KINDS, type GoogleAlert, type GoogleAlertKind, type GoogleAlerts } from './read-types.js'

/** The bell kind of each alert; none = shown on the page only. */
export const GOOGLE_ALERT_BELL: Readonly<Partial<Record<GoogleAlertKind, ChannelAlertKind>>> = {
  spend_pace: 'google-ads-spend-pace',
  month_pace: 'google-ads-spend-pace',
  zero_conversions: 'google-ads-zero-conversions',
  tracking_stopped: 'google-ads-zero-conversions',
  ads_disapproved: 'google-ads-disapproved',
  products_not_eligible: 'google-ads-disapproved',
  auto_apply_on: 'google-ads-auto-apply',
  changed_by_google: 'google-ads-changed-by-google',
  moved_to_ai_max: 'google-ads-changed-by-google',
}

const GOOGLE_PAGE = '/marketing/ads/google'

/** Where the bell and the MCP tool point (a bare path; the bell adds the business). The page builds its own (M4). */
export function alertHref(kind: GoogleAlertKind, campaignId: string | null): string {
  switch (kind) {
    case 'spend_pace':
    case 'month_pace':
    case 'zero_conversions':
    case 'tracking_stopped':
      return campaignId ? `${GOOGLE_PAGE}?campaign=${encodeURIComponent(campaignId)}&tab=overview` : GOOGLE_PAGE
    case 'ads_disapproved':
    case 'products_not_eligible':
    case 'ads_limited':
      return `${GOOGLE_PAGE}?view=disapprovals`
    default:
      return `${GOOGLE_PAGE}?view=on-its-own`
  }
}

// ── The snapshot ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Everything the rules look at, for one account, from the stored tables. */
export async function googleAdsAlertSnapshot(customer: CustomerRow, now: Date): Promise<GoogleAdsAlertSnapshot> {
  const t = googleAdsAlertThresholds()
  const customerId = customer.customerId
  const days = alertDaysFrom(customer.timeZone || null, now, t)
  const changesFrom = new Date(now.getTime() - t.changeDays * 86_400_000)
  const [states, campaigns, sums, issues, autoApply, changes] = await Promise.all([
    googleReadStates(customerId),
    prisma.googleAdsCampaign.findMany({
      where: { customerId },
      select: { campaignId: true, status: true, removedAt: true, budgetAmountMicros: true, broadMatchMigratedAt: true },
    }),
    prisma.googleAdsDailyMetric.groupBy({
      by: ['campaignId', 'date'],
      where: { customerId, entityType: 'CAMPAIGN', date: { gte: dayToDate(days.from), lte: dayToDate(days.to) } },
      _sum: SUM_FIELDS,
    }),
    prisma.googleAdsPolicyIssue.findMany({
      where: { customerId, resolvedAt: null, OR: [{ kind: 'AD', status: { in: ['DISAPPROVED', 'APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY'] } }, { kind: 'PRODUCT', status: 'NOT_ELIGIBLE' }] },
      select: { kind: true, entityKey: true, campaignId: true, itemId: true, status: true, firstSeenAt: true },
    }),
    prisma.googleAdsAutoApply.findMany({ where: { customerId, removedAt: null }, select: { type: true, status: true, createdAtGoogle: true } }),
    prisma.googleAdsChangeEvent.findMany({
      where: { customerId, changedAt: { gte: changesFrom } },
      // userEmail is deliberately not selected.
      select: { changedAt: true, clientType: true, campaignId: true, resourceType: true, changedFields: true },
    }),
  ])
  return {
    customerId,
    timeZone: customer.timeZone || null,
    now,
    metricsRead: readRangeOf(customer),
    campaigns: campaigns.map((c) => ({
      googleCampaignId: c.campaignId, status: c.status, removed: !!c.removedAt, dailyBudgetMicros: c.budgetAmountMicros, broadMatchMigratedAt: c.broadMatchMigratedAt,
    })),
    days: sums.map((row) => {
      const s = toSums(row._sum)
      return { googleCampaignId: row.campaignId, day: dateToDay(row.date), costMicros: s.costMicros, clicks: s.clicks, conversions4: s.conversions4 }
    }),
    adPolicyReadAt: states.readAt('AD_POLICY'),
    productStatusReadAt: states.readAt('PRODUCT_STATUS'),
    autoApplyReadAt: states.readAt('AUTO_APPLY'),
    settingsReadAt: states.readAt('CAMPAIGN_SETTINGS'),
    issues: issues.map((i) => ({ kind: i.kind === 'PRODUCT' ? 'PRODUCT' : 'AD', entityKey: i.entityKey, googleCampaignId: i.campaignId, itemId: i.itemId, status: i.status, firstSeenAt: i.firstSeenAt })),
    autoApply: autoApply.map((a) => ({ type: a.type, status: a.status, since: a.createdAtGoogle })),
    changesReadThrough: customer.changesSyncedThrough,
    changes: changes.map((c) => ({ changedAt: c.changedAt, clientType: c.clientType, googleCampaignId: c.campaignId, resourceType: c.resourceType, changedFields: c.changedFields })),
  }
}

/** One evaluated alert as R14 answers it: the campaign in Nexus's ids, money in minor units under `numbers`. */
function alertOf(alert: EvaluatedAlert, directory: GoogleCampaignDirectory, exponent: number): GoogleAlert {
  const campaign = alert.googleCampaignId ? directory(alert.googleCampaignId) : null
  const numbers: Record<string, number | null> = {}
  for (const [key, micros] of Object.entries(alert.money)) numbers[key] = micros == null ? null : microsToMinor(micros, exponent)
  for (const [key, value] of Object.entries(alert.counts)) numbers[key] = value ?? null
  return {
    alertId: alert.alertId,
    kind: alert.kind,
    severity: alert.severity,
    title: alert.title,
    body: alert.body,
    campaignId: campaign?.campaignId ?? null,
    externalCampaignId: alert.googleCampaignId,
    campaignName: campaign?.campaignName ?? null,
    since: alert.since,
    numbers: Object.keys(numbers).length ? numbers : null,
    href: alertHref(alert.kind, campaign?.campaignId ?? null),
  }
}

async function evaluate(customer: CustomerRow, now: Date) {
  const snapshot = await googleAdsAlertSnapshot(customer, now)
  const evaluated = evaluateGoogleAdsAlerts(snapshot)
  const directory = await googleCampaignDirectory(
    { customerId: customer.customerId, structureSyncedAt: customer.structureSyncedAt, timeZone: customer.timeZone || null },
    evaluated.items.map((a) => a.googleCampaignId ?? '').filter(Boolean),
  )
  return { evaluated, directory, exponent: currencyExponent(customer.currencyCode) }
}

// ── R14 ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** R14 — what needs a look in the chosen Google Ads account, checked now over what Nexus has read. */
export async function googleAdsAlerts(input: { connectionId?: string | null }, now: Date = new Date()): Promise<GoogleAlerts> {
  const context = await googleAdsAccount(input.connectionId)
  const checkedAt = now.toISOString()
  if (!context.customerId || !context.customer) {
    const reason = context.customerId ? 'Nexus has not read this Google Ads account yet.' : 'No Google Ads account is chosen yet.'
    return { checkedAt, items: [], notChecked: GOOGLE_ALERT_KINDS.map((kind) => ({ kind, reason })) }
  }
  const { evaluated, directory, exponent } = await evaluate(context.customer, now)
  return { checkedAt, items: evaluated.items.map((a) => alertOf(a, directory, exponent)), notChecked: evaluated.notChecked }
}

// ── The bell ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const googleAdsAlertsOff = (): boolean => (process.env.NEXUS_GOOGLE_ADS_ALERTS ?? '').trim().toLowerCase() === 'off'

/**
 * After a read of one account (in its business's context): ring the bell for each warn and danger alert once per
 * occurrence. Best effort: never throws; `raised` = notifications written.
 */
export async function raiseGoogleAdsAlerts(customerId: string, now: Date = new Date()): Promise<{ raised: number }> {
  if (googleAdsAlertsOff()) return { raised: 0 }
  try {
    const customer = await customerOf(customerId)
    if (!customer) return { raised: 0 }
    const { evaluated, directory } = await evaluate(customer, now)
    let raised = 0
    for (const alert of evaluated.items) {
      const kind = GOOGLE_ALERT_BELL[alert.kind]
      if (!kind || alert.severity === 'info') continue
      const campaign = alert.googleCampaignId ? directory(alert.googleCampaignId) : null
      try {
        const result = await raiseChannelAlertInTx(prisma, {
          kind,
          severity: alert.severity,
          title: `Google Ads: ${alert.title}`,
          // Never an amount: the title and body carry none; the campaign is named by its name.
          body: campaign?.campaignName ? `${campaign.campaignName}: ${alert.body}` : alert.body,
          entityType: alert.googleCampaignId ? 'google-ads-campaign' : 'google-ads-account',
          entityId: alert.googleCampaignId ? `${customerId}~${alert.googleCampaignId}` : customerId,
          href: alertHref(alert.kind, campaign?.campaignId ?? null),
          meta: { customerId, alert: alert.kind, googleCampaignId: alert.googleCampaignId, since: alert.since },
        }, { occurrenceId: `${alert.kind}:${alert.occurrence}` })
        raised += result.created
      } catch (error) {
        logger.warn('[google-ads-alerts] could not raise', { kind: alert.kind, error: (error as Error)?.message })
      }
    }
    return { raised }
  } catch (error) {
    logger.warn('[google-ads-alerts] could not check', { error: (error as Error)?.message })
    return { raised: 0 }
  }
}
