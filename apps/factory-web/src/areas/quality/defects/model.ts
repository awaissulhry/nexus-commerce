import {
  CLASS_RANK,
  DEFECT_CLASSES,
  defectDraftProblems,
  DISPOSITION_OUTCOMES,
  dispositionDraftProblems,
  labelIn,
  OUTCOME_RULES,
  QUALITY_STAGES,
  sortedStages,
  type DefectClass,
  type DispositionFollowUp,
  type DispositionMove,
  type DispositionOutcome,
  type QualityStage,
} from '@nexus/factory-domain/quality/defects/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { LiveState } from '../_shared/model'
import type { DefectCategory, DefectCode, DefectEdit, Disposition, DispositionEdit, Dispositions, Library, NewDefectBody, NewDispositionBody, OutcomeOption } from './api'

/**
 * The rules of Quality › Defects & dispositions (SCR-079; design quality.defects df-tabs, df-library, df-dispositions,
 * df-drawer, df-retire), without React and without the API: the address (tab, rows, search, the open code, a new one),
 * the library as a tree (category › defect), a cell's change → the PATCH it sends (or why not, in our words), the save
 * marks, the held reasons said before the click, the drafts of a new defect and a new disposition (the domain's own
 * checks, at their fields), the stock action of a code in our words, the CSV. Message keys are the `defects` catalogue's.
 */

// ---- the address -----------------------------------------------------------------------------------------------------------

/** The page's link tabs (design df-tabs): Defects and Dispositions built; Severity, Causes and Leather grades come in W2b. */
export const TABS = ['defects', 'severity', 'causes', 'dispositions', 'grades'] as const
export type Tab = (typeof TABS)[number]
export const BUILT_TABS: readonly Tab[] = ['defects', 'dispositions']
export type BuiltTab = 'defects' | 'dispositions'

/** The library's rows: every code, the active ones, the retired ones. */
export const LIBRARY_VIEWS = ['all', 'active', 'retired'] as const
export type LibraryView = (typeof LIBRARY_VIEWS)[number]

export interface Address {
  readonly tab: BuiltTab
  readonly view: LibraryView
  readonly q: string
  /** `?open=<id>`: a code in its drawer (a defect or a category; on Dispositions a disposition). */
  readonly open: string | null
  /** `?new=1`: Add defect (Defects) or Add disposition (Dispositions). */
  readonly isNew: boolean
}

type Params = { get(name: string): string | null } | null | undefined

export function addressOf(params: Params): Address {
  const tab = params?.get('tab')
  const view = params?.get('view')
  return {
    tab: tab === 'dispositions' ? 'dispositions' : 'defects',
    view: view && (LIBRARY_VIEWS as readonly string[]).includes(view) ? (view as LibraryView) : 'all',
    q: (params?.get('q') ?? '').slice(0, 80),
    open: params?.get('open') || null,
    isNew: params?.get('new') === '1',
  }
}

/** The page's address for an address (only what differs from the defaults). */
export function queryOf(address: Partial<Address> & Pick<Address, 'tab'>): string {
  const query = new URLSearchParams()
  if (address.tab !== 'defects') query.set('tab', address.tab)
  if (address.view && address.view !== 'all') query.set('view', address.view)
  if (address.q) query.set('q', address.q)
  if (address.open) query.set('open', address.open)
  if (address.isNew) query.set('new', '1')
  const text = query.toString()
  return text ? `?${text}` : ''
}

// ---- the library as a tree -------------------------------------------------------------------------------------------------

export interface LibraryRow {
  readonly id: string
  readonly kind: 'category' | 'defect'
  readonly code: DefectCode
  /** The category (a category: itself). */
  readonly category: DefectCode
  /** A category: its defects (all of them, whatever the view shows). */
  readonly defects: number
}

const fold = (text: string): string => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/** A code matches the search: its code or any of its words, ignoring case and accents. */
export function matches(code: Pick<DefectCode, 'code' | 'labelIt' | 'labelEn' | 'labelI18n'>, q: string): boolean {
  const query = fold(q.trim())
  if (!query) return true
  return [code.code, code.labelIt, code.labelEn, ...Object.values(code.labelI18n)].some((text) => fold(text).includes(query))
}

