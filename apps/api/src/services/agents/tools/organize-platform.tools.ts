/**
 * MCP full control P7 (W2) — organizing changes to the platform: alert rules, acknowledging alerts and notifications,
 * and the image library (plan section 09 §4).
 *
 *   set-alert-rule          create a rule, or change one's name, threshold, window, channel or on/off
 *   acknowledge-alerts      acknowledge or resolve alert events; mark your own notifications read
 *   organize-image-library  label, folder and tags of library assets — never a delete
 *
 * Each is a change a person approves in Nexus (or, inside the limits a business sets, Claude runs itself: `auto`).
 * The dry run is pure: it reads, it refuses in a sentence, it never writes. `execute` writes through the same services
 * the pages use (alerts/alert-rules.service.ts, notification-inbox.service.ts, assets/asset-library.service.ts) and
 * returns what it changed, before → after; `undo` asks for the inverse through the same gate.
 *
 * Never for Claude (09 §2): where an alert is SENT. A rule's notification targets (webhooks, e-mail addresses, Slack)
 * are an outgoing-webhook path — they are never shown here (only how many of each kind) and never set: a new rule
 * notifies the Nexus log only, and a change keeps the targets the rule has.
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { CHANNEL_LABELS } from '@nexus/shared/channel-label'
import prisma from '../../../db.js'
import { ALERT_METRICS, ALERT_OPERATORS } from '../../alert-evaluator.service.js'
import {
  acknowledgeAlertEvent,
  alertEventStates,
  createAlertRule,
  resolveAlertEvent,
  restoreAlertEventStates,
  updateAlertRule,
  type AlertEventState,
  type AlertRuleChange,
} from '../../alerts/alert-rules.service.js'
import { markNotificationsRead, markNotificationsUnread } from '../../notification-inbox.service.js'
import { moveAssets, replaceAssetTags, updateAssetFields } from '../../assets/asset-library.service.js'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'
import { capped, safeText } from './claude-safe.js'

const ID = z.string().trim().min(1).max(64)
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const CHANNELS = Object.keys(CHANNEL_LABELS) as [string, ...string[]]
/** Lines a preview lists; the rest are counted (05 §3.7: previews ≤ 20 lines plus totals). */
const PREVIEW_LINES = 20

/** Who did it, as the page records it: the person's name, and "(Claude)" when the request came from Claude. */
async function actorName(ctx: ToolContext): Promise<string> {
  const id = ctx.userId ?? null
  const person = id ? await prisma.userProfile.findUnique({ where: { id }, select: { displayName: true } }) : null
  const name = person ? person.displayName?.trim() || 'a team member' : id || 'Nexus'
  return ctx.via === 'claude' ? `${name} (Claude)` : name
}

// ── set-alert-rule ───────────────────────────────────────────────────────────────────────────────────

/** The fields a rule change is judged on and undone by. */
interface RuleState {
  ruleId: string
  name: string
  description: string | null
  metric: string
  operator: string
  threshold: number
  windowMinutes: number
  channel: string | null
  enabled: boolean
}

const ruleState = (row: { id: string; name: string; description: string | null; metric: string; operator: string; threshold: number; windowMinutes: number; channel: string | null; enabled: boolean }): RuleState => ({
  ruleId: row.id,
  name: row.name,
  description: row.description,
  metric: row.metric,
  operator: row.operator,
  threshold: row.threshold,
  windowMinutes: row.windowMinutes,
  channel: row.channel,
  enabled: row.enabled,
})

/** Where a rule's alerts go, by kind and count only: a target (URL, address) is never shown. */
function notifiesOf(channels: unknown): string[] {
  const list = Array.isArray(channels) ? channels.filter((c): c is string => typeof c === 'string') : []
  const count = (prefix: string) => list.filter((c) => c.startsWith(prefix)).length
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const out: string[] = []
  if (list.includes('log')) out.push('the Nexus log')
  if (count('webhook:')) out.push(plural(count('webhook:'), 'webhook', 'webhooks'))
  if (count('email:')) out.push(plural(count('email:'), 'e-mail address', 'e-mail addresses'))
  if (count('slack:')) out.push(plural(count('slack:'), 'Slack channel', 'Slack channels'))
  const other = list.filter((c) => c !== 'log' && !/^(webhook|email|slack):/.test(c)).length
  if (other) out.push(plural(other, 'other target', 'other targets'))
  return out
}

type RulePlan =
  | { ok: false; error: string }
  | { ok: true; mode: 'create'; next: Omit<RuleState, 'ruleId'>; preview: Record<string, unknown> }
  | { ok: true; mode: 'update'; current: RuleState; change: AlertRuleChange; preview: Record<string, unknown> }

