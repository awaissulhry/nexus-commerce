/**
 * ADS AUTONOMY W4-1 — the daily Claude ads run reports to Nexus (agent-results/6 §6 "Where the daily summary goes").
 *
 *   report-ads-run    start · finish · fail (and withdraw, what undo sends). Nexus only: nothing reaches Amazon or a
 *                     buyer. start records the run and answers with what the business set (the mode, each ad tool's
 *                     level, the Pause, the daily cap, each market's strategy version). finish / fail store the report:
 *                     Claude's words per market and the approval ids it asked for; Nexus adds every number itself
 *                     (`amazonOverview`, the read ads-overview answers from), reads what each approval became, and sends
 *                     one bell notice and at most one e-mail a day. A line with an amount or a percentage is refused.
 *   ads-manager-runs  the runs of the last days, each approval's fate read again now (approved, declined, expired …).
 *   set-ads-report-time  W4-2 — by when the day's report is due (the watchdog, ads-manager-watchdog.service.ts). Ceiling
 *                     ask: Claude never changes its own watchdog alone.
 *
 * The record lives in ads-manager-run.service.ts (one AgentRun per run, id = the start request's approvalId: the runId).
 * Ceiling auto: a business may let the report run by its rule, inside `allowEmail` (the e-mail may go without a
 * person). Reversibility partial: undo withdraws the bell notice and marks the run withdrawn; a sent e-mail stays sent.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import prisma from '../../../db.js'
import {
  approvalCounts,
  businessName,
  emailPlan,
  FATE_WORDS,
  fateOf,
  namedApprovals,
  noticeRun,
  operatorDay,
  outputOf,
  recordFinish,
  recordStart,
  RUN_STATUS_WORDS,
  runById,
  runsSince,
  runStateOf,
  sendRunEmail,
  startFacts,
  startRequestOf,
  storeRunOutput,
  WATCH_WEEK_SLOT,
  withdrawRun,
  type EmailOutcome,
  type NamedApproval,
  type RunOutput,
  type RunState,
  type RunStatus,
  type StartFacts,
} from '../ads-manager-run.service.js'
import { knownTimeZone, readExpectedReport, TIME, writeExpectedReport, type ExpectedReport } from '../ads-manager-watchdog.service.js'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'
import { amazonOverview } from './ads-read.tools.js'

const TOOL = 'report-ads-run'
const OPS = ['start', 'finish', 'fail', 'withdraw'] as const
type Op = (typeof OPS)[number]
const MAX_IDS = 100
const DAYS = 7

const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
const ID = z.string().trim().min(1).max(64)
const sentence = (max: number) => z.string().trim().min(1).max(max)

/**
 * An amount or a percentage in Claude's words: €12, 12 €, 12.50 EUR, USD 3, 31%, 31 % — Nexus states every figure of a
 * report itself, so the words cannot misstate one. Counts ("3 campaigns", "2 wait") are words.
 */
const FIGURE = /[€$£]\s?\d|\d\s?(?:[€$£%]|(?:EUR|USD|GBP|SEK|PLN|CHF)\b)|\b(?:EUR|USD|GBP|SEK|PLN|CHF)\s?\d|\bper ?cent\b/i

const INPUT = z.object({
  op: z.preprocess(lower, z.enum(OPS))
    .describe('start when the run begins; finish when it ends; fail when it cannot finish (say why in problems); withdraw is what undo sends (with runId)'),
  runId: ID.optional()
    .describe('finish, fail, withdraw: the approvalId the start request of this run answered with (omit for a run whose start was never sent)'),
  markets: z.array(z.object({
    market: z.string().trim().toUpperCase().min(2).max(20).describe('an Amazon market code of this business (business-overview lists them: IT, DE …)'),
    lines: z.array(sentence(300)).max(5).default([])
      .describe('up to 5 short lines in plain words: what the run saw and did in this market. No amounts or percentages: Nexus adds the market\'s figures itself'),
  })).max(20).optional().describe('finish, fail: one entry per market the run looked at'),
  ranByRule: z.array(ID).max(MAX_IDS).optional().describe('finish, fail: the approval ids of this run\'s changes that the business let run by its rule'),
  waiting: z.array(ID).max(MAX_IDS).optional().describe('finish, fail: the approval ids of this run\'s changes that wait for a person (the change plan)'),
  wouldDo: z.array(ID).max(MAX_IDS).optional().describe('finish, fail: the approval ids of this run\'s changes asked at watch (what it would have done; Nexus recorded each verdict)'),
  problems: z.array(sentence(300)).max(10).optional()
    .describe('finish, fail: what the Owner must know (a refusal, data too old, a tool missing), in plain words without amounts; any problem makes the notice a danger notice'),
  nextFocus: sentence(500).optional().describe('finish, fail: what the next run looks at first, in plain words without amounts'),
  email: z.boolean().optional().describe('finish, fail: false sends no e-mail with this report (default: the day\'s one e-mail goes if none went yet)'),
})
type Args = z.infer<typeof INPUT>

