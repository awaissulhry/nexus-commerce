'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
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
  label: string
  items: readonly WorkspaceNavItem[]
  collapsible?: boolean
}

export interface WorkspaceSubheaderProps {
  /** The existing page header. A render function places the optional view menu beside its title. */
  header: ReactNode | ((titleMenu: ReactNode) => ReactNode)
  tabs?: ReactNode
  navigationLabel: string
  groups: readonly WorkspaceNavGroup[]
  views?: { label: string; selectedId: string; items: readonly WorkspaceNavItem[] }
  /** Browser-native links by default; adapters may preserve their router's navigation semantics. */
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>, item: WorkspaceNavItem) => void
  /** Actual shell elements, observed for resizing, pinning and hover expansion. */
  chrome?: { header: HTMLElement | null; primaryNavigation: HTMLElement | null }
}

/** The toggle column exists only in this subheader. Render page content as its NEXT sibling. */
export function WorkspaceSubheader({ header, tabs, navigationLabel, groups, views, onNavigate, chrome }: WorkspaceSubheaderProps) {
  const id = useId()
  const panelId = `${id}-navigation`
  const root = useRef<HTMLDivElement>(null)
  const [surface, setSurface] = useState<'navigation' | 'views' | null>(null)
  const [inset, setInset] = useState({ top: 0, left: 0 })
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const open = surface === 'navigation'
  const close = useCallback(() => setSurface(null), [])

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

  return (
    <TooltipPortalProvider>
    <div className="nds-workspace-subheader" ref={root}>
      <div className="nds-workspace-subheader-toggle">
        <ToolbarButton
          icon={<PanelLeftOpen size={18} aria-hidden />}
          label={`Expand ${navigationLabel.toLowerCase()}`}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={event => {
            event.currentTarget.focus({ preventScroll: true })
            setSurface(open ? null : 'navigation')
          }}
        />
      </div>
      <div className="nds-workspace-subheader-main">
        {typeof header === 'function' ? header(titleMenu) : header}
        {tabs != null && <div className="nds-workspace-subheader-tabs">{tabs}</div>}
      </div>
      <Drawer
        id={panelId}
        open={open}
        onClose={close}
        title={navigationLabel}
        side="left"
        backdrop="transparent"
        inset={inset}
        width="var(--nds-secondary-nav-w)"
        className="nds-secondary-navigation"
        closeLabel={`Collapse ${navigationLabel.toLowerCase()}`}
        closeIcon={<PanelLeftClose size={18} aria-hidden />}
      >
        <nav aria-label={navigationLabel}>
          {groups.filter(group => group.items.length > 0).map(group => {
            const expanded = !collapsedGroups.has(group.id)
            const groupId = `${id}-${group.id}`
            return (
              <section className="nds-secondary-nav-group" key={group.id} aria-labelledby={`${groupId}-label`}>
                {group.collapsible ? (
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
      </Drawer>
    </div>
    </TooltipPortalProvider>
  )
}
