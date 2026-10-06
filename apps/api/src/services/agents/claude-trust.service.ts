/**
 * MCP full control C5 (D1 = B) — how far Claude may run a change in one business without a person.
 *
 *   level      per business and per tool (AgentTool.claudeTrust): off (not offered to Claude) · ask (a person approves
 *              it in Nexus; the default, and what every tool is at with no row) · confirm (C7) · auto (runs after the
 *              undo window without a person, inside the tool's limits). Never above the tool's code ceiling
 *              (`maxClaudeTrust`): a higher stored value is read as the ceiling. A read, and a control tool, is off or
 *              ask (offered or not).
 *   limits     per business and per tool (AgentTool.claudeLimits), in the tool's own `limits` schema; null = the
 *              code defaults. `withinLimits(preview, limits)` decides; outside them the change waits for a person and
 *              Claude is told why.
 *   brakes     per business (AgentAutonomy): Pause (instant, no deploy: every change waiting to run by rule goes back
 *              to a person), a cap of changes run by rule in 24 hours (default 200), and an automatic pause after
 *              AUTO_PAUSE_FAILURES rule-runs that were stale or failed within an hour.
 *   nexus.run  without that scope on the connection, every change waits for a person, whatever the level.
 *   raising    a level, LOOSENING a tool's limits, raising the daily cap or resuming after a pause needs
 *              settings.security.manage and a fresh 2FA code. A brake is easy: lowering, TIGHTENING limits
 *              (`limitsTighten`) and Pause need neither (the routes let anyone who may use Claude in the business —
 *              ai.run — reach them). Every change is audited (AgentControlAudit, charter `claude`).
 *
 * How `auto` runs: the gate stores the request as usual; Claude's door (mcp-tool-call.ts) then schedules it as the
 * person who asked (decisionVia auto), through the normal undo window; the sweep's normal commit re-checks their
 * permissions and the preview, and — here — that the business still lets it run by rule. Everything is read fresh,
 * in the business the call is bound to (row-level security): one business's rule never applies in another.
 *
 * ADS AUTONOMY W1-8 — the ads strategy NARROWS the level of an ad change, never widens it: per kind of ad action and
 * where the change lands (a market, a category, a product: advertising/ads-strategy/claude.ts), the lower of the
 * tool's level here and the strategy's applies (`claudeRuleForChange`) — to refuse it (off), to decide who takes it,
 * to confirm it in Claude and, at commit, to hand a change back that the strategy narrowed inside its window. Brakes
 * are never narrowed. What a change cannot be placed for exactly takes the strictest row (fail closed).
 *
 * ADS AUTONOMY AA-W2-3 — a strategy-bound change (tool-types.ts StrategyBound) that the rule scheduled is judged once
 * more at commit, on the fresh dry run rather than the stored preview (`autoFreshRefusal`): its limits read the
 * strategy's facts and the day's counts from the preview, and those may move inside the window.
 *
 * ADS AUTONOMY AA-W2-4 — `watch`, between confirm and auto: a change Claude asks for at watch goes through the full
 * check auto would make (the level where it lands with the ads strategy, nexus.run, Pause, the tool's limits, the daily
 * cap — counting the watched changes that would have run, as if their kinds were at auto) and the verdict is recorded on
 * the request (AgentApproval.ruleVerdict, `watchVerdictOf` / a plan's per step). It is never scheduled by the rule: a
 * person decides it, as at confirm (watch allows all confirm allows, so lowering watch → confirm never lets Claude do
 * more). Raising to watch is a raise (2FA); lowering auto → watch is a free brake. Offered only for a tool whose
 * ceiling is auto, never for a brake (`levelsFor`).
 */

import { z } from 'zod'
import { Prisma } from '@nexus/database'
import { workspaceIdForQuery, workspaceKey } from '@nexus/database/workspace-context'
import type { RuleCheck, WatchStepVerdict, WatchVerdict } from '@nexus/shared/approval-queue'
import prisma from '../../db.js'
import { verifyStepUpCode } from '../../lib/auth/step-up.js'
import { publishEvent } from '../../lib/events/publish.js'
import { logger } from '../../utils/logger.js'
import { recordControlChange } from '../agent-fleet/control-audit.service.js'
import { BRAKE_TOOLS, strategyLevelFor, strategyMemo, type StrategyMemo, type StrategyNarrowing } from '../advertising/ads-strategy/claude.js'
import { DAILY_SOURCE } from '../advertising/ads-strategy/autonomy.js'
import type { ClaudeActionType } from '../advertising/ads-strategy/fields.js'
import { EXPIRY_HOURS } from './approval-gate.service.js'
import { offeredOn } from './call-tool.js'
import { bustPolicyCache } from './tool-policy.service.js'
import { getTool, listTools } from './tool-registry.js'
import { CLAUDE_TRUST_LEVELS, PLAN_TOOL, type AgentTool, type ClaudeTrust, type Reversibility } from './tool-types.js'
import { asWatched, dailyRefusal, ledgerOf, limitFactsOf, ruleRunLedger, type LimitFacts, type MarketFacts, type RuleRunLedger } from './tools/ads-autonomy-kit.js'

/** The charter Claude's approvals are audited under (AgentRun.agentKey of every MCP call). */
export const CLAUDE_CHARTER = 'claude'
export const DEFAULT_DAILY_AUTO_CAP = 200
export const MAX_DAILY_AUTO_CAP = 10_000
export const AUTO_CAP_WINDOW_MS = 24 * 3600_000
export const AUTO_PAUSE_FAILURES = 5
export const AUTO_PAUSE_WINDOW_MS = 3600_000
/** Who an automatic pause is by. */
export const AUTO_PAUSED_BY = 'Nexus'
/** The audit actions of a rule-run that never ran or failed (approval-inbox.service.ts writes them). */
const FAILED_RUN_ACTIONS = ['stale_refused', 'permission_refused', 'execution_failed']

const RANK: Record<ClaudeTrust, number> = { off: 0, ask: 1, confirm: 2, watch: 3, auto: 4 }
const isLevel = (value: unknown): value is ClaudeTrust => typeof value === 'string' && (CLAUDE_TRUST_LEVELS as readonly string[]).includes(value)
const lower = (a: ClaudeTrust, b: ClaudeTrust): ClaudeTrust => (RANK[a] <= RANK[b] ? a : b)

/**
 * Who changes a setting: the signed-in person (their id for the 2FA code, their name for the audit) and whether they
 * hold settings.security.manage in this business — needed to raise anything, never to lower or pause.
 */
export interface TrustActor {
  userId: string
  label: string
  canManage: boolean
}

/**
 * The words of a raise's refusals, for the act being raised. `act` starts a sentence ("Letting Claude do more without
 * a person needs …"), `before` ends one ("Turn on two-factor authentication before you …"), `free` says what needs
 * neither the permission nor the code.
 */
export interface RaiseWords {
  act: string
  before: string
  free: string
}

/** Claude's levels, limits, daily cap and resume (this file): the words every raise here has always used. */
export const CLAUDE_RAISE: RaiseWords = {
  act: 'Letting Claude do more without a person',
  before: 'you let Claude do more without a person',
  free: 'Lowering a level and Pause do not.',
}

/**
 * Raising: settings.security.manage, then a fresh 2FA code (lib/auth/step-up.ts: single use, lockout after wrong
 * codes). `sentence` names what is raised; the ads strategy (ads autonomy W1-3) raises through here too.
 */
export async function mayRaise(actor: TrustActor, code: unknown, sentence: RaiseWords = CLAUDE_RAISE): Promise<TrustRefusal | null> {
  if (!actor.canManage) {
    return { ok: false, status: 403, code: 'forbidden', error: `${sentence.act} needs the settings.security.manage permission in this business. ${sentence.free}` }
  }
  return stepUp(actor.userId, code, sentence)
}