/** The limits a business may set for letting a report run by its rule. */
export const REPORT_LIMITS = z.object({
  allowEmail: z.boolean().default(true).describe('the day\'s report e-mail (at most one a day, to the Monday ads digest\'s recipients) may go without a person'),
})

// ── Each market's figures (Nexus's own) ────────────────────────────────────────────────────────────

interface Period { spendCents: number; salesCents: number; orders: number; clicks: number; acos: number | null }
export interface MarketFigures {
  market: string
  currency: string | null
  dataAsOf: string | null
  /** The newest day of data (Amazon restates the last 3 days for up to 72 hours: `provisional`). */
  lastDay: (Period & { date: string; provisional: boolean }) | null
  last7Days: Period & { from: string; to: string }
  previous7Days: Period & { from: string | null; to: string | null }
  campaigns: { total: number; enabled: number }
}

const ratio = (top: number, bottom: number) => (bottom > 0 ? top / bottom : null)
const period = (t: { spendCents: number; salesCents: number; orders: number; clicks: number }): Period => ({
  spendCents: t.spendCents, salesCents: t.salesCents, orders: t.orders, clicks: t.clicks, acos: ratio(t.spendCents, t.salesCents),
})

/** Every Amazon market's figures for the last 7 complete days, the 7 before, and the newest day — as ads-overview reads them. */
async function marketFigures(): Promise<Map<string, MarketFigures>> {
  const overview = await amazonOverview({ days: DAYS })
  const out = new Map<string, MarketFigures>()
  for (const m of overview.markets) {
    const newest = m.days.find((d) => d.date === m.dataAsOf) ?? m.days.at(-1) ?? null
    out.set(m.market, {
      market: m.market,
      currency: m.currency ?? null,
      dataAsOf: m.dataAsOf,
      lastDay: newest ? { date: newest.date, provisional: newest.provisional, ...period(newest) } : null,
      last7Days: { from: overview.window.from, to: overview.window.to, ...period(m.totals) },
      previous7Days: { from: m.previous.from, to: m.previous.to, ...period(m.previous) },
      campaigns: { total: m.campaigns.total, enabled: m.campaigns.enabled },
    })
  }
  return out
}

