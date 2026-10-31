'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
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
import { liveBus } from '../live/bus'
import { useLiveState } from '../live/use-live'
import { isWindowPage, officeNavFor, OFFICE_PAGES } from '../nav/office-nav'
import { useRecordSearch } from '../palette/use-record-search'
import { isPrintView, printKindOf } from '../print/print-model'
import { PrintModeProvider } from '../print/print-mode'
import { OfficeScopeProvider, type OfficeScopeValue } from '../scope/scope-context'
import { scopeOf } from '../scope/scope-model'
import { lastPageOf, readLastPages, writeLastPages, type LastPages } from './phone-bar'
import { useBell } from './use-bell'
import { OfficeShellView, type OfficeFrame, type SystemBanner } from './view/OfficeShellView'

/**
 * The live Office shell: the signed-in person (from the office layout) → the shell's view model. It owns what the view
 * does not: the address (company and page), client-side navigation, the remembered site and company (per person,
 * scope-memory.ts), signing out, and the page language on `<html>` (the person's own, PLT-127).
 * B-W2b-05: the scope every page reads (company and site, `useOfficeScope`), the tab's one live connection, the frame
 * (the Office, a window page, the print view of any page) and the last page per area for the phone's tabs.
 */
export function OfficeShell({ session, company, site: initialSite = null, children }: { session: OfficeSession; company: string; site?: string | null; children?: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname() ?? `/w/${company}`
  const search = useSearchParams()
  const locale = useLocale()
  const { path } = splitOfficePath(pathname)
  const person = useMemo(() => ({ tenantId: session.tenant.id, userId: session.user.id }), [session.tenant.id, session.user.id])
  // The site this person last chose in this company (among the sites their roles reach; the layout read it, so the
  // first paint already shows it and a page reads once); then remember this company (and site) for them.
  const [site, setSite] = useState<string | null>(initialSite)
  useEffect(() => {
    const remembered = recallScope(readCookie(SCOPE_COOKIE), person, { companies: [company], sites: session.sites.map((s) => s.id) })
    setSite((current) => (current === (remembered?.site ?? null) ? current : (remembered?.site ?? null)))
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
  // B-W2a-32: the palette's Records and Exact number groups (GET /search as this company).
  const recordSearch = useRecordSearch({ company, companies: session.companies })
  // B-W2a-40: the bell — unread notifications, one light read, then live (only for a person who reaches Home).
  const bell = useBell(company, session.permissions.includes('home.view'))
  // No API reports the connections' modes yet (Connections, SCR-087, comes with B-W0-28): no TEST MODE banner until it does.
  const banners: SystemBanner[] = []

  // B-W2b-05 (COL-077): the tab's ONE live connection stays open while the Office is (the bell and every page share it).
  useEffect(() => liveBus().subscribe({}), [])
  const live = useLiveState()

  // B-W2b-05 (PLT-008): the company and site every page reads.
  const scope = useMemo<OfficeScopeValue>(
    () => ({ ...scopeOf({ company: session.company, sites: session.sites, everySite: session.allSites, chosen: site }), setSite }),
    [session.company, session.sites, session.allSites, site],
  )

  // B-W2b-05 (PLT-162): the page of each area this person used last (the phone's tabs open there).
  const personKey = `${person.tenantId}:${person.userId}`
  const [lastPages, setLastPages] = useState<LastPages>({})
  useEffect(() => setLastPages(readLastPages(personKey)), [personKey])
  useEffect(() => {
    const here = lastPageOf(nav, path)
    if (!here || isWindowPage(path)) return
    setLastPages((current) => {
      if (current[here.area] === here.page) return current
      const next = { ...current, [here.area]: here.page }
      writeLastPages(personKey, next)
      return next
    })
  }, [nav, path, personKey])

  // B-W2b-05: the frame — the print view of any page (`?print=1`), a window page (WINDOW_PAGES), or the Office.
  const printing = isPrintView(search)
  const frame: OfficeFrame = printing ? 'print' : isWindowPage(path) ? 'window' : 'office'
  const query = search?.toString() ?? ''
  const [printedAt] = useState(() => new Date().toISOString())

  return (
    <OfficeShellView
      model={{
        nav,
        path,
        query,
        frame,
        printKind: printKindOf(path, OFFICE_PAGES),
        printedAt,
        live,
        lastPages,
        switcher: { companies: session.companies, company, sites: session.sites, site: scope.siteId, path, limited: scope.limited },
        user: { displayName: session.user.displayName, email: session.user.email },
        tenantTag: tenantTag(session.tenant.id),
        banners,
        paletteRecords: recordSearch.records,
        bell,
      }}
      onNavigate={(href) => router.push(href)}
      onSiteChange={setSite}
      onPaletteQuery={recordSearch.onQuery}
      onSignOut={() => {
        void signOut(browserApi())
          .catch(() => undefined)
          .finally(() => router.replace('/sign-in'))
      }}
    >
      {/* The pages see the company session (`useOfficeSession`, `useOfficeApi` with its x-factory-company). */}
      <OfficeSessionProvider session={session}>
        <OfficeScopeProvider value={scope}>
          <PrintModeProvider printing={printing}>
            {/* B-W2a-23: every list frame's saved views and export. */}
            <ListToolsProvider>{children}</ListToolsProvider>
          </PrintModeProvider>
        </OfficeScopeProvider>
      </OfficeSessionProvider>
    </OfficeShellView>
  )
}
