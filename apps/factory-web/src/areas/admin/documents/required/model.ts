import { sameRuleKey } from '@nexus/factory-domain/files/required/rules'
import type { Rule, RulesAnswer } from './api'

/**
 * SCR-014 › Required documents (B-W2b-177; design admin.documents/sec:required, COL-048: "Record type, document type,
 * required for (status), blocks the move (yes/no). Inline edit; feeds the record frame's GuardList."), pure. The rules of
 * a company (or of every company the person sees, with a Company column), switched-off ones only on "Show switched off";
 * Blocks and On switch in place (one PATCH at the row's version); New rule (`c`, `?rule=new`); Switch off N / Switch on N
 * over the ticked rows. A rule is never deleted. Words are message keys of `admin-required` (and `record-files` for record
 * types, statuses and documents, shared with the record's Files panel).
 */

export type Read = { readonly status: 'loading' } | { readonly status: 'failed'; readonly problem: string } | { readonly status: 'ready'; readonly answer: RulesAnswer }

export interface RequiredDraft {
  readonly recordType: string
  readonly category: string
  readonly beforeStatus: string
  /** '' = every record. */
  readonly partyRole: string
  readonly level: 'BLOCK' | 'WARN'
}

export interface RequiredDialog {
  readonly draft: RequiredDraft
  readonly busy: boolean
  readonly problem: string | null
}

export interface CompanyChoice {
  readonly id: string
  readonly name: string
}

export interface RequiredModel {
  readonly companies: readonly CompanyChoice[]
  /** The company shown, or null for every company the person sees. */
  readonly companyId: string | null
  readonly read: Read
  readonly showOff: boolean
  readonly selected: readonly string[]
  readonly dialog: RequiredDialog | null
  /** Rules being saved now (their switches wait). */
  readonly saving: readonly string[]
  readonly notice: { readonly key: string; readonly tone: 'success' | 'warning' | 'danger'; readonly params?: Record<string, string | number> } | null
  readonly asOf: string | null
}

export const PARTY_ROLE_CHOICES = ['', 'SUPPLIER', 'SUBCONTRACTOR', 'CUSTOMER', 'BRAND', 'CARRIER', 'CONSULTANT'] as const

export const EMPTY_DRAFT: RequiredDraft = { recordType: 'PurchaseOrder', category: 'SUPPLIER_CERTIFICATE', beforeStatus: 'CONFIRMED', partyRole: 'SUPPLIER', level: 'BLOCK' }

/** The rows shown: the company's (or all), on ones first, then by record type, status and document. */
export function rowsOf(model: Pick<RequiredModel, 'read' | 'companyId' | 'showOff'>): Rule[] {
  if (model.read.status !== 'ready') return []
  return model.read.answer.rules
    .filter((rule) => (model.companyId === null || rule.companyId === model.companyId) && (model.showOff || rule.active))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.recordType.localeCompare(b.recordType) || a.beforeStatus.localeCompare(b.beforeStatus) || a.category.localeCompare(b.category))
}

/** How many switched-off rules the list hides. */
export const hiddenOff = (model: Pick<RequiredModel, 'read' | 'companyId'>): number =>
  model.read.status === 'ready' ? model.read.answer.rules.filter((rule) => !rule.active && (model.companyId === null || rule.companyId === model.companyId)).length : 0

/** May the person change this company's rules? */
export const mayChange = (model: Pick<RequiredModel, 'read'>, companyId: string | null): boolean =>
  model.read.status === 'ready' && companyId !== null && model.read.answer.mayChange.includes(companyId)

/** Why a rule's switches are held (a message key), or null. */
export function rowHeld(model: Pick<RequiredModel, 'read' | 'saving'>, rule: Rule): string | null {
  if (!mayChange(model, rule.companyId)) return 'req.held.noRight'
  if (model.saving.includes(rule.id)) return 'req.held.saving'
  return null
}

/** Why New rule is held (a message key), or null. */
export function newHeld(model: Pick<RequiredModel, 'read' | 'companyId'>): string | null {
  if (model.read.status !== 'ready') return 'req.held.reading'
  if (model.companyId === null) return model.read.answer.mayChange.length === 0 ? 'req.held.noRight' : 'req.held.pickCompany'
  return mayChange(model, model.companyId) ? null : 'req.held.noRight'
}

/** The statuses a record type's rule may name. */
export const statusesOf = (answer: RulesAnswer | null, recordType: string): string[] => answer?.recordTypes.find((type) => type.recordType === recordType)?.statuses ?? []

/** What is wrong with the New rule draft (a message key), or null. */
export function draftHeld(model: Pick<RequiredModel, 'read' | 'companyId'>, draft: RequiredDraft): string | null {
  if (model.read.status !== 'ready' || model.companyId === null) return 'req.held.pickCompany'
  if (!statusesOf(model.read.answer, draft.recordType).includes(draft.beforeStatus)) return 'req.held.status'
  const key = { recordType: draft.recordType, category: draft.category, beforeStatus: draft.beforeStatus, partyRole: draft.partyRole === '' ? null : draft.partyRole }
  if (model.read.answer.rules.some((rule) => rule.active && rule.companyId === model.companyId && sameRuleKey(rule, key))) return 'req.held.duplicate'
  return null
}

/** The draft after a change: a new record type picks its first status when the old one is not one of its own. */
export function draftAfter(answer: RulesAnswer | null, draft: RequiredDraft, change: Partial<RequiredDraft>): RequiredDraft {
  const next = { ...draft, ...change }
  const statuses = statusesOf(answer, next.recordType)
  return statuses.includes(next.beforeStatus) ? next : { ...next, beforeStatus: statuses[0] ?? '' }
}

/** Switch on/off N: the ticked rows that would change, and why the others are left. */
export function switchReach(model: Pick<RequiredModel, 'read' | 'saving'>, rows: readonly Rule[], selected: readonly string[], on: boolean): { readonly applies: Rule[]; readonly left: number; readonly held: string | null } {
  const chosen = rows.filter((rule) => selected.includes(rule.id))
  const applies = chosen.filter((rule) => rule.active !== on && rowHeld(model, rule) === null)
  if (chosen.some((rule) => !mayChange(model, rule.companyId)) && applies.length === 0) return { applies, left: chosen.length, held: 'req.held.noRight' }
  return { applies, left: chosen.length - applies.length, held: applies.length === 0 ? (on ? 'req.held.allOn' : 'req.held.allOff') : null }
}

/** The address of the section: `?view=required&company=&off=1&rule=new`. */
export function requiredQuery(state: { readonly companyId: string | null; readonly showOff: boolean; readonly dialog: boolean }): string {
  const query = new URLSearchParams({ view: 'required' })
  if (state.companyId) query.set('company', state.companyId)
  if (state.showOff) query.set('off', '1')
  if (state.dialog) query.set('rule', 'new')
  return query.toString()
}
