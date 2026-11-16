import type { IntegrationMode } from '../../ports/provider'
import { carrierNameFor } from '../labels/labels'
import { EU_COUNTRIES } from '../validate/rules'
// B-W2b-GF2: the EU's special fiscal territories, told apart by the address.
import { specialTerritoryOf, type TerritoryAddress } from '../../tax/special-territories'

/**
 * Carrier services beyond the plain label (B-W2b-400; LOG-033 own contracts, LOG-038 the customer's carrier account, LOG-041
 * express and international with duties and paperless trade, LOG-042 insurance; Owner answer Q20: everything through the
 * factory company's own Sendcloud account, and a service its plan does not include stays on the fake until the Owner chooses
 * it, the exact cost first). Pure data and rules:
 *
 *   services     OWN_CONTRACT (labels on our own contract with the carrier), CUSTOMER_ACCOUNT (the freight billed to the
 *                customer's own account with the carrier, or a third party's), EXPRESS, DUTIES_PAID (we pay an export's
 *                duties: DDP), PAPERLESS (an export's papers sent electronically), INSURANCE (a parcel insured for a value)
 *   offers       what each carrier offers through Sendcloud (CARRIER_OFFERS): STARTING values from the carriers' published
 *                services, UNVERIFIED (check them against the company's contracts and Sendcloud's shipping options once
 *                the live account exists). A carrier not listed (the seeds' carriers) is not known: nothing is refused for
 *                it here, its own refusal stays the carrier's
 *   states       per service and booking: TEST (the site is in test mode: the TEST carrier, nothing sent or charged), FAKE
 *                (the FAKE Sendcloud connection of local and test: nothing charged), CHOSEN (live: the Owner chose it for live
 *                use; Sendcloud charges its price) or NOT_CHOSEN (live, not chosen: a booking that needs it is refused in
 *                words with its cost in words; it stays on the fake until the Owner chooses it)
 *   destination  DOMESTIC (same country), EU (both in the European Union) or EXPORT (leaving it: duties, customs papers)
 *
 * The Owner's choice lives in the Sendcloud connection's settings (not secret): `services` (the codes chosen for live use)
 * and `contracts` ({ carrierCode: Sendcloud's id of our own contract registered there }). No price is ever invented here:
 * the cost of a service is said in words until Sendcloud's offer for the factory's plan gives the figure.
 */

export const CARRIER_SERVICES = ['OWN_CONTRACT', 'CUSTOMER_ACCOUNT', 'EXPRESS', 'DUTIES_PAID', 'PAPERLESS', 'INSURANCE'] as const
export type CarrierService = (typeof CARRIER_SERVICES)[number]

/** What a carrier offers beyond its standard parcel service (our own contract is possible with every carrier). */
export interface CarrierOffer {
  readonly express: boolean
  readonly dutiesPaid: boolean
  readonly paperless: boolean
  readonly insurance: boolean
  readonly customerAccount: boolean
}

const offer = (express: boolean, dutiesPaid: boolean, paperless: boolean, insurance: boolean, customerAccount: boolean): CarrierOffer => Object.freeze({ express, dutiesPaid, paperless, insurance, customerAccount })

/**
 * Starting values per carrier code (Sendcloud's codes, labels.ts CARRIER_NAMES), from the carriers' published services.
 * UNVERIFIED: the express integrators bill a receiver's account and take paperless papers; the parcel carriers do neither.
 */
export const CARRIER_OFFERS: Readonly<Record<string, CarrierOffer>> = Object.freeze({
  ups: offer(true, true, true, true, true),
  fedex: offer(true, true, true, true, true),
  dhl_express: offer(true, true, true, true, true),
  tnt: offer(true, true, true, true, false),
  dhl: offer(false, false, false, true, false),
  dpd: offer(true, false, false, true, false),
  gls: offer(true, false, false, true, false),
  gls_it: offer(true, false, false, true, false),
  brt: offer(true, false, false, true, false),
  poste_italiane: offer(true, false, false, true, false),
  poste: offer(true, false, false, true, false),
  sda: offer(true, false, false, true, false),
  chronopost: offer(true, false, false, true, false),
  colissimo: offer(false, false, false, true, false),
  inpost: offer(false, false, false, true, false),
  postnl: offer(false, false, false, true, false),
  correos: offer(true, false, false, true, false),
})

