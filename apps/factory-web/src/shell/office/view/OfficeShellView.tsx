'use client'

import { forwardRef, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowLeft, Bell, LogOut, Monitor, Moon, Printer, Search, Sun, UserRound, X } from 'lucide-react'
import { Banner, Menu, SearchTrigger } from '@nexus/ui/components'
import { BottomBar } from '@nexus/ui/components/BottomBar/index'
import { DetailHeader, WorkspaceSubheader, type WorkspaceSubheaderProps } from '@nexus/ui/patterns'
import { AppRail, areaRailItems, areaSubNavGroups, findAreaNavPlace, type AreaNav, type RailLinkProps } from '@nexus/ui/patterns/shell/index'
import '@nexus/ui/patterns/shell/app-rail.css'
import { Button, Kbd, ToolbarButton } from '@nexus/ui/primitives'
import { useScopedT, useT } from '../../../lib/i18n/provider'
import { companyPrefix } from '../../../lib/session/session'
import { useTheme } from '../../../lib/theme/use-theme'
import { bellWords, type BellState } from '../../../areas/home/notifications/model'
import type { LiveState } from '../../live/bus'
import { isWindowPage, OFFICE_PAGES, officeCrumbs, palettePages, translateNav } from '../../nav/office-nav'
import type { PaletteRecords } from '../../palette/palette-model'
import { CommandPaletteView } from '../../palette/view/CommandPaletteView'
import { printAddressOf, viewHref, type PrintKind } from '../../print/print-model'
import { PrintFrameView } from '../../print/view/PrintFrameView'
import { scopeChip, scopeOf } from '../../scope/scope-model'
import { CompanySwitcherView, type CompanySwitcherViewModel } from '../../switcher/view/CompanySwitcherView'
import { areaTabHref, phoneNav, type LastPages } from '../phone-bar'
import '../office-shell.css'

/**
 * SCR-003 — the Office shell (PLT-160, PLT-173; A2 §1, §2.1). Composed from design-system parts only:
 *  - top bar: the brand, the company and site switcher (SCR-002), the search field that opens the palette (SCR-004,
 *    also ⌘K / Ctrl K), the bell (B-W2a-40: unread notifications in words, opens Home › Notifications), the theme button
 *    and the person's menu (profile, sign out);
 *  - system banners under it: TEST MODE while a fake or sandbox connection is active;
 *  - the main sidebar: the DS `AppRail`, one row per area the person may open (areas/<area>/nav.ts);
 *  - the area's sub-sidebar, as Commerce's Settings and product studio have it: the DS `WorkspaceSubheader` (NOT
 *    `pinned`) — a band on top of the page with the toggle BUTTON at its start and the page's place beside it (a dense
 *    `DetailHeader`: the page as its title, the area › group as its meta — the crumbs). The button opens the area's
 *    pages as an overlay from the left, under the top bar and beside the rail; there is no permanent column. Enter
 *    opens it, Esc closes it and the focus goes back to the button; choosing a page closes it. The same on a phone;
 *  - on a phone (under 720 px) no rail: the DS `BottomBar` — B-W2b-05 (PLT-162): the person's own 4 tabs
 *    (phone-bar.ts), each opening the area's page used last, and More (the DS sheet) with every other area.
 * B-W2b-05 also: the band says the tab's live state and holds Print (the page's print view in a new tab, PLT-171); a
 * WINDOW page (office-nav WINDOW_PAGES) is drawn in window mode — no rail, no Pages, no bottom bar: a slim bar with
 * Back to Office, the page's name, the company and site, the live state and Close — and its navigation row opens it
 * in a new tab; the PRINT view (`?print=1`) of any page is drawn by the print frame (shell/print).
 * Standard (office) density. The page itself is `children`, inside `<main id="main-content">`.
 */

/** Which frame the page is drawn in (B-W2b-05). */
export type OfficeFrame = 'office' | 'window' | 'print'

export interface SystemBanner {
  id: string
  kind: 'test-mode'
  /** The connections that run fake or in a sandbox ("Email (fake)"). */
  connections: readonly string[]
}

