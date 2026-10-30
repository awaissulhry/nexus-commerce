import type { Issue } from '../core/errors'
import { REASON_CODE } from '../production/scans/reasons'
import { fieldsOf, type ReasonList } from './lists'

/**
 * The rules of keeping a reason list (B-W2a-18; PLT-116), pure; the API says them in words before the database's guards
 * (…_platform_w2a_guards ReasonCode, …_production_scan_records_guards ScrapReason) would refuse the same:
 *
 *   - a code is upper-case letters, digits and underscores (2-40), unique in its list, and never changes;
 *   - the Italian and English words are never blank (at most 80 characters); the other floor languages are words keyed
 *     by an ISO 639 code (2-3 lower-case letters), never blank;
 *   - an icon is one of the design system's tag icons, a colour one of its swatches (the same closed sets the IconPicker
 *     and ColorSwatchPicker offer, so a stored value always draws), or none;
 *   - a list keeps what its source keeps (lists.ts fieldsOf): a scan list has no icon, colour, other language or note;
 *   - a reason is set inactive, never deleted; its order is the list's tile order.
 */

export { REASON_CODE }

export const REASON_LIMITS = Object.freeze({ label: 80, languages: 12, perRequest: 200, perList: 200 })

/** The design system's tag icon ids (packages/ui primitives/icons/tag-icons TAG_ICONS; the web's test compares them). */
export const REASON_ICONS = Object.freeze([
  'star', 'heart', 'flag', 'bookmark', 'sparkles', 'zap', 'flame', 'snowflake', 'sun', 'leaf', 'gift', 'package',
  'box', 'truck', 'shirt', 'award', 'crown', 'gem', 'shield', 'alert', 'clock', 'calendar', 'percent', 'camera',
] as const)

/** The design system's swatches (packages/ui tokens/colors.ts tagSwatches; the web's test compares them). */
export const REASON_COLOURS = Object.freeze([
  '#1f6fde', '#15a34a', '#059669', '#65a30d', '#b87503', '#ea580c', '#e5484d', '#f43f5e',
  '#be185d', '#c026d3', '#7400bc', '#8b5cf6', '#6366f1', '#0e7490', '#8d6e63', '#5b6573',
] as const)

/** A language of the other words: ISO 639-1 or -2 (the database's guard says the same). */
export const LANGUAGE_CODE = /^[a-z]{2,3}$/

/** The words a reason keeps in the floor's other languages: `{ "ro": "…" }`. */
export type ReasonWords = Readonly<Record<string, string>>

/** What a new reason or a change of one brings (only the fields present are checked). */
export interface ReasonDraft {
  readonly code?: string | undefined
  readonly labelIt?: string | undefined
  readonly labelEn?: string | undefined
  /** A change: a language with null is taken out. */
  readonly labelI18n?: Readonly<Record<string, string | null>> | undefined
  readonly icon?: string | null | undefined
  readonly colour?: string | null | undefined
  readonly needsDetail?: boolean | undefined
}

const blank = (value: string | undefined) => value !== undefined && value.trim() === ''

