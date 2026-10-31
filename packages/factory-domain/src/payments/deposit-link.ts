import { formatExpiry } from '../email/compose'
import type { Locale } from '../email/rules'

/**
 * The mail that brings the customer its deposit page (DEPOSIT_INFO link; Q12 (a): an acconto paid by bank transfer;
 * design: the deposit request's "bank details page sent to the customer", the bank-transfer part of Pay online), pure:
 * its subject and text, in Italian or English. The text is a message on the quote's thread, so the stored text never
 * holds the link (a bearer key): `url` null writes the line the thread keeps. The mail with the link is composed in
 * memory and sent at once.
 */

export interface DepositLinkMail {
  readonly locale: Locale
  /** The quote document the deposit is asked for, "QT-2026-00001 v1"; null (B-W2b-16) for a request made on an order. */
  readonly quoteDocument: string | null
  /** The sales order the acceptance made, when there is one. */
  readonly orderNumber: string | null
  readonly expiresAt: Date
  /** A note of the sender, after the standard text. */
  readonly message: string | null
}

const TEXT = {
  it: {
    subject: (quote: string) => `Acconto per l'offerta ${quote}: importo e coordinate per il bonifico`,
    hello: 'Buongiorno,',
    body: (quote: string, order: string) => `ecco la pagina dell'acconto richiesto per l'offerta ${quote}${order}: importo, scadenza, causale e coordinate bancarie per il bonifico.`,
    order: (number: string) => ` (ordine ${number})`,
    kept: 'Link personale inviato solo per e-mail: non è conservato qui.',
    expires: (when: string) => `Il link funziona fino al ${when}.`,
    orderSubject: (order: string) => `Pagamento anticipato per l'ordine ${order}: importo e coordinate per il bonifico`,
    orderBody: (order: string) => `ecco la pagina del pagamento anticipato richiesto per l'ordine ${order}: importo, scadenza, causale e coordinate bancarie per il bonifico.`,
  },
  en: {
    subject: (quote: string) => `Deposit for quote ${quote}: amount and bank details`,
    hello: 'Hello,',
    body: (quote: string, order: string) => `here is the page of the deposit asked for quote ${quote}${order}: the amount, the due date, the payment reference and the bank details for the transfer.`,
    order: (number: string) => ` (order ${number})`,
    kept: 'A personal link, sent by e-mail only: it is not kept here.',
    expires: (when: string) => `The link works until ${when}.`,
    orderSubject: (order: string) => `Advance payment for order ${order}: amount and bank details`,
    orderBody: (order: string) => `here is the page of the advance payment asked for order ${order}: the amount, the due date, the payment reference and the bank details for the transfer.`,
  },
} as const

/** The subject and text; `url` null gives the text the thread keeps (no link). */
export function depositLinkMail(input: DepositLinkMail, url: string | null): { readonly subject: string; readonly body: string } {
  const words = TEXT[input.locale]
  const note = input.message?.trim() ?? ''
  // B-W2b-16: a request made on an order without a quote (a typed order's deposit, a balance before shipping).
  const typed = input.quoteDocument === null && input.orderNumber !== null
  const lead = typed ? words.orderBody(input.orderNumber!) : words.body(input.quoteDocument ?? '', input.orderNumber ? words.order(input.orderNumber) : '')
  const body = [words.hello, `${lead}\n${url ?? `[${words.kept}]`}`, words.expires(formatExpiry(input.expiresAt, input.locale)), note].filter((part) => part !== '').join('\n\n')
  return { subject: typed ? words.orderSubject(input.orderNumber!) : words.subject(input.quoteDocument ?? ''), body }
}