const RULE_FIELDS = ['name', 'description', 'threshold', 'windowMinutes', 'channel', 'enabled'] as const

/** The one resolution both the dry run and the run use: what the arguments would do to this business's rules now. */
async function planRule(args: Record<string, unknown>): Promise<RulePlan> {
  const channel = args.channel === undefined ? undefined : args.channel === 'ANY' ? null : (args.channel as string)
  const description = args.description === undefined ? undefined : (args.description as string) || null
  if (typeof args.ruleId === 'string') {
    const row = await prisma.alertRule.findUnique({ where: { id: args.ruleId } })
    if (!row) return { ok: false, error: 'Alert rule not found' }
    const current = ruleState(row)
    if ((args.metric !== undefined && args.metric !== row.metric) || (args.operator !== undefined && args.operator !== row.operator)) {
      return { ok: false, error: `A rule's metric and operator stay as they are ("${row.name}" watches ${row.metric} ${row.operator}). Create a new rule to watch something else.` }
    }
    const wanted: Record<string, unknown> = {
      name: args.name, description, threshold: args.threshold, windowMinutes: args.windowMinutes, channel, enabled: args.enabled,
    }
    const change: Record<string, unknown> = {}
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    for (const field of RULE_FIELDS) {
      const to = wanted[field]
      if (to === undefined || to === current[field]) continue
      change[field] = to
      changes[field] = { from: current[field], to }
    }
    if (!Object.keys(changes).length) return { ok: false, error: `Nothing would change: the alert rule "${row.name}" already has these values.` }
    const thresholdChangePct = changes.threshold
      ? current.threshold === 0
        ? null
        : Math.round(((Number(changes.threshold.to) - current.threshold) / Math.abs(current.threshold)) * 1000) / 10
      : null
    return {
      ok: true,
      mode: 'update',
      current,
      change: change as AlertRuleChange,
      preview: {
        action: 'set-alert-rule',
        mode: 'update',
        ruleId: row.id,
        rule: row.name,
        watches: `${row.metric} ${row.operator}`,
        changes,
        thresholdChangePct,
        notifies: notifiesOf(row.notificationChannels),
        note: 'Changes the rule in Nexus only; where its alerts are sent stays as it is. Undo puts the old values back.',
      },
    }
  }
  if (typeof args.name !== 'string' || typeof args.metric !== 'string' || typeof args.operator !== 'string' || typeof args.threshold !== 'number') {
    return { ok: false, error: 'A new alert rule needs a name, a metric, an operator and a threshold (or name the rule to change with ruleId).' }
  }
  const next = {
    name: args.name,
    description: description ?? null,
    metric: args.metric,
    operator: args.operator,
    threshold: args.threshold,
    windowMinutes: (args.windowMinutes as number | undefined) ?? 15,
    channel: channel ?? null,
    enabled: (args.enabled as boolean | undefined) ?? true,
  }
  return {
    ok: true,
    mode: 'create',
    next,
    preview: {
      action: 'set-alert-rule',
      mode: 'create',
      rule: next.name,
      watches: `${next.metric} ${next.operator}`,
      changes: Object.fromEntries(Object.entries(next).map(([field, to]) => [field, { from: null, to }])),
      thresholdChangePct: null,
      notifies: notifiesOf(['log']),
      note: 'Creates the rule in Nexus; its alerts go to the Nexus log only (a person adds e-mail, Slack or webhooks in Nexus). Undo switches it off.',
    },
  }
}

/** C1 — how far Claude may change alert rules without a person, when a business allows `auto` (C5). */
export const SET_ALERT_RULE_LIMITS = z.object({
  allowNewRules: z.boolean().default(false).describe('a new alert rule may be created without a person'),
  allowSwitchingOff: z.boolean().default(false).describe('a rule may be switched off without a person (it then stays silent)'),
  maxThresholdChangePercent: z.number().positive().max(1000).default(50)
    .describe('the most a threshold may move, up or down, in percent of the current one'),
})

export function setAlertRuleWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = preview as { mode?: string; rule?: string; changes?: Record<string, { to?: unknown }>; thresholdChangePct?: number | null } | null
  if (!p || typeof p !== 'object' || !p.mode) return 'there is no preview to judge'
  if (p.mode === 'create' && limits.allowNewRules !== true) return 'it creates a new alert rule, and your limits keep new rules for a person'
  if (p.changes?.enabled?.to === false && limits.allowSwitchingOff !== true) {
    return `it switches the rule "${p.rule}" off, and an alert that is off stays silent; your limits keep that for a person`
  }
  if (p.mode === 'update' && p.changes?.threshold) {
    const max = Number(limits.maxThresholdChangePercent)
    if (typeof p.thresholdChangePct !== 'number') return 'the threshold moves from 0, which cannot be measured in percent'
    if (!(Math.abs(p.thresholdChangePct) <= max)) {
      return `the threshold moves ${Math.abs(p.thresholdChangePct)} %, more than the ${max} % allowed without a person`
    }
  }
  return null
}

