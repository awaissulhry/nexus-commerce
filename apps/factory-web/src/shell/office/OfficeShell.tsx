'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { browserApi } from '../../lib/api/browser'
import { signOut } from '../../lib/api/office'
import { readCookie, writeCookie } from '../../lib/cookies'
import { LOCALE_COOKIE } from '../../lib/i18n/locales'
import { useLocale } from '../../lib/i18n/provider'
import { OfficeSessionProvider } from '../../lib/session/context'
import { recallScope, rememberScope, SCOPE_COOKIE } from '../../lib/session/scope-memory'
import { permissionCheck, splitOfficePath, type OfficeSession } from '../../lib/session/session'
import { ListToolsProvider } from '../../areas/_shared/list-tools/ListToolsProvider'
import { officeNavFor } from '../nav/office-nav'
import { OfficeShellView, type SystemBanner } from './view/OfficeShellView'

/**
 * The live Office shell: the signed-in person (from the office layout) → the shell's view model. It owns what the view
 * does not: the address (company and page), client-side navigation, the remembered site and company (per person,
 * scope-memory.ts), signing out, and the page language on `<html>` (the person's own, PLT-127).
 */
export function OfficeShell({ session, company, children }: { session: OfficeSession; company: string; children?: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname() ?? `/w/${company}`
  const locale = useLocale()
  const { path } = splitOfficePath(pathname)
  const person = useMemo(() => ({ tenantId: session.tenant.id, userId: session.user.id }), [session.tenant.id, session.user.id])
  const [site, setSite] = useState<string | null>(null)

  // The site this person last chose in this company; then remember this company (and site) for them.
  useEffect(() => {
    const remembered = recallScope(readCookie(SCOPE_COOKIE), person, { companies: [company], sites: session.sites.map((s) => s.id) })
    setSite(remembered?.site ?? null)
  }, [person, company, session.sites])
  useEffect(() => {
    writeCookie(SCOPE_COOKIE, rememberScope(readCookie(SCOPE_COOKIE), person, { company, site }), 400)
  }, [person, company, site])

  // The person's language is the page's (the root layout read the cookie; the next load reads this one).
  useEffect(() => {
    document.documentElement.lang = locale
    if (readCookie(LOCALE_COOKIE) !== locale) writeCookie(LOCALE_COOKIE, locale)
  }, [locale])

  const nav = useMemo(() => officeNavFor(permissionCheck(session.permissions)), [session.permissions])
  // No API reports the connections' modes yet (Connections, SCR-087, comes with B-W0-28): no TEST MODE banner until it does.
  const banners: SystemBanner[] = []

  return (
    <OfficeShellView
      model={{
        nav,
        path,
        switcher: { companies: session.companies, company, sites: session.sites, site, path },
        user: { displayName: session.user.displayName, email: session.user.email },
        tenantTag: tenantTag(session.tenant.id),
        banners,
      }}
      onNavigate={(href) => router.push(href)}
      onSiteChange={setSite}
      onSignOut={() => {
        void signOut(browserApi())
          .catch(() => undefined)
          .finally(() => router.replace('/sign-in'))
      }}
    >
      {/* The pages see the company session (`useOfficeSession`, `useOfficeApi` with its x-factory-company). */}
      <OfficeSessionProvider session={session}>
        {/* B-W2a-23: every list frame's saved views and export. */}
        <ListToolsProvider>{children}</ListToolsProvider>
      </OfficeSessionProvider>
    </OfficeShellView>
  )
}