const inView = (code: Pick<DefectCode, 'active'>, view: LibraryView): boolean => view === 'all' || (view === 'active' ? code.active : !code.active)

/**
 * The rows the list frame draws: each category, then its defects under it. A category shows when it is in the view and
 * matches the search, or when one of its defects does (then only those defects show).
 */
export function libraryRows(library: Pick<Library, 'categories'> | null, view: LibraryView, q: string): LibraryRow[] {
  if (!library) return []
  const rows: LibraryRow[] = []
  for (const category of library.categories) {
    const own = inView(category, view) && matches(category, q)
    // A search that names the category shows all its defects (in the view); else the defects that match themselves.
    const defects = category.defects.filter((defect) => inView(defect, view) && (matches(defect, q) || (!!q.trim() && matches(category, q))))
    if (!own && defects.length === 0) continue
    rows.push({ id: category.id, kind: 'category', code: category, category, defects: category.defects.length })
    for (const defect of defects) rows.push({ id: defect.id, kind: 'defect', code: defect, category, defects: 0 })
  }
  return rows
}

/** Every code of the library (categories and defects), in tree order. */
export const allCodes = (library: Pick<Library, 'categories'> | null): DefectCode[] => (library ? library.categories.flatMap((category) => [category, ...category.defects]) : [])

/** A code by id, with its category. */
export function findCode(library: Pick<Library, 'categories'> | null, id: string | null): { code: DefectCode; category: DefectCategory } | null {
  if (!library || !id) return null
  for (const category of library.categories) {
    if (category.id === id) return { code: category, category }
    const defect = category.defects.find((entry) => entry.id === id)
    if (defect) return { code: defect, category }
  }
  return null
}

/** The library with one code replaced by the API's answer (a category keeps its defects). */
export function withCode(library: Library, code: DefectCode): Library {
  return {
    ...library,
    categories: library.categories.map((category) =>
      category.id === code.id ? { ...category, ...code, defects: category.defects } : { ...category, defects: category.defects.map((defect) => (defect.id === code.id ? code : defect)) },
    ),
  }
}

/** The library without a deleted code. */
export function withoutCode(library: Library, id: string): Library {
  return { ...library, categories: library.categories.filter((category) => category.id !== id).map((category) => ({ ...category, defects: category.defects.filter((defect) => defect.id !== id) })) }
}

/** The library with a new code (a category at the end, a defect under its category). */
export function withNewCode(library: Library, code: DefectCode): Library {
  if (code.parentId === null) return { ...library, categories: [...library.categories, { ...code, defects: [] }] }
  return { ...library, categories: library.categories.map((category) => (category.id === code.parentId ? { ...category, defects: [...category.defects, code] } : category)) }
}

/** The ids of the drawer's walk (⌘↑ / ⌘↓): the rows the list shows, in order. */
export function stepOpen(rows: readonly { id: string }[], current: string | null, delta: 1 | -1): string | null {
  if (rows.length === 0) return null
  const index = current ? rows.findIndex((row) => row.id === current) : -1
  if (index < 0) return rows[0]!.id
  const next = index + delta
  return next < 0 || next >= rows.length ? null : rows[next]!.id
}

// ---- words of a code ---------------------------------------------------------------------------------------------------------

/** A code's words in the page's language. */
export const wordsOf = (code: Pick<DefectCode, 'labelIt' | 'labelEn' | 'labelI18n'>, locale: string): string => labelIn(code, locale)

/** The stages in the factory's order; none = every stage (a key). */
export const stagesOf = (code: Pick<DefectCode, 'stages'>): QualityStage[] => sortedStages(code.stages)

/** The other floor languages a code has words in (not it/en), sorted. */
export const otherLanguages = (code: Pick<DefectCode, 'labelI18n'>): string[] => Object.keys(code.labelI18n).sort()

// ---- cell changes -----------------------------------------------------------------------------------------------------------

