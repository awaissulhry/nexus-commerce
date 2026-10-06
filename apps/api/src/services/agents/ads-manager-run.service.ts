/**
 * ADS AUTONOMY W4-1 — the daily Claude ads run, on record (agent-results/6 §6 "Where the daily summary goes").
 *
 * A scheduled Claude run (a claude.ai routine, one per business) reports to Nexus with `report-ads-run`: `start` when it
 * begins, `finish` (or `fail`) when it ends. Each run is ONE AgentRun row of its own:
 *
 *   agentKey 'claude-ads-manager' · trigger 'schedule' · mode null · via null · cost 0
 *   id       the runId start answers with (a fresh id; the start's approvalId if a business's own policy made it
 *            wait for a person), or a fresh id for a run that reports without a start
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
 * report-ads-run's start, finish and fail are journal entries (tool-types.ts AgentTool.journal): they change nothing of
 * the business, so Claude's door runs them at once — also without nexus.run, in the watch week and during a Pause. A
 * withdraw is a request a person approves. The journal is capped: no start while a run that started within 2 hours is
 * open, at most RUNS_PER_DAY runs and DANGER_NOTICES_PER_DAY danger notices a business and operator day.
 *
 * One bell notice per finish or fail to each of the business's people — the figures only to those who may see its ad
 * money — (danger when the run names a problem or failed, never deduped; a warning past the day's cap), and at most one
 * e-mail a day per business (the operator's day, Europe/Rome, as the Monday digest counts it; one row taken atomically),
 * through the shared e-mail transport (a dry run unless outbound e-mail is on). To the Monday ads digest's recipients (NEXUS_ADS_DIGEST_RECIPIENTS);
 * when that list is empty, to this business's own active people who may see its ad money (ads.view and
 * financials.adspend.view, or its owners) — one e-mail per business, never two businesses in one.
 *
 * W4-5: the watch-week comparison — each watched step against what then happened to its entity — is
 * ads-watch-week.service.ts: `ads-manager-runs` answers with it, and the daily e-mail carries its table while watch mode
 * is on (`watchModeOn`).
 */

import type { Prisma } from '@nexus/database'
import { FEATURES as F, FIELDS, OWNER_ROLE_KEY, expandPermissions } from '@nexus/shared/permissions'
import prisma from '../../db.js'
import { workspaceContext } from '../../lib/workspace-context.js'
import { logger } from '../../utils/logger.js'
import { sendEmail } from '../email/transport.js'
import { AUTOMATION_HREF } from '../advertising/ads-automation-notify.service.js'
import { CLAUDE_ACTION_TOOLS } from '../advertising/ads-strategy/fields.js'
import { campaignMarkets, loadIndex } from '../advertising/ads-strategy/load.js'
import { strategyVersionOf } from '../advertising/ads-strategy/autonomy.js'
import type { ClaudeTrust } from './tool-types.js'
import { ADS_MANAGER_AGENT_KEY, ADS_RUN_DAY_ZONE, ADS_RUN_NOTICE_TYPE, DANGER_NOTICES_PER_DAY, OPEN_RUN_MS, RUNS_PER_DAY } from './ads-manager-constants.js'

// Claude's trust rules and the tool registry are imported where used: they load every tool, this module's own among
// them, and this module must load first in any order a process takes (ads-manager-constants.ts).
const trust = () => import('./claude-trust.service.js')
const registry = () => import('./tool-registry.js')

export { ADS_MANAGER_AGENT_KEY, ADS_RUN_DAY_ZONE, ADS_RUN_NOTICE_TYPE }

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
const adChangeTools = () => [...new Set(Object.values(CLAUDE_ACTION_TOOLS).flat())].sort()

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

/** Each ad change tool by the business's level for it now (the ads strategy may hold a kind lower where a change lands). */
export async function adToolLevels(): Promise<StartFacts['levels']> {
  const [{ ruleFrom }, { getTool }] = await Promise.all([trust(), registry()])
  const names = adChangeTools()
  const rows = await prisma.agentTool.findMany({ where: { name: { in: names } }, select: { name: true, claudeTrust: true, claudeLimits: true } })
  const levels: StartFacts['levels'] = { auto: [], watch: [], confirm: [], ask: [], off: [] }
  for (const name of names) {
    const tool = getTool(name)
    if (!tool) continue
    const level = ruleFrom(tool, rows.find((row) => row.name === name) ?? null).level as ClaudeTrust
    levels[level].push(name)
  }
  return levels
}

