import { businessDate } from '../../core/time'
import { trackingPageOf } from '../labels/tracking'
import { hasTestLabel } from '../exceptions/rules'

/**
 * The shipping notice to the customer (B-W2b-398; LOG-061 "Shipping notice to the customer"; design warehouse.shipments
 * Tracking & delivery › "Customer notice": the shipping mail to the customer in their language, sent at, to whom,
 * delivery state, Send again), pure. apps/factory-api's modules/shipping/notices sends it.
 *
 *   by itself   when the goods leave (SHIPPED) with their tracking numbers: only while the site's switch
 *               ShippingSettings.customerNoticeOn is on (OFF by default: the Owner's rule of 11-13, a message that goes out
 *               by itself waits for his switch), once per shipment
 *   by hand     "Send again" from the shipment (shipping.manage): a person's act, not held by the switch
 *   never       a shipment with a TEST label (B-W2b-390): no customer ever gets a TEST tracking number; a shipment that has
 *               not left, or was cancelled; one without a tracking number (our own van, the customer collects)
 *
 * The mail says, in the customer's language (the contact's, else the customer's, else the order's): the customer's
 * reference and our order, the carrier, the expected day, each parcel's tracking number and carrier page (https only) and
 * what is in it (style, colour, sizes and pieces). Never a price, never a person of ours.
 */

export const NOTICE_TEMPLATE = 'shipping.customer_notice'

export const NOTICE_HELD = ['SWITCH_OFF', 'NOT_LEFT', 'CANCELLED', 'TEST_LABELS', 'NO_TRACKING', 'NO_RECIPIENT', 'SENT'] as const
export type NoticeHeld = (typeof NOTICE_HELD)[number]

export const NOTICE_HELD_WORDS: Readonly<Record<NoticeHeld, string>> = Object.freeze({
  SWITCH_OFF: "The site's customer notice is off (Shipping settings): nothing is mailed by itself; Send again mails it by hand.",
  NOT_LEFT: 'The goods have not left yet: the notice goes when they leave with their tracking numbers.',
  CANCELLED: 'The shipment is cancelled: no notice goes.',
  TEST_LABELS: 'The shipment left with TEST labels (test mode): no customer ever gets a TEST tracking number.',
  NO_TRACKING: 'The shipment has no carrier tracking number (our own van, or the customer collects): there is nothing to follow.',
  NO_RECIPIENT: 'The customer has no active orders contact with an e-mail address: add one on the customer first.',
  SENT: 'The notice of this shipment was sent already.',
})

export const noticeHeldPath = (code: NoticeHeld): string => `refusal/${code}`

export interface NoticeFacts {
  readonly status: string
  readonly parcels: readonly { readonly carrierParcelId: string | null; readonly trackingNumber: string | null }[]
  /** B-W2b-390: a carrier booked by hand has its tracking number typed on the shipment. */
  readonly manualTrackingNumber: string | null
  readonly recipients: number
  readonly switchOn: boolean
  /** Sent by itself (the leaving handler) or by a person. */
  readonly automatic: boolean
  /** A notice of this shipment was sent by itself before (the automatic one goes once). */
  readonly sentBefore: boolean
}

/** Why the notice does not go now; null: it goes. */
export function noticeHeld(facts: NoticeFacts): NoticeHeld | null {
  if (facts.status === 'CANCELLED') return 'CANCELLED'
  if (facts.status !== 'SHIPPED' && facts.status !== 'DELIVERED' && facts.status !== 'RETURNED') return 'NOT_LEFT'
  if (hasTestLabel(facts.parcels) || (facts.manualTrackingNumber ?? '').startsWith('TEST-')) return 'TEST_LABELS'
  if (!facts.parcels.some((parcel) => parcel.trackingNumber !== null) && !facts.manualTrackingNumber) return 'NO_TRACKING'
  if (facts.automatic && !facts.switchOn) return 'SWITCH_OFF'
  if (facts.automatic && facts.sentBefore) return 'SENT'
  if (facts.recipients === 0) return 'NO_RECIPIENT'
  return null
}

// ---- the mail -------------------------------------------------------------------------------------------------------

export type NoticeLocale = 'it' | 'en'

export interface NoticeParcel {
  readonly seq: number
  readonly trackingNumber: string | null
  readonly trackingUrl: string | null
  readonly contents: readonly { readonly style: string; readonly colour: string; readonly sizes: readonly { readonly size: string; readonly quantity: number }[] }[]
}

export interface NoticeInput {
  readonly locale: NoticeLocale
  readonly companyName: string
  readonly shipmentNumber: string
  readonly orderNumber: string | null
  readonly customerRef: string | null
  readonly carrierName: string | null
  readonly manualTrackingNumber: string | null
  readonly expectedDeliveryAt: Date | null
  readonly parcels: readonly NoticeParcel[]
}