export interface OfficeShellViewModel {
  /** The navigation this person may open (`officeNavFor`); labels are message keys. */
  nav: AreaNav
  /** The current page without `/w/<company>`. */
  path: string
  /** B-W2b-05: the address terms (without `?`): the print view keeps them. */
  query?: string
  /** B-W2b-05: the frame (default the Office). */
  frame?: OfficeFrame
  /** B-W2b-05: what the band's Print opens (a record, a view), or null where the page is paper already. */
  printKind?: PrintKind | null
  /** B-W2b-05: when the print view was opened (UTC). */
  printedAt?: string
  /** B-W2b-05 (COL-077): the tab's live connection, said in the band (absent: not said, as in most design cases). */
  live?: LiveState
  /** B-W2b-05 (PLT-162): the page of each area the person used last (the phone's tabs open there). */
  lastPages?: LastPages
  switcher: CompanySwitcherViewModel
  user: { displayName: string; email: string }
  /** The signed-in tenant's label tag (the palette refuses another factory's labels). */
  tenantTag: string | null
  banners: readonly SystemBanner[]
  /** Badge counts by key (`approvals.waiting`); W0 has none. */
  counts?: Readonly<Record<string, number>>
  /** Open the palette at once (design fixtures). */
  paletteOpen?: boolean
  /** Open the area's navigation at once (design fixtures). */
  areaNavOpen?: boolean
  paletteQuery?: string
  /** B-W2a-32: what the record search answered for the palette (absent: no record search, as in the shell's cases). */
  paletteRecords?: PaletteRecords | null
  /**
   * B-W2a-40: the bell — the person's unread notifications (mentions, assignments, approvals, alerts, records they
   * follow). Absent or null: no bell (a person who does not reach Home). An unknown count shows no badge, never 0.
   */
  bell?: BellState | null
}

export interface OfficeShellViewProps {
  model: OfficeShellViewModel
  children?: ReactNode
  /**
   * Client-side navigation for a plain click and for the palette (the live shell's router). Absent: links load the page
   * and the palette only closes (the design index).
   */
  onNavigate?: (href: string) => void
  onSiteChange?: (site: string | null) => void
  onSignOut?: () => void
  /** B-W2a-32: the palette's field changed (the container searches the records). */
  onPaletteQuery?: (query: string) => void
}

/** Next's Link for the DS rail and bottom bar (they take the app's link). */
const ShellLink = forwardRef<HTMLAnchorElement, RailLinkProps & { onClick?: () => void }>(function ShellLink({ href, children, ...rest }, ref) {
  return (
    <Link ref={ref} href={href} {...rest}>
      {children}
    </Link>
  )
})

const isPlainClick = (event: MouseEvent<HTMLAnchorElement>) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

