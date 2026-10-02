/**
 * MCP full control P6 — what happened in the business, read: the alerts inbox, the audit trail, the sync activity
 * between Nexus and the channels, and AI usage (plan section 09 §4).
 *
 * Read only and low risk: each reads this business's own rows through the services the pages use (P3) and calls no
 * marketplace. Acknowledging alerts, retrying or replaying syncs, purging and cron triggers stay a person's click in
 * Nexus (09 §2). These rows sit close to the safety system, so everything free-form passes through claude-safe.ts:
 * no payload, no signature, no IP address, no token, no person's e-mail; and the audit trail leaves out the security
 * rows (sign-ins, people, sessions, API keys) altogether. Money inside an audit row's before/after is stripped by the
 * door, at any depth, for a person who may not see it.
 *
 * Lists page with an opaque cursor bound to the tool, the business and the filters (lib/pagination/cursor.ts).
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { CHANNEL_LABELS } from '@nexus/shared/channel-label'
import prisma from '../../../db.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { InvalidCursorError, cursorScope, decodeCursor, encodeCursor } from '../../../lib/pagination/cursor.js'
import { countTriageInbox, readTriageInbox, type InboxItem } from '../../inbox/triage-inbox.service.js'
import { listAlertRules } from '../../alerts/alert-rules.service.js'
import { searchAuditTrail } from '../../audit/audit-search.service.js'
import { listErrorGroups, listOutboundQueue, listWebhookEvents, recentApiCalls } from '../../sync-logs/sync-activity.service.js'
import { aiUsageByModel, aiUsageSummary } from '../../ai/ai-usage-summary.service.js'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { capped, personName, safeText, safeTextOrNull, safeValue } from './claude-safe.js'

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
const iso = (at: Date | string | null | undefined) => (at == null ? null : typeof at === 'string' ? at : at.toISOString())
const CHANNELS = Object.keys(CHANNEL_LABELS) as [string, ...string[]]
const HOUR = 3_600_000
const DAY = 24 * HOUR

// ── Paging, shared by every list here ────────────────────────────────────────────────────────────────

const paging = {
  limit: z.coerce.number().int().min(1).max(100).optional().describe('rows per page (default 25, at most 100)'),
  cursor: z.string().min(1).max(512).optional()
    .describe('nextCursor from the previous page, with the same filters; omit it for the first page'),
}

/** A cursor belongs to one tool, one business and one set of filters (the page size may change between pages). */
function scopeOf(tool: string, args: Record<string, unknown>): string {
  const { limit: _limit, cursor: _cursor, ...filters } = args
  return cursorScope(tool, { business: workspaceIdForQuery(), ...filters })
}

/** The position the caller's cursor names (the service's own cursor: a row id or an offset), or null. */
const positionIn = (scope: string, cursor: unknown) => decodeCursor(scope, typeof cursor === 'string' ? cursor : null)?.id ?? null
const nextCursorOf = (scope: string, position: string | null) => (position ? encodeCursor(scope, { values: [], id: position }) : null)

/** A bad cursor is a wrongly made call, said the way call-tool.ts says one; anything else is a real failure. */
async function listTool(name: string, work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof InvalidCursorError) return { ok: false, error: `${name} was called wrongly — cursor: ${error.message}` }
    throw error
  }
}

const pageHint = (more: boolean) => (more ? 'More rows match: call again with cursor set to nextCursor.' : undefined)

// ── alerts-inbox ─────────────────────────────────────────────────────────────────────────────────────

const INBOX_SOURCES = ['all', 'sync', 'alert', 'notification', 'webhook'] as const
const SEVERITIES = ['critical', 'warn', 'info'] as const

const inboxItem = (item: InboxItem) => ({
  key: item.key,
  source: item.source,
  severity: item.severity,
  title: safeText(item.title),
  body: safeTextOrNull(item.body),
  channel: item.channel ?? null,
  at: item.createdAt,
  detail: safeValue(item.meta),
})