const WORDS = {
  en: {
    subject: (reference: string, company: string) => `Your order ${reference} is on its way - ${company}`,
    hello: 'Hello,',
    left: (reference: string) => `your order ${reference} has left us.`,
    carrier: (name: string) => `Carrier: ${name}`,
    expected: (day: string) => `Expected delivery: ${day}`,
    tracking: 'Tracking number',
    parcel: (seq: number, of: number) => `Parcel ${seq} of ${of}`,
    contents: 'Contents',
    pieces: (count: number) => (count === 1 ? '1 piece' : `${count} pieces`),
    shipment: (number: string) => `Our shipment ${number}`,
    order: (number: string) => `our order ${number}`,
    thanks: 'Thank you.',
  },
  it: {
    subject: (reference: string, company: string) => `Il Suo ordine ${reference} è in viaggio - ${company}`,
    hello: 'Gentile cliente,',
    left: (reference: string) => `il Suo ordine ${reference} è partito.`,
    carrier: (name: string) => `Vettore: ${name}`,
    expected: (day: string) => `Consegna prevista: ${day}`,
    tracking: 'Numero di tracciamento',
    parcel: (seq: number, of: number) => `Collo ${seq} di ${of}`,
    contents: 'Contenuto',
    pieces: (count: number) => (count === 1 ? '1 capo' : `${count} capi`),
    shipment: (number: string) => `Nostra spedizione ${number}`,
    order: (number: string) => `nostro ordine ${number}`,
    thanks: 'Grazie.',
  },
} as const

const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The day as the customer reads it (Rome's day, written out in their language). */
function dayWords(at: Date, locale: NoticeLocale): string {
  const [year, month, day] = businessDate(at).split('-').map((part) => Number.parseInt(part, 10))
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year!, month! - 1, day!)))
}

/** The notice's subject and its text and HTML bodies (the footer is the caller's: the company's legal lines). */
export function noticeMail(input: NoticeInput): { readonly subject: string; readonly text: string; readonly html: string } {
  const words = WORDS[input.locale]
  const reference = input.customerRef ?? input.orderNumber ?? input.shipmentNumber
  const lines: string[] = [words.hello, '', `${words.left(reference)}${input.customerRef && input.orderNumber ? ` (${words.order(input.orderNumber)})` : ''}`, '']
  if (input.carrierName) lines.push(words.carrier(input.carrierName))
  if (input.expectedDeliveryAt) lines.push(words.expected(dayWords(input.expectedDeliveryAt, input.locale)))
  if (input.manualTrackingNumber) lines.push(`${words.tracking}: ${input.manualTrackingNumber}`)
  const html: string[] = [`<p>${escape(words.hello)}</p>`, `<p>${escape(lines[2]!)}</p>`, `<ul>${lines.slice(4).map((line) => `<li>${escape(line)}</li>`).join('')}</ul>`]
  for (const parcel of input.parcels) {
    const page = trackingPageOf(parcel.trackingUrl)
    lines.push('', words.parcel(parcel.seq, input.parcels.length))
    const block: string[] = []
    if (parcel.trackingNumber) {
      lines.push(`${words.tracking}: ${parcel.trackingNumber}${page ? ` - ${page}` : ''}`)
      block.push(`${escape(words.tracking)}: ${page ? `<a href="${escape(page)}">${escape(parcel.trackingNumber)}</a>` : escape(parcel.trackingNumber)}`)
    }
    if (parcel.contents.length > 0) {
      lines.push(`${words.contents}:`)
      const items: string[] = []
      for (const item of parcel.contents) {
        const count = item.sizes.reduce((sum, entry) => sum + entry.quantity, 0)
        const sizes = item.sizes.map((entry) => `${entry.size} × ${entry.quantity}`).join(', ')
        const line = `${item.style} · ${item.colour}: ${sizes} (${words.pieces(count)})`
        lines.push(`- ${line}`)
        items.push(`<li>${escape(line)}</li>`)
      }
      block.push(`${escape(words.contents)}:<ul>${items.join('')}</ul>`)
    }
    html.push(`<p><strong>${escape(words.parcel(parcel.seq, input.parcels.length))}</strong><br>${block.join('<br>')}</p>`)
  }
  lines.push('', words.shipment(input.shipmentNumber), '', words.thanks, input.companyName)
  html.push(`<p>${escape(words.shipment(input.shipmentNumber))}</p>`, `<p>${escape(words.thanks)}<br>${escape(input.companyName)}</p>`)
  return { subject: words.subject(reference, input.companyName).slice(0, 200), text: lines.join('\n'), html: html.join('') }
}

/** The notice's language: the contact's, else the customer's, else the order's, else Italian. */
export function noticeLocaleOf(...languages: readonly (string | null | undefined)[]): NoticeLocale {
  const first = languages.find((language) => typeof language === 'string' && language.trim() !== '')
  return first && first.toLowerCase().startsWith('en') ? 'en' : first && !first.toLowerCase().startsWith('it') ? 'en' : 'it'
}
