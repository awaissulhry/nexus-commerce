/**
 * R5 (MCP full control, part 06) — the words every automation is described in, and the env gates' arithmetic.
 *
 * One vocabulary for "how far may it go", the same four words the ads rules and the Control Room use
 * (`ads-autonomy.ts`, `ads-control-room.service.ts`):
 *   OFF      does not run, or cannot act at all
 *   OBSERVE  runs and records; changes nothing outside Nexus (a dry run, a sandbox, findings)
 *   PROPOSE  runs and leaves proposals a person decides
 *   AUTO     runs and changes things by itself
 *
 * An automation's effective level is the LOWEST of what the environment allows (env flags, set on the server, never
 * by Claude) and what this business set (its rows: rules, plans, switches, dials). "Env says off" always wins: a rule
 * switched to AUTO on a server whose cron is off does nothing, and the catalog says so, with the flag's name.
 */
import type { ToolPermission } from '../agents/tool-types.js'
import prisma from '../../db.js'
import { resolveAutonomy } from '../advertising/ads-autonomy.js'

export const LEVELS = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'] as const
export type AutomationLevel = (typeof LEVELS)[number]

const rank = (level: AutomationLevel) => LEVELS.indexOf(level)
export const lowest = (...levels: AutomationLevel[]): AutomationLevel =>
  levels.reduce((a, b) => (rank(a) <= rank(b) ? a : b), 'AUTO' as AutomationLevel)
export const highest = (...levels: AutomationLevel[]): AutomationLevel =>
  levels.reduce((a, b) => (rank(a) >= rank(b) ? a : b), 'OFF' as AutomationLevel)
export const isLevel = (value: unknown): value is AutomationLevel => LEVELS.includes(value as AutomationLevel)

/** The 39 automations of plan part 06 §1, by their inventory number. */
export const AUTOMATION_IDS = [
  'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18',
  'E1', 'E2', 'F1', 'F2',
  'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N10', 'N11', 'N12', 'N13', 'N14', 'N15', 'N16', 'N17',
] as const
export type AutomationId = (typeof AUTOMATION_IDS)[number]

export const AREAS = [
  'amazon-ads', 'ebay-ads', 'marketing', 'agents', 'pricing', 'products', 'listings', 'replenishment',
  'reviews', 'bulk', 'alerts', 'detectors',
] as const
export type AutomationArea = (typeof AREAS)[number]

/** Where its writes land. */
export type WritesTo = 'nexus' | 'amazon' | 'ebay' | 'shopify' | 'channels' | 'email' | 'ai-spend'

/** What Claude may do with it once the whole plan is built (part 06 §1, last column). Today every one is read-only. */
export type ClaudeReach = 'full' | 'switch-tune' | 'switch' | 'tune' | 'decide' | 'steer' | 'see'

/** What preview-automation (R8) can show for it. */
export type PreviewKind = 'draft-and-saved' | 'saved' | 'none'

/** One env flag as it bears on an automation: whether it lets it act, and what that means. No value is ever shown. */
export interface EnvFlag {
  flag: string
  allows: boolean
  says: string
}

export interface EnvVerdict {
  /** The highest level the server lets this automation reach. */
  ceiling: AutomationLevel
  flags: EnvFlag[]
  /** Why the ceiling is below AUTO, in a sentence; null when env allows everything. */
  reason: string | null
}

export interface EnvCheck {
  flag: string
  allows: boolean
  /** The ceiling while this flag does not allow it. */
  whenNot: AutomationLevel
  /** Said when it does not allow it. */
  not: string
  /** Said when it allows it. */
  yes: string
}

/** The env verdict of a set of checks: the lowest ceiling, and the sentence of the check that set it. */
export function envVerdict(checks: EnvCheck[]): EnvVerdict {
  let ceiling: AutomationLevel = 'AUTO'
  let reason: string | null = null
  for (const check of checks) {
    if (check.allows) continue
    if (rank(check.whenNot) < rank(ceiling)) {
      ceiling = check.whenNot
      reason = check.not
    }
  }
  return { ceiling, flags: checks.map((c) => ({ flag: c.flag, allows: c.allows, says: c.allows ? c.yes : c.not })), reason }
}

