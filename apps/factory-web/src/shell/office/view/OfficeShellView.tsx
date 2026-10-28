'use client'

import { forwardRef, useEffect, useId, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { LogOut, Monitor, Moon, PanelLeftOpen, Search, Sun, UserRound } from 'lucide-react'
import { Banner, EntityPath, Menu, SearchTrigger } from '@nexus/ui/components'
import { BottomBar } from '@nexus/ui/components/BottomBar/index'
import { WorkspaceSubheader } from '@nexus/ui/patterns'
import { AppRail, areaRailItems, areaSubNavGroups, findAreaNavPlace, type AreaNav, type RailLinkProps } from '@nexus/ui/patterns/shell/index'
import '@nexus/ui/patterns/shell/app-rail.css'
import { Button, Kbd, ToolbarButton } from '@nexus/ui/primitives'
import { useScopedT, useT } from '../../../lib/i18n/provider'
import { companyPrefix } from '../../../lib/session/session'
import { useTheme } from '../../../lib/theme/use-theme'
import { navPages, officeCrumbs, translateNav } from '../../nav/office-nav'
import { CommandPaletteView } from '../../palette/view/CommandPaletteView'
import { CompanySwitcherView, type CompanySwitcherViewModel } from '../../switcher/view/CompanySwitcherView'
import '../office-shell.css'

/**
 * SCR-003 — the Office shell (PLT-160, PLT-173; A2 §1, §2.1). Composed from design-system parts only:
 *  - top bar: the brand, the company and site switcher (SCR-002), the search field that opens the palette (SCR-004,
 *    also ⌘K / Ctrl K), the theme button and the person's menu (profile, sign out);
 *  - system banners under it: TEST MODE while a fake or sandbox connection is active;
 *  - the main sidebar: the DS `AppRail`, one row per area the person may open (areas/<area>/nav.ts);
 *  - the area's pinned sub-sidebar: DS `WorkspaceSubheader pinned` (a column from 1024 px, a drawer below, opened by the
 *    area button in the crumbs row);
 *  - crumbs: area › page (DS `EntityPath`), from the same manifest;
 *  - on a phone (under 720 px) no rail: the DS `BottomBar` with the areas, More for the rest.
 * Standard (office) density. The page itself is `children`, inside `<main id="main-content">`.
 */

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
  switcher: CompanySwitcherViewModel
  user: { displayName: string; email: string }
  /** The signed-in tenant's label tag (the palette refuses another factory's labels). */
  tenantTag: string | null
  banners: readonly SystemBanner[]
  /** Badge counts by key (`approvals.waiting`); W0 has none. */
  counts?: Readonly<Record<string, number>>
  /** Open the palette at once (design fixtures). */
  paletteOpen?: boolean
  paletteQuery?: string
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

export function OfficeShellView({ model, children, onNavigate, onSiteChange, onSignOut }: OfficeShellViewProps) {
  const t = useT('shell')
  const named = useScopedT('shell')
  const { mode, cycleTheme } = useTheme()
  const [paletteOpen, setPaletteOpen] = useState(model.paletteOpen ?? false)
  const [areaMenuOpen, setAreaMenuOpen] = useState(false)
  const areaMenuId = `fw-area-nav-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [isMac, setIsMac] = useState(true)

  const prefix = companyPrefix(model.switcher.company)
  const toHref = (address: string) => `${prefix}${address}`
  const fullPath = toHref(model.path === '/' ? '' : model.path)
  const nav = useMemo(() => translateNav(model.nav, named), [model.nav, named])
  const place = findAreaNavPlace(nav, model.path)
  const area = place?.area
  const crumbs = officeCrumbs(nav, model.path).map((crumb) => ({ id: crumb.id, name: crumb.name, href: crumb.href ? toHref(crumb.href) : null }))
  const count = (key: string) => model.counts?.[key]
  const pages = useMemo(() => navPages(model.nav).map((page) => ({ ...page, href: `${prefix}${page.href}` })), [model.nav, prefix])

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

  const ThemeIcon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor
  const searchLabel = t('topbar.searchLabel')

  return (
    <div className="fw-office">
      <header className="fw-topbar" role="banner">
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

      <div className="fw-office-body">
        <AppRail navItems={areaRailItems(nav, count).map((item) => ({ ...item, href: toHref(item.href) }))} pathname={fullPath} LinkComponent={ShellLink} />
        <div className="fw-office-area">
          {area?.sections?.length ? (
            <WorkspaceSubheader
              pinned
              navigationLabel={t('subnav.label', { area: area.label })}
              title={area.label}
              groups={areaSubNavGroups(area, { path: model.path, href: toHref, count })}
              onNavigate={(event, item) => follow(event, item.href)}
              navigationOpen={areaMenuOpen}
              onNavigationOpenChange={setAreaMenuOpen}
              navigationId={areaMenuId}
            />
          ) : null}
          <div className="fw-office-page">
            <div className="fw-office-crumbs">
              {area?.sections?.length ? (
                <span className="fw-area-button">
                  <Button size="sm" aria-haspopup="dialog" aria-expanded={areaMenuOpen} aria-controls={areaMenuId} onClick={() => setAreaMenuOpen(!areaMenuOpen)}>
                    <PanelLeftOpen size={13} aria-hidden /> {area.label}
                  </Button>
                </span>
              ) : null}
              {crumbs.length > 0 && <EntityPath items={crumbs} label={t('crumbs.label')} linkAs={Link} />}
            </div>
            <main id="main-content" tabIndex={-1} className="fw-office-main">
              {children}
            </main>
          </div>
        </div>
      </div>

      <BottomBar
        nav={nav}
        pathname={model.path}
        LinkComponent={ShellLink}
        href={toHref}
        count={count}
        labels={{ navigation: t('bottomBar.navigation'), more: t('bottomBar.more'), count: (n) => t('bottomBar.count', { count: n }), currentInside: t('bottomBar.currentInside') }}
      />

      <CommandPaletteView
        model={{ open: paletteOpen, query: model.paletteQuery ?? '', pages, tenantTag: model.tenantTag }}
        onClose={() => setPaletteOpen(false)}
        onOpenHref={(href) => onNavigate?.(href)}
      />
    </div>
  )
}
