/**
 * PROGRESS — the sheet's progress columns (2026-09-26): ONE colour rule and ONE card model. Pure, so the rule is
 * tested node-only (this repo's vitest has no DOM and no JSX transform) and `ProgressCell` / `ProgressDetailCard`
 * only draw what this returns.
 *
 * ## Colour rule A (the Owner's choice, 2026-09-26)
 *
 *   red    (`missing`)  — a REQUIRED field is empty, whatever the percentage
 *   yellow (`partial`)  — every required field is filled, an OPTIONAL one is empty
 *   green  (`complete`) — nothing that applies here is empty
 *   grey   (`unknown`)  — it cannot be said: not computed, not scorable, or the optional side is not recorded yet
 *
 * 🔴 The colour comes from WHAT is missing, never from HOW MUCH (#43, #727). A 96% row with one empty required
 * field is red; a 12% row whose required fields are all filled is yellow. The percentage drives only the bar's
 * length and the number beside it.
 *
 * 🔴 Grey is not green. A row whose optional side was never recorded (an index row written before 2026-09-26)
 * could be yellow or green, and painting either would be a guess (R-LX-9: could not measure ≠ measured empty).
 * A KNOWN empty required field is still red — that part is measured.
 *
 * Not publish readiness. This is completeness: what is filled against what applies. Whether a listing can
 * publish is the channel's verdict (the scope chips, the listings readiness page, the publish check).
 */

export type ProgressTone = 'complete' | 'partial' | 'missing' | 'unknown'

/** One field in the card. `reason` is the server's sentence, verbatim, when it has one. */
export interface ProgressField {
  field: string
  label: string
  reason?: string | null
}

export interface ProgressValue {
  /** 0–100: filled ÷ every field that applies (required + optional). `null` = not measurable. */
  pct: number | null
  /** Counts behind the required side; `null` when the scope has none to count. */
  required: { filled: number; total: number } | null
  /** Counts behind the optional side; `null` = NOT RECORDED (never "none"). */
  optional: { filled: number; total: number } | null
  /** The empty required fields, by name. */
  requiredEmpty: readonly ProgressField[]
  /** The empty optional fields, by name; `null` = not recorded. */
  optionalEmpty: readonly ProgressField[] | null
  /** Issues that are not an empty field (a value the channel rejects, a missing translation, …). */
  otherIssues?: readonly ProgressField[]
  /** The server's own sentence when the value cannot be measured. Shown verbatim. */
  note?: string | null
  /** When the stored reading was computed (index rows). Live sheet rows leave it out. */
  computedAt?: string | null
}

/** The ONE colour rule. */
export function progressTone(value: ProgressValue | null | undefined): ProgressTone {
  if (!value) return 'unknown'
  const requiredGap = value.requiredEmpty.length > 0 || (value.required ? value.required.filled < value.required.total : false)
  // A KNOWN empty required field is red even when the percentage cannot be drawn — that fact is measured.
  if (requiredGap) return 'missing'
  if (value.pct === null || value.optional === null || value.optionalEmpty === null) return 'unknown'
  const optionalGap = value.optionalEmpty.length > 0 || value.optional.filled < value.optional.total
  return optionalGap ? 'partial' : 'complete'
}

export const PROGRESS_TONE_WORD: Readonly<Record<ProgressTone, string>> = {
  missing: 'Required fields empty',
  partial: 'Optional fields empty',
  complete: 'Complete',
  unknown: 'Not measured',
}

/** 0–100, rounded once, so the bar and the number can never tell two stories. `null` stays null. */
export function progressPercent(pct: number | null | undefined): number | null {
  if (pct == null || !Number.isFinite(pct)) return null
  return Math.max(0, Math.min(100, Math.round(pct)))
}

/**
 * filled ÷ total over both sides, or `null` when the optional side is not recorded — a percentage over the required
 * side alone would be a different number under the same label.
 */
export function combinedPercent(required: { filled: number; total: number } | null, optional: { filled: number; total: number } | null): number | null {
  if (!optional) return null
  const filled = (required?.filled ?? 0) + optional.filled
  const total = (required?.total ?? 0) + optional.total
  return total > 0 ? Math.round((filled / total) * 100) : 100
}

/* ── the card ─────────────────────────────────────────────────────────────────────────────── */

/** What one field in the card can do. The CALLER decides, because only it knows its columns and scopes. */
export type ProgressAction =
  /** A column on this sheet: put the cursor in the cell (a hidden column is shown first). */
  | { kind: 'goto'; label: string }
  /** Not a column here: open the scope that has it. */
  | { kind: 'link'; label: string; href: string }
  /** Nothing can be offered — the sentence says where to do it. */
  | { kind: 'none'; text: string }

export interface ProgressDetailItem extends ProgressField {
  action: ProgressAction
}

export interface ProgressDetailGroup {
  id: 'required' | 'optional' | 'other'
  heading: string
  /** The group's mark: the tone its fields cause. `other` issues are neutral — they are not an empty field. */
  tone: 'missing' | 'partial' | 'unknown'
  items: ProgressDetailItem[]
}