/** Every carrier not listed: not known here, so nothing is refused for it (its own refusal stays the carrier's). */
const UNKNOWN_OFFER = offer(true, true, true, true, true)

/** The offer of a carrier code, and whether it is known (false: the permissive default). */
export function carrierOfferOf(carrierCode: string | null | undefined): { readonly offer: CarrierOffer; readonly known: boolean } {
  const code = carrierCode?.trim().toLowerCase() ?? ''
  if (code !== '' && Object.hasOwn(CARRIER_OFFERS, code)) return { offer: CARRIER_OFFERS[code]!, known: true }
  return { offer: UNKNOWN_OFFER, known: false }
}

/** The carrier offers the service (our own contract: always). */
export function offers(value: CarrierOffer, service: CarrierService): boolean {
  switch (service) {
    case 'OWN_CONTRACT':
      return true
    case 'CUSTOMER_ACCOUNT':
      return value.customerAccount
    case 'EXPRESS':
      return value.express
    case 'DUTIES_PAID':
      return value.dutiesPaid
    case 'PAPERLESS':
      return value.paperless
    case 'INSURANCE':
      return value.insurance
  }
}

/** What each service does, and what it costs, in words (never a figure: Sendcloud's offer gives it; English, screens word the code). */
export const SERVICE_WORDS: Readonly<Record<CarrierService, { readonly words: string; readonly cost: string }>> = Object.freeze({
  OWN_CONTRACT: {
    words: 'The label is bought on our own contract with the carrier, at our negotiated rates.',
    cost: "The carrier bills us at our contract's rates; Sendcloud's plan decides whether own contracts can be used and what it charges for them: the exact cost comes from Sendcloud's offer first.",
  },
  CUSTOMER_ACCOUNT: {
    words: "The freight is billed to the customer's own account with the carrier (or a third party's), not to us.",
    cost: "The carrier bills the customer's account; whether Sendcloud's plan can book on a customer's account, and at what charge, comes from Sendcloud's offer first.",
  },
  EXPRESS: {
    words: 'An express service: faster, time-definite delivery.',
    cost: "Express costs more than the standard service; the carrier's price for it comes with the label (Sendcloud's offer first for the factory's plan).",
  },
  DUTIES_PAID: {
    words: "We pay the export's duties and taxes (DDP): the receiver pays nothing on delivery.",
    cost: "The carrier bills us the duties and taxes it pays, plus its own fee for the service: the exact fee comes from the carrier's and Sendcloud's offer first.",
  },
  PAPERLESS: {
    words: "The export's commercial invoice goes to the carrier electronically (paperless trade), not taped to the parcel.",
    cost: 'Usually free with the express carriers that take it; Sendcloud confirms whether its plan includes it.',
  },
  INSURANCE: {
    words: "The parcel is insured for its insured value (above the carrier's standard liability).",
    cost: "Insurance is charged per parcel by the insured value; the exact price comes from Sendcloud's offer for the factory's plan first.",
  },
})

export const SERVICE_STATES = ['TEST', 'FAKE', 'CHOSEN', 'NOT_CHOSEN'] as const
export type ServiceState = (typeof SERVICE_STATES)[number]

/** What each state means for a booking (English; screens word the code). */
export const SERVICE_STATE_WORDS: Readonly<Record<ServiceState, string>> = Object.freeze({
  TEST: 'Test mode: the TEST carrier makes the label; nothing is sent and nothing is charged.',
  FAKE: 'The FAKE Sendcloud connection (local and test): nothing is sent and nothing is charged.',
  CHOSEN: "Chosen for live use: Sendcloud and the carrier charge it at their price.",
  NOT_CHOSEN: "Not chosen for live use: the service stays on the fake until the Owner chooses it (the exact cost first); a booking that needs it is refused.",
})

