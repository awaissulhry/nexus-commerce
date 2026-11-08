'use client'

import { forwardRef, useMemo, useState, type MouseEvent, type ReactNode, type Ref, type UIEvent } from 'react'
import Link from 'next/link'
import { Bell, Keyboard, LogOut, MessageCircleQuestion, MoreHorizontal, Palette, Search, ShieldCheck, UserRound, Mail, ChevronDown } from 'lucide-react'
import { Banner, Menu, SearchTrigger, Tabs, type MenuItemDef } from '@nexus/ui/components'
import { BottomBar, type BottomBarLinkProps } from '@nexus/ui/components/BottomBar/index'
import { RefPair } from '@nexus/ui/components/RefPair/index'
import { DetailHeader, DETAIL_HEADER_FOLD } from '@nexus/ui/patterns'
import { PortalActionBar } from '@nexus/ui/patterns/PortalActionBar/index'
import type { AreaNav } from '@nexus/ui/patterns/shell/index'
import { Button, Kbd, Pill, ToolbarButton } from '@nexus/ui/primitives'
import { brandingAttrs, checkBranding, type BrandingTokens } from '@nexus/ui/tokens/branding'
import { densityAttrs } from '@nexus/ui/tokens/density'
import '@nexus/ui/styles/branding.css'
import { useDsWords } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import type { LiveState } from '../../../shell/live/bus'
import type { PortalBand } from '../frame'
import type { BadgeWords, PortalNotice } from '../model'
import { portalPlace, translatePortalNav } from '../nav/portal-nav'
import { PortalRail } from './PortalRail'
import '../portal-shell.css'

/**
 * SCR-027 — the portal frame (B-W2b-173; design portal.frame, archetype §2.8; SCM-101): every portal page sits in it, at
 * comfortable density, branded with the company's logo and colour (the colour only where the DS's checkBranding passes).
 *  - top bar: the company's logo or name (→ Home), the partner organisation, search ("your PO number works": / focuses it),
 *    the bell (what is new for this person, in words) and the person's menu (My access, E-mail settings, Language and theme,
 *    Keyboard shortcuts, Sign out);
 *  - ONE notice under it, the most serious first (an office preview, the connection, the end of access, a read-only record);
 *  - the rail: the partner's areas, always labelled, with the badges of the one task list (PortalRail);
 *  - the band: [Pages] where an area has two or more, ‹ back, the title, their reference first and ours second (RefPair), the
 *    lifecycle pill, at most two buttons (primary last) and ⋯ ending with "Ask a question"; record pages: link tabs below;
 *  - the page (`children`, `<main id="main-content">`), and the foot: the company's legal block (c.c. art. 2250), the privacy
 *    notice and the portal terms (new tabs), and for a supplier "Free for suppliers — no fees, no document limits";
 *  - on a phone (< 720 px): the DS BottomBar (its More sheet) and the band's primary action in the PortalActionBar above it.
 * Fails closed: `nav` holds only what this person may open.
 */

export interface PortalShellViewModel {
  /** The company's portal branding: its portal name, logos and colour (null: the company's name in text, DS colours). */
  brand: (BrandingTokens & { name: string }) | null
  /** Whose portal: the company (when the branding is missing). */
  companyName: string
  /** The partner organisation ("Brand Alpha S.r.l."). */
  partyName: string
  person: { displayName: string; email: string }
  /** The person's areas (labels are `portal` keys). */
  nav: AreaNav
  /** The portal address without `/p/<party>` (`/` for Home). */
  path: string
  /** `/p/<party code>`. */
  prefix: string
  /** The badges by the task list's area; null: unknown (no badge, never 0). */
  badges: Readonly<Record<string, BadgeWords>> | null
  /** The bell: unread notifications; null: not known (no badge). */
  bell: { unread: number; complete: boolean } | null
  /** The one notice shown. */
  notice: PortalNotice | null
  /** What the page put in its band (null: the navigation place). */
  band: PortalBand | null
  live?: LiveState
  /** The company's legal block (c.c. art. 2250) in the page's language. */
  legal: { name: string; lines: readonly string[] }
  privacyHref: string
  termsHref: string
  /** A supplier or workshop portal: the foot says it is free (SCM-102). */
  freeForSuppliers: boolean
  /** An office preview: the menu has no E-mail settings (they are the person's own). */
  preview: boolean
  /** The person may search (portal.search). */
  canSearch: boolean
}

export type PortalDialog = 'search' | 'notifications' | 'email' | 'shortcuts' | 'access' | 'display'

export interface PortalShellViewProps {
  model: PortalShellViewModel
  children?: ReactNode
  /** Client-side navigation for a plain click (the live frame's router); absent: links load the page. */
  onNavigate?: (href: string) => void
  onOpen?: (dialog: PortalDialog) => void
  onAsk?: () => void
  onSignOut?: () => void
  onDismissNotice?: (notice: PortalNotice) => void
  /** The bell, for the notifications pop-up to sit under it on a desktop. */
  bellRef?: Ref<HTMLSpanElement>
}

const isPlainClick = (event: MouseEvent<HTMLAnchorElement>) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