export function OfficeShellView({ model, children, onNavigate, onSiteChange, onSignOut, onPaletteQuery }: OfficeShellViewProps) {
  const t = useT('shell')
  const named = useScopedT('shell')
  const { mode, cycleTheme } = useTheme()
  const [paletteOpen, setPaletteOpen] = useState(model.paletteOpen ?? false)
  const [areaNavOpen, setAreaNavOpen] = useState(false)
  const [isMac, setIsMac] = useState(true)
  // The overlay sits under the top bar and beside the rail: the subheader measures them (as Commerce's Settings).
  const topBar = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [chrome, setChrome] = useState<WorkspaceSubheaderProps['chrome']>()

  const prefix = companyPrefix(model.switcher.company)
  const toHref = (address: string) => `${prefix}${address}`
  const fullPath = toHref(model.path === '/' ? '' : model.path)
  const nav = useMemo(() => translateNav(model.nav, named), [model.nav, named])
  const place = findAreaNavPlace(nav, model.path)
  const area = place?.area
  // The page's place (the crumbs): its name as the band's title, the area (› group) as its meta. A record under a page
  // keeps the page's name; the record page draws its own header below.
  const crumbs = officeCrumbs(nav, model.path)
  const here = crumbs.length > 1 ? crumbs[crumbs.length - 1].name : (area?.label ?? '')
  const above = crumbs.slice(0, -1).map((crumb) => crumb.name).join(' › ')
  const count = (key: string) => model.counts?.[key]
  const pages = useMemo(() => palettePages(model.nav).map((page) => ({ ...page, href: `${prefix}${page.href}` })), [model.nav, prefix])
  const frame = model.frame ?? 'office'
  // B-W2b-05 (PLT-162): the person's own phone tabs; a tab opens the area's page used last.
  const phone = useMemo(() => phoneNav(nav), [nav])
  const tabHref = (address: string) => toHref(areaTabHref(nav, model.lastPages ?? {}, address))
  const companyFree = (href: string) => (href.startsWith(`${prefix}/`) ? href.slice(prefix.length) : href === prefix ? '/' : href)
  // A window may close itself only when it is the tab's first page (opened from a row, or by ⌘-click).
  const [closable, setClosable] = useState(false)
  useEffect(() => setClosable(window.history.length <= 1 || window.opener !== null), [])

  useEffect(() => {
    setChrome({ header: topBar.current, primaryNavigation: body.current?.querySelector<HTMLElement>('.h10-rail') ?? null })
  }, [])
  // Opened after the first paint (design fixtures): the overlay is drawn into <body>, which a server render lacks.
  useEffect(() => setAreaNavOpen(model.areaNavOpen ?? false), [model.areaNavOpen])

  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent))
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const follow = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.defaultPrevented || !onNavigate || !isPlainClick(event)) return
    event.preventDefault()
    onNavigate(href)
  }
  // B-W2b-05 (nav row target): a window page's row opens it in a new tab on a plain click too (⌘-click does as always).
  const openRow = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!event.defaultPrevented && isPlainClick(event) && isWindowPage(companyFree(href))) {
      event.preventDefault()
      window.open(href, '_blank', 'noopener')
      return
    }
    follow(event, href)
  }

  const ThemeIcon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor
  const bell = model.bell ? bellWords(model.bell) : null
  const notificationsHref = toHref('/home/notifications')
  const searchLabel = t('topbar.searchLabel')
  // B-W2b-05 (COL-077): the tab's live connection in words (design shell.frame h.status).
  const liveStatus = model.live ? (
    <span className={`fw-live fw-live-${model.live}`} role="status" aria-label={t(`live.${model.live}`)} title={t(`live.${model.live}`)}>
      <span className="fw-live-dot" aria-hidden="true" />
      <span className="fw-live-word">{t(`live.${model.live}`)}</span>
    </span>
  ) : undefined
  // B-W2b-05 (PLT-171): the page's print view in a new tab (a real link: ⌘-click and middle-click work too).
  const query = model.query ?? ''
  const printAction = model.printKind ? (
    <Button asChild size="sm" variant="quiet">
      <a className="fw-band-print" href={toHref(printAddressOf(model.path, query, OFFICE_PAGES))} target="_blank" rel="noopener" aria-label={t(model.printKind === 'record' ? 'print.record' : 'print.view')}>
        <Printer size={14} aria-hidden /> {t('print.print')}
      </a>
    </Button>
  ) : undefined

  if (frame === 'print') {
    const company = model.switcher.companies.find((entry) => entry.code === model.switcher.company) ?? null
    const site = scopeChip(scopeOf({ company: null, sites: model.switcher.sites, everySite: !model.switcher.limited, chosen: model.switcher.site }))
    // A record without its own page yet (the panels route) is named by its label, as the panels name it.
    const label = model.path.startsWith('/records/') ? new URLSearchParams(query).get('label') : null
    const place = crumbs.length > 0 ? crumbs.map((crumb) => crumb.name).join(' › ') : (label ?? area?.label ?? t('print.page'))
    return (
      <PrintFrameView
        model={{
          kind: model.printKind ?? 'view',
          company: company ? { name: company.name, code: company.code } : null,
          site: site?.kind === 'site' ? { kind: 'site', name: site.name } : site ? { kind: 'all', limited: site.limited } : null,
          place,
          printedBy: model.user.displayName,
          printedAt: model.printedAt ?? new Date(0).toISOString(),
          backHref: viewHref(fullPath, query),
        }}
      >
        {children}
      </PrintFrameView>
    )
  }

  if (frame === 'window') {
    return (
      <div className="fw-office fw-window">
        <header ref={topBar} className="fw-topbar fw-window-bar" role="banner">
          <Link href={toHref(area?.href ?? '/home')} className="fw-window-back" aria-label={t('window.back')} onClick={(event) => follow(event, toHref(area?.href ?? '/home'))}>
            <ArrowLeft size={15} aria-hidden />
            <span className="fw-window-back-word">{t('window.back')}</span>
          </Link>
          <h1 className="fw-window-title">{here}</h1>
          <div className="fw-topbar-scope">
            <CompanySwitcherView model={model.switcher} onSiteChange={onSiteChange} onNavigate={follow} />
          </div>
          <div className="fw-topbar-utility">
            {liveStatus}
            <ToolbarButton icon={<ThemeIcon size={16} />} label={t(`topbar.theme.${mode}`)} onClick={cycleTheme} />
            {closable && <ToolbarButton icon={<X size={16} />} label={t('window.close')} onClick={() => window.close()} />}
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="fw-office-main fw-window-main">
          {children}
        </main>
      </div>
    )
  }

  return (
    <div className="fw-office">
      <header ref={topBar} className="fw-topbar" role="banner">
        <Link href={toHref('/home')} className="fw-topbar-brand" aria-label={t('topbar.home')}>
          <span className="logo" aria-hidden="true">
            F
          </span>
        </Link>
        <div className="fw-topbar-scope">
          <CompanySwitcherView model={model.switcher} onSiteChange={onSiteChange} onNavigate={follow} />
        </div>
        <div className="fw-topbar-search">
          <span className="fw-topbar-search-compact">
            <ToolbarButton icon={<Search size={16} />} label={searchLabel} onClick={() => setPaletteOpen(true)} />
          </span>
          <SearchTrigger
            className="fw-topbar-field"
            placeholder={t('topbar.searchPlaceholder')}
            ariaLabel={searchLabel}
            icon={<Search size={15} />}
            onOpen={() => setPaletteOpen(true)}
            adornment={
              <>
                <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
                <Kbd>K</Kbd>
              </>
            }
          />
        </div>
        <div className="fw-topbar-utility">
          {bell && (
            <ToolbarButton
              icon={<Bell size={16} />}
              label={t(bell.key, { count: bell.count })}
              description={t('topbar.bell.open')}
              badge={bell.badge ?? undefined}
              onClick={() => (onNavigate ? onNavigate(notificationsHref) : window.location.assign(notificationsHref))}
            />
          )}
          <ToolbarButton icon={<ThemeIcon size={16} />} label={t(`topbar.theme.${mode}`)} onClick={cycleTheme} />
          <Menu
            className="fw-usermenu"
            align="right"
            label={
              <>
                <UserRound size={15} aria-hidden />
                <span className="fw-usermenu-name">{model.user.displayName}</span>
              </>
            }
            triggerProps={{ 'aria-label': t('topbar.userMenu', { name: model.user.displayName }) }}
            onNavigate={(event, item) => item.href && follow(event, item.href)}
            items={[
              { id: 'profile', label: t('topbar.profile'), description: model.user.email, icon: <UserRound size={15} aria-hidden />, href: toHref('/me') },
              { id: 'sep', separator: true },
              { id: 'sign-out', label: t('topbar.signOut'), icon: <LogOut size={15} aria-hidden />, onSelect: onSignOut },
            ]}
          />
        </div>
      </header>

      {model.banners.map((banner) => (
        <Banner key={banner.id} tone="warning" className="fw-system-banner" title={t('banner.testMode.title')}>
          {t('banner.testMode.body', { connections: banner.connections.join(', ') })}
        </Banner>
      ))}

      <div ref={body} className="fw-office-body">
        <AppRail navItems={areaRailItems(nav, count).map((item) => ({ ...item, href: toHref(item.href) }))} pathname={fullPath} LinkComponent={ShellLink} />
        <div className="fw-office-page">
          {area?.sections?.length ? (
            <div className="fw-office-subheader">
              <WorkspaceSubheader
                chrome={chrome}
                navigationLabel={t('subnav.label', { area: area.label })}
                title={area.label}
                groups={areaSubNavGroups(area, { path: model.path, href: toHref, count })}
                onNavigate={(event, item) => openRow(event, item.href)}
                navigationOpen={areaNavOpen}
                onNavigationOpenChange={setAreaNavOpen}
                header={
                  <DetailHeader dense title={here} meta={above || undefined} status={liveStatus} actions={printAction} />
                }
              />
            </div>
          ) : null}
          <main id="main-content" tabIndex={-1} className="fw-office-main">
            {children}
          </main>
        </div>
      </div>

      <BottomBar
        nav={phone}
        pathname={model.path}
        LinkComponent={ShellLink}
        href={tabHref}
        count={count}
        labels={{ navigation: t('bottomBar.navigation'), more: t('bottomBar.more'), count: (n) => t('bottomBar.count', { count: n }), currentInside: t('bottomBar.currentInside') }}
      />

      <CommandPaletteView
        model={{ open: paletteOpen, query: model.paletteQuery ?? '', pages, tenantTag: model.tenantTag, records: model.paletteRecords ?? null }}
        onClose={() => setPaletteOpen(false)}
        onOpenHref={(href, options) => (options?.newTab || isWindowPage(companyFree(href)) ? window.open(href, '_blank', 'noopener') : onNavigate?.(href))}
        onQuery={onPaletteQuery}
      />
    </div>
  )
}