/** The Sendcloud connection a booking uses, as the services see it (null: none named). */
export interface ServiceAccount {
  readonly mode: IntegrationMode
  readonly settings: unknown
}

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** The services the Owner chose for live use (the connection's `settings.services`; unknown codes left out). */
export function chosenServicesOf(settings: unknown): CarrierService[] {
  const listed = record(settings).services
  return Array.isArray(listed) ? CARRIER_SERVICES.filter((service) => listed.includes(service)) : []
}

/** Sendcloud's id of our own contract per carrier code (the connection's `settings.contracts`; a bad entry left out). */
export function providerContractsOf(settings: unknown): Map<string, number> {
  const contracts = record(record(settings).contracts)
  const found = new Map<string, number>()
  for (const [code, value] of Object.entries(contracts)) if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) found.set(code, value)
  return found
}

/** The connection's settings with the Owner's choice written in (every other key kept as it is). */
export function withChosenServices(settings: unknown, services: readonly CarrierService[], contracts: ReadonlyMap<string, number>): Record<string, unknown> {
  return { ...record(settings), services: CARRIER_SERVICES.filter((service) => services.includes(service)), contracts: Object.fromEntries([...contracts.entries()].sort(([a], [b]) => a.localeCompare(b))) }
}

/** The state of a service for a booking: test mode, the FAKE connection, or live chosen / not chosen. */
export function serviceStateOf(service: CarrierService, input: { readonly testMode: boolean; readonly account: ServiceAccount | null }): ServiceState {
  if (input.testMode) return 'TEST'
  if (input.account?.mode === 'FAKE') return 'FAKE'
  return input.account && chosenServicesOf(input.account.settings).includes(service) ? 'CHOSEN' : 'NOT_CHOSEN'
}

export const DESTINATIONS = ['DOMESTIC', 'EU', 'EXPORT'] as const
export type Destination = (typeof DESTINATIONS)[number]

const country = (value: string | null | undefined): string | null => {
  const code = value?.trim().toUpperCase() ?? ''
  return /^[A-Z]{2}$/.test(code) ? code : null
}

/**
 * Where the goods go from the sender's country: the same country, the European Union, or out of it (null: a country
 * missing). B-W2b-GF2 (G463): with the delivery's postal code and town, an EU special fiscal territory outside the VAT
 * area (Livigno, the Canary Islands …) is an export (customs papers travel with it); Monaco goes as France.
 */
export function destinationOf(from: string | null | undefined, to: string | null | undefined, place: Omit<TerritoryAddress, 'country'> = {}): Destination | null {
  const a = country(from)
  const b = country(to)
  if (!a || !b) return null
  const territory = specialTerritoryOf({ country: b, ...place })
  if (territory?.vat === 'OUTSIDE') return 'EXPORT'
  const state = territory?.state ?? b
  if (a === state) return 'DOMESTIC'
  return EU_COUNTRIES.has(a) && EU_COUNTRIES.has(state) ? 'EU' : 'EXPORT'
}

export const DESTINATION_WORDS: Readonly<Record<Destination, string>> = Object.freeze({
  DOMESTIC: 'Within the country.',
  EU: 'To another country of the European Union: no duties, no customs papers.',
  EXPORT: 'An export, out of the European Union: say who pays the duties; customs papers travel with it.',
})

/** The carrier's offer in words, for the booking (known or not). */
export function offerWords(carrierCode: string | null, known: boolean): string {
  const name = carrierNameFor('CARRIER', carrierCode) ?? 'No carrier'
  return known
    ? `${name}: what it offers here are starting values from its published services, not yet checked against our contract.`
    : `${name} is not known here: no service is refused for it; check with the carrier what it offers.`
}
