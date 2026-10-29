import { formatExpiry } from '../../email/compose'
import type { Locale } from '../../email/rules'

/**
 * The mail that brings a party its shipment's documents link (B-W1-49; LOG-020; SAL-099), pure: its subject and its
 * text, in Italian or English (the languages mail has; email/rules localeOf). The text is a record mail on the
 * shipment's thread, so the API stores it as the thread's message — but the link is a bearer key, so the stored text
 * never holds it: `url` null writes the line the thread keeps instead. The mail itself (with the link) is composed in
 * memory and sent at once, like a sign-in mail.
 */

export interface DocumentsLinkMail {
  readonly locale: Locale
  readonly shipmentNumber: string
  /** The sales order and the party's own order reference, when known. */
  readonly orderNumber: string | null
  readonly customerRef: string | null
  /** The documents the link shows now, by title. */
  readonly titles: readonly string[]
  readonly expiresAt: Date
  /** Sent because the party asked for a new link. */
  readonly renewal: boolean
}

const TEXT = {
  it: {
    subject: (shipment: string) => `Spedizione ${shipment}: documenti e dichiarazione di conformità`,
    hello: 'Buongiorno,',
    left: (shipment: string, order: string) => `ecco i documenti della spedizione ${shipment}${order}. Li può leggere e scaricare da questa pagina:`,
    renewal: (shipment: string, order: string) => `come richiesto, ecco un nuovo link ai documenti della spedizione ${shipment}${order}:`,
    order: (number: string | null, ref: string | null) => (ref ? ` (vostro ordine ${ref})` : number ? ` (ordine ${number})` : ''),
    kept: 'Link personale inviato solo per e-mail: non è conservato qui.',
    list: 'Documenti:',
    expires: (when: string) => `Il link funziona fino al ${when}. Quando non si apre più, dalla stessa pagina può chiederne uno nuovo: lo inviamo a questo indirizzo.`,
  },
  en: {
    subject: (shipment: string) => `Shipment ${shipment}: documents and declaration of conformity`,
    hello: 'Hello,',
    left: (shipment: string, order: string) => `here are the documents of shipment ${shipment}${order}. You can read and download them on this page:`,
    renewal: (shipment: string, order: string) => `as you asked, here is a new link to the documents of shipment ${shipment}${order}:`,
    order: (number: string | null, ref: string | null) => (ref ? ` (your order ${ref})` : number ? ` (order ${number})` : ''),
    kept: 'A personal link, sent by e-mail only: it is not kept here.',
    list: 'Documents:',
    expires: (when: string) => `The link works until ${when}. When it no longer opens, you can ask for a new one on the same page: we send it to this address.`,
  },
} as const

/** The subject and text; `url` null gives the text the thread keeps (no link). */
export function documentsLinkMail(input: DocumentsLinkMail, url: string | null): { readonly subject: string; readonly body: string } {
  const words = TEXT[input.locale]
  const order = words.order(input.orderNumber, input.customerRef)
  const opening = input.renewal ? words.renewal(input.shipmentNumber, order) : words.left(input.shipmentNumber, order)
  const list = input.titles.length > 0 ? [words.list, ...input.titles.map((title) => `- ${title}`)].join('\n') : ''
  const body = [words.hello, `${opening}\n${url ?? `[${words.kept}]`}`, list, words.expires(formatExpiry(input.expiresAt, input.locale))].filter((part) => part !== '').join('\n\n')
  return { subject: words.subject(input.shipmentNumber), body }
}
