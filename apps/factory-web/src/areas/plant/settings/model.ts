import { PLANT_CODE, PLANT_LIMITS } from '@nexus/factory-domain/plant/rules'
import { movedOrder } from '@nexus/factory-domain/reasons/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Locale } from '../../../lib/i18n/locales'
import { labelOf } from '../_shared/model'
import type { ClassRow, NewSymptomBody, SymptomEdit, SymptomRow } from './api'

/**
 * Plant settings › Symptoms on the floor (SCR-241; design plant.settings sec:symptoms "The icons operators pick, per
 * machine class"), pure: which rows a class filter and a search keep, what a cell edit sends, what holds a button and why
 * (`plant-settings` keys), an API refusal in words, the order after a move and the few writes that make it. The same
 * edit model as the shared reason code editor (SCR-242): every cell saves on its own.
 */

export const PLANT_SETTINGS_NAMESPACES = ['plant-settings', 'lists'] as const

/** The class filter: every symptom, those for every machine, or what the floor offers one class (its own + every machine's). */
export const ALL = 'all'
export const EVERY = 'every'

/** A cell's own save (DS CellSaveMark shapes). */
export type MarkState = 'saving' | 'saved' | 'refused' | 'unknown'
export interface Mark {
  readonly state: MarkState
  /** A `plant-settings` key: why it was refused, or what is not known. */
  readonly problem?: string
}
export const markKey = (id: string, field: string): string => `${id}:${field}`

/** The cells that save: the words in Italian and English, the icon, three switches. */
export type CellField = 'labelIt' | 'labelEn' | 'icon' | 'unsafe' | 'needsDetail' | 'active'

export interface Notice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export interface SymptomDraft {
  code: string
  /** The class it is for; null: every machine. */
  classId: string | null
  labelIt: string
  labelEn: string
  icon: string | null
  unsafe: boolean
  needsDetail: boolean
}
export const EMPTY_DRAFT: SymptomDraft = Object.freeze({ code: '', classId: null, labelIt: '', labelEn: '', icon: null, unsafe: false, needsDetail: false }) as SymptomDraft