const money = (cents: number, currency: string | null) => {
  if (!currency) return (cents / 100).toFixed(2)
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`
  }
}
const pct = (fraction: number | null) => (fraction == null ? 'no sales' : `${(fraction * 100).toFixed(1)} %`)

/** One market's figures in one line, as the bell and the e-mail say them. */
function figuresLine(f: MarketFigures): string {
  const week = `7 days: ${money(f.last7Days.spendCents, f.currency)} spend, ${money(f.last7Days.salesCents, f.currency)} sales, ACoS ${pct(f.last7Days.acos)} (the 7 before: ${pct(f.previous7Days.acos)})`
  if (!f.lastDay) return `${f.market} — ${week}`
  const day = `${f.lastDay.date}${f.lastDay.provisional ? ' (may still change)' : ''}: ${money(f.lastDay.spendCents, f.currency)} spend, ${money(f.lastDay.salesCents, f.currency)} sales, ${f.lastDay.orders} orders`
  return `${f.market} — ${day}; ${week}`
}

// ── The plan of one call (the dry run, and again at execute) ──────────────────────────────────────

type Refusal = { ok: false; error: string }
interface MarketReport { market: string; lines: string[]; figures: MarketFigures | null }
interface ReportPlan {
  op: 'finish' | 'fail'
  runId: string | null
  startRecorded: boolean
  started: Started | null
  markets: MarketReport[]
  approvals: NamedApproval[]
  counts: ReturnType<typeof approvalCounts>
  problems: string[]
  nextFocus: string | null
  danger: boolean
  title: string
  email: { send: boolean; recipients: number; why: string | null }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function wordsRefusal(a: Args): string | null {
  const texts = [
    ...(a.markets ?? []).flatMap((m) => m.lines.map((line) => ({ where: `markets ${m.market}`, line }))),
    ...(a.problems ?? []).map((line) => ({ where: 'problems', line })),
    ...(a.nextFocus ? [{ where: 'nextFocus', line: a.nextFocus }] : []),
  ]
  const hit = texts.find((t) => FIGURE.test(t.line))
  return hit
    ? `${hit.where}: "${hit.line.slice(0, 80)}" states an amount or a percentage. Nexus adds every figure of a report itself; write the line in words and leave the numbers out. Nothing was queued.`
    : null
}

/** The run a finish, fail or withdraw names, in this business; a refusal when it is not found or already over. */
/** What the start of a run recorded, as a person approving its end reads it. */
interface Started { at: string; mode: string | null; markets: string[] }
type FoundRun = { runId: string; status: RunStatus | null; startRecorded: boolean; started: Started | null }

async function runOf(runId: string, op: Op): Promise<FoundRun | Refusal> {
  const row = await runById(runId)
  if (!row) {
    const start = op === 'withdraw' ? null : await startRequestOf(runId)
    if (!start) return { ok: false, error: `Run ${runId} not found in this business: pass the approvalId the start request of this run answered with, or omit runId. Nothing was queued.` }
    return { runId, status: null, startRecorded: false, started: null }
  }
  const facts = (row.input as { start?: Partial<StartFacts> } | null)?.start
  const started: Started = {
    at: row.createdAt.toISOString(),
    mode: typeof facts?.mode === 'string' ? facts.mode : null,
    markets: Array.isArray(facts?.markets) ? facts.markets.map((m) => String(m?.market)) : [],
  }
  const status = row.status as RunStatus
  if (op !== 'withdraw' && status !== 'running') return { ok: false, error: `Run ${runId} already ${RUN_STATUS_WORDS[status] ?? status}: a run reports its end once. Nothing was queued.` }
  if (op === 'withdraw' && status === 'cancelled') return { ok: false, error: `Run ${runId} is already withdrawn. Nothing was queued.` }
  return { runId, status, startRecorded: true, started }
}

async function planReport(a: Args, now = new Date()): Promise<ReportPlan | Refusal> {
  const op = a.op as 'finish' | 'fail'
  const words = wordsRefusal(a)
  if (words) return { ok: false, error: words }
  const found = a.runId ? await runOf(a.runId, op) : null
  if (found && 'ok' in found) return found
  const run = found as Exclude<typeof found, Refusal>
  const named = new Set<string>()
  for (const m of a.markets ?? []) {
    if (named.has(m.market)) return { ok: false, error: `markets: ${m.market} is named twice; give each market one entry. Nothing was queued.` }
    named.add(m.market)
  }
  const [figures, approvals] = await Promise.all([
    named.size ? marketFigures() : Promise.resolve(new Map<string, MarketFigures>()),
    namedApprovals({ ranByRule: a.ranByRule ?? [], waiting: a.waiting ?? [], wouldDo: a.wouldDo ?? [] }),
  ])
  const unknown = [...named].filter((m) => !figures.has(m))
  if (unknown.length) {
    const own = [...figures.keys()].sort()
    return { ok: false, error: `Amazon market ${unknown.join(', ')} not found in this business (${own.length ? `its Amazon ad markets: ${own.join(', ')}` : 'it has no Amazon campaign'}). Nothing was queued.` }
  }
  if (approvals.missing.length) {
    return { ok: false, error: `Approval ${approvals.missing.slice(0, 5).join(', ')} not found in this business: name only the approval ids this run's own requests answered with. Nothing was queued.` }
  }
  const counts = approvalCounts(approvals.items)
  const problems = a.problems ?? []
  const danger = op === 'fail' || problems.length > 0
  const head = op === 'fail' ? 'Claude ads run failed' : 'Claude ads run'
  const title = [
    head,
    ...(problems.length ? [plural(problems.length, 'problem')] : []),
    `${counts.ranByRule} ran by rule`,
    `${counts.waitingForYou} wait for you`,
  ].join(' · ')
  return {
    op,
    runId: run?.runId ?? null,
    startRecorded: run?.startRecorded ?? false,
    started: run?.started ?? null,
    markets: (a.markets ?? []).map((m) => ({ market: m.market, lines: m.lines, figures: figures.get(m.market) ?? null })),
    approvals: approvals.items,
    counts,
    problems,
    nextFocus: a.nextFocus ?? null,
    danger,
    title,
    email: await emailPlan(a.email !== false, now),
  }
}