/** C2 — undo: the old values back through set-alert-rule; a rule it created is switched off. */
export const SET_ALERT_RULE_UNDO: ToolUndo = {
  async current(change) {
    const ruleId = String((change.after as { ruleId?: unknown } | null)?.ruleId ?? '')
    const row = ruleId ? await prisma.alertRule.findUnique({ where: { id: ruleId } }) : null
    return row ? ruleState(row) : null
  },
  request(change) {
    const before = (change.before ?? {}) as Partial<RuleState> & { created?: boolean }
    const after = (change.after ?? {}) as Partial<RuleState>
    if (!after.ruleId) return { refusal: 'This change does not name its alert rule.' }
    if (before.created) {
      if (after.enabled === false) return { refusal: `The rule "${after.name}" was created switched off; there is nothing to undo.` }
      return { tool: 'set-alert-rule', args: { ruleId: after.ruleId, enabled: false } }
    }
    return {
      tool: 'set-alert-rule',
      args: {
        ruleId: after.ruleId,
        name: before.name,
        description: before.description ?? '',
        threshold: before.threshold,
        windowMinutes: before.windowMinutes,
        channel: before.channel ?? 'ANY',
        enabled: before.enabled,
      },
    }
  },
}

const setAlertRule: AgentTool = {
  name: 'set-alert-rule',
  title: 'Set an alert rule',
  category: 'platform',
  description:
    'Create an alert rule (what to watch, the comparison, the threshold, the window, optionally one channel), or change '
    + 'an existing rule\'s name, description, threshold, window, channel or on/off (name it with ruleId, from '
    + 'alerts-inbox). A rule\'s metric and operator stay as they are. A new rule notifies the Nexus log only: where '
    + 'alerts are sent (e-mail, Slack, webhooks) is set by a person in Nexus and never shown here. A person approves '
    + 'the change in Nexus before it is made; undo puts the old values back (a new rule is switched off).',
  input: z.object({
    ruleId: ID.optional().describe('the rule to change (from alerts-inbox); omit to create a new rule'),
    name: z.string().trim().min(1).max(120).optional().describe('the rule\'s name; required for a new rule'),
    description: z.string().trim().max(500).optional().describe('what the rule is for; an empty text clears it'),
    metric: z.enum(ALERT_METRICS).optional().describe('what a NEW rule watches (an existing rule keeps its metric)'),
    operator: z.enum(ALERT_OPERATORS).optional()
      .describe('how a NEW rule compares the metric with the threshold: gt, gte, lt or lte (an existing rule keeps it)'),
    threshold: z.coerce.number().optional().describe('the value the metric is compared with; required for a new rule'),
    windowMinutes: z.coerce.number().int().min(1).max(1440).optional().describe('the window the metric is measured over, in minutes (default 15)'),
    channel: z.preprocess(upper, z.enum(['ANY', ...CHANNELS])).optional()
      .describe('count only calls to this channel (errorRate, latencyP95); ANY counts every channel'),
    enabled: z.boolean().optional().describe('switch the rule on (true) or off (false)'),
  }),
  requires: [F.syncManage],
  riskTier: 'medium',
  requiresApprovalDefault: true,
  readOnly: false,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: SET_ALERT_RULE_LIMITS,
  withinLimits: setAlertRuleWithinLimits,
  undo: SET_ALERT_RULE_UNDO,
  async handler(args): Promise<ToolResult> {
    const plan = await planRule(args)
    return plan.ok === false ? { ok: false, error: plan.error } : { ok: true, preview: plan.preview }
  },
  async execute(args): Promise<ToolResult> {
    const plan = await planRule(args)
    if (plan.ok === false) return { ok: false, error: plan.error }
    if (plan.mode === 'create') {
      const row = await createAlertRule({ ...plan.next, notificationChannels: ['log'] })
      const after = ruleState(row)
      return {
        ok: true,
        data: { mode: 'create', ruleId: row.id, rule: row.name },
        change: { before: { ruleId: row.id, name: row.name, created: true }, after },
      }
    }
    const row = await updateAlertRule(plan.current.ruleId, plan.change)
    return {
      ok: true,
      data: { mode: 'update', ruleId: row.id, rule: row.name, changed: Object.keys(plan.change) },
      change: { before: plan.current, after: ruleState(row) },
    }
  },
}

// ── acknowledge-alerts ───────────────────────────────────────────────────────────────────────────────