const raw = (name: string) => process.env[name]
/** `=== '1'`: off unless set to exactly 1. */
export const isOne = (name: string) => raw(name) === '1'
/** `!== '0'`: on unless set to exactly 0. */
export const notZero = (name: string) => raw(name) !== '0'
/** `=== 'true'`. */
export const isTrue = (name: string) => raw(name) === 'true'

/** A row of an automation (a rule, a plan, a schedule, a pool …), as the catalog lists it. */
export interface AutomationRow {
  id: string
  name: string
  level: AutomationLevel
  /** Anything else worth one glance: scope, caps, last run. Money keys are named so the money filter can strip them. */
  [key: string]: unknown
}

/** What this business's own rows say. */
export interface BusinessState {
  /** The highest level its rows reach (null for settings and brakes, which never act on their own). */
  level: AutomationLevel | null
  reason: string
  /** For settings and brakes: what is in force. */
  state?: string
  scope?: string | null
  caps?: Record<string, unknown> | null
  rows?: { total: number; byLevel: Partial<Record<AutomationLevel, number>> } | null
  /** Up to 5 rows, the most active first. */
  sample?: Array<Pick<AutomationRow, 'id' | 'name' | 'level'>>
  /** When the automation keeps no CronRun: its last run from its own record. */
  lastRun?: LastRun | null
}

export interface LastRun {
  at: string
  status: string | null
  summary: string | null
}

/** One adapter per automation kind (plan part 06 §4: `{ list, get, level, preview, explain }` — preview and explain
 *  are R8 and R7, which dispatch on `id`). */
export interface AutomationAdapter {
  id: AutomationId
  key: string
  name: string
  what: string
  area: AutomationArea
  writesTo: readonly WritesTo[]
  /** The permission a person needs to see it (and its rows). */
  view: ToolPermission
  claude: ClaudeReach
  preview: PreviewKind
  /** Why there is no preview, or what the preview covers. */
  previewNote: string
  /** CronRun job names its ticks record, for its last run; empty when it keeps none. */
  crons: readonly string[]
  schedule: string | null
  /** Pure: env only. */
  env(): EnvVerdict
  /** This business's rows. */
  state(): Promise<BusinessState>
  /** Its rows, for automation-detail; absent when it has none of its own. */
  rows?(): Promise<AutomationRow[]>
  /** One row in full (conditions, actions, history); absent ⇒ the row as `rows()` lists it. Null when not found. */
  get?(rowId: string): Promise<Record<string, unknown> | null>
  /**
   * R7 — what it did in a window: its runs, its writes matched by its EXACT actor strings (R2 made them exact), its
   * refusals. Null when `rowId` names no row of it in this business. Absent ⇒ its CronRun runs only.
   */
  explain?(opts: ExplainOptions): Promise<ExplainFacts | null>
  /**
   * R8 — what it would do now, writing nothing: a draft (before it is saved) and/or a saved row. Absent ⇒ no preview
   * (`previewNote` says why).
   */
  runPreview?(input: PreviewInput): Promise<PreviewOutcome>
  /** R10 — how turn-up-automation / turn-down-automation move it; absent ⇒ no switch Claude can move (`noSwitch` says why). */
  levelSwitch?: LevelSwitch
  noSwitch?: string
  /**
   * R16 — the key of its per-business engine switch (engine-switch.service.ts ENGINE_KEYS), when the engine itself has
   * one: turn-up / turn-down-automation move it when no rowId is named. Env stays the outer limit.
   */
  engine?: string
}

// ── R10 — switches ───────────────────────────────────────────────────────────────────────────────────

/** One row (or the automation itself, when it has none) as its switch reads it. */
export interface SwitchRow {
  id: string
  name: string
  level: AutomationLevel
  /** The row's updatedAt the move was planned from; an approval runs only while it is unchanged. */
  basis: string | null
  /**
   * A brake (part 06 §3, "brakes are not down"): turning it down can RAISE spend — a dayparting closed window lifts,
   * a bid-lowering or negating rule stops. Its reason, or null.
   */
  brake: string | null
}

/** W4-12b — a field a level move changes with the level (from → to), and the sentence the preview says it in. */
export interface SwitchAlso {
  field: string
  from: string
  to: string
  words: string
}

