import type { CarrierBookingExtras } from '../../ports/carrier'
import { carrierNameFor } from '../labels/labels'
import type { ShipmentStatus, TransportBy } from '../shipments'
import { carrierOfferOf, offers, SERVICE_STATE_WORDS, SERVICE_WORDS, serviceStateOf, providerContractsOf, type CarrierService, type Destination, type ServiceAccount, type ServiceState } from './catalogue'
import { decimalOf, type InsuranceRuleView } from './insurance'

/**
 * A shipment's booking with its carrier (B-W2b-400; LOG-033, LOG-038, LOG-041, LOG-042), pure: who the carrier bills, which
 * services the label carries, what each costs in words, and what stops the booking. apps/factory-api's modules/shipping
 * reads the facts (services/booking.ts), shows them (GET …/booking: "shown in the booking cost") and checks them in the label
 * buy before anything is bought or the TEST carrier makes a label (409 `refusal/<CODE>`, every problem):
 *
 *   billed to   the customer's own account (its freight billing COLLECT or THIRD_PARTY, an account sealed on file, and the
 *               shipment goes with the customer's carrier), else our own contract with the carrier (the site's, else the
 *               company's; live only when the Owner chose OWN_CONTRACT and Sendcloud knows the contract), else Sendcloud's
 *               rates (AGGREGATOR). "Use only our rates" refuses the aggregator's rates for that carrier
 *   services    express, who pays an export's duties (DDP needs a carrier that offers it), paperless trade (an export, a
 *               carrier that takes it), insurance (a carrier that insures); an export says who pays the duties
 *   live use    a service the Owner did not choose for live use stays on the fake: refused live, with its cost in words
 *               (Owner Q20); test mode and the FAKE connection refuse nothing for it
 */

/** Why a booking or a service change is refused (409 `refusal/<CODE>`), one code per kind; each problem carries its words. */
export const SERVICE_REFUSALS = [
  'LEFT',
  'CANCELLED',
  'LABELLED',
  'NOT_CARRIER',
  'NOT_EXPORT',
  'DUTY_PAYER_NEEDED',
  'EXPRESS_NOT_OFFERED',
  'DUTIES_PAID_NOT_OFFERED',
  'PAPERLESS_NOT_OFFERED',
  'INSURANCE_NOT_OFFERED',
  'CUSTOMER_ACCOUNT_NOT_OFFERED',
  'SERVICE_NOT_CHOSEN',
  'OWN_CONTRACT_NOT_READY',
  'NO_CUSTOMER_CARRIER',
  'DATABASE',
] as const
export type ServiceRefusalCode = (typeof SERVICE_REFUSALS)[number]

/** What a booking only warns about (it goes on). */
export const BOOKING_WARNINGS = ['CUSTOMER_PAYS_OTHER_CARRIER', 'CONTRACT_NOT_USED', 'NOT_INSURED_BY_RULE'] as const
export type BookingWarningCode = (typeof BOOKING_WARNINGS)[number]

export const BILLED_TO = ['OWN_CONTRACT', 'CUSTOMER_ACCOUNT', 'AGGREGATOR'] as const
export type BilledTo = (typeof BILLED_TO)[number]

export interface BookingProblem<Code extends string = ServiceRefusalCode> {
  readonly code: Code
  readonly message: string
}

/** Everything a booking needs, read before the carrier is called. Values: minor units of the order's currency. */
export interface BookingFacts {
  readonly shipment: {
    readonly number: string
    readonly status: ShipmentStatus
    readonly transportBy: TransportBy
    readonly carrierCode: string | null
    readonly serviceCode: string | null
    readonly express: boolean
    readonly dutyPayer: 'SENDER' | 'RECEIVER' | null
    readonly paperless: boolean
  }
  readonly destination: Destination | null
  readonly testMode: boolean
  /** The Sendcloud connection the labels are bought with (null: none, or not needed in test mode). */
  readonly account: ServiceAccount | null
  /** Our own live contract with the shipment's carrier for its site (else its company's); null: none. */
  readonly contract: { readonly id: string; readonly siteId: string | null; readonly ownRatesOnly: boolean } | null
  /** The customer's carrier terms (Party): its carrier, freight billing, whether an account is on file, its default service. */
  readonly customer: { readonly name: string; readonly carrierCode: string | null; readonly freightBilling: 'SENDER' | 'COLLECT' | 'THIRD_PARTY'; readonly accountOnFile: boolean; readonly defaultService: string | null } | null
  readonly currency: string
  readonly parcels: readonly { readonly id: string; readonly seq: number; readonly labelled: boolean; readonly declaredValue: number | null; readonly insuredValue: number | null; readonly rule: InsuranceRuleView }[]
}