const EVENT_STATUSES = ['TRIGGERED', 'ACKNOWLEDGED', 'RESOLVED'] as const
const ACK_ACTIONS = ['acknowledge', 'resolve', 'restore'] as const
const nullableText = (max: number) => z.string().max(max).nullable()

/** What acknowledge-alerts changed, and what its undo puts back: each event's triage state, each notification's read time. */
interface AckState {
  events: Record<string, AlertEventState>
  notifications: Record<string, string | null>
}

type AckPlan =
  | { ok: false; error: string }
  | {
      ok: true
      mode: (typeof ACK_ACTIONS)[number]
      /** Events that change, with the state each gets (restore: the state given). */
      events: Record<string, AlertEventState | null>
      /** Notifications that change: true = read, false = unread again. */
      notifications: Record<string, boolean>
      preview: Record<string, unknown>
    }

const unique = (values: unknown) => [...new Set(Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : [])]

/**
 * The one resolution both the dry run and the run use. A notification is only ever the caller's own: checked when a
 * person (or Claude for them) asks; the system re-check and the run go by the ids that check let through.
 */
async function planAcknowledge(args: Record<string, unknown>, ctx: ToolContext): Promise<AckPlan> {
  const mode = args.action as (typeof ACK_ACTIONS)[number]
  const restoring = mode === 'restore'
  const previousEvents = restoring ? ((args.previousEvents as Array<AlertEventState & { alertEventId: string }> | undefined) ?? []) : []
  const previousNotes = restoring ? ((args.previousNotifications as Array<{ notificationId: string; read: boolean }> | undefined) ?? []) : []
  const eventIds = restoring ? unique(previousEvents.map((e) => e.alertEventId)) : unique(args.alertEventIds)
  const noteIds = restoring ? unique(previousNotes.map((n) => n.notificationId)) : unique(args.notificationIds)
  if (!eventIds.length && !noteIds.length) return { ok: false, error: 'Name at least one alert event or notification (from alerts-inbox).' }

  const ownOnly = ctx.via !== 'system' && !!ctx.userId
  const [events, notes] = await Promise.all([
    eventIds.length
      ? prisma.alertEvent.findMany({
          where: { id: { in: eventIds } },
          select: { id: true, value: true, triggeredAt: true, status: true, acknowledgedAt: true, acknowledgedBy: true, resolvedAt: true, resolvedBy: true, notes: true, rule: { select: { name: true, metric: true } } },
        })
      : [],
    noteIds.length
      ? prisma.notification.findMany({
          where: { id: { in: noteIds }, ...(ownOnly ? { userId: ctx.userId! } : {}) },
          select: { id: true, title: true, readAt: true },
        })
      : [],
  ])
  if (events.length !== eventIds.length) return { ok: false, error: 'Alert event not found' }
  if (notes.length !== noteIds.length) return { ok: false, error: 'Notification not found' }

  const states = await alertEventStates(eventIds)
  const changingEvents: Record<string, AlertEventState | null> = {}
  const eventLines: Array<Record<string, unknown>> = []
  const unchanged: string[] = []
  const restoreOf = new Map(previousEvents.map((e) => [e.alertEventId, e]))
  for (const event of events) {
    const from = event.status
    const label = `${event.rule.name} (${event.rule.metric} = ${event.value})`
    let to: string | null = null
    if (mode === 'acknowledge') to = from === 'TRIGGERED' ? 'ACKNOWLEDGED' : null
    else if (mode === 'resolve') to = from === 'RESOLVED' ? null : 'RESOLVED'
    else {
      const wanted = restoreOf.get(event.id)!
      const target: AlertEventState = {
        status: wanted.status, acknowledgedAt: wanted.acknowledgedAt, acknowledgedBy: wanted.acknowledgedBy,
        resolvedAt: wanted.resolvedAt, resolvedBy: wanted.resolvedBy, notes: wanted.notes,
      }
      if (JSON.stringify(target) !== JSON.stringify(states[event.id])) {
        to = wanted.status
        changingEvents[event.id] = target
      }
    }
    if (to === null) {
      unchanged.push(`${label}: already ${from.toLowerCase()}`)
      continue
    }
    if (mode !== 'restore') changingEvents[event.id] = null
    eventLines.push({ alertEventId: event.id, rule: safeText(event.rule.name, 120), metric: event.rule.metric, value: event.value, triggeredAt: event.triggeredAt.toISOString(), status: { from, to } })
  }
  const changingNotes: Record<string, boolean> = {}
  const noteLines: Array<Record<string, unknown>> = []
  const unreadAgain = new Map(previousNotes.map((n) => [n.notificationId, !n.read]))
  for (const note of notes) {
    const read = note.readAt != null
    const toRead = restoring ? !unreadAgain.get(note.id) : true
    if (read === toRead) {
      unchanged.push(`notification "${safeText(note.title, 80)}": already ${read ? 'read' : 'unread'}`)
      continue
    }
    changingNotes[note.id] = toRead
    noteLines.push({ notificationId: note.id, title: safeText(note.title, 120), read: { from: read, to: toRead } })
  }
  const count = eventLines.length + noteLines.length
  if (!count) return { ok: false, error: `Nothing to change: ${unchanged.join('; ')}.` }
  const events20 = capped(eventLines, PREVIEW_LINES)
  const notes20 = capped(noteLines, PREVIEW_LINES)
  return {
    ok: true,
    mode,
    events: changingEvents,
    notifications: changingNotes,
    preview: {
      action: 'acknowledge-alerts',
      mode,
      count,
      events: events20.items,
      ...(events20.more ? { moreEvents: events20.more } : {}),
      notifications: notes20.items,
      ...(notes20.more ? { moreNotifications: notes20.more } : {}),
      ...(unchanged.length ? { unchanged: capped(unchanged, PREVIEW_LINES).items } : {}),
      ...(typeof args.note === 'string' ? { note: safeText(args.note, 200) } : {}),
      // What the approval is about, per row: the state each is in now. A row someone triaged since makes it stale.
      changes: {
        ...Object.fromEntries(Object.keys(changingEvents).map((id) => [id, states[id]?.status ?? null])),
        ...Object.fromEntries(notes.filter((n) => n.id in changingNotes).map((n) => [n.id, n.readAt != null])),
      },
    },
  }
}

