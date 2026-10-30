import type { ReasonList } from '@nexus/factory-domain/reasons/lists'
import { movedOrder, REASON_CODE, REASON_LIMITS } from '@nexus/factory-domain/reasons/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { NewReasonBody, Reason, ReasonEdit, ReasonListView } from './api'

/**
 * The shared reason list editor's rules (B-W2a-18; SCR-242), pure: what a cell edit sends, what holds a button and why
 * (in the `reasons` catalogue's words), what an API refusal means in words, the search, the moves. The hosts (Production ›
 * Floor rules & codes, Sales settings, …) pass which lists they show; the editor reads, saves and words them the same way.
 */

export const REASON_NAMESPACES = ['reasons', 'lists'] as const

/** A cell's own save (design: autosave per cell; DS CellSaveMark shapes). */
export type MarkState = 'saving' | 'saved' | 'refused' | 'unknown'
export interface Mark {
  readonly state: MarkState
  /** A `reasons` key: why it was refused, or what is not known. */
  readonly problem?: string
}
export const markKey = (id: string, field: string): string => `${id}:${field}`

/** The editable cells: the words in Italian, English and each other floor language (`lang:ro`), the look, two switches. */
export type CellField = 'labelIt' | 'labelEn' | `lang:${string}` | 'look' | 'needsDetail' | 'active'

export interface Notice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  /** A `reasons` key and its values. */
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export interface ReasonDraft {
  code: string
  labelIt: string
  labelEn: string
  /** The other floor languages' words, by language code. */
  words: Record<string, string>
  icon: string | null
  colour: string | null
  needsDetail: boolean
}
export const EMPTY_DRAFT: ReasonDraft = Object.freeze({ code: '', labelIt: '', labelEn: '', words: {}, icon: null, colour: null, needsDetail: false }) as ReasonDraft

/** Why "Add code" is held (a `reasons` key), or null. */
export function draftHeld(draft: ReasonDraft, codes: readonly string[], busy: boolean): string | null {
  if (busy) return 'held.busy'
  if (!draft.code.trim()) return 'held.noCode'
  if (!REASON_CODE.test(draft.code.trim())) return 'held.badCode'
  if (codes.includes(draft.code.trim())) return 'held.codeTaken'
  if (!draft.labelIt.trim() || !draft.labelEn.trim()) return 'held.noWords'
  return null
}

/** The body of a new reason: trimmed, only the other languages that have words, the look only where the list keeps it. */
export function draftBody(draft: ReasonDraft, view: Pick<ReasonListView, 'fields'>): NewReasonBody {
  const words = Object.fromEntries(Object.entries(draft.words).filter(([, text]) => text.trim() !== '').map(([language, text]) => [language, text.trim()]))
  return {
    code: draft.code.trim(),
    labelIt: draft.labelIt.trim(),
    labelEn: draft.labelEn.trim(),
    ...(view.fields.languages && Object.keys(words).length > 0 ? { labelI18n: words } : {}),
    ...(view.fields.icon ? { icon: draft.icon } : {}),
    ...(view.fields.colour ? { colour: draft.colour } : {}),
    ...(view.fields.needsDetail ? { needsDetail: draft.needsDetail } : {}),
  }
}

/** A code as it is typed: upper case, spaces and hyphens become underscores. */
export const typedCode = (text: string): string => text.toUpperCase().replace(/[\s-]+/g, '_').slice(0, 40)

/**
 * What one edited word cell sends, or the `reasons` key of why it is not sent: Italian and English are never blank;
 * another language left blank is taken out (the floor then reads English). Unchanged: nothing.
 */
export function wordEdit(row: Reason, field: CellField, typed: unknown): { edit: ReasonEdit } | { problem: string } | null {
  const text = typeof typed === 'string' ? typed.trim() : typed === null || typed === undefined ? '' : String(typed).trim()
  if (text.length > REASON_LIMITS.label) return { problem: 'problem.tooLong' }
  if (field === 'labelIt' || field === 'labelEn') {
    if (!text) return { problem: field === 'labelIt' ? 'problem.labelIt' : 'problem.labelEn' }
    if (text === row[field]) return null
    return { edit: { version: row.version, [field]: text } }
  }
  if (field.startsWith('lang:')) {
    const language = field.slice(5)
    const current = row.labelI18n[language] ?? ''
    if (text === current) return null
    return { edit: { version: row.version, labelI18n: { [language]: text || null } } }
  }
  return null
}

/** The row as the screen shows it at once, before the answer (an edit's fields applied). */
export function withEdit(row: Reason, edit: ReasonEdit): Reason {
  const words = { ...row.labelI18n }
  for (const [language, text] of Object.entries(edit.labelI18n ?? {})) {
    if (text === null) delete words[language]
    else words[language] = text
  }
  return {
    ...row,
    ...(edit.labelIt === undefined ? {} : { labelIt: edit.labelIt }),
    ...(edit.labelEn === undefined ? {} : { labelEn: edit.labelEn }),
    labelI18n: words,
    ...(edit.icon === undefined ? {} : { icon: edit.icon }),
    ...(edit.colour === undefined ? {} : { colour: edit.colour }),
    ...(edit.needsDetail === undefined ? {} : { needsDetail: edit.needsDetail }),
    ...(edit.active === undefined ? {} : { active: edit.active }),
  }
}

