'use client'

import { forwardRef, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type Ref, type UIEvent } from 'react'
import Link from 'next/link'
import { Bell, Camera, Keyboard, LogOut, MessageCircleQuestion, MessageSquare, MoreHorizontal, Palette, Search, ShieldCheck, UserRound, Users, Mail, ChevronDown, ChevronRight } from 'lucide-react'
import { Banner, Menu, SearchTrigger, Tabs, type MenuItemDef } from '@nexus/ui/components'
import { BottomBar, type BottomBarLinkProps } from '@nexus/ui/components/BottomBar/index'
import { RefPair } from '@nexus/ui/components/RefPair/index'
import { DetailHeader, DETAIL_HEADER_FOLD, WorkspaceSubheader, type WorkspaceSubheaderProps } from '@nexus/ui/patterns'
import { PortalActionBar } from '@nexus/ui/patterns/PortalActionBar/index'
// owb-po4.2: the office's rail and sub-sidebar (the DS shell parts, used as they are).
import { AppRail, areaSubNavGroups, type AreaNav, type RailLinkProps } from '@nexus/ui/patterns/shell/index'
import '@nexus/ui/patterns/shell/app-rail.css'
import { Button, Kbd, Pill, Tag, ToolbarButton } from '@nexus/ui/primitives'
import { brandingAttrs, checkBranding, type BrandingTokens } from '@nexus/ui/tokens/branding'
import { densityAttrs } from '@nexus/ui/tokens/density'
import '@nexus/ui/styles/branding.css'
import { useDsWords } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import { HealthPill } from '../../../lib/production/view/HealthPill'
import { StateChip } from '../../../lib/order-cells/view/StateChip' // owb-po5.1: `{ life, note }`, the nine words
// owb-po5.1: the order's picture in the band (the shared part, read by the frame's batch reader).
import type { ReadPictures } from '../../../lib/record-picture/cache'
import { RecordPicture } from '../../../lib/record-picture/view/RecordPicture'
import type { LiveState } from '../../../shell/live/bus'
import type { PortalBand } from '../frame'
import { badgeOf, type BadgeWords, type PortalNotice } from '../model'
import { portalPlace, translatePortalNav } from '../nav/portal-nav'
import { messagesButtonWords } from '../record/model' // pp-w1 (w1.1): the band's thread button words
import { useActiveTabInView } from './active-tab' // pp-fx7 (re-walk R2-01)
import '../portal-shell.css'

/**
 * SCR-027 — the portal frame (B-W2b-173; design portal.frame, archetype §2.8; SCM-101): every portal page sits in it, at
 * comfortable density, branded with the company's logo and colour (the colour only where the DS's checkBranding passes).
 *  - top bar: the company's logo or name (→ Home), the partner organisation, search ("your PO number works": / focuses it),
 *    the bell (what is new for this person, in words) and the person's menu (My access, E-mail settings, Language and theme,
 *    Keyboard shortcuts, Sign out);
 *  - ONE notice under it, the most serious first (an office preview, the connection, the end of access, a read-only record);
 *  - owb-po4.2 (order workflow plan § 5 "the office's sidebar + sub-sidebar"): the rail is the office's DS `AppRail` (66 px,
 *    labels on hover or focus) with the badges of the one task list (a row's count adds up its moved pages', `badgeOf`); an area
 *    with two or more pages draws the office's sub-sidebar — the DS `WorkspaceSubheader` with `areaSubNavGroups` (its toggle
 *    beside the band; its pages open from the left, under the top bar and beside the rail);
 *  - the band: ‹ back, the title, their reference first and ours second (RefPair), the lifecycle pill, at most two buttons
 *    (primary last) and ⋯ ending with "Ask a question"; record pages: link tabs below;
 *  - the page (`children`, `<main id="main-content">`), and the foot: the company's legal block (c.c. art. 2250), the privacy
 *    notice and the portal terms (new tabs), and for a supplier "Free for suppliers — no fees, no document limits";
 *  - on a phone (< 720 px): no rail; the DS BottomBar (Home · Orders · New order · Account, its More sheet) and the band's
 *    primary action in the PortalActionBar above it.
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
  /** owb-po5.1: the frame's batch picture reader (the band's order picture); absent: no picture read (a placeholder). */
  pictures?: ReadPictures | null
  /** owb-po5.4: the top bar's Chat — the new messages of every chat (null: not read: no number); absent: no Chat button. */
  chat?: { readonly count: number | null; readonly open: boolean; /** owb-po6.4: the band's record's new messages (null: no band chat). */ readonly here?: number | null } | null
}