export interface LevelSwitch {
  /** The levels its rows can be at, lowest first. */
  levels: readonly AutomationLevel[]
  /** Whether a row must be named (false: the automation itself, e.g. the ads dial). */
  needsRow: boolean
  /** The permission a person needs to move it. */
  manage: ToolPermission
  read(rowId?: string): Promise<SwitchRow | null>
  /** Why it may not go to `level` (a ceiling, the graduation gate, a contested lane); null when it may. No write. */
  refusal?(row: SwitchRow, level: AutomationLevel): Promise<string | null>
  /**
   * AA-W2-11 — the evidence of its graduation gate for one row (14 days watched, 10 runs, 1 match or decision), read for
   * a move to AUTO and shown in the preview. It binds only Claude's AUTO (turn-up-automation's limits); a person's own
   * click is held by `refusal` alone, as before. Absent: no gate Nexus can check — AUTO stays a person's click.
   */
  gateEvidence?(row: SwitchRow): Promise<GateEvidence>
  /**
   * W4-12b — what else a move to `level` changes on the row besides its level (an Amazon ads builder rule's
   * Manual/Automate setting), said on the preview; null when nothing. `write` makes the same change.
   */
  alsoChanges?(row: SwitchRow, level: AutomationLevel): Promise<SwitchAlso | null>
  /** The move itself, with its own audit; returns why it failed, or null — or what else it did (`note`, e.g. a give-back). */
  write(row: SwitchRow, level: AutomationLevel, actorUserId: string | null): Promise<string | null | { note: string }>
}

const DAY_MS = 86_400_000

/** The graduation gate's numbers: the same as the Amazon ads rules' (ads-rule-crud.service.ts GRADUATION_GATE). */
export const GATE_NUMBERS = { days: 14, runs: 10, matches: 1 } as const

/**
 * D-R1 for a rule outside Amazon ads: the same evidence the Amazon graduation gate asks for — 14 days watched, 10 real
 * runs, 1 match — from the rule's own counters (which previews no longer raise, R3).
 */
export function evidenceGate(r: { createdAt: Date; evaluationCount: number; matchCount: number }): string[] {
  const days = Math.floor((Date.now() - r.createdAt.getTime()) / DAY_MS)
  const out: string[] = []
  if (days < GATE_NUMBERS.days) out.push(`${days}/${GATE_NUMBERS.days} days watched`)
  if (r.evaluationCount < GATE_NUMBERS.runs) out.push(`${r.evaluationCount}/${GATE_NUMBERS.runs} real runs`)
  if (r.matchCount < GATE_NUMBERS.matches) out.push('no match yet')
  return out
}

/** AA-W2-11 — one row's graduation gate as turn-up-automation's preview shows it (LevelSwitch.gateEvidence). */
export interface GateEvidence {
  open: boolean
  /** What the counts are read from, in a sentence. */
  from: string
  checks: Array<{ check: string; passed: boolean; detail: string }>
  /** A rule's own caps: at AUTO it acts as itself, held by them. Absent when the row is not such a rule. */
  caps?: { maxWritesPerDay: number | null; maxValueCentsEur: number | null }
}

/**
 * AA-W2-11 — the gate from counts: days since the row was made, the runs it recorded, the runs that found something to
 * do (a match, or a decision). Pure; `runs` and `matches` say what they count.
 */
export function gateOfCounts(input: {
  createdAt: Date
  runs: number
  matches: number
  runsAre: string
  matchesAre: string
  from: string
  caps?: GateEvidence['caps']
  now?: Date
}): GateEvidence {
  const days = Math.max(0, Math.floor(((input.now ?? new Date()).getTime() - input.createdAt.getTime()) / DAY_MS))
  const checks = [
    { check: `${GATE_NUMBERS.days} days watched`, passed: days >= GATE_NUMBERS.days, detail: `${days}/${GATE_NUMBERS.days} days since it was made` },
    { check: `${GATE_NUMBERS.runs} runs`, passed: input.runs >= GATE_NUMBERS.runs, detail: `${input.runs}/${GATE_NUMBERS.runs} ${input.runsAre}` },
    { check: `${GATE_NUMBERS.matches} match or decision`, passed: input.matches >= GATE_NUMBERS.matches, detail: `${input.matches} ${input.matchesAre}` },
  ]
  return { open: checks.every((c) => c.passed), from: input.from, checks, ...(input.caps !== undefined ? { caps: input.caps } : {}) }
}