export interface ProgressDetailModel {
  tone: ProgressTone
  /** "Amazon · IT · 83%" */
  title: string
  /** The tone in words — the same words the legend uses. */
  toneWord: string
  /** The row the card is about (a SKU). */
  subject: string | null
  /** "1 of 4 required empty · 2 of 9 optional empty", or the server's sentence when nothing can be measured. */
  summary: string | null
  groups: ProgressDetailGroup[]
  /** Said when there is nothing to list: "Every field Amazon · IT asks for is filled." */
  allFilled: string | null
  /** Honest gaps in what the card knows, each a full sentence. */
  notes: string[]
  /** "Computed 6 h ago · not publish readiness" */
  footer: string
}

export const OPTIONAL_NOT_RECORDED =
  'The optional fields are not recorded for this row yet — the nightly refresh (02:17 UTC) or the next edit of this family records them.'
export const REQUIRED_NAMES_NOT_RECORDED =
  'Some empty required fields are not recorded by name for this row yet — the nightly refresh (02:17 UTC) or the next edit of this family records them.'

/** "just now", "12 min ago", "6 h ago", "3 d ago". */
export function progressAge(computedAt: string | null | undefined, now: number): string | null {
  if (!computedAt) return null
  const at = Date.parse(computedAt)
  if (!Number.isFinite(at)) return null
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

/**
 * The card behind one progress cell. NO CAP: every field is listed and the list scrolls (the Owner: "In case there
 * are several attributes, I want them to be like a dropdown, and I should be able to scroll").
 */
export function progressDetailModel(input: {
  scopeLabel: string
  subject?: string | null
  value: ProgressValue | null
  actionFor: (field: string, label: string) => ProgressAction
  now: number
}): ProgressDetailModel {
  const { scopeLabel, value, actionFor, now } = input
  const subject = input.subject ?? null
  const tone = progressTone(value)
  const pct = progressPercent(value?.pct)
  const title = pct === null ? scopeLabel : `${scopeLabel} · ${pct}%`
  const toneWord = PROGRESS_TONE_WORD[tone]
  if (!value) {
    return { tone, title, toneWord, subject, summary: 'Progress has not been computed for this row in this language.', groups: [], allFilled: null, notes: [], footer: 'Completeness — not publish readiness' }
  }
  const item = (f: ProgressField): ProgressDetailItem => ({ ...f, reason: f.reason ?? null, action: actionFor(f.field, f.label) })
  const groups: ProgressDetailGroup[] = []
  if (value.requiredEmpty.length) groups.push({ id: 'required', heading: `Required and empty (${value.requiredEmpty.length})`, tone: 'missing', items: value.requiredEmpty.map(item) })
  if (value.optionalEmpty?.length) groups.push({ id: 'optional', heading: `Optional and empty (${value.optionalEmpty.length})`, tone: 'partial', items: value.optionalEmpty.map(item) })
  const other = value.otherIssues ?? []
  if (other.length) groups.push({ id: 'other', heading: `Other issues (${other.length})`, tone: 'unknown', items: other.map(item) })

  const bits: string[] = []
  if (value.required && value.required.total > 0) bits.push(`${value.required.total - value.required.filled} of ${value.required.total} required empty`)
  if (value.optional && value.optional.total > 0) bits.push(`${value.optional.total - value.optional.filled} of ${value.optional.total} optional empty`)
  const summary = value.pct === null && value.note ? value.note : bits.length ? bits.join(' · ') : (value.note ?? null)

  const notes: string[] = []
  const requiredGap = value.required ? value.required.total - value.required.filled : 0
  if (requiredGap > value.requiredEmpty.length) notes.push(REQUIRED_NAMES_NOT_RECORDED)
  if (value.optional === null || value.optionalEmpty === null) notes.push(OPTIONAL_NOT_RECORDED)

  const allFilled = tone === 'complete' ? `Every field ${scopeLabel} asks for is filled.` : null
  const age = progressAge(value.computedAt, now)
  return { tone, title, toneWord, subject, summary, groups, allFilled, notes,
    footer: `${age ? `Computed ${age} · ` : ''}completeness — not publish readiness` }
}

/** The trigger's accessible name: the whole reading, not the bar's abbreviation. */
export function progressTriggerLabel(scopeLabel: string, subject: string | null | undefined, value: ProgressValue | null): string {
  const tone = progressTone(value)
  const pct = progressPercent(value?.pct)
  const where = subject ? `${scopeLabel}, ${subject}` : scopeLabel
  return `${where}: ${pct === null ? '' : `${pct}% filled, `}${PROGRESS_TONE_WORD[tone].toLowerCase()}. Show what is missing.`
}

/** Plain text for export and the cell's own value formatter. */
export function progressText(value: ProgressValue | null | undefined): string {
  const pct = progressPercent(value?.pct)
  return `${pct === null ? '—' : `${pct}%`} · ${PROGRESS_TONE_WORD[progressTone(value)]}`
}

/**
 * The next item to focus in the card's list, for ↑ ↓ Home End. `-1` = nothing to move to. Pure, so the card's
 * keyboard model is tested without a DOM.
 */
export function progressListKey(key: string, index: number, count: number): number {
  if (count <= 0) return -1
  if (key === 'ArrowDown') return index < 0 ? 0 : Math.min(count - 1, index + 1)
  if (key === 'ArrowUp') return index < 0 ? count - 1 : Math.max(0, index - 1)
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return -1
}
