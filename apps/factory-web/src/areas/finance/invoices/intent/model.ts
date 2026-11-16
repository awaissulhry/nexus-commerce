import { PROTOCOL_PATTERN, MAX_REVOKE_REASON } from '@nexus/factory-domain/invoicing/intent/intent'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { parseAmount, writeProblem, type Phrase, type Tone } from '../../_shared/model'
import { refusalCode } from '../test-mode/depth'
import type { Declaration, DeclarationState, InvoiceIntent } from './api'

/**
 * Declarations of intent in words, pure (B-W2b-GB02, G152; FIN-100; DPR 633/1972 art. 8 c.1 lett. c): who may do what (the
 * tax set-up's right for a new one, its check and its revocation; the invoices' right to name one on a draft; the price
 * grain for what was declared), each state's tone, what holds Add, Check, Revoke and naming one on a draft (said in words,
 * never a code), the new declaration's problems per field before it is sent (the same rules as the API's), and a refused
 * write as this screen's words. No fetching, no React: the tests hold them.
 */

export const NAMESPACE = 'finance-intent'
/** The catalogues the declarations' views read (the finance words come along for the shared problem keys). */
export const INTENT_NAMESPACES = ['finance', NAMESPACE, 'lists'] as const

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export interface IntentAbilities {
  /** invoices.tax.manage: record, check and revoke a declaration. */
  manage: boolean
  /** invoices.manage: name one on a draft, or let it go. */
  manageInvoices: boolean
  /** files.upload: the receipt onto the declaration. */
  upload: boolean
  /** parties.view: the customers to pick from. */
  parties: boolean
  /** money.price: what was declared, used and is left. */
  price: boolean
}

export function intentAbilitiesOf(permissions: readonly string[]): IntentAbilities {
  const held = new Set(permissions)
  return { manage: held.has('invoices.tax.manage'), manageInvoices: held.has('invoices.manage'), upload: held.has('files.upload'), parties: held.has('parties.view'), price: held.has('money.price') }
}

export const STATE_TONE: Record<DeclarationState, Tone> = { UNCHECKED: 'warning', CHECKED: 'success', USED_UP: 'neutral', REVOKED: 'danger' }

/** The filters of the list: all states or one; this year by default, or all years. */
export const STATE_FILTERS = ['ALL', 'UNCHECKED', 'CHECKED', 'USED_UP', 'REVOKED'] as const
export type StateFilter = (typeof STATE_FILTERS)[number]

/** The years offered: all, last year, this year, next year (a declaration of December may cover the next one). */
export const yearsOf = (today: string): number[] => {
  const year = Number(today.slice(0, 4))
  return [year - 1, year, year + 1]
}

/** How much of the declared amount is used, 0 to 100 (null without the price grain or an amount). */
export function usedPercent(declaration: Pick<Declaration, 'amount' | 'usedAmount'>): number | null {
  if (declaration.amount === undefined || declaration.usedAmount === undefined || declaration.amount <= 0) return null
  return Math.min(100, Math.round((declaration.usedAmount / declaration.amount) * 100))
}

/** A declaration not of this year: an invoice issued now cannot rest on it (said beside its year). */
export const otherYear = (declaration: Pick<Declaration, 'year'>, today: string): boolean => declaration.year !== Number(today.slice(0, 4))

// ---- what holds a verb ----------------------------------------------------------------------------------------------------------

/** Why "Add declaration" is held: the right, the price grain (the amount is typed by who holds it), the customers. */
export function addHeld(can: IntentAbilities, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (!can.price) return phrase('held.noPrice')
  if (!can.parties) return phrase('held.noParties')
  if (busy) return phrase('held.busy')
  return null
}

/** Why "Check" is held: the right, the upload right, revoked, checked already, busy. */
export function checkHeld(declaration: Pick<Declaration, 'state' | 'checkedAt'>, can: IntentAbilities, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (!can.upload) return phrase('held.noUpload')
  if (declaration.state === 'REVOKED') return phrase('held.revoked')
  if (declaration.checkedAt !== null) return phrase('held.checked')
  if (busy) return phrase('held.busy')
  return null
}

/** Why "Revoke" is held: the right, revoked already, busy. */
export function revokeHeld(declaration: Pick<Declaration, 'state'>, can: IntentAbilities, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (declaration.state === 'REVOKED') return phrase('held.revoked')
  if (busy) return phrase('held.busy')
  return null
}

/** Why "Record the check" is held once the dialog is open: no receipt chosen yet. */
export const receiptHeld = (file: { name: string } | null, busy: boolean): Phrase | null => (busy ? phrase('held.busy') : file === null ? phrase('check.problem.noFile') : null)

/** The revocation's reason: at least 3 characters, at most the API's limit. */
export function reasonProblem(reason: string): Phrase | null {
  const text = reason.trim()
  if (text.length < 3) return phrase('revoke.problem.short')
  if (text.length > MAX_REVOKE_REASON) return phrase('revoke.problem.long', { max: MAX_REVOKE_REASON })
  return null
}

// ---- a new declaration --------------------------------------------------------------------------------------------------------

export interface AddDraft {
  partyId: string | null
  protocolNumber: string
  protocolDate: string
  /** The year it covers: the protocol's, or the next one. */
  year: number | null
  amount: string
}

export const emptyAddDraft = (today: string): AddDraft => ({ partyId: null, protocolNumber: '', protocolDate: today, year: Number(today.slice(0, 4)), amount: '' })

export type AddField = 'partyId' | 'protocolNumber' | 'protocolDate' | 'year' | 'amount'

