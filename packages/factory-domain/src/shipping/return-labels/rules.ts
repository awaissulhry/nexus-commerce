import type { CarrierAddress, CarrierLabelRequest } from '../../ports/carrier'
import { carrierAddressOf } from '../labels/labels'
import { parseDecimal } from '../../tax/decimal'

/**
 * Return labels (B-W2b-398; LOG-112 "Return label"; design sales.returns RMA › Shipments: "Return label or link", "Make
 * return label", the Return label PDF window; plan rule 1: a return today asks the customer to find a carrier), pure.
 * factory-db customs.prisma ReturnLabel keeps them; apps/factory-api's modules/shipping/return-labels makes them.
 *
 *   label now   the carrier is booked at once from a shipment of the return's order that left us, with the addresses
 *               swapped: from the customer (the shipment's ship-to) to the return's site (its return address, else its
 *               sender address); one parcel, the shipment's first parcel's weight, its carrier and service (else the
 *               site's defaults). BOOKED with the carrier's reference (its tracking number) and the label PDF, a file of
 *               the return shared with the customer
 *   by link     a one-off link of purpose RETURN_LABEL of the return (mailed to the customer's contact, or passed on):
 *               OFFERED; nothing is booked or paid until the customer uses it, then the same booking: BOOKED
 *   used        USED once our dock receives the return's goods (the carrier had the parcel); CANCELLED by a person
 *               before (the link of an offered one withdrawn with it)
 *
 * Never while the return's site is in test mode (B-W2b-390): a TEST label would reach a customer, who must never get one.
 * The goods may come back only while the return is AUTHORISED or RECEIVED (the database refuses a label otherwise).
 */

export const RETURN_LABEL_STATUSES = ['OFFERED', 'BOOKED', 'USED', 'CANCELLED'] as const
export type ReturnLabelStatus = (typeof RETURN_LABEL_STATUSES)[number]

export const RETURN_LABEL_MODES = ['LABEL', 'LINK'] as const
export type ReturnLabelMode = (typeof RETURN_LABEL_MODES)[number]

/** A return label's link: how long it lives (the purpose's default), and the note it carries. */
export const RETURN_LABEL_LINK = Object.freeze({ expiryDays: 30, maxExpiryDays: 60, note: 'Return label offer' })

/** The weight booked when the shipment's parcel has none: one kilogram. */
export const RETURN_DEFAULT_WEIGHT_KG = '1'

export const RETURN_LABEL_REFUSALS = ['RETURN_CLOSED', 'NO_SHIPMENT', 'TEST_MODE', 'NO_CARRIER_ACCOUNT', 'NO_ADDRESS', 'NO_SERVICE', 'NO_RECIPIENT', 'FINAL', 'NOT_OFFERED', 'CARRIER'] as const
export type ReturnLabelRefusal = (typeof RETURN_LABEL_REFUSALS)[number]
export const returnLabelRefusalPath = (code: ReturnLabelRefusal): string => `refusal/${code}`

export const RETURN_LABEL_REFUSAL_WORDS: Readonly<Record<ReturnLabelRefusal, string>> = Object.freeze({
  RETURN_CLOSED: 'A return label is made only while the goods may come back (the return authorised, or received in part).',
  NO_SHIPMENT: 'No shipment of the return\'s order left us: the label swaps the addresses of the shipment the goods went out on.',
  TEST_MODE: "The return's site is in test mode (Shipping settings): a TEST label would reach the customer, who never gets one.",
  NO_CARRIER_ACCOUNT: 'The company has no usable Sendcloud connection: nothing can be booked.',
  NO_ADDRESS: "The return's site has no return or sender address in its shipping settings, or the shipment's address is incomplete.",
  NO_SERVICE: 'Neither the shipment nor the site names a carrier and a service to book.',
  NO_RECIPIENT: 'The customer has no active orders contact with an e-mail address: pass the link on instead.',
  FINAL: 'This return label is used or cancelled: it never changes.',
  NOT_OFFERED: 'This link\'s label was booked or withdrawn already.',
  CARRIER: 'The carrier did not book the label.',
})

export interface ReturnLabelHeldFacts {
  readonly returnStatus: string
  readonly testMode: boolean
  readonly hasShipment: boolean
  readonly hasAccount: boolean
  readonly hasAddress: boolean
  readonly hasService: boolean
}

/** Why no return label can be made now (the first reason), or null. */
export function makeHeldOf(facts: ReturnLabelHeldFacts): ReturnLabelRefusal | null {
  if (facts.returnStatus !== 'AUTHORISED' && facts.returnStatus !== 'RECEIVED') return 'RETURN_CLOSED'
  if (!facts.hasShipment) return 'NO_SHIPMENT'
  if (facts.testMode) return 'TEST_MODE'
  if (!facts.hasAccount) return 'NO_CARRIER_ACCOUNT'
  if (!facts.hasAddress) return 'NO_ADDRESS'
  if (!facts.hasService) return 'NO_SERVICE'
  return null
}