export type PortalDialog = 'search' | 'notifications' | 'email' | 'shortcuts' | 'access' | 'display' | 'chat' /* owb-po5.4 */

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
  // ── owb-po4.2: the rail and the sub-sidebar ──
  // The badge of a row, a slot or a sub-sidebar row: one task-list area or several joined (owb-po4.4).
  const countOf = (key: string): number | undefined => badgeOf(model.badges, key)?.count
  // The rail lights the area the frame places the page in (the band and the bottom bar read the same place): a moved page lights its
  // new area (My production → Orders), a card's page its own (Waiting for you → Home), a page of no area nothing.
  const railPath = place ? toHref(place.area.href) : ''
  // A row says its count with its noun, as the one task list words it ("Orders, 2 to confirm"); the DS's words otherwise.
  const railWords = useMemo(() => {
    const said = new Map(nav.areas.flatMap((entry) => {
      const badge = badgeOf(model.badges, entry.badge)
      return badge ? [[entry.label, badge.words] as const] : []
    }))
    return { ...ds.appRail, withCount: (label: string, count: number) => (said.has(label) ? t('rail.withBadge', { area: label, badge: said.get(label)! }) : ds.appRail.withCount(label, count)) }
  }, [nav, model.badges, ds.appRail, t])
  // The rail's links: the frame's client navigation (a plain click asks the unsaved guard first); one component for every render.
  const followRef = useRef(follow)
  followRef.current = follow
  const RailLink = useMemo(
    () =>
      forwardRef<HTMLAnchorElement, RailLinkProps>(function RailLink({ href, children, ...rest }, ref) {
        return (
          <Link ref={ref} href={href} {...rest} onClick={(event) => followRef.current(event, href)}>
            {children}
          </Link>
        )
      }),
    [],
  )
  // The sub-sidebar opens under the top bar and beside the rail (the subheader measures them, as the office's does).
  const topBar = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [chrome, setChrome] = useState<WorkspaceSubheaderProps['chrome']>()
  useEffect(() => {
    setChrome({ header: topBar.current, primaryNavigation: body.current?.querySelector<HTMLElement>('.h10-rail') ?? null })
  }, [])
  const band = model.band ?? {}
  // pp-fx7 (re-walk R2-01): a band's tab row keeps the tab you are on whole in view, as the order's body tabs (the one shared part).
  const bandRef = useRef<HTMLDivElement>(null)
  useActiveTabInView(bandRef, band.tabs ? `${band.tabs.active}:${band.tabs.items.length}` : null)
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
  // pp-w1 (w1.1): the record frame's "Messages (2 new)" (the conversation not on screen); on a phone its icon alone, named.
  const threadWords = band.thread ? messagesButtonWords(band.thread.count) : null
  // owb-po6.4: a page without a dock (the order page): the band's Chat opens the panel at its record, with that chat's new messages.
  const bandChatWords = !band.thread && band.chat && model.chat ? messagesButtonWords(model.chat.here ?? 0) : null
  const moreItems: MenuItemDef[] = [...(band.more ?? []), ...(band.more?.length ? [{ id: 'sep-ask', separator: true } as MenuItemDef] : []), { id: 'ask', label: t('band.ask'), icon: <MessageCircleQuestion size={15} aria-hidden />, onSelect: onAsk }]

  const liveStatus =
    model.live === 'offline' ? (
      <span className="fw-plive" role="status">
        {t('live.offline')}
      </span>
    ) : undefined

  // owb-po5.1: the order's picture before the title — a button with the camera when the person may change it, else the picture.
  const picture = band.picture ?? null
  const pictureFace = picture ? <RecordPicture source={picture.source ?? 'customerOrder'} recordId={picture.recordId} number={picture.number} size="cell" read={model.pictures ?? null} /> : null
  const bandPicture = picture ? (
    picture.onOpen ? (
      <button type="button" className="fw-pband-pic" aria-label={t('band.pictureChange')} onClick={picture.onOpen}>
        {pictureFace}
        <span className="fw-pband-pic-cam" aria-hidden="true">
          <Camera size={12} />
        </span>
      </button>
    ) : (
      <span className="fw-pband-pic">{pictureFace}</span>
    )
  ) : undefined
  const bandHeader = (
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
      badge={bandPicture}
      title={title}
      meta={
        band.refs || band.status || band.chips ? (
          <span className="fw-pband-meta">
            {band.refs ? <RefPair theirs={band.refs.theirs ?? null} ours={band.refs.ours ?? null} size="sm" labels={ds.refPair} /> : null}
            {band.status ? band.status.life ? <StateChip life={band.status.life} note={band.status.note ?? null} /> : <Pill tone={band.status.tone}>{band.status.label}</Pill> : null}
            {/* pp-w1 (w1.2): the office band's twins after the status — health (Late / At risk), urgency, made from. */}
            {band.chips?.health ? <HealthPill face="customer" computed={band.chips.health.computed} raised={band.chips.health.raised ?? null} /> : null}
            {band.chips?.urgent ? <Tag tone="warning">{band.chips.urgent}</Tag> : null}
            {band.chips?.madeFrom ? (
              <Button asChild size="sm" variant="link" inline>
                <Link href={band.chips.madeFrom.href} onClick={(event) => follow(event, band.chips!.madeFrom!.href)}>
                  {band.chips.madeFrom.label}
                  <ChevronRight size={14} aria-hidden />
                </Link>
              </Button>
            ) : null}
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
          {band.people ? (
            <Button size="sm" variant="tonal" className="fw-pband-people" aria-label={`${t('band.peopleLabel')}: ${t('band.people', { count: band.people.count })}`} onClick={band.people.onOpen}>
              <Users size={14} aria-hidden /> <span className="fw-pband-thread-words">{t('band.people', { count: band.people.count })}</span>
            </Button>
          ) : null}
          {bandChatWords ? (
            <Button size="sm" variant="tonal" className="fw-pband-thread" aria-label={bandChatWords.label ? t(bandChatWords.label.key, { count: bandChatWords.label.count }) : t(bandChatWords.key)} aria-pressed={model.chat?.open ?? false} onClick={() => onOpen?.('chat')}>
              <MessageSquare size={14} aria-hidden /> <span className="fw-pband-thread-words">{t(bandChatWords.key, bandChatWords.count === undefined ? undefined : { count: bandChatWords.count })}</span>
            </Button>
          ) : null}
          {band.thread && threadWords ? (
            <Button size="sm" variant="tonal" className="fw-pband-thread" aria-controls="messages" aria-keyshortcuts="Meta+J Control+J" aria-label={threadWords.label ? t(threadWords.label.key, { count: threadWords.label.count }) : t(threadWords.key)} onClick={band.thread.onClick}>
              <MessageSquare size={14} aria-hidden /> <span className="fw-pband-thread-words">{t(threadWords.key, threadWords.count === undefined ? undefined : { count: threadWords.count })}</span>
            </Button>
          ) : null}
          <Menu className="fw-pmore" align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('band.more') }} items={moreItems} />
        </span>
      }
    />
  )
  // pp-fx6 (re-walk W-15): a tab row longer than its room scrolls with the DS arrows, as the order's body tabs (no tab left at the edge).
  const bandTabs = band.tabs ? <Tabs className="fw-ptabs" ariaLabel={band.tabs.label} tabs={band.tabs.items} active={band.tabs.active} overflow="scroll" /> : null

  return (
    <div className="fw-portal" {...densityAttrs('comfortable')} {...(brand ? brandingAttrs(brand) : {})}>
      <header ref={topBar} className="fw-ptop" role="banner">
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
          {model.chat ? (
            <ToolbarButton
              icon={<MessageSquare size={18} />}
              label={model.chat.count ? t('chat.labelNew', { count: model.chat.count }) : t('chat.title')}
              description={t('chat.open')}
              badge={model.chat.count ? model.chat.count : undefined}
              active={model.chat.open}
              onClick={() => onOpen?.('chat')}
            />
          ) : null}
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

      <div ref={body} className="fw-pbody">
        <AppRail
          navItems={nav.areas.map((entry) => {
            const count = entry.badge ? countOf(entry.badge) : undefined
            return { label: entry.label, href: toHref(entry.href), Icon: entry.icon, ...(count !== undefined ? { badge: count } : {}) }
          })}
          pathname={railPath}
          LinkComponent={RailLink}
          labels={railWords}
        />
        <div className="fw-ppage" onScroll={onScroll}>
          <div ref={bandRef} className={['fw-pband', DETAIL_HEADER_FOLD.host, folded ? DETAIL_HEADER_FOLD.folded : ''].filter(Boolean).join(' ')}>
            {area && pages.length >= 2 ? (
              <WorkspaceSubheader
                chrome={chrome}
                navigationLabel={t('band.pagesOf', { area: area.label })}
                title={area.label}
                groups={areaSubNavGroups(area, { path: model.path, href: toHref, count: countOf })}
                onNavigate={(event, item) => follow(event, item.href)}
                labels={ds.workspaceSubheader}
                header={bandHeader}
                tabs={bandTabs}
              />
            ) : (
              <>
                {bandHeader}
                {bandTabs}
              </>
            )}
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
        /* owb-po4.1: a card's page (Waiting for you) lights its area's slot; owb-po4.4: a slot's count adds up its moved pages'. */
        pathname={place?.card ? place.area.href : model.path}
        LinkComponent={BarLink}
        href={toHref}
        count={countOf}
        labels={{ navigation: t('bottomBar.navigation'), more: t('bottomBar.more'), count: (n) => t('bottomBar.count', { count: n }), currentInside: t('bottomBar.currentInside') }}
      />
    </div>
  )
}