function reportPreview(p: ReportPlan) {
  const mismatches = p.approvals.filter((a) => a.mismatch).map((a) => `${a.approvalId}: ${a.mismatch}`)
  const notice = `one ${p.danger ? 'danger' : 'info'} notice to the business's bell`
  const mail = p.email.send ? `the day's e-mail to ${plural(p.email.recipients, 'recipient')}` : `no e-mail (${p.email.why})`
  return {
    action: TOOL,
    op: p.op,
    summary: `Reports the daily Claude ads run${p.op === 'fail' ? ' as failed' : ''}: ${p.counts.ranByRule} ran by rule, `
      + `${p.counts.waitingForYou} wait for you${p.problems.length ? `, ${plural(p.problems.length, 'problem')}` : ''}. Sends ${notice} and ${mail}. Nexus only.`,
    // MATERIAL_PREVIEW_FIELDS: the run, and whether it is over — another report of it since makes this a different one.
    run: { runId: p.runId, finished: false },
    startRecorded: p.startRecorded,
    started: p.started,
    markets: p.markets,
    approvals: p.approvals,
    counts: p.counts,
    problems: p.problems,
    nextFocus: p.nextFocus,
    notice: { severity: p.danger ? 'danger' : 'info', title: p.title },
    email: p.email,
    totals: { markets: p.markets.length, ranByRule: p.counts.ranByRule, waitingForYou: p.counts.waitingForYou, wouldHaveRun: p.counts.wouldHaveRun, problems: p.problems.length },
    ...(mismatches.length ? { warnings: mismatches.slice(0, 10) } : {}),
  }
}

// ── The notice and the e-mail ──────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function noticeBody(p: ReportPlan): string {
  const parts = [
    ...p.problems.slice(0, 3).map((problem) => `Problem: ${problem}`),
    ...p.markets.map((m) => (m.figures ? figuresLine(m.figures) : m.market)),
    ...(p.nextFocus ? [`Next: ${p.nextFocus}`] : []),
  ]
  const body = parts.join('\n')
  return body.length > 1000 ? `${body.slice(0, 999)}…` : body
}

/** The Approvals page of one request (mcp-tool-call.ts approvalsPageUrl), or null when Nexus has no public origin set. */
async function approvalLink(workspaceId: string, approvalId: string): Promise<string | null> {
  try {
    const { approvalsPageUrl } = await import('../../mcp/mcp-tool-call.js')
    return approvalsPageUrl(workspaceId, approvalId)
  } catch {
    return null
  }
}