async function ackStateOf(eventIds: readonly string[], noteIds: readonly string[]): Promise<AckState> {
  const [events, notes] = await Promise.all([
    alertEventStates(eventIds),
    noteIds.length ? prisma.notification.findMany({ where: { id: { in: [...noteIds] } }, select: { id: true, readAt: true } }) : [],
  ])
  return { events, notifications: Object.fromEntries(notes.map((n) => [n.id, n.readAt?.toISOString() ?? null])) }
}

/** C1 — how far Claude may triage alerts without a person, when a business allows `auto` (C5). */
export const ACKNOWLEDGE_ALERTS_LIMITS = z.object({
  maxItems: z.number().int().min(1).max(100).default(20).describe('the most alerts and notifications in one change'),
  allowResolve: z.boolean().default(false).describe('alerts may be resolved (closed) without a person, not only acknowledged'),
})

export function acknowledgeAlertsWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = preview as { mode?: string; count?: number } | null
  if (!p || typeof p !== 'object' || typeof p.count !== 'number') return 'there is no preview to judge'
  const max = Number(limits.maxItems)
  if (!(p.count <= max)) return `it changes ${p.count} alerts and notifications, more than the ${max} allowed without a person`
  if (p.mode === 'resolve' && limits.allowResolve !== true) return 'it resolves alerts, and your limits keep resolving for a person'
  return null
}

/** C2 — undo: every event back to the state it had, every notification unread or read again (action `restore`). */
export const ACKNOWLEDGE_ALERTS_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as Partial<AckState>
    return ackStateOf(Object.keys(after.events ?? {}), Object.keys(after.notifications ?? {}))
  },
  request(change) {
    const before = (change.before ?? {}) as Partial<AckState>
    const previousEvents = Object.entries(before.events ?? {}).map(([alertEventId, state]) => ({ alertEventId, ...state }))
    const previousNotifications = Object.entries(before.notifications ?? {}).map(([notificationId, readAt]) => ({ notificationId, read: readAt != null }))
    if (!previousEvents.length && !previousNotifications.length) return { refusal: 'This change touched no alert or notification.' }
    return {
      tool: 'acknowledge-alerts',
      args: {
        action: 'restore',
        ...(previousEvents.length ? { previousEvents } : {}),
        ...(previousNotifications.length ? { previousNotifications } : {}),
      },
    }
  },
}

