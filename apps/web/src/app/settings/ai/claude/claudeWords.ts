/**
 * MCP full control C9 — the words and rules of Settings › AI › Claude, kept pure so they are tested without a browser.
 *
 * The API decides everything (apps/api/src/services/agents/claude-trust.service.ts, claude-activity.service.ts); this
 * file only says it: which levels a tool may take, whether a choice RAISES what Claude may do (that asks for a fresh
 * 2FA code before it is sent), the limits as a person reads them, and each activity outcome in words.
 */

/** Lowest first. `watch` (ADS AUTONOMY AA-W2-4): checked as Auto would and recorded, but a person still decides. */
export type ClaudeTrust = 'off' | 'ask' | 'confirm' | 'watch' | 'auto'
export const TRUST_ORDER: readonly ClaudeTrust[] = ['off', 'ask', 'confirm', 'watch', 'auto']

export const LEVEL_LABEL: Record<ClaudeTrust, string> = {
  off: 'Off — not offered to Claude',
  ask: 'Ask — a person approves each change in Nexus',
  confirm: 'Confirm — the person who asked types their authenticator code in Claude',
  watch: 'Watch — checked as Auto would and recorded; a person still decides',
  auto: 'Auto — runs by your rule, inside its limits',
}

/** The short form, for a grid cell or a sentence. */
export const LEVEL_SHORT: Record<ClaudeTrust, string> = { off: 'Off', ask: 'Ask', confirm: 'Confirm', watch: 'Watch', auto: 'Auto' }

/** A read (or a control tool) is offered or not; "ask" reads as "On" for it. */
export function levelLabel(level: ClaudeTrust, readOnly: boolean): string {
  if (readOnly) return level === 'off' ? 'Off — not offered to Claude' : 'On — Claude may use it'
  return LEVEL_LABEL[level]
}

export const rank = (level: ClaudeTrust) => TRUST_ORDER.indexOf(level)

/** Does going from `from` to `to` let Claude do more without a person? Then it needs the 2FA code (and the API's permission). */
export function raises(from: ClaudeTrust, to: ClaudeTrust): boolean {
  return rank(to) > rank(from)
}

/** One tool's rule as GET /api/claude/trust returns it. */
export interface ClaudeRule {
  name: string
  title: string
  category: string
  readOnly: boolean
  openWorld: boolean
  reversibility: 'full' | 'partial' | 'none' | null
  ceiling: ClaudeTrust
  levels: ClaudeTrust[]
  level: ClaudeTrust
  stored: ClaudeTrust
  limits: Record<string, unknown> | null
  limitsInvalid?: string
  defaultLimits: Record<string, unknown> | null
  limitsSchema: LimitsSchema | null
}

export interface Autonomy {
  paused: boolean
  pausedAt: string | null
  pausedBy: string | null
  reason: string | null
  dailyAutoCap: number
  autoRunsLastDay: number
}

export interface ClaudeRules {
  autonomy: Autonomy
  tools: ClaudeRule[]
}

/** A tool named in a sentence: its title, as a name ("“Set product tags”"), so a title that starts with a verb never
 * runs into the sentence's own ("Set Set product tags to Confirm", the 2026-10-02 end-to-end run). */
export const toolTitle = (rule: Pick<ClaudeRule, 'title'>) => `“${rule.title}”`

/** What a person raises, and so confirms with a fresh 2FA code. */
export type Raise =
  | { kind: 'level'; rule: ClaudeRule; level: ClaudeTrust }
  | { kind: 'limits'; rule: ClaudeRule; limits: Record<string, number> | null }
  | { kind: 'cap'; value: number }
  | { kind: 'resume' }