export type TrustRefusal = { ok: false; status: 400 | 403 | 404 | 429; code?: string; error: string }

/** The most this tool may be set to: a read or a control tool is offered (ask) or not (off). */
export function trustCeiling(tool: Pick<AgentTool, 'readOnly' | 'control' | 'maxClaudeTrust'>): ClaudeTrust {
  if (tool.readOnly || tool.control) return 'ask'
  return tool.maxClaudeTrust ?? 'ask'
}

/**
 * AA-W2-4 — may this tool be watched? Only below an auto ceiling (watch measures what auto would do), and never a brake
 * (stop-automation, turn-down-automation, set-ad-guardrail): a brake runs by the rule or waits for a person, it is never
 * only recorded.
 */
export function watchable(tool: Pick<AgentTool, 'name' | 'readOnly' | 'control' | 'maxClaudeTrust'>): boolean {
  return trustCeiling(tool) === 'auto' && !(BRAKE_TOOLS as readonly string[]).includes(tool.name)
}

/** The levels a business may pick for this tool, lowest first. */
export function levelsFor(tool: Pick<AgentTool, 'name' | 'readOnly' | 'control' | 'maxClaudeTrust'>): ClaudeTrust[] {
  const ceiling = trustCeiling(tool)
  return CLAUDE_TRUST_LEVELS.filter((level) => RANK[level] <= RANK[ceiling] && (level !== 'watch' || watchable(tool)))
}

/** The highest level this tool allows that is not above `stored`: above the ceiling reads as the ceiling, a watch it does not allow as confirm. */
function levelAllowed(tool: AgentTool, stored: ClaudeTrust): ClaudeTrust {
  return levelsFor(tool).filter((level) => RANK[level] <= RANK[stored]).pop() ?? 'off'
}

const defaultsOf = (tool: AgentTool): Record<string, unknown> | null =>
  tool.limits ? (tool.limits.parse({}) as Record<string, unknown>) : null

/** One tool's rule in the current business. `limits`: the stored limits on top of the defaults (null without any). */
export interface ClaudeToolRule {
  tool: string
  /** The level that applies: the stored one, never above the ceiling (a watch the tool does not allow reads as confirm). */
  level: ClaudeTrust
  /** What the row says (the default `ask` without a row). */
  stored: ClaudeTrust
  ceiling: ClaudeTrust
  limits: Record<string, unknown> | null
  /** The stored limits no longer fit the tool's schema (it changed): nothing runs by rule until they are set again. */
  limitsInvalid?: string
  storedLimits: Record<string, unknown> | null
}