const acknowledgeAlerts: AgentTool = {
  name: 'acknowledge-alerts',
  title: 'Acknowledge alerts',
  category: 'platform',
  description:
    'Triage what alerts-inbox shows: acknowledge alert events (someone is on it) or resolve them (dealt with; the rule '
    + 'stops counting as fired), and mark your own notifications read. Up to 50 of each, with an optional note. Rows '
    + 'already in that state are listed and left alone. A person approves it in Nexus first; undo puts every alert '
    + 'and notification back exactly as it was.',
  input: z.object({
    alertEventIds: z.array(ID).max(50).optional().describe('alert events to acknowledge or resolve (from alerts-inbox)'),
    notificationIds: z.array(ID).max(50).optional().describe('your own notifications to mark read (from alerts-inbox)'),
    action: z.enum(ACK_ACTIONS).describe('acknowledge or resolve; restore is what undo sends (previousEvents, previousNotifications)'),
    note: z.string().trim().min(1).max(500).optional().describe('a note stored on each alert event'),
    previousEvents: z.array(z.object({
      alertEventId: ID.describe('the alert event'),
      status: z.enum(EVENT_STATUSES).describe('the state to put back'),
      acknowledgedAt: nullableText(40).describe('when it was acknowledged, or null'),
      acknowledgedBy: nullableText(200).describe('who acknowledged it, or null'),
      resolvedAt: nullableText(40).describe('when it was resolved, or null'),
      resolvedBy: nullableText(200).describe('who resolved it, or null'),
      notes: nullableText(2000).describe('its note, or null'),
    })).max(50).optional().describe('restore only (what undo sends): each event\'s triage state to put back'),
    previousNotifications: z.array(z.object({
      notificationId: ID.describe('the notification'),
      read: z.boolean().describe('read (true) or unread (false)'),
    })).max(50).optional().describe('restore only (what undo sends): each notification read or unread again'),
  }),
  requires: [F.syncManage],
  riskTier: 'medium',
  requiresApprovalDefault: true,
  readOnly: false,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: ACKNOWLEDGE_ALERTS_LIMITS,
  withinLimits: acknowledgeAlertsWithinLimits,
  undo: ACKNOWLEDGE_ALERTS_UNDO,
  async handler(args, ctx): Promise<ToolResult> {
    const plan = await planAcknowledge(args, ctx)
    return plan.ok === false ? { ok: false, error: plan.error } : { ok: true, preview: plan.preview }
  },
  async execute(args, ctx): Promise<ToolResult> {
    // The ids were checked when the request was made (a notification: the person's own); the run goes by them.
    const plan = await planAcknowledge(args, { ...ctx, via: 'system' })
    if (plan.ok === false) return { ok: false, error: plan.error }
    const eventIds = Object.keys(plan.events)
    const noteIds = Object.keys(plan.notifications)
    const before = await ackStateOf(eventIds, noteIds)
    const who = await actorName(ctx)
    const note = typeof args.note === 'string' ? args.note : undefined
    if (plan.mode === 'restore') {
      await restoreAlertEventStates(plan.events as Record<string, AlertEventState>)
      const unread = noteIds.filter((id) => !plan.notifications[id])
      const read = noteIds.filter((id) => plan.notifications[id])
      if (unread.length) await markNotificationsUnread(unread)
      if (read.length) await markNotificationsRead(read)
    } else {
      for (const id of eventIds) {
        if (plan.mode === 'acknowledge') await acknowledgeAlertEvent(id, { notes: note, acknowledgedBy: who })
        else await resolveAlertEvent(id, { notes: note, resolvedBy: who })
      }
      if (noteIds.length) await markNotificationsRead(noteIds)
    }
    const after = await ackStateOf(eventIds, noteIds)
    return {
      ok: true,
      data: { mode: plan.mode, alertEvents: eventIds.length, notifications: noteIds.length },
      change: { before, after },
    }
  },
}

// ── organize-image-library ───────────────────────────────────────────────────────────────────────────

/** What organize-image-library changes on one asset, and what its undo puts back. */
interface AssetState {
  label: string
  folderId: string | null
  tagIds: string[]
}

/** A library id as image-library shows it (`da_…`), or the bare id. A product photo (`pi_…`) is not in the library. */
function assetIdOf(raw: string): { id: string } | { photo: true } {
  if (raw.startsWith('pi_')) return { photo: true }
  return { id: raw.startsWith('da_') ? raw.slice(3) : raw }
}

async function assetStates(ids: readonly string[]) {
  const rows = await prisma.digitalAsset.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, label: true, folderId: true, tags: { select: { tagId: true } } },
  })
  return new Map(rows.map((row) => [row.id, { label: row.label, folderId: row.folderId, tagIds: row.tags.map((t) => t.tagId).sort() } satisfies AssetState]))
}

type LibraryPlan =
  | { ok: false; error: string }
  | { ok: true; next: Map<string, AssetState>; current: Map<string, AssetState>; preview: Record<string, unknown> }

