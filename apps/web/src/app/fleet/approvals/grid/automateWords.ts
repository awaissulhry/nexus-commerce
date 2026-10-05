/**
 * Approvals grid (docs/approvals-grid/PLAN.md §4; Owner decision 2 = A, 2026-10-05) — the words and rules of the
 * "Automate this kind…" modal, kept pure so they are tested without a browser.
 *
 * The rule itself is the one Settings › AI › Claude › Rules edits (one business × one kind, its level and its limits);
 * this file reuses that page's own helpers (claudeWords.ts: limit fields, parsing, raises, tightens) and only adds what
 * the modal says on top: which levels this kind may take, a hint from the request in front of the person, when the save
 * needs the 2FA code, and the history test in words. The API decides and refuses; nothing here is a second rule.
 */
import type { QueueRow, QueueTarget, QueueTrustLevel, RuleSimulation } from '@nexus/shared/approval-queue'
import {
  limitFields,
  parseLimits,
  raises,
  rank,
  tightens,
  toolTitle,
  type ClaudeRule,
  type ClaudeTrust,
  type LimitField,
  type LimitsSchema,
  type Raise,
} from '@/app/settings/ai/claude/claudeWords'

/** The change-plan tool: a plan has no rule of its own; it runs by itself only when every kind of step in it may. */
export const PLAN_TOOL = 'submit-change-plan'

/** The days the history test reads back. */
export const TEST_DAYS = 30

/** The levels the modal offers, lowest first. `off` (not offered to Claude at all) stays on the settings page. */
export type AutomateLevel = Extract<ClaudeTrust, 'ask' | 'confirm' | 'auto'>
const OFFERED: readonly AutomateLevel[] = ['ask', 'confirm', 'auto']

export const CHOICE_LABEL: Record<AutomateLevel, string> = {
  ask: 'Ask me',
  confirm: 'Confirm in Claude with my code',
  auto: 'Run by themselves within these limits',
}

export const CHOICE_HINT: Record<AutomateLevel, string> = {
  ask: 'You approve each request here.',
  confirm: 'The person who asked types the 6-digit code from their authenticator app in Claude. You can still approve it here.',
  auto: 'Each one still waits 20 seconds before it runs, so you can stop it.',
}

/** The line under the choices. */
export const AUTOMATE_NOTE = 'A rule changes only new requests. You can switch it back to Ask me at any time, without a code.'

/** Under the history test: what it does not replay (claude-rule-simulate.service.ts). */
export const TEST_NOTE = 'This test checks the limits only. A pause or the daily limit can still hold a request.'

/** Beside a limit the settings page cannot edit either (a switch, a choice or a list). */
export const FIXED_LIMIT_HINT = 'Cannot be changed on screen yet.'

/** "“Set price”": a title that starts with a verb never runs into the sentence (claudeWords toolTitle). */
export const kindName = (row: Pick<QueueRow, 'title'>) => toolTitle(row)

export const modalTitle = (row: Pick<QueueRow, 'title'>) => `Automate ${kindName(row)}`
export const leadSentence = (row: Pick<QueueRow, 'title'>) => `From now on, ${kindName(row)} requests from Claude:`

const lower = (a: ClaudeTrust, b: ClaudeTrust): ClaudeTrust => (rank(a) <= rank(b) ? a : b)

/**
 * Can the row's own reading of this kind offer any choice at all? A plan, or a kind whose ceiling is Ask (or Off),
 * always needs a person: the modal says why and offers no level.
 */
export function rowOffersChoices(row: Pick<QueueRow, 'toolName' | 'automation'>): boolean {
  return row.toolName !== PLAN_TOOL && rank(row.automation.max) > rank('ask')
}

/**
 * The levels this kind may take here: never above the row's ceiling NOR the rule's (GET /api/claude/trust), whichever
 * is lower, and only the ones the rule lists. Fewer than two means there is nothing to choose: [].
 */
export function levelChoices(rule: Pick<ClaudeRule, 'levels' | 'ceiling'>, rowMax: QueueTrustLevel): AutomateLevel[] {
  const top = lower(rule.ceiling, rowMax)
  const choices = OFFERED.filter((level) => rule.levels.includes(level) && rank(level) <= rank(top))
  return choices.length > 1 ? choices : []
}

/** Said when the kind may go as far as Confirm but never run by itself. */
export function ceilingNote(choices: readonly AutomateLevel[]): string | null {
  return choices.length && !choices.includes('auto') ? 'This kind can go as far as Confirm in Claude: it never runs by itself.' : null
}