/** A rule's caps as the gate evidence carries them. */
export const capsOfRule = (r: { maxWritesPerDay: number | null; maxValueCentsEur: number | null }): NonNullable<GateEvidence['caps']> =>
  ({ maxWritesPerDay: r.maxWritesPerDay, maxValueCentsEur: r.maxValueCentsEur })

/** The switch of an AutomationRule domain outside Amazon ads (marketing, listings, replenishment, reviews, bulk). */
export function ruleLevelSwitch(domain: string, manage: ToolPermission, brakeOf: (actions: unknown) => string | null = () => null): LevelSwitch {
  return {
    levels: ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'],
    needsRow: true,
    manage,
    async read(rowId) {
      const r = rowId ? await prisma.automationRule.findFirst({ where: { id: rowId, domain } }) : null
      return r ? { id: r.id, name: r.name, level: resolveAutonomy(r), basis: r.updatedAt.toISOString(), brake: brakeOf(r.actions) } : null
    },
    async refusal(row, level) {
      if (level !== 'AUTO') return null
      const r = await prisma.automationRule.findUnique({ where: { id: row.id }, select: { createdAt: true, evaluationCount: true, matchCount: true } })
      const failures = r ? evidenceGate(r) : ['not found']
      return failures.length ? `AUTO only after the graduation gate: ${failures.join(', ')}.` : null
    },
    async gateEvidence(row) {
      const r = await prisma.automationRule.findUnique({ where: { id: row.id }, select: { createdAt: true, evaluationCount: true, matchCount: true, maxWritesPerDay: true, maxValueCentsEur: true } })
      return gateOfCounts({
        createdAt: r?.createdAt ?? new Date(), runs: r?.evaluationCount ?? 0, matches: r?.matchCount ?? 0,
        runsAre: 'real runs', matchesAre: 'matches', from: "the rule's own run counters", caps: r ? capsOfRule(r) : { maxWritesPerDay: null, maxValueCentsEur: null },
      })
    },
    async write(row, level, actorUserId) {
      const before = await prisma.automationRule.findUnique({ where: { id: row.id }, select: { autonomyLevel: true, enabled: true, dryRun: true } })
      await prisma.automationRule.update({ where: { id: row.id }, data: { autonomyLevel: level, enabled: level !== 'OFF', dryRun: level !== 'AUTO' } })
      const { auditLogService } = await import('../audit-log.service.js')
      await auditLogService.write({ userId: actorUserId, entityType: 'AutomationRule', entityId: row.id, action: 'set_level', before, after: { autonomyLevel: level, enabled: level !== 'OFF', dryRun: level !== 'AUTO' }, metadata: { domain } })
      return null
    },
  }
}

// ── R8 — previews ─────────────────────────────────────────────────────────────────────────────────────

export interface PreviewInput {
  /** A saved row (rule, plan, pool, coverage set …) by id. */
  rowId?: string
  /** An unsaved rule, in the shape its own builder or route takes. */
  draft?: Record<string, unknown>
  /** For a saved rule whose trigger comes from events: the context to evaluate it against. */
  context?: Record<string, unknown>
}

export type PreviewOutcome =
  | {
    kind: 'draft' | 'saved'
    subject: { id: string; name: string } | null
    /** What the engine computed, as its own preview returns it. */
    result: unknown
    /** The action types the rule carries (a builder rule: those its translation produces), for the no-pause check. */
    actionTypes?: string[]
    notes?: string[]
  }
  | { refused: string; notFound?: boolean }

/** The action types stored on a rule. */
export const actionTypesOf = (actions: unknown): string[] =>
  (Array.isArray(actions) ? actions : []).map((a) => String((a as { type?: unknown })?.type ?? '')).filter(Boolean)

/** How many contexts a saved-rule preview evaluates at most. */
export const PREVIEW_CONTEXTS = 20

/**
 * A saved AutomationRule (marketing, listing, replenishment, bulk …) against the contexts its trigger would hand it
 * now — or the one context given — through the R3 preview path: `evaluateRule({ noPersist })`, so no run row, no
 * counter, no suggestion, no notification, and always a dry run. A disabled rule is previewed without arming it.
 */
