import { createHmac, timingSafeEqual } from 'node:crypto'
import { escapeHtml, safeUrl, type Footer } from '../../email/footer'
import type { PortalLocale } from '../tasks/kinds'

/**
 * The e-mails a partner person gets from the portal (B-W2b-167; PLT-148, COL-063; design portal.frame E-mail settings "also
 * the 'Manage e-mails' link in every e-mail footer", "Unsubscribe from all non-essential mail in one switch (GDPR)"):
 *
 *   portal.notification   one notification as it happens (an INSTANT topic, a transactional one, a reminder set so)
 *   portal.digest         the daily or weekly summary: the notifications of the DAILY (and on Monday the WEEKLY) topics not
 *                         e-mailed yet
 *
 * Every mail ends with the person's two links before the company's legal footer: "Manage e-mails" (the portal's E-mail
 * settings) and "Unsubscribe from non-essential mail" (a signed link: one press turns every non-essential topic off;
 * order, delivery and invoice mail keeps coming, and the mail says so). Composed in memory; the body is never stored.
 */

export const PORTAL_MAIL_TEMPLATES = { notification: 'portal.notification', digest: 'portal.digest' } as const
export const DIGEST_MAX_ITEMS = 50

export interface MailItem {
  readonly sentence: string
  /** The record's page in the portal (absolute). */
  readonly link: string
}

export interface MailLinks {
  readonly manage: string
  readonly unsubscribe: string
}

export interface ComposedMail {
  readonly subject: string
  readonly text: string
  readonly html: string
}

const WORDS = {
  it: {
    hello: (name: string) => `Ciao ${name},`,
    open: 'Apri nel portale',
    digestIntro: (company: string) => `ecco le novità dal portale di ${company}:`,
    daily: (company: string, count: number) => `Il tuo riepilogo giornaliero da ${company}: ${count} ${count === 1 ? 'novità' : 'novità'}`,
    weekly: (company: string, count: number) => `Il tuo riepilogo settimanale da ${company}: ${count} ${count === 1 ? 'novità' : 'novità'}`,
    more: (count: number) => `e altre ${count} nel portale.`,
    manage: 'Gestisci le e-mail',
    unsubscribe: 'Disiscriviti dalle e-mail non essenziali',
    essential: 'Le e-mail su ordini, consegne e fatture continuano ad arrivare: servono per gestire i tuoi ordini.',
  },
  en: {
    hello: (name: string) => `Hello ${name},`,
    open: 'Open in the portal',
    digestIntro: (company: string) => `this is what is new in the ${company} portal:`,
    daily: (company: string, count: number) => `Your daily summary from ${company}: ${count} ${count === 1 ? 'update' : 'updates'}`,
    weekly: (company: string, count: number) => `Your weekly summary from ${company}: ${count} ${count === 1 ? 'update' : 'updates'}`,
    more: (count: number) => `and ${count} more in the portal.`,
    manage: 'Manage e-mails',
    unsubscribe: 'Unsubscribe from non-essential mail',
    essential: 'Order, delivery and invoice mail keeps coming: it is needed to run your orders.',
  },
} as const

function linkOrThrow(value: string): string {
  const url = safeUrl(value)
  if (!url) throw new Error('A portal mail link must be an http(s) URL.')
  return url
}

function closing(links: MailLinks, footer: Footer, locale: PortalLocale): { text: string[]; html: string } {
  const words = WORDS[locale]
  const manage = linkOrThrow(links.manage)
  const unsubscribe = linkOrThrow(links.unsubscribe)
  return {
    text: ['', `${words.manage}: ${manage}`, `${words.unsubscribe}: ${unsubscribe}`, words.essential, '', footer.text],
    html:
      '<p style="color:#666666;font-size:12px">' +
      `<a href="${escapeHtml(manage)}" style="color:#666666">${escapeHtml(words.manage)}</a> · ` +
      `<a href="${escapeHtml(unsubscribe)}" style="color:#666666">${escapeHtml(words.unsubscribe)}</a><br>${escapeHtml(words.essential)}</p>` +
      footer.html,
  }
}

