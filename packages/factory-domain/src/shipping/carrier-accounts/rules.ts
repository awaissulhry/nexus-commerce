import type { Issue } from '../../core/errors'
import { carrierNameFor } from '../labels/labels'

/**
 * Carrier accounts (B-W2b-400; LOG-033 "own carrier contracts; the Owner says which account to use", LOG-038 "the customer's
 * own carrier account for brand orders"; factory-db CarrierAccount and Party.carrierAccountSecretId, B-W2b-367), pure.
 *
 *   our contracts   a company's account number with a carrier, for one of its sites or every site (siteId null), sealed
 *                   (SecretValue `shipping.carrier_account`): typed once, never shown again (the answer says its last four
 *                   characters from the request, never kept). "Use only our rates": labels for that carrier are bought on
 *                   it only. One live contract per company, site (or every site) and carrier; switched off (its number
 *                   removed), never deleted. A label takes the site's contract, else the company's (`contractFor`)
 *   the customer's  a customer's account with its preferred carrier, sealed (`parties.carrier_account`), who the carrier
 *                   bills (SENDER: we; COLLECT: the customer, porto assegnato; THIRD_PARTY: another party on that
 *                   account) and its default service. COLLECT and THIRD_PARTY need the account; the account and the default
 *                   service need the carrier
 *
 * Refusals are 409 `refusal/<CODE>`; field problems 400.
 */

/** A carrier code as the shipments name it (Sendcloud's: "brt"): 1 to 40 characters, no spaces or control characters. */
export const CARRIER_CODE = /^[^\s\p{Cc}]{1,40}$/u

/** An account number with a carrier: 3 to 40 letters, digits, spaces, dots, slashes or hyphens on one line. */
export const ACCOUNT_NUMBER = /^[A-Za-z0-9][A-Za-z0-9 ./-]{1,38}[A-Za-z0-9]$/

/** A carrier service code (Sendcloud's shipping option code): 1 to 100 characters on one line. */
export const SERVICE_CODE = /^[^\r\n\p{Cc}]{1,100}$/u

export const normalCarrierCode = (value: string): string => value.trim().toLowerCase()

export function carrierCodeProblem(value: string | null | undefined, path = 'body/carrierCode'): Issue | null {
  if (typeof value !== 'string' || !CARRIER_CODE.test(normalCarrierCode(value))) return { path, message: 'Name the carrier by its code (as Sendcloud names it, e.g. "brt"): 1 to 40 characters without spaces.' }
  return null
}

export function accountNumberProblem(value: string | null | undefined, path = 'body/accountNumber'): Issue | null {
  if (typeof value !== 'string' || !ACCOUNT_NUMBER.test(value.trim())) return { path, message: "The account number is the carrier's: 3 to 40 letters, digits, spaces, dots, slashes or hyphens on one line." }
  return null
}

export function serviceCodeProblem(value: string | null | undefined, path = 'body/defaultCarrierService'): Issue | null {
  if (value === null || value === undefined) return null
  if (!SERVICE_CODE.test(value.trim()) || value.trim() === '') return { path, message: 'The carrier service is its code (Sendcloud shipping option code): 1 to 100 characters on one line.' }
  return null
}

/** The last four characters of a number typed (answered once from the request; never kept, never read back). */
export const numberEndOf = (value: string): string => value.trim().replace(/[\s./-]+/g, '').slice(-4)

/** Why a contract change is refused (409 `refusal/<CODE>`). */
/** DATABASE: the database's own rule refused the write (its words), when it reached the rule without the check. */
export const CONTRACT_REFUSALS = ['LIVE_EXISTS', 'SWITCHED_OFF', 'DATABASE'] as const
export type ContractRefusalCode = (typeof CONTRACT_REFUSALS)[number]

/** A contract as the rules see it. */
export interface ContractRow {
  readonly id: string
  readonly companyId: string
  readonly siteId: string | null
  readonly carrierCode: string
  readonly active: boolean
}

/** The live contract that covers exactly this company, site (or every site) and carrier; null: none. */
export const liveContractOf = <C extends ContractRow>(contracts: readonly C[], scope: { readonly companyId: string; readonly siteId: string | null; readonly carrierCode: string }): C | null =>
  contracts.find((row) => row.active && row.companyId === scope.companyId && row.siteId === scope.siteId && row.carrierCode === scope.carrierCode) ?? null

/** The contract a label of this site and carrier is bought on: the site's live contract, else the company's (every site). */
export function contractFor<C extends ContractRow>(contracts: readonly C[], scope: { readonly companyId: string; readonly siteId: string; readonly carrierCode: string | null }): C | null {
  if (!scope.carrierCode) return null
  return liveContractOf(contracts, { ...scope, carrierCode: scope.carrierCode }) ?? liveContractOf(contracts, { ...scope, siteId: null, carrierCode: scope.carrierCode })
}

/** What a contract covers, in words. */
export function contractWords(row: Pick<ContractRow, 'siteId' | 'carrierCode' | 'active'> & { readonly ownRatesOnly: boolean }, siteCode: string | null): string {
  const carrier = carrierNameFor('CARRIER', row.carrierCode) ?? row.carrierCode
  if (!row.active) return `Our contract with ${carrier}${siteCode ? ` for ${siteCode}` : ''}: switched off, its number removed.`
  const where = row.siteId ? `for site ${siteCode ?? 'of the company'} only` : 'for every site of the company'
  return `Our own contract with ${carrier}, ${where}${row.ownRatesOnly ? ': labels for it are bought only on this contract ("use only our rates")' : ''}.`
}

export const FREIGHT_BILLINGS = ['SENDER', 'COLLECT', 'THIRD_PARTY'] as const
export type FreightBilling = (typeof FREIGHT_BILLINGS)[number]

/** Who the carrier bills, in words. */
export const FREIGHT_BILLING_WORDS: Readonly<Record<FreightBilling, string>> = Object.freeze({
  SENDER: 'We pay the freight (on our own contract or at Sendcloud’s rates).',
  COLLECT: "The customer pays the freight on its own account with the carrier (porto assegnato).",
  THIRD_PARTY: 'Another party pays the freight on its account with the carrier (e.g. a brand paying for its dealer).',
})

/** Why a customer's carrier account cannot be kept (409 `refusal/<CODE>`). */
export const CUSTOMER_ACCOUNT_REFUSALS = ['NOT_A_CUSTOMER', 'DATABASE'] as const
export type CustomerAccountRefusalCode = (typeof CUSTOMER_ACCOUNT_REFUSALS)[number]

/** The field problems (400) of a customer's carrier terms as they would stand after the change. */
export function customerAccountProblems(next: { readonly carrierCode: string | null; readonly accountOnFile: boolean; readonly freightBilling: FreightBilling; readonly defaultService: string | null }): Issue[] {
  const problems: Issue[] = []
  if (next.accountOnFile && next.carrierCode === null) problems.push({ path: 'body/carrierCode', message: "A carrier account is the account with one carrier: name the customer's carrier." })
  if (next.freightBilling !== 'SENDER' && !next.accountOnFile) problems.push({ path: 'body/freightBilling', message: "The customer (or a third party) pays the freight only on its own account with the carrier: give the account number, or let us pay (SENDER)." })
  if (next.defaultService !== null && next.carrierCode === null) problems.push({ path: 'body/defaultCarrierService', message: "A default service is a service of the customer's carrier: name the carrier." })
  return problems
}