/** Next's Link for the DS bottom bar. */
const BarLink = forwardRef<HTMLAnchorElement, BottomBarLinkProps>(function BarLink({ href, children, ...rest }, ref) {
  return (
    <Link ref={ref} href={href} {...rest}>
      {children}
    </Link>
  )
})

export function PortalShellView({ model, children, onNavigate, onOpen, onAsk, onSignOut, onDismissNotice, bellRef }: PortalShellViewProps) {
  const t = useT('portal')
  const ds = useDsWords()
  // The band folds 48 → 32 px while the page scrolls (anatomy §1.4: the DS's fold).
  const [folded, setFolded] = useState(false)
  const onScroll = (event: UIEvent<HTMLDivElement>) => setFolded(event.currentTarget.scrollTop > 8)
  const brand = model.brand ? checkBranding(model.brand) : null
  const nav = useMemo(() => translatePortalNav(model.nav, t), [model.nav, t])
  const place = portalPlace(nav, model.path)
  const area = place?.area ?? null
  const pages = area?.sections?.flatMap((section) => section.items) ?? []
  const toHref = (address: string) => (address === '/' ? model.prefix : `${model.prefix}${address}`)
  const follow = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.defaultPrevented || !onNavigate || !isPlainClick(event)) return
    event.preventDefault()
    onNavigate(href)
  }
  const band = model.band ?? {}
  const title = band.title ?? place?.item?.label ?? area?.label ?? t('band.portal')
  const actions = (band.actions ?? []).slice(0, 2)
  const primary = actions.find((action) => action.variant === 'primary') ?? null
  const homeName = brand?.name || model.companyName
  const bell = model.bell
  const bellLabel = bell ? (bell.unread > 0 ? t(bell.complete ? 'bell.unread' : 'bell.unreadMore', { count: bell.unread }) : t('bell.none')) : t('bell.label')

  const personItems: MenuItemDef[] = [
    { id: 'who', label: model.person.displayName, description: model.person.email, icon: <UserRound size={15} aria-hidden />, disabled: true },
    { id: 'sep-1', separator: true },
    { id: 'access', label: t('menu.access'), icon: <ShieldCheck size={15} aria-hidden />, onSelect: () => onOpen?.('access') },
    ...(model.preview ? [] : [{ id: 'email', label: t('menu.email'), icon: <Mail size={15} aria-hidden />, onSelect: () => onOpen?.('email') }]),
    { id: 'display', label: t('menu.display'), icon: <Palette size={15} aria-hidden />, onSelect: () => onOpen?.('display') },
    { id: 'shortcuts', label: t('menu.shortcuts'), icon: <Keyboard size={15} aria-hidden />, onSelect: () => onOpen?.('shortcuts') },
    { id: 'sep-2', separator: true },
    { id: 'sign-out', label: t('menu.signOut'), icon: <LogOut size={15} aria-hidden />, onSelect: onSignOut },
  ]
  const moreItems: MenuItemDef[] = [...(band.more ?? []), ...(band.more?.length ? [{ id: 'sep-ask', separator: true } as MenuItemDef] : []), { id: 'ask', label: t('band.ask'), icon: <MessageCircleQuestion size={15} aria-hidden />, onSelect: onAsk }]

  const liveStatus =
    model.live === 'offline' ? (
      <span className="fw-plive" role="status">
        {t('live.offline')}
      </span>
    ) : undefined

  return (
    <div className="fw-portal" {...densityAttrs('comfortable')} {...(brand ? brandingAttrs(brand) : {})}>
      <header className="fw-ptop" role="banner">
        <Link href={model.prefix} className="fw-ptop-brand" aria-label={t('top.home', { name: homeName })} onClick={(event) => follow(event, model.prefix)}>
          {brand?.logoUrl ? (
            <>
              <img className={`fw-ptop-logo${brand.logoDarkUrl && brand.logoDarkUrl !== brand.logoUrl ? ' for-light' : ''}`} src={brand.logoUrl} alt="" />
              {brand.logoDarkUrl && brand.logoDarkUrl !== brand.logoUrl ? <img className="fw-ptop-logo for-dark" src={brand.logoDarkUrl} alt="" /> : null}
            </>
          ) : (
            <span className="fw-ptop-name">{homeName}</span>
          )}
        </Link>
        <span className="fw-ptop-party" title={model.partyName}>
          {model.partyName}
        </span>
        {model.canSearch ? (
          <div className="fw-ptop-search">
            <span className="fw-ptop-search-compact">
              <ToolbarButton icon={<Search size={18} />} label={t('search.label')} onClick={() => onOpen?.('search')} />
            </span>
            <SearchTrigger
              className="fw-ptop-field"
              placeholder={t('search.placeholder')}
              ariaLabel={t('search.label')}
              icon={<Search size={16} />}
              onOpen={() => onOpen?.('search')}
              adornment={<Kbd>/</Kbd>}
            />
          </div>
        ) : null}
        <div className="fw-ptop-utility">
          <span ref={bellRef} className="fw-ptop-bell">
            <ToolbarButton icon={<Bell size={18} />} label={bellLabel} description={t('bell.open')} badge={bell && bell.unread > 0 ? bell.unread : undefined} onClick={() => onOpen?.('notifications')} />
          </span>
          <Menu
            className="fw-pmenu"
            align="right"
            label={
              <>
                <UserRound size={16} aria-hidden />
                <span className="fw-pmenu-name">{model.person.displayName}</span>
                <ChevronDown size={14} aria-hidden />
              </>
            }
            triggerProps={{ 'aria-label': t('menu.label', { name: model.person.displayName }) }}
            items={personItems}
          />
        </div>
      </header>

      {model.notice ? (
        <Banner
          tone={model.notice.tone}
          className="fw-pnotice"
          title={t(`${model.notice.key}.title`, model.notice.params)}
          action={
            model.notice.value !== undefined && onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={() => onDismissNotice(model.notice!)}>
                {t('notice.dismiss')}
              </Button>
            ) : undefined
          }
        >
          {t(`${model.notice.key}.body`, model.notice.params)}
        </Banner>
      ) : null}

      <div className="fw-pbody">
        <PortalRail nav={nav} current={area?.id ?? null} badges={model.badges} toHref={toHref} onNavigate={follow} />
        <div className="fw-ppage" onScroll={onScroll}>
          <div className={['fw-pband', DETAIL_HEADER_FOLD.host, folded ? DETAIL_HEADER_FOLD.folded : ''].filter(Boolean).join(' ')}>
            <DetailHeader
              dense
              backAsChild={Boolean(band.back)}
              backLabel={
                band.back ? (
                  <Link href={band.back.href} onClick={(event) => follow(event, band.back!.href)}>
                    {band.back.label}
                  </Link>
                ) : undefined
              }
              badge={
                pages.length >= 2 ? (
                  <Menu
                    className="fw-ppages"
                    label={
                      <>
                        {t('band.pages')}
                        <ChevronDown size={14} aria-hidden />
                      </>
                    }
                    triggerProps={{ 'aria-label': t('band.pagesOf', { area: area?.label ?? '' }) }}
                    selectedId={place?.item?.id}
                    onNavigate={(event, item) => item.href && follow(event, item.href)}
                    items={pages.map((page) => ({ id: page.id, label: page.label, href: toHref(page.href) }))}
                  />
                ) : undefined
              }
              title={title}
              meta={
                band.refs || band.status ? (
                  <span className="fw-pband-meta">
                    {band.refs ? <RefPair theirs={band.refs.theirs ?? null} ours={band.refs.ours ?? null} size="sm" labels={ds.refPair} /> : null}
                    {band.status ? <Pill tone={band.status.tone}>{band.status.label}</Pill> : null}
                  </span>
                ) : undefined
              }
              status={liveStatus}
              actions={
                <span className="fw-pband-actions">
                  <span className="fw-pband-buttons">
                    {actions.map((action) =>
                      action.href ? (
                        <Button key={action.id} asChild size="sm" variant={action.variant ?? 'secondary'} heldReason={action.heldReason ?? null}>
                          <Link href={action.href} onClick={(event) => follow(event, action.href!)}>
                            {action.label}
                          </Link>
                        </Button>
                      ) : (
                        <Button key={action.id} size="sm" variant={action.variant ?? 'secondary'} onClick={action.onClick} heldReason={action.heldReason ?? null}>
                          {action.label}
                        </Button>
                      ),
                    )}
                  </span>
                  <Menu className="fw-pmore" align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('band.more') }} items={moreItems} />
                </span>
              }
            />
            {band.tabs ? <Tabs className="fw-ptabs" ariaLabel={band.tabs.label} tabs={band.tabs.items} active={band.tabs.active} /> : null}
          </div>
          <main id="main-content" tabIndex={-1} className="fw-pmain">
            {children}
          </main>
          <footer className="fw-pfoot">
            <div className="fw-pfoot-legal">
              <span className="fw-pfoot-name">{model.legal.name}</span>
              {model.legal.lines.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </div>
            <nav className="fw-pfoot-links" aria-label={t('foot.label')}>
              <a href={model.privacyHref} target="_blank" rel="noopener">
                {t('foot.privacy')}
              </a>
              <a href={model.termsHref} target="_blank" rel="noopener">
                {t('foot.terms')}
              </a>
            </nav>
            {model.freeForSuppliers ? <p className="fw-pfoot-free">{t('foot.free')}</p> : null}
          </footer>
        </div>
      </div>

      {primary ? (
        <PortalActionBar
          action={{ label: primary.label, ...(primary.href ? { href: primary.href } : {}), ...(primary.onClick ? { onClick: primary.onClick } : {}), heldReason: primary.heldReason ?? null }}
          labels={ds.portalActionBar}
        />
      ) : null}
      <BottomBar
        nav={nav}
        pathname={model.path}
        LinkComponent={BarLink}
        href={toHref}
        count={(badge) => model.badges?.[badge]?.count}
        labels={{ navigation: t('bottomBar.navigation'), more: t('bottomBar.more'), count: (n) => t('bottomBar.count', { count: n }), currentInside: t('bottomBar.currentInside') }}
      />
    </div>
  )
}