/** Each field's problem as a key (the same rules as the API's: protocol shape, a date not ahead, its year or the next, an amount above 0). */
export function addProblems(draft: AddDraft, today: string): Partial<Record<AddField, string>> {
  const problems: Partial<Record<AddField, string>> = {}
  if (!draft.partyId) problems.partyId = 'add.problem.party'
  if (!PROTOCOL_PATTERN.test(draft.protocolNumber.trim())) problems.protocolNumber = 'add.problem.protocol'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.protocolDate)) problems.protocolDate = 'add.problem.date'
  else if (draft.protocolDate > today) problems.protocolDate = 'add.problem.future'
  const protocolYear = Number(draft.protocolDate.slice(0, 4))
  if (draft.year === null || (!problems.protocolDate && draft.year !== protocolYear && draft.year !== protocolYear + 1)) problems.year = 'add.problem.year'
  if (parseAmount(draft.amount) === null) problems.amount = 'add.problem.amount'
  return problems
}

/** The years a protocol date allows (its year, the next one). */
export const yearsForDate = (protocolDate: string): number[] => {
  const year = Number(protocolDate.slice(0, 4))
  return Number.isFinite(year) && year > 1999 ? [year, year + 1] : []
}

/** What "Add" sends, or null while a field has a problem. */
export function addInput(draft: AddDraft, companyId: string, today: string): { companyId: string; partyId: string; protocolNumber: string; protocolDate: string; year: number; amount: number } | null {
  if (Object.keys(addProblems(draft, today)).length > 0) return null
  return { companyId, partyId: draft.partyId!, protocolNumber: draft.protocolNumber.trim(), protocolDate: draft.protocolDate, year: draft.year!, amount: parseAmount(draft.amount)! }
}

// ---- a refused write ----------------------------------------------------------------------------------------------------------

/** The refusals of the declarations' routes this screen words (409 `refusal/<CODE>`). */
export const INTENT_REFUSALS = ['NOT_CUSTOMER', 'REVOKED', 'CHECKED', 'RECEIPT', 'SWITCH_OFF', 'DECLARATION', 'DATABASE'] as const

export interface IntentProblem extends Phrase {
  /** The record changed meanwhile: read it again. */
  reload: boolean
}

/** The receipt reached the store but the virus check holds it: the check is not recorded (said in words). */
export class ReceiptHeldError extends Error {
  override name = 'ReceiptHeldError'
  constructor() {
    super('The receipt is held by the virus check.')
  }
}

/** A refused write in this screen's words (a key a `finance`-scoped translator reads), never the API's English. */
export function intentProblem(error: unknown): IntentProblem {
  if (error instanceof ReceiptHeldError) return { key: `${NAMESPACE}:check.heldByScan`, reload: false }
  const code = refusalCode(error)
  if (code && (INTENT_REFUSALS as readonly string[]).includes(code)) return { key: `${NAMESPACE}:refusal.${code}`, reload: code !== 'DATABASE' }
  if (isApiError(error) && error.kind === 'not_found') return { key: `${NAMESPACE}:refusal.NOT_FOUND`, reload: true }
  const plain = writeProblem(error)
  return plain.params ? { key: plain.key, params: plain.params, reload: plain.reload } : { key: plain.key, reload: plain.reload }
}

/** The fields a refused new declaration names (a 400 with `body/<field>`), as this screen's keys. */
export function addFieldProblems(error: unknown): Partial<Record<AddField, string>> {
  if (!isApiError(error) || error.kind !== 'invalid') return {}
  const out: Partial<Record<AddField, string>> = {}
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.endsWith('protocolNumber')) out.protocolNumber = 'add.problem.protocol'
    else if (path.endsWith('protocolDate')) out.protocolDate = 'add.problem.dateRefused'
    else if (path.endsWith('year')) out.year = 'add.problem.year'
    else if (path.endsWith('amount')) out.amount = 'add.problem.amount'
    else if (path.endsWith('partyId')) out.partyId = 'add.problem.party'
  }
  return out
}

// ---- the declaration a draft rests on ----------------------------------------------------------------------------------------

/** The documents that may rest on a declaration (the API's; a credit note gives back what the invoice it credits used). */
export const NAMING_TYPES = ['TD01', 'TD02', 'TD24', 'TD05'] as const

/** Whether a draft shows the declaration line: a type that names one, and a declaration named or one to pick. */
export const pickShown = (docType: string, intent: Pick<InvoiceIntent, 'declarationOfIntent' | 'declarationCandidates'> | null): boolean =>
  (NAMING_TYPES as readonly string[]).includes(docType) && intent !== null && (intent.declarationOfIntent !== null || intent.declarationCandidates.length > 0)

/** Why naming the declaration picked is held: the right, the switch (letting one go never waits for it), nothing picked, busy. */
export function nameHeld(input: { can: IntentAbilities; switchOn: boolean; picked: string | null; named: string | null; busy: boolean }): Phrase | null {
  if (!input.can.manageInvoices) return phrase('held.noManageInvoices')
  if (input.picked === null) return phrase('pick.held.none')
  if (input.picked === input.named) return phrase('pick.held.same')
  if (!input.switchOn) return phrase('pick.held.switchOff')
  if (input.busy) return phrase('held.busy')
  return null
}

/** Why letting the named declaration go is held: the right, busy. */
export const letGoHeld = (can: IntentAbilities, busy: boolean): Phrase | null => (!can.manageInvoices ? phrase('held.noManageInvoices') : busy ? phrase('held.busy') : null)

/** The named declaration's line in words: its protocol and state, what this invoice uses of it (with the price grain). */
export function namedWords(named: NonNullable<InvoiceIntent['declarationOfIntent']>, amountText: string | null): Phrase {
  if (amountText) return phrase(`pick.named.${named.state}`, { protocol: named.protocolNumber, amount: amountText })
  return phrase(`pick.namedNoPrice.${named.state}`, { protocol: named.protocolNumber })
}