export async function previewSavedRule(
  domain: string,
  input: PreviewInput,
  contextsOf: (rule: { trigger: string; scopeMarketplace: string | null }) => Promise<unknown[]>,
  register?: () => Promise<unknown>,
): Promise<PreviewOutcome> {
  if (!input.rowId) return { refused: 'Name the saved rule to preview (rowId). A rule of this kind is previewed once saved: a new one is saved OFF, so saving it changes nothing.' }
  const rule = await prisma.automationRule.findFirst({ where: { id: input.rowId, domain } })
  if (!rule) return { refused: 'not found', notFound: true }
  await register?.()
  const contexts = input.context ? [input.context] : await contextsOf(rule)
  const shown = contexts.slice(0, PREVIEW_CONTEXTS)
  const { evaluateRule } = await import('../automation-rule.service.js')
  const results = []
  for (const context of shown) {
    const r = await evaluateRule({ ruleId: rule.id, context, forceDryRun: true, isTestRun: true, ignoreEnabled: true, noPersist: true })
    results.push({ matched: r.matched, status: r.status, ...(r.errorMessage ? { error: r.errorMessage } : {}), actions: r.actionResults })
  }
  return {
    kind: 'saved',
    subject: { id: rule.id, name: rule.name },
    actionTypes: actionTypesOf(rule.actions),
    result: {
      contextSource: input.context ? 'the context given' : 'built from current data, as its next run would',
      contexts: contexts.length,
      evaluated: shown.length,
      matched: results.filter((r) => r.matched).length,
      results,
    },
    notes: contexts.length ? [] : ['Its trigger has nothing to hand it right now; give a context to see what it would do with one.'],
  }
}

// ── R7 — what an automation did ─────────────────────────────────────────────────────────────────────

export interface ExplainOptions {
  rowId?: string
  since: Date
  days: number
}

export interface RunsFact {
  /** Where the runs are recorded (AutomationRuleExecution, CronRun, EbayAdsRuleExecution …). */
  source: string
  total: number
  byStatus: Record<string, number>
  /** Runs its own daily cap stopped (recorded as runs before AUTO.P0, as refusals since). */
  capped?: number
  last: Array<{ at: string; status: string | null; summary?: string | null }>
}

export interface WritesFact {
  /** Where the writes are recorded, and the exact actor strings matched (never a prefix). */
  source: string
  actors: string[]
  total: number
  byAction: Record<string, number>
  lastAt: string | null
  /** Over all time, not only the window: whether it has ever written anything. */
  everWritten: boolean
  lastEverAt: string | null
  last: Array<{ at: string; action: string; entityType: string; entityId: string; status?: string | null }>
}

export interface RefusalsFact {
  total: number
  byReason: Record<string, number>
  lastAt: string | null
  lastReason: string | null
}

export interface ExplainFacts {
  /** The row explained, when one was named. */
  subject: { id: string; name: string; level: AutomationLevel | null } | null
  runs: RunsFact | null
  writes: WritesFact | null
  refusals: RefusalsFact | null
  notes?: string[]
}

const LAST = 10

/** Runs recorded as CronRun rows of these jobs since a time. */
export async function cronRunsFact(crons: readonly string[], since: Date): Promise<RunsFact | null> {
  if (!crons.length) return null
  const where = { jobName: { in: [...crons] }, startedAt: { gte: since } }
  const [grouped, last] = await Promise.all([
    prisma.cronRun.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.cronRun.findMany({ where, orderBy: { startedAt: 'desc' }, take: LAST, select: { startedAt: true, status: true, outputSummary: true, errorMessage: true, jobName: true } }),
  ])
  const byStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]))
  return {
    source: `CronRun (${crons.join(', ')})`,
    total: grouped.reduce((n, g) => n + g._count._all, 0),
    byStatus,
    last: last.map((r) => ({ at: r.startedAt.toISOString(), status: r.status, summary: (r.outputSummary ?? r.errorMessage ?? '').slice(0, 200) || null })),
  }
}

