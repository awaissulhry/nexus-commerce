'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { ChevronDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Drawer } from '../components/Drawer'
import { Menu, type MenuItemDef } from '../components/Menu'
import { ToolbarButton } from '../primitives/ToolbarButton'
import { Tag } from '../primitives/Tag'
import { TooltipPortalProvider } from '../primitives/Tooltip'

export interface WorkspaceNavItem {
  id: string
  label: string
  href: string
  icon?: ReactNode
  active?: boolean
  badge?: string | number
}

export interface WorkspaceNavGroup {
  id: string
  /** Always required: it names the group to a screen reader, even when `hideLabel` hides it on screen. */
  label: string
  items: readonly WorkspaceNavItem[]
  collapsible?: boolean
  /** No label on screen (the label stays the group's accessible name); such a group is never collapsible. */
  hideLabel?: boolean
}

export interface WorkspaceSubheaderProps {
  /**
   * The existing page header. A render function places the optional view menu beside its title.
   * Optional: without a header (and without tabs) there is no header band. Not drawn when `pinned`.
   */
  header?: ReactNode | ((titleMenu: ReactNode) => ReactNode)
  tabs?: ReactNode
  navigationLabel: string
  groups: readonly WorkspaceNavGroup[]
  views?: { label: string; selectedId: string; items: readonly WorkspaceNavItem[] }
  /** Browser-native links by default; adapters may preserve their router's navigation semantics. */
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>, item: WorkspaceNavItem) => void
  /** Actual shell elements, observed for resizing, pinning and hover expansion. */
  chrome?: { header: HTMLElement | null; primaryNavigation: HTMLElement | null }
  /**
   * Pinned (Reviews, 2026-10-26): from 1024 px the navigation is a column beside the primary navigation
   * (`--nds-secondary-nav-w`, sticky, scrolls inside) with a Collapse button that folds it to the 48 px
   * toggle strip. Below 1024 px there is no column: the drawer opens from a button the page renders
   * (`navigationOpen` / `onNavigationOpenChange`, `navigationId` for its `aria-controls`). The subheader
   * is then the navigation only — `header` and `tabs` are not drawn; render it as the FIRST child of a
   * row whose next child is the page, and let each page render its own header.
   */
  pinned?: boolean
  /** The navigation panel's heading. Default: `navigationLabel`. */
  title?: ReactNode
  /** A smaller line under the heading ("All channels"). */
  subtitle?: ReactNode
  /** Controlled drawer state, for a page button that opens the navigation (pinned mode below 1024 px). */
  navigationOpen?: boolean
  onNavigationOpenChange?: (open: boolean) => void
  /** The drawer's id, so an outside opener can name it in `aria-controls`. */
  navigationId?: string
}

