import { ITEM_KINDS, type ItemKind } from '@nexus/factory-domain/product/materials/rules'
import { CONFIRM_DAYS, REMINDERS } from '@nexus/factory-domain/purchasing/orders/delivery'
import { MAX_TOLERANCE_NOTE, TOLERANCE_ACTIONS, type ToleranceAction } from '@nexus/factory-domain/purchasing/po-depth/tolerances'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { AlertRule, ApprovalRule, AuditEntry, CreateToleranceBody, KindsAnswer, ReminderSettings, RulesAnswer, Tolerance, UpdateToleranceBody } from './api'

/**
 * Purchasing settings (SCR-256, B-W2b-354), the rules without React: the address, what each card reads and shows, the drafts
 * and what they send, why a control is held, and the API's refusals in this page's words (keys of `purchasing-settings`).
 * Pure, so the tests hold it.
 */

export { CONFIRM_DAYS, ITEM_KINDS, REMINDERS, TOLERANCE_ACTIONS }
/** The longest note a tolerance keeps (the API's). */
export const MAX_NOTE = MAX_TOLERANCE_NOTE
export type { ItemKind, ToleranceAction }

export interface Read<T> {
  readonly value: T | null
  readonly problem: string | null
}
export const reading = <T>(): Read<T> => ({ value: null, problem: null })
export const ready = <T>(value: T): Read<T> => ({ value, problem: null })
export const failed = <T>(problem: string): Read<T> => ({ value: null, problem })

export interface Notice {
  readonly key: string
  readonly tone: 'info' | 'success' | 'warning' | 'danger'
  readonly params?: Readonly<Record<string, string | number>>
}

/** "Changed by Anna Demo · 12/11 09:42"; `by` null: the time without a name (no audit.read, or no name on the row). */
export interface ChangedBy {
  readonly at: string
  readonly by: string | null
}

// ---- the address ----------------------------------------------------------------------------------------------------------

/** Whose settings: the address's company (with what it follows), or every company's. */
export type Scope = 'company' | 'all'
export type StatusFilter = 'ACTIVE' | 'ARCHIVED' | 'ALL'

export interface Address {
  readonly scope: Scope
  /** The exceptions list's filter. */
  readonly status: StatusFilter
  /** A tolerance in its dialog: its id, or `new`. */
  readonly tolerance: string | null
}
export const NO_ADDRESS: Address = { scope: 'company', status: 'ACTIVE', tolerance: null }

export function addressOf(params: { get(name: string): string | null } | null): Address {
  const status = params?.get('status')
  return {
    scope: params?.get('scope') === 'all' ? 'all' : 'company',
    status: status === 'ARCHIVED' || status === 'ALL' ? status : 'ACTIVE',
    tolerance: params?.get('tolerance') || null,
  }
}

