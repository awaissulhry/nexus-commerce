/**
 * ADS AUTONOMY W4-1 — the daily Claude ads run, on record (agent-results/6 §6 "Where the daily summary goes").
 *
 * A scheduled Claude run (a claude.ai routine, one per business) reports to Nexus with `report-ads-run`: `start` when it
 * begins, `finish` (or `fail`) when it ends. Each run is ONE AgentRun row of its own:
 *
 *   agentKey 'claude-ads-manager' · trigger 'schedule' · mode null · via null · cost 0
 *   id       the approvalId of the run's `start` request — the runId Claude passes to finish — or a fresh id for a run
 *            that reports without a start
 *   status   running (started) · done (finished) · failed (failed) · cancelled (withdrawn by an undo)
 *   input    what the start read: the mode, each ad tool's level, the Pause, the daily cap, the strategy per market
 *   output   the report: per market Claude's lines and Nexus's own numbers, each approval Claude named and what it is,
 *            problems, the next focus, the notice and the e-mail
 *
 * Why AgentRun and not a table of its own (every reader checked, 2026-10-06): the fleet's reads (map, timeline, health,
 * budget guard, sweep report, the stuck-run reclaimer) take `mode NOT NULL`; scorecards, promotion, charter revisions,
 * workflow tests, the automation explain and Settings → AI's agent cards take a charter or agent key, never this one;
 * claude-activity takes `via 'claude'` (the report-ads-run CALL is there, as every call is); the Approvals pages reach a
 * run through its approvals, and this row has none. Only Settings → AI's "Recent activity" lists every run, each Claude
 * call included: it shows this one as one line a run (claude-ads-manager · schedule · its status · $0). The cost is 0
 * because the run's model time is on the Owner's Claude plan, not on Nexus's AI budget.
 *
 * Every number in a report is Nexus's own (tools/ads-manager.tools.ts reads them from the builder `ads-overview` answers
 * from); Claude writes only words and approval ids. What each approval Claude names became is read here too
 * (`namedApprovals`): the counts in the bell and the e-mail ("3 ran, 2 wait for you") are Nexus's, never Claude's lists.
 *
 * One bell notice per finish or fail (danger when the run names a problem or failed: never deduped), and at most one
 * e-mail a day per business (the operator's day, Europe/Rome, as the Monday digest counts it) to the Monday ads digest's
 * recipients, through the shared e-mail transport (a dry run unless outbound e-mail is on).
 *
 * W4-5 (not built): the watch-week comparison — each watched step against what then happened to its entity — goes in
 * `ads-manager-runs` where WATCH_WEEK_SLOT stands, and in the daily e-mail.
 */

import type { Prisma } from '@nexus/database'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { sendEmail } from '../email/transport.js'
import { AUTOMATION_HREF, notifyAutomationDetailed } from '../advertising/ads-automation-notify.service.js'
import { CLAUDE_ACTION_TOOLS } from '../advertising/ads-strategy/fields.js'
import { campaignMarkets, loadIndex } from '../advertising/ads-strategy/load.js'
import { strategyVersionOf } from '../advertising/ads-strategy/autonomy.js'
import { autonomyOf, autoRunsInLastDay, ruleFrom } from './claude-trust.service.js'
import { getTool } from './tool-registry.js'
import type { ClaudeTrust } from './tool-types.js'

/** The run record's agent key (AgentRun.agentKey): no charter, no agent definition, no fleet reader takes it. */
export const ADS_MANAGER_AGENT_KEY = 'claude-ads-manager'
/** The bell notice's type (Notification.type); `meta.runId` names the run, so an undo can withdraw it. */
export const ADS_RUN_NOTICE_TYPE = 'claude-ads-run'
/** The operator's clock for "one e-mail a day" — the Monday digest's (ads-weekly-digest.service.ts OPERATOR_TIMEZONE). */
export const ADS_RUN_DAY_ZONE = 'Europe/Rome'
/** W4-5 slot: the watch-week comparison is not built yet; `ads-manager-runs` says so where it will stand. */
export const WATCH_WEEK_SLOT = {
  comparison: null,
  note: 'The watch-week comparison (each watched step against what then happened to its entity) is not built yet (W4-5).',
} as const

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled'
/** How a run's status reads to a person and to Claude. */
export const RUN_STATUS_WORDS: Record<RunStatus, string> = {
  running: 'started, no finish reported yet',
  done: 'finished',
  failed: 'reported a failure',
  cancelled: 'withdrawn (its notice was taken back)',
}