const alertsInbox: AgentTool = {
  name: 'alerts-inbox',
  title: 'Alerts inbox',
  category: 'platform',
  description:
    'What needs attention in this business, worst first, newest first: channel syncs that failed or gave up, alerts '
    + 'that fired and were not acknowledged, unread notifications, and incoming channel events that failed to '
    + 'process. Filter by source or severity. The first page also counts the inbox by severity and lists the alert '
    + 'rules. Read only: acknowledging, resolving and retrying are done by a person in Nexus.',
  input: z.object({
    source: z.preprocess(lower, z.enum(INBOX_SOURCES)).optional().describe('only this source (default all)'),
    severity: z.preprocess(lower, z.enum(SEVERITIES)).optional().describe('only this severity'),
    ...paging,
  }),
  requires: [F.adminView],
  riskTier: 'low',
  readOnly: true,
  handler: (args) => listTool('alerts-inbox', async () => {
    const scope = scopeOf('alerts-inbox', args)
    const position = positionIn(scope, args.cursor)
    const offset = position && /^\d{1,6}$/.test(position) ? Number(position) : 0
    const limit = (args.limit as number | undefined) ?? 25
    const source = args.source as string | undefined
    const page = await readTriageInbox({
      sourceFilter: source && source !== 'all' ? source : null,
      severityFilter: (args.severity as string | undefined) ?? null,
      limit,
      offset,
    })
    const next = offset + page.items.length < page.total ? String(offset + page.items.length) : null
    const first = !position
    const [counts, rules] = first ? await Promise.all([countTriageInbox(), listAlertRules()]) : [null, null]
    const listedRules = rules ? capped(rules, 20) : null
    return {
      ok: true,
      data: {
        items: page.items.map(inboxItem),
        nextCursor: nextCursorOf(scope, next),
        total: page.total,
        bySource: page.counts,
        ...(counts ? { counts } : {}),
        ...(listedRules
          ? {
              alertRules: listedRules.items.map((rule) => ({
                name: safeText(rule.name, 120),
                metric: rule.metric,
                operator: rule.operator,
                threshold: rule.threshold,
                windowMinutes: rule.windowMinutes,
                channel: rule.channel,
                enabled: rule.enabled,
                firing: rule.lastFired,
              })),
              ...(listedRules.more ? { moreAlertRules: listedRules.more } : {}),
            }
          : {}),
        ...(next ? { hint: pageHint(true) } : {}),
      },
    }
  }),
}

// ── audit-trail ──────────────────────────────────────────────────────────────────────────────────────

const auditTrail: AgentTool = {
  name: 'audit-trail',
  title: 'Audit trail',
  category: 'platform',
  description:
    'Who changed what in this business, newest first: the entity (type and id), the action, the person (by name, or '
    + '"system"), when, and the values before and after. Filter by entity type, entity id or action; the window is '
    + 'the last 30 days unless days says otherwise (at most 365). Sign-ins, people, sessions, password and API-key '
    + 'changes are never shown; secrets and personal contact details inside the values are hidden. Read only.',
  input: z.object({
    entityType: z.string().trim().min(1).max(64).optional().describe('only this kind of record, e.g. Product, ChannelListing, Order, Settings'),
    entityId: z.string().trim().min(1).max(128).optional().describe('only the changes of this one record, by its id'),
    action: z.string().trim().min(1).max(64).optional().describe('only this action, e.g. update, publish, delete'),
    days: z.coerce.number().int().min(1).max(365).optional().describe('how many days back to read (default 30, at most 365)'),
    ...paging,
  }),
  requires: [F.auditView],
  riskTier: 'low',
  readOnly: true,
  handler: (args) => listTool('audit-trail', async () => {
    const scope = scopeOf('audit-trail', args)
    const afterId = positionIn(scope, args.cursor)
    const days = (args.days as number | undefined) ?? 30
    const { items, nextId } = await searchAuditTrail({
      entityType: args.entityType as string | undefined,
      entityId: args.entityId as string | undefined,
      action: args.action as string | undefined,
      since: new Date(Date.now() - days * DAY),
      limit: (args.limit as number | undefined) ?? 25,
      afterId,
    })
    // People by name. A user id with no person behind it (a job, an API key) reads as "system".
    const userIds = [...new Set(items.map((row) => row.userId).filter((id): id is string => !!id))]
    const people = userIds.length
      ? await prisma.userProfile.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })
      : []
    const names = new Map(people.map((person) => [person.id, personName(person.displayName)]))
    return {
      ok: true,
      data: {
        items: items.map((row) => ({
          id: row.id,
          at: iso(row.createdAt),
          who: (row.userId && names.get(row.userId)) || 'system',
          entityType: row.entityType,
          entityId: row.entityId,
          action: row.action,
          before: safeValue(row.before),
          after: safeValue(row.after),
          metadata: safeValue(row.metadata),
        })),
        nextCursor: nextCursorOf(scope, nextId),
        ...(nextId ? { hint: pageHint(true) } : {}),
      },
    }
  }),
}

