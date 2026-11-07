import { formatExpiry } from '../../email/compose'
import { escapeHtml, footerOf, safeUrl, type CompanyLegal } from '../../email/footer'
import type { Locale } from '../../email/rules'

/**
 * The portal's sign-in e-mails (B-W2b-159; PLT-050; design portal.signin email-step "One e-mail holds BOTH a link and a
 * 6-digit code"; the step-up dialog "We sent a 6-digit code to …"), in Italian and English, pure. The code and the link
 * are in the text and HTML only: the subject (stored on EmailOutbound) never holds them, and the caller keeps neither.
 *
 *   auth.portal_sign_in   the code, the link that signs in on Continue, until when both work, "ignore it if you did not
 *                         ask: nobody can sign in without the code"
 *   auth.portal_step_up   the code that confirms a sensitive act in an open portal session
 *
 * The template keys start with `auth.`: the mail delivery log shows them as sign-in mail (platform/email-out/delivery).
 */

export const PORTAL_MAIL_TEMPLATES = { sign_in: 'auth.portal_sign_in', step_up: 'auth.portal_step_up' } as const

export type PortalMailInput =
  | {
      readonly template: 'auth.portal_sign_in'
      readonly recipientName: string
      /** The company whose portal it is, as partners know it. */
      readonly portalName: string
      readonly code: string
      readonly link: string
      readonly expiresAt: Date
    }
  | {
      readonly template: 'auth.portal_step_up'
      readonly recipientName: string
      readonly portalName: string
      readonly code: string
      readonly expiresAt: Date
    }

export interface PortalMailContext {
  readonly locale: Locale
  readonly company: CompanyLegal
  readonly privacyUrl: string
  readonly timeZone?: string
}

export interface PortalMail {
  readonly subject: string
  readonly text: string
  readonly html: string
}

const WORDS = {
  it: {
    hello: (name: string) => `Buongiorno ${name},`,
    signInSubject: (portal: string) => `Accesso al portale ${portal}`,
    signInCode: (portal: string) => `ecco il codice per accedere al portale ${portal}:`,
    orLink: 'Oppure apri questo link e premi Continua:',
    button: 'Apri il portale',
    signInExpires: (when: string) => `Il codice e il link valgono una sola volta, per 15 minuti, fino al ${when}.`,
    signInIgnore: 'Se non hai chiesto di accedere puoi ignorare questa email: nessuno può entrare senza il codice.',
    stepUpSubject: (portal: string) => `Conferma che sei tu - portale ${portal}`,
    stepUpCode: (portal: string) => `ecco il codice per confermare un'operazione sul portale ${portal}:`,
    stepUpExpires: (when: string) => `Il codice vale una sola volta, fino al ${when}.`,
    stepUpIgnore: 'Se non stavi usando il portale, avvisa subito il tuo contatto: qualcuno potrebbe usare il tuo accesso.',
  },
  en: {
    hello: (name: string) => `Hello ${name},`,
    signInSubject: (portal: string) => `Sign in to the ${portal} portal`,
    signInCode: (portal: string) => `here is your code to sign in to the ${portal} portal:`,
    orLink: 'Or open this link and press Continue:',
    button: 'Open the portal',
    signInExpires: (when: string) => `The code and the link work once, for 15 minutes, until ${when}.`,
    signInIgnore: 'If you did not ask to sign in, you can ignore this e-mail: nobody can sign in without the code.',
    stepUpSubject: (portal: string) => `Confirm it's you - ${portal} portal`,
    stepUpCode: (portal: string) => `here is your code to confirm an action on the ${portal} portal:`,
    stepUpExpires: (when: string) => `The code works once, until ${when}.`,
    stepUpIgnore: 'If you were not using the portal, tell your contact at once: someone may be using your access.',
  },
} as const

const paragraph = (text: string): string => `<p style="margin:0 0 12px">${escapeHtml(text).replace(/\n/g, '<br>')}</p>`
const codeBlock = (code: string): string =>
  `<p style="margin:12px 0;font-size:28px;font-weight:bold;letter-spacing:6px;font-family:Consolas,Menlo,monospace">${escapeHtml(code)}</p>`
const button = (url: string, label: string): string =>
  `<p style="margin:16px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#1f4e79;color:#ffffff;text-decoration:none;border-radius:4px">${escapeHtml(label)}</a></p>`
const page = (inner: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222">${inner}</body></html>`

/** The subject, text and HTML of one portal mail. Throws on a code that is not six digits or a link that is not http(s). */
export function composePortalMail(input: PortalMailInput, context: PortalMailContext): PortalMail {
  if (!/^\d{6}$/.test(input.code)) throw new Error('A portal mail carries a 6-digit code.')
  const words = WORDS[context.locale]
  const footer = footerOf(context.company, context.privacyUrl, context.locale)
  const when = formatExpiry(input.expiresAt, context.locale, context.timeZone)
  const hello = words.hello(input.recipientName)

  if (input.template === 'auth.portal_sign_in') {
    const link = safeUrl(input.link)
    if (!link) throw new Error('A portal sign-in mail needs an http(s) link.')
    const lead = words.signInCode(input.portalName)
    const expires = words.signInExpires(when)
    const text = [hello, lead, input.code, `${words.orLink}\n${link}`, expires, words.signInIgnore, footer.text].join('\n\n')
    const html = page(
      paragraph(hello) + paragraph(lead) + codeBlock(input.code) + paragraph(words.orLink) + button(link, words.button) + paragraph(link) + paragraph(expires) + paragraph(words.signInIgnore) + footer.html,
    )
    return { subject: words.signInSubject(input.portalName), text, html }
  }
  const lead = words.stepUpCode(input.portalName)
  const expires = words.stepUpExpires(when)
  const text = [hello, lead, input.code, expires, words.stepUpIgnore, footer.text].join('\n\n')
  const html = page(paragraph(hello) + paragraph(lead) + codeBlock(input.code) + paragraph(expires) + paragraph(words.stepUpIgnore) + footer.html)
  return { subject: words.stepUpSubject(input.portalName), text, html }
}