async function renderEmail(p: ReportPlan, business: string | null, runId: string, now: Date) {
  const workspaceId = workspaceIdForQuery()
  const subject = `Claude ads${business ? ` · ${business}` : ''} — ${p.counts.ranByRule} ran, ${p.counts.waitingForYou} wait for you${p.problems.length ? ` · ${plural(p.problems.length, 'problem')}` : ''}`
  const links = new Map<string, string | null>()
  for (const a of p.approvals) links.set(a.approvalId, await approvalLink(workspaceId, a.approvalId))
  const item = (a: NamedApproval) => {
    const link = links.get(a.approvalId)
    const name = esc(a.title ?? a.tool)
    const watch = a.watch ? ` — at watch: ${a.watch.wouldRun ? 'would have run by rule' : `would not have run (${esc(a.watch.why ?? 'held')})`}` : ''
    return `<li>${link ? `<a href="${esc(link)}">${name}</a>` : name} — ${esc(FATE_WORDS[a.fate])}${watch}</li>`
  }
  const group = (heading: string, rows: NamedApproval[]) => (rows.length ? `<h3 style="margin:16px 0 4px;font-size:14px">${heading}</h3><ul style="margin:0;padding-left:18px">${rows.map(item).join('')}</ul>` : '')
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1c2530;max-width:680px">
  <h2 style="margin:0 0 2px;font-size:17px">Claude ads run — ${esc(operatorDay(now))}</h2>
  <p style="margin:0 0 14px;color:#5b6573;font-size:13px">${p.counts.ranByRule} ran by rule · ${p.counts.waitingForYou} wait for you${p.counts.wouldHaveRun ? ` · ${p.counts.wouldHaveRun} would have run (watch)` : ''}</p>
  ${p.problems.length || p.op === 'fail' ? `<div style="padding:12px 14px;border-left:3px solid #a3342b;background:#fdf6f5;margin:0 0 16px">
    <b>${p.op === 'fail' ? 'The run reported a failure.' : `${plural(p.problems.length, 'problem')} to look at.`}</b>
    ${p.problems.map((problem) => `<div style="margin-top:3px">${esc(problem)}</div>`).join('')}
  </div>` : ''}
  ${p.markets.map((m) => `<h3 style="margin:16px 0 4px;font-size:14px">${esc(m.market)}</h3>
  ${m.figures ? `<p style="margin:0 0 4px;color:#5b6573;font-size:13px">${esc(figuresLine(m.figures))}</p>` : ''}
  ${m.lines.length ? `<ul style="margin:0;padding-left:18px">${m.lines.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : ''}`).join('')}
  ${group('Ran by rule', p.approvals.filter((a) => a.byRule))}
  ${group('Waits for you', p.approvals.filter((a) => a.fate === 'waiting' || a.fate === 'handed_back'))}
  ${group('Decided by a person', p.approvals.filter((a) => !a.byRule && (a.fate === 'ran' || a.fate === 'approved')))}
  ${group('Not run', p.approvals.filter((a) => !['ran', 'approved', 'waiting', 'handed_back'].includes(a.fate)))}
  ${p.nextFocus ? `<p style="margin:16px 0 0"><b>Next:</b> ${esc(p.nextFocus)}</p>` : ''}
  <p style="margin:20px 0 0;color:#8a93a1;font-size:12px">Run ${esc(runId)}. Every figure here is Nexus's own, read when the report was made; the words are Claude's.</p>
</div>`
  const text = [
    subject,
    ...p.problems.map((problem) => `Problem: ${problem}`),
    ...p.markets.flatMap((m) => [m.figures ? figuresLine(m.figures) : m.market, ...m.lines.map((line) => `  - ${line}`)]),
    ...p.approvals.map((a) => `${a.title ?? a.tool} (${a.approvalId}): ${FATE_WORDS[a.fate]}`),
    ...(p.nextFocus ? [`Next: ${p.nextFocus}`] : []),
  ].join('\n')
  return { subject, html, text }
}

// ── report-ads-run ─────────────────────────────────────────────────────────────────────────────────

const START_NEXT = 'Keep the approvalId of this request: it is the runId that finish and fail take.'

async function startPreview() {
  const facts = await startFacts()
  return {
    action: TOOL,
    op: 'start' as const,
    summary: `Records that the daily Claude ads run began (mode: ${facts.mode}). Nexus only; no notice, no e-mail.`,
    run: null,
    mode: facts.mode,
    facts,
    next: START_NEXT,
  }
}

async function withdrawPreview(runId: string | undefined): Promise<{ ok: true; preview: unknown } | Refusal> {
  if (!runId) return { ok: false, error: 'withdraw needs runId: the run whose report to take back. Nothing was queued.' }
  const run = await runOf(runId, 'withdraw')
  if ('ok' in run) return run
  return {
    ok: true,
    preview: {
      action: TOOL,
      op: 'withdraw',
      summary: `Takes back the bell notice of run ${runId} and marks the run withdrawn. An e-mail already sent stays in the inbox. Nexus only.`,
      run: { runId, finished: run.status !== 'running' },
    },
  }
}

async function plan(args: Record<string, unknown>): Promise<{ ok: true; preview: unknown; report?: ReportPlan } | Refusal> {
  const a = args as Args
  if (a.op === 'start') {
    if (a.runId) return { ok: false, error: 'start takes no runId: its own approvalId becomes the runId. Nothing was queued.' }
    return { ok: true, preview: await startPreview() }
  }
  if (a.op === 'withdraw') return withdrawPreview(a.runId)
  const report = await planReport(a)
  if ('ok' in report) return report
  return { ok: true, preview: reportPreview(report), report }
}

export function reportWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = preview as { action?: unknown; op?: unknown; email?: { send?: unknown } } | null
  if (!p || typeof p !== 'object' || p.action !== TOOL || typeof p.op !== 'string') return 'there is no preview to judge'
  if (p.email?.send === true && limits.allowEmail !== true) return 'it sends the day\'s report e-mail, and your limits keep e-mails for a person'
  return null
}

/** C2 — undo: the report's bell notice taken back and the run marked withdrawn (op withdraw). */
export const REPORT_UNDO: ToolUndo = {
  async current(change) {
    return runStateOf((change.after as RunState).runId)
  },
  request(change) {
    const after = (change.after ?? {}) as Partial<RunState>
    if (!after.runId) return { refusal: 'This change names no run.' }
    if (after.withdrawn || after.status === 'cancelled') return { refusal: 'This put a report back already: a withdrawn report is not sent again.' }
    return { tool: TOOL, args: { op: 'withdraw', runId: after.runId } }
  },
}

async function execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const a = args as Args
  const userId = ctx.userId ?? null
  if (a.op === 'start') {
    if (!ctx.approvalId) return { ok: false, error: 'A start runs only as an approved request: its approvalId is the runId.' }
    const facts = await startFacts()
    const before: RunState = { runId: ctx.approvalId, status: null, withdrawn: false }
    const started = await recordStart(ctx.approvalId, facts, userId)
    return {
      ok: true,
      data: { runId: ctx.approvalId, status: 'running', recorded: started.created, mode: facts.mode },
      change: { before, after: await runStateOf(ctx.approvalId) },
    }
  }
  if (a.op === 'withdraw') {
    const checked = await withdrawPreview(a.runId)
    if (checked.ok === false) return checked
    const before = await runStateOf(a.runId!)
    const withdrawn = await withdrawRun(a.runId!)
    return { ok: true, data: { runId: a.runId, status: 'cancelled', noticesRemoved: withdrawn.noticesRemoved }, change: { before, after: await runStateOf(a.runId!) } }
  }
  const now = new Date()
  const report = await planReport(a, now)
  if ('ok' in report) return report
  const output: RunOutput = {
    v: 1,
    op: report.op,
    reportedAt: now.toISOString(),
    markets: report.markets,
    approvals: report.approvals,
    counts: report.counts,
    problems: report.problems,
    nextFocus: report.nextFocus,
  }
  // On record first: a notice or an e-mail that fails never loses the run.
  const recorded = await recordFinish(report.runId, report.op, output, userId)
  const notice = await noticeRun({ runId: recorded.runId, op: report.op, danger: report.danger, title: report.title, body: noticeBody(report), waiting: report.counts.waitingForYou })
  const email: EmailOutcome = report.email.send
    ? await sendRunEmail(await renderEmail(report, await businessName(workspaceIdForQuery()), recorded.runId, now), now)
    : { status: 'skipped', on: null, recipients: report.email.recipients, why: report.email.why }
  await storeRunOutput(recorded.runId, { ...output, notice, email })
  return {
    ok: true,
    data: { runId: recorded.runId, status: report.op === 'finish' ? 'done' : 'failed', counts: report.counts, notice, email },
    change: { before: { runId: recorded.runId, status: recorded.before, withdrawn: false } satisfies RunState, after: await runStateOf(recorded.runId) },
  }
}

