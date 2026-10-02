/**
 * MCP full control P3 — the unified triage inbox (P5.1), read in one place: GET /api/inbox and /api/inbox/count
 * (inbox.routes.ts) and Claude's `alerts-inbox` read call these.
 *
 * Four sources, read in parallel and normalised to InboxItem: failed or dead outbound syncs, triggered alert events,
 * unread notifications and webhook events that failed to process. Sorted by severity (critical, warn, info), then
 * newest first. Moved from the route without a change in behaviour (triage-inbox.service.vitest.test.ts holds the
 * route's answers byte for byte).
 */

import prisma from '../../db.js'

export interface InboxItem {
  key: string
  source: 'sync' | 'alert' | 'notification' | 'webhook'
  severity: 'critical' | 'warn' | 'info'
  title: string
  body?: string
  channel?: string
  href?: string
  createdAt: string
  resolvedAt?: string | null
  meta: Record<string, unknown>
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, warn: 1, info: 2 }

/** What to read: one source or all (null), one severity or all (null), and the page. */
export interface TriageInboxQuery {
  sourceFilter: string | null
  severityFilter: string | null
  limit: number
  offset: number
}

export interface TriageInboxPage {
  items: InboxItem[]
  total: number
  counts: { all: number; sync: number; alert: number; notification: number; webhook: number }
}

