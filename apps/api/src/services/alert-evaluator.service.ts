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
 *   - 'email:<addr>'       — sent via the Resend transport (L.18.0)
 *   - 'slack:<channel>'    — POSTed to NEXUS_SLACK_WEBHOOK_URL (L.18.0)
 *
 * Failure to dispatch one channel doesn't block the others; each
 * channel result is captured in AlertEvent.notifications.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { CRON_COMPLETED_STATUSES } from '../utils/cron-observability.js'
import { sendEmail } from './email/transport.js'

type Operator = (typeof ALERT_OPERATORS)[number]

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

// RRL.7 — review-pipeline OUTPUT freshness as an alertable metric. staleCrons
// above only catches STUCK crons (RUNNING > 2h); it cannot catch a cron that
// silently NEVER RAN (no row) or ran SUCCESS while producing nothing — which is
// exactly how the review pipeline froze. This surfaces the same weekend-proof
// "overdue-undelivered" backlog the dashboard banner uses, so an AlertRule can
// email/Slack the operator the moment the loop starves.
async function metricReviewOverdueUndelivered(_ctx: MetricContext): Promise<number> {
  const { computeReviewPipelineFreshness } = await import('./reviews/review-pipeline-health.service.js')
  const f = await computeReviewPipelineFreshness()
  return f.overdueUndelivered
}

// RRL.7 — generic "a cron that WAS running silently stopped" detector. The
// fixed-time daily crons (≈36 of them) share node-cron's silent-skip exposure:
// an in-memory timer that a container restart can skip with no replay. Rather
// than hand-maintain a per-cron cadence map (which rots), infer each cron's
// own cadence from its success history and flag any whose latest success is
// far past that cadence. Self-tuning, false-alarm-free (a never-run / disabled
// cron has no successes so it's never evaluated; the review pipeline's own
// never-ran case is covered by metricReviewOverdueUndelivered above).
export interface CronSuccessRow {
  jobName: string
  startedAt: Date
}

const HOUR = 60 * 60 * 1000

export function detectOverdueCrons(rows: CronSuccessRow[], now: number): string[] {
  const byJob = new Map<string, number[]>()
  for (const r of rows) {
    const arr = byJob.get(r.jobName) ?? []
    arr.push(r.startedAt.getTime())
    byJob.set(r.jobName, arr)
  }
  const overdue: string[] = []
  for (const [jobName, tsList] of byJob) {
    // Need enough history to trust the inferred cadence.
    if (tsList.length < 3) continue
    tsList.sort((a, b) => a - b)
    const gaps: number[] = []
    for (let i = 1; i < tsList.length; i++) gaps.push(tsList[i] - tsList[i - 1])
    gaps.sort((a, b) => a - b)
    const medianGap = gaps[Math.floor(gaps.length / 2)]
    const lastSuccess = tsList[tsList.length - 1]
    // Overdue = silent for >3× the normal cadence (and at least cadence+2h so a
    // tiny-interval cron can't trip on minor jitter). A daily cron (~24h median)
    // flags after ~72h; an hourly one after ~3h.
    const threshold = Math.max(medianGap * 3, medianGap + 2 * HOUR)
    if (now - lastSuccess > threshold) overdue.push(jobName)
  }
  return overdue
}

/** The crons overdue now. Exported for its test: which rows count as "it ran" is the whole question. */
export async function overdueCronJobs(now: number = Date.now()): Promise<string[]> {
  // 14d of completed runs is enough to infer cadence for daily/weekly crons
  // while bounding the row count. Select only what detectOverdueCrons needs.
  // P1.8 — a run that finished PARTIAL or NOT_CONFIGURED still RAN on schedule: counting SUCCESS alone made
  // such a job look silent. FAILED / RUNNING prove nothing about cadence.
  const rows = await prisma.cronRun.findMany({
    where: { status: { in: [...CRON_COMPLETED_STATUSES] }, startedAt: { gte: new Date(now - 14 * 24 * HOUR) } },
    select: { jobName: true, startedAt: true },
  })
  return detectOverdueCrons(rows, now)
}

async function metricOverdueCrons(_ctx: MetricContext): Promise<number> {
  return (await overdueCronJobs()).length
}

const METRIC_FNS: Record<string, (ctx: MetricContext) => Promise<number>> = {
  errorRate: metricErrorRate,
  latencyP95: metricLatencyP95,
  queueDepth: metricQueueDepth,
  activeErrorGroups: metricActiveErrorGroups,
  staleCrons: metricStaleCrons,
  reviewOverdueUndelivered: metricReviewOverdueUndelivered,
  overdueCrons: metricOverdueCrons,
}