const reportAdsRun: AgentTool = {
  name: TOOL,
  title: 'Report the daily ads run',
  category: 'advertising',
  description:
    'Report the daily Claude ads run to Nexus: the scheduled run\'s own record, Nexus only (nothing reaches Amazon). '
    + 'op start when the run begins: Nexus records it and answers with what the business set — the run\'s mode (paused, '
    + 'act, watch or ask), each ad tool\'s level, the Pause, the daily cap and each market\'s strategy version. Keep the '
    + 'approvalId of the start request: it is the runId. op finish (or fail) when the run ends: per market up to 5 lines '
    + 'in plain words — no amounts or percentages, Nexus adds each market\'s figures itself from the read ads-overview '
    + 'answers from — the approval ids this run asked for (ranByRule, waiting, wouldDo), problems and the next focus. '
    + 'Nexus reads what each approval became and states the counts itself, sends one notice to the business\'s bell (a '
    + 'danger notice when there is a problem or the run failed) and at most one e-mail a day to the Monday ads digest\'s '
    + 'recipients. It is a request: a person approves it in Nexus, unless the business lets it run by its rule (limits: '
    + 'whether the e-mail may go without a person). Undo withdraws the bell notice and marks the run withdrawn; an e-mail '
    + 'already sent stays in the inbox.',
  surfaces: ['mcp'],
  input: INPUT,
  requires: [F.adsView, FIELDS.financialsAdspendView],
  riskTier: 'low',
  requiresApprovalDefault: true,
  readOnly: false,
  openWorld: false,
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: REPORT_LIMITS,
  withinLimits: reportWithinLimits,
  undo: REPORT_UNDO,
  async handler(args): Promise<ToolResult> {
    const planned = await plan(args)
    return planned.ok === false ? planned : { ok: true, preview: planned.preview }
  },
  execute,
}