/** One service the booking uses, with its state and cost in words (the booking cost's lines). */
export interface BookingExtra {
  readonly service: CarrierService
  readonly state: ServiceState
  readonly words: string
  readonly stateWords: string
  readonly costWords: string
}

export interface BookingCheck {
  readonly billedTo: BilledTo
  readonly billedToWords: string
  /** Our own contract used for the label (its id and Sendcloud's id of it); null: not on our contract. */
  readonly contract: { readonly id: string; readonly providerContractId: number | null } | null
  readonly extras: readonly BookingExtra[]
  readonly problems: readonly BookingProblem[]
  readonly warnings: readonly BookingProblem<BookingWarningCode>[]
}

const name = (code: string | null): string => carrierNameFor('CARRIER', code) ?? 'the carrier'

/** Who the carrier bills, before any live-use rule. */
function billing(facts: BookingFacts): { kind: BilledTo; customerBills: boolean } {
  const customer = facts.customer
  const customerBills = customer !== null && customer.freightBilling !== 'SENDER' && customer.accountOnFile && customer.carrierCode !== null && customer.carrierCode === facts.shipment.carrierCode
  if (customerBills) return { kind: 'CUSTOMER_ACCOUNT', customerBills }
  return { kind: facts.contract ? 'OWN_CONTRACT' : 'AGGREGATOR', customerBills }
}

/**
 * The booking's check. `parcels` = the parcels the buy labels now (default: those without a label): insurance is checked on
 * them. Problems refuse the buy; warnings go on.
 */