export type DefectField = 'labelIt' | 'labelEn' | 'severity' | 'active' | 'zone' | 'stages' | 'needsDetail' | 'look' | 'sortOrder' | 'picture' | `lang:${string}`
export type DispositionField = 'labelIt' | 'labelEn' | 'reinspection' | 'approvalSeverity' | 'approvalAmount' | 'active' | 'sortOrder'

export type MarkState = 'saving' | 'saved' | 'refused' | 'unknown'
export interface Mark {
  readonly state: MarkState
  /** Refused or unknown: a `defects` key. */
  readonly problem?: string
}
export const markKey = (id: string, field: string): string => `${id}:${field}`

export type Change<E> = { edit: E } | { problem: string } | null

const LABEL_MAX = 80

function wordsChange(field: 'labelIt' | 'labelEn', before: string, typed: unknown): Change<{ labelIt?: string; labelEn?: string }> {
  const text = typeof typed === 'string' ? typed.trim() : ''
  if (text === before) return null
  if (!text) return { problem: field === 'labelIt' ? 'problem.labelIt' : 'problem.labelEn' }
  if (text.length > LABEL_MAX) return { problem: 'problem.tooLong' }
  return { edit: { [field]: text } }
}

/**
 * A cell or drawer change of a defect or category → the PATCH it sends (only that field), or its problem in our words
 * (a `defects` key), or null when nothing changed. A category has no class, zone or "asks for a note".
 */
export function defectChange(code: DefectCode, field: DefectField, value: unknown): Change<DefectEdit> {
  const isCategory = code.parentId === null
  if (field === 'labelIt' || field === 'labelEn') return wordsChange(field, code[field], value)
  if (field.startsWith('lang:')) {
    const language = field.slice(5)
    const text = typeof value === 'string' ? value.trim() : ''
    const before = code.labelI18n[language] ?? ''
    if (text === before) return null
    if (text.length > LABEL_MAX) return { problem: 'problem.tooLong' }
    return { edit: { labelI18n: { [language]: text || null } } }
  }
  if (field === 'severity') {
    if (isCategory) return { problem: 'problem.categorySeverity' }
    if (value === code.severity) return null
    if (!(DEFECT_CLASSES as readonly unknown[]).includes(value)) return { problem: 'problem.severity' }
    return { edit: { severity: value as DefectClass } }
  }
  if (field === 'zone') {
    if (isCategory) return { problem: 'problem.categoryZone' }
    const zone = (value as string | null) || null
    if (zone === code.zone) return null
    const problems = defectDraftProblems({ zone }, { isCategory: false, creating: false })
    return problems.length > 0 ? { problem: 'problem.zone' } : { edit: { zone } }
  }
  if (field === 'stages') {
    const stages = sortedStages(Array.isArray(value) ? (value as string[]) : [])
    if (stages.join(',') === sortedStages(code.stages).join(',')) return null
    return { edit: { stages } }
  }
  if (field === 'needsDetail') {
    if (isCategory) return { problem: 'problem.categoryDetail' }
    const on = value === true
    return on === code.needsDetail ? null : { edit: { needsDetail: on } }
  }
  if (field === 'active') {
    const on = value === true
    return on === code.active ? null : { edit: { active: on } }
  }
  if (field === 'sortOrder') {
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
    if (!/^\d{1,7}$/.test(text)) return { problem: 'problem.sortOrder' }
    const order = Number(text)
    return order === code.sortOrder ? null : { edit: { sortOrder: order } }
  }
  if (field === 'picture') {
    // Only taking the picture off goes through here; a new one is uploaded first (api.ts uploadPicture).
    return value === null && code.pictureFileId !== null ? { edit: { pictureFileId: null } } : null
  }
  if (field === 'look') {
    const look = (value ?? {}) as { icon?: string | null; colour?: string | null }
    const edit: DefectEdit = {}
    if (look.icon !== undefined && look.icon !== code.icon) edit.icon = look.icon
    if (look.colour !== undefined && (look.colour ?? null) !== (code.colour ?? null)) edit.colour = look.colour
    return Object.keys(edit).length === 0 ? null : { edit }
  }
  return null
}