// ── What the start reads ───────────────────────────────────────────────────────────────────────────

/** Every ad change tool the ads strategy knows by kind (fields.ts), once. */
const AD_CHANGE_TOOLS = [...new Set(Object.values(CLAUDE_ACTION_TOOLS).flat())].sort()

/**
 * The run's mode, as the business has set it (never as the run says):
 *   paused  the business's Pause is on: nothing runs by rule; read and report only
 *   act     at least one ad tool may run by rule (auto), inside its limits and the ads strategy
 *   watch   none may run by rule, at least one is watched (its verdict is recorded, a person decides)
 *   ask     every ad change waits for a person
 */
export type RunMode = 'paused' | 'act' | 'watch' | 'ask'

export interface StartFacts {
  mode: RunMode
  paused: boolean
  pauseReason: string | null
  /** The changes run by rule in the last 24 hours, and the cap. */
  dailyCap: { cap: number; usedLast24h: number }
  /** Each ad change tool by the business's level for it (the ads strategy may hold a kind lower where a change lands). */
  levels: Record<'auto' | 'watch' | 'confirm' | 'ask' | 'off', string[]>
  /** Each Amazon ad market and its strategy's version (a fingerprint of its rows; null: no strategy row). */
  markets: Array<{ market: string; strategyVersion: string | null }>
  readAt: string
}

export async function startFacts(now = new Date()): Promise<StartFacts> {
  const [rows, autonomy, used, markets] = await Promise.all([
    prisma.agentTool.findMany({ where: { name: { in: AD_CHANGE_TOOLS } }, select: { name: true, claudeTrust: true, claudeLimits: true } }),
    autonomyOf(),
    autoRunsInLastDay(),
    campaignMarkets(),
  ])
  const levels: StartFacts['levels'] = { auto: [], watch: [], confirm: [], ask: [], off: [] }
  for (const name of AD_CHANGE_TOOLS) {
    const tool = getTool(name)
    if (!tool) continue
    const level = ruleFrom(tool, rows.find((row) => row.name === name) ?? null).level as ClaudeTrust
    levels[level].push(name)
  }
  const versions = await Promise.all(markets.map(async (market) => ({ market, strategyVersion: strategyVersionOf((await loadIndex(market)).index) })))
  const mode: RunMode = autonomy.paused ? 'paused' : levels.auto.length ? 'act' : levels.watch.length ? 'watch' : 'ask'
  return {
    mode,
    paused: autonomy.paused,
    pauseReason: autonomy.reason,
    dailyCap: { cap: autonomy.dailyAutoCap, usedLast24h: used },
    levels,
    markets: versions,
    readAt: now.toISOString(),
  }
}

// ── The approvals a report names ───────────────────────────────────────────────────────────────────

/** What became of an approval, in Nexus's own words (approval-status says the same per status). */
export type ApprovalFate = 'ran' | 'approved' | 'waiting' | 'handed_back' | 'declined' | 'withdrawn' | 'expired' | 'replaced' | 'other'
export const FATE_WORDS: Record<ApprovalFate, string> = {
  ran: 'approved, and it ran',
  approved: 'approved; it runs when its short undo window closes',
  waiting: 'waits for a person',
  handed_back: 'approved, then handed back to a person without running',
  declined: 'a person declined it',
  withdrawn: 'Nexus withdrew it',
  expired: 'nobody decided in time',
  replaced: 'a person replaced it with an edited request',
  other: 'see approval-status',
}

export type ListedAs = 'ranByRule' | 'waiting' | 'wouldDo'

export interface NamedApproval {
  approvalId: string
  /** Which of Claude's lists named it. */
  listedAs: ListedAs
  tool: string
  title: string | null
  status: string
  fate: ApprovalFate
  /** It was (or is about to be) run by the business's rule, not decided by a person. */
  byRule: boolean
  /** A watched request (AA-W2-4): would the business's rule have run it, and why not. */
  watch: { wouldRun: boolean; why: string | null } | null
  /** Claude listed it as ran by rule (or waiting) and Nexus says otherwise. */
  mismatch: string | null
}

const HANDED_BACK = /^not run(?: by rule)? — /