export function bookingCheck(facts: BookingFacts, parcelIds: readonly string[] = facts.parcels.filter((parcel) => !parcel.labelled).map((parcel) => parcel.id)): BookingCheck {
  const problems: BookingProblem[] = []
  const warnings: BookingProblem<BookingWarningCode>[] = []
  const extras: BookingExtra[] = []
  const { shipment } = facts
  const carrier = name(shipment.carrierCode)
  const { offer, known } = carrierOfferOf(shipment.carrierCode)
  const stateOf = (service: CarrierService) => serviceStateOf(service, { testMode: facts.testMode, account: facts.account })
  const use = (service: CarrierService, words: string = SERVICE_WORDS[service].words) => {
    const state = stateOf(service)
    extras.push({ service, state, words, stateWords: SERVICE_STATE_WORDS[state], costWords: SERVICE_WORDS[service].cost })
    if (state === 'NOT_CHOSEN') problems.push({ code: 'SERVICE_NOT_CHOSEN', message: `${words} It is not chosen for live use on the Sendcloud connection: it stays on the fake until the Owner chooses it. ${SERVICE_WORDS[service].cost}` })
  }
  const notOffered = (service: CarrierService, code: ServiceRefusalCode, what: string) => {
    if (known && !offers(offer, service)) problems.push({ code, message: `${carrier} offers no ${what} here: choose another carrier, or take it off.` })
  }

  // Who the carrier bills.
  const bill = billing(facts)
  let billedTo: BilledTo = bill.kind
  let billedToWords: string
  let contract: BookingCheck['contract'] = null
  if (bill.kind === 'CUSTOMER_ACCOUNT') {
    const payer = facts.customer!.freightBilling === 'COLLECT' ? facts.customer!.name : 'a third party'
    billedToWords = `${carrier} bills the freight to ${payer}'s own account with it (the account number stays sealed).`
    notOffered('CUSTOMER_ACCOUNT', 'CUSTOMER_ACCOUNT_NOT_OFFERED', "booking on a customer's own account")
    use('CUSTOMER_ACCOUNT')
  } else if (bill.kind === 'OWN_CONTRACT') {
    const own = facts.contract!
    const state = stateOf('OWN_CONTRACT')
    const providerContractId = facts.account ? (providerContractsOf(facts.account.settings).get(shipment.carrierCode ?? '') ?? null) : null
    const ready = state === 'TEST' || state === 'FAKE' || (state === 'CHOSEN' && providerContractId !== null)
    if (ready) {
      contract = { id: own.id, providerContractId }
      billedToWords = `The label is bought on our own contract with ${carrier} (${own.siteId ? 'for this site' : 'for every site of the company'}).`
      use('OWN_CONTRACT')
    } else if (own.ownRatesOnly) {
      billedToWords = `Labels for ${carrier} are bought only on our own contract ("use only our rates"), which cannot be used live yet.`
      problems.push({
        code: 'OWN_CONTRACT_NOT_READY',
        message:
          state === 'CHOSEN'
            ? `Labels for ${carrier} are bought only on our own contract, and the Sendcloud connection does not know that contract yet: register it in Sendcloud and give its contract id in the carrier services, or switch "use only our rates" off.`
            : `Labels for ${carrier} are bought only on our own contract, and own contracts are not chosen for live use on the Sendcloud connection: they stay on the fake until the Owner chooses them. ${SERVICE_WORDS.OWN_CONTRACT.cost}`,
      })
    } else {
      billedTo = 'AGGREGATOR'
      billedToWords = `The label is bought at Sendcloud's rates for ${carrier}: our own contract cannot be used live yet.`
      warnings.push({ code: 'CONTRACT_NOT_USED', message: `Our own contract with ${carrier} is not used: ${state === 'CHOSEN' ? 'the Sendcloud connection does not know it yet (its contract id)' : 'own contracts are not chosen for live use'}. The label is bought at Sendcloud's rates.` })
    }
  } else {
    billedToWords = `The label is bought at Sendcloud's rates for ${carrier} (no own contract with it).`
  }
  const customer = facts.customer
  if (customer && customer.freightBilling !== 'SENDER' && !bill.customerBills && customer.carrierCode && customer.carrierCode !== shipment.carrierCode) {
    warnings.push({ code: 'CUSTOMER_PAYS_OTHER_CARRIER', message: `${customer.name} pays its freight on its own account with ${name(customer.carrierCode)}; this shipment goes with ${carrier} and is billed to us.` })
  }

  // The services of the label.
  if (shipment.express) {
    notOffered('EXPRESS', 'EXPRESS_NOT_OFFERED', 'express service')
    use('EXPRESS')
  }
  const exporting = facts.destination === 'EXPORT'
  if (!exporting && (shipment.dutyPayer !== null || shipment.paperless)) {
    problems.push({ code: 'NOT_EXPORT', message: 'Who pays the duties and paperless trade are said only for an export (out of the European Union): this shipment is not one. Take them off.' })
  }
  if (exporting && shipment.dutyPayer === null) problems.push({ code: 'DUTY_PAYER_NEEDED', message: 'This is an export: say who pays the duties and taxes (we pay them: DDP; the receiver pays on delivery: DAP) before booking.' })
  if (exporting && shipment.dutyPayer === 'SENDER') {
    notOffered('DUTIES_PAID', 'DUTIES_PAID_NOT_OFFERED', 'duties paid by the sender (DDP)')
    use('DUTIES_PAID')
  }
  if (exporting && shipment.paperless) {
    notOffered('PAPERLESS', 'PAPERLESS_NOT_OFFERED', 'paperless trade')
    use('PAPERLESS')
  }
  const booked = facts.parcels.filter((parcel) => parcelIds.includes(parcel.id))
  const insured = booked.filter((parcel) => parcel.insuredValue !== null && parcel.insuredValue > 0)
  if (insured.length > 0) {
    notOffered('INSURANCE', 'INSURANCE_NOT_OFFERED', 'insurance')
    use('INSURANCE', `${insured.length === 1 ? `Parcel ${insured[0]!.seq} is` : `Parcels ${insured.map((parcel) => parcel.seq).join(', ')} are`} insured for ${insured.length === 1 ? 'its' : 'their'} insured value (above the carrier's standard liability).`)
  }
  for (const parcel of booked) {
    if (parcel.rule.insure === true && parcel.insuredValue === null) warnings.push({ code: 'NOT_INSURED_BY_RULE', message: `Parcel ${parcel.seq}: ${parcel.rule.words} Apply the rule, or book it uninsured.` })
  }
  return { billedTo, billedToWords, contract, extras, problems, warnings }
}