const withStop = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`)

/**
 * Why this kind always needs a person: the API's own sentence when the row carries it, else the kind's reversibility
 * in plain words (the API's `alwaysNeedsYou`, approval-queue.service.ts). A plan says how a plan runs by itself.
 */
export function alwaysNeedsYouWords(row: Pick<QueueRow, 'toolName' | 'reversibility' | 'reachesOutside' | 'automation'>): string {
  if (row.toolName === PLAN_TOOL) {
    return 'A change plan runs by itself only when every kind of step in it may. Automate each kind from its own requests, or in Settings › AI › Claude › Rules.'
  }
  const why = row.automation.whyWaits?.trim()
  if (why && why.startsWith('This kind always needs you')) return withStop(why)
  if (row.reversibility === 'none') return 'This kind always needs you: it cannot be undone.'
  if (row.reachesOutside) return 'This kind always needs you: it reaches a marketplace or a buyer.'
  return 'This kind always needs you.'
}

/** The kind is not a tool Claude is offered (a fleet agent's kind): there is no Claude rule to set. */
export const notOfferedWords = (row: Pick<QueueRow, 'title'>) =>
  `${kindName(row)} is not a tool Claude is offered, so there is no rule to set for it: a person approves each request.`

/** "Also approve this one" is offered only for a request that waits for a person this viewer may approve. */
export function mayAlsoApprove(row: Pick<QueueRow, 'state' | 'canApprove'>): boolean {
  return (row.state === 'waiting' || row.state === 'back_to_you') && row.canApprove
}

// ── Limits ─────────────────────────────────────────────────────────────────────────────────────

/** The number limits, as the settings page's form reads them (only these are editable on screen today). */
export const numberLimits = (rule: Pick<ClaudeRule, 'limitsSchema' | 'limits'>): LimitField[] => limitFields(rule.limitsSchema, rule.limits)

/** A limit the settings page cannot edit either: shown, never changed here. */
export interface FixedLimit {
  key: string
  label: string
  value: string
}

const capital = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text)

function valueWords(value: unknown): string {
  if (value == null) return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.length ? value.map((item) => String(item)).join(', ') : 'None'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** The switches, choices and lists of a kind's limits, with their value now. */
export function fixedLimits(schema: LimitsSchema | null, values: Record<string, unknown> | null): FixedLimit[] {
  return Object.entries(schema?.properties ?? {})
    .filter(([, p]) => p.type !== 'number' && p.type !== 'integer')
    .map(([key, p]) => ({ key, label: capital(p.description ?? key), value: valueWords(values?.[key]) }))
}

/** "from 0 up to 100", as the settings page's limits form says it. */
export function boundsHint(field: Pick<LimitField, 'min' | 'max'>): string | null {
  return [field.min != null ? `from ${field.min}` : '', field.max != null ? `up to ${field.max}` : ''].filter(Boolean).join(' ') || null
}

/** The first number in a change's value ("€49.90", "SEK 120.00", "−3"), or null. */
export function valueNumber(text: string | null): number | null {
  if (!text) return null
  const match = text.replace(/[−–]/g, '-').match(/(-?)\s*[^\d-]*?(\d+(?:\.\d+)?)/)
  if (!match) return null
  const value = Number(match[2])
  return Number.isFinite(value) ? (match[1] ? -value : value) : null
}

const PERCENT_KEY = /(change|variance)(percent|pct)$/i
const COUNT_KEY: Record<string, QueueTarget['kind']> = {
  maxProducts: 'product',
  maxListings: 'listing',
  maxOrders: 'order',
}

const percentWords = (value: number) => {
  const rounded = Math.round(value * 10) / 10
  return `${rounded < 0 ? '−' : ''}${Math.abs(rounded)}%`
}

/**
 * What the request in front of the person shows for this limit, as a hint beside the field — never filled in:
 *   a move in percent ("This request: −10%"), when every change line of the request is in the row and each has a
 *   number before and after; the count of products, listings or orders ("This request: 12 products") when the
 *   request names that many of that kind. Null when the row does not make it obvious.
 */
export function requestHint(field: Pick<LimitField, 'key'>, row: Pick<QueueRow, 'changes' | 'changeCount' | 'target'>): string | null {
  if (PERCENT_KEY.test(field.key)) {
    if (!row.changes.length || row.changeCount > row.changes.length) return null
    const moves: number[] = []
    for (const change of row.changes) {
      const from = valueNumber(change.from)
      const to = valueNumber(change.to)
      if (from == null || to == null || from === 0) return null
      moves.push(((to - from) / Math.abs(from)) * 100)
    }
    if (moves.length === 1) return `This request: ${percentWords(moves[0])}`
    const largest = Math.max(...moves.map((m) => Math.abs(m)))
    return `This request: up to ${percentWords(largest)}`
  }
  const kind = COUNT_KEY[field.key]
  if (kind && row.target?.kind === kind && row.target.count > 0) {
    const count = row.target.count
    return `This request: ${count} ${kind}${count === 1 ? '' : 's'}`
  }
  return null
}

/** What is wrong with each typed limit, by key, in the settings page's own words (its label left off: it sits under it). */
export function fieldErrors(fields: LimitField[], typed: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const field of fields) {
    const parsed = parseLimits([field], typed)
    if ('error' in parsed) errors[field.key] = capital(parsed.error.startsWith(`${field.label}: `) ? parsed.error.slice(field.label.length + 2) : parsed.error)
  }
  return errors
}

/** The limit a refusal of the API names ("Limits for set-price: maxChangePercent — …"), so its words sit beside it. */
export function serverErrorField(message: string, fields: Pick<LimitField, 'key'>[]): string | null {
  return fields.find((field) => new RegExp(`\\b${field.key}\\b`).test(message))?.key ?? null
}

// ── Saving ─────────────────────────────────────────────────────────────────────────────────────

export type SavePlan =
  /** A typed limit is not a number inside its bounds. */
  | { kind: 'invalid'; errors: Record<string, string> }
  /** The level and the limits are as they are now: nothing to send. */
  | { kind: 'nothing' }
  /**
   * Send `patch` (PUT /api/claude/trust/:tool). `needsCode`: it lets Claude do more without a person — a higher level,
   * or limits that do not only tighten — so the 2FA code is asked for first, as on the settings page. `raise` names it
   * for the code dialog (claudeWords raiseText).
   */
  | { kind: 'save'; patch: { level?: AutomateLevel; limits?: Record<string, number> }; needsCode: boolean; raise: Raise }

/**
 * What Save sends, and whether it needs the code. Limits are sent only for `auto`, and only when they changed (or the
 * saved ones no longer fit the kind, so they must be set again). Tightening and lowering are brakes: no code. The API
 * judges again either way (claude-trust.service.ts setClaudeRule) and asks for the code itself if it disagrees.
 */
export function savePlan(rule: ClaudeRule, chosen: AutomateLevel, typed: Record<string, string>): SavePlan {
  const fields = numberLimits(rule)
  let limits: Record<string, number> | undefined
  if (chosen === 'auto' && fields.length) {
    const errors = fieldErrors(fields, typed)
    if (Object.keys(errors).length) return { kind: 'invalid', errors }
    const parsed = parseLimits(fields, typed)
    if ('error' in parsed) return { kind: 'invalid', errors: {} }
    const changed = fields.some((field) => parsed.limits[field.key] !== Number(field.value === '' ? NaN : field.value))
    if (changed || rule.limitsInvalid) limits = parsed.limits
  }
  const levelChanged = chosen !== rule.level
  if (!levelChanged && !limits) return { kind: 'nothing' }
  const raising = raises(rule.level, chosen)
  const loosening = !!limits && !tightens(fields, limits)
  const patch = { ...(levelChanged ? { level: chosen } : {}), ...(limits ? { limits } : {}) }
  const raise: Raise = raising || !limits ? { kind: 'level', rule, level: chosen } : { kind: 'limits', rule, limits }
  return { kind: 'save', patch, needsCode: raising || loosening, raise }
}

/** The limits the history test sends: the typed numbers when they all parse, else null (the fields show why). */
export function testLimits(rule: Pick<ClaudeRule, 'limitsSchema' | 'limits'>, typed: Record<string, string>): Record<string, number> | null {
  const parsed = parseLimits(numberLimits(rule), typed)
  return 'error' in parsed ? null : parsed.limits
}

/** GET /api/claude/trust/:tool/simulate — at Auto, with these limits (none: the kind's limits now). */
export function simulatePath(toolName: string, limits: Record<string, number> | null): string {
  const query = new URLSearchParams({ days: String(TEST_DAYS), level: 'auto' })
  if (limits && Object.keys(limits).length) query.set('limits', JSON.stringify(limits))
  return `/api/claude/trust/${encodeURIComponent(toolName)}/simulate?${query}`
}

/** The primary button: what pressing it does. */
export function saveLabel(plan: SavePlan, alsoApprove: boolean): string {
  if (plan.kind === 'nothing') return 'Approve this one'
  return alsoApprove ? 'Save and approve this one' : 'Save'
}

// ── The history test ───────────────────────────────────────────────────────────────────────────

/** The test in words: the headline, the rejected ones among those that would have run, and each example. */
export function simulationWords(sim: RuleSimulation, row: Pick<QueueRow, 'title'>): { headline: string; rejected: string | null } {
  const kind = kindName(row)
  if (sim.considered === 0) return { headline: `No ${kind} requests in the last ${sim.days} days to test against.`, rejected: null }
  const headline = sim.considered === 1
    ? `With these limits, your one ${kind} request of the last ${sim.days} days would ${sim.wouldRun ? '' : 'not '}have run by itself.`
    : `With these limits, ${sim.wouldRun} of your last ${sim.considered} ${kind} requests would have run by themselves.`
  if (!sim.wouldRun) return { headline, rejected: null }
  const rejected = sim.rejectedAmongWouldRun === 0
    ? `You rejected none of ${sim.wouldRun === 1 ? 'it' : 'those'}.`
    : sim.wouldRun === 1
      ? 'You rejected it.'
      : `You rejected ${sim.rejectedAmongWouldRun} of those.`
  return { headline, rejected }
}

/** One rejected request that would have run: what it was, and the person's own reason. */
export function exampleWords(example: RuleSimulation['examples'][number]): { what: string; why: string } {
  const reason = example.rejectedReason?.trim()
  return {
    what: example.summary?.trim() || 'A request with no summary',
    why: reason ? `Your reason: “${reason}”` : 'You gave no reason.',
  }
}
