/**
 * H.8 — saved-view alert evaluator.
 *
 * For one alert (or a batch): re-run the saved-view's filter, get
 * the current count, compare to threshold/baseline, fire a
 * Notification if the condition is met AND the cooldown has
 * elapsed.
 *
 * Always updates `lastCheckedAt` + `lastCount` on the alert row,
 * regardless of whether it fired — the topnav badge needs the
 * latest count even between fires.
 *
 * Cooldown semantics: after firing we bump `baselineCount` to
 * `lastCount` so a flapping condition (e.g. count hovering at
 * threshold ± 1) doesn't notify on every check. The user's intent
 * with CHANGE_ABS / CHANGE_PCT is "tell me when this *moves* from
 * its current normal", and rebaselining after a fire gives them
 * exactly that.
 */

import type { PrismaClient, Prisma } from '@prisma/client'
import { buildProductWhereFromSavedView } from '../saved-views/build-where.service.js'

export interface AlertEvalContext {
  prisma: PrismaClient
}

export interface AlertEvalResult {
  alertId: string
  count: number
  matched: boolean
  fired: boolean
  reason?: string
}

interface AlertWithView {
  id: string
  userId: string
  name: string
  isActive: boolean
  comparison: string
  threshold: Prisma.Decimal
  baselineCount: number
  lastFiredAt: Date | null
  cooldownMinutes: number
  savedView: { id: string; name: string; filters: unknown }
}

function compare(
  comparison: string,
  current: number,
  baseline: number,
  threshold: number,
): boolean {
  switch (comparison) {
    case 'GT':
      return current > threshold
    case 'LT':
      return current < threshold
    case 'CHANGE_ABS':
      return Math.abs(current - baseline) >= threshold
    case 'CHANGE_PCT': {
      const denom = Math.max(1, baseline)
      return Math.abs(current - baseline) / denom >= threshold
    }
    default:
      return false
  }
}

function reasonLine(
  comparison: string,
  current: number,
  baseline: number,
  threshold: number,
): string {
  switch (comparison) {
    case 'GT':
      return `count is ${current} (> ${threshold})`
    case 'LT':
      return `count is ${current} (< ${threshold})`
    case 'CHANGE_ABS': {
      const delta = current - baseline
      const sign = delta >= 0 ? '+' : ''
      return `count moved ${sign}${delta} (from ${baseline} to ${current})`
    }
    case 'CHANGE_PCT': {
      const delta = current - baseline
      const denom = Math.max(1, baseline)
      const pct = Math.round((delta / denom) * 100)
      return `count moved ${pct >= 0 ? '+' : ''}${pct}% (from ${baseline} to ${current})`
    }
    default:
      return `count is ${current}`
  }
}

function buildHref(filters: unknown): string {
  const params = new URLSearchParams()
  if (filters && typeof filters === 'object') {
    const f = filters as Record<string, unknown>
    if (typeof f.search === 'string' && f.search) params.set('search', f.search)
    const passList = (key: string) => {
      const v = f[key]
      if (Array.isArray(v) && v.length > 0) {
        for (const item of v) {
          if (typeof item === 'string') params.append(key, item)
        }
      } else if (typeof v === 'string' && v) {
        for (const part of v.split(',').map((s) => s.trim()).filter(Boolean)) {
          params.append(key, part)
        }
      }
    }
    passList('status')
    passList('channel')
    passList('marketplace')
    if (typeof f.stockLevel === 'string' && f.stockLevel) {
      params.set('stockLevel', f.stockLevel)
    }
  }
  const qs = params.toString()
  return qs ? `/products?${qs}` : '/products'
}

export async function evaluateAlert(
  ctx: AlertEvalContext,
  alert: AlertWithView,
): Promise<AlertEvalResult> {
  const { prisma } = ctx
  const where = await buildProductWhereFromSavedView(
    prisma,
    alert.savedView.filters as any,
  )
  const count = await prisma.product.count({ where })
  const threshold = Number(alert.threshold)
  const matched = compare(
    alert.comparison,
    count,
    alert.baselineCount,
    threshold,
  )

  // Cooldown gate: even if matched, suppress fires that fall inside
  // cooldownMinutes since the last fire.
  let fired = false
  if (matched) {
    const now = Date.now()
    const lastFireTs = alert.lastFiredAt?.getTime() ?? 0
    const cooldownMs = alert.cooldownMinutes * 60_000
    if (now - lastFireTs >= cooldownMs) {
      fired = true
    }
  }

  // Always update lastChecked + lastCount; conditionally bump baseline
  // and fire timestamp.
  await prisma.savedViewAlert.update({
    where: { id: alert.id },
    data: {
      lastCheckedAt: new Date(),
      lastCount: count,
      ...(fired
        ? { lastFiredAt: new Date(), baselineCount: count }
        : {}),
    },
  })

  if (fired) {
    const reason = reasonLine(
      alert.comparison,
      count,
      alert.baselineCount,
      threshold,
    )
    await prisma.notification.create({
      data: {
        userId: alert.userId,
        type: 'saved-view-alert',
        severity:
          alert.comparison === 'LT'
            ? 'warn'
            : alert.comparison === 'GT'
              ? 'warn'
              : 'info',
        title: `${alert.name} — ${reason}`,
        body: `Saved view "${alert.savedView.name}" tripped.`,
        entityType: 'SavedView',
        entityId: alert.savedView.id,
        href: buildHref(alert.savedView.filters),
        meta: {
          alertId: alert.id,
          comparison: alert.comparison,
          threshold,
          baselineCount: alert.baselineCount,
          currentCount: count,
        },
      },
    })
    return { alertId: alert.id, count, matched: true, fired: true, reason }
  }

  return { alertId: alert.id, count, matched, fired: false }
}

/**
 * Walk all active alerts and evaluate each. Returns per-alert
 * results. Errors on one alert don't stop the batch — bad filters
 * shouldn't take down the entire cron.
 */
export async function evaluateAllActiveAlerts(
  ctx: AlertEvalContext,
): Promise<AlertEvalResult[]> {
  const alerts = await ctx.prisma.savedViewAlert.findMany({
    where: { isActive: true },
    include: {
      savedView: { select: { id: true, name: true, filters: true } },
    },
    orderBy: { lastCheckedAt: 'asc' },
  })
  const results: AlertEvalResult[] = []
  for (const a of alerts) {
    try {
      const r = await evaluateAlert(ctx, a as AlertWithView)
      results.push(r)
    } catch (err) {
      results.push({
        alertId: a.id,
        count: 0,
        matched: false,
        fired: false,
        reason:
          err instanceof Error
            ? `evaluator failed: ${err.message}`
            : 'evaluator failed',
      })
    }
  }
  return results
}