/** A cell change of a disposition code → its PATCH, its problem, or null. `seesCost`: the person has the cost grain. */
export function dispositionChange(code: Disposition, field: DispositionField, value: unknown, seesCost: boolean): Change<DispositionEdit> {
  if (field === 'labelIt' || field === 'labelEn') return wordsChange(field, code[field], value)
  if (field === 'reinspection') {
    const on = value === true
    if (on === code.reinspection) return null
    if (on && code.outcome === 'USE_AS_IS') return { problem: 'problem.reinspectUseAsIs' }
    return { edit: { reinspection: on } }
  }
  if (field === 'approvalSeverity') {
    const next = (value as DefectClass | null) || null
    if (next === code.approvalSeverity) return null
    if (next !== null && !(DEFECT_CLASSES as readonly string[]).includes(next)) return { problem: 'problem.severity' }
    return { edit: { approvalSeverity: next } }
  }
  if (field === 'approvalAmount') {
    if (!seesCost || code.approvalAmount === undefined) return { problem: 'problem.noCost' }
    const parsed = parseAmount(typeof value === 'string' ? value : value === null ? '' : String(value))
    if (parsed === undefined) return { problem: 'problem.amount' }
    return parsed === code.approvalAmount ? null : { edit: { approvalAmount: parsed } }
  }
  if (field === 'active') {
    const on = value === true
    return on === code.active ? null : { edit: { active: on } }
  }
  if (field === 'sortOrder') {
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
    if (!/^\d{1,7}$/.test(text)) return { problem: 'problem.sortOrder' }
    return Number(text) === code.sortOrder ? null : { edit: { sortOrder: Number(text) } }
  }
  return null
}

/** The field a change saves (where its mark goes). */
export function fieldOfDefectEdit(edit: DefectEdit): DefectField {
  if (edit.labelIt !== undefined) return 'labelIt'
  if (edit.labelEn !== undefined) return 'labelEn'
  if (edit.labelI18n !== undefined) return `lang:${Object.keys(edit.labelI18n)[0] ?? ''}`
  if (edit.severity !== undefined) return 'severity'
  if (edit.zone !== undefined) return 'zone'
  if (edit.stages !== undefined) return 'stages'
  if (edit.needsDetail !== undefined) return 'needsDetail'
  if (edit.icon !== undefined || edit.colour !== undefined) return 'look'
  if (edit.pictureFileId !== undefined) return 'picture'
  if (edit.sortOrder !== undefined) return 'sortOrder'
  return 'active'
}

/**
 * A typed amount in the company's currency → minor units (cents): "120", "120,50", "1.200,50", "120.5"; empty = no
 * value rule (null); undefined = not an amount.
 */
export function parseAmount(text: string): number | null | undefined {
  const raw = text.trim().replace(/\s|€/g, '')
  if (!raw) return null
  let normal = raw
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(raw)) normal = raw.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(raw)) normal = raw.replace(/,/g, '')
  else normal = raw.replace(',', '.')
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(normal)) return undefined
  const [whole, fraction = ''] = normal.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

/** Minor units as an amount to type again ("120,50" in Italian, "120.50" in English). */
export const amountText = (minor: number | null | undefined, locale: string): string => {
  if (minor === null || minor === undefined) return ''
  const text = (minor / 100).toFixed(2)
  return locale === 'it' ? text.replace('.', ',') : text
}

// ---- refusals in our words ------------------------------------------------------------------------------------------------------

const FIELD_PROBLEMS = new Set(['code', 'labelIt', 'labelEn', 'labelI18n', 'icon', 'colour', 'severity', 'zone', 'stages', 'needsDetail', 'sortOrder', 'parentId', 'pictureFileId', 'outcome', 'stockMoveReason', 'followUp', 'reinspection', 'approvalSeverity', 'approvalAmount'])