/** The 2FA dialog's title and its one sentence: what the code raises. */
export function raiseText(raise: Raise): { title: string; sentence: string } {
  switch (raise.kind) {
    case 'level':
      return {
        title: `Raise ${toolTitle(raise.rule)} to ${LEVEL_SHORT[raise.level]}`,
        sentence: raise.level === 'auto'
          ? `Claude may then make ${toolTitle(raise.rule)} changes by your rule, inside their limits, without a person approving each one. Anyone with permission can still stop each one in its undo window.`
          : `Claude may then do more with ${toolTitle(raise.rule)} in this business.`,
      }
    case 'limits':
      return {
        title: `Change the limits for ${toolTitle(raise.rule)}`,
        sentence: raise.limits ? 'Changes inside the new limits may run by your rule without a person.' : 'The limits go back to the Nexus defaults.',
      }
    case 'cap':
      return { title: 'Raise the daily limit', sentence: `Up to ${raise.value} changes may then run by your rule in 24 hours.` }
    default:
      return { title: 'Resume changes that run by rule', sentence: 'Changes set to Auto run by your rule again, inside their limits.' }
  }
}

/** The JSON Schema of a tool's limits (zod's), as far as this page reads it. */
export interface LimitsSchema {
  type?: string
  properties?: Record<string, { type?: string; description?: string; minimum?: number; maximum?: number; exclusiveMinimum?: number; default?: unknown }>
}

/** One limit, as a form field: its key, the sentence that names it, its bounds and its current value. */
export interface LimitField {
  key: string
  label: string
  min: number | null
  max: number | null
  value: string
  /** True when the schema says the number is whole. */
  integer: boolean
}

export function limitFields(schema: LimitsSchema | null, values: Record<string, unknown> | null): LimitField[] {
  const properties = schema?.properties ?? {}
  return Object.entries(properties)
    .filter(([, p]) => p.type === 'number' || p.type === 'integer')
    .map(([key, p]) => ({
      key,
      label: sentence(p.description ?? key),
      min: typeof p.minimum === 'number' ? p.minimum : typeof p.exclusiveMinimum === 'number' ? p.exclusiveMinimum : null,
      max: typeof p.maximum === 'number' ? p.maximum : null,
      value: values?.[key] == null ? '' : String(values[key]),
      integer: p.type === 'integer',
    }))
}

const sentence = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text)

/** The limits in one line a person reads in the grid: "at most 10 % per change". */
export function limitsSummary(rule: Pick<ClaudeRule, 'limits' | 'limitsSchema' | 'limitsInvalid' | 'readOnly'>): string {
  if (rule.readOnly || !rule.limitsSchema) return '—'
  if (rule.limitsInvalid) return `Saved limits no longer fit: set them again`
  const fields = limitFields(rule.limitsSchema, rule.limits)
  if (!fields.length) return '—'
  return fields.map((f) => `${f.value || '—'} · ${f.label.toLowerCase()}`).join('; ')
}

/** Parse what was typed into limit fields: numbers inside their bounds, or the first problem in words. */
export function parseLimits(fields: LimitField[], typed: Record<string, string>): { limits: Record<string, number> } | { error: string } {
  const limits: Record<string, number> = {}
  for (const field of fields) {
    const raw = (typed[field.key] ?? field.value).trim().replace(',', '.')
    const value = Number(raw)
    if (!raw || !Number.isFinite(value)) return { error: `${field.label}: type a number.` }
    if (field.integer && !Number.isInteger(value)) return { error: `${field.label}: type a whole number.` }
    if (field.min != null && value < field.min) return { error: `${field.label}: at least ${field.min}.` }
    if (field.max != null && value > field.max) return { error: `${field.label}: at most ${field.max}.` }
    limits[field.key] = value
  }
  return { limits }
}

/**
 * Do the new limits only TIGHTEN the current ones (the API's convention: a `max…` lower, a `min…` higher)? Then they
 * are a brake: sent at once, no code. Anything else — or back to the defaults — asks for the code first; the API
 * decides either way (claude-trust.service.ts limitsTighten).
 */
export function tightens(fields: LimitField[], next: Record<string, number> | null): boolean {
  if (!next) return false
  return fields.every((field) => {
    const before = Number(field.value)
    const after = next[field.key]
    if (!Number.isFinite(before) || typeof after !== 'number') return false
    if (after === before) return true
    if (/^max/.test(field.key)) return after < before
    if (/^min/.test(field.key)) return after > before
    return false
  })
}

