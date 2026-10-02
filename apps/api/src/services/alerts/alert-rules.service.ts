/**
 * MCP full control P3 — alert rules and the alert events they fired (L.16.0), read in one place: the alerts page
 * (GET /api/sync-logs/alerts/rules and /api/sync-logs/alerts/events, sync-logs.routes.ts) and Claude's
 * `alerts-inbox` read call these.
 *
 * Moved from the route without a change in behaviour (alert-rules.service.vitest.test.ts holds the route's answers
 * byte for byte).
 *
 * MCP full control P7 — the writes too: creating and changing a rule, acknowledging and resolving an event. The alerts
 * page (POST/PATCH /sync-logs/alerts/rules, POST …/events/:id/acknowledge|resolve) and Claude's set-alert-rule and
 * acknowledge-alerts call these; alert-writes.vitest.test.ts holds the routes' answers byte for byte. The route keeps
 * its own input checks (which metrics and operators, at least one notification channel); deleting a rule stays there.
 */

import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'

/** Every alert rule: the enabled ones first, then by name. */
export async function listAlertRules() {
  return prisma.alertRule.findMany({
    orderBy: [{ enabled: 'desc' }, { name: 'asc' }],
  })
}

/**
 * The newest alert events, each with its rule. `status` narrows to one state (TRIGGERED, ACKNOWLEDGED, RESOLVED);
 * absent or 'ALL' reads every state. `limit` is the query string's: 50 by default, held between 1 and 200.
 */
export async function listAlertEvents({ status, limit }: { status?: string; limit?: string }) {
  const take = Math.min(Math.max(Number(limit ?? 50), 1), 200)
  const where: Prisma.AlertEventWhereInput = {}
  if (status && status !== 'ALL') where.status = status
  return prisma.alertEvent.findMany({
    where,
    include: { rule: true },
    orderBy: { triggeredAt: 'desc' },
    take,
  })
}

/** What a new rule is made of: the route's body, as it creates it. */
export interface AlertRuleCreate {
  name: string
  description?: string | null
  metric: string
  operator: string
  threshold: number
  windowMinutes?: number
  channel?: string | null
  notificationChannels: string[]
  enabled?: boolean
}

/** A new alert rule: 15-minute window and enabled unless the body says otherwise. */
export async function createAlertRule(b: AlertRuleCreate) {
  return prisma.alertRule.create({
    data: {
      name: b.name,
      description: b.description,
      metric: b.metric,
      operator: b.operator,
      threshold: b.threshold,
      windowMinutes: b.windowMinutes ?? 15,
      channel: b.channel,
      notificationChannels: b.notificationChannels as never,
      enabled: b.enabled ?? true,
    },
  })
}

/** What a rule change may set. A rule's metric and operator are never changed: that is a different rule. */
export type AlertRuleChange = Partial<{
  name: string
  description: string | null
  threshold: number
  windowMinutes: number
  channel: string | null
  notificationChannels: string[]
  enabled: boolean
}>

/** Change the fields the body names, and only those. Throws (Prisma P2025) when the rule is not there. */
export async function updateAlertRule(id: string, b: AlertRuleChange) {
  const data: Record<string, unknown> = {}
  if (b.name !== undefined) data.name = b.name
  if (b.description !== undefined) data.description = b.description
  if (b.threshold !== undefined) data.threshold = b.threshold
  if (b.windowMinutes !== undefined) data.windowMinutes = b.windowMinutes
  if (b.channel !== undefined) data.channel = b.channel
  if (b.notificationChannels !== undefined) data.notificationChannels = b.notificationChannels
  if (b.enabled !== undefined) data.enabled = b.enabled
  return prisma.alertRule.update({ where: { id }, data })
}

/** Someone is looking at it: ACKNOWLEDGED, now, by whom, with an optional note. */
export async function acknowledgeAlertEvent(id: string, b: { notes?: string; acknowledgedBy?: string }) {
  return prisma.alertEvent.update({
    where: { id },
    data: {
      status: 'ACKNOWLEDGED',
      acknowledgedAt: new Date(),
      acknowledgedBy: b.acknowledgedBy ?? null,
      notes: b.notes ?? undefined,
    },
  })
}

/**
 * Dealt with: RESOLVED, now, by whom, with an optional note — and the rule no longer counts as fired, so a manual
 * resolve does not re-fire on the next evaluation while the condition still holds (the operator may have acknowledged
 * while triaging).
 */
export async function resolveAlertEvent(id: string, b: { notes?: string; resolvedBy?: string }) {
  const updated = await prisma.alertEvent.update({
    where: { id },
    data: {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      resolvedBy: b.resolvedBy ?? null,
      notes: b.notes ?? undefined,
    },
  })
  await prisma.alertRule.update({
    where: { id: updated.ruleId },
    data: { lastFired: false },
  })
  return updated
}

/** An alert event's triage state: what acknowledging and resolving set, and what putting one back restores. */
export interface AlertEventState {
  status: string
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  resolvedAt: string | null
  resolvedBy: string | null
  notes: string | null
}

/** MCP full control P7 — the triage state of these events as stored now, by id (the ones of this business). */
export async function alertEventStates(ids: readonly string[]): Promise<Record<string, AlertEventState>> {
  const rows = await prisma.alertEvent.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, status: true, acknowledgedAt: true, acknowledgedBy: true, resolvedAt: true, resolvedBy: true, notes: true },
  })
  return Object.fromEntries(rows.map((row) => [row.id, {
    status: row.status,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: row.acknowledgedBy,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    notes: row.notes,
  }]))
}

/**
 * MCP full control P7 — put events back to a triage state they had (the undo of acknowledge-alerts): status, who and
 * when, and the note, exactly as recorded. Only events of this business are found; returns how many were written.
 */
export async function restoreAlertEventStates(states: Readonly<Record<string, AlertEventState>>): Promise<number> {
  let written = 0
  for (const [id, state] of Object.entries(states)) {
    const result = await prisma.alertEvent.updateMany({
      where: { id },
      data: {
        status: state.status,
        acknowledgedAt: state.acknowledgedAt ? new Date(state.acknowledgedAt) : null,
        acknowledgedBy: state.acknowledgedBy,
        resolvedAt: state.resolvedAt ? new Date(state.resolvedAt) : null,
        resolvedBy: state.resolvedBy,
        notes: state.notes,
      },
    })
    written += result.count
  }
  return written
}
