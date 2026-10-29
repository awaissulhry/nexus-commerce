import type { AddressKind } from './addresses'
import type { ContactRole } from './contacts'
import { isCustomer, isSupplier, type PartyKind, type PartyRole } from './rules'
import { NO_SDI_CODE, type TaxIdentityFields } from './tax'
import type { ViesStanding } from './vies'

/**
 * What a party's record still lacks for the work it is in (A2 SCR-033 and SCR-057 show them as banners), pure. A
 * warning never stops an edit; `blocksInvoice` marks what the invoicing steps (B-W1-28, 50, 51) refuse to issue
 * without, so the record says it before the invoice does:
 *
 *   NO_TAX_IDENTITY          no tax identity in force (D.Lgs. 127/2015: the e-invoice names the buyer's tax ids)
 *   NO_REGISTERED_ADDRESS    no registered office (FatturaPA's Sede of the buyer)
 *   FISCAL_DRAWER            an Italian business without an SDI code or a PEC: invoices land in its fiscal drawer
 *                            (codice destinatario 0000000); a courtesy copy goes by mail
 *   VIES_NOT_PROVEN          an EU business customer without a current VIES proof (art. 41 DL 331/1993): its sales
 *                            are not zero-rated until a check answers valid (./vies.ts)
 *   TAX_COUNTRY_DIFFERS      the tax identity's country is not the party's
 *   NO_DEFAULT_BILL_TO       a customer without a default invoice address
 *   NO_DEFAULT_SHIP_TO       a customer without a default delivery address
 *   NO_ORDERS_CONTACT        nobody receives quotes or purchase orders (an active ORDERS contact with an email)
 *   NAME_TOO_LONG            the legal name passes FatturaPA's 80 characters (Denominazione)
 *   NOT_LATIN1               the name or the registered address has characters FatturaPA cannot carry (Latin-1 only)
 */

export const PARTY_WARNINGS = [
  'NO_TAX_IDENTITY',
  'NO_REGISTERED_ADDRESS',
  'FISCAL_DRAWER',
  'VIES_NOT_PROVEN',
  'TAX_COUNTRY_DIFFERS',
  'NO_DEFAULT_BILL_TO',
  'NO_DEFAULT_SHIP_TO',
  'NO_ORDERS_CONTACT',
  'NAME_TOO_LONG',
  'NOT_LATIN1',
] as const
export type PartyWarningCode = (typeof PARTY_WARNINGS)[number]

export interface PartyWarning {
  readonly code: PartyWarningCode
  readonly message: string
  /** The invoicing steps refuse to issue an invoice to this party until it is fixed. */
  readonly blocksInvoice: boolean
}

export interface WarningFacts {
  readonly party: { readonly kind: PartyKind; readonly roles: readonly PartyRole[]; readonly country: string; readonly legalName: string }
  /** The identity in force today. */
  readonly identity: Pick<TaxIdentityFields, 'country' | 'taxMode' | 'vatNumber' | 'fiscalCode' | 'sdiRecipientCode' | 'pec'> | null
  readonly vies: Pick<ViesStanding, 'state' | 'message'>
  /** The ACTIVE addresses. */
  readonly addresses: readonly { readonly kinds: readonly AddressKind[]; readonly isDefaultBillTo: boolean; readonly isDefaultShipTo: boolean; readonly line1: string; readonly line2: string | null; readonly city: string }[]
  /** The ACTIVE contacts. */
  readonly contacts: readonly { readonly email: string | null; readonly roles: readonly ContactRole[] }[]
}

// FatturaPA's character set is Latin-1 (the builder refuses anything else rather than change it).
const LATIN1 = /^[ -~ -ÿ]*$/
export const isLatin1 = (value: string): boolean => LATIN1.test(value)

export function partyWarnings(facts: WarningFacts): PartyWarning[] {
  const { party, identity, addresses, contacts } = facts
  const customer = isCustomer(party.roles)
  const trades = customer || isSupplier(party.roles)
  const warnings: PartyWarning[] = []
  const add = (code: PartyWarningCode, message: string, blocksInvoice = false) => warnings.push({ code, message, blocksInvoice })

  if (identity === null) {
    if (trades) add('NO_TAX_IDENTITY', 'No tax identity in force: an invoice and a purchase order name the tax ids of the party.', customer)
  } else {
    if (identity.country !== party.country) add('TAX_COUNTRY_DIFFERS', `The tax identity is of ${identity.country}, the party of ${party.country}: check which is right.`)
    if (customer && identity.taxMode === 'IT_B2B' && (identity.sdiRecipientCode === null || identity.sdiRecipientCode === NO_SDI_CODE) && identity.pec === null) {
      add('FISCAL_DRAWER', "No SDI code or PEC: invoices land in the customer's fiscal drawer (0000000); a courtesy copy goes by mail.")
    }
    if (customer && identity.taxMode === 'EU_B2B' && facts.vies.state !== 'VALID') add('VIES_NOT_PROVEN', facts.vies.message)
  }
  const registered = addresses.find((address) => address.kinds.includes('REGISTERED')) ?? null
  if (trades && registered === null) add('NO_REGISTERED_ADDRESS', 'No registered office: the invoice names the party\'s seat (sede legale).', customer)
  if (customer && !addresses.some((address) => address.isDefaultBillTo)) add('NO_DEFAULT_BILL_TO', 'No default invoice address.')
  if (customer && !addresses.some((address) => address.isDefaultShipTo)) add('NO_DEFAULT_SHIP_TO', 'No default delivery address.')
  if (trades && !contacts.some((contact) => contact.email !== null && contact.roles.includes('ORDERS'))) {
    add('NO_ORDERS_CONTACT', customer ? 'Nobody receives quotes and order confirmations: give a contact the ORDERS role and an email.' : 'Nobody receives purchase orders: give a contact the ORDERS role and an email.')
  }
  if (party.legalName.length > 80) add('NAME_TOO_LONG', 'The legal name passes the 80 characters an e-invoice carries: the invoice needs a shorter form of it.', customer)
  const texts = [party.legalName, ...(registered ? [registered.line1, registered.line2 ?? '', registered.city] : [])]
  if (texts.some((text) => !isLatin1(text))) add('NOT_LATIN1', 'The name or the registered address has characters an e-invoice cannot carry (Latin-1 only): write them in Latin letters.', customer)
  return warnings
}
