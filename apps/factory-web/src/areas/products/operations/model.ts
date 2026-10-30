import { minutesOf, OPERATION_CODE, sameMinutes, WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { csvOf, type LibraryCan } from '../library/model'
import type { OperationQuery, OperationRow, OperationView, WhereUsed } from './api'

/**
 * Operation library rules (SCR-049), pure: the saved views and tiles (each a filter the API applies), the New
 * operation draft (code, name per language, department, machine, skill, standard minutes, instructions) checked with
 * the domain's own minute rule, the held reasons (the code is frozen once a routing copied it), the rows of Where used
 * a person may update to the library value (draft revisions only), and the CSV.
 */

export { WORK_CENTRE_KINDS }
export type WorkCentreKind = (typeof WORK_CENTRE_KINDS)[number]

export const OPERATION_VIEWS = ['open', 'unused', 'differs', 'archived', 'all'] as const
export type OperationListView = (typeof OPERATION_VIEWS)[number]
export const OPERATION_TILES = ['unused', 'differs'] as const satisfies readonly OperationListView[]
export type OperationTile = (typeof OPERATION_TILES)[number]

export const viewOf = (value: string | null | undefined): OperationListView => ((OPERATION_VIEWS as readonly string[]).includes(value ?? '') ? (value as OperationListView) : 'open')

export function viewQuery(view: OperationListView): OperationQuery {
  switch (view) {
    case 'unused':
      return { usage: 'UNUSED' }
    case 'differs':
      return { usage: 'DIFFERS' }
    case 'archived':
      return { status: 'ARCHIVED' }
    case 'all':
      return { status: 'ALL' }
    default:
      return {}
  }
}

export interface OperationFilters {
  view: OperationListView
  q: string
  /** A department (work centre kind) or ''. */
  kind: '' | WorkCentreKind
}

export const NO_FILTERS: OperationFilters = { view: 'open', q: '', kind: '' }
export const isFiltered = (filters: OperationFilters): boolean => filters.view !== 'open' || filters.kind !== '' || filters.q.trim() !== ''
export const listQuery = (filters: OperationFilters, cursor: string | null): OperationQuery => ({ ...viewQuery(filters.view), q: filters.q, kind: filters.kind || undefined, cursor })

// ---- minutes in words ---------------------------------------------------------------------------------------------------

/** Typed minutes ("4,25" or "4.25") as the API wants them, or why not: '' → 'empty', bad → 'invalid'. */
export function minutesInput(text: string): { ok: true; minutes: string } | { ok: false; reason: 'empty' | 'invalid' } {
  const value = text.trim().replace(/\s/g, '').replace(',', '.')
  if (value === '') return { ok: false, reason: 'empty' }
  const outcome = minutesOf(value)
  return outcome.ok ? { ok: true, minutes: outcome.minutes } : { ok: false, reason: 'invalid' }
}

/** "+0,4 min" / "−0,2 min" for a difference (step − library). */
export function differenceText(difference: string, locale: 'it' | 'en'): string {
  const value = Number(difference)
  if (!Number.isFinite(value) || value === 0) return '0'
  const text = new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 3, signDisplay: 'always' }).format(value)
  return text.replace('-', '−')
}

// ---- the New operation draft --------------------------------------------------------------------------------------------

export interface OperationDraft {
  companyId: string | null
  code: string
  name: string
  nameIt: string
  nameEn: string
  workCentreKind: WorkCentreKind
  machineType: string
  skill: string
  minutes: string
  instructions: string
}

export const emptyDraft = (companyId: string | null): OperationDraft => ({ companyId, code: '', name: '', nameIt: '', nameEn: '', workCentreKind: 'SEWING', machineType: '', skill: '', minutes: '', instructions: '' })

/** Create is held with the first thing to fix (a message key). */
export function createHeld(draft: OperationDraft, busy: boolean): string | null {
  if (!OPERATION_CODE.test(draft.code.trim().toUpperCase())) return 'newOperation.held.code'
  if (draft.name.trim() === '') return 'newOperation.held.name'
  const minutes = minutesInput(draft.minutes)
  if (!minutes.ok) return minutes.reason === 'empty' ? 'newOperation.held.minutes' : 'newOperation.held.minutesInvalid'
  if (busy) return 'held.busy'
  return null
}

const textOrNull = (value: string): string | null => (value.trim() === '' ? null : value.trim())

export function namesOf(it: string, en: string): { it?: string; en?: string } | null {
  const names = { ...(it.trim() ? { it: it.trim() } : {}), ...(en.trim() ? { en: en.trim() } : {}) }
  return Object.keys(names).length ? names : null
}

export function bodyOf(draft: OperationDraft) {
  const minutes = minutesInput(draft.minutes)
  return {
    companyId: draft.companyId,
    code: draft.code.trim().toUpperCase(),
    name: draft.name.trim(),
    nameI18n: namesOf(draft.nameIt, draft.nameEn),
    workCentreKind: draft.workCentreKind,
    machineType: textOrNull(draft.machineType),
    skill: textOrNull(draft.skill),
    standardMinutes: minutes.ok ? minutes.minutes : '',
    instructions: textOrNull(draft.instructions),
  }
}

// ---- held reasons -------------------------------------------------------------------------------------------------------

/** The code changes only while no routing copied it (the API refuses it otherwise). */
export const codeFrozen = (operation: Pick<OperationRow, 'usedIn'>): boolean => operation.usedIn > 0

export function archiveHeld(rows: readonly OperationRow[], can: Pick<LibraryCan, 'operationsManage'>): string | null {
  if (!can.operationsManage) return 'held.noManage'
  if (rows.some((row) => row.status === 'ARCHIVED')) return 'list.bulk.archiveHeld'
  return null
}

export function reactivateHeld(rows: readonly OperationRow[], can: Pick<LibraryCan, 'operationsManage'>): string | null {
  if (!can.operationsManage) return 'held.noManage'
  if (rows.some((row) => row.status !== 'ARCHIVED')) return 'list.bulk.reactivateHeld'
  return null
}

/**
 * Why a Where used row cannot be updated to the library value, or null: only a DRAFT revision's step changes (a released
 * routing is frozen: a new revision takes the library's minutes), and only when it differs.
 */
export function updateHeld(row: WhereUsed, operation: Pick<OperationView, 'standardMinutes' | 'status'>): string | null {
  if (row.revision.status !== 'DRAFT') return row.revision.status === 'RELEASED' ? 'operation.used.held.released' : 'operation.used.held.obsolete'
  if (sameMinutes(row.standardMinutes, operation.standardMinutes)) return 'operation.used.held.same'
  return null
}

export const STATUS_TONE = { ACTIVE: 'success', ARCHIVED: 'neutral' } as const

export const OPERATION_TABS = ['definition', 'minutes', 'whereused'] as const
export type OperationTab = (typeof OPERATION_TABS)[number]
export const tabOf = (value: string | null | undefined): OperationTab => ((OPERATION_TABS as readonly string[]).includes(value ?? '') ? (value as OperationTab) : 'definition')

export function operationsCsv(rows: readonly OperationRow[], words: { header: readonly string[]; kind: (kind: string) => string; status: (status: string) => string }): string {
  return csvOf(
    words.header,
    rows.map((row) => [row.code, row.name, words.kind(row.workCentreKind), row.machineType ?? '', row.skill ?? '', row.standardMinutes, row.usedIn, row.differing, words.status(row.status)]),
  )
}