export function fateOf(row: { status: string; reason: string | null }): ApprovalFate {
  switch (row.status) {
    case 'executed': return 'ran'
    case 'scheduled': case 'executing': case 'approved': return 'approved'
    case 'pending': return HANDED_BACK.test(row.reason ?? '') ? 'handed_back' : 'waiting'
    case 'rejected': return (row.reason ?? '').startsWith('withdrawn:') ? 'withdrawn' : 'declined'
    case 'expired': return 'expired'
    case 'superseded': return 'replaced'
    default: return 'other'
  }
}

const ruleVerdictOf = (value: unknown): NamedApproval['watch'] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as { wouldRun?: unknown; why?: unknown }
  return typeof v.wouldRun === 'boolean' ? { wouldRun: v.wouldRun, why: typeof v.why === 'string' ? v.why : null } : null
}

function mismatchOf(listedAs: ListedAs, a: Pick<NamedApproval, 'fate' | 'byRule' | 'watch'>): string | null {
  if (listedAs === 'ranByRule' && !a.byRule) return `listed as run by rule, but Nexus says it ${FATE_WORDS[a.fate]}`
  if (listedAs === 'waiting' && !['waiting', 'handed_back'].includes(a.fate)) return `listed as waiting, but Nexus says it ${FATE_WORDS[a.fate]}`
  if (listedAs === 'wouldDo' && !a.watch) return 'listed as what the run would have done, but Nexus recorded no watch verdict on it'
  return null
}

/**
 * Each approval a report names, read in this business (row-level security: another business's id is not found), in
 * the order Claude listed them; an id named twice counts once (its first list). `missing`: ids this business does
 * not have.
 */
export async function namedApprovals(lists: Record<ListedAs, readonly string[]>): Promise<{ items: NamedApproval[]; missing: string[] }> {
  const order: Array<{ approvalId: string; listedAs: ListedAs }> = []
  const seen = new Set<string>()
  for (const listedAs of ['ranByRule', 'waiting', 'wouldDo'] as const) {
    for (const approvalId of lists[listedAs] ?? []) {
      if (seen.has(approvalId)) continue
      seen.add(approvalId)
      order.push({ approvalId, listedAs })
    }
  }
  if (!order.length) return { items: [], missing: [] }
  const rows = await prisma.agentApproval.findMany({
    where: { id: { in: order.map((o) => o.approvalId) } },
    select: { id: true, toolName: true, status: true, reason: true, decisionVia: true, ruleVerdict: true },
  })
  const byId = new Map(rows.map((row) => [row.id, row]))
  const items: NamedApproval[] = []
  const missing: string[] = []
  for (const { approvalId, listedAs } of order) {
    const row = byId.get(approvalId)
    if (!row) {
      missing.push(approvalId)
      continue
    }
    const fate = fateOf(row)
    const byRule = row.decisionVia === 'auto' && (fate === 'ran' || fate === 'approved')
    const watch = ruleVerdictOf(row.ruleVerdict)
    items.push({
      approvalId,
      listedAs,
      tool: row.toolName,
      title: getTool(row.toolName)?.title ?? null,
      status: row.status,
      fate,
      byRule,
      watch,
      mismatch: mismatchOf(listedAs, { fate, byRule, watch }),
    })
  }
  return { items, missing }
}

/** The counts a report states, from Nexus's own reading of each approval. */
export function approvalCounts(items: readonly NamedApproval[]) {
  return {
    ranByRule: items.filter((a) => a.byRule).length,
    waitingForYou: items.filter((a) => a.fate === 'waiting' || a.fate === 'handed_back').length,
    wouldHaveRun: items.filter((a) => a.watch?.wouldRun === true).length,
    declined: items.filter((a) => a.fate === 'declined').length,
    expired: items.filter((a) => a.fate === 'expired').length,
  }
}

// ── The run record ─────────────────────────────────────────────────────────────────────────────────

export interface RunRow {
  id: string
  status: string
  ok: boolean
  createdAt: Date
  endedAt: Date | null
  userId: string | null
  input: unknown
  output: unknown
}

const RUN_SELECT = { id: true, status: true, ok: true, createdAt: true, endedAt: true, userId: true, input: true, output: true } as const

/** One run of this business by its id, or null (another business's run is not found). */
export async function runById(runId: string): Promise<RunRow | null> {
  return prisma.agentRun.findFirst({ where: { id: runId, agentKey: ADS_MANAGER_AGENT_KEY }, select: RUN_SELECT })
}