// ── sync-activity ────────────────────────────────────────────────────────────────────────────────────

const SYNC_KINDS = ['queue', 'failed-calls', 'webhooks', 'error-groups'] as const
const QUEUE_TABS = ['active', 'dead', 'success'] as const
/** Default window per kind, in hours (the pages' own defaults). */
const DEFAULT_HOURS: Record<string, number> = { 'failed-calls': 24, webhooks: 24, 'error-groups': 168 }

/** One kind of sync activity: its rows as Claude reads them, the service's next position, and its totals. */
type SyncPage = { items: unknown[]; next: string | null; totals?: unknown }

async function syncPage(kind: string, args: Record<string, unknown>, position: string | null, limit: number): Promise<SyncPage> {
  const channel = args.channel as string | undefined
  const since = () => new Date(Date.now() - ((args.hours as number | undefined) ?? DEFAULT_HOURS[kind]) * HOUR).toISOString()
  const common = { limit: String(limit), ...(channel ? { channel } : {}), ...(position ? { cursor: position } : {}) }
  switch (kind) {
    case 'queue': {
      const page = await listOutboundQueue({ ...common, tab: (args.tab as string | undefined) ?? 'active' })
      return {
        // The payload (what would be sent) is never handed out.
        items: page.items.map((row) => ({
          id: row.id,
          productId: row.productId,
          sku: row.sku,
          productName: safeTextOrNull(row.productName, 120),
          channelListingId: row.channelListingId,
          channel: row.targetChannel,
          syncType: row.syncType,
          status: row.syncStatus,
          dead: row.isDead,
          retryCount: row.retryCount,
          maxRetries: row.maxRetries,
          error: safeTextOrNull(row.errorMessage),
          errorCode: row.errorCode,
          createdAt: row.createdAt,
          holdUntil: row.holdUntil,
          nextRetryAt: row.nextRetryAt,
          syncedAt: row.syncedAt,
          diedAt: row.diedAt,
        })),
        next: page.nextCursor,
        totals: page.stats,
      }
    }
    case 'failed-calls': {
      const page = await recentApiCalls({ ...common, success: 'false', since: since() })
      return {
        // Never the request or response payload.
        items: page.items.map((call) => ({
          id: call.id,
          at: iso(call.createdAt),
          channel: call.channel,
          marketplace: call.marketplace,
          operation: call.operation,
          statusCode: call.statusCode,
          latencyMs: call.latencyMs,
          errorType: call.errorType,
          errorCode: call.errorCode,
          error: safeTextOrNull(call.errorMessage),
          triggeredBy: call.triggeredBy,
          traceId: call.traceId,
          connectionId: call.connectionId,
          productId: call.productId,
          listingId: call.listingId,
          orderId: call.orderId,
        })),
        next: page.nextCursor,
      }
    }
    case 'webhooks': {
      const page = await listWebhookEvents({ ...common, since: since() })
      return {
        // The list read leaves out the payload and the signature; the error texts are made safe here.
        items: page.items.map((event) => ({
          id: event.id,
          at: iso(event.createdAt),
          channel: event.channel,
          eventType: event.eventType,
          status: event.status,
          processed: event.isProcessed,
          processedAt: iso(event.processedAt),
          attempts: event.attempts,
          deliveries: event.deliveries,
          nextAttemptAt: iso(event.nextAttemptAt),
          signatureChecked: event.signatureOk,
          error: safeTextOrNull(event.error ?? event.lastError),
        })),
        next: page.nextCursor,
        totals: page.totals,
      }
    }
    default: {
      const page = await listErrorGroups({ ...common, since: since() })
      return {
        items: page.items.map((group) => ({
          id: group.id,
          channel: group.channel,
          operation: group.operation,
          errorType: group.errorType,
          errorCode: group.errorCode,
          sampleMessage: safeTextOrNull(group.sampleMessage),
          count: group.count,
          firstSeen: iso(group.firstSeen),
          lastSeen: iso(group.lastSeen),
          status: group.resolutionStatus,
          resolvedAt: iso(group.resolvedAt),
          notes: safeTextOrNull(group.notes),
        })),
        next: page.nextCursor,
        totals: page.totals,
      }
    }
  }
}