/** The inbox feed: every source the filter allows, normalised, sorted, filtered by severity, one page. */
export async function readTriageInbox({ sourceFilter, severityFilter, limit, offset }: TriageInboxQuery): Promise<TriageInboxPage> {
  // Run all 4 source queries in parallel; skip sources filtered out
  const [syncItems, alertItems, notifItems, webhookItems] = await Promise.all([
    // ── Sync failures ──────────────────────────────────────────────────────
    !sourceFilter || sourceFilter === 'sync'
      ? (prisma.outboundSyncQueue as any).findMany({
          where: {
            OR: [
              { isDead: true },
              { syncStatus: 'FAILED', retryCount: { gt: 0 } },
            ],
          },
          orderBy: { updatedAt: 'desc' },
          take: 60,
          select: {
            id: true,
            targetChannel: true,
            syncType: true,
            syncStatus: true,
            isDead: true,
            retryCount: true,
            maxRetries: true,
            errorMessage: true,
            errorCode: true,
            updatedAt: true,
            createdAt: true,
            product: { select: { name: true, sku: true } },
          },
        })
      : [],

    // ── Unacknowledged alert events ────────────────────────────────────────
    !sourceFilter || sourceFilter === 'alert'
      ? prisma.alertEvent.findMany({
          where: { status: 'TRIGGERED' },
          orderBy: { triggeredAt: 'desc' },
          take: 60,
          include: { rule: { select: { name: true, metric: true, channel: true } } },
        })
      : [],

    // ── Unread notifications ───────────────────────────────────────────────
    !sourceFilter || sourceFilter === 'notification'
      ? prisma.notification.findMany({
          where: { readAt: null },
          orderBy: { createdAt: 'desc' },
          take: 60,
        })
      : [],

    // ── Unprocessed webhook errors ─────────────────────────────────────────
    !sourceFilter || sourceFilter === 'webhook'
      ? prisma.webhookEvent.findMany({
          where: { isProcessed: false, error: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: 60,
        })
      : [],
  ])

  // ── Normalise ────────────────────────────────────────────────────────────

  const items: InboxItem[] = []

  for (const s of syncItems as any[]) {
    const sev: InboxItem['severity'] = s.isDead ? 'critical' : 'warn'
    const productLabel = s.product?.sku ?? s.product?.name ?? s.id.slice(0, 8)
    items.push({
      key: `sync:${s.id}`,
      source: 'sync',
      severity: sev,
      title: `${s.targetChannel} sync ${s.isDead ? 'dead' : 'failed'} · ${productLabel}`,
      body: s.errorMessage
        ? `${s.syncType} · attempt ${s.retryCount}/${s.maxRetries}${s.errorCode ? ` · ${s.errorCode}` : ''}`
        : `${s.syncType} · attempt ${s.retryCount}/${s.maxRetries}`,
      channel: s.targetChannel,
      href: '/sync-logs/outbound-queue',
      createdAt: s.updatedAt.toISOString(),
      meta: { id: s.id, syncType: s.syncType, isDead: s.isDead, retryCount: s.retryCount, maxRetries: s.maxRetries, errorMessage: s.errorMessage },
    })
  }

  for (const a of alertItems as any[]) {
    const isRateMetric = a.rule?.metric === 'errorRate' || a.rule?.metric === 'latencyP95'
    items.push({
      key: `alert:${a.id}`,
      source: 'alert',
      severity: isRateMetric ? 'critical' : 'warn',
      title: `Alert fired: ${a.rule?.name ?? a.ruleId}`,
      body: a.rule?.channel
        ? `${a.rule.channel} · ${a.rule.metric} = ${a.value}`
        : `${a.rule?.metric ?? 'metric'} = ${a.value}`,
      channel: a.rule?.channel ?? undefined,
      href: '/sync-logs/alerts',
      createdAt: a.triggeredAt.toISOString(),
      meta: { id: a.id, ruleId: a.ruleId, metric: a.rule?.metric, value: a.value },
    })
  }

  for (const n of notifItems as any[]) {
    const sevMap: Record<string, InboxItem['severity']> = {
      danger: 'critical', warn: 'warn', success: 'info', info: 'info',
    }
    items.push({
      key: `notification:${n.id}`,
      source: 'notification',
      severity: sevMap[n.severity] ?? 'info',
      title: n.title,
      body: n.body ?? undefined,
      href: n.href ?? undefined,
      createdAt: n.createdAt.toISOString(),
      meta: { id: n.id, type: n.type, entityType: n.entityType, entityId: n.entityId },
    })
  }

  for (const w of webhookItems as any[]) {
    items.push({
      key: `webhook:${w.id}`,
      source: 'webhook',
      severity: 'warn',
      title: `Webhook unprocessed · ${w.channel}`,
      body: `${w.eventType}${w.error ? ` · ${w.error.slice(0, 80)}` : ''}`,
      channel: w.channel,
      href: '/sync-logs',
      createdAt: w.createdAt.toISOString(),
      meta: { id: w.id, channel: w.channel, eventType: w.eventType, error: w.error },
    })
  }

  // ── Sort: severity rank ASC, createdAt DESC ───────────────────────────────
  items.sort((a, b) => {
    const rs = (SEVERITY_RANK[a.severity] ?? 2) - (SEVERITY_RANK[b.severity] ?? 2)
    if (rs !== 0) return rs
    return b.createdAt.localeCompare(a.createdAt)
  })

  // ── Severity filter ───────────────────────────────────────────────────────
  const filtered = severityFilter
    ? items.filter((i) => i.severity === severityFilter)
    : items

  const page = filtered.slice(offset, offset + limit)

  // Source counts for tab badges
  const counts = {
    all: filtered.length,
    sync: filtered.filter((i) => i.source === 'sync').length,
    alert: filtered.filter((i) => i.source === 'alert').length,
    notification: filtered.filter((i) => i.source === 'notification').length,
    webhook: filtered.filter((i) => i.source === 'webhook').length,
  }

  return { items: page, total: filtered.length, counts }
}

/** The sidebar badge: how many inbox items there are, by severity. */
export async function countTriageInbox(): Promise<{ total: number; bySeverity: { critical: number; warn: number; info: number } }> {
  const [syncCritical, syncWarn, alertCritical, alertWarn, notifCounts, webhookCount] =
    await Promise.all([
      (prisma.outboundSyncQueue as any).count({ where: { isDead: true } }),
      (prisma.outboundSyncQueue as any).count({ where: { syncStatus: 'FAILED', retryCount: { gt: 0 }, isDead: false } }),
      prisma.alertEvent.count({ where: { status: 'TRIGGERED', rule: { metric: { in: ['errorRate', 'latencyP95'] } } } }),
      prisma.alertEvent.count({ where: { status: 'TRIGGERED', rule: { metric: { notIn: ['errorRate', 'latencyP95'] } } } }),
      prisma.notification.count({ where: { readAt: null } }),
      prisma.webhookEvent.count({ where: { isProcessed: false, error: { not: null } } }),
    ])

  const critical = syncCritical + alertCritical
  const warn = syncWarn + alertWarn + webhookCount
  const info = notifCounts
  const total = critical + warn + info

  return { total, bySeverity: { critical, warn, info } }
}