/** This business's runs since a moment, newest first. */
export async function runsSince(since: Date, take = 50): Promise<RunRow[]> {
  return prisma.agentRun.findMany({
    where: { agentKey: ADS_MANAGER_AGENT_KEY, createdAt: { gte: since } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
    select: RUN_SELECT,
  })
}

/** A start request of report-ads-run in this business: the runId of a run whose start has not run yet. */
export async function startRequestOf(runId: string): Promise<{ id: string; status: string } | null> {
  const row = await prisma.agentApproval.findFirst({ where: { id: runId, toolName: 'report-ads-run' }, select: { id: true, status: true, args: true } })
  const op = row && row.args && typeof row.args === 'object' ? (row.args as { op?: unknown }).op : null
  return row && op === 'start' ? { id: row.id, status: row.status } : null
}

/** What an undo compares (ToolUndo.current) and what a report's change records. */
export interface RunState {
  runId: string
  status: RunStatus | null
  withdrawn: boolean
}

export async function runStateOf(runId: string): Promise<RunState> {
  const row = await runById(runId)
  return { runId, status: (row?.status as RunStatus | undefined) ?? null, withdrawn: !!outputOf(row)?.withdrawnAt }
}

/** The stored report, in one shape (v 1). */
export interface RunOutput {
  v: 1
  op?: 'finish' | 'fail'
  reportedAt?: string
  markets?: unknown[]
  approvals?: NamedApproval[]
  counts?: ReturnType<typeof approvalCounts>
  problems?: string[]
  nextFocus?: string | null
  notice?: { severity: string; created: number }
  email?: EmailOutcome
  withdrawnAt?: string
}

export function outputOf(row: Pick<RunRow, 'output'> | null): RunOutput | null {
  const out = row?.output
  return out && typeof out === 'object' && !Array.isArray(out) && (out as { v?: unknown }).v === 1 ? (out as RunOutput) : null
}

/** A run begins (op start): its record, unless a finish of the same run got there first. */
export async function recordStart(runId: string, facts: StartFacts, userId: string | null): Promise<{ created: boolean }> {
  const existing = await runById(runId)
  if (existing) return { created: false }
  await prisma.agentRun.create({
    data: {
      id: runId,
      agentKey: ADS_MANAGER_AGENT_KEY,
      trigger: 'schedule',
      status: 'running',
      userId,
      input: { v: 1, start: facts } as unknown as Prisma.InputJsonValue,
    },
  })
  return { created: true }
}

/** A run ends (finish or fail): its record — created when no start was recorded — set to done or failed. */
export async function recordFinish(runId: string | null, op: 'finish' | 'fail', output: RunOutput, userId: string | null): Promise<{ runId: string; before: RunStatus | null }> {
  const existing = runId ? await runById(runId) : null
  const status: RunStatus = op === 'finish' ? 'done' : 'failed'
  const data = {
    status,
    ok: op === 'finish',
    endedAt: new Date(),
    output: output as unknown as Prisma.InputJsonValue,
    ...(op === 'fail' ? { errorMessage: (output.problems ?? [])[0] ?? 'the run reported a failure' } : {}),
  }
  if (existing) {
    await prisma.agentRun.update({ where: { id: existing.id }, data })
    return { runId: existing.id, before: existing.status as RunStatus }
  }
  // No start on record: the run named by its start request (runId), else a new one.
  const created = await prisma.agentRun.create({
    data: { ...(runId ? { id: runId } : {}), agentKey: ADS_MANAGER_AGENT_KEY, trigger: 'schedule', userId, ...data },
    select: { id: true },
  })
  return { runId: created.id, before: null }
}

/** The report again, with what its notice and e-mail did. */
export async function storeRunOutput(runId: string, output: RunOutput): Promise<void> {
  await prisma.agentRun.update({ where: { id: runId }, data: { output: output as unknown as Prisma.InputJsonValue } })
}

/** An undo of a report: its bell notices taken back, the run kept on record as withdrawn. The e-mail stays sent. */
export async function withdrawRun(runId: string): Promise<{ noticesRemoved: number }> {
  const row = await runById(runId)
  if (!row) return { noticesRemoved: 0 }
  const removed = await prisma.notification.deleteMany({ where: { type: ADS_RUN_NOTICE_TYPE, meta: { path: ['runId'], equals: runId } } })
  const output = outputOf(row) ?? { v: 1 }
  await prisma.agentRun.update({
    where: { id: runId },
    data: { status: 'cancelled', endedAt: row.endedAt ?? new Date(), output: { ...output, withdrawnAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue },
  })
  return { noticesRemoved: removed.count }
}

// ── The bell and the e-mail ────────────────────────────────────────────────────────────────────────

/** The operator's calendar day of a moment (YYYY-MM-DD). */
export function operatorDay(at: Date, timeZone = ADS_RUN_DAY_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

export interface EmailOutcome {
  status: 'sent' | 'dry-run' | 'skipped' | 'failed'
  /** The operator's day it counts against (sent or dry run), else null. */
  on: string | null
  recipients: number
  why: string | null
}

/** The Monday ads digest's recipients (NEXUS_ADS_DIGEST_RECIPIENTS); loaded where used, as its module graph is wide. */
async function digestRecipients(): Promise<string[]> {
  const { digestRecipients: read } = await import('../advertising/ads-weekly-digest-mail.service.js')
  return read()
}

/** Whether a report e-mail already went (or was rehearsed) on this operator day, in this business. */
export async function emailedOn(day: string, now = new Date()): Promise<boolean> {
  const recent = await runsSince(new Date(now.getTime() - 2 * 86_400_000), 100)
  return recent.some((row) => {
    const email = outputOf(row)?.email
    return !!email && email.on === day && (email.status === 'sent' || email.status === 'dry-run')
  })
}

/** Whether today's e-mail would go, and to how many (the dry run's answer; never the addresses). */
export async function emailPlan(wanted: boolean, now = new Date()): Promise<{ send: boolean; recipients: number; why: string | null }> {
  const recipients = (await digestRecipients()).length
  if (!wanted) return { send: false, recipients, why: 'the run asked for no e-mail' }
  if (!recipients) return { send: false, recipients, why: 'no recipients are set for the Monday ads digest (NEXUS_ADS_DIGEST_RECIPIENTS)' }
  if (await emailedOn(operatorDay(now), now)) return { send: false, recipients, why: 'today\'s report e-mail already went (one a day)' }
  return { send: true, recipients, why: null }
}

export async function sendRunEmail(message: { subject: string; html: string; text: string }, now = new Date()): Promise<EmailOutcome> {
  const to = await digestRecipients()
  if (!to.length) return { status: 'skipped', on: null, recipients: 0, why: 'no recipients are set for the Monday ads digest' }
  const day = operatorDay(now)
  if (await emailedOn(day, now)) return { status: 'skipped', on: null, recipients: to.length, why: 'today\'s report e-mail already went (one a day)' }
  try {
    const sent = await sendEmail({ to, subject: message.subject, html: message.html, text: message.text, tag: 'claude-ads-run' })
    if (sent.dryRun) return { status: 'dry-run', on: day, recipients: to.length, why: 'built and logged, nothing mailed: outbound e-mail is off' }
    return sent.ok
      ? { status: 'sent', on: day, recipients: to.length, why: null }
      : { status: 'failed', on: null, recipients: to.length, why: sent.error ?? 'the e-mail could not be sent' }
  } catch (error) {
    logger.warn('[ads-manager-run] e-mail failed', { error: String(error).slice(0, 140) })
    return { status: 'failed', on: null, recipients: to.length, why: 'the e-mail could not be sent' }
  }
}

/** One bell notice to the business's people (danger is never deduped: notifyAutomationDetailed). */
export async function noticeRun(n: { runId: string; op: 'finish' | 'fail'; danger: boolean; title: string; body: string; waiting: number }) {
  const severity = n.danger ? 'danger' : 'info'
  const result = await notifyAutomationDetailed({
    type: ADS_RUN_NOTICE_TYPE,
    severity,
    title: n.title,
    body: n.body,
    href: n.waiting > 0 ? '/fleet/approvals' : AUTOMATION_HREF,
    meta: { runId: n.runId, op: n.op },
  })
  return { severity, created: result.created }
}

/** The business's own name, for the e-mail's subject (the token's business: row-level security holds the rest). */
export async function businessName(workspaceId: string): Promise<string | null> {
  const row = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }).catch(() => null)
  return row?.name ?? null
}