/** One notification as it happens. */
export function composeNotificationMail(input: { readonly recipientName: string; readonly item: MailItem; readonly links: MailLinks; readonly footer: Footer; readonly locale: PortalLocale }): ComposedMail {
  const words = WORDS[input.locale]
  const link = linkOrThrow(input.item.link)
  const end = closing(input.links, input.footer, input.locale)
  const text = [words.hello(input.recipientName), '', input.item.sentence, '', `${words.open}: ${link}`, ...end.text].join('\n')
  const html =
    `<p>${escapeHtml(words.hello(input.recipientName))}</p><p>${escapeHtml(input.item.sentence)}</p>` +
    `<p><a href="${escapeHtml(link)}">${escapeHtml(words.open)}</a></p>` +
    end.html
  return { subject: input.item.sentence.slice(0, 200), text, html }
}

/** The daily or weekly summary: at most 50 items listed, "and N more in the portal". */
export function composeDigestMail(input: {
  readonly recipientName: string
  readonly company: string
  readonly weekly: boolean
  readonly items: readonly MailItem[]
  readonly more: number
  readonly links: MailLinks
  readonly footer: Footer
  readonly locale: PortalLocale
}): ComposedMail {
  const words = WORDS[input.locale]
  const total = input.items.length + input.more
  const subject = (input.weekly ? words.weekly : words.daily)(input.company, total)
  const end = closing(input.links, input.footer, input.locale)
  const lines = input.items.map((item) => `• ${item.sentence}\n  ${linkOrThrow(item.link)}`)
  const text = [words.hello(input.recipientName), words.digestIntro(input.company), '', ...lines, ...(input.more > 0 ? ['', words.more(input.more)] : []), ...end.text].join('\n')
  const html =
    `<p>${escapeHtml(words.hello(input.recipientName))}</p><p>${escapeHtml(words.digestIntro(input.company))}</p><ul>` +
    input.items.map((item) => `<li><a href="${escapeHtml(linkOrThrow(item.link))}">${escapeHtml(item.sentence)}</a></li>`).join('') +
    '</ul>' +
    (input.more > 0 ? `<p>${escapeHtml(words.more(input.more))}</p>` : '') +
    end.html
  return { subject, text, html }
}

// --- the unsubscribe link -----------------------------------------------------------------------------------------------------

/**
 * `pu1.<tenant>.<person>.<mac>`: the person's unsubscribe token, HMAC-SHA-256 with a key derived from the cookie secret.
 * It names nobody else and does nothing but turn the person's non-essential mail off; it does not expire (an old mail's
 * link keeps working). It travels in the link's fragment (`#token=`), never in a query string or an access log.
 */
const TOKEN = /^pu1\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/

const macOf = (key: Buffer, tenantId: string, userId: string): string => createHmac('sha256', key).update(`pu1|${tenantId}|${userId}`).digest('base64url')

export function unsubscribeToken(key: Buffer, tenantId: string, userId: string): string {
  return `pu1.${tenantId}.${userId}.${macOf(key, tenantId, userId)}`
}

/** The token's tenant and person, or null when it is not one we made. */
export function readUnsubscribeToken(key: Buffer, token: unknown): { tenantId: string; userId: string } | null {
  if (typeof token !== 'string') return null
  const match = TOKEN.exec(token)
  if (!match) return null
  const [, tenantId, userId, mac] = match as unknown as [string, string, string, string]
  const expected = Buffer.from(macOf(key, tenantId, userId))
  const given = Buffer.from(mac)
  return expected.length === given.length && timingSafeEqual(expected, given) ? { tenantId, userId } : null
}

/** The web page of the link (it reads `#token=`, shows what it will do and asks for one press). */
export const unsubscribeUrl = (webOrigin: string, token: string): string => `${webOrigin.replace(/\/+$/, '')}/p/unsubscribe#token=${encodeURIComponent(token)}`