/** The problems of a draft, each at its field (`code`, `labelIt`, `labelI18n/ro`, `icon` …). */
export function reasonDraftProblems(list: ReasonList, draft: ReasonDraft): Issue[] {
  const fields = fieldsOf(list)
  const problems: Issue[] = []
  if (draft.code !== undefined && !REASON_CODE.test(draft.code)) problems.push({ path: 'code', message: 'A code is 2 to 40 upper-case letters, digits and underscores, starting with a letter (WRONG_SIZE).' })
  for (const field of ['labelIt', 'labelEn'] as const) {
    const value = draft[field]
    if (blank(value)) problems.push({ path: field, message: field === 'labelIt' ? 'Say the reason in Italian.' : 'Say the reason in English.' })
    else if (value !== undefined && value.trim().length > REASON_LIMITS.label) problems.push({ path: field, message: `At most ${REASON_LIMITS.label} characters.` })
  }
  if (draft.labelI18n !== undefined) {
    if (!fields.languages) problems.push({ path: 'labelI18n', message: 'Scrap and rework reasons keep words in Italian and English only.' })
    else {
      const entries = Object.entries(draft.labelI18n)
      if (entries.length > REASON_LIMITS.languages) problems.push({ path: 'labelI18n', message: `At most ${REASON_LIMITS.languages} other languages.` })
      for (const [language, words] of entries) {
        if (!LANGUAGE_CODE.test(language) || language === 'it' || language === 'en') problems.push({ path: `labelI18n/${language}`, message: 'A language is its ISO 639 code (ro, ur, zh); Italian and English have their own words.' })
        else if (words !== null && words.trim() === '') problems.push({ path: `labelI18n/${language}`, message: 'Leave a language out instead of blank words.' })
        else if (words !== null && words.trim().length > REASON_LIMITS.label) problems.push({ path: `labelI18n/${language}`, message: `At most ${REASON_LIMITS.label} characters.` })
      }
    }
  }
  if (draft.icon !== undefined && draft.icon !== null) {
    if (!fields.icon) problems.push({ path: 'icon', message: 'Scrap and rework reasons have no icon yet.' })
    else if (!(REASON_ICONS as readonly string[]).includes(draft.icon)) problems.push({ path: 'icon', message: 'Pick one of the icons offered.' })
  }
  if (draft.colour !== undefined && draft.colour !== null) {
    if (!fields.colour) problems.push({ path: 'colour', message: 'Scrap and rework reasons have no colour yet.' })
    else if (!(REASON_COLOURS as readonly string[]).includes(draft.colour.toLowerCase())) problems.push({ path: 'colour', message: 'Pick one of the colours offered.' })
  }
  if (draft.needsDetail === true && !fields.needsDetail) problems.push({ path: 'needsDetail', message: 'Scrap and rework reasons cannot ask for a note yet.' })
  return problems
}

/** The other languages after a change: null takes a language out, words replace it, the rest stays (trimmed). */
export function mergedWords(current: ReasonWords, change: Readonly<Record<string, string | null>> | undefined): Record<string, string> {
  const next: Record<string, string> = { ...current }
  for (const [language, words] of Object.entries(change ?? {})) {
    if (words === null) delete next[language]
    else next[language] = words.trim()
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)))
}

/** The stored words of a language (it, en, else the other languages), else the English words. */
export function reasonLabel(reason: { readonly labelIt: string; readonly labelEn: string; readonly labelI18n?: ReasonWords | null | undefined }, language: string): string {
  if (language === 'it') return reason.labelIt
  if (language === 'en') return reason.labelEn
  return reason.labelI18n?.[language] ?? reason.labelEn
}

/** The sort orders of a list in this order: 10, 20, 30 … (room for a later insert by hand). */
export const sortOrdersOf = (ids: readonly string[]): Map<string, number> => new Map(ids.map((id, index) => [id, (index + 1) * 10]))

/** The sort order a new reason takes: after the list's last one. */
export const nextSortOrder = (orders: Iterable<number>): number => {
  let max = 0
  for (const order of orders) max = Math.max(max, order)
  return Math.floor(max / 10) * 10 + 10
}

/**
 * The list's order after moving the chosen reasons one place up (-1) or down (1): each moves past its neighbour unless
 * that neighbour is chosen too and cannot move (a block at the edge stays). The others keep their order.
 */
export function movedOrder(order: readonly string[], chosen: readonly string[], delta: -1 | 1): string[] {
  const next = [...order]
  const picked = new Set(chosen)
  const indexes = next.map((_, index) => index)
  const walk = delta === -1 ? indexes : indexes.reverse()
  for (const index of walk) {
    const id = next[index]!
    if (!picked.has(id)) continue
    const target = index + delta
    if (target < 0 || target >= next.length || picked.has(next[target]!)) continue
    next[index] = next[target]!
    next[target] = id
  }
  return next
}

/** A reorder names every reason of the list exactly once: the problems if not. */
export function orderProblems(listIds: readonly string[], sent: readonly string[]): Issue[] {
  const known = new Set(listIds)
  const seen = new Set<string>()
  const problems: Issue[] = []
  sent.forEach((id, index) => {
    if (!known.has(id)) problems.push({ path: `reasons/${index}/id`, message: 'Not a reason of this list.' })
    else if (seen.has(id)) problems.push({ path: `reasons/${index}/id`, message: 'Named twice.' })
    seen.add(id)
  })
  const missing = listIds.filter((id) => !seen.has(id))
  if (missing.length > 0) problems.push({ path: 'reasons', message: `Send every reason of the list once: ${missing.length} ${missing.length === 1 ? 'is' : 'are'} missing (reload the list).` })
  return problems
}