/** Exported for the approvals queue (approval-queue.service.ts), which loads every rule in one query. */
export function ruleFrom(tool: AgentTool, row: { claudeTrust: string; claudeLimits: unknown } | null): ClaudeToolRule {
  const ceiling = trustCeiling(tool)
  const stored: ClaudeTrust = isLevel(row?.claudeTrust) ? row!.claudeTrust as ClaudeTrust : 'ask'
  const storedLimits = row?.claudeLimits && typeof row.claudeLimits === 'object' && !Array.isArray(row.claudeLimits)
    ? (row.claudeLimits as Record<string, unknown>)
    : null
  let limits = defaultsOf(tool)
  let limitsInvalid: string | undefined
  if (tool.limits && storedLimits) {
    const parsed = tool.limits.strict().safeParse(storedLimits)
    if (parsed.success) limits = parsed.data as Record<string, unknown>
    else limitsInvalid = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'limits'}: ${issue.message}`).join('; ')
  }
  return {
    tool: tool.name,
    level: levelAllowed(tool, stored),
    stored,
    ceiling,
    limits,
    ...(limitsInvalid ? { limitsInvalid } : {}),
    storedLimits,
  }
}

/** The rule for one tool in the current business, read fresh (a change of level takes effect at once). */
export async function claudeRuleOf(toolName: string): Promise<ClaudeToolRule | null> {
  const tool = getTool(toolName)
  if (!tool) return null
  const row = await prisma.agentTool.findFirst({ where: { name: toolName }, select: { claudeTrust: true, claudeLimits: true } })
  return ruleFrom(tool, row)
}

/** W1-8 — the ads strategy narrowed one change below the business's own level for its tool. */
export interface StrategyNarrowed extends StrategyNarrowing {
  /** The business's own level for the tool, before the strategy. */
  business: ClaudeTrust
}

/** W1-8 — the rule for ONE change: its tool's rule here, at the strategy's lower level where the change lands. */
export interface ClaudeChangeRule extends ClaudeToolRule {
  narrowedBy?: StrategyNarrowed
}

/** The business's rule for a tool, narrowed (never widened) by the ads strategy for this one change. */
async function narrowed(rule: ClaudeToolRule | null, args: unknown, preview: unknown, memo: StrategyMemo): Promise<ClaudeChangeRule | null> {
  if (!rule || rule.level === 'off') return rule
  const strategy = await strategyLevelFor(rule.tool, args, preview, memo)
  if (!strategy || RANK[strategy.level] >= RANK[rule.level]) return rule
  return { ...rule, level: strategy.level, narrowedBy: { ...strategy, business: rule.level } }
}

/**
 * W1-8 — the rule for one change Claude asks for, read fresh: its tool's level in this business, lowered to the ads
 * strategy's level where the change lands when that is lower. `preview` (after the dry run) places it more exactly.
 */
export async function claudeRuleForChange(toolName: string, args: unknown, preview?: unknown, memo: StrategyMemo = strategyMemo()): Promise<ClaudeChangeRule | null> {
  return narrowed(await claudeRuleOf(toolName), args, preview, memo)
}

/** W1-8 — the rule for each change of a plan, in order: each tool's rule read once, each step narrowed on its own. */
export async function claudeRulesForSteps(steps: Array<{ toolName: string; args?: unknown; preview?: unknown }>): Promise<Array<ClaudeChangeRule | null>> {
  const names = [...new Set(steps.map((step) => step.toolName))]
  const rules = new Map(await Promise.all(names.map(async (name) => [name, await claudeRuleOf(name)] as const)))
  const memo = strategyMemo()
  const out: Array<ClaudeChangeRule | null> = []
  for (const step of steps) out.push(await narrowed(rules.get(step.toolName) ?? null, step.args ?? {}, step.preview, memo))
  return out
}

const ACTION_WORDS: Record<ClaudeActionType, string> = {
  bid: 'bid changes',
  negative: 'negative keywords',
  harvest: 'new exact keywords from search terms',
  placement: 'placement adjustments',
  budget: 'budget changes',
  target: 'target ACoS changes',
  suggestion: 'decisions on rule suggestions',
  stop: 'stopping a campaign with low bids',
  restore: "restoring a campaign's bids",
  create: 'new campaigns',
  rule: 'ads rules',
  undo: 'undoing ad changes',
  allowlist: 'putting a campaign on the live-write allowlist',
  automation: 'turning ads automations up and tuning their settings',
  pause: 'pausing ads (a real pause)',
  enable: 'switching paused ads back on',
  archive: 'archiving ads (for good)',
}
const LEVEL_WORDS: Record<ClaudeTrust, string> = { off: 'off', ask: 'ask', confirm: 'confirm in Claude', watch: 'watch', auto: 'run by rule' }

/**
 * W1-8 — which strategy row narrowed a change, in one clause: what it allows here, the row (market, scope, label,
 * version, the product whose number it is), why it is the strictest row when the change could not be placed exactly,
 * and the business's own level.
 */
export function narrowedWhy(n: StrategyNarrowed): string {
  const what = ACTION_WORDS[n.action]
  const allows = n.level === 'off'
    ? `turns ${what} off for Claude here`
    : n.level === 'ask'
      ? `lets Claude only ask for ${what} here`
      : n.level === 'watch'
        ? `only watches ${what} here (Nexus records whether they would have run by rule; a person decides)`
        : `lets Claude go no further than confirm in Claude for ${what} here`
  const row = `${n.market}: ${n.row.scope} "${n.row.label}", version ${n.row.version}${n.row.product ? `, from ${n.row.product}` : ''}`
  const basis = n.basis === 'scope' ? '' : `; ${n.unplaced}, so the strictest row of ${n.basis === 'market' ? n.market : 'the business'} applies`
  return `the ads strategy ${allows} (${row}${basis}; the business's own level is ${LEVEL_WORDS[n.business]})`
}

/** The tools this business turned off for Claude: not offered, and refused by name. */
export async function claudeOffTools(): Promise<Set<string>> {
  const rows = await prisma.agentTool.findMany({ where: { claudeTrust: 'off' }, select: { name: true } })
  return new Set(rows.map((row) => row.name))
}

export interface Autonomy {
  paused: boolean
  pausedAt: Date | null
  pausedBy: string | null
  reason: string | null
  dailyAutoCap: number
}

/** The business's brakes now; no row = not paused, the default cap. */
export async function autonomyOf(): Promise<Autonomy> {
  const row = await prisma.agentAutonomy.findFirst()
  return {
    paused: !!row?.autoPausedAt,
    pausedAt: row?.autoPausedAt ?? null,
    pausedBy: row?.autoPausedBy ?? null,
    reason: row?.pauseReason ?? null,
    dailyAutoCap: row?.dailyAutoCap ?? DEFAULT_DAILY_AUTO_CAP,
  }
}

/**
 * Changes the business's rules scheduled in the last 24 hours (a handed-back one no longer counts). C6 — each step of
 * a plan run by rule counts as one change.
 */
export async function autoRunsInLastDay(): Promise<number> {
  const since = new Date(Date.now() - AUTO_CAP_WINDOW_MS)
  const [single, steps] = await Promise.all([
    prisma.agentApproval.count({ where: { decisionVia: 'auto', decidedAt: { gte: since }, toolName: { not: PLAN_TOOL } } }),
    prisma.agentPlanStep.count({ where: { approval: { decisionVia: 'auto', decidedAt: { gte: since } } } }),
  ])
  return single + steps
}

const CONFIRM_HOW = 'the person who asked types their authenticator code to approve it here (confirm-change), or a person approves it in Nexus'
/** C7 — a change set to confirm: the person who asked confirms it in Claude with their code, or a person in Nexus. */
export const CONFIRM_IN_CLAUDE = `this business set it to "confirm in Claude": ${CONFIRM_HOW}`

const A_PERSON = 'a person approves it in Nexus'
/**
 * AA-W2-3 — one ending, where the person decides: a limit's sentence that already ends "a person decides" (the ads kit's,
 * and some tools' own) says it once, as "a person approves it in Nexus", instead of both one after the other.
 */
export function inNexusEnding(sentence: string): string {
  return `${sentence.replace(/[;:] a person decides\.?$/, '')}; ${A_PERSON}`
}

/** W1-8 — why a change the strategy narrowed waits for a person: at ask (or off), or at confirm (AA-W2-4: or watch). */
export function narrowedDecision(n: StrategyNarrowed): string {
  return n.level === 'confirm' || n.level === 'watch' ? `${narrowedWhy(n)}, so ${CONFIRM_HOW}` : `${narrowedWhy(n)}; ${A_PERSON}`
}

const NO_RUN_SCOPE = 'this Claude connection may not run changes by rule (it was connected without nexus.run, "run the changes set to run by rule")'
const pausedWhy = (autonomy: Autonomy) => `changes that run by rule are paused in this business${autonomy.reason ? ` (${autonomy.reason})` : ''}`

/** What keeps a change from running by rule — which check, why — and the words that join who decides instead. */
interface RuleHold {
  check: RuleCheck
  why: string
  then: string
}
const asRefusal = (hold: RuleHold) => (hold.then === '; ' ? inNexusEnding(hold.why) : `${hold.why}${hold.then}${A_PERSON}`)
/** A limit's sentence for a watch verdict: what holds it, without who decides (at watch a person always does). */
const bare = (why: string) => why.replace(/[;:] a person decides\.?$/, '')

/** Why the tool's limits keep a change from running by rule, or null when it is inside them. */
function limitsOutside(tool: AgentTool, preview: unknown, rule: ClaudeToolRule): RuleHold | null {
  if (!tool.withinLimits || !rule.limits) return { check: 'limits', why: `${tool.name} has no limits to run inside`, then: '; ' }
  if (rule.limitsInvalid) return { check: 'limits', why: `the limits saved for ${tool.name} no longer fit it (${rule.limitsInvalid}); set them again`, then: '. Until then ' }
  const outside = tool.withinLimits(preview, rule.limits)
  return outside ? { check: 'limits', why: outside, then: '; ' } : null
}

/**
 * The first of auto's checks that keeps a change from running by the rule now, or null: the connection's nexus.run
 * scope, the business's Pause, the tool's limits, the daily cap. AA-W2-4 — `watching`: the cap also counts the watched
 * changes that would have run, as if their kinds were at auto.
 */
async function ruleHold(tool: AgentTool, preview: unknown, opts: { runScope: boolean; rule: ClaudeToolRule; watching?: boolean }): Promise<RuleHold | null> {
  if (!opts.runScope) return { check: 'scope', why: NO_RUN_SCOPE, then: '; ' }
  const autonomy = await autonomyOf()
  if (autonomy.paused) return { check: 'pause', why: pausedWhy(autonomy), then: '; ' }
  const outside = limitsOutside(tool, preview, opts.rule)
  if (outside) return outside
  const used = await autoRunsInLastDay() + (opts.watching ? await watchedRunsInLastDay() : 0)
  if (used >= autonomy.dailyAutoCap) {
    return { check: 'cap', why: `this business's limit of ${autonomy.dailyAutoCap} changes run by rule in 24 hours is reached`, then: '; ' }
  }
  return null
}

/**
 * Why a change Claude asked for, at level auto, may NOT run by the rule now — or null when it may. In this order: the
 * connection's nexus.run scope, the business's Pause, the tool's limits, the daily cap.
 */
export async function autoRefusal(tool: AgentTool, preview: unknown, opts: { runScope: boolean; rule: ClaudeToolRule }): Promise<string | null> {
  const hold = await ruleHold(tool, preview, opts)
  return hold ? asRefusal(hold) : null
}

function limitsRefusal(tool: AgentTool, preview: unknown, rule: ClaudeToolRule): string | null {
  const outside = limitsOutside(tool, preview, rule)
  return outside ? asRefusal(outside) : null
}

// ── AA-W2-4 — the watch level ─────────────────────────────────────────────────────────────────────

/** Is this change watched: the business set its kind to watch, or the ads strategy holds it at watch where it lands? */
export function isWatched(rule: ClaudeChangeRule | null | undefined): boolean {
  return !!rule && (rule.level === 'watch' || rule.narrowedBy?.business === 'watch')
}

/**
 * The watched changes of the last 24 hours their verdict says would have run by rule (each step of a plan counts): what
 * the daily cap would also have counted, had their kinds been at auto. Read only by a watch verdict.
 */
export async function watchedRunsInLastDay(): Promise<number> {
  const since = new Date(Date.now() - AUTO_CAP_WINDOW_MS)
  const wouldRun = { path: ['wouldRun'], equals: true }
  const [single, steps] = await Promise.all([
    prisma.agentApproval.count({ where: { requestedAt: { gte: since }, toolName: { not: PLAN_TOOL }, ruleVerdict: wouldRun } }),
    prisma.agentPlanStep.count({ where: { approval: { requestedAt: { gte: since }, ruleVerdict: wouldRun } } }),
  ])
  return single + steps
}

const strategyOf = (n: StrategyNarrowed): NonNullable<WatchVerdict['strategy']> =>
  ({ market: n.market, scope: n.row.scope, label: n.row.label, version: n.row.version, level: n.level })

/** A step (or change) below watch where it lands: which check held it (the ads strategy, or its own level) and why. */
function levelHold(rule: ClaudeChangeRule | null | undefined): Pick<WatchStepVerdict, 'check' | 'why'> {
  if (rule?.narrowedBy) return { check: 'strategy', why: narrowedWhy(rule.narrowedBy) }
  return { check: 'level', why: rule?.level === 'confirm' ? 'it is set to confirm in Claude' : 'it waits for a person (ask)' }
}

const RULE_COULD_NOT = 'Nexus could not apply the business’s rule to it'

/** Does a preview carry the ads autonomy kit's limit facts (a strategy-bound ad tool's)? Its version is the kit's to judge. */
const hasLimitFacts = (preview: unknown) => !!preview && typeof preview === 'object' && 'limitFacts' in preview

/**
 * The ledger of the watched changes of the last 24 hours that would have run by rule (a plan's steps only when the
 * whole plan would have): what the strategy's daily limits would also have counted, had their kinds been at auto.
 */
async function watchedRunLedger(): Promise<RuleRunLedger> {
  const since = new Date(Date.now() - AUTO_CAP_WINDOW_MS)
  const wouldRun = { path: ['wouldRun'], equals: true }
  const [single, steps] = await Promise.all([
    prisma.agentApproval.findMany({ where: { requestedAt: { gte: since }, toolName: { not: PLAN_TOOL }, ruleVerdict: wouldRun }, select: { preview: true } }),
    prisma.agentPlanStep.findMany({ where: { approval: { requestedAt: { gte: since }, ruleVerdict: wouldRun } }, select: { preview: true } }),
  ])
  return ledgerOf([...single, ...steps].map((row) => row.preview))
}

/**
 * Previews as the watch level judges them (ads autonomy kit `asWatched`): today's ad counts also hold the watched
 * changes that would have run, and a watch the ads strategy set reads as auto when it is what holds the change at
 * watch. Read only for previews that carry limit facts; the others come back as they are.
 */
async function watchJudged(previews: unknown[], strategyWatchAsAuto: boolean): Promise<unknown[]> {
  if (!previews.some(hasLimitFacts)) return previews
  const watched = await watchedRunLedger()
  return previews.map((preview) => asWatched(preview, { watched, strategyWatchAsAuto }))
}

/** Two ledgers of the same 24 hours added up: what ran by rule, and the watched changes that would have. */
function addLedgers(a: RuleRunLedger, b: RuleRunLedger): RuleRunLedger {
  const out: RuleRunLedger = { byMarket: {}, byEntity: { ...a.byEntity }, runs: a.runs + b.runs }
  for (const [market, day] of [...Object.entries(a.byMarket), ...Object.entries(b.byMarket)]) {
    const sum = (out.byMarket[market] ??= { changes: 0, writes: 0, raises: 0, budgetIncreaseCents: 0 })
    sum.changes += day.changes
    sum.writes += day.writes
    sum.raises += day.raises
    sum.budgetIncreaseCents += day.budgetIncreaseCents
  }
  for (const [entity, runs] of Object.entries(b.byEntity)) out.byEntity[entity] = (out.byEntity[entity] ?? 0) + runs
  return out
}

/**
 * The verdict of the business's rule on one watched change, exactly as auto would judge it: the level where it lands
 * (the ads strategy may hold it lower), then nexus.run, Pause, the tool's limits and the daily cap (counting the watched
 * changes that would have run). Schedules nothing. A check that throws is held as `error`: auto leaves such a change
 * with a person too.
 */
export async function watchVerdictOf(tool: AgentTool, preview: unknown, opts: { runScope: boolean; rule: ClaudeChangeRule }): Promise<WatchVerdict> {
  const { rule } = opts
  const base = { level: rule.level, checkedAt: new Date().toISOString(), changes: 1, ...(rule.narrowedBy ? { strategy: strategyOf(rule.narrowedBy) } : {}) }
  if (rule.level !== 'watch') return { ...base, wouldRun: false, ...levelHold(rule) }
  try {
    const judged = await watchJudged([preview], rule.narrowedBy?.level === 'watch')
    const hold = await ruleHold(tool, judged[0], { runScope: opts.runScope, rule, watching: true })
    return hold ? { ...base, wouldRun: false, check: hold.check, why: bare(hold.why) } : { ...base, wouldRun: true, check: null, why: null }
  } catch (error) {
    logger.error('[claude-trust] the watch check failed', { tool: tool.name, error: error instanceof Error ? error.message : String(error) })
    return { ...base, wouldRun: false, check: 'error', why: RULE_COULD_NOT }
  }
}

/**
 * A watched plan: each step's own verdict — its level where it lands, its limits — and the business's brakes of the
 * moment (nexus.run, Pause, the ad steps together within the strategy's daily limits, the daily cap for all its steps);
 * the plan would have run only when every step would. The plan's own check and words follow planRuleRefusal's order: a
 * step's level, nexus.run, Pause, a step's limits, the ad steps together, the cap.
 */
async function planWatchVerdict(
  steps: Array<{ tool: AgentTool; preview: unknown }>,
  rules: Array<ClaudeChangeRule | null>,
  lowest: { level: ClaudeTrust; index: number } | null,
  opts: { runScope: boolean },
): Promise<WatchVerdict> {
  const deciding = lowest ? rules[lowest.index] : null
  const base = {
    level: lowest?.level ?? 'auto',
    checkedAt: new Date().toISOString(),
    changes: steps.length,
    ...(deciding?.narrowedBy ? { strategy: strategyOf(deciding.narrowedBy) } : {}),
  }
  const stepOf = (index: number, verdict: Pick<WatchStepVerdict, 'wouldRun' | 'check' | 'why'>): WatchStepVerdict => ({
    step: index + 1,
    tool: steps[index].tool.name,
    level: rules[index]?.level ?? 'ask',
    watched: isWatched(rules[index]),
    ...verdict,
  })
  try {
    const autonomy = await autonomyOf()
    const shared: RuleHold | null = !opts.runScope
      ? { check: 'scope', why: NO_RUN_SCOPE, then: '' }
      : autonomy.paused ? { check: 'pause', why: pausedWhy(autonomy), then: '' } : null
    // Each step's preview as watch judges it: today's ad counts with the watched changes that would have run.
    const judged = await watchJudged(steps.map((step) => step.preview), steps.some((_step, index) => rules[index]?.narrowedBy?.level === 'watch'))
    const own = steps.map((step, index) => {
      const level = rules[index]?.level ?? 'ask'
      if (level !== 'watch' && level !== 'auto') return { wouldRun: false, ...levelHold(rules[index]) }
      if (shared) return { wouldRun: false, check: shared.check, why: shared.why }
      const outside = limitsOutside(step.tool, judged[index], rules[index]!)
      return outside ? { wouldRun: false, check: 'limits' as const, why: bare(outside.why) } : { wouldRun: true, check: null, why: null }
    })
    // The ad steps together within the strategy's daily limits, as auto judges a plan (AA-W2-3 `planDailyRefusal`), on
    // what ran by rule plus the watched changes that would have: when they pass them, none runs.
    const bound = steps.map((step, index) => ({ tool: step.tool, preview: judged[index] }))
    const together = own.some((verdict) => verdict.wouldRun) && bound.some((step) => step.tool.strategyBound)
      ? planDailyRefusal(bound, addLedgers(await ruleRunLedger(), await watchedRunLedger()))
      : null
    // The cap counts every step of a plan: when the plan would pass it, no step runs.
    let capWhy: string | null = null
    if (own.some((verdict) => verdict.wouldRun)) {
      const used = await autoRunsInLastDay() + await watchedRunsInLastDay()
      if (used + steps.length > autonomy.dailyAutoCap) {
        capWhy = `its ${plural(steps.length, 'change')} would pass this business's limit of ${autonomy.dailyAutoCap} changes run by rule in 24 hours (${used} already, counting the watched changes that would have run)`
      }
    }
    const verdicts = own.map((verdict, index) => stepOf(index, !verdict.wouldRun ? verdict
      : together && steps[index].tool.strategyBound ? { wouldRun: false, check: 'limits', why: bare(together) }
        : capWhy ? { wouldRun: false, check: 'cap', why: capWhy } : verdict))
    const firstOutside = own.findIndex((verdict) => verdict.check === 'limits')
    const plan: Pick<WatchVerdict, 'wouldRun' | 'check' | 'why'> = lowest && lowest.level !== 'watch'
      ? { wouldRun: false, ...planLevelHold(steps, rules, lowest) }
      : shared ? { wouldRun: false, check: shared.check, why: shared.why }
        : firstOutside >= 0 ? { wouldRun: false, check: 'limits', why: `step ${firstOutside + 1} (${steps[firstOutside].tool.name}): ${own[firstOutside].why}` }
          : together ? { wouldRun: false, check: 'limits', why: bare(together) }
            : capWhy ? { wouldRun: false, check: 'cap', why: capWhy }
              : { wouldRun: true, check: null, why: null }
    return { ...base, ...plan, steps: verdicts }
  } catch (error) {
    logger.error('[claude-trust] the watch check of a plan failed', { error: error instanceof Error ? error.message : String(error) })
    return { ...base, wouldRun: false, check: 'error', why: RULE_COULD_NOT, steps: steps.map((_step, index) => stepOf(index, { wouldRun: false, check: 'error', why: RULE_COULD_NOT })) }
  }
}

/** A plan held below watch by one step: the step that decides, in the words planRuleRefusal tells Claude (without who decides). */
function planLevelHold(
  steps: Array<{ tool: AgentTool }>,
  rules: Array<ClaudeChangeRule | null>,
  lowest: { level: ClaudeTrust; index: number },
): Pick<WatchVerdict, 'check' | 'why'> {
  const named = `step ${lowest.index + 1} (${steps[lowest.index].tool.name})`
  const strategy = rules[lowest.index]?.narrowedBy
  if (strategy) return { check: 'strategy', why: `a plan runs by rule only when every step may: ${named}: ${narrowedWhy(strategy)}` }
  return { check: 'level', why: `a plan runs by rule only when every step may: ${named} ${lowest.level === 'confirm' ? 'is set to confirm in Claude' : 'waits for a person'}` }
}

/** What Claude is told about a watched change: what the rule would have done, then who decides (as at confirm). */
export function watchWords(verdict: WatchVerdict, opts: { runScope: boolean }): string {
  const would = verdict.wouldRun ? 'watching: it would have run by rule' : `watching: it would not — ${verdict.why}`
  return `${would}; ${opts.runScope ? CONFIRM_HOW : A_PERSON}`
}

/** Record a watched request's verdict on it (AgentApproval.ruleVerdict). */
export async function recordWatch(approvalId: string, verdict: WatchVerdict): Promise<WatchVerdict> {
  await prisma.agentApproval.update({ where: { id: approvalId }, data: { ruleVerdict: verdict as unknown as Prisma.InputJsonValue } })
  return verdict
}

/**
 * C6 — why a plan may NOT run by the business's rule — or null when it may: every step's tool at auto, the connection's
 * nexus.run, no Pause, every step inside its tool's limits (AA-W2-4: and its ad steps together inside the ads
 * strategy's daily limits), and room under the daily cap for all its steps. `level` is
 * the lowest step's (ask when one waits for a person); `why` is absent only when every step is simply at ask. W1-8 —
 * each step at its own level where it lands (the ads strategy narrows an ad step); `strategy` names the row that
 * narrowed the step that decides. AA-W2-4 — a plan with a watched step carries `watch`, the verdict to record (per
 * step and for the plan); with every step at watch or auto its level is `watch` and nothing runs by rule.
 */
export async function planRuleRefusal(
  steps: Array<{ tool: AgentTool; preview: unknown; args?: Record<string, unknown> }>,
  opts: { runScope: boolean },
): Promise<{ level: ClaudeTrust; why?: string; strategy?: StrategyNarrowed; watch?: WatchVerdict } | null> {
  const rules = await claudeRulesForSteps(steps.map((step) => ({ toolName: step.tool.name, args: step.args, preview: step.preview })))
  const levelOf = (index: number): ClaudeTrust => rules[index]?.level ?? 'ask'
  let found: { level: ClaudeTrust; index: number } | null = null
  steps.forEach((_step, index) => {
    const level = levelOf(index)
    if (level !== 'auto' && (!found || RANK[level] < RANK[found.level])) found = { level, index }
  })
  const lowest = found as { level: ClaudeTrust; index: number } | null
  // AA-W2-4 — a plan with a watched step: the full check, per step and for the plan (the door records it).
  const watch = steps.some((_step, index) => isWatched(rules[index])) ? await planWatchVerdict(steps, rules, lowest, opts) : undefined
  const watched = watch ? { watch } : {}
  if (lowest && lowest.level !== 'watch') {
    const { level, index } = lowest
    const every = steps.every((_step, i) => levelOf(i) === level)
    const named = `step ${index + 1} (${steps[index].tool.name})`
    const strategy = rules[index]?.narrowedBy
    if (strategy) {
      const why = `${every ? '' : 'a plan runs by rule only when every step may: '}${named}: ${narrowedDecision(strategy)}`
      return { level: level === 'confirm' ? 'confirm' : 'ask', why, strategy, ...watched }
    }
    if (level === 'confirm') {
      return { level, why: every ? CONFIRM_IN_CLAUDE : `a plan runs by rule only when every step may: ${named} is set to confirm in Claude, so ${CONFIRM_HOW}`, ...watched }
    }
    return every ? { level: 'ask', ...watched } : { level: 'ask', why: `a plan runs by rule only when every step may: ${named} waits for a person`, ...watched }
  }
  if (lowest) {
    // AA-W2-4 — every step at watch or auto: nothing runs by rule; the verdict says whether it would have.
    const strategy = rules[lowest.index]?.narrowedBy
    return { level: 'watch', why: watchWords(watch!, opts), ...(strategy ? { strategy } : {}), watch: watch! }
  }
  if (!opts.runScope) {
    return { level: 'auto', why: `this Claude connection may not run changes by rule (it was connected without nexus.run, "run the changes set to run by rule"); ${A_PERSON}` }
  }
  const autonomy = await autonomyOf()
  if (autonomy.paused) return { level: 'auto', why: `changes that run by rule are paused in this business${autonomy.reason ? ` (${autonomy.reason})` : ''}; ${A_PERSON}` }
  for (const [index, step] of steps.entries()) {
    const outside = limitsRefusal(step.tool, step.preview, rules[index]!)
    if (outside) return { level: 'auto', why: `step ${index + 1} (${step.tool.name}): ${outside}` }
  }
  // AA-W2-3 — each ad step inside the strategy's daily limits alone is not enough: the steps count together.
  if (steps.some((step) => step.tool.strategyBound)) {
    const together = planDailyRefusal(steps, await ruleRunLedger())
    if (together) return { level: 'auto', why: inNexusEnding(together) }
  }
  const used = await autoRunsInLastDay()
  if (used + steps.length > autonomy.dailyAutoCap) {
    return {
      level: 'auto',
      why: `its ${plural(steps.length, 'change')} would pass this business's limit of ${autonomy.dailyAutoCap} changes run by rule in 24 hours (${used} already); ${A_PERSON}`,
    }
  }
  return null
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * C6 — at commit, for a plan the rule scheduled: the Pause, and every step's level and limits, as for one change.
 * AA-W2-3 — and its ad steps together inside the strategy's daily limits, against what ran by rule since it was asked
 * for (this plan left out). Each step is judged again on its fresh dry run when the worker runs it.
 */
export async function autoPlanCommitRefusal(approvalId: string): Promise<string | null> {
  const autonomy = await autonomyOf()
  if (autonomy.paused) return 'changes that run by rule were paused in this business before it ran'
  const steps = await prisma.agentPlanStep.findMany({ where: { approvalId }, orderBy: { position: 'asc' }, select: { position: true, toolName: true, preview: true, args: true } })
  for (const step of steps) {
    const refusal = await autoPlanStepRefusal(step.toolName, step.preview, step.args)
    if (refusal) return `step ${step.position}: ${refusal}`
  }
  const judged = steps.map((step) => ({ tool: getTool(step.toolName), preview: step.preview }))
  if (judged.some((step) => step.tool?.strategyBound)) {
    const together = planDailyRefusal(judged, await ruleRunLedger({ excludeApprovalId: approvalId }))
    if (together) return `it is no longer inside the business's limits: ${inNexusEnding(together)}`
  }
  return null
}

/** The tighter of two daily limits (null: not set); the source is the one that gave it. */
function tighterDaily(a: MarketFacts, b: MarketFacts): MarketFacts {
  const out: MarketFacts = { ...a, sources: { ...a.sources } }
  for (const key of ['maxChangesPerDay', 'maxRaisesPerDay', 'maxBudgetIncreasePerDayCents'] as const) {
    if (b[key] != null && (out[key] == null || b[key]! < out[key]!)) {
      out[key] = b[key]
      const source = DAILY_SOURCE[key]
      if (b.sources[source]) out.sources[source] = b.sources[source]
      else delete out.sources[source]
    }
  }
  if (!b.strategy) out.strategy = null
  return out
}

/**
 * AA-W2-3 — a plan's strategy-bound steps judged against the ads strategy's daily limits (C5) TOGETHER: what ran by
 * rule in the last 24 hours (`ledger`, without this plan) plus every such step, summed per market from the `this` block
 * each step's preview stored (the kit's `ledgerOf`), within the tightest daily limit any step's facts carry there. Each
 * step may be inside alone while the plan is not. Null when inside, or when no step carries limit facts (each step's
 * own limits refuse that). Pure.
 */
export function planDailyRefusal(steps: ReadonlyArray<{ tool?: Pick<AgentTool, 'strategyBound'> | null; preview: unknown }>, ledger: RuleRunLedger): string | null {
  const bound = steps.filter((step) => step.tool?.strategyBound).map((step) => step.preview)
  const facts = bound.map(limitFactsOf).filter((f): f is LimitFacts => !!f)
  if (!facts.length) return null
  const plan = ledgerOf(bound)
  const markets = Object.keys(plan.byMarket).sort()
  const limits: Record<string, MarketFacts> = {}
  for (const f of facts) {
    for (const market of markets) {
      const m = f.markets[market]
      if (m) limits[market] = limits[market] ? tighterDaily(limits[market], m) : m
    }
  }
  const zero = { changes: 0, writes: 0, raises: 0, budgetIncreaseCents: 0 }
  const together: LimitFacts = {
    ...facts[0],
    markets: limits,
    this: { ...facts[0].this, markets, byMarket: Object.fromEntries(markets.map((m) => [m, { ...plan.byMarket[m], items: 0, addedDailyCents: 0 }])) },
    today: Object.fromEntries(markets.map((m) => [m, ledger.byMarket[m] ?? zero])),
  }
  const why = dailyRefusal(together)
  return why ? `the plan's ad steps together — ${why}` : null
}

/** C6 — one step of a plan run by rule, when it runs: still allowed by the rule (as `autoCommitRefusal`)? */
export async function autoPlanStepRefusal(toolName: string, preview: unknown, args?: unknown): Promise<string | null> {
  return autoCommitRefusal(toolName, preview, args)
}

/** After a rule scheduled a change: over the daily cap now (two at once)? Then the one just scheduled must not run. */
export async function overDailyCap(): Promise<string | null> {
  const [autonomy, used] = await Promise.all([autonomyOf(), autoRunsInLastDay()])
  return used > autonomy.dailyAutoCap
    ? `this business's limit of ${autonomy.dailyAutoCap} changes run by rule in 24 hours was reached at the same moment; ${A_PERSON}`
    : null
}

/** Back to a person: a change a rule scheduled that must not run by rule after all. */
async function handToPerson(where: Prisma.AgentApprovalWhereInput, why: string, db: Pick<typeof prisma, 'agentApproval'> = prisma): Promise<number> {
  const handed = await db.agentApproval.updateMany({
    where: { ...where, status: 'scheduled', decisionVia: 'auto' },
    data: {
      status: 'pending',
      decidedBy: null,
      decidedByUserId: null,
      decidedAt: null,
      executeAfter: null,
      decisionVia: null,
      reason: `not run by rule — ${why}`,
      expiresAt: new Date(Date.now() + EXPIRY_HOURS * 3600 * 1000),
    },
  })
  return handed.count
}

/** Undo a rule's schedule the moment it was made (the daily cap was crossed at the same time). */
export async function withdrawRuleSchedule(approvalId: string, why: string): Promise<void> {
  await handToPerson({ id: approvalId }, why)
}

/**
 * At commit, for a change a rule scheduled: why it must go back to a person instead of running — the business paused
 * Claude's rule-runs, lowered the tool's level or tightened its limits inside the window, or (W1-8) the ads strategy
 * now narrows it where it lands — or null.
 */
export async function autoCommitRefusal(toolName: string, preview: unknown, args?: unknown): Promise<string | null> {
  const autonomy = await autonomyOf()
  if (autonomy.paused) return 'changes that run by rule were paused in this business before it ran'
  const tool = getTool(toolName)
  const rule = tool ? await claudeRuleForChange(toolName, args ?? {}, preview) : null
  if (rule?.narrowedBy) return narrowedWhy(rule.narrowedBy)
  if (!tool || !rule || rule.level !== 'auto') return `the business no longer lets Claude run ${toolName} by rule`
  const outside = limitsRefusal(tool, preview, rule)
  return outside ? `it is no longer inside the business's limits: ${outside}` : null
}

/**
 * ADS AUTONOMY AA-W2-3 — at commit, for a strategy-bound change the rule scheduled (one change, or a step of a plan):
 * the same check as `autoCommitRefusal`, on the FRESH dry run the staleness check just made instead of the preview
 * stored when Claude asked — the ads strategy, its narrowing where the change lands (W1-8) and the day's counts as they
 * are when it runs. Null when it may still run, and for a tool that is not strategy-bound (its stored preview was
 * judged; the staleness check compares the rest). The strategy's version is deliberately not a material preview field:
 * a strategy edit would then make every request a person approved stale, and count towards the automatic pause.
 */
export async function autoFreshRefusal(toolName: string, freshPreview: unknown, args?: unknown): Promise<string | null> {
  if (!getTool(toolName)?.strategyBound) return null
  const refusal = await autoCommitRefusal(toolName, freshPreview, args)
  return refusal ? `judged again on a fresh dry run: ${refusal}` : null
}

/**
 * A rule-run was stale or failed (approval-inbox.service.ts wrote its audit row first). After AUTO_PAUSE_FAILURES in
 * AUTO_PAUSE_WINDOW_MS, Nexus pauses Claude's rule-runs in this business itself. Never throws.
 */
export async function noteAutoFailure(): Promise<void> {
  try {
    const failures = await prisma.agentControlAudit.count({
      where: {
        charterKey: CLAUDE_CHARTER,
        action: { in: FAILED_RUN_ACTIONS },
        createdAt: { gte: new Date(Date.now() - AUTO_PAUSE_WINDOW_MS) },
        toValue: { path: ['decisionVia'], equals: 'auto' },
      },
    })
    if (failures < AUTO_PAUSE_FAILURES) return
    if ((await autonomyOf()).paused) return
    await pauseAutoRuns(
      { userId: '', label: AUTO_PAUSED_BY, canManage: false },
      `${failures} changes run by rule were stale or failed within an hour`,
      { automatic: true, failures },
    )
  } catch (error) {
    logger.error('[claude-trust] could not check for an automatic pause', { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Pause every change that runs by rule in this business, at once: new ones wait for a person, and those waiting out
 * their undo window go back to a person. No 2FA code: stopping is never harder than going. Idempotent.
 */
export async function pauseAutoRuns(
  actor: Pick<TrustActor, 'label'> & Partial<TrustActor>,
  reason?: string | null,
  opts: { automatic?: boolean; failures?: number } = {},
): Promise<{ ok: true; paused: true; handedBack: number; alreadyPaused: boolean }> {
  const now = await autonomyOf()
  const why = (reason ?? '').trim().slice(0, 500) || null
  // The pause, what it hands back and its event (C8: agent.autorun.paused, once per pause), in one transaction.
  const handedBack = await prisma.$transaction(async (tx) => {
    const row = now.paused
      ? null
      : await tx.agentAutonomy.upsert({
          where: { workspaceId: workspaceIdForQuery() },
          create: { autoPausedAt: new Date(), autoPausedBy: actor.label, pauseReason: why, updatedBy: actor.label },
          update: { autoPausedAt: new Date(), autoPausedBy: actor.label, pauseReason: why, updatedBy: actor.label },
          select: { id: true },
        })
    const count = await handToPerson({}, 'changes that run by rule were paused in this business', tx)
    if (row) {
      await publishEvent(tx, 'agent.autorun.paused', {
        autonomyId: row.id,
        automatic: !!opts.automatic,
        failures: opts.automatic ? (opts.failures ?? null) : null,
        handedBack: count,
      })
    }
    return count
  })
  await recordControlChange({
    charterKey: CLAUDE_CHARTER,
    action: 'pause',
    from: { paused: now.paused },
    to: { paused: true, handedBack, ...(opts.automatic ? { automatic: true, failures: opts.failures ?? null } : {}) },
    note: why,
    actor: actor.label,
  })
  return { ok: true, paused: true, handedBack, alreadyPaused: now.paused }
}

/** Lift the pause: changes may run by rule again. Takes a fresh 2FA code. */
export async function resumeAutoRuns(actor: TrustActor, code: unknown): Promise<{ ok: true; paused: false } | TrustRefusal> {
  const now = await autonomyOf()
  if (!now.paused) return { ok: true, paused: false }
  const refused = await mayRaise(actor, code)
  if (refused) return refused
  await prisma.agentAutonomy.update({
    where: { workspaceId: workspaceIdForQuery() },
    data: { autoPausedAt: null, autoPausedBy: null, pauseReason: null, updatedBy: actor.label },
  })
  await recordControlChange({
    charterKey: CLAUDE_CHARTER,
    action: 'resume',
    from: { paused: true, pausedBy: now.pausedBy, reason: now.reason },
    to: { paused: false },
    actor: actor.label,
  })
  return { ok: true, paused: false }
}

/** The person's fresh 2FA code, once (lib/auth/step-up.ts: single use, lockout after wrong codes). */
async function stepUp(userId: string, code: unknown, sentence: RaiseWords): Promise<TrustRefusal | null> {
  const user = userId
    ? await prisma.userProfile.findUnique({ where: { id: userId }, select: { twoFactorEnabledAt: true, twoFactorSecret: true } })
    : null
  if (!user?.twoFactorEnabledAt || !user.twoFactorSecret) {
    return { ok: false, status: 403, code: 'mfa_not_enrolled', error: `Turn on two-factor authentication before ${sentence.before}.` }
  }
  if (typeof code !== 'string' || !code.trim()) {
    return { ok: false, status: 403, code: 'mfa_required', error: `${sentence.act} needs the 6-digit code from your authenticator app.` }
  }
  const verdict = await verifyStepUpCode(userId, user.twoFactorSecret, code.trim())
  if (verdict === 'locked') return { ok: false, status: 429, code: 'mfa_locked', error: 'Too many wrong codes. Try again in 15 minutes.' }
  if (verdict === 'reused') return { ok: false, status: 400, code: 'mfa_invalid', error: 'That code was already used. Wait for the next one.' }
  if (verdict !== 'ok') return { ok: false, status: 400, code: 'mfa_invalid', error: 'That code is not right. Check your authenticator app.' }
  return null
}

/**
 * Does going from `before` to `after` only TIGHTEN a tool's limits (or leave them as they are)? By the limits
 * convention (tool-types.ts `limits`): a `max…` number lower, a `min…` number higher, an `allow…` switch off, a `max…`
 * choice earlier in its own list, a list of what is allowed with nothing added. Any other change — or a limit whose
 * direction the convention does not say — counts as loosening: it asks for settings.security.manage and the code.
 */
export function limitsTighten(tool: Pick<AgentTool, 'limits'>, before: Record<string, unknown> | null, after: Record<string, unknown> | null): boolean {
  const b = before ?? {}
  const a = after ?? {}
  const shape = (tool.limits?.shape ?? {}) as Record<string, unknown>
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const from = b[key]
    const to = a[key]
    if (canonical(from) === canonical(to)) continue
    if (typeof from === 'number' && typeof to === 'number') {
      if (/^max/.test(key) && to < from) continue
      if (/^min/.test(key) && to > from) continue
      return false
    }
    if (typeof from === 'boolean' && typeof to === 'boolean') {
      if (/^allow/.test(key) && from && !to) continue
      return false
    }
    if (typeof from === 'string' && typeof to === 'string' && /^max/.test(key)) {
      const order = enumOptions(shape[key])
      if (order && order.includes(from) && order.includes(to) && order.indexOf(to) < order.indexOf(from)) continue
      return false
    }
    if (Array.isArray(from) && Array.isArray(to)) {
      const allowed = new Set(from.map((item) => canonical(item)))
      if (to.every((item) => allowed.has(canonical(item)))) continue
      return false
    }
    return false
  }
  return true
}

/** The options of a zod enum, in order, through optional/default wrappers; null for anything else. */
function enumOptions(node: unknown): string[] | null {
  let current = node as { _zod?: { def?: { type?: string; innerType?: unknown; entries?: Record<string, string> } } } | undefined
  for (let i = 0; i < 5 && current?._zod?.def; i++) {
    const def = current._zod.def
    if (def.type === 'enum' && def.entries) return Object.values(def.entries)
    current = def.innerType as typeof current
  }
  return null
}

/** One text per value whatever the order of its keys, to tell whether limits changed. */
function canonical(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v
  return JSON.stringify(sorted(value ?? null))
}

/** Why this tool may not be set to `level` (one it does not list in `levelsFor`), in the words a person reads. */
export function levelNotAllowed(tool: AgentTool, level: ClaudeTrust): string {
  if (tool.readOnly || tool.control) return `${tool.name} can only be offered to Claude (ask) or not (off).`
  const ceiling = trustCeiling(tool)
  // AA-W2-4 — watch measures what auto would do: a kind that may never run by rule, or a brake, has nothing to watch.
  if (level === 'watch' && RANK[ceiling] >= RANK.watch) return `${tool.name} cannot be watched: it is a brake, so it runs by rule or waits for a person.`
  if (level === 'watch') return `${tool.name} cannot be watched: only a kind that may run by rule (auto) can be.`
  return `${tool.name} can be set to ${ceiling} at most: ${ceiling === 'ask' ? 'a person always approves it' : 'that is the most it may do without a person'}.`
}

export interface RulePatch {
  level?: unknown
  /** The tool's limits, or null for its code defaults. */
  limits?: unknown
  code?: unknown
}

/**
 * Set one tool's level and/or limits in this business. A level is refused above the tool's ceiling (floors cannot be
 * raised); limits are checked against the tool's own schema (unknown keys refused). Raising the level, or any change
 * of limits, needs a fresh 2FA code; lowering does not. For a tool that cannot be undone, raising the level and
 * loosening the limits are two calls, so two codes (AA-W2-13). Audited.
 */
export async function setClaudeRule(actor: TrustActor, toolName: string, patch: RulePatch): Promise<{ ok: true; rule: ClaudeToolRule } | TrustRefusal> {
  const tool = getTool(toolName)
  if (!tool || !offeredOn(tool, 'mcp')) return { ok: false, status: 404, error: `${toolName} is not a tool Claude is offered.` }
  const current = (await claudeRuleOf(toolName))!
  const levels = levelsFor(tool)

  let level = current.stored
  if (patch.level !== undefined) {
    if (!isLevel(patch.level)) return { ok: false, status: 400, error: `level must be one of ${CLAUDE_TRUST_LEVELS.join(', ')}.` }
    if (!levels.includes(patch.level)) return { ok: false, status: 400, error: levelNotAllowed(tool, patch.level) }
    level = patch.level
  }

  let limits = current.storedLimits
  if (patch.limits !== undefined) {
    if (patch.limits === null) limits = null
    else {
      if (!tool.limits) return { ok: false, status: 400, error: `${toolName} has no limits to set.` }
      const parsed = tool.limits.strict().safeParse(patch.limits)
      if (!parsed.success) {
        return { ok: false, status: 400, error: `Limits for ${toolName}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'limits'} — ${i.message}`).join('; ')}.` }
      }
      limits = parsed.data as Record<string, unknown>
    }
  }

  const raising = RANK[lower(level, current.ceiling)] > RANK[current.level]
  const limitsChanged = canonical(limits) !== canonical(current.storedLimits)
  if (!raising && !limitsChanged && level === current.stored) return { ok: true, rule: current }
  // Tightening limits is a brake, like lowering a level; loosening them lets Claude do more, like raising one.
  const defaults = defaultsOf(tool)
  const loosening = limitsChanged && !limitsTighten(tool, current.limits ?? defaults, limits ? { ...defaults, ...limits } : defaults)
  // ADS AUTONOMY AA-W2-13 — a kind that cannot be undone (archive-ads): what it may do alone is raised one step at a
  // time, each with its own fresh code (a code is single use), so a permanent change never starts running by rule on
  // one code. Lowering and tightening stay free.
  if (raising && loosening && tool.reversibility === 'none') {
    return {
      ok: false, status: 400, code: 'second_code_required',
      error: `${toolName} cannot be undone: raise its level and loosen its limits one at a time, each with its own authenticator code.`,
    }
  }
  if (raising || loosening) {
    const refused = await mayRaise(actor, patch.code)
    if (refused) return refused
  }

  const data = {
    claudeTrust: level,
    claudeLimits: limits ? (limits as Prisma.InputJsonValue) : Prisma.JsonNull,
    updatedBy: actor.label,
  }
  await prisma.agentTool.upsert({
    where: { workspace_name: workspaceKey({ name: toolName }) },
    create: {
      name: toolName,
      riskTier: tool.alwaysAsk ? 'high' : tool.riskTier,
      requiresApproval: !!tool.alwaysAsk || tool.riskTier === 'high' || !!tool.requiresApprovalDefault,
      ...data,
    },
    update: data,
  })
  bustPolicyCache()
  await recordControlChange({
    charterKey: CLAUDE_CHARTER,
    action: 'policy',
    from: { tool: toolName, level: current.stored, limits: current.storedLimits },
    to: { tool: toolName, level, limits },
    actor: actor.label,
  })
  return { ok: true, rule: (await claudeRuleOf(toolName))! }
}

/** Set the most changes that may run by rule in 24 hours. Raising it needs a fresh 2FA code. Audited. */
export async function setDailyAutoCap(actor: TrustActor, patch: { dailyAutoCap?: unknown; code?: unknown }): Promise<{ ok: true; dailyAutoCap: number } | TrustRefusal> {
  const cap = Number(patch.dailyAutoCap)
  if (!Number.isInteger(cap) || cap < 0 || cap > MAX_DAILY_AUTO_CAP) {
    return { ok: false, status: 400, error: `dailyAutoCap must be a whole number from 0 to ${MAX_DAILY_AUTO_CAP}.` }
  }
  const now = await autonomyOf()
  if (cap === now.dailyAutoCap) return { ok: true, dailyAutoCap: cap }
  if (cap > now.dailyAutoCap) {
    const refused = await mayRaise(actor, patch.code)
    if (refused) return refused
  }
  await prisma.agentAutonomy.upsert({
    where: { workspaceId: workspaceIdForQuery() },
    create: { dailyAutoCap: cap, updatedBy: actor.label },
    update: { dailyAutoCap: cap, updatedBy: actor.label },
  })
  await recordControlChange({ charterKey: CLAUDE_CHARTER, action: 'policy', from: { dailyAutoCap: now.dailyAutoCap }, to: { dailyAutoCap: cap }, actor: actor.label })
  return { ok: true, dailyAutoCap: cap }
}

export interface ClaudeRuleRow {
  name: string
  title: string
  category: string
  readOnly: boolean
  /** W4-1 — a journal tool (AgentTool.journal): no change of the business, it runs at once; its levels mean on or off. */
  journal?: true
  /** Its preview or its change reaches a marketplace or a buyer. */
  openWorld: boolean
  reversibility: Reversibility | null
  ceiling: ClaudeTrust
  levels: ClaudeTrust[]
  level: ClaudeTrust
  stored: ClaudeTrust
  limits: Record<string, unknown> | null
  limitsInvalid?: string
  defaultLimits: Record<string, unknown> | null
  /** JSON Schema of the limits (each field described), for a form; null when the tool has none. */
  limitsSchema: Record<string, unknown> | null
}

export interface ClaudeRulesView {
  autonomy: Autonomy & { autoRunsLastDay: number }
  tools: ClaudeRuleRow[]
}

const LIMIT_SCHEMAS = new WeakMap<AgentTool, Record<string, unknown>>()
function limitsSchemaOf(tool: AgentTool): Record<string, unknown> | null {
  if (!tool.limits) return null
  let schema = LIMIT_SCHEMAS.get(tool)
  if (!schema) {
    const { $schema: _dialect, ...rest } = z.toJSONSchema(tool.limits, { io: 'input' }) as Record<string, unknown>
    schema = rest
    LIMIT_SCHEMAS.set(tool, schema)
  }
  return schema
}

/** Every tool Claude is offered, with this business's level, ceiling and limits, and the business's brakes. */
export async function listClaudeRules(): Promise<ClaudeRulesView> {
  const offered = listTools().filter((tool) => offeredOn(tool, 'mcp'))
  const [rows, autonomy, autoRunsLastDay] = await Promise.all([
    prisma.agentTool.findMany({ select: { name: true, claudeTrust: true, claudeLimits: true } }),
    autonomyOf(),
    autoRunsInLastDay(),
  ])
  const byName = new Map(rows.map((row) => [row.name, row]))
  return {
    autonomy: { ...autonomy, autoRunsLastDay },
    tools: offered.map((tool) => {
      const rule = ruleFrom(tool, byName.get(tool.name) ?? null)
      return {
        name: tool.name,
        title: tool.title,
        category: tool.category,
        readOnly: tool.readOnly,
        ...(tool.journal ? { journal: true as const } : {}),
        openWorld: !!tool.openWorld,
        reversibility: tool.reversibility ?? null,
        ceiling: rule.ceiling,
        levels: levelsFor(tool),
        level: rule.level,
        stored: rule.stored,
        limits: rule.limits,
        ...(rule.limitsInvalid ? { limitsInvalid: rule.limitsInvalid } : {}),
        defaultLimits: defaultsOf(tool),
        limitsSchema: limitsSchemaOf(tool),
      }
    }),
  }
}