/** An API refusal (or no answer) in this page's words: a `defects` key, and whether the outcome is unknown. */
export function problemOf(error: unknown): { key: string; unknown: boolean } {
  if (!isApiError(error)) return { key: 'problem.failed', unknown: true }
  const paths = error.issues.map((issue) => issuePath(issue))
  switch (error.kind) {
    case 'conflict': {
      if (paths.includes('version')) return { key: 'problem.stale', unknown: false }
      const message = error.message
      if (/ is taken/.test(message)) return { key: /retired|inactive/.test(message) ? 'problem.codeTakenRetired' : 'problem.codeTaken', unknown: false }
      if (/at most/.test(message)) return { key: 'problem.libraryFull', unknown: false }
      if (/has defects/.test(message)) return { key: 'problem.categoryHasDefects', unknown: false }
      if (/is used on/.test(message)) return { key: 'problem.inUse', unknown: false }
      return { key: 'problem.conflict', unknown: false }
    }
    case 'invalid': {
      const field = paths.map((path) => path.replace(/^body\//, '').split('/')[0]!).find((name) => FIELD_PROBLEMS.has(name))
      if (field === 'labelI18n') return { key: 'problem.language', unknown: false }
      if (field === 'pictureFileId') return { key: 'problem.picture', unknown: false }
      if (field) return { key: `problem.${field}`, unknown: false }
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

/** The fields a 400 names (`body/<field>`), each with our words: the dialogs show them at their fields. */
export function fieldProblemsOf(error: unknown): Record<string, string> {
  if (!isApiError(error) || error.kind !== 'invalid') return {}
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const field = issuePath(issue).replace(/^body\//, '').split('/')[0]!
    if (FIELD_PROBLEMS.has(field) && !out[field]) out[field] = field === 'labelI18n' ? 'problem.language' : `problem.${field}`
  }
  return out
}

/** A failed read in words (a `defects` key): never drawn as an empty library. */
export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.readForbidden'
  if (error.kind === 'unavailable') return 'problem.offline'
  if (error.kind === 'signed_out') return 'problem.signedOut'
  return 'problem.read'
}

// ---- held reasons (said before the click) -------------------------------------------------------------------------------

/** Changing anything needs quality.defects.manage over every company (the API's `canManage`). */
export const manageHeld = (canManage: boolean): string | null => (canManage ? null : 'held.noManage')

/** Delete: only a code nothing names; a category with defects never. */
export function deleteHeld(row: Pick<LibraryRow, 'kind' | 'code' | 'defects'>, canManage: boolean): { key: string; params?: Record<string, string | number> } | null {
  if (!canManage) return { key: 'held.noManage' }
  if (row.kind === 'category' && row.defects > 0) return { key: 'held.categoryHasDefects', params: { count: row.defects } }
  if (row.code.usedCount > 0) return { key: 'held.used', params: { count: row.code.usedCount } }
  return null
}

/** Retire / Restore of the selected codes: held when none of them would change. */
export function bulkActiveHeld(picked: readonly Pick<DefectCode, 'active'>[], active: boolean, canManage: boolean, busy: boolean): string | null {
  if (!canManage) return 'held.noManage'
  if (busy) return 'held.busy'
  if (picked.length === 0) return 'held.pickRows'
  if (!picked.some((code) => code.active !== active)) return active ? 'held.allActive' : 'held.allRetired'
  return null
}

/** Add defect under a category: held for a retired category (its defects would not reach the pickers). */
export function addUnderHeld(category: Pick<DefectCode, 'active'>, canManage: boolean): string | null {
  if (!canManage) return 'held.noManage'
  return category.active ? null : 'held.categoryRetired'
}

/** The words of retiring codes (design df-retire): used codes stay on their records and leave the pickers. */
export function retireLines(codes: readonly Pick<DefectCode, 'code' | 'usedCount' | 'parentId'>[], childCounts: Readonly<Record<string, number>>): { key: string; params: Record<string, string | number> }[] {
  return codes.map((code): { key: string; params: Record<string, string | number> } => {
    if (code.parentId === null) return { key: 'retire.category', params: { code: code.code, count: childCounts[code.code] ?? 0 } }
    return code.usedCount > 0 ? { key: 'retire.used', params: { code: code.code, count: code.usedCount } } : { key: 'retire.unused', params: { code: code.code } }
  })
}

// ---- a new defect -------------------------------------------------------------------------------------------------------------

export interface NewDefectDraft {
  /** A defect (under a category) or a new category. */
  readonly kind: 'defect' | 'category'
  readonly parentId: string | null
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly severity: DefectClass | null
  readonly zone: string | null
  readonly stages: readonly string[]
  readonly needsDetail: boolean
}

export const NEW_DEFECT: NewDefectDraft = Object.freeze({ kind: 'defect', parentId: null, code: '', labelIt: '', labelEn: '', severity: 'MAJOR', zone: null, stages: [], needsDetail: false })

/** A typed code as the library keeps it: upper case, spaces as hyphens (a disposition: underscores). */
export const typedCode = (text: string, kind: 'defect' | 'disposition' = 'defect'): string =>
  text
    .toUpperCase()
    .replace(/\s+/g, kind === 'defect' ? '-' : '_')
    .replace(kind === 'defect' ? /[^A-Z0-9_-]/g : /[^A-Z0-9_]/g, '')
    .slice(0, 40)

/** The new defect's problems at their fields (the domain's own checks), as `defects` keys. */
export function newDefectProblems(draft: NewDefectDraft, library: Pick<Library, 'categories'> | null): Record<string, string> {
  const isCategory = draft.kind === 'category'
  const parent = isCategory ? undefined : draft.parentId ? (library?.categories.find((category) => category.id === draft.parentId) ? { isCategory: true } : null) : null
  const problems = defectDraftProblems(
    {
      code: draft.code,
      parentId: isCategory ? null : draft.parentId,
      labelIt: draft.labelIt,
      labelEn: draft.labelEn,
      ...(isCategory ? {} : { severity: draft.severity, zone: draft.zone, needsDetail: draft.needsDetail }),
      stages: [...draft.stages],
    },
    { isCategory, creating: true, parent },
  )
  const out: Record<string, string> = {}
  for (const problem of problems) {
    const field = problem.path.split('/')[0]!
    if (!out[field]) out[field] = field === 'labelI18n' ? 'problem.language' : `problem.${field}`
  }
  const taken = allCodes(library).find((code) => code.code === draft.code.trim())
  if (taken && !out.code) out.code = taken.active ? 'problem.codeTaken' : 'problem.codeTakenRetired'
  return out
}

export function newDefectBody(draft: NewDefectDraft): NewDefectBody {
  const isCategory = draft.kind === 'category'
  return {
    code: draft.code.trim(),
    parentId: isCategory ? null : draft.parentId,
    labelIt: draft.labelIt.trim(),
    labelEn: draft.labelEn.trim(),
    severity: isCategory ? null : draft.severity,
    zone: isCategory ? null : draft.zone,
    stages: sortedStages(draft.stages),
    needsDetail: isCategory ? false : draft.needsDetail,
  }
}

// ---- dispositions ------------------------------------------------------------------------------------------------------------

/** Our words of what a code does with the stock and what it opens (the API's `stockAction` is English: data under it). */
export function stockActionKeys(code: Pick<Disposition, 'stockMoveReason' | 'followUp' | 'reinspection'>): { key: string }[] {
  const lines = [{ key: code.stockMoveReason ? `move.${code.stockMoveReason}` : 'move.none' }]
  if (code.followUp) lines.push({ key: `followUp.${code.followUp}` })
  if (code.reinspection) lines.push({ key: 'reinspection.yes' })
  return lines
}

export interface NewDispositionDraft {
  readonly outcome: DispositionOutcome | null
  readonly stockMoveReason: DispositionMove | null
  readonly followUp: DispositionFollowUp | null
  readonly reinspection: boolean
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly approvalSeverity: DefectClass | null
  /** Typed in the company's currency (only offered with the cost grain). */
  readonly approvalAmount: string
}

export const NEW_DISPOSITION: NewDispositionDraft = Object.freeze({ outcome: null, stockMoveReason: null, followUp: null, reinspection: false, code: '', labelIt: '', labelEn: '', approvalSeverity: null, approvalAmount: '' })

/** The options of an outcome: the API's (they are the domain's OUTCOME_RULES), else the domain's own. */
export function optionsOf(outcomes: readonly OutcomeOption[] | null | undefined, outcome: DispositionOutcome): { moves: (DispositionMove | null)[]; followUps: (DispositionFollowUp | null)[]; reinspection: boolean } {
  const option = outcomes?.find((entry) => entry.outcome === outcome)
  const rule = OUTCOME_RULES[outcome]
  return option ? { moves: [...option.moves], followUps: [...option.followUps], reinspection: option.reinspection } : { moves: [...rule.moves], followUps: [...rule.followUps], reinspection: rule.reinspection }
}

/** Picking an outcome sets its default move, follow-up and re-inspection (the first of each). */
export function withOutcome(draft: NewDispositionDraft, outcome: DispositionOutcome, outcomes: readonly OutcomeOption[] | null | undefined): NewDispositionDraft {
  const options = optionsOf(outcomes, outcome)
  return { ...draft, outcome, stockMoveReason: options.moves[0] ?? null, followUp: options.followUps[0] ?? null, reinspection: options.reinspection, code: draft.code || outcome }
}

export function newDispositionProblems(draft: NewDispositionDraft, codes: readonly string[], seesCost: boolean): Record<string, string> {
  const amount = seesCost ? parseAmount(draft.approvalAmount) : null
  const problems = dispositionDraftProblems(
    {
      code: draft.code,
      labelIt: draft.labelIt,
      labelEn: draft.labelEn,
      ...(draft.outcome ? { outcome: draft.outcome } : {}),
      stockMoveReason: draft.stockMoveReason,
      followUp: draft.followUp,
      reinspection: draft.reinspection,
      approvalSeverity: draft.approvalSeverity,
      ...(amount === undefined ? {} : { approvalAmount: amount }),
    },
    true,
  )
  const out: Record<string, string> = {}
  for (const problem of problems) {
    const field = problem.path.split('/')[0]!
    if (!out[field]) out[field] = `problem.${field}`
  }
  if (seesCost && amount === undefined) out.approvalAmount = 'problem.amount'
  if (!out.code && codes.includes(draft.code.trim())) out.code = 'problem.codeTaken'
  return out
}

export function newDispositionBody(draft: NewDispositionDraft, seesCost: boolean): NewDispositionBody {
  const amount = seesCost ? parseAmount(draft.approvalAmount) : undefined
  return {
    code: draft.code.trim(),
    labelIt: draft.labelIt.trim(),
    labelEn: draft.labelEn.trim(),
    outcome: draft.outcome!,
    stockMoveReason: draft.stockMoveReason,
    followUp: draft.followUp,
    reinspection: draft.reinspection,
    approvalSeverity: draft.approvalSeverity,
    // The amount is the cost grain: sent only by a person who has it (the API refuses it otherwise).
    ...(seesCost && amount !== undefined ? { approvalAmount: amount } : {}),
  }
}

/** The approval rule in words: by class (this class or worse), by value, both, or none (keys). */
export function approvalKeys(code: Pick<Disposition, 'approvalSeverity' | 'approvalAmount'>): { key: string; params?: Record<string, string> }[] {
  const lines: { key: string; params?: Record<string, string> }[] = []
  if (code.approvalSeverity) lines.push({ key: `approval.severity.${code.approvalSeverity}` })
  if (code.approvalAmount !== undefined && code.approvalAmount !== null) lines.push({ key: 'approval.amount' })
  if (lines.length === 0) lines.push({ key: code.approvalAmount === undefined ? 'approval.noneSeen' : 'approval.none' })
  return lines
}

/** The classes worse or equal to one (what "this class or worse" covers). */
export const classesFrom = (severity: DefectClass): DefectClass[] => DEFECT_CLASSES.filter((entry) => CLASS_RANK[entry] <= CLASS_RANK[severity])

export const OUTCOMES = DISPOSITION_OUTCOMES
export const STAGES = QUALITY_STAGES

// ---- CSV ------------------------------------------------------------------------------------------------------------------------

type T = (key: string, params?: Record<string, string | number>) => string

export const LIBRARY_CSV_HEAD = ['csv.category', 'csv.code', 'csv.it', 'csv.en', 'csv.severity', 'csv.zone', 'csv.stages', 'csv.needsDetail', 'csv.used', 'csv.status'] as const

export function libraryCsvRow(row: LibraryRow, t: T, zone: (id: string | null) => string): (string | number)[] {
  const code = row.code
  return [
    row.category.code,
    code.code,
    code.labelIt,
    code.labelEn,
    code.severity ? t(`severity.${code.severity}`) : '',
    zone(code.zone),
    code.stages.length === 0 ? t('stages.every') : stagesOf(code).map((stage) => t(`stage.${stage}`)).join(' · '),
    row.kind === 'defect' ? t(code.needsDetail ? 'csv.yes' : 'csv.no') : '',
    code.usedCount,
    t(code.active ? 'status.active' : 'status.retired'),
  ]
}

export const DISPOSITION_CSV_HEAD = ['csv.code', 'csv.it', 'csv.en', 'csv.outcome', 'csv.stockAction', 'csv.reinspection', 'csv.used', 'csv.status'] as const

export function dispositionCsvRow(code: Disposition, t: T): (string | number)[] {
  return [code.code, code.labelIt, code.labelEn, t(`outcome.${code.outcome}`), stockActionKeys(code).map((line) => t(line.key)).join('; '), t(code.reinspection ? 'csv.yes' : 'csv.no'), code.usedCount, t(code.active ? 'status.active' : 'status.inactive')]
}

// ---- live ----------------------------------------------------------------------------------------------------------------------

export const LIVE_EVENTS = ['quality.defects_changed', 'quality.dispositions_changed'] as const

// ---- the view models --------------------------------------------------------------------------------------------------------

export interface ReadOf<T> {
  readonly value: T | null
  readonly problem: string | null
}

export type DefectsDialog =
  | { kind: 'new-defect'; draft: NewDefectDraft; problems: Readonly<Record<string, string>>; problem: string | null; shown: boolean }
  | { kind: 'new-disposition'; draft: NewDispositionDraft; problems: Readonly<Record<string, string>>; problem: string | null; shown: boolean }
  | { kind: 'retire'; ids: readonly string[] }
  | { kind: 'delete'; id: string }
  | { kind: 'photo'; id: string }
  | { kind: 'keys' }

/** The drawer's picture: its upload under way, its failure (its address is in `thumbs` once read). */
export interface PictureState {
  readonly uploading: boolean
  readonly problem: string | null
}

export interface Notice {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  /** The codes a bulk change could not change, each with why (keys). */
  readonly refused?: readonly { code: string; key: string }[]
}

export interface DefectsModel {
  readonly prefix: string
  /** quality.defects.view (the page); the API's canManage decides the writes. */
  readonly canView: boolean
  /** files.upload: a picture may be uploaded. */
  readonly canUpload: boolean
  /** money.cost: the approval amount is shown (the API leaves it out otherwise). */
  readonly seesCost: boolean
  readonly address: Address
  readonly library: ReadOf<Library>
  readonly dispositions: ReadOf<Dispositions>
  readonly selected: readonly string[]
  readonly marks: Readonly<Record<string, Mark>>
  readonly asOf: string | null
  readonly live: LiveState
  readonly updates: number
  readonly busy: boolean
  readonly notice: Notice | null
  readonly dialog: DefectsDialog | null
  /** The open code's picture upload (the drawer). */
  readonly picture: PictureState
  /** The pictures' addresses read so far, by file id (the list's thumbnails, the drawer's picture). */
  readonly thumbs: Readonly<Record<string, string>>
  /** Design cases: the focused row. */
  readonly focusRow?: number
}

export const EMPTY_PICTURE: PictureState = Object.freeze({ uploading: false, problem: null })
