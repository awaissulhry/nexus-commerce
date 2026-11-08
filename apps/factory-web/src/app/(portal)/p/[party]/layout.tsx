import type { ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { requestLocale } from '../../../../lib/i18n/server'
import { addressNamesParty, localeOfPerson, portalPrefix, RESERVED_SEGMENTS } from '../../../../portal/shell/model'
import { PortalGate } from '../../../../portal/shell/PortalGate'
import { PortalShell } from '../../../../portal/shell/PortalShell'
import { loadPortalSession } from '../../../../portal/shell/server'

/**
 * One partner's portal (`/p/<party code>/…`; B-W2b-173, SCR-027): the portal session (`GET /portal/me`, the portal cookie
 * only), the person's own language (SCM-101: theirs after sign-in), the company's branding, and the frame. No session — or
 * the first visit's terms still due — goes to sign-in and comes back to the same address; an address of another
 * organisation says so. Every portal page sits in this frame.
 */
export default async function PartyLayout({ children, params }: { children: ReactNode; params: Promise<{ party: string }> }) {
  const { party } = await params
  if (RESERVED_SEGMENTS.has(party)) notFound()
  const load = await loadPortalSession()
  if (load.kind !== 'signed_in' || load.me.termsDue) {
    // No person yet: the page's language (the cookie, else the browser's).
    const locale = load.kind === 'signed_in' ? localeOfPerson(load.me.user.locale) : await requestLocale()
    return (
      <I18nProvider locale={locale} messages={messagesFor(locale, ['shell', 'portal'])}>
        {load.kind === 'unavailable' ? <PortalGate kind="api" code={load.code} /> : <PortalGate kind="sign-in" />}
      </I18nProvider>
    )
  }
  const { me, branding } = load
  const locale = localeOfPerson(me.user.locale)
  if (!addressNamesParty(party, me.party)) {
    return (
      <I18nProvider locale={locale} messages={messagesFor(locale, ['shell', 'portal'])}>
        <PortalGate kind="other" ownHref={portalPrefix(me.party.code)} />
      </I18nProvider>
    )
  }
  return (
    <I18nProvider locale={locale} messages={messagesFor(locale, ['shell', 'portal'])}>
      <PortalShell me={me} branding={branding}>
        {children}
      </PortalShell>
    </I18nProvider>
  )
}
