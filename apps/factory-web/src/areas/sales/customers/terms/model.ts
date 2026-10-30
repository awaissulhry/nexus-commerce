import { isCurrencyCode } from '@nexus/factory-domain/core/money'
import { parsePercent, parsePrice } from '../../quotes/model'
import type { PriceListRow } from '../../pricelists/api'
import { INCOTERMS_2020, type CommercialTerms, type Incoterm, type InvoiceTiming, type PaymentTermsRow, type TermsPatch } from './api'

/**
 * Customer › Tax & terms › Commercial terms (design customer.tax.terms, SAL-012: the defaults copied to new quotes and
 * orders): what a person may change (and why not, in words), the form's draft and the fields that changed, its checks,
 * and the choices it offers — the payment terms library of the customer's company and the active price lists in the
 * customer's currency. Pure: the tests hold every rule.
 */

export interface TermsAbilities {
  view: boolean
  /** parties.manage: the terms are the party's columns. */
  manage: boolean
  /** paymentterms.view: the library to pick from. */
  terms: boolean
  /** pricelists.view: the lists to pick from; giving one needs pricelists.manage too. */
  lists: boolean
  listsManage: boolean
  price: boolean
}

export function termsAbilitiesOf(permissions: readonly string[]): TermsAbilities {
  const held = new Set(permissions)
  return {
    view: held.has('parties.view'),
    manage: held.has('parties.manage'),
    terms: held.has('paymentterms.view'),
    lists: held.has('pricelists.view'),
    listsManage: held.has('pricelists.manage'),
    price: held.has('money.price'),
  }
}

/** Why the card is drawn as text (a message key), or null when it can be edited. */
export function termsHeld(party: { status: string; roles: readonly string[] }, can: Pick<TermsAbilities, 'manage'>): string | null {
  if (!party.roles.includes('CUSTOMER')) return 'terms.held.notCustomer'
  if (party.status === 'ARCHIVED') return 'terms.held.archived'
  if (!can.manage) return 'terms.held.noManage'
  return null
}

export interface TermsDraft {
  currency: string
  language: string
  paymentTermsId: string
  priceListId: string
  defaultDepositPct: string
  invoiceTiming: InvoiceTiming
  incoterm: string
  preferredCarrierCode: string
  /** The minimum order as typed (in the customer's currency); '' = none. */
  minimumOrder: string
}

/** Minor units as the form shows them ("500.00" → "500,00" is the person's own typing; the form keeps dots). */
const minorText = (minor: number | null | undefined): string => (minor === null || minor === undefined ? '' : (minor / 100).toFixed(2))

export function termsDraftOf(terms: CommercialTerms): TermsDraft {
  return {
    currency: terms.currency,
    language: terms.language,
    paymentTermsId: terms.paymentTermsId ?? '',
    priceListId: terms.priceListId ?? '',
    defaultDepositPct: terms.defaultDepositPct ?? '',
    invoiceTiming: terms.invoiceTiming,
    incoterm: terms.incoterm ?? '',
    preferredCarrierCode: terms.preferredCarrierCode ?? '',
    minimumOrder: minorText(terms.minimumOrderAmount),
  }
}