/** The class filter as the address keeps it: `all`, `every`, or a class id the group has. */
export function classFilterOf(asked: string | null | undefined, classes: readonly Pick<ClassRow, 'id'>[]): string {
  if (!asked || asked === ALL) return ALL
  if (asked === EVERY) return EVERY
  return classes.some((entry) => entry.id === asked) ? asked : ALL
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/** The rows the class filter and the search keep, in the list's order. */
export function visibleRows(rows: readonly SymptomRow[], filter: string, query: string): SymptomRow[] {
  const q = fold(query.trim())
  return rows.filter((row) => {
    if (filter === EVERY && row.classId !== null) return false
    if (filter !== ALL && filter !== EVERY && row.classId !== null && row.classId !== filter) return false
    if (!q) return true
    return [row.code, row.labelIt, row.labelEn].some((text) => fold(text).includes(q))
  })
}

/** The list's order (as the floor's tiles show it): sortOrder, then code. */
export function inOrder(rows: readonly SymptomRow[]): SymptomRow[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
}

/** "Every machine", or the class's words in the page's language (a retired class says so). */
export function classWords(classId: string | null, classes: readonly ClassRow[], locale: Locale): { key: 'for.every' } | { key: 'for.class' | 'for.retired'; words: string } | { key: 'for.unknown' } {
  if (classId === null) return { key: 'for.every' }
  const found = classes.find((entry) => entry.id === classId)
  if (!found) return { key: 'for.unknown' }
  return { key: found.active ? 'for.class' : 'for.retired', words: labelOf(found, locale) }
}

/** A code as it is typed: upper case, spaces and hyphens become underscores. */
export const typedCode = (text: string): string => text.toUpperCase().replace(/[\s-]+/g, '_').slice(0, 40)

/** Why "Add symptom" is held (a `plant-settings` key), or null. */
export function draftHeld(draft: SymptomDraft, codes: readonly string[], busy: boolean): string | null {
  if (busy) return 'held.busy'
  const code = draft.code.trim()
  if (!code) return 'held.noCode'
  if (!PLANT_CODE.test(code)) return 'held.badCode'
  if (codes.includes(code)) return 'held.codeTaken'
  if (!draft.labelIt.trim() || !draft.labelEn.trim()) return 'held.noWords'
  if (draft.labelIt.trim().length > PLANT_LIMITS.label || draft.labelEn.trim().length > PLANT_LIMITS.label) return 'problem.tooLong'
  return null
}

/** The body of a new symptom, trimmed. */
export function draftBody(draft: SymptomDraft): NewSymptomBody {
  return { code: draft.code.trim(), classId: draft.classId, labelIt: draft.labelIt.trim(), labelEn: draft.labelEn.trim(), icon: draft.icon, unsafe: draft.unsafe, needsDetail: draft.needsDetail }
}

/** What one edited word cell sends, or the key of why it is not sent (never blank, at most 80 characters); unchanged: null. */
export function wordEdit(row: SymptomRow, field: 'labelIt' | 'labelEn', typed: unknown): { edit: SymptomEdit } | { problem: string } | null {
  const text = typeof typed === 'string' ? typed.trim() : typed === null || typed === undefined ? '' : String(typed).trim()
  if (!text) return { problem: field === 'labelIt' ? 'problem.labelIt' : 'problem.labelEn' }
  if (text.length > PLANT_LIMITS.label) return { problem: 'problem.tooLong' }
  if (text === row[field]) return null
  return { edit: { version: row.version, [field]: text } }
}

/** The row as the screen shows it at once, before the answer. */
export function withEdit(row: SymptomRow, edit: Omit<SymptomEdit, 'version'>): SymptomRow {
  const next: SymptomRow = { ...row }
  if (edit.labelIt !== undefined) next.labelIt = edit.labelIt
  if (edit.labelEn !== undefined) next.labelEn = edit.labelEn
  if (edit.icon !== undefined) next.icon = edit.icon
  if (edit.unsafe !== undefined) next.unsafe = edit.unsafe
  if (edit.needsDetail !== undefined) next.needsDetail = edit.needsDetail
  if (edit.active !== undefined) next.active = edit.active
  if (edit.sortOrder !== undefined) next.sortOrder = edit.sortOrder
  return next
}

/** The fields of an edit set back to the row's values before it (a refused save puts back what was there). */
export function reverseOf(before: SymptomRow, edit: Omit<SymptomEdit, 'version'>): Omit<SymptomEdit, 'version'> {
  const back: Omit<SymptomEdit, 'version'> = {}
  if (edit.labelIt !== undefined) back.labelIt = before.labelIt
  if (edit.labelEn !== undefined) back.labelEn = before.labelEn
  if (edit.icon !== undefined) back.icon = before.icon
  if (edit.unsafe !== undefined) back.unsafe = before.unsafe
  if (edit.needsDetail !== undefined) back.needsDetail = before.needsDetail
  if (edit.active !== undefined) back.active = before.active
  if (edit.sortOrder !== undefined) back.sortOrder = before.sortOrder
  return back
}

/** The cell an edit belongs to (its save mark). */
export function fieldOfEdit(edit: Omit<SymptomEdit, 'version'>): CellField {
  if (edit.labelIt !== undefined) return 'labelIt'
  if (edit.labelEn !== undefined) return 'labelEn'
  if (edit.icon !== undefined) return 'icon'
  if (edit.unsafe !== undefined) return 'unsafe'
  if (edit.needsDetail !== undefined) return 'needsDetail'
  return 'active'
}

/**
 * An API refusal (or no answer) in this page's words: a `plant-settings` key, and whether the answer is unknown. `create`:
 * a 409 is a code already taken (or the group's limit); an edit's 409 is a version read before someone else's change.
 */
export function problemOf(error: unknown, write: 'create' | 'edit' = 'edit'): { key: string; unknown: boolean } {
  if (!isApiError(error)) return { key: 'problem.failed', unknown: true }
  const first = error.issues[0]?.message ?? error.message ?? ''
  switch (error.kind) {
    case 'conflict':
      if (write === 'create') return { key: /at most/i.test(first) ? 'problem.tooMany' : /retired/i.test(first) ? 'problem.codeTakenRetired' : 'problem.codeTaken', unknown: false }
      return { key: 'problem.stale', unknown: false }
    case 'invalid': {
      const field = error.issues.map((issue) => issuePath(issue).replace(/^body[./]/, '').split(/[./]/)[0]).find(Boolean)
      if (field === 'code' || field === 'labelIt' || field === 'labelEn' || field === 'icon' || field === 'classId') return { key: `problem.${field}`, unknown: false }
      return { key: 'problem.invalid', unknown: false }
    }
    case 'forbidden':
    case 'step_up':
      return { key: 'problem.forbidden', unknown: false }
    case 'not_found':
      return { key: 'problem.gone', unknown: false }
    case 'signed_out':
      return { key: 'problem.signedOut', unknown: false }
    case 'unavailable':
      return { key: 'problem.offline', unknown: true }
    default:
      return { key: 'problem.failed', unknown: true }
  }
}

/** A failed read in words: never drawn as an empty list. */
export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.readForbidden'
  if (error.kind === 'unavailable') return 'problem.offline'
  return 'problem.read'
}