/** Runs of AutomationRules: one AutomationRuleExecution per run that matched. */
export async function ruleRunsFact(ruleIds: string[], since: Date): Promise<RunsFact> {
  const where = { ruleId: { in: ruleIds }, startedAt: { gte: since } }
  const [grouped, capped, last] = await Promise.all([
    prisma.automationRuleExecution.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.automationRuleExecution.count({ where: { ...where, errorMessage: { in: ['DAILY_CAP_EXCEEDED', 'WRITE_CAP_REACHED'] } } }),
    prisma.automationRuleExecution.findMany({ where, orderBy: { startedAt: 'desc' }, take: LAST, select: { startedAt: true, status: true, errorMessage: true } }),
  ])
  return {
    source: 'AutomationRuleExecution',
    total: grouped.reduce((n, g) => n + g._count._all, 0),
    byStatus: Object.fromEntries(grouped.map((g) => [g.status, g._count._all])),
    capped,
    last: last.map((r) => ({ at: r.startedAt.toISOString(), status: r.status, summary: r.errorMessage })),
  }
}

/** Refusals recorded for these rules (AutomationRefusalDaily, keyed by the bare rule id). */
export async function ruleRefusalsFact(ruleIds: string[], days: number): Promise<RefusalsFact> {
  const { refusalCountsByActor } = await import('../automation-refusals.service.js')
  const counts = await refusalCountsByActor(days)
  const out: RefusalsFact = { total: 0, byReason: {}, lastAt: null, lastReason: null }
  let lastAt: Date | null = null
  for (const id of ruleIds) {
    const c = counts.get(id)
    if (!c) continue
    out.total += c.total
    for (const [reason, n] of Object.entries(c.byReason)) out.byReason[reason] = (out.byReason[reason] ?? 0) + n
    if (c.lastAt && (!lastAt || c.lastAt > lastAt)) {
      lastAt = c.lastAt
      out.lastReason = c.lastReason
    }
  }
  out.lastAt = lastAt ? lastAt.toISOString() : null
  return out
}

/** The rule ids an explain covers: the named one (null when it is not a rule of that domain here), or all of them. */
export async function ruleIdsFor(domain: string, rowId?: string): Promise<{ ids: string[]; subject: ExplainFacts['subject'] } | null> {
  if (rowId) {
    const rule = await prisma.automationRule.findFirst({ where: { id: rowId, domain }, select: { id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true } })
    if (!rule) return null
    return { ids: [rule.id], subject: { id: rule.id, name: rule.name, level: resolveAutonomy(rule) } }
  }
  const rules = await prisma.automationRule.findMany({ where: { domain }, select: { id: true } })
  return { ids: rules.map((r) => r.id), subject: null }
}

/** The explain of a rule domain whose writes are not attributable here: runs and refusals. */
export async function ruleExplain(domain: string, opts: ExplainOptions, writes?: (ids: string[]) => Promise<WritesFact | null>): Promise<ExplainFacts | null> {
  const scope = await ruleIdsFor(domain, opts.rowId)
  if (!scope) return null
  const [runs, refusals, written] = await Promise.all([
    ruleRunsFact(scope.ids, opts.since),
    ruleRefusalsFact(scope.ids, opts.days),
    writes ? writes(scope.ids) : Promise.resolve(null),
  ])
  return { subject: scope.subject, runs, writes: written, refusals }
}

/** Rows summarised: counts by level and the 5 most active. */
export function summarise(rows: AutomationRow[]): { level: AutomationLevel; rows: NonNullable<BusinessState['rows']>; sample: NonNullable<BusinessState['sample']> } {
  const byLevel: Partial<Record<AutomationLevel, number>> = {}
  for (const row of rows) byLevel[row.level] = (byLevel[row.level] ?? 0) + 1
  const sorted = [...rows].sort((a, b) => rank(b.level) - rank(a.level) || a.name.localeCompare(b.name))
  return {
    level: rows.length ? highest(...rows.map((r) => r.level)) : 'OFF',
    rows: { total: rows.length, byLevel },
    sample: sorted.slice(0, 5).map((r) => ({ id: r.id, name: r.name, level: r.level })),
  }
}

// ── Helpers every adapter shares ──────────────────────────────────────────────────────────────────────

