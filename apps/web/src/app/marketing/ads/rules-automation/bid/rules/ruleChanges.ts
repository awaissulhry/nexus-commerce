/**
 * Bid page, Rules view (2026-10-10) — what a person can change from the rules table, as a DRAFT and as requests. Pure,
 * tested in Node. Nothing here sends anything: the page reviews the draft in the DS `ReviewChangesModal` and sends the
 * requests these functions name.
 *
 * A mode change is one PATCH /api/advertising/autonomy/rules/:id { level } — the one level route (it keeps `enabled` and
 * `dryRun` in step and refuses a level above the rule's ceiling, or Auto before the graduation gate, with a sentence).
 * A rule made in the bid builder also carries a belt (`actions[0].control`): 'manual' makes it ask at ANY level — so at
 * Watch it would ask instead of watching, and at Auto it would never write. The belt is set with the level: 'automate'
 * for Watch and Auto (FIRST, so the rule never acts lower than asked), 'manual' for Ask me (AFTER the level).
 *
 * Archive replaces delete (POST /api/advertising/bid-rules/:id/archive): runs and changes are kept; its waiting asks
 * expire and its inputs to the brain are dropped. Undo = unarchive (it comes back at Off) and the mode it had.
 */
import type { ReviewChange, ReviewConflict } from '@/design-system/patterns'
import {
  LEVEL_OF_MODE, MODE_WORD, heldStep, holdWord, isBrain, modeRank, plural,
  type BidMode, type BidRuleRow, type RuleLevel,
} from './bidRulesModel'

// ── the mode draft ──────────────────────────────────────────────────────────────────────────────────────────────────

/** rule id → the mode the person picked (only rules whose pick differs from what is set). */
export type ModeDraft = Readonly<Record<string, BidMode>>

/**
 * The draft after a pick: a pick back to the set mode drops the rule from the draft. The brain, archived rules and a step
 * the rule holds (Auto before its gate, Auto from Off — `heldStep`) never enter it: the server would refuse the save
 * (use audit A4, A5).
 */
export function pickMode(draft: ModeDraft, row: BidRuleRow, next: BidMode): ModeDraft {
  if (isBrain(row) || row.archived || heldStep(row, next)) return draft
  const out: Record<string, BidMode> = { ...draft }
  if (next === row.mode.set) delete out[row.id]
  else out[row.id] = next
  return out
}

/** The same pick for many rules (the selection's "Mode"); a rule that holds the step keeps its mode. */
export function pickModeFor(draft: ModeDraft, rows: readonly BidRuleRow[], next: BidMode): ModeDraft {
  return rows.reduce((d, r) => pickMode(d, r, next), draft)
}

/**
 * The selection's mode list: a step none of the ticked rules may take is held with the first one's reason; one that only
 * some may take says how many keep their mode (A4: "Auto" offered beside "Auto from 24 Oct").
 */
export function bulkModeOptions(rows: readonly BidRuleRow[]): Array<{ value: BidMode; label: string; note?: string; heldReason?: string }> {
  const live = rows.filter((r) => !isBrain(r) && !r.archived)
  return (['OFF', 'WATCH', 'ASK', 'AUTO'] as const).map((m) => {
    const held = live.map((r) => heldStep(r, m)).filter((w): w is string => !!w)
    if (live.length && held.length === live.length) return { value: m, label: MODE_WORD[m], note: held[0], heldReason: held[0] }
    return held.length ? { value: m, label: MODE_WORD[m], note: `${plural(held.length, 'rule')} ${held.length === 1 ? 'keeps its' : 'keep their'} mode: ${held[0]}` } : { value: m, label: MODE_WORD[m] }
  })
}

/** Keep only picks that still differ from what is set now (after a re-read or a save). */
export function retidyModes(draft: ModeDraft, rows: ReadonlyMap<string, BidRuleRow>): ModeDraft {
  const out: Record<string, BidMode> = {}
  for (const [id, mode] of Object.entries(draft)) {
    const row = rows.get(id)
    if (row && !row.archived && !isBrain(row) && row.mode.set !== mode) out[id] = mode
  }
  return out
}

/** The mode a row shows in the grid: the person's pick while it is in the draft, else what is set (and what acts). */
export function shownMode(row: BidRuleRow, draft: ModeDraft): BidRuleRow['mode'] {
  const pick = draft[row.id]
  return pick ? { ...row.mode, set: pick, acts: pick, heldBy: null } : row.mode
}

/**
 * A pick that can change bids: up to Ask me (its asks change bids once you approve them) or Auto (it changes them alone).
 * Watch changes nothing, so Off → Watch is no raise and needs no tick (audit S1).
 */
export const canChangeBids = (from: BidMode, to: BidMode): boolean => (to === 'ASK' || to === 'AUTO') && modeRank(to) > modeRank(from)

/** The one tick's words for the picks that can change bids. */
export const raiseAck = (count: number): string => (count === 1
  ? 'I understand: from its next run this rule can change bids'
  : `I understand: from their next run these ${count} rules can change bids`)

/** One line of the review per drafted rule. A pick that can change bids needs the one tick. */
export function modeReviewChanges(draft: ModeDraft, rows: ReadonlyMap<string, BidRuleRow>): ReviewChange[] {
  return Object.entries(draft).flatMap(([id, next]) => {
    const row = rows.get(id)
    if (!row) return []
    const raise = canChangeBids(row.mode.set, next)
    const held = row.mode.acts !== row.mode.set ? `Acts as ${MODE_WORD[row.mode.acts]} now${row.mode.heldBy ? `: ${holdWord(row.mode.heldBy.label)}` : ''}` : undefined
    const note = held ?? (raise ? 'Can change bids' : undefined)
    return [{ id, where: row.name, what: 'Mode', now: MODE_WORD[row.mode.set], next: MODE_WORD[next], raise, ...(note ? { note } : {}) }]
  })
}