/** The cell an edit belongs to (its save mark). */
export function fieldOfEdit(edit: ReasonEdit): CellField {
  if (edit.labelIt !== undefined) return 'labelIt'
  if (edit.labelEn !== undefined) return 'labelEn'
  if (edit.labelI18n !== undefined) return `lang:${Object.keys(edit.labelI18n)[0] ?? ''}`
  if (edit.icon !== undefined || edit.colour !== undefined) return 'look'
  if (edit.needsDetail !== undefined) return 'needsDetail'
  return 'active'
}

/** An API refusal (or no answer) in this editor's words: a `reasons` key, and whether the answer is unknown. */
export function problemOf(error: unknown): { key: string; unknown: boolean } {
  if (!isApiError(error)) return { key: 'problem.failed', unknown: true }
  const paths = error.issues.map((issue) => issuePath(issue))
  const messages = error.issues.map((issue) => issue.message ?? '')
  switch (error.kind) {
    case 'conflict':
      if (paths.includes('body/code')) return { key: messages.some((message) => message.includes('inactive')) ? 'problem.codeTakenInactive' : 'problem.codeTaken', unknown: false }
      return { key: 'problem.stale', unknown: false }
    case 'invalid': {
      const field = paths.map((path) => path.replace(/^body\//, '').split('/')[0]).find(Boolean)
      if (field === 'code' || field === 'labelIt' || field === 'labelEn' || field === 'icon' || field === 'colour') return { key: `problem.${field}`, unknown: false }
      if (field === 'labelI18n') return { key: 'problem.language', unknown: false }
      if (field === 'reasons') return { key: 'problem.order', unknown: false }
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

/** A failed read in words (a `reasons` key): the editor never draws a failed read as an empty list. */
export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.readForbidden'
  if (error.kind === 'unavailable') return 'problem.offline'
  return 'problem.read'
}

/** The rows a search keeps: the code or any of the words (any language), ignoring case and accents. */
export function searchRows(rows: readonly Reason[], query: string): Reason[] {
  const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  const q = fold(query.trim())
  if (!q) return [...rows]
  return rows.filter((row) => [row.code, row.labelIt, row.labelEn, ...Object.values(row.labelI18n)].some((text) => fold(text).includes(q)))
}

/** Why the bulk "Set inactive / Set active" is held (a `reasons` key), or null. */
export function activeHeld(picked: readonly Reason[], active: boolean, busy: boolean): string | null {
  if (busy) return 'held.busy'
  if (!picked.some((row) => row.active !== active)) return active ? 'held.allActive' : 'held.allInactive'
  return null
}

/** The list's order after moving the chosen rows one place, or null when nothing would move. */
export function moveOf(rows: readonly Reason[], chosen: readonly string[], delta: -1 | 1): string[] | null {
  const order = rows.map((row) => row.id)
  const next = movedOrder(order, chosen, delta)
  return next.every((id, index) => id === order[index]) ? null : next
}

/** Why Move up / Move down is held (a `reasons` key), or null. */
export function moveHeld(rows: readonly Reason[], chosen: readonly string[], delta: -1 | 1, busy: boolean, searching: boolean): string | null {
  if (busy) return 'held.busy'
  if (searching) return 'held.searching'
  return moveOf(rows, chosen, delta) ? null : delta === -1 ? 'held.atTop' : 'held.atBottom'
}

/** Why "Add N standard reasons" is held, or null (none missing: the button is not shown). */
export function standardHeld(canManage: boolean, busy: boolean): string | null {
  if (!canManage) return 'held.noManage'
  return busy ? 'held.busy' : null
}

/** A language named in the reader's language ("Romanian", "rumeno"); the code itself when the browser has no name. */
export function languageName(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code)
    return name ? name.charAt(0).toLocaleUpperCase(locale) + name.slice(1) : code
  } catch {
    return code
  }
}

/** The words a reader sees for a reason: their language's, else English. */
export const wordsIn = (row: Pick<Reason, 'labelIt' | 'labelEn' | 'labelI18n'>, locale: string): string => (locale === 'it' ? row.labelIt : locale === 'en' ? row.labelEn : (row.labelI18n[locale] ?? row.labelEn))

/** One write's live message, as the editor waits for it: its list and its codes (any order). */
export const echoKey = (list: string, codes: readonly string[]): string => `${list}|${[...codes].sort().join(',')}`

/** The list a host opens first: the one asked if it is among the host's lists, else the first. */
export const firstList = (lists: readonly ReasonList[], asked: string | null | undefined): ReasonList => (lists.find((list) => list === asked) ?? lists[0]!) as ReasonList
