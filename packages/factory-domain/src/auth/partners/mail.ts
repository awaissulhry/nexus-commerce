import { formatExpiry } from '../../email/compose'
import { escapeHtml, footerOf, safeUrl } from '../../email/footer'
import type { PortalMailContext } from '../portal/mail'

/**
 * The partner people's e-mails (B-W2b-162; PLT-006, PLT-022; Owner answer C3: e-mail codes, no password), in Italian and
 * English, pure. Neither holds a secret: the invitation names the portal's sign-in page, where the person types their
 * address and gets a code (B-W2b-159); the first sign-in accepts the invitation.
 *
 *   auth.portal_invitation     who invited them to which company's portal, as which role, until when the invitation works
 *                              and, when there is one, the end of their access
 *   auth.portal_access_ending  their access ends on a date within 7 days; whom to ask if they still need it
 *
 * The template keys start with `auth.`: the mail delivery log shows them with the sign-in mail.
 */

export const PARTNER_MAIL_TEMPLATES = { invitation: 'auth.portal_invitation', access_ending: 'auth.portal_access_ending' } as const

export type PartnerMailInput =
  | {
      readonly template: 'auth.portal_invitation'
      readonly recipientName: string
      /** The company whose portal it is, as partners know it. */
      readonly portalName: string
      /** The partner organisation's name. */
      readonly organisation: string
      /** Who invited, as the person knows them ("Anna Rossi (Example S.r.l.)"). */
      readonly invitedBy: string
      /** The role's name (Buyer, Orders…). */
      readonly roleName: string
      /** The portal's sign-in page. */
      readonly link: string
      readonly expiresAt: Date
      readonly accessUntil: Date | null
    }
  | {
      readonly template: 'auth.portal_access_ending'
      readonly recipientName: string
      readonly portalName: string
      readonly accessUntil: Date
      /** Whom to ask: "<company> (<address>)". */
      readonly contact: string
    }

export interface PartnerMail {
  readonly subject: string
  readonly text: string
  readonly html: string
}

const WORDS = {
  it: {
    hello: (name: string) => `Buongiorno ${name},`,
    inviteSubject: (portal: string) => `Invito al portale ${portal}`,
    invite: (by: string, portal: string, organisation: string, role: string) =>
      `${by} ti ha invitato al portale ${portal} per ${organisation}, con il ruolo ${role}.`,
    how: "Apri il portale e scrivi questo indirizzo e-mail: ti inviamo un codice di 6 cifre per entrare. Non serve una password.",
    button: 'Apri il portale',
    inviteExpires: (when: string) => `L'invito vale fino al ${when}.`,
    accessUntil: (when: string) => `Il tuo accesso dura fino al ${when}.`,
    inviteIgnore: 'Se non conosci chi ti ha invitato puoi ignorare questa email.',
    endingSubject: (portal: string) => `Il tuo accesso al portale ${portal} sta per finire`,
    ending: (portal: string, when: string) => `il tuo accesso al portale ${portal} finisce il ${when}.`,
    endingAsk: (contact: string) => `Se ti serve ancora, scrivi a ${contact}.`,
  },
  en: {
    hello: (name: string) => `Hello ${name},`,
    inviteSubject: (portal: string) => `Invitation to the ${portal} portal`,
    invite: (by: string, portal: string, organisation: string, role: string) =>
      `${by} invited you to the ${portal} portal for ${organisation}, as ${role}.`,
    how: 'Open the portal and type this e-mail address: we send you a 6-digit code to sign in. No password is needed.',
    button: 'Open the portal',
    inviteExpires: (when: string) => `The invitation works until ${when}.`,
    accessUntil: (when: string) => `Your access lasts until ${when}.`,
    inviteIgnore: 'If you do not know who invited you, you can ignore this e-mail.',
    endingSubject: (portal: string) => `Your access to the ${portal} portal ends soon`,
    ending: (portal: string, when: string) => `your access to the ${portal} portal ends on ${when}.`,
    endingAsk: (contact: string) => `If you still need it, write to ${contact}.`,
  },
} as const

const paragraph = (text: string): string => `<p style="margin:0 0 12px">${escapeHtml(text)}</p>`
const button = (url: string, label: string): string =>
  `<p style="margin:16px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#1f4e79;color:#ffffff;text-decoration:none;border-radius:4px">${escapeHtml(label)}</a></p>`
const page = (inner: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222">${inner}</body></html>`

/** The subject, text and HTML of one partner mail. Throws on a link that is not http(s). */
export function composePartnerMail(input: PartnerMailInput, context: PortalMailContext): PartnerMail {
  const words = WORDS[context.locale]
  const footer = footerOf(context.company, context.privacyUrl, context.locale)
  const hello = words.hello(input.recipientName)
  if (input.template === 'auth.portal_invitation') {
    const link = safeUrl(input.link)
    if (!link) throw new Error('A portal invitation needs an http(s) link.')
    const lines = [
      words.invite(input.invitedBy, input.portalName, input.organisation, input.roleName),
      words.how,
      words.inviteExpires(formatExpiry(input.expiresAt, context.locale, context.timeZone)),
      ...(input.accessUntil ? [words.accessUntil(formatExpiry(input.accessUntil, context.locale, context.timeZone))] : []),
      words.inviteIgnore,
    ]
    const text = [hello, lines[0], lines[1], link, ...lines.slice(2), footer.text].join('\n\n')
    const html = page(paragraph(hello) + paragraph(lines[0]!) + paragraph(lines[1]!) + button(link, words.button) + paragraph(link) + lines.slice(2).map(paragraph).join('') + footer.html)
    return { subject: words.inviteSubject(input.portalName), text, html }
  }
  const ending = words.ending(input.portalName, formatExpiry(input.accessUntil, context.locale, context.timeZone))
  const ask = words.endingAsk(input.contact)
  const text = [hello, ending, ask, footer.text].join('\n\n')
  const html = page(paragraph(hello) + paragraph(ending) + paragraph(ask) + footer.html)
  return { subject: words.endingSubject(input.portalName), text, html }
}
