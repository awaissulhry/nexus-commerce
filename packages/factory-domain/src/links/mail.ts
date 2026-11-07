import { formatExpiry } from '../email/compose'
import type { Locale } from '../email/rules'

/**
 * The mail that brings a set of files by link (COL-051, MES-274; B-W2b-163), pure: its subject and text, in Italian or
 * English. No attachment: the files stay behind an expiring, revocable link whose downloads are logged. Never the
 * password: it goes to the person another way ("sent separately"), and the mail says so. The link is a bearer key, so
 * the text is made in memory and sent at once: never stored, never in an answer, a receipt, an audit row, an event or a
 * log (the stored subject and the thread-less outbound row hold no link). A renewal says it replaces the dead one.
 */

export interface LinkFilesMail {
  readonly locale: Locale
  readonly companyName: string
  readonly secure: boolean
  readonly fileNames: readonly string[]
  readonly expiresAt: Date
  readonly uses: number
  readonly password: boolean
  readonly renewal: boolean
  readonly message: string | null
}

const TEXT = {
  it: {
    subject: (company: string, count: number, secure: boolean) => `${secure ? 'File riservati' : 'Documenti'} da ${company} (${count} ${count === 1 ? 'file' : 'file'})`,
    hello: 'Buongiorno,',
    shared: (company: string, count: number) => `${company} ha condiviso con lei ${count === 1 ? 'un file' : `${count} file`}:`,
    open: 'Li può aprire e scaricare da questa pagina:',
    renewal: 'Questo nuovo link sostituisce quello che non si apriva più.',
    password: 'Per aprirli serve la password che le diamo a parte: non la inviamo mai insieme al link.',
    terms: (when: string, uses: number, secure: boolean) => `Il link funziona fino al ${when} e per ${uses} ${secure ? (uses === 1 ? 'scaricamento' : 'scaricamenti') : uses === 1 ? 'apertura' : 'aperture'}. Ogni scaricamento viene registrato.`,
    private: 'Non inoltri questo messaggio: il link è personale.',
  },
  en: {
    subject: (company: string, count: number, secure: boolean) => `${secure ? 'Secure files' : 'Documents'} from ${company} (${count} ${count === 1 ? 'file' : 'files'})`,
    hello: 'Hello,',
    shared: (company: string, count: number) => `${company} shared ${count === 1 ? 'a file' : `${count} files`} with you:`,
    open: 'You can open and download them on this page:',
    renewal: 'This new link replaces the one that no longer opened.',
    password: 'They open with the password we give you separately: we never send it with the link.',
    terms: (when: string, uses: number, secure: boolean) => `The link works until ${when}, for ${uses} ${secure ? (uses === 1 ? 'download' : 'downloads') : uses === 1 ? 'open' : 'opens'}. Every download is logged.`,
    private: 'Please do not forward this message: the link is personal.',
  },
} as const

/** The mail's subject and text (the subject never holds the link; the text is never stored). */
export function linkFilesMail(mail: LinkFilesMail, url: string): { readonly subject: string; readonly body: string } {
  const words = TEXT[mail.locale]
  return {
    subject: words.subject(mail.companyName, mail.fileNames.length, mail.secure),
    body: [
      words.hello,
      ...(mail.message ? [mail.message] : []),
      [words.shared(mail.companyName, mail.fileNames.length), ...mail.fileNames.map((name) => `- ${name}`)].join('\n'),
      `${words.open}\n${url}`,
      ...(mail.renewal ? [words.renewal] : []),
      ...(mail.password ? [words.password] : []),
      words.terms(formatExpiry(mail.expiresAt, mail.locale), mail.uses, mail.secure),
      words.private,
    ].join('\n\n'),
  }
}
