import { IBAN_LENGTHS, ibanRemainder, normaliseIban } from '@nexus/factory-domain/purchasing/bank/rules'
import type { PortalBank, PortalBankAccount, PortalProposal } from './api'

/**
 * The supplier's bank details in its portal (B-W2b-334), pure: what the section shows (the account in use per currency,
 * a change waiting, the last refusal), why "Change bank details" waits, a typed IBAN checked as typed (the shape, the
 * country's length, the check digits) and the review old → new, both masked. Words are `purchasing-suppliers-depth` keys
 * under `portalBank.*` with their figures.
 */

export const BANK_NS = 'purchasing-suppliers-depth'

export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
const w = (key: string, params?: Record<string, string | number>): Words => (params ? { key, params } : { key })

export const STATE_TONE: Readonly<Record<PortalBankAccount['state'], 'success' | 'warning' | 'danger' | 'neutral'>> = { USABLE: 'success', WAITING: 'warning', REFUSED: 'danger', RETIRED: 'neutral' }

/** The section's rows: the accounts in use, then the changes waiting, then the newest refusal (the older ones are history). */
export function bankRows(bank: PortalBank): PortalBankAccount[] {
  const usable = bank.accounts.filter((account) => account.state === 'USABLE')
  const waiting = bank.accounts.filter((account) => account.state === 'WAITING')
  const refused = [...bank.accounts.filter((account) => account.state === 'REFUSED')].sort((a, b) => ((a.refusedAt ?? '') < (b.refusedAt ?? '') ? 1 : -1)).slice(0, 1)
  return [...usable, ...waiting, ...refused]
}

export const hasWaiting = (bank: PortalBank) => bank.accounts.some((account) => account.state === 'WAITING')

export interface BankFacts {
  readonly preview: boolean
  readonly offline: boolean
  readonly mayPropose: boolean
  readonly waiting: boolean
}

/** Why "Change bank details" waits, or null. */
export function changeHeld(facts: BankFacts): Words | null {
  if (facts.preview) return w('portalBank.held.preview')
  if (!facts.mayPropose) return w('portalBank.held.admin')
  if (facts.waiting) return w('portalBank.held.waiting')
  if (facts.offline) return w('portalBank.held.offline')
  return null
}

export interface BankDraft {
  readonly iban: string
  readonly holder: string
  readonly bankName: string
  readonly bic: string
  readonly currency: string
}
export const EMPTY_DRAFT: BankDraft = { iban: '', holder: '', bankName: '', bic: '', currency: 'EUR' }

/** What is wrong with a typed IBAN, in our words; null when it is right. */
export function ibanProblem(typed: string): Words | null {
  const iban = normaliseIban(typed)
  if (iban === '') return w('portalBank.problem.ibanEmpty')
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return w('portalBank.problem.ibanShape')
  const length = IBAN_LENGTHS[iban.slice(0, 2)]
  if (length !== undefined && iban.length !== length) return w('portalBank.problem.ibanLength', { country: iban.slice(0, 2), length, typed: iban.length })
  if (ibanRemainder(iban) !== 1) return w('portalBank.problem.ibanDigits')
  return null
}

export function draftProblems(draft: BankDraft): Record<string, Words> {
  const problems: Record<string, Words> = {}
  const iban = ibanProblem(draft.iban)
  if (iban) problems.iban = iban
  if (draft.holder.trim() === '') problems.holder = w('portalBank.problem.holder')
  if (draft.bic.trim() !== '' && !/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(draft.bic.trim().toUpperCase())) problems.bic = w('portalBank.problem.bic')
  if (!/^[A-Z]{3}$/.test(draft.currency.trim().toUpperCase())) problems.currency = w('portalBank.problem.currency')
  return problems
}

/** A typed IBAN masked as the account rows are ("IT** **** **** 3456"). */
export function masked(typed: string): string {
  const iban = normaliseIban(typed)
  return iban.length < 8 ? '—' : `${iban.slice(0, 2)}** **** **** ${iban.slice(-4)}`
}

export const proposalOf = (draft: BankDraft): PortalProposal => ({
  iban: draft.iban,
  holder: draft.holder.trim(),
  bankName: draft.bankName.trim() || null,
  bic: draft.bic.trim().toUpperCase() || null,
  currency: draft.currency.trim().toUpperCase(),
})

/** The account the change replaces (the one in use in its currency), for the review. */
export const replacedOf = (bank: PortalBank | null, currency: string) => bank?.accounts.find((account) => account.state === 'USABLE' && account.currency === currency.trim().toUpperCase()) ?? null

/** A refusal of the send as a `portalBank.failed.*` key (never the API's English). */
export function sendFailed(error: unknown): string {
  const kind = (error as { kind?: string } | null)?.kind
  if (kind === 'conflict') return 'portalBank.failed.clash'
  if (kind === 'invalid') return 'portalBank.failed.invalid'
  if (kind === 'forbidden') return 'portalBank.failed.forbidden'
  if (kind === 'rate_limited') return 'portalBank.failed.wait'
  return 'portalBank.failed.network'
}