// ── ads-manager-runs ───────────────────────────────────────────────────────────────────────────────

const adsManagerRuns: AgentTool = {
  name: 'ads-manager-runs',
  title: 'Daily ads runs',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  input: z.object({
    days: z.coerce.number().int().min(1).max(30).default(DAYS).describe(`the runs of the last N days (default ${DAYS}, max 30)`),
  }),
  description:
    'The daily Claude ads runs of the last days (report-ads-run), newest first: each run\'s status (started, finished, '
    + 'reported a failure, withdrawn) and mode, per market the run\'s lines and the figures Nexus stated, each approval '
    + 'the run named with what it is now (ran, approved, waits for a person, declined, expired …) and what it was when '
    + 'reported, the problems, the next focus, and whether the bell notice and the e-mail went. A run that started and '
    + 'never reported its end shows as started. Amounts are minor units of each market\'s own currency; a person without '
    + 'the ad-spend money permission gets the same answer without them. Read only.',
  async handler(args): Promise<ToolResult> {
    const days = Number((args as { days: number }).days)
    const since = new Date(Date.now() - days * 86_400_000)
    const rows = await runsSince(since)
    const named = [...new Set(rows.flatMap((row) => (outputOf(row)?.approvals ?? []).map((a) => a.approvalId)))]
    const now = named.length
      ? await prisma.agentApproval.findMany({ where: { id: { in: named } }, select: { id: true, status: true, reason: true } })
      : []
    const fateNow = new Map(now.map((row) => [row.id, fateOf(row)]))
    const tally: Record<string, number> = {}
    const runs = rows.map((row) => {
      const out = outputOf(row)
      const start = (row.input as { start?: StartFacts } | null)?.start ?? null
      const approvals = (out?.approvals ?? []).map((a) => {
        const fate = fateNow.get(a.approvalId) ?? 'other'
        tally[fate] = (tally[fate] ?? 0) + 1
        return { approvalId: a.approvalId, listedAs: a.listedAs, tool: a.tool, title: a.title, fate, meaning: FATE_WORDS[fate], whenReported: a.fate, byRule: a.byRule, watch: a.watch }
      })
      const status = row.status as RunStatus
      return {
        runId: row.id,
        status,
        meaning: RUN_STATUS_WORDS[status] ?? row.status,
        startedAt: row.createdAt.toISOString(),
        endedAt: row.endedAt?.toISOString() ?? null,
        mode: start?.mode ?? null,
        strategyVersions: start?.markets ?? null,
        markets: (out?.markets ?? []) as MarketReport[],
        counts: out?.counts ?? null,
        approvals,
        problems: out?.problems ?? [],
        nextFocus: out?.nextFocus ?? null,
        notice: out?.notice ?? null,
        email: out?.email ?? null,
        ...(out?.withdrawnAt ? { withdrawnAt: out.withdrawnAt } : {}),
      }
    })
    return {
      ok: true,
      data: {
        window: { days },
        runs,
        total: runs.length,
        unfinished: runs.filter((r) => r.status === 'running').length,
        fatesNow: tally,
        // W4-2 — by when the watchdog expects the day's report (null: the missing-report check is off).
        expectedReport: await expectedNow(),
        // W4-5 — the watch-week comparison stands here once built.
        watchWeek: WATCH_WEEK_SLOT,
        ...(runs.length ? {} : { empty: `No daily Claude ads run reported in the last ${days} days.` }),
      },
    }
  },
}