/** Where a pinned subheader becomes a column (the drawer below). Matches `.nds-workspace-subheader.pinned` in patterns.css. */
const PINNED_QUERY = '(min-width: 1024px)'
function subscribeWide(onChange: () => void): () => void {
  const query = window.matchMedia(PINNED_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
const isWide = () => window.matchMedia(PINNED_QUERY).matches
// Server and hydration: the column (desktop); CSS hides it below 1024 px before the first paint.
const wideOnServer = () => true

/**
 * The toggle column exists only in this subheader. Render page content as its NEXT sibling.
 * `pinned`: the navigation is a column of its own from 1024 px; see the prop.
 */
export function WorkspaceSubheader({
  header, tabs, navigationLabel, groups, views, onNavigate, chrome,
  pinned = false, title, subtitle, navigationOpen, onNavigationOpenChange, navigationId,
}: WorkspaceSubheaderProps) {
  const id = useId()
  const panelId = navigationId ?? `${id}-navigation`
  const pinnedBodyId = `${id}-pinned-navigation`
  const root = useRef<HTMLDivElement>(null)
  const [surface, setSurface] = useState<'navigation' | 'views' | null>(null)
  const [inset, setInset] = useState({ top: 0, left: 0 })
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const [columnCollapsed, setColumnCollapsed] = useState(false)
  const focusAfterToggle = useRef(false)
  const wide = useSyncExternalStore(subscribeWide, isWide, wideOnServer)
  const columnShown = pinned && wide
  const controlled = navigationOpen !== undefined
  const requested = controlled ? navigationOpen : surface === 'navigation'
  // A pinned column never sits beside its own drawer.
  const open = requested && !columnShown
  const latest = useRef({ requested, onNavigationOpenChange })
  useLayoutEffect(() => { latest.current = { requested, onNavigationOpenChange } })
  const close = useCallback(() => {
    setSurface(null)
    if (latest.current.requested) latest.current.onNavigationOpenChange?.(false)
  }, [])
  const toggleNavigation = () => {
    setSurface(open ? null : 'navigation')
    onNavigationOpenChange?.(!open)
  }
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const measure = () => {
      const rect = el.getBoundingClientRect()
      const next = {
        top: Math.max(0, chrome?.header?.isConnected ? chrome.header.getBoundingClientRect().bottom : rect.top),
        left: Math.max(0, Math.min(window.innerWidth, chrome?.primaryNavigation?.isConnected ? chrome.primaryNavigation.getBoundingClientRect().right : rect.left)),
      }
      setInset(old => old.top === next.top && old.left === next.left ? old : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    for (const target of [el, chrome?.header, chrome?.primaryNavigation]) if (target) observer.observe(target)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    window.visualViewport?.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      window.visualViewport?.removeEventListener('resize', measure)
    }
  }, [chrome?.header, chrome?.primaryNavigation])

  // An external route/view change also closes the panel. Hovering or opening it never changes a route.
  const selection = groups.flatMap(g => g.items).filter(i => i.active).map(i => i.href).join('|')
  useEffect(close, [selection, close])
  // A drawer asked for on a narrow screen closes when the screen becomes wide enough for the column.
  useEffect(() => { if (columnShown && requested) close() }, [columnShown, requested, close])
  // The Collapse / Expand button unmounts as it toggles: focus moves to the one that replaced it.
  useEffect(() => {
    if (!focusAfterToggle.current) return
    focusAfterToggle.current = false
    root.current?.querySelector<HTMLElement>('[data-nds-pin-toggle]')?.focus({ preventScroll: true })
  }, [columnCollapsed])

  const navigate = (event: MouseEvent<HTMLAnchorElement>, item: WorkspaceNavItem) => {
    onNavigate?.(event, item)
    close()
  }
  const menuItems: MenuItemDef[] = (views?.items ?? []).map(item => ({
    id: item.id, label: item.label, icon: item.icon, href: item.href,
  }))
  const titleMenu = views && views.items.length > 1 ? (
    <Menu
      label={<ChevronDown size={14} aria-hidden />}
      items={menuItems}
      open={surface === 'views'}
      onOpenChange={next => setSurface(next ? 'views' : null)}
      selectedId={views.selectedId}
      onNavigate={(event, item) => {
        const destination = views.items.find(view => view.id === item.id)
        if (destination) onNavigate?.(event, destination)
      }}
      triggerProps={{ className: 'nds-tbtn', 'aria-label': views.label }}
    />
  ) : null

  const navigation = (scope: string) => (
    <nav aria-label={navigationLabel}>
      {groups.filter(group => group.items.length > 0).map(group => {
        const expanded = !!group.hideLabel || !collapsedGroups.has(group.id)
        const groupId = `${id}-${scope}-${group.id}`
        return (
          <section className="nds-secondary-nav-group" key={group.id} aria-labelledby={`${groupId}-label`}>
            {group.hideLabel ? <span id={`${groupId}-label`} className="nds-vh">{group.label}</span> : group.collapsible ? (
              <button
                id={`${groupId}-label`}
                type="button"
                className="nds-secondary-nav-group-label disclosure"
                aria-expanded={expanded}
                aria-controls={groupId}
                onClick={() => setCollapsedGroups(previous => {
                  const next = new Set(previous)
                  next.has(group.id) ? next.delete(group.id) : next.add(group.id)
                  return next
                })}
              >{group.label}<ChevronDown size={14} aria-hidden /></button>
            ) : <div id={`${groupId}-label`} className="nds-secondary-nav-group-label">{group.label}</div>}
            <div id={groupId} hidden={!expanded}>
              {group.items.map(item => (
                <a
                  key={item.id}
                  href={item.href}
                  className="nds-secondary-nav-link"
                  aria-current={item.active ? 'page' : undefined}
                  onClick={event => navigate(event, item)}
                >
                  {item.icon && <span className="nds-secondary-nav-icon" aria-hidden>{item.icon}</span>}
                  <span className="nds-secondary-nav-label">{item.label}</span>
                  {item.badge != null && <Tag>{item.badge}</Tag>}
                </a>
              ))}
            </div>
          </section>
        )
      })}
    </nav>
  )
  const lowerLabel = navigationLabel.toLowerCase()
  // A pinned subheader's drawer (below 1024 px) opens from a page button and closes away: "Close Reviews navigation".
  // "Collapse …" belongs to the column, which folds to its strip, and to the plain subheader's drawer, which its own
  // "Expand …" strip opened.
  const drawerCloseLabel = pinned ? `Close ${navigationLabel}` : `Collapse ${lowerLabel}`
  const drawer = (
    <Drawer
      id={panelId}
      open={open}
      onClose={close}
      title={title ?? navigationLabel}
      subtitle={subtitle}
      side="left"
      backdrop="transparent"
      inset={inset}
      width="var(--nds-secondary-nav-w)"
      className="nds-secondary-navigation"
      closeLabel={drawerCloseLabel}
      closeIcon={<PanelLeftClose size={18} aria-hidden />}
    >
      {navigation('drawer')}
    </Drawer>
  )
  const toggleColumn = (collapsed: boolean) => {
    focusAfterToggle.current = true
    setColumnCollapsed(collapsed)
  }

  if (pinned) {
    return (
      <TooltipPortalProvider>
      <div
        className={`nds-workspace-subheader pinned${columnCollapsed ? ' collapsed' : ''}`}
        ref={root}
        style={chrome?.header ? { '--nds-secondary-nav-top': `${inset.top}px` } as CSSProperties : undefined}
      >
        {columnShown && (columnCollapsed ? (
          <div className="nds-workspace-subheader-toggle">
            <ToolbarButton
              data-nds-pin-toggle=""
              icon={<PanelLeftOpen size={18} aria-hidden />}
              label={`Expand ${lowerLabel}`}
              aria-expanded={false}
              onClick={() => toggleColumn(false)}
            />
          </div>
        ) : (
          <aside className="nds-drawer-embedded nds-secondary-navigation" aria-labelledby={`${id}-pinned-title`}>
            <div className="nds-drawer-h">
              <div className="nds-drawer-ht">
                <span className="t" id={`${id}-pinned-title`}>{title ?? navigationLabel}</span>
                {subtitle != null && <span className="st">{subtitle}</span>}
              </div>
              <ToolbarButton
                data-nds-pin-toggle=""
                icon={<PanelLeftClose size={18} aria-hidden />}
                label={`Collapse ${lowerLabel}`}
                aria-expanded
                aria-controls={pinnedBodyId}
                onClick={() => toggleColumn(true)}
              />
            </div>
            <div className="nds-drawer-b" id={pinnedBodyId}>{navigation('pinned')}</div>
          </aside>
        ))}
        {drawer}
      </div>
      </TooltipPortalProvider>
    )
  }

  const headerBand = typeof header === 'function' ? header(titleMenu) : header
  return (
    <TooltipPortalProvider>
    <div className="nds-workspace-subheader" ref={root}>
      <div className="nds-workspace-subheader-toggle">
        <ToolbarButton
          icon={<PanelLeftOpen size={18} aria-hidden />}
          label={`Expand ${lowerLabel}`}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={event => {
            event.currentTarget.focus({ preventScroll: true })
            toggleNavigation()
          }}
        />
      </div>
      {(headerBand != null || tabs != null) && (
        <div className="nds-workspace-subheader-main">
          {headerBand}
          {tabs != null && <div className="nds-workspace-subheader-tabs">{tabs}</div>}
        </div>
      )}
      {drawer}
    </div>
    </TooltipPortalProvider>
  )
}