/** What a tool does, in a few words: reads, changes in Nexus, or changes that reach outside. */
export function toolReach(rule: Pick<ClaudeRule, 'readOnly' | 'openWorld' | 'reversibility'>): string {
  if (rule.readOnly) return 'Reads'
  const where = rule.openWorld ? 'Changes; reaches a marketplace or a buyer' : 'Changes in Nexus'
  return rule.reversibility === 'none' ? `${where}; cannot be undone` : where
}

/** The sentence under the Pause switch. */
export function pauseSentence(autonomy: Autonomy): string {
  if (!autonomy.paused) {
    return `Changes set to Auto run by your rule. ${autonomy.autoRunsLastDay} of at most ${autonomy.dailyAutoCap} ran in the last 24 hours.`
  }
  const by = autonomy.pausedBy === 'Nexus' ? 'Nexus paused them itself' : `${autonomy.pausedBy ?? 'Someone'} paused them`
  return `${by}${autonomy.reason ? `: ${autonomy.reason}` : ''}. Every change Claude asks for waits for a person until they are resumed.`
}

// ── Activity ───────────────────────────────────────────────────────────────────────────────────────────

export const OUTCOMES = [
  'read', 'refused', 'preview', 'queued', 'handed-back', 'failed', 'auto', 'approved', 'confirmed', 'rejected', 'expired', 'superseded', 'undone',
] as const
export type Outcome = (typeof OUTCOMES)[number]

export const OUTCOME_LABEL: Record<Outcome, string> = {
  read: 'Read',
  refused: 'Refused',
  preview: 'Preview only',
  queued: 'Waits for a person',
  'handed-back': 'Handed back',
  failed: 'Failed',
  auto: 'Ran by your rule',
  approved: 'Approved',
  confirmed: 'Confirmed in Claude',
  rejected: 'Rejected',
  expired: 'Expired',
  superseded: 'Replaced',
  undone: 'Undone',
}

export const OUTCOME_TONE: Record<Outcome, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  read: 'neutral',
  refused: 'danger',
  preview: 'neutral',
  queued: 'info',
  'handed-back': 'warning',
  failed: 'danger',
  auto: 'success',
  approved: 'success',
  confirmed: 'success',
  rejected: 'neutral',
  expired: 'neutral',
  superseded: 'neutral',
  undone: 'warning',
}

export type UndoState = 'possible' | 'waiting' | 'done' | 'not possible'

/** One row of GET /api/claude/activity. */
export interface ActivityRow {
  runId: string
  at: string
  who: { userId: string | null; name: string | null }
  connection: { id: string | null; app: string | null }
  tool: string
  outcome: Outcome
  note?: string
  approval?: { id: string; tool: string; status: string; decidedBy: string | null; decisionVia: string | null; note: string | null }
  change?: { id: string; reversibility: string; undo: UndoState; outbound: boolean }
  plan?: { steps: number; byStatus: Record<string, number> }
}

/** What became of the change, and whether it can be put back, in words. */
export function changeWords(row: ActivityRow): string {
  if (row.plan) {
    const done = row.plan.byStatus.done ?? 0
    const notRun = (row.plan.byStatus.skipped ?? 0) + (row.plan.byStatus.failed ?? 0)
    return `Plan of ${row.plan.steps}: ${done} ran${notRun ? `, ${notRun} did not` : ''}`
  }
  if (!row.change) return row.note ?? row.approval?.note ?? ''
  switch (row.change.undo) {
    case 'possible':
      return row.change.outbound ? 'Can be undone (sent to the marketplace again)' : 'Can be undone'
    case 'waiting':
      return 'An undo waits for a person'
    case 'done':
      return 'Undone'
    default:
      return 'Cannot be undone'
  }
}

/** The connection, as a person knows it: the app's name, else the start of its id. */
export function connectionWords(row: Pick<ActivityRow, 'connection'>): string {
  return row.connection.app ?? (row.connection.id ? `Connection ${row.connection.id.slice(0, 8)}` : '—')
}

/** "3 min ago" for a recent moment, else the date and time. */
export function when(iso: string, now = Date.now()): string {
  const at = new Date(iso).getTime()
  const seconds = Math.round((now - at) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