export const aiKill = (): EnvCheck => ({
  flag: 'NEXUS_AI_KILL_SWITCH', allows: !['1', 'true', 'yes', 'on'].includes((process.env.NEXUS_AI_KILL_SWITCH ?? '').trim().toLowerCase()), whenNot: 'OFF',
  not: 'NEXUS_AI_KILL_SWITCH is on — no AI runs.',
  yes: 'The AI kill switch is off.',
})
export const outboundEmails = (): EnvCheck => ({
  flag: 'NEXUS_ENABLE_OUTBOUND_EMAILS', allows: isTrue('NEXUS_ENABLE_OUTBOUND_EMAILS'), whenNot: 'OBSERVE',
  not: 'NEXUS_ENABLE_OUTBOUND_EMAILS is not true — no e-mail leaves; sends are recorded as dry runs.',
  yes: 'E-mails are sent.',
})
export const flagOn = (flag: string, allows: boolean, whenNot: AutomationLevel, not: string, yes: string): EnvCheck => ({ flag, allows, whenNot, not, yes })
export const noEnv = () => envVerdict([])

export const on = (yes: boolean): AutomationLevel => (yes ? 'AUTO' : 'OFF')
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

/** An AutomationRule, at the level the engine resolves it to. */
export function ruleRow(r: { id: string; name: string; enabled: boolean; dryRun: boolean; autonomyLevel: string; trigger: string; maxExecutionsPerDay: number | null; maxWritesPerDay: number | null; maxValueCentsEur: number | null; scopeMarketplace: string | null; lastExecutedAt: Date | null }): AutomationRow {
  return {
    id: r.id, name: r.name, level: resolveAutonomy(r), trigger: r.trigger,
    caps: { maxExecutionsPerDay: r.maxExecutionsPerDay, maxWritesPerDay: r.maxWritesPerDay, maxValueCentsEur: r.maxValueCentsEur },
    marketplace: r.scopeMarketplace, lastExecutedAt: iso(r.lastExecutedAt),
  }
}
export const RULE_SELECT = { id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true, trigger: true, maxExecutionsPerDay: true, maxWritesPerDay: true, maxValueCentsEur: true, scopeMarketplace: true, lastExecutedAt: true } as const
export const rulesOf = async (domain: string) => (await prisma.automationRule.findMany({ where: { domain }, select: RULE_SELECT, orderBy: { name: 'asc' } })).map(ruleRow)

export function fromRows(rows: AutomationRow[], none: string, extra: Partial<BusinessState> = {}): BusinessState {
  const s = summarise(rows)
  return {
    level: s.level,
    reason: !rows.length ? none : s.level === 'OFF' ? 'Every one is switched off.' : `The most active is at ${s.level}.`,
    rows: s.rows, sample: s.sample, ...extra,
  }
}


/** An AutomationRule in full, for automation-detail: what it does, in words and as stored. */
export async function ruleDetail(domain: string, rowId: string): Promise<Record<string, unknown> | null> {
  const rule = await prisma.automationRule.findFirst({ where: { id: rowId, domain } })
  if (!rule) return null
  const { conditionsTextOf, ruleWindowOf } = await import('../advertising/rule-conditions-text.js')
  return {
    ...ruleRow(rule),
    description: rule.description,
    when: rule.trigger,
    conditionsText: conditionsTextOf(rule.conditions),
    window: ruleWindowOf(rule.conditions),
    conditions: rule.conditions,
    actions: rule.actions,
    caps: { maxExecutionsPerDay: rule.maxExecutionsPerDay, maxWritesPerDay: rule.maxWritesPerDay, maxValueCentsEur: rule.maxValueCentsEur, maxDailyAdSpendCentsEur: rule.maxDailyAdSpendCentsEur },
    scope: { marketplace: rule.scopeMarketplace, portfolioId: rule.scopePortfolioId, campaignId: rule.scopeCampaignId, productId: rule.scopeProductId },
    lifetime: { evaluations: rule.evaluationCount, matches: rule.matchCount, executions: rule.executionCount },
    lastEvaluatedAt: iso(rule.lastEvaluatedAt), lastMatchedAt: iso(rule.lastMatchedAt), lastExecutedAt: iso(rule.lastExecutedAt),
    createdAt: iso(rule.createdAt), updatedAt: iso(rule.updatedAt),
  }
}