/**
 * MCP full control P7 — the metrics a rule may watch and the comparisons it may make: exactly what this evaluator
 * computes and compares (Claude's set-alert-rule offers these and nothing else).
 */
export const ALERT_METRICS = Object.keys(METRIC_FNS) as [string, ...string[]]
export const ALERT_OPERATORS = ['gt', 'gte', 'lt', 'lte'] as const

interface DispatchResult {
  channel: string
  ok: boolean
  error?: string
}

/**
 * Platform health watchdog (2026-10-07) — what a check found, in plain words. A rule evaluated by the watchdog
 * (metric `platformHealth:<checkId>`) carries it into every channel, so the e-mail says what is wrong instead of
 * "metric = 2".
 */
export interface AlertDetail {
  /** ok | warn | fail */
  status: string
  message: string
  likelyCause?: string | null
  nextStep?: string | null
  /** True when an open alert got worse (warn → fail): the channels hear it again. */
  escalated?: boolean
}

/** The metric family the platform health watchdog evaluates itself, once a day: the minute evaluator skips it. */
export const PLATFORM_HEALTH_METRIC_PREFIX = 'platformHealth:'

const detailLines = (d: AlertDetail): string[] => [
  `${d.escalated ? 'Now ' : ''}${d.status.toUpperCase()}: ${d.message}`,
  ...(d.likelyCause ? [``, `Likely cause: ${d.likelyCause}`] : []),
  ...(d.nextStep ? [``, `Next step: ${d.nextStep}`] : []),
]

const escHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