// ── set-ads-report-time (W4-2) ─────────────────────────────────────────────────────────────────────

const REPORT_TIME_TOOL = 'set-ads-report-time'

async function expectedNow(): Promise<ExpectedReport | null> {
  const now = await readExpectedReport()
  return now ? { time: now.time, timeZone: now.timeZone } : null
}

const words = (e: ExpectedReport | null) => (e ? `${e.time} (${e.timeZone})` : 'off')

async function planReportTime(args: Record<string, unknown>) {
  const a = args as { time: string | null; timeZone?: string }
  const timeZone = a.time === null ? null : knownTimeZone(a.timeZone ?? 'Europe/Rome')
  if (a.time !== null && !timeZone) return { ok: false as const, error: `timeZone: "${a.timeZone}" is not a time zone Nexus knows (use an IANA name such as Europe/Rome). Nothing was queued.` }
  const to: ExpectedReport | null = a.time === null ? null : { time: a.time, timeZone: timeZone! }
  const from = await expectedNow()
  return { ok: true as const, from, to }
}

/** C2 — undo: the time it replaced, set again (off, when there was none). */
export const REPORT_TIME_UNDO: ToolUndo = {
  async current() {
    return { expected: await expectedNow() }
  },
  request(change) {
    const before = (change.before as { expected: ExpectedReport | null } | null)?.expected ?? null
    return { tool: REPORT_TIME_TOOL, args: before ? { time: before.time, timeZone: before.timeZone } : { time: null } }
  },
}

const setAdsReportTime: AgentTool = {
  name: REPORT_TIME_TOOL,
  title: 'Set the daily report time',
  category: 'advertising',
  description:
    'Set by when the daily Claude ads run reports its end (report-ads-run finish or fail), on the business\'s own clock: '
    + 'a time (HH:MM, 24-hour) and a time zone. Nexus\'s watchdog checks every hour: no report by that time plus 30 '
    + 'minutes sends one danger notice to the bell and one e-mail to the Monday ads digest\'s recipients (a run that '
    + 'started and reports no end in 2 hours does too, with or without this time). time null switches the missing-report '
    + 'check off. Nexus only. A person approves it in Nexus (Claude never changes its own watchdog alone); undo sets the '
    + 'time it replaced again.',
  input: z.object({
    time: z.string().trim().regex(TIME, 'a time as HH:MM, 24-hour').nullable()
      .describe('HH:MM, 24-hour, by which the day\'s report arrives (e.g. 08:30); null switches the missing-report check off'),
    timeZone: z.string().trim().min(1).max(64).optional().describe('an IANA time zone for the time (default Europe/Rome)'),
  }),
  requires: [F.adsAutomationManage],
  riskTier: 'low',
  requiresApprovalDefault: true,
  readOnly: false,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: REPORT_TIME_UNDO,
  async handler(args): Promise<ToolResult> {
    const p = await planReportTime(args)
    if (p.ok === false) return p
    return {
      ok: true,
      preview: {
        action: REPORT_TIME_TOOL,
        summary: p.to
          ? `The daily Claude ads run reports by ${words(p.to)}; with no report by 30 minutes later, the watchdog alerts you. Nexus only.`
          : 'Switches the missing-report check of the daily Claude ads run off (a started run with no end still alerts). Nexus only.',
        changes: { 'expected report time': { from: words(p.from), to: words(p.to) } },
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const p = await planReportTime(args)
    if (p.ok === false) return p
    await writeExpectedReport(p.to, ctx.userId ?? null)
    return { ok: true, data: { expectedReport: p.to }, change: { before: { expected: p.from }, after: { expected: await expectedNow() } } }
  },
}

export const ADS_MANAGER_TOOLS: AgentTool[] = [reportAdsRun, adsManagerRuns, setAdsReportTime]