async function planLibrary(args: Record<string, unknown>): Promise<LibraryPlan> {
  const restore = args.restore as Array<AssetState & { assetId: string }> | undefined
  const raw = restore ? restore.map((r) => r.assetId) : unique(args.assetIds)
  const ids: string[] = []
  for (const value of raw) {
    const parsed = assetIdOf(value)
    if ('photo' in parsed) return { ok: false, error: `${value} is a product photo: it is organized on its product, not in the library.` }
    ids.push(parsed.id)
  }
  const assetIds = [...new Set(ids)]
  if (!restore && args.label === undefined && args.folderId === undefined && !(args.tagIds as string[] | undefined)?.length) {
    return { ok: false, error: 'Say what to change: a label, a folder (folderId; null takes them out of any folder) or tags (tagIds).' }
  }
  if (!restore && args.label !== undefined && assetIds.length !== 1) return { ok: false, error: 'A label is set on one asset at a time.' }

  const current = await assetStates(assetIds)
  if (current.size !== assetIds.length) return { ok: false, error: 'Asset not found' }
  const folderIds = new Set<string>()
  const tagIds = new Set<string>()
  if (restore) for (const r of restore) { if (r.folderId) folderIds.add(r.folderId); r.tagIds.forEach((t) => tagIds.add(t)) }
  else {
    if (typeof args.folderId === 'string') folderIds.add(args.folderId)
    for (const t of (args.tagIds as string[] | undefined) ?? []) tagIds.add(t)
  }
  for (const state of current.values()) { if (state.folderId) folderIds.add(state.folderId); state.tagIds.forEach((t) => tagIds.add(t)) }
  const none: Array<{ id: string; name: string }> = []
  const [folders, tags] = await Promise.all([
    folderIds.size ? prisma.assetFolder.findMany({ where: { id: { in: [...folderIds] } }, select: { id: true, name: true } }) : none,
    tagIds.size ? prisma.tag.findMany({ where: { id: { in: [...tagIds] } }, select: { id: true, name: true } }) : none,
  ])
  const folderName = new Map(folders.map((f) => [f.id, f.name]))
  const tagName = new Map(tags.map((t) => [t.id, t.name]))
  const wantedFolders = restore ? restore.map((r) => r.folderId).filter((f): f is string => !!f) : typeof args.folderId === 'string' ? [args.folderId] : []
  if (wantedFolders.some((f) => !folderName.has(f))) return { ok: false, error: 'Folder not found' }
  const wantedTags = restore ? restore.flatMap((r) => r.tagIds) : ((args.tagIds as string[] | undefined) ?? [])
  if (wantedTags.some((t) => !tagName.has(t))) return { ok: false, error: 'Tag not found' }

  const restoreOf = new Map((restore ?? []).map((r) => [r.assetId.startsWith('da_') ? r.assetId.slice(3) : r.assetId, r]))
  const next = new Map<string, AssetState>()
  const lines: Array<Record<string, unknown>> = []
  const names = (list: string[]) => list.map((id) => tagName.get(id) ?? id).sort()
  for (const id of assetIds) {
    const now = current.get(id)!
    let wanted: AssetState
    if (restore) {
      const r = restoreOf.get(id)!
      wanted = { label: r.label, folderId: r.folderId, tagIds: [...new Set(r.tagIds)].sort() }
    } else {
      const set = new Set(now.tagIds)
      for (const t of (args.tagIds as string[] | undefined) ?? []) (args.tagAction === 'remove' ? set.delete(t) : set.add(t))
      wanted = {
        label: typeof args.label === 'string' ? args.label : now.label,
        folderId: args.folderId === undefined ? now.folderId : (args.folderId as string | null),
        tagIds: [...set].sort(),
      }
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    if (wanted.label !== now.label) changes.label = { from: now.label, to: wanted.label }
    if (wanted.folderId !== now.folderId) {
      changes.folder = { from: now.folderId ? folderName.get(now.folderId) ?? null : null, to: wanted.folderId ? folderName.get(wanted.folderId) ?? null : null }
    }
    if (wanted.tagIds.join() !== now.tagIds.join()) changes.tags = { from: names(now.tagIds), to: names(wanted.tagIds) }
    if (!Object.keys(changes).length) continue
    next.set(id, wanted)
    lines.push({ assetId: id, label: safeText(now.label, 120), changes })
  }
  if (!next.size) return { ok: false, error: 'Nothing would change: every asset already has this label, folder and tags.' }
  const shown = capped(lines, PREVIEW_LINES)
  return {
    ok: true,
    next,
    current,
    preview: {
      action: 'organize-image-library',
      totals: { assets: assetIds.length, changing: next.size },
      assets: shown.items,
      ...(shown.more ? { moreAssets: shown.more } : {}),
      // What each changing asset becomes, and what it is now: an asset someone organized since makes the approval stale.
      changes: Object.fromEntries(next),
      basis: Object.fromEntries([...next.keys()].map((id) => [id, current.get(id)!])),
      note: 'Organizes the library in Nexus only; nothing is deleted and no channel is touched. Undo puts each asset back.',
    },
  }
}

/** C1 — how many library assets Claude may organize at once without a person, when a business allows `auto` (C5). */
export const ORGANIZE_IMAGE_LIBRARY_LIMITS = z.object({
  maxAssets: z.number().int().min(1).max(100).default(25).describe('the most assets one change may organize'),
})

export function organizeImageLibraryWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const changing = (preview as { totals?: { changing?: unknown } } | null)?.totals?.changing
  if (typeof changing !== 'number') return 'there is no preview to judge'
  const max = Number(limits.maxAssets)
  if (!(changing <= max)) return `it organizes ${changing} assets, more than the ${max} allowed without a person`
  return null
}