export async function startFacts(now = new Date()): Promise<StartFacts> {
  const { autonomyOf, autoRunsInLastDay } = await trust()
  const [levels, autonomy, used, markets] = await Promise.all([adToolLevels(), autonomyOf(), autoRunsInLastDay(), campaignMarkets()])
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
  const { getTool } = await registry()
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

/**
 * A run begins (op start): its record, under a fresh id (the runId), or under `runId` — the start request's approvalId
 * when the business's own policy made the start wait for a person — unless a finish of that run got there first.
 */
export async function recordStart(runId: string | null, facts: StartFacts, userId: string | null): Promise<{ runId: string; created: boolean }> {
  const existing = runId ? await runById(runId) : null
  if (existing) return { runId: existing.id, created: false }
  const row = await prisma.agentRun.create({
    data: {
      ...(runId ? { id: runId } : {}),
      agentKey: ADS_MANAGER_AGENT_KEY,
      trigger: 'schedule',
      status: 'running',
      userId,
      input: { v: 1, start: facts } as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  })
  return { runId: row.id, created: true }
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

type RoleRows = Array<{ role: { key: string; permissions: string[] } }>
const mayReadAds = (roles: RoleRows, money: boolean) => {
  if (roles.some(({ role }) => role.key === OWNER_ROLE_KEY)) return true
  const held = expandPermissions(roles.flatMap(({ role }) => role.permissions))
  return held.has(F.adsView) && (!money || held.has(FIELDS.financialsAdspendView))
}

interface Person { userId: string; email: string; ads: boolean; money: boolean }

/**
 * This business's own active people, each with whether they may see its ads (ads.view, or an owner) and its ad money
 * (and financials.adspend.view). With business profiles on, the business's members by their roles in it; with them off
 * (one business), every active login by its roles — the people the bell reaches. Never anyone of another business.
 */
async function businessPeople(): Promise<Person[]> {
  const roles = { select: { role: { select: { key: true, permissions: true } } } } as const
  if (process.env.NEXUS_WORKSPACES_ENABLED === '1') {
    const workspaceId = workspaceContext()?.workspaceId
    if (!workspaceId) {
      logger.warn('[ads-manager-run] no business in context; nobody is told')
      return []
    }
    const members = await prisma.workspaceMembership.findMany({
      where: { workspaceId, status: 'active', user: { status: 'active' } },
      select: { userId: true, user: { select: { email: true } }, roles },
    })
    return members.map((m) => ({ userId: m.userId, email: m.user.email, ads: mayReadAds(m.roles, false), money: mayReadAds(m.roles, true) }))
  }
  const people = await prisma.userProfile.findMany({ where: { status: 'active' }, select: { id: true, email: true, roleAssignments: roles } })
  return people.map((p) => ({ userId: p.id, email: p.email, ads: mayReadAds(p.roleAssignments, false), money: mayReadAds(p.roleAssignments, true) }))
}

/** This business's own people who may see its ads — `money`: and its ad money, for an e-mail that states spend and sales. */
export async function adsPeople(opts: { money: boolean }): Promise<string[]> {
  return [...new Set((await businessPeople()).filter((p) => (opts.money ? p.money : p.ads)).map((p) => p.email).filter(Boolean))]
}

/** Who the day's report e-mail goes to: the Monday digest's list, else this business's own people who may see ad money. */
export async function reportRecipients(): Promise<{ to: string[]; source: 'digest' | 'business' }> {
  const digest = await digestRecipients()
  return digest.length ? { to: digest, source: 'digest' } : { to: await adsPeople({ money: true }), source: 'business' }
}

/**
 * The day's one report e-mail is a row of its own (AgentMemory, one per business and operator day, its unique key):
 * taking it is one insert that does nothing when the row is there, so two reports racing for the day's e-mail send one.
 */
const EMAIL_DAY = { scope: ADS_MANAGER_AGENT_KEY, entityType: 'report-email', key: 'sent' } as const

/** Whether the day's report e-mail is taken (sent, rehearsed, or being sent) in this business. */
export async function emailedOn(day: string): Promise<boolean> {
  return (await prisma.agentMemory.count({ where: { ...EMAIL_DAY, entityId: day } })) > 0
}

async function claimEmailDay(day: string): Promise<boolean> {
  const taken = await prisma.agentMemory.createMany({ data: [{ ...EMAIL_DAY, entityId: day, value: { at: new Date().toISOString() } }], skipDuplicates: true })
  return taken.count === 1
}

/** Whether today's e-mail would go, and to how many (the dry run's answer; never the addresses). */
export async function emailPlan(wanted: boolean, now = new Date()): Promise<{ send: boolean; recipients: number; why: string | null }> {
  const recipients = (await reportRecipients()).to.length
  if (!wanted) return { send: false, recipients, why: 'the run asked for no e-mail' }
  if (!recipients) return { send: false, recipients, why: 'no one to send it to: the Monday ads digest has no recipients and no one in this business may see its ad money' }
  if (await emailedOn(operatorDay(now))) return { send: false, recipients, why: 'today\'s report e-mail already went (one a day)' }
  return { send: true, recipients, why: null }
}

export async function sendRunEmail(message: { subject: string; html: string; text: string }, now = new Date()): Promise<EmailOutcome> {
  const { to } = await reportRecipients()
  if (!to.length) return { status: 'skipped', on: null, recipients: 0, why: 'no one to send it to: the Monday ads digest has no recipients and no one in this business may see its ad money' }
  const day = operatorDay(now)
  if (!(await claimEmailDay(day))) return { status: 'skipped', on: null, recipients: to.length, why: 'today\'s report e-mail already went (one a day)' }
  const release = () => prisma.agentMemory.deleteMany({ where: { ...EMAIL_DAY, entityId: day } }).catch(() => undefined)
  try {
    const sent = await sendEmail({ to, subject: message.subject, html: message.html, text: message.text, tag: 'claude-ads-run' })
    if (sent.dryRun) return { status: 'dry-run', on: day, recipients: to.length, why: 'built and logged, nothing mailed: outbound e-mail is off' }
    if (sent.ok) return { status: 'sent', on: day, recipients: to.length, why: null }
    await release()
    return { status: 'failed', on: null, recipients: to.length, why: sent.error ?? 'the e-mail could not be sent' }
  } catch (error) {
    logger.warn('[ads-manager-run] e-mail failed', { error: String(error).slice(0, 140) })
    await release()
    return { status: 'failed', on: null, recipients: to.length, why: 'the e-mail could not be sent' }
  }
}

export type NoticeSeverity = 'danger' | 'warn' | 'info'

/**
 * One bell notice to each of the business's people. The figures (spend, sales) only to those who may see its ad money;
 * the others get the same notice without amounts (`plainBody`). Never deduped.
 */
export async function noticeRun(n: { runId: string; op: 'finish' | 'fail'; severity: NoticeSeverity; title: string; body: string; plainBody: string; waiting: number }) {
  try {
    const people = await businessPeople()
    if (!people.length) return { severity: n.severity, created: 0 }
    const href = n.waiting > 0 ? '/fleet/approvals' : AUTOMATION_HREF
    await prisma.notification.createMany({
      data: people.map((p) => ({
        userId: p.userId, type: ADS_RUN_NOTICE_TYPE, severity: n.severity, title: n.title, body: p.money ? n.body : n.plainBody, href, meta: { runId: n.runId, op: n.op },
      })),
    })
    return { severity: n.severity, created: people.length }
  } catch (error) {
    logger.warn('[ads-manager-run] notice failed', { error: String(error).slice(0, 140) })
    return { severity: n.severity, created: 0 }
  }
}

// ── The day's caps ─────────────────────────────────────────────────────────────────────────────────

export interface DayCounts {
  /** Runs recorded on this operator day (a start, or a report without one). */
  runs: number
  /** Danger notices the day's reports raised. */
  dangerNotices: number
  /** A run that started within OPEN_RUN_MS and reported no end. */
  open: { runId: string; startedAt: Date } | null
}

/** The business's runs of this operator day, for the caps (RUNS_PER_DAY, DANGER_NOTICES_PER_DAY, OPEN_RUN_MS). */
export async function dayCounts(now = new Date()): Promise<DayCounts> {
  const day = operatorDay(now)
  const recent = await runsSince(new Date(now.getTime() - 30 * 3600_000), 100)
  const open = recent.find((r) => r.status === 'running' && r.createdAt.getTime() >= now.getTime() - OPEN_RUN_MS)
  return {
    runs: recent.filter((r) => operatorDay(r.createdAt) === day).length,
    dangerNotices: recent.filter((r) => {
      const out = outputOf(r)
      return out?.notice?.severity === 'danger' && out.notice.created > 0 && !!out.reportedAt && operatorDay(new Date(out.reportedAt)) === day
    }).length,
    open: open ? { runId: open.id, startedAt: open.createdAt } : null,
  }
}

/** Why a new run may not be recorded now, or null. */
export function newRunRefusal(counts: DayCounts, op: 'start' | 'report'): string | null {
  if (op === 'start' && counts.open) {
    return `Run ${counts.open.runId} started at ${counts.open.startedAt.toISOString()} and is still open: report its end (finish or fail) with that runId first. Nothing was recorded.`
  }
  if (counts.runs >= RUNS_PER_DAY) {
    return `This business recorded ${counts.runs} daily Claude ads runs today, the most a day (${RUNS_PER_DAY}); the next one starts tomorrow. Nothing was recorded.`
  }
  return null
}

/** The notice's severity: danger on a problem or a failure, but at most DANGER_NOTICES_PER_DAY a day (then a warning). */
export function noticeSeverity(danger: boolean, counts: DayCounts): NoticeSeverity {
  if (!danger) return 'info'
  return counts.dangerNotices >= DANGER_NOTICES_PER_DAY ? 'warn' : 'danger'
}

/** The business's own name, for the e-mail's subject (the token's business: row-level security holds the rest). */
export async function businessName(workspaceId: string): Promise<string | null> {
  const row = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }).catch(() => null)
  return row?.name ?? null
}