/** Why the bulk "Stop offering / Offer again" is held, or null. */
export function activeHeld(picked: readonly SymptomRow[], active: boolean, busy: boolean): string | null {
  if (busy) return 'held.busy'
  if (!picked.some((row) => row.active !== active)) return active ? 'held.allOffered' : 'held.noneOffered'
  return null
}

/** The order of the whole list after moving the chosen rows one place, or null when nothing would move. */
export function moveOf(rows: readonly SymptomRow[], chosen: readonly string[], delta: -1 | 1): string[] | null {
  const order = inOrder(rows).map((row) => row.id)
  const next = movedOrder(order, chosen, delta)
  return next.every((id, index) => id === order[index]) ? null : next
}

/** Why Move up / Move down is held (the order is the whole list's: no search, no class filter), or null. */
export function moveHeld(rows: readonly SymptomRow[], chosen: readonly string[], delta: -1 | 1, busy: boolean, narrowed: boolean): string | null {
  if (busy) return 'held.busy'
  if (narrowed) return 'held.narrowed'
  return moveOf(rows, chosen, delta) ? null : delta === -1 ? 'held.atTop' : 'held.atBottom'
}

/**
 * The writes that give the list a new order: each row whose place changed takes the sort value its new place has. The
 * values the list already holds are kept (only the moved rows change) when they rise strictly; else the list is numbered
 * again in tens.
 */
export function orderWrites(rows: readonly SymptomRow[], order: readonly string[]): { id: string; version: number; sortOrder: number }[] {
  const ordered = inOrder(rows)
  const byId = new Map(ordered.map((row) => [row.id, row]))
  const values = ordered.map((row) => row.sortOrder)
  const rising = values.every((value, index) => index === 0 || value > values[index - 1]!)
  const slots = rising ? values : ordered.map((_, index) => (index + 1) * 10)
  return order.flatMap((id, index) => {
    const row = byId.get(id)
    if (!row || row.sortOrder === slots[index]) return []
    return [{ id, version: row.version, sortOrder: slots[index]! }]
  })
}

/** What the floor will offer one class now (its own and every machine's, offered ones only): the preview's count. */
export const offeredFor = (rows: readonly SymptomRow[], classId: string): number => rows.filter((row) => row.active && (row.classId === null || row.classId === classId)).length