async function dispatch(
  rule: { id: string; name: string; metric: string; threshold: number },
  channel: string,
  value: number,
  detail?: AlertDetail,
): Promise<DispatchResult> {
  if (channel === 'log') {
    logger.warn('[ALERT] rule fired', {
      ruleId: rule.id,
      name: rule.name,
      metric: rule.metric,
      value,
      threshold: rule.threshold,
      ...(detail ? { status: detail.status, message: detail.message.slice(0, 500), escalated: detail.escalated === true } : {}),
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
          ...(detail ? { detail } : {}),
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

  // L.18.0 — email dispatch via the existing Resend transport.
  // dryRun mode (default when NEXUS_ENABLE_OUTBOUND_EMAILS≠'true' or
  // RESEND_API_KEY is unset) logs to stdout and returns ok=true.
  if (channel.startsWith('email:') && detail) {
    const to = channel.slice('email:'.length)
    const lines = detailLines(detail)
    try {
      const r = await sendEmail({
        to,
        subject: `[Nexus alert] ${rule.name}${detail.escalated ? ' now' : ''}: ${detail.status}`,
        text: [`Alert "${rule.name}" ${detail.escalated ? 'got worse' : 'fired'}.`, ``, ...lines, ``, `Open the alerts view: /sync-logs/alerts`].join('\n'),
        html: `<p>Alert <strong>"${escHtml(rule.name)}"</strong> ${detail.escalated ? 'got worse' : 'fired'}.</p>
${lines.filter(Boolean).map((line) => `<p style="font-family:Inter,sans-serif;font-size:13px;color:#0f172a;">${escHtml(line)}</p>`).join('\n')}
<p><a href="/sync-logs/alerts">Open the alerts view →</a></p>`,
        tag: `alert-${rule.id}`,
      })
      if (r.ok) return { channel, ok: true }
      return { channel, ok: false, error: r.error ?? 'email send failed' }
    } catch (e) {
      return { channel, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  if (channel.startsWith('email:')) {
    const to = channel.slice('email:'.length)
    const valueStr =
      rule.metric === 'errorRate'
        ? `${(value * 100).toFixed(2)}%`
        : rule.metric === 'latencyP95'
          ? `${Math.round(value)}ms`
          : String(Math.round(value))
    const thresholdStr =
      rule.metric === 'errorRate'
        ? `${(rule.threshold * 100).toFixed(2)}%`
        : String(rule.threshold)
    try {
      const r = await sendEmail({
        to,
        subject: `[Nexus alert] ${rule.name}: ${rule.metric} ${valueStr}`,
        text: [
          `Alert "${rule.name}" fired.`,
          ``,
          `Metric:     ${rule.metric}`,
          `Value:      ${valueStr}`,
          `Threshold:  ${thresholdStr}`,
          ``,
          `Open the hub: /sync-logs/alerts`,
        ].join('\n'),
        html: `<p>Alert <strong>"${rule.name}"</strong> fired.</p>
<table cellpadding="4" style="font-family:Inter,sans-serif;font-size:13px;color:#0f172a;">
  <tr><td>Metric</td><td><code>${rule.metric}</code></td></tr>
  <tr><td>Value</td><td><strong style="color:#dc2626;">${valueStr}</strong></td></tr>
  <tr><td>Threshold</td><td>${thresholdStr}</td></tr>
</table>
<p><a href="/sync-logs/alerts">Open the alerts view →</a></p>`,
        tag: `alert-${rule.id}`,
      })
      if (r.ok) return { channel, ok: true }
      return { channel, ok: false, error: r.error ?? 'email send failed' }
    } catch (e) {
      return {
        channel,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  }

  // L.18.0 — Slack incoming-webhook dispatch.
  // The 'slack:' prefix takes a channel hint that's only used in the
  // message text — the actual delivery target comes from
  // NEXUS_SLACK_WEBHOOK_URL. This is the standard Slack incoming-webhook
  // pattern: one webhook URL per Slack channel; you pre-create them in
  // Slack and stash the URL in env.
  if (channel.startsWith('slack:')) {
    const slackChannelHint = channel.slice('slack:'.length)
    const url = process.env.NEXUS_SLACK_WEBHOOK_URL
    if (!url) {
      return {
        channel,
        ok: false,
        error: 'NEXUS_SLACK_WEBHOOK_URL not configured',
      }
    }
    const valueStr =
      rule.metric === 'errorRate'
        ? `${(value * 100).toFixed(2)}%`
        : rule.metric === 'latencyP95'
          ? `${Math.round(value)}ms`
          : String(Math.round(value))
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Slack incoming-webhooks accept channel override only on
          // legacy webhooks; modern ones ignore it. Keeping it makes
          // the rule readable in the UI either way.
          channel: slackChannelHint || undefined,
          text: detail
            ? `:rotating_light: *Alert ${detail.escalated ? 'got worse' : 'fired'}:* ${rule.name} — ${detail.status}: ${detail.message.slice(0, 1500)}`
            : `:rotating_light: *Alert fired:* ${rule.name}`,
          attachments: [
            {
              color: '#dc2626',
              fields: [
                { title: 'Metric', value: rule.metric, short: true },
                { title: 'Value', value: valueStr, short: true },
                {
                  title: 'Threshold',
                  value:
                    rule.metric === 'errorRate'
                      ? `${(rule.threshold * 100).toFixed(2)}%`
                      : String(rule.threshold),
                  short: true,
                },
              ],
            },
          ],
        }),
      })
      if (!r.ok) return { channel, ok: false, error: `HTTP ${r.status}` }
      return { channel, ok: true }
    } catch (e) {
      return {
        channel,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }
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

/** The rule fields settling an evaluation needs. */
export interface SettleableRule {
  id: string
  name: string
  metric: string
  operator: string
  threshold: number
  notificationChannels: unknown
  lastFired: boolean
  lastValue: number | null
}

export type AlertSettlement = 'fired' | 'resolved' | 'escalated' | 'unchanged'

export interface SettleOptions {
  /** What a watchdog check found, for the channels (absent for the minute evaluator's metrics). */
  detail?: AlertDetail
  /** Also resolve an ACKNOWLEDGED event when the condition clears (the watchdog's checks: "resolved when it passes"). */
  resolveAcknowledged?: boolean
  /** A firing rule whose value rose (warn → fail) updates its open event and notifies again. */
  notifyOnRise?: boolean
}

/**
 * One evaluated value, settled on its rule: not firing → firing creates ONE AlertEvent (TRIGGERED) and notifies; firing →
 * not firing auto-resolves it (resolvedBy 'auto'); no transition only refreshes lastValue + lastEvaluatedAt — no spam.
 * The minute evaluator and the platform health watchdog both settle through here.
 */
export async function settleAlertRule(rule: SettleableRule, value: number, opts: SettleOptions = {}): Promise<AlertSettlement> {
  const op = rule.operator as Operator
  const fires = COMPARE[op] ? COMPARE[op](value, rule.threshold) : false

  if (fires && !rule.lastFired) {
    // Transition: not-firing → firing. Create event + notify.
    const channels = (rule.notificationChannels as string[]) ?? ['log']
    const dispatchResults: DispatchResult[] = []
    for (const ch of channels) {
      dispatchResults.push(await dispatch(rule, ch, value, opts.detail))
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
    return 'fired'
  }
  if (!fires && rule.lastFired) {
    // Transition: firing → not-firing. Auto-resolve any open
    // event for this rule.
    await prisma.alertEvent.updateMany({
      where: { ruleId: rule.id, status: opts.resolveAcknowledged ? { in: ['TRIGGERED', 'ACKNOWLEDGED'] } : 'TRIGGERED' },
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
    return 'resolved'
  }
  if (fires && opts.notifyOnRise && rule.lastValue != null && value > rule.lastValue) {
    // Still firing, and worse: the open event carries the new value and needs a look again; the channels hear it.
    const channels = (rule.notificationChannels as string[]) ?? ['log']
    for (const ch of channels) await dispatch(rule, ch, value, opts.detail ? { ...opts.detail, escalated: true } : undefined)
    await prisma.alertEvent.updateMany({
      where: { ruleId: rule.id, status: { in: ['TRIGGERED', 'ACKNOWLEDGED'] } },
      data: { value, status: 'TRIGGERED' },
    })
    await prisma.alertRule.update({ where: { id: rule.id }, data: { lastEvaluatedAt: new Date(), lastValue: value } })
    return 'escalated'
  }
  // No transition — just refresh the lastEvaluated/lastValue.
  await prisma.alertRule.update({
    where: { id: rule.id },
    data: { lastEvaluatedAt: new Date(), lastValue: value },
  })
  return 'unchanged'
}

export async function runAlertEvaluator(): Promise<EvalResult> {
  // The platform health watchdog's rules are evaluated by the watchdog itself, once a day, with their findings.
  const rules = await prisma.alertRule.findMany({ where: { enabled: true, NOT: { metric: { startsWith: PLATFORM_HEALTH_METRIC_PREFIX } } } })
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
      const outcome = await settleAlertRule(rule, value)
      if (outcome === 'fired') result.rulesFired++
      else if (outcome === 'resolved') result.rulesResolved++
      else result.rulesUnchanged++
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

/**
 * RRL.7 — seed the two default reliability alert rules so the operator is
 * actively notified (not just a log line / dashboard banner) when:
 *   1. the review-request pipeline starves (deliveredAt stops advancing), and
 *   2. ANY cron that was running silently stops (the node-cron skip class).
 *
 * Idempotent: matched by name, only created if absent — so the operator can
 * freely retune thresholds, change channels, or disable them in the UI without
 * this re-creating them. Email routes to NEXUS_ALERT_EMAIL → NEXUS_SUPPORT_INBOX
 * → support@xavia.it; the 'log' channel always works even with email off. Add a
 * 'slack:#alerts' channel in the UI once NEXUS_SLACK_WEBHOOK_URL is set.
 */
/** Where a seeded reliability rule notifies: the log, and the operator's alert inbox (NEXUS_ALERT_EMAIL → NEXUS_SUPPORT_INBOX → the support inbox). */
export function defaultAlertChannels(): { email: string; channels: string[] } {
  const email = process.env.NEXUS_ALERT_EMAIL ?? process.env.NEXUS_SUPPORT_INBOX ?? 'support@xavia.it'
  return { email, channels: ['log', `email:${email}`] }
}

export async function seedDefaultAlertRules(): Promise<{ created: string[] }> {
  const { email, channels } = defaultAlertChannels()
  const defaults = [
    {
      name: 'Review pipeline starved',
      description:
        'Amazon orders shipped ≥6d ago with no deliveredAt — the review-request scheduler is being starved (the loop has stopped feeding itself). See /marketing/reviews/requests.',
      metric: 'reviewOverdueUndelivered',
      operator: 'gte',
      threshold: 10,
    },
    {
      name: 'Critical cron stopped',
      description:
        'A cron that was running on a regular cadence has gone silent well past its normal interval (node-cron in-memory timers can be skipped across restarts with no replay).',
      metric: 'overdueCrons',
      operator: 'gte',
      threshold: 1,
    },
  ]
  const created: string[] = []
  for (const d of defaults) {
    const existing = await prisma.alertRule.findFirst({ where: { name: d.name } })
    if (existing) continue
    await prisma.alertRule.create({
      data: {
        name: d.name,
        description: d.description,
        metric: d.metric,
        operator: d.operator,
        threshold: d.threshold,
        windowMinutes: 15,
        notificationChannels: channels as never,
        enabled: true,
      },
    })
    created.push(d.name)
  }
  if (created.length > 0) {
    logger.info('[alert-evaluator] seeded default reliability alert rules', { created, email })
  }
  return { created }
}