/** A drafted rule whose set mode changed since the draft was made (another tab, Claude, the Control Room). */
export function modeConflicts(draft: ModeDraft, before: ReadonlyMap<string, BidRuleRow>, fresh: ReadonlyMap<string, BidRuleRow>): ReviewConflict[] {
  return Object.keys(draft).flatMap((id) => {
    const was = before.get(id), now = fresh.get(id)
    if (!was) return []
    if (!now) return [{ label: was.name, was: MODE_WORD[was.mode.set], now: 'gone' }]
    if (now.archived && !was.archived) return [{ label: was.name, was: MODE_WORD[was.mode.set], now: 'archived' }]
    return now.mode.set !== was.mode.set ? [{ label: was.name, was: MODE_WORD[was.mode.set], now: MODE_WORD[now.mode.set] }] : []
  })
}

// ── the requests of one mode change ─────────────────────────────────────────────────────────────────────────────────

export type Belt = 'manual' | 'automate'

/** Whether a stored rule is a bid-builder rule (its belt lives in `actions[0].control`). */
export function isBuilderRule(actions: unknown): boolean {
  const a0 = Array.isArray(actions) ? (actions[0] as { type?: unknown } | undefined) : undefined
  return a0?.type === 'bid'
}

export function storedBelt(actions: unknown): Belt | null {
  const a0 = Array.isArray(actions) ? (actions[0] as { control?: unknown } | undefined) : undefined
  return a0?.control === 'manual' || a0?.control === 'automate' ? a0.control : null
}

/** The belt a mode needs on a builder rule, or null when the stored one may stay (Off keeps whatever it had). */
export function beltFor(mode: BidMode): Belt | null {
  if (mode === 'WATCH' || mode === 'AUTO') return 'automate'
  if (mode === 'ASK') return 'manual'
  return null
}

export type ModeStep =
  | { kind: 'belt'; control: Belt; rollbackOnFail?: Belt }
  | { kind: 'level'; level: RuleLevel }

/**
 * The requests that move one rule to `next`, in order. The belt goes first when the new mode needs 'automate' (the rule
 * then never acts lower than asked; if the level is refused the belt goes back), last when it needs 'manual' (the level
 * stops a write first). An engine rule (no builder belt) is one level request.
 */
export function modeSteps(next: BidMode, actions: unknown): ModeStep[] {
  const level: ModeStep = { kind: 'level', level: LEVEL_OF_MODE[next] }
  if (!isBuilderRule(actions)) return [level]
  const want = beltFor(next)
  const have = storedBelt(actions)
  if (!want || want === have) return [level]
  if (want === 'automate') return [{ kind: 'belt', control: 'automate', rollbackOnFail: have ?? 'manual' }, level]
  return [level, { kind: 'belt', control: 'manual' }]
}

/** The stored actions with the belt set (the PATCH body of a belt step). */
export function withBelt(actions: unknown, control: Belt): unknown[] {
  const list = Array.isArray(actions) ? actions : []
  return list.map((a, i) => (i === 0 && a && typeof a === 'object' ? { ...(a as object), control } : a))
}

/** A refusal in the server's own words (a 409's `message` or `reason`, a 400's `error`), never a bare code. */
export function refusalWords(status: number, body: unknown): string {
  const b = (body && typeof body === 'object' ? body : {}) as { message?: unknown; reason?: unknown; error?: unknown; problems?: unknown }
  const sentence = (v: unknown) => (typeof v === 'string' && /\s/.test(v.trim()) ? v.trim() : null)
  const problems = Array.isArray(b.problems) ? b.problems.filter((p): p is string => typeof p === 'string') : []
  if (problems.length) return problems.join(' · ')
  const said = sentence(b.message) ?? sentence(b.reason) ?? sentence(b.error)
  if (said) return said
  if (status === 404) return 'Not found: it may have been archived or deleted.'
  if (status === 403 || status === 401) return 'Not allowed for your account.'
  const code = typeof b.error === 'string' && b.error ? `: ${b.error}` : ''
  return `Refused (HTTP ${status}${code}).`
}

// ── archive ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The rules that may be archived (not the brain, not already archived). */
export const archivable = (rows: readonly BidRuleRow[]): BidRuleRow[] => rows.filter((r) => !isBrain(r) && !r.archived)

export function archiveReviewChanges(rows: readonly BidRuleRow[]): ReviewChange[] {
  return archivable(rows).map((r) => {
    const notes = [
      r.waiting ? `${plural(r.waiting, 'waiting ask')} ${r.waiting === 1 ? 'expires' : 'expire'}` : null,
      r.last7d.brainInputs ? `${plural(r.last7d.brainInputs, 'Brain input')} ${r.last7d.brainInputs === 1 ? 'ends' : 'end'}` : null,
    ].filter(Boolean)
    return { id: r.id, where: r.name, what: 'Rule', now: MODE_WORD[r.mode.set], next: 'Archived', ...(notes.length ? { note: notes.join(' · ') } : {}) }
  })
}

export function restoreReviewChanges(rows: readonly BidRuleRow[]): ReviewChange[] {
  return rows.filter((r) => r.archived && !isBrain(r)).map((r) => ({ id: r.id, where: r.name, what: 'Rule', now: 'Archived', next: MODE_WORD.OFF }))
}

export const archiveLabel = (count: number): string => `Archive ${plural(count, 'rule')}`
export const restoreLabel = (count: number): string => `Restore ${plural(count, 'rule')}`