/** A typed amount ("500", "1.250,50") in minor units; null when it is not one. */
export function minorOf(text: string): number | null {
  const parsed = parsePrice(text)
  if (parsed === null) return null
  const [whole, fraction = ''] = parsed.split('.')
  if (fraction.length > 2) return null
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

/** What stops Save, per field (message keys). */
export function termsProblems(draft: TermsDraft): Partial<Record<keyof TermsDraft, string>> {
  const problems: Partial<Record<keyof TermsDraft, string>> = {}
  if (!isCurrencyCode(draft.currency.trim().toUpperCase())) problems.currency = 'terms.problem.currency'
  if (!/^[a-z]{2}$/.test(draft.language.trim().toLowerCase())) problems.language = 'terms.problem.language'
  if (draft.defaultDepositPct.trim() !== '' && parsePercent(draft.defaultDepositPct) === null) problems.defaultDepositPct = 'terms.problem.deposit'
  if (draft.minimumOrder.trim() !== '' && minorOf(draft.minimumOrder) === null) problems.minimumOrder = 'terms.problem.minimum'
  if (draft.preferredCarrierCode.trim().length > 50) problems.preferredCarrierCode = 'terms.problem.carrier'
  if (draft.incoterm && !(INCOTERMS_2020 as readonly string[]).includes(draft.incoterm)) problems.incoterm = 'terms.problem.incoterm'
  return problems
}

/** The fields that changed, as the PATCH sends them (empty = null); the minimum order only with the price grain. */
export function termsPatch(before: TermsDraft, after: TermsDraft, can: Pick<TermsAbilities, 'price' | 'listsManage'>): TermsPatch {
  const patch: TermsPatch = {}
  const text = (value: string) => (value.trim() === '' ? null : value.trim())
  if (after.currency.trim().toUpperCase() !== before.currency) patch.currency = after.currency.trim().toUpperCase()
  if (after.language.trim().toLowerCase() !== before.language) patch.language = after.language.trim().toLowerCase()
  if (after.paymentTermsId !== before.paymentTermsId) patch.paymentTermsId = text(after.paymentTermsId)
  if (can.listsManage && after.priceListId !== before.priceListId) patch.priceListId = text(after.priceListId)
  if (after.defaultDepositPct.trim() !== before.defaultDepositPct) patch.defaultDepositPct = after.defaultDepositPct.trim() === '' ? null : parsePercent(after.defaultDepositPct)
  if (after.invoiceTiming !== before.invoiceTiming) patch.invoiceTiming = after.invoiceTiming
  if (after.incoterm !== before.incoterm) patch.incoterm = (text(after.incoterm) as Incoterm | null) ?? null
  if (after.preferredCarrierCode.trim() !== before.preferredCarrierCode) patch.preferredCarrierCode = text(after.preferredCarrierCode)
  if (can.price && after.minimumOrder.trim() !== before.minimumOrder) patch.minimumOrderAmount = after.minimumOrder.trim() === '' ? null : minorOf(after.minimumOrder)
  return patch
}

/** The payment terms the card offers: the library's active terms (the one it has stays offered, even archived). */
export function termsChoices(library: readonly PaymentTermsRow[] | null, terms: CommercialTerms): Array<{ id: string; code: string; name: string; archived: boolean }> {
  const rows = (library ?? []).map((row) => ({ id: row.id, code: row.code, name: row.name, archived: row.status === 'ARCHIVED' }))
  if (terms.paymentTerms && !rows.some((row) => row.id === terms.paymentTerms!.id)) rows.unshift({ id: terms.paymentTerms.id, code: terms.paymentTerms.code, name: terms.paymentTerms.name, archived: terms.paymentTerms.status !== 'ACTIVE' })
  return rows
}

/** The price lists the card offers: active, of the customer's company or every company, in the customer's currency. */
export function listChoices(lists: readonly PriceListRow[] | null, terms: Pick<CommercialTerms, 'companyId' | 'priceList'>, currency: string): Array<{ id: string; code: string; name: string; kind: string }> {
  const rows = (lists ?? [])
    .filter((list) => list.status === 'ACTIVE' && list.currency === currency.trim().toUpperCase() && (list.companyId === null || terms.companyId === null || list.companyId === terms.companyId))
    .map((list) => ({ id: list.id, code: list.code, name: list.name, kind: list.kind }))
  if (terms.priceList && !rows.some((row) => row.id === terms.priceList!.id)) rows.unshift({ id: terms.priceList.id, code: terms.priceList.code, name: terms.priceList.name, kind: terms.priceList.kind })
  return rows
}

/** "Its list → the lists it falls back to", for the card's text. */
export const chainText = (terms: Pick<CommercialTerms, 'priceChain'>): string => terms.priceChain.map((list) => list.code).join(' → ')