/** C2 — undo: each asset's label, folder and tags back, through organize-image-library (`restore`). */
export const ORGANIZE_IMAGE_LIBRARY_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { assets?: Record<string, AssetState> }
    const ids = Object.keys(after.assets ?? {})
    const now = await assetStates(ids)
    return { assets: Object.fromEntries(ids.map((id) => [id, now.get(id) ?? null])) }
  },
  request(change) {
    const before = (change.before ?? {}) as { assets?: Record<string, AssetState> }
    const restore = Object.entries(before.assets ?? {}).map(([assetId, state]) => ({ assetId, ...state }))
    if (!restore.length) return { refusal: 'This change organized no asset.' }
    return { tool: 'organize-image-library', args: { assetIds: restore.map((r) => r.assetId), restore } }
  },
}

const organizeImageLibrary: AgentTool = {
  name: 'organize-image-library',
  title: 'Organize the image library',
  category: 'platform',
  description:
    'Organize library assets (ids from image-library): move them into a folder or out of any folder, add or remove '
    + 'tags, or give one asset a new label. Up to 100 assets; product photos are organized on their product. Nothing is '
    + 'ever deleted, and no channel is touched. A person approves it in Nexus first; undo puts every asset back.',
  input: z.object({
    assetIds: z.array(ID).min(1).max(100).describe('the library assets to organize (ids from image-library)'),
    label: z.string().trim().min(1).max(200).optional().describe('a new label, for one asset only'),
    folderId: ID.nullable().optional().describe('move them into this folder (from image-library); null takes them out of any folder'),
    tagIds: z.array(ID).max(20).optional().describe('tags to add, or to remove with tagAction (tag ids from image-library)'),
    tagAction: z.enum(['add', 'remove']).optional().describe('add (the default) or remove the tags in tagIds'),
    restore: z.array(z.object({
      assetId: ID.describe('the asset'),
      label: z.string().min(1).max(200).describe('its label'),
      folderId: ID.nullable().describe('its folder, or null'),
      tagIds: z.array(ID).max(100).describe('its tags'),
    })).max(100).optional().describe('what undo sends: each asset\'s label, folder and tags to put back'),
  }),
  requires: [F.assetsManage],
  riskTier: 'medium',
  requiresApprovalDefault: true,
  readOnly: false,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: ORGANIZE_IMAGE_LIBRARY_LIMITS,
  withinLimits: organizeImageLibraryWithinLimits,
  undo: ORGANIZE_IMAGE_LIBRARY_UNDO,
  async handler(args): Promise<ToolResult> {
    const plan = await planLibrary(args)
    return plan.ok === false ? { ok: false, error: plan.error } : { ok: true, preview: plan.preview }
  },
  async execute(args): Promise<ToolResult> {
    const plan = await planLibrary(args)
    if (plan.ok === false) return { ok: false, error: plan.error }
    const before = Object.fromEntries([...plan.next.keys()].map((id) => [id, plan.current.get(id)!]))
    // Folder moves grouped by destination, then labels and tag sets per asset, through the library service.
    const byFolder = new Map<string | null, string[]>()
    for (const [id, wanted] of plan.next) {
      if (wanted.folderId !== plan.current.get(id)!.folderId) byFolder.set(wanted.folderId, [...(byFolder.get(wanted.folderId) ?? []), id])
    }
    for (const [folderId, assetIds] of byFolder) {
      const moved = await moveAssets({ assetIds, folderId })
      if (moved.ok === false) return { ok: false, error: `Not changed: ${moved.error}.` }
    }
    for (const [id, wanted] of plan.next) {
      const now = plan.current.get(id)!
      if (wanted.label !== now.label) {
        const labelled = await updateAssetFields(id, { label: wanted.label })
        if (labelled.ok === false) return { ok: false, error: `Not changed: ${labelled.error}.` }
      }
      if (wanted.tagIds.join() !== now.tagIds.join()) await replaceAssetTags(id, { tagIds: wanted.tagIds })
    }
    const after = await assetStates([...plan.next.keys()])
    return {
      ok: true,
      data: { organized: plan.next.size },
      change: { before: { assets: before }, after: { assets: Object.fromEntries([...plan.next.keys()].map((id) => [id, after.get(id) ?? null])) } },
    }
  },
}

export const ORGANIZE_PLATFORM_TOOLS: AgentTool[] = [setAlertRule, acknowledgeAlerts, organizeImageLibrary]
