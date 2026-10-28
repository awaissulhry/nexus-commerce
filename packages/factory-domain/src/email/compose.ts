import { escapeHtml, footerOf, safeUrl, type CompanyLegal } from './footer'
import type { Locale, TemplateKey } from './rules'

/**
 * What a mail says (features PLT-139, COL-024): the plain text and the safe HTML of each template, in Italian and
 * English, pure. The HTML is made here from escaped text only (no markup from a person, a record or a link ever passes
 * through unescaped), and every link is an http(s) URL; the plain text says the same. The footer (footer.ts) closes
 * every mail.
 *
 *   thread.message        a person's message on a record's thread: their text, their signature, the names of the
 *                         record's files they shared with it, the footer
 *   auth.invitation       an invitation to the tenant's Office, with its single-use link
 *   auth.password_reset   a password reset, with its single-use link
 *
 * A sign-in mail's link is in the text it returns: the caller sends it and keeps neither.
 */

export type ComposeInput =
  | {
      readonly template: 'thread.message'
      /** The person's text, cleaned (threads' cleanBody). */
      readonly body: string
      /** The sender's name for the signature; null for the system. */
      readonly senderName: string | null
      /** The company's name as mail shows it. */
      readonly companyName: string
      /** The names of the record's files shared with the recipient (their bytes travel through the portal or a link). */
      readonly attachmentNames: readonly string[]
    }
  | {
      readonly template: 'auth.invitation'
      readonly recipientName: string
      readonly inviterName: string | null
      /** The tenant (group) the person joins. */
      readonly tenantName: string
      readonly link: string
      readonly expiresAt: Date
    }
  | {
      readonly template: 'auth.password_reset'
      readonly recipientName: string
      readonly link: string
      readonly expiresAt: Date
    }

export interface ComposeContext {
  readonly locale: Locale
  readonly company: CompanyLegal
  /** The company's privacy notice (footer.ts privacyNoticeUrl). */
  readonly privacyUrl: string
  /** The time zone the expiry of a link is written in. Default Europe/Rome. */
  readonly timeZone?: string
}

export interface Composed {
  /** The subject a template sets (sign-in mails); a thread message keeps the one the person wrote. */
  readonly subject: string | null
  readonly text: string
  readonly html: string
}

const TEXT = {
  it: {
    files: 'File condivisi con te su questo argomento:',
    invitationSubject: (tenant: string) => `Invito a ${tenant} su Nexus Factory`,
    hello: (name: string) => `Buongiorno ${name},`,
    invited: (inviter: string | null, tenant: string) =>
      inviter ? `${inviter} ti ha invitato a lavorare con ${tenant} su Nexus Factory.` : `Sei stato invitato a lavorare con ${tenant} su Nexus Factory.`,
    accept: 'Per accettare e scegliere la tua password apri questo link:',
    resetSubject: 'Nuova password per Nexus Factory',
    reset: 'Abbiamo ricevuto una richiesta di nuova password per il tuo account Nexus Factory. Per sceglierla apri questo link:',
    expires: (when: string) => `Il link vale una sola volta, fino al ${when}.`,
    ignore: 'Se non ti aspettavi questa email puoi ignorarla.',
    button: { invitation: 'Accetta l\'invito', reset: 'Scegli una nuova password' },
  },
  en: {
    files: 'Files shared with you on this matter:',
    invitationSubject: (tenant: string) => `Invitation to ${tenant} on Nexus Factory`,
    hello: (name: string) => `Hello ${name},`,
    invited: (inviter: string | null, tenant: string) =>
      inviter ? `${inviter} invited you to work with ${tenant} on Nexus Factory.` : `You were invited to work with ${tenant} on Nexus Factory.`,
    accept: 'To accept and choose your password, open this link:',
    resetSubject: 'New password for Nexus Factory',
    reset: 'We received a request for a new password for your Nexus Factory account. To choose it, open this link:',
    expires: (when: string) => `The link works once, until ${when}.`,
    ignore: 'If you did not expect this email, you can ignore it.',
    button: { invitation: 'Accept the invitation', reset: 'Choose a new password' },
  },
} as const

/** A time as the reader's notation writes it, in the business time zone: `31/10/2026, 10:00 (Europe/Rome)`. */
export function formatExpiry(instant: Date, locale: Locale, timeZone = 'Europe/Rome'): string {
  const formatted = new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { timeZone, dateStyle: 'short', timeStyle: 'short' }).format(instant)
  return `${formatted} (${timeZone})`
}

const paragraph = (text: string): string => `<p style="margin:0 0 12px">${escapeHtml(text).replace(/\n/g, '<br>')}</p>`
const button = (url: string, label: string): string =>
  `<p style="margin:16px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#1f4e79;color:#ffffff;text-decoration:none;border-radius:4px">${escapeHtml(label)}</a></p>`
const page = (inner: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222">${inner}</body></html>`

/** The text and HTML of one mail. Throws on a link that is not http(s): it is never put into a mail. */
export function compose(input: ComposeInput, context: ComposeContext): Composed {
  const words = TEXT[context.locale]
  const footer = footerOf(context.company, context.privacyUrl, context.locale)

  if (input.template === 'thread.message') {
    const signature = [input.senderName, input.companyName].filter((part): part is string => !!part && part.trim() !== '').join('\n')
    const files = input.attachmentNames.length > 0 ? [words.files, ...input.attachmentNames.map((name) => `- ${name}`)].join('\n') : ''
    const text = [input.body, signature, files, footer.text].filter((part) => part !== '').join('\n\n')
    const html = page(
      input.body
        .split(/\n{2,}/)
        .filter((part) => part.trim() !== '')
        .map(paragraph)
        .join('') +
        (signature ? paragraph(signature) : '') +
        (input.attachmentNames.length > 0
          ? `${paragraph(words.files)}<ul style="margin:0 0 12px">${input.attachmentNames.map((name) => `<li>${escapeHtml(name)}</li>`).join('')}</ul>`
          : '') +
        footer.html,
    )
    return { subject: null, text, html }
  }

  const link = safeUrl(input.link)
  if (!link) throw new Error('A sign-in mail needs an http(s) link.')
  const expires = words.expires(formatExpiry(input.expiresAt, context.locale, context.timeZone))
  const hello = words.hello(input.recipientName)
  if (input.template === 'auth.invitation') {
    const invited = words.invited(input.inviterName, input.tenantName)
    const text = [hello, invited, `${words.accept}\n${link}`, expires, words.ignore, footer.text].join('\n\n')
    const html = page(paragraph(hello) + paragraph(invited) + paragraph(words.accept) + button(link, words.button.invitation) + paragraph(link) + paragraph(expires) + paragraph(words.ignore) + footer.html)
    return { subject: words.invitationSubject(input.tenantName), text, html }
  }
  const text = [hello, `${words.reset}\n${link}`, expires, words.ignore, footer.text].join('\n\n')
  const html = page(paragraph(hello) + paragraph(words.reset) + button(link, words.button.reset) + paragraph(link) + paragraph(expires) + paragraph(words.ignore) + footer.html)
  return { subject: words.resetSubject, text, html }
}

/** The template of each kind of sign-in mail. */
export const AUTH_TEMPLATES = { invitation: 'auth.invitation', password_reset: 'auth.password_reset' } as const satisfies Record<string, TemplateKey>
