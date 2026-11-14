import type { Locale } from '../../email/rules'
import type { ShipmentStatus } from '../shipments'

/**
 * The mail that brings a customer the branded tracking page of a shipment (B-W2b-170; LOG-062), pure: its subject and
 * text in Italian or English (the languages mail has). The link is a bearer key: the API keeps the subject only (the
 * outbound row, no body) and composes the text with the link in memory after its command, like the claim link's mail.
 */

export interface TrackingLinkMail {
  readonly locale: Locale
  readonly companyName: string
  readonly shipmentNumber: string
  readonly orderNumber: string | null
  /** The customer's own reference of the order, said first when known. */
  readonly customerRef: string | null
  readonly status: ShipmentStatus
  readonly carrierName: string | null
  /** The carrier's expected delivery, while packed or on the way. */
  readonly expectedDeliveryAt: Date | null
  /** Sent because the customer asked for a new link. */
  readonly renewal: boolean
}

const day = (instant: Date, locale: Locale): string => new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { timeZone: 'Europe/Rome', dateStyle: 'long' }).format(instant)

const TEXT = {
  it: {
    subject: (order: string, company: string) => `Il suo ordine ${order} — ${company}`,
    hello: 'Buongiorno,',
    where: (status: ShipmentStatus, order: string, shipment: string) =>
      status === 'PACKED'
        ? `il suo ordine ${order} è imballato e attende il corriere (spedizione ${shipment}).`
        : status === 'DELIVERED'
          ? `il suo ordine ${order} è stato consegnato (spedizione ${shipment}).`
          : `il suo ordine ${order} è in viaggio (spedizione ${shipment}).`,
    renewal: (order: string, shipment: string) => `come richiesto, ecco un nuovo link per seguire il suo ordine ${order} (spedizione ${shipment}).`,
    carrier: (name: string) => `Corriere: ${name}.`,
    eta: (when: string) => `Consegna prevista: ${when}.`,
    follow: 'Lo segua da questa pagina, nella sua lingua: dove si trova, le notizie del corriere e i documenti della spedizione.',
    kept: 'Link personale inviato solo per e-mail.',
    ends: 'La pagina resta aperta fino a 60 giorni dopo la consegna. Se qualcosa non va, dalla stessa pagina può segnalarcelo.',
  },
  en: {
    subject: (order: string, company: string) => `Your order ${order} — ${company}`,
    hello: 'Hello,',
    where: (status: ShipmentStatus, order: string, shipment: string) =>
      status === 'PACKED'
        ? `your order ${order} is packed and waits for the carrier (shipment ${shipment}).`
        : status === 'DELIVERED'
          ? `your order ${order} was delivered (shipment ${shipment}).`
          : `your order ${order} is on its way (shipment ${shipment}).`,
    renewal: (order: string, shipment: string) => `as you asked, here is a new link to follow your order ${order} (shipment ${shipment}).`,
    carrier: (name: string) => `Carrier: ${name}.`,
    eta: (when: string) => `Expected delivery: ${when}.`,
    follow: "Follow it on this page, in your language: where it is, the carrier's news and the shipment's papers.",
    kept: 'A personal link, sent by e-mail only.',
    ends: 'The page stays open until 60 days after delivery. If something is wrong, you can tell us from the same page.',
  },
} as const

/**
 * B-W2b-422 (PLT-232): the values of the e-mail template `shipping.tracking_link` (factory-domain templates/mail.ts), so a
 * company's template in use says what this code says: the order (the customer's reference first), the shipment, where it is
 * (or the renewal's words), the carrier and expected delivery lines, the link (`url` null: the words that stand for it, as
 * the stored copy says). Without a template in use the mail is trackingLinkMail's.
 */
export function trackingLinkMailValues(input: TrackingLinkMail, url: string | null): Readonly<Record<string, string>> {
  const words = TEXT[input.locale]
  const order = input.customerRef ?? input.orderNumber ?? input.shipmentNumber
  const expected = input.expectedDeliveryAt ? day(input.expectedDeliveryAt, input.locale) : ''
  const facts = [input.carrierName ? words.carrier(input.carrierName) : null, expected ? words.eta(expected) : null].filter((line): line is string => line !== null)
  return {
    'order.number': order,
    'shipment.number': input.shipmentNumber,
    'shipment.where': input.renewal ? words.renewal(order, input.shipmentNumber) : words.where(input.status, order, input.shipmentNumber),
    'shipment.facts': facts.join('\n'),
    'carrier.name': input.carrierName ?? '',
    'delivery.expected': expected,
    trackingUrl: url ?? `[${words.kept}]`,
    'company.name': input.companyName,
  }
}

/** The subject and text; `url` null gives the text without the link (never stored with it). */
export function trackingLinkMail(input: TrackingLinkMail, url: string | null): { readonly subject: string; readonly body: string } {
  const words = TEXT[input.locale]
  const order = input.customerRef ?? input.orderNumber ?? input.shipmentNumber
  const opening = input.renewal ? words.renewal(order, input.shipmentNumber) : words.where(input.status, order, input.shipmentNumber)
  const facts = [input.carrierName ? words.carrier(input.carrierName) : null, input.expectedDeliveryAt ? words.eta(day(input.expectedDeliveryAt, input.locale)) : null].filter((line): line is string => line !== null)
  const body = [words.hello, opening, ...(facts.length > 0 ? [facts.join('\n')] : []), `${words.follow}\n${url ?? `[${words.kept}]`}`, words.ends].join('\n\n')
  return { subject: words.subject(order, input.companyName), body }
}