export function queryOf(address: Address): string {
  const query = new URLSearchParams()
  if (address.scope === 'all') query.set('scope', 'all')
  if (address.status !== 'ACTIVE') query.set('status', address.status)
  if (address.tolerance) query.set('tolerance', address.tolerance)
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** Where other pages open (company-scoped: the caller passes `/w/<company>`). */
export const adminRuleHref = (prefix: string, ruleId: string): string => `${prefix}/admin/automation?view=approvals&rule=${encodeURIComponent(ruleId)}`
export const inboxHref = (prefix: string): string => `${prefix}/home/approvals?kind=PURCHASE_ORDER`
export const alertRuleHref = (prefix: string, ruleId: string | 'new'): string => `${prefix}/home/alerts?rule=${encodeURIComponent(ruleId)}`
export function auditHref(prefix: string, recordType: string, recordId?: string | null): string {
  const query = new URLSearchParams({ type: recordType })
  if (recordId) query.set('record', recordId)
  return `${prefix}/admin/audit?${query.toString()}`
}

// ---- PO approval --------------------------------------------------------------------------------------------------------------

export const PO_KIND = 'PURCHASE_ORDER'

/** The purchase order rules this scope shows: a company's own and every company's, or (every company) all of them. */
export function poRulesOf(answer: RulesAnswer | null, scope: Scope, companyId: string | null): ApprovalRule[] {
  if (!answer) return []
  return answer.rules
    .filter((rule) => rule.kind === PO_KIND && (scope === 'all' || rule.companyId === null || rule.companyId === companyId))
    .sort((a, b) => (a.active === b.active ? a.sequence - b.sequence || a.name.localeCompare(b.name) || a.id.localeCompare(b.id) : a.active ? -1 : 1))
}

/** NONE: no rule written; OFF: rules, none switched on; ON: at least one switched on (and in force). */
export type ApprovalState = 'NONE' | 'OFF' | 'ON'
export function approvalStateOf(rules: readonly ApprovalRule[], now: Date = new Date()): { state: ApprovalState; on: number; total: number; later: number } {
  const inForce = (rule: ApprovalRule) => rule.active && (rule.effectiveFrom === null || new Date(rule.effectiveFrom).getTime() <= now.getTime())
  const on = rules.filter(inForce).length
  const later = rules.filter((rule) => rule.active && !inForce(rule)).length
  return { state: rules.length === 0 ? 'NONE' : on === 0 ? 'OFF' : 'ON', on, total: rules.length, later }
}

/** What a purchase order rule may check (the kind's facts, in the reader's language), or null while unknown. */
export function poFactsOf(kinds: KindsAnswer | null, locale: 'it' | 'en'): string[] | null {
  const kind = kinds?.kinds.find((entry) => entry.kind === PO_KIND)
  return kind ? kind.fields.map((field) => field.label[locale]) : null
}

/** The newest change among the rules shown (the API names who changed each). */
export function rulesChangedOf(rules: readonly ApprovalRule[]): ChangedBy | null {
  const newest = [...rules].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  return newest ? { at: newest.updatedAt, by: newest.changedBy?.name ?? null } : null
}

// ---- delivery tolerances ------------------------------------------------------------------------------------------------------

/** Every supplier and every material: the company's (or every company's) default. */
export const isDefault = (row: Pick<Tolerance, 'supplierId' | 'itemId' | 'itemKind'>): boolean => row.supplierId === null && row.itemId === null && row.itemKind === null

/** The scope's own ACTIVE default (the company's, or every company's), or null. */
export function ownDefaultOf(rows: readonly Tolerance[], scope: Scope, companyId: string | null): Tolerance | null {
  const owner = scope === 'company' ? companyId : null
  return rows.find((row) => row.status === 'ACTIVE' && isDefault(row) && row.companyId === owner) ?? null
}

/** What a company follows without its own default: every company's ACTIVE default, or null (exactly as ordered). */
export function followedDefaultOf(rows: readonly Tolerance[], scope: Scope): Tolerance | null {
  if (scope === 'all') return null
  return rows.find((row) => row.status === 'ACTIVE' && isDefault(row) && row.companyId === null) ?? null
}

/** The rows a scope reads: a company's and every company's, or every company's only. */
export const rowsOfScope = (rows: readonly Tolerance[], scope: Scope, companyId: string | null): Tolerance[] => rows.filter((row) => (scope === 'all' ? row.companyId === null : row.companyId === null || row.companyId === companyId))

/** The per-supplier or per-material rules of the list: every row of the scope but the ACTIVE defaults the form shows. */
export function exceptionsOf(rows: readonly Tolerance[], scope: Scope, companyId: string | null, status: StatusFilter): Tolerance[] {
  const shownAbove = new Set([ownDefaultOf(rows, scope, companyId)?.id, followedDefaultOf(rows, scope)?.id].filter(Boolean))
  return rowsOfScope(rows, scope, companyId)
    .filter((row) => !shownAbove.has(row.id) && (status === 'ALL' || row.status === status))
    .sort((a, b) => {
      // This company's first, then every company's; by supplier, then material.
      const whose = (row: Tolerance) => (row.companyId === null ? 1 : 0)
      const supplier = (row: Tolerance) => row.supplier?.name ?? ''
      const material = (row: Tolerance) => row.item?.code ?? row.itemKind ?? ''
      return whose(a) - whose(b) || supplier(a).localeCompare(supplier(b)) || material(a).localeCompare(material(b)) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    })
}

/** A percent as the API keeps it ("5", "2.5") ⇄ the stepper's number. */
export const percentOf = (text: string): number => Number.parseFloat(text)
export const percentText = (value: number | ''): string => (value === '' ? '' : String(Number.parseFloat(value.toFixed(4))))
export function percentWords(text: string, locale: 'it' | 'en'): string {
  const value = Number.parseFloat(text)
  return Number.isFinite(value) ? `${new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 4 }).format(value)} %` : '—'
}

/** Why a percentage as typed cannot be kept, or null: 0 to 100, at most four decimals. */
export function percentProblem(value: number | ''): string | null {
  if (value === '') return 'problem.percentNeeded'
  if (!Number.isFinite(value) || value < 0 || value > 100) return 'problem.percentRange'
  if (Math.abs(value * 10_000 - Math.round(value * 10_000)) > 1e-6) return 'problem.percentPlaces'
  return null
}

// -- the default (every supplier, every material) --

export interface DefaultDraft {
  readonly over: number | ''
  readonly under: number | ''
  readonly whenBeyond: ToleranceAction
}

/** The form from the scope's own default; empty fields when it keeps none (each with its hint). */
export const defaultDraftOf = (own: Tolerance | null): DefaultDraft => (own ? { over: percentOf(own.overPct), under: percentOf(own.underPct), whenBeyond: own.whenBeyond } : { over: '', under: '', whenBeyond: 'BLOCK' })

/** How many fields differ from what is kept (a new default counts once both percentages are typed or one is). */
export function defaultChanges(own: Tolerance | null, draft: DefaultDraft): number {
  if (!own) return draft.over === '' && draft.under === '' ? 0 : 1
  let count = 0
  if (draft.over === '' || percentText(draft.over) !== percentText(percentOf(own.overPct))) count += 1
  if (draft.under === '' || percentText(draft.under) !== percentText(percentOf(own.underPct))) count += 1
  if (draft.whenBeyond !== own.whenBeyond) count += 1
  return count
}

export function defaultProblems(draft: DefaultDraft): { over: string | null; under: string | null } {
  return { over: percentProblem(draft.over), under: percentProblem(draft.under) }
}

/** What Save sends: a new default (POST), or the fields that changed (PATCH at the version read). */
export function defaultWrite(own: Tolerance | null, draft: DefaultDraft, scope: Scope, companyId: string | null): { kind: 'create'; body: CreateToleranceBody } | { kind: 'update'; id: string; body: UpdateToleranceBody } {
  if (!own) {
    return { kind: 'create', body: { companyId: scope === 'company' ? companyId : null, supplierId: null, itemId: null, itemKind: null, overPct: percentText(draft.over), underPct: percentText(draft.under), whenBeyond: draft.whenBeyond } }
  }
  const body: { version: number; overPct?: string; underPct?: string; whenBeyond?: ToleranceAction } = { version: own.version }
  if (percentText(draft.over) !== percentText(percentOf(own.overPct))) body.overPct = percentText(draft.over)
  if (percentText(draft.under) !== percentText(percentOf(own.underPct))) body.underPct = percentText(draft.under)
  if (draft.whenBeyond !== own.whenBeyond) body.whenBeyond = draft.whenBeyond
  return { kind: 'update', id: own.id, body }
}

/** The scope's own tolerances may be kept: the API's answer on its rows; without one, the permission (the API decides). */
export function mayKeepTolerances(rows: readonly Tolerance[] | null, scope: Scope, companyId: string | null, permitted: boolean): boolean {
  if (!permitted) return false
  const owner = scope === 'company' ? companyId : null
  const own = (rows ?? []).filter((row) => row.companyId === owner)
  return own.length === 0 ? true : own.some((row) => row.mayChange)
}

/** Why the default's Save (or the exceptions' writes) are held now, or null. */
export function keepHeld(input: { readonly may: boolean; readonly scope: Scope; readonly offline: boolean; readonly busy: boolean }): string | null {
  if (input.busy) return 'held.busy'
  if (!input.may) return input.scope === 'all' ? 'held.noToleranceRightAll' : 'held.noToleranceRight'
  if (input.offline) return 'held.offline'
  return null
}

// -- an exception (per supplier or per material) --

export type MaterialMode = 'ALL' | 'KIND' | 'ITEM'

export interface ToleranceDraft {
  /** null: a new exception. */
  readonly id: string | null
  /** For every company (null) or the address's company. */
  readonly companyId: string | null
  readonly supplierId: string | null
  readonly materialMode: MaterialMode
  readonly itemKind: ItemKind | null
  readonly itemId: string | null
  readonly over: number | ''
  readonly under: number | ''
  readonly whenBeyond: ToleranceAction
  readonly note: string
}

export function toleranceDraftOf(row: Tolerance | null, companyId: string | null): ToleranceDraft {
  if (!row) return { id: null, companyId, supplierId: null, materialMode: 'ALL', itemKind: null, itemId: null, over: '', under: '', whenBeyond: 'BLOCK', note: '' }
  return {
    id: row.id,
    companyId: row.companyId,
    supplierId: row.supplierId,
    materialMode: row.itemId ? 'ITEM' : row.itemKind ? 'KIND' : 'ALL',
    itemKind: row.itemKind,
    itemId: row.itemId,
    over: percentOf(row.overPct),
    under: percentOf(row.underPct),
    whenBeyond: row.whenBeyond,
    note: row.note ?? '',
  }
}

export interface DraftProblems {
  readonly supplier?: string
  readonly material?: string
  readonly over?: string
  readonly under?: string
  readonly note?: string
  /** The whole rule (one active rule per scope). */
  readonly scope?: string
}

/** What is wrong with an exception as typed (shown at its fields after the first Save), from the rows read. */
export function draftProblems(draft: ToleranceDraft, rows: readonly Tolerance[]): DraftProblems {
  const problems: { -readonly [K in keyof DraftProblems]?: string } = {}
  if (draft.id === null) {
    if (draft.materialMode === 'KIND' && !draft.itemKind) problems.material = 'problem.kindNeeded'
    if (draft.materialMode === 'ITEM' && !draft.itemId) problems.material = 'problem.materialNeeded'
    if (draft.supplierId === null && draft.materialMode === 'ALL') problems.scope = 'problem.exceptionNeedsScope'
    else {
      const scope = scopeOfDraft(draft)
      if (rows.some((row) => row.status === 'ACTIVE' && row.companyId === scope.companyId && row.supplierId === scope.supplierId && row.itemId === scope.itemId && row.itemKind === scope.itemKind)) problems.scope = 'problem.sameScope'
    }
  }
  const over = percentProblem(draft.over)
  if (over) problems.over = over
  const under = percentProblem(draft.under)
  if (under) problems.under = under
  if (draft.note.length > MAX_TOLERANCE_NOTE) problems.note = 'problem.noteLong'
  return problems
}

const scopeOfDraft = (draft: ToleranceDraft) => ({
  companyId: draft.companyId,
  supplierId: draft.supplierId,
  itemId: draft.materialMode === 'ITEM' ? draft.itemId : null,
  itemKind: draft.materialMode === 'KIND' ? draft.itemKind : null,
})

export function draftCreateBody(draft: ToleranceDraft): CreateToleranceBody {
  const scope = scopeOfDraft(draft)
  const note = draft.note.trim()
  return { ...scope, overPct: percentText(draft.over), underPct: percentText(draft.under), whenBeyond: draft.whenBeyond, note: note === '' ? null : note }
}

/** The fields of an existing rule that changed (its scope never changes), or null when nothing did. */
export function draftUpdateBody(row: Tolerance, draft: ToleranceDraft): UpdateToleranceBody | null {
  const body: { version: number; overPct?: string; underPct?: string; whenBeyond?: ToleranceAction; note?: string | null } = { version: row.version }
  if (percentText(draft.over) !== percentText(percentOf(row.overPct))) body.overPct = percentText(draft.over)
  if (percentText(draft.under) !== percentText(percentOf(row.underPct))) body.underPct = percentText(draft.under)
  if (draft.whenBeyond !== row.whenBeyond) body.whenBeyond = draft.whenBeyond
  const note = draft.note.trim() === '' ? null : draft.note.trim()
  if (note !== (row.note ?? null)) body.note = note
  return Object.keys(body).length > 1 ? body : null
}

/** The rows a bulk move takes: in the other state, and the person may change them. */
export const movable = (rows: readonly Tolerance[], selected: readonly string[], to: 'archive' | 'reactivate'): Tolerance[] =>
  rows.filter((row) => selected.includes(row.id) && row.mayChange && row.status === (to === 'archive' ? 'ACTIVE' : 'ARCHIVED'))

/** The newest change of the tolerances shown: the audit trail's (with the name), else the rows' own times. */
export function tolerancesChangedOf(rows: readonly Tolerance[], audit: readonly AuditEntry[] | null): ChangedBy | null {
  const ids = new Set(rows.map((row) => row.id))
  const entry = audit?.find((row) => ids.has(row.recordId))
  if (entry) return { at: entry.at, by: entry.actorName }
  const newest = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  return newest ? { at: newest.updatedAt, by: null } : null
}

// ---- confirmation -------------------------------------------------------------------------------------------------------------

/** The default confirm-by, in hours (the W2a rule: two of the supplier's open days). */
export const CONFIRM_HOURS = CONFIRM_DAYS * 24

/** The row the scope's switch writes: the company's own (company scope) or every company's. */
export const ownSwitchRow = (settings: ReminderSettings, scope: Scope) => (scope === 'company' ? settings.company : settings.tenant)

/** Why the switch's Save is held now, or null. */
export function switchHeld(settings: ReminderSettings | null, scope: Scope, offline: boolean, busy: boolean): string | null {
  if (!settings) return 'held.reading'
  if (busy) return 'held.busy'
  if (!settings.mayChange) return scope === 'all' ? 'held.noSwitchAll' : 'held.noSwitch'
  if (offline) return 'held.offline'
  return null
}

/** What Save sends: the scope's row at the version read (no version when the row does not exist yet). */
export function switchBody(settings: ReminderSettings, on: boolean, scope: Scope, companyId: string | null): { companyId: string | null; on: boolean; version?: number } {
  const row = ownSwitchRow(settings, scope)
  return { companyId: scope === 'company' ? companyId : null, on, ...(row ? { version: row.version } : {}) }
}

/** The switch's words: on or off, and where it comes from. */
export function switchWordsKey(settings: Pick<ReminderSettings, 'on' | 'source'>): string {
  return `switch.${settings.on ? 'on' : 'off'}.${settings.source}`
}

/** The newest switch change: the audit trail's (who), else the row's own time. */
export function switchChangedOf(settings: ReminderSettings | null, scope: Scope, audit: readonly AuditEntry[] | null): ChangedBy | null {
  if (!settings) return null
  const row = ownSwitchRow(settings, scope)
  if (!row) return null
  const entry = audit?.find((entry) => entry.recordId === row.id && entry.action.startsWith('purchasing.reminder'))
  return entry ? { at: entry.at, by: entry.actorName } : { at: row.updatedAt, by: null }
}

/** The buyer's alert rules that hold for this scope (a company's place or everywhere). */
export const buyerAlertsOf = (rules: readonly AlertRule[], scope: Scope, companyId: string | null): AlertRule[] =>
  rules.filter((rule) => scope === 'all' || rule.place.companyId === null || rule.place.companyId === companyId)

// ---- the API's answers in this page's words -----------------------------------------------------------------------------------

export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.read.internal'
  return ['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'contract'].includes(error.kind) ? `problem.read.${error.kind}` : 'problem.read.internal'
}

export interface WriteProblem {
  readonly key: string
  /** Read again: the row moved meanwhile (never overwritten). */
  readonly reload: boolean
  /** The dialog's fields the API refused, each with this page's words. */
  readonly fields: Readonly<Record<string, string>>
}

const FIELD_WORDS: Readonly<Record<string, string>> = {
  overPct: 'problem.percentRange',
  underPct: 'problem.percentRange',
  itemKind: 'problem.kindNeeded',
  itemId: 'problem.materialNeeded',
  supplierId: 'problem.supplierRefused',
  note: 'problem.noteLong',
}

export function writeProblemOf(error: unknown, scope: Scope): WriteProblem {
  if (!isApiError(error)) return { key: 'problem.write.internal', reload: false, fields: {} }
  const paths = error.issues.map((issue) => issuePath(issue).replace(/^body[./]/, ''))
  const fields: Record<string, string> = {}
  for (const path of paths) {
    const field = path.split(/[./]/)[0] ?? path
    if (FIELD_WORDS[field] && !fields[field]) fields[field] = FIELD_WORDS[field]!
  }
  switch (error.kind) {
    case 'conflict':
      if (paths.some((path) => path.includes('version'))) return { key: 'problem.write.moved', reload: true, fields: {} }
      if (/already exists/i.test(error.message)) return { key: 'problem.write.sameScope', reload: true, fields: {} }
      if (/archived|active already/i.test(error.message)) return { key: 'problem.write.state', reload: true, fields: {} }
      return { key: 'problem.write.moved', reload: true, fields: {} }
    case 'invalid':
      return { key: 'problem.write.invalid', reload: false, fields }
    case 'forbidden':
      return { key: scope === 'all' ? 'problem.write.forbiddenAll' : 'problem.write.forbidden', reload: false, fields: {} }
    case 'not_found':
      return { key: 'problem.write.not_found', reload: true, fields: {} }
    case 'step_up':
      return { key: 'stepUp.cancelled', reload: false, fields: {} }
    case 'signed_out':
    case 'rate_limited':
    case 'unavailable':
      return { key: `problem.write.${error.kind}`, reload: false, fields: {} }
    default:
      return { key: 'problem.write.internal', reload: false, fields: {} }
  }
}

/** Every write problem key this page may say (the catalogue test reads them). */
export const WRITE_PROBLEM_KEYS = ['moved', 'sameScope', 'state', 'invalid', 'forbidden', 'forbiddenAll', 'not_found', 'signed_out', 'rate_limited', 'unavailable', 'internal'] as const
export const READ_PROBLEM_KEYS = ['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'contract', 'internal'] as const
export const LIVE_EVENTS = ['approval.rule_changed', 'delivery_tolerance.changed', 'purchasing_settings.changed', 'alert.rule_changed'] as const
