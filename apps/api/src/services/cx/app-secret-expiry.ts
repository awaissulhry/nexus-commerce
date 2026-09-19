/**
 * P0.5 (docs/channel-connections/FINAL-PLAN.md) — our app secrets' expiry dates, and the alerts.
 *
 * Amazon requires a new LWA client secret for our SP-API app every 180 days. If it is missed, every
 * Amazon call stops. `ChannelApp.secretExpiresAt` existed and the heartbeat read it, but nothing ever
 * wrote it, so no alert could fire. This module is the one place that:
 *   • lists each app's expiry date (never a secret),
 *   • records a date an operator reads from the channel's developer portal (with a ledger event),
 *   • raises the alerts at 90, 30 and 7 days and on expiry — each level ONCE per recorded date.
 *     (The heartbeat before P0.5 matched exact days 30/7/1 and would have fired every 15 minutes
 *     for the whole matching day.)
 *
 * Step 2 is automatic rotation (P6.1), which will write the next date itself.
 */
import prisma from '../../db.js'
import { alertService, AlertType } from '../monitoring/alert.service.js'
import { CRON_ACTOR, recordConnectionEvent, type Actor } from './events.service.js'

export const APP_SECRET_WARN_DAYS = [90, 30, 7] as const
const DAY_MS = 86_400_000

/** Whole days until `date`; negative once it has passed. */
export function daysUntil(date: Date, now: number = Date.now()): number {
  return Math.floor((date.getTime() - now) / DAY_MS)
}

/**
 * The most urgent alert level reached: 0 = expired, else the smallest warn day at or above
 * `daysLeft`; null = nothing to say yet (more than 90 days left).
 */
export function appSecretAlertLevel(daysLeft: number): number | null {
  if (daysLeft < 0) return 0
  const reached = APP_SECRET_WARN_DAYS.filter((d) => daysLeft <= d)
  return reached.length > 0 ? Math.min(...reached) : null
}

const APP_LABEL: Record<string, string> = {
  AMAZON_SP: 'Amazon SP-API',
  AMAZON_ADS: 'Amazon Ads',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  ETSY: 'Etsy',
}
export const appLabel = (channelKey: string): string => APP_LABEL[channelKey] ?? channelKey

export interface AppSecretSummary {
  channelKey: string
  label: string
  environment: string
  secretExpiresAt: string | null
  daysLeft: number | null
  rotatedAt: string | null
}

/** Every app row, with its expiry date. Selects no credential column. */
export async function listAppSecrets(now: number = Date.now()): Promise<AppSecretSummary[]> {
  const rows = await prisma.channelApp.findMany({
    select: { channelKey: true, environment: true, secretExpiresAt: true, rotatedAt: true },
    orderBy: [{ channelKey: 'asc' }, { environment: 'asc' }],
  })
  return rows.map((row) => ({
    channelKey: row.channelKey,
    label: appLabel(row.channelKey),
    environment: row.environment,
    secretExpiresAt: row.secretExpiresAt ? row.secretExpiresAt.toISOString() : null,
    daysLeft: row.secretExpiresAt ? daysUntil(row.secretExpiresAt, now) : null,
    rotatedAt: row.rotatedAt ? row.rotatedAt.toISOString() : null,
  }))
}

/** Record (or clear, with null) the expiry date an operator read from the channel's portal. */
export async function setAppSecretExpiry(input: {
  channelKey: string
  environment: string
  expiresAt: Date | null
  actor: Actor
}): Promise<AppSecretSummary | null> {
  const where = { channelKey_environment: { channelKey: input.channelKey, environment: input.environment } }
  const existing = await prisma.channelApp.findUnique({ where, select: { secretExpiresAt: true } })
  if (!existing) return null
  const from = existing.secretExpiresAt ? existing.secretExpiresAt.toISOString() : null
  await prisma.channelApp.update({ where, data: { secretExpiresAt: input.expiresAt } })
  await recordConnectionEvent({
    channelKey: input.channelKey,
    type: 'app_secret_expiry_set',
    actor: input.actor,
    detail: { environment: input.environment, from, to: input.expiresAt ? input.expiresAt.toISOString() : null },
  })
  const [summary] = (await listAppSecrets()).filter(
    (row) => row.channelKey === input.channelKey && row.environment === input.environment,
  )
  return summary ?? null
}

function alertText(channelKey: string, expiresAt: Date, daysLeft: number): { title: string; message: string } {
  const label = appLabel(channelKey)
  const date = expiresAt.toISOString().slice(0, 10)
  const consequence = channelKey === 'AMAZON_SP'
    ? 'When it expires, every Amazon call stops.'
    : `When it expires, ${label} calls stop.`
  if (daysLeft < 0) {
    return {
      title: `${label} app secret expired on ${date}`,
      message: `${consequence} Rotate the secret in the channel's developer portal now, then record the new expiry date in Settings → Channels → Diagnostics.`,
    }
  }
  return {
    title: `${label} app secret expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${date})`,
    message: `${consequence} Rotate the secret in the channel's developer portal before then, then record the new expiry date in Settings → Channels → Diagnostics.`,
  }
}

/** Raise each alert level once per recorded date. Returns how many alerts were raised. */
export async function runAppSecretExpiryAlerts(now: number = Date.now()): Promise<number> {
  const apps = await prisma.channelApp.findMany({
    where: { secretExpiresAt: { not: null } },
    select: { id: true, channelKey: true, environment: true, secretExpiresAt: true },
  })
  let raised = 0
  for (const app of apps) {
    const expiresAt = app.secretExpiresAt as Date
    const daysLeft = daysUntil(expiresAt, now)
    const level = appSecretAlertLevel(daysLeft)
    if (level === null) continue
    const iso = expiresAt.toISOString()
    const already = await prisma.connectionEvent.findFirst({
      where: {
        channelKey: app.channelKey,
        type: 'app_secret_expiry_warn',
        AND: [
          { detail: { path: ['environment'], equals: app.environment } },
          { detail: { path: ['secretExpiresAt'], equals: iso } },
          { detail: { path: ['level'], equals: level } },
        ],
      },
      select: { id: true },
    })
    if (already) continue
    await recordConnectionEvent({
      channelKey: app.channelKey,
      type: 'app_secret_expiry_warn',
      actor: CRON_ACTOR,
      detail: { environment: app.environment, secretExpiresAt: iso, level, daysLeft },
    })
    const { title, message } = alertText(app.channelKey, expiresAt, daysLeft)
    await alertService.createAlert(AlertType.CONNECTION_HEALTH, title, message, 1, [app.id])
    raised++
  }
  return raised
}
