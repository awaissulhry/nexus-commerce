import type { SharePermission, ShareLocale } from './rules'

/**
 * The mails of an invitation to one record (B-W2b-200), in the reader's language (it/en). No money, no cost and no office id
 * in any of them. The link is in the sent invitation only (the EmailOutbound row keeps the subject, never the body): a later
 * mail cannot carry it again, so "E-mail me" mails say where to answer instead.
 *
 *   invite    to the contact on file (or the address typed): who invites, to what, what they may do, until when, the
 *             inviter's own words, the link ("please do not forward it")
 *   message   "E-mail me": a new message on the shared record (who wrote, the first lines), open the invitation's link to read
 *             and answer
 */

export interface Mail {
  readonly subject: string
  readonly body: string
}

export const SHARE_MAIL_TEMPLATES = Object.freeze({ invite: 'shares.invite', message: 'shares.message' })

/** A day as the reader reads it ("30 nov" / "30 Nov"), in the company's zone. */
export const shareDayOf = (at: Date, locale: ShareLocale): string =>
  new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { timeZone: 'Europe/Rome', day: 'numeric', month: 'short', year: 'numeric' }).format(at).replace('.', '')

const MAY_WORDS: Readonly<Record<SharePermission, { readonly it: string; readonly en: string }>> = Object.freeze({
  VIEW: { it: 'leggere', en: 'read' },
  COMMENT: { it: 'scrivere messaggi', en: 'write messages' },
  UPLOAD: { it: 'caricare file', en: 'upload files' },
})

/** "read, write messages and upload files" in the reader's language. */
export function mayWords(permissions: readonly SharePermission[], locale: ShareLocale): string {
  const words = permissions.map((permission) => MAY_WORDS[permission][locale])
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} ${locale === 'it' ? 'e' : 'and'} ${words.at(-1)}`
}

export interface InviteMailFacts {
  readonly companyName: string
  /** Who invites (the office person's name), or null for the company itself. */
  readonly inviterName: string | null
  /** The record as the partner reads it ("Ordine SO-2026-0042" / "Order SO-2026-0042"). */
  readonly label: string
  readonly permissions: readonly SharePermission[]
  readonly expiresAt: Date
  readonly note: string | null
}

export function inviteMail(locale: ShareLocale, facts: InviteMailFacts, url: string): Mail {
  const who = facts.inviterName ? `${facts.inviterName} (${facts.companyName})` : facts.companyName
  const until = shareDayOf(facts.expiresAt, locale)
  const may = mayWords(facts.permissions, locale)
  if (locale === 'it') {
    return {
      subject: `${facts.companyName} vi invita: ${facts.label}`,
      body: [
        'Buongiorno,',
        '',
        `${who} vi ha aggiunto a ${facts.label}.`,
        ...(facts.note ? ['', facts.note] : []),
        '',
        `Con questo link potete ${may} fino al ${until}, senza creare un account:`,
        url,
        '',
        'Vedete solo i dati e i file che condividiamo con voi su questo record. Il link è solo per voi: non inoltratelo.',
      ].join('\n'),
    }
  }
  return {
    subject: `${facts.companyName} invites you: ${facts.label}`,
    body: [
      'Hello,',
      '',
      `${who} added you to ${facts.label}.`,
      ...(facts.note ? ['', facts.note] : []),
      '',
      `With this link you can ${may} until ${until}, without an account:`,
      url,
      '',
      'You see only the details and files we share with you on this record. The link is for you only: please do not forward it.',
    ].join('\n'),
  }
}

export interface MessageMailFacts {
  readonly companyName: string
  readonly label: string
  /** Who wrote it: a person's name, or the company. */
  readonly authorName: string
  /** The first lines of the message. */
  readonly excerpt: string
}

export function newMessageMail(locale: ShareLocale, facts: MessageMailFacts): Mail {
  if (locale === 'it') {
    return {
      subject: `Nuovo messaggio: ${facts.label} — ${facts.companyName}`,
      body: [
        'Buongiorno,',
        '',
        `${facts.authorName} ha scritto su ${facts.label}:`,
        '',
        facts.excerpt,
        '',
        "Per leggere tutto e rispondere aprite il link del nostro invito. Per non ricevere più queste e-mail, spegnete «Avvisami per e-mail» nella stessa pagina.",
      ].join('\n'),
    }
  }
  return {
    subject: `New message: ${facts.label} — ${facts.companyName}`,
    body: [
      'Hello,',
      '',
      `${facts.authorName} wrote on ${facts.label}:`,
      '',
      facts.excerpt,
      '',
      'To read everything and answer, open the link of our invitation. To stop these e-mails, turn off "E-mail me" on the same page.',
    ].join('\n'),
  }
}

/** The record as a mail names it: its kind and number ("Ordine SO-2026-0042"). */
const RECORD_WORDS: Readonly<Record<string, { readonly it: string; readonly en: string }>> = Object.freeze({
  Style: { it: 'Modello', en: 'Style' },
  Quote: { it: 'Offerta', en: 'Quote' },
  SalesOrder: { it: 'Ordine', en: 'Order' },
  PurchaseOrder: { it: "Ordine d'acquisto", en: 'Purchase order' },
  SubcontractOrder: { it: 'Lavorazione', en: 'Subcontract order' },
  Shipment: { it: 'Spedizione', en: 'Shipment' },
  Complaint: { it: 'Reclamo', en: 'Complaint' },
  ReturnAuthorisation: { it: 'Reso', en: 'Return' },
  SupplierClaim: { it: 'Contestazione', en: 'Supplier claim' },
})

export function recordLabelOf(recordType: string, reference: string, locale: ShareLocale): string {
  const kind = RECORD_WORDS[recordType]?.[locale]
  return kind ? `${kind} ${reference}` : reference
}