/** What a label may still do: an offered one is booked by its link or cancelled; a booked one used or cancelled. */
export const cancellable = (status: ReturnLabelStatus): boolean => status === 'OFFERED' || status === 'BOOKED'

/** An address complete enough to print: a name, a street, a postcode, a town and a country. */
export function addressComplete(address: CarrierAddress): boolean {
  return [address.name, address.line1, address.postalCode, address.city, address.country].every((part) => part.trim() !== '')
}

export interface SwapFacts {
  readonly returnNumber: string
  readonly labelId: string
  /** The shipment's ship-to (with the customer's name when the address has none): where the goods come from now. */
  readonly customerAddress: unknown
  /** The site's return address, else its sender address: where they come back to. */
  readonly siteAddress: unknown
  readonly carrierCode: string | null
  readonly serviceCode: string | null
  /** The shipment's first parcel's gross weight (kg, decimal), when weighed. */
  readonly weightKg: string | null
}

/** The booking of a return label: the shipment's addresses swapped, one parcel, its reference the label's own. */
export function returnLabelRequestOf(facts: SwapFacts): CarrierLabelRequest {
  const weight = facts.weightKg !== null ? parseDecimal(facts.weightKg) : null
  return {
    shipmentNumber: facts.returnNumber,
    seq: 1,
    parcels: 1,
    externalReference: `return-label:${facts.labelId}`,
    from: carrierAddressOf(facts.customerAddress),
    to: carrierAddressOf(facts.siteAddress),
    carrierCode: facts.carrierCode,
    serviceCode: facts.serviceCode ?? '',
    weightKg: weight !== null && weight.greaterThan(0) ? weight.toFixed(3) : RETURN_DEFAULT_WEIGHT_KG,
    lengthCm: null,
    widthCm: null,
    heightCm: null,
  }
}

/** The label PDF's file name: the return and the carrier's reference. */
export function returnLabelFileName(returnNumber: string, reference: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, '-')
  return `return-label-${safe(returnNumber)}-${safe(reference)}.pdf`
}

/** A carrier code as the database keeps it (1 to 40 characters, no spaces), else null. */
export function carrierCodeOf(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim()
  return code.length >= 1 && code.length <= 40 && !/\s/.test(code) ? code : null
}

// ---- the link's mail --------------------------------------------------------------------------------------------------

/** The template of the mail that carries a return label's link. */
export const RETURN_LABEL_MAIL_TEMPLATE = 'shipping.return_label_link'

export interface ReturnLabelMailInput {
  readonly locale: 'it' | 'en'
  readonly companyName: string
  readonly returnNumber: string
  readonly customerRef: string | null
  /** The day the link stops opening (Rome's day, YYYY-MM-DD). */
  readonly openUntil: string
}

const MAIL_WORDS = {
  en: {
    subject: (reference: string, company: string) => `Your return ${reference}: your carrier label - ${company}`,
    body: (reference: string, url: string, until: string) =>
      [
        'Hello,',
        '',
        `your return ${reference} is authorised. When the goods are packed, open this link, book the carrier and print the label to stick on the parcel:`,
        url,
        '',
        `Nothing is booked before you use the link. It opens until ${until}.`,
      ].join('\n'),
    noLink: 'The link is in the mail we sent you.',
  },
  it: {
    subject: (reference: string, company: string) => `Il Suo reso ${reference}: l’etichetta del vettore - ${company}`,
    body: (reference: string, url: string, until: string) =>
      [
        'Gentile cliente,',
        '',
        `il Suo reso ${reference} è autorizzato. Quando la merce è imballata, apra questo link, prenoti il vettore e stampi l’etichetta da applicare sul collo:`,
        url,
        '',
        `Nulla viene prenotato prima che usi il link. Il link resta aperto fino al ${until}.`,
      ].join('\n'),
    noLink: 'Il link è nella mail che Le abbiamo inviato.',
  },
} as const

/** The mail's subject, and its body with the link (`url` null: the stored text without it). */
export function returnLabelMail(input: ReturnLabelMailInput, url: string | null): { readonly subject: string; readonly body: string } {
  const words = MAIL_WORDS[input.locale]
  const reference = input.customerRef ?? input.returnNumber
  const [year, month, day] = input.openUntil.split('-')
  const until = `${day}/${month}/${year}`
  return { subject: words.subject(reference, input.companyName).slice(0, 200), body: words.body(reference, url ?? words.noLink, until) }
}