/** What one parcel's label carries beyond its service (the port's extras). */
export function bookingExtrasOf(facts: BookingFacts, check: BookingCheck, parcelId: string): CarrierBookingExtras {
  const parcel = facts.parcels.find((entry) => entry.id === parcelId)
  const declared = parcel?.declaredValue ?? null
  const insured = parcel?.insuredValue ?? null
  const exporting = facts.destination === 'EXPORT'
  return {
    express: facts.shipment.express,
    dutyPayer: exporting ? facts.shipment.dutyPayer : null,
    paperless: exporting && facts.shipment.paperless,
    declaredValue: declared === null ? null : decimalOf(declared, facts.currency),
    insuredValue: insured === null ? null : decimalOf(insured, facts.currency),
    currency: declared === null && insured === null ? null : facts.currency,
    contract: check.contract,
    billing: check.billedTo === 'CUSTOMER_ACCOUNT' ? (facts.customer!.freightBilling as 'COLLECT' | 'THIRD_PARTY') : null,
  }
}

/** Why a shipment's services cannot change now (null: they can): until a label is bought and while it has not left. */
export function servicesChangeRefusal(status: ShipmentStatus, labelled: number): BookingProblem | null {
  if (status === 'CANCELLED') return { code: 'CANCELLED', message: 'The shipment is cancelled.' }
  if (status !== 'DRAFT' && status !== 'PACKED') return { code: 'LEFT', message: `The shipment is ${status}: the goods left, its booking stays as it was.` }
  if (labelled > 0) return { code: 'LABELLED', message: `${labelled === 1 ? 'A parcel has its' : `${labelled} parcels have their`} carrier label already, booked as it stands: void the labels first, then change the booking.` }
  return null
}

/** The field-level refusals of a service change (409 `refusal/<CODE>`): what the carrier offers and an export's services. */
export function servicesProblems(input: { readonly carrierCode: string | null; readonly transportBy: TransportBy; readonly destination: Destination | null; readonly express: boolean; readonly dutyPayer: 'SENDER' | 'RECEIVER' | null; readonly paperless: boolean }): BookingProblem[] {
  const problems: BookingProblem[] = []
  if (input.transportBy !== 'CARRIER' && (input.express || input.dutyPayer !== null || input.paperless)) {
    return [{ code: 'NOT_CARRIER', message: 'The goods do not travel with a carrier (our own van or the customer collects): no carrier service applies.' }]
  }
  const carrier = name(input.carrierCode)
  const { offer, known } = carrierOfferOf(input.carrierCode)
  if (input.express && known && !offer.express) problems.push({ code: 'EXPRESS_NOT_OFFERED', message: `${carrier} offers no express service here: choose another carrier, or take express off.` })
  if ((input.dutyPayer !== null || input.paperless) && input.destination !== 'EXPORT') {
    problems.push({ code: 'NOT_EXPORT', message: 'Who pays the duties and paperless trade are said only for an export (out of the European Union): this shipment is not one.' })
  }
  if (input.destination === 'EXPORT' && input.dutyPayer === 'SENDER' && known && !offer.dutiesPaid) problems.push({ code: 'DUTIES_PAID_NOT_OFFERED', message: `${carrier} does not bill the sender for duties (DDP) here: the receiver pays them (DAP), or choose another carrier.` })
  if (input.destination === 'EXPORT' && input.paperless && known && !offer.paperless) problems.push({ code: 'PAPERLESS_NOT_OFFERED', message: `${carrier} takes no paperless papers here: the commercial invoice travels with the parcel.` })
  return problems
}
