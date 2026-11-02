import { monthLabel } from '../../accounting/periods'
import { formatExpiry } from '../../email/compose'
import type { Locale } from '../../email/rules'

/**
 * The mail that brings the labour consultant a payroll file (B-W2b-54; MES-274; GDPR art. 32; design people.payroll pop-up "Send
 * to the labour consultant"), pure: its subject and text, in Italian or English. No figure, no name and no attachment:
 * the file stays behind an expiring link whose downloads are logged. The link is a bearer key, so the text is made in
 * memory and sent at once: never stored, never in an answer, a receipt, an audit row, an event or a log.
 */

export interface PayrollLinkMail {
  readonly locale: Locale
  readonly companyName: string
  readonly month: string
  readonly number: string
  readonly revision: number
  readonly expiresAt: Date
  readonly uses: number
  readonly message: string | null
  /** The layout is not confirmed yet: the consultant is asked to check it. */
  readonly notConfirmed: boolean
}

const TEXT = {
  it: {
    subject: (month: string, number: string, revision: number) => `Paghe ${month}: file per il consulente del lavoro (${number}${revision > 1 ? `, v${revision}` : ''})`,
    hello: 'Buongiorno,',
    left: (company: string, month: string) => `${company} le invia il file paghe di ${month}. Lo può scaricare da questa pagina:`,
    replaced: (revision: number) => `Questa versione (v${revision}) sostituisce quella precedente.`,
    terms: (when: string, uses: number) => `Il link funziona fino al ${when} e per ${uses} aperture o scaricamenti. Ogni scaricamento viene registrato.`,
    check: 'Il tracciato è da confermare: ci dica se va bene per il suo programma.',
    private: 'Contiene dati personali: non inoltri questo messaggio.',
  },
  en: {
    subject: (month: string, number: string, revision: number) => `Payroll ${month}: file for the labour consultant (${number}${revision > 1 ? `, v${revision}` : ''})`,
    hello: 'Hello,',
    left: (company: string, month: string) => `${company} sends you the payroll file of ${month}. You can download it on this page:`,
    replaced: (revision: number) => `This version (v${revision}) replaces the one before.`,
    terms: (when: string, uses: number) => `The link works until ${when}, for ${uses} opens or downloads. Every download is logged.`,
    check: 'The layout is still to be confirmed: please tell us whether it suits your software.',
    private: 'It holds personal data: please do not forward this message.',
  },
} as const

/** The mail's subject and text. */
export function payrollLinkMail(mail: PayrollLinkMail, url: string): { readonly subject: string; readonly body: string } {
  const words = TEXT[mail.locale]
  const month = monthLabel(mail.month, mail.locale)
  return {
    subject: words.subject(month, mail.number, mail.revision),
    body: [
      words.hello,
      ...(mail.message ? [mail.message] : []),
      `${words.left(mail.companyName, month)}\n${url}`,
      ...(mail.revision > 1 ? [words.replaced(mail.revision)] : []),
      ...(mail.notConfirmed ? [words.check] : []),
      words.terms(formatExpiry(mail.expiresAt, mail.locale), mail.uses),
      words.private,
    ].join('\n\n'),
  }
}
