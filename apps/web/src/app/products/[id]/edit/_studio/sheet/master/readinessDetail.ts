/**
 * A-45 (Step 4.3 #4) — the completeness CARD behind a per-coordinate readiness cell, as a pure model.
 * `apps/web` vitest is node-only, so every decision lives here and `ReadinessDetailCard.tsx` only draws it.
 *
 * What the card may say, and what it may not (R4, honest UI):
 *  - "N of M required" only from the product's own stored counts; the list of EMPTY required fields only from
 *    entries the writer FLAGGED (`requiredEmpty`) — never a guess from the issue sentences.
 *  - A row stored before the flag existed has fewer flagged entries than `total − filled`: the card says the
 *    names are not recorded yet, and when they will be — it never lists part of them as if it were all.
 *  - No index row = "not computed", the server's own sentence, never 0 %.
 *  - Every action names what it does: go to a visible column, open Customise for a hidden one, or — for a field
 *    that is not a column of this sheet — a plain sentence naming the scope (no jump that is not built).
 */
export interface DetailEntry { field: string; label: string; reason: string; kind?: string; requiredEmpty?: true }
export interface DetailValue {
  state: string
  pct: number | null
  note?: string
  required?: { filled: number; total: number }
  computedAt?: string | null
}
export type ColumnPresence = 'visible' | 'hidden' | 'absent'
export type DetailAction =
  | { kind: 'goto'; label: string }
  | { kind: 'customise'; label: string }
  | { kind: 'elsewhere'; text: string }
export interface DetailItem { field: string; label: string; reason: string | null; action: DetailAction }
export interface DetailGroup { id: 'required' | 'other'; heading: string; items: DetailItem[] }
export interface ReadinessDetailModel {
  title: string
  summary: string | null
  groups: DetailGroup[]
  more: number
  notRecordedYet: string | null
  footer: string | null
}

export const DETAIL_ITEM_CAP = 8
export const NOT_COMPUTED_SENTENCE = 'Readiness has not been computed for this language.'
export const NOT_RECORDED_YET = 'The empty required fields are not recorded for this row yet — the nightly refresh (02:17 UTC) or the next edit of this family records them.'
const GENERIC_REQUIRED_REASON = 'Required and empty'

/** "just now", "12 min ago", "6 h ago", "3 d ago" — the age of a stored reading. */
export function readingAge(computedAt: string | null | undefined, now: number): string | null {
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

export function readinessDetailModel(input: {
  coordinateLabel: string
  languageLabel: string
  value: DetailValue | null
  entries: readonly DetailEntry[]
  presence: (field: string) => ColumnPresence
  now: number
}): ReadinessDetailModel {
  const { coordinateLabel, languageLabel, value, entries, presence, now } = input
  const where = `${coordinateLabel} · ${languageLabel}`
  if (!value) return { title: where, summary: NOT_COMPUTED_SENTENCE, groups: [], more: 0, notRecordedYet: null, footer: null }

  const req = value.required
  const title = value.pct === null
    ? `${where} — not scored`
    : req ? `${where} — ${value.pct}% (${req.filled} of ${req.total} required)` : `${where} — ${value.pct}%`
  // `pct === null`: the server says WHY in its note (schema missing, no account) — shown verbatim.
  const summary = value.pct === null ? (value.note ?? null) : null

  const action = (field: string, label: string): DetailAction => {
    const where = presence(field)
    if (where === 'visible') return { kind: 'goto', label: `Go to ${label}` }
    if (where === 'hidden') return { kind: 'customise', label: `${label} is hidden — Customise` }
    return { kind: 'elsewhere', text: `Not a column on this sheet — edit it in the ${coordinateLabel} scope.` }
  }
  const required = entries.filter(e => e.requiredEmpty === true)
  const other = entries.filter(e => e.requiredEmpty !== true)
  let budget = DETAIL_ITEM_CAP
  const take = (list: readonly DetailEntry[], generic: boolean): DetailItem[] => {
    const shown = list.slice(0, Math.max(0, budget))
    budget -= shown.length
    return shown.map(e => ({ field: e.field, label: e.label,
      reason: generic && e.reason === GENERIC_REQUIRED_REASON ? null : e.reason, action: action(e.field, e.label) }))
  }
  const groups: DetailGroup[] = []
  const requiredItems = take(required, true)
  if (requiredItems.length) groups.push({ id: 'required', heading: `Required and empty (${required.length})`, items: requiredItems })
  const otherItems = take(other, false)
  if (otherItems.length) groups.push({ id: 'other', heading: `Other issues (${other.length})`, items: otherItems })
  const more = entries.length - requiredItems.length - otherItems.length

  const empty = req ? req.total - req.filled : null
  const notRecordedYet = empty !== null && required.length < empty ? NOT_RECORDED_YET : null
  const age = readingAge(value.computedAt, now)
  const footer = `${age ? `Computed ${age} · ` : ''}this is not publish eligibility`
  return { title, summary, groups, more, notRecordedYet, footer }
}

/** The trigger's accessible name: the whole reading, not the pill's abbreviation. */
export function readinessDetailTriggerLabel(coordinateLabel: string, languageLabel: string, value: DetailValue | null, stateLabel: string): string {
  const where = `${coordinateLabel}, ${languageLabel}`
  if (!value) return `${where}: not computed. Show details.`
  const req = value.required
  const count = req ? `, ${req.total - req.filled} required ${req.total - req.filled === 1 ? 'field' : 'fields'} empty` : ''
  const pct = value.pct === null ? '' : `, ${value.pct}% of required values filled`
  return `${where}: ${stateLabel}${pct}${count}. Show details.`
}

/** R-54 — the Product column's pill: how RICH a row is, never whether it can publish. One wording, one label. */
export function filledAllFieldsTip(pct: number | null | undefined): string {
  const value = typeof pct === 'number' && Number.isFinite(pct) ? `${Math.max(0, Math.min(100, Math.round(pct)))}%` : '—'
  return `Filled (all fields): ${value} — filled ÷ every applicable attribute, optional included. Not publish readiness.`
}
