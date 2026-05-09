/**
 * L.16.0 — Alert evaluator + dispatcher.
 *
 * Runs once per minute via the alert-evaluator cron. For each
 * enabled AlertRule:
 *
 *   1. Compute the current value of the rule's metric over its
 *      windowMinutes (errorRate, latencyP95, queueDepth,
 *      activeErrorGroups, staleCrons).
 *   2. Compare against the threshold using the rule's operator.
 *   3. If the rule transitions FROM not-firing TO firing, create an
 *      AlertEvent(status=TRIGGERED) and dispatch notifications.
 *   4. If the rule transitions FROM firing TO not-firing, auto-
 *      resolve the open AlertEvent (status=RESOLVED, resolvedBy='auto').
 *   5. If the rule stays in the same state, just update lastValue
 *      + lastEvaluatedAt — no spam.
 *
 * Notification channels supported today:
 *   - 'log'                — stdout via logger.warn (always works)
 *   - 'webhook:<url>'      — POST { rule, event, value } to the URL
 *   - 'email:<addr>'       — STUB (returns ok=false until wired)
 *   - 'slack:<channel>'    — STUB (returns ok=false until wired)
 *
 * Failure to dispatch one channel doesn't block the others; each
 * channel result is captured in AlertEvent.notifications.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

type Operator = 'gt' | 'gte' | 'lt' | 'lte'

const COMPARE: Record<Operator, (a: number, b: number) => boolean> = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
}

interface MetricContext {
  windowMs: number
  channel?: string | null
}

async function metricErrorRate(ctx: MetricContext): Promise<number> {
  const since = new Date(Date.now() - ctx.windowMs)
  const where = ctx.channel
    ? { createdAt: { gte: since }, channel: ctx.channel }
    : { createdAt: { gte: since } }
  const total = await prisma.outboundApiCallLog.count({ where })
  if (total === 0) return 0
  const failed = await prisma.outboundApiCallLog.count({
    where: { ...where, success: false },
  })
  return failed / total
}

async function metricLatencyP95(ctx: MetricContext): Promise<number> {
  const since = new Date(Date.now() - ctx.windowMs)
  const where = ctx.channel
    ? { createdAt: { gte: since }, channel: ctx.channel }
    : { createdAt: { gte: since } }
  // Read latency values + compute percentile in JS. For typical
  // alert windows (5-15 min) this is at most a few thousand rows;
  // pulling them all is cheaper than a percentile_disc query that
  // can't share the same Prisma WHERE shape.
  const rows = await prisma.outboundApiCallLog.findMany({
    where,
    select: { latencyMs: true },
    orderBy: { latencyMs: 'asc' },
  })
  if (rows.length === 0) return 0
  const idx = Math.max(0, Math.floor(rows.length * 0.95) - 1)
  return rows[idx].latencyMs
}

async function metricQueueDepth(_ctx: MetricContext): Promise<number> {
  return prisma.outboundSyncQueue.count({
    where: { syncStatus: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] } },
  })
}

async function metricActiveErrorGroups(_ctx: MetricContext): Promise<number> {
  return prisma.syncLogErrorGroup.count({
    where: { resolutionStatus: 'ACTIVE' },
  })
}

async function metricStaleCrons(_ctx: MetricContext): Promise<number> {
  return prisma.cronRun.count({
    where: {
      status: 'RUNNING',
      startedAt: { lt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    },
  })
}

const METRIC_FNS: Record<string, (ctx: MetricContext) => Promise<number>> = {
  errorRate: metricErrorRate,
  latencyP95: metricLatencyP95,
  queueDepth: metricQueueDepth,
  activeErrorGroups: metricActiveErrorGroups,
  staleCrons: metricStaleCrons,
}

interface DispatchResult {
  channel: string
  ok: boolean
  error?: string
}

async function dispatch(
  rule: { id: string; name: string; metric: string; threshold: number },
  channel: string,
  value: number,
): Promise<DispatchResult> {
  if (channel === 'log') {
    logger.warn('[ALERT] rule fired', {
      ruleId: rule.id,
      name: rule.name,
      metric: rule.metric,
      value,
      threshold: rule.threshold,
    })
    return { channel, ok: true }
  }

  if (channel.startsWith('webhook:')) {
    const url = channel.slice('webhook:'.length)
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rule: { id: rule.id, name: rule.name, metric: rule.metric, threshold: rule.threshold },
          value,
          firedAt: new Date().toISOString(),
        }),
      })
      if (!r.ok) {
        return { channel, ok: false, error: `HTTP ${r.status}` }
      }
      return { channel, ok: true }
    } catch (e) {
      return { channel, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  // Stubs — wire when notification infrastructure exists.
  if (channel.startsWith('email:') || channel.startsWith('slack:')) {
    return {
      channel,
      ok: false,
      error: `${channel.split(':')[0]} dispatch not wired yet`,
    }
  }

  return { channel, ok: false, error: 'unknown channel scheme' }
}

interface EvalResult {
  rulesEvaluated: number
  rulesFired: number
  rulesResolved: number
  rulesUnchanged: number
  errors: number
}

export async function runAlertEvaluator(): Promise<EvalResult> {
  const rules = await prisma.alertRule.findMany({ where: { enabled: true } })
  const result: EvalResult = {
    rulesEvaluated: 0,
    rulesFired: 0,
    rulesResolved: 0,
    rulesUnchanged: 0,
    errors: 0,
  }

  for (const rule of rules) {
    result.rulesEvaluated++
    const fn = METRIC_FNS[rule.metric]
    if (!fn) {
      logger.warn('[alert-evaluator] unknown metric', {
        ruleId: rule.id,
        metric: rule.metric,
      })
      result.errors++
      continue
    }
    try {
      const value = await fn({
        windowMs: rule.windowMinutes * 60 * 1000,
        channel: rule.channel,
      })
      const op = rule.operator as Operator
      const fires = COMPARE[op] ? COMPARE[op](value, rule.threshold) : false

      if (fires && !rule.lastFired) {
        // Transition: not-firing → firing. Create event + notify.
        const channels = (rule.notificationChannels as string[]) ?? ['log']
        const dispatchResults: DispatchResult[] = []
        for (const ch of channels) {
          dispatchResults.push(await dispatch(rule, ch, value))
        }
        await prisma.alertEvent.create({
          data: {
            ruleId: rule.id,
            value,
            status: 'TRIGGERED',
            notifications: dispatchResults as never,
          },
        })
        await prisma.alertRule.update({
          where: { id: rule.id },
          data: {
            lastEvaluatedAt: new Date(),
            lastValue: value,
            lastFired: true,
          },
        })
        result.rulesFired++
      } else if (!fires && rule.lastFired) {
        // Transition: firing → not-firing. Auto-resolve any open
        // event for this rule.
        await prisma.alertEvent.updateMany({
          where: { ruleId: rule.id, status: 'TRIGGERED' },
          data: {
            status: 'RESOLVED',
            resolvedAt: new Date(),
            resolvedBy: 'auto',
          },
        })
        await prisma.alertRule.update({
          where: { id: rule.id },
          data: {
            lastEvaluatedAt: new Date(),
            lastValue: value,
            lastFired: false,
          },
        })
        result.rulesResolved++
      } else {
        // No transition — just refresh the lastEvaluated/lastValue.
        await prisma.alertRule.update({
          where: { id: rule.id },
          data: { lastEvaluatedAt: new Date(), lastValue: value },
        })
        result.rulesUnchanged++
      }
    } catch (err) {
      logger.error('[alert-evaluator] rule failed', {
        ruleId: rule.id,
        err: err instanceof Error ? err.message : String(err),
      })
      result.errors++
    }
  }

  return result
}