const syncActivity: AgentTool = {
  name: 'sync-activity',
  title: 'Sync activity',
  category: 'platform',
  description:
    'What is moving between Nexus and the channels. kind=queue: changes waiting to go out, failed ones, or (tab) the '
    + 'ones that gave up or went out in the last 2 hours, with counts per channel. kind=failed-calls: channel calls '
    + 'that failed, newest first, each with its trace id (channel-health shows every call of one trace). '
    + 'kind=webhooks: incoming channel events and their processing state. kind=error-groups: recurring errors, '
    + 'grouped. Never shows what was sent or received. Read only: retrying, replaying and purging are done by a '
    + 'person in Nexus.',
  input: z.object({
    kind: z.enum(SYNC_KINDS).describe('which activity: queue, failed-calls, webhooks or error-groups'),
    channel: z.preprocess(upper, z.enum(CHANNELS)).optional().describe('only this channel'),
    tab: z.enum(QUEUE_TABS).optional()
      .describe('kind=queue only: active (waiting or failed in the last 7 days, the default), dead (gave up) or success (sent in the last 2 hours)'),
    hours: z.coerce.number().int().min(1).max(720).optional()
      .describe('failed-calls, webhooks, error-groups: how many hours back (default 24; error groups 168)'),
    ...paging,
  }),
  requires: [F.adminView],
  riskTier: 'low',
  readOnly: true,
  handler: (args) => listTool('sync-activity', async () => {
    const scope = scopeOf('sync-activity', args)
    const position = positionIn(scope, args.cursor)
    const page = await syncPage(String(args.kind), args, position, (args.limit as number | undefined) ?? 25)
    return {
      ok: true,
      data: {
        kind: args.kind,
        items: page.items,
        nextCursor: nextCursorOf(scope, page.next),
        ...(page.totals !== undefined ? { totals: page.totals } : {}),
        ...(page.next ? { hint: pageHint(true) } : {}),
      },
    }
  }),
}

// ── ai-usage ─────────────────────────────────────────────────────────────────────────────────────────

const aiUsage: AgentTool = {
  name: 'ai-usage',
  title: 'AI usage',
  category: 'platform',
  description:
    'How much this business used Nexus\'s own AI features over a recent window (default 30 days, at most 90): calls, '
    + 'tokens, failed calls and cost, by feature, by provider and by model, and the totals. Usage only — providers, '
    + 'models, budgets and the AI switch are set by a person in Nexus. Read only.',
  input: z.object({
    days: z.coerce.number().int().min(1).max(90).optional().describe('how many days back (default 30, at most 90)'),
  }),
  requires: [F.aiUsageView],
  riskTier: 'low',
  readOnly: true,
  async handler(args) {
    const days = (args.days as number | undefined) ?? 30
    const [summary, byModel] = await Promise.all([aiUsageSummary(days), aiUsageByModel(new Date(Date.now() - days * DAY))])
    const byCalls = <T extends { calls: number; name: string }>(rows: T[]) =>
      [...rows].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)).slice(0, 20)
    return {
      ok: true,
      data: {
        days,
        byFeature: byCalls(summary.byFeature),
        byProvider: byCalls(summary.byProvider),
        byModel: byModel.slice(0, 20),
        totals: { ...summary.totals, failed: byModel.reduce((sum, row) => sum + row.failed, 0) },
      },
    }
  },
}

export const PLATFORM_ACTIVITY_TOOLS: AgentTool[] = [alertsInbox, auditTrail, syncActivity, aiUsage]
