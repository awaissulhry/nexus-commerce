'use client'

import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

export interface ShellNavItem {
  id: string
  label: ReactNode
  icon: ReactNode
  href?: string
  active?: boolean
  badge?: ReactNode
  onClick?: () => void
}

export interface ShellSubItem {
  id: string
  label: ReactNode
  href?: string
  active?: boolean
  onClick?: () => void
}

/** A collapsible parent with sub-items (the H10 AMC / Reporting groups). */
export interface ShellNavGroup {
  id: string
  label: ReactNode
  icon: ReactNode
  items: ShellSubItem[]
  defaultOpen?: boolean
}

export type ShellNavEntry = ShellNavItem | ShellNavGroup

export interface AppShellProps {
  brand: { mark: ReactNode; name: ReactNode }
  nav: ShellNavEntry[]
  footer?: ReactNode
  children: ReactNode
  className?: string
}

const isGroup = (e: ShellNavEntry): e is ShellNavGroup => 'items' in e

function SubItem({ item }: { item: ShellSubItem }) {
  const cls = ['h10-ds-subitem', item.active ? 'on' : ''].filter(Boolean).join(' ')
  return item.href ? (
    <a className={cls} href={item.href} aria-current={item.active ? 'page' : undefined}>
      {item.label}
    </a>
  ) : (
    <button type="button" className={cls} onClick={item.onClick} aria-current={item.active ? 'page' : undefined}>
      {item.label}
    </button>
  )
}

/**
 * App frame (H10 rail + content). Collapsed 66px icon rail that hover-expands
 * (pure CSS); flat items show an active fill + count badge, while groups expand
 * to reveal sub-items (a group opens by default if it holds the active route, or
 * via `defaultOpen`). Fills its parent — wrap in a `100dvh` container for a
 * full-page layout.
 */
export function AppShell({ brand, nav, footer, children, className }: AppShellProps) {
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(nav.filter(isGroup).filter((g) => g.defaultOpen || g.items.some((i) => i.active)).map((g) => g.id)),
  )
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  return (
    <div className={`h10-ds-shell${className ? ` ${className}` : ''}`}>
      <aside className="h10-ds-rail">
        <div className="h10-ds-brand">
          <span className="mark">{brand.mark}</span>
          <span className="name">{brand.name}</span>
        </div>
        <nav className="h10-ds-nav">
          {nav.map((entry) => {
            if (isGroup(entry)) {
              const isOpen = open.has(entry.id)
              return (
                <div className="h10-ds-group" key={entry.id}>
                  <button type="button" className="h10-ds-navitem" onClick={() => toggle(entry.id)} aria-expanded={isOpen}>
                    <span className="ico">{entry.icon}</span>
                    <span className="lbl">{entry.label}</span>
                    <ChevronDown size={15} className={['chev', isOpen ? 'open' : ''].filter(Boolean).join(' ')} aria-hidden />
                  </button>
                  {isOpen && (
                    <div className="h10-ds-sub">
                      {entry.items.map((sub) => (
                        <SubItem key={sub.id} item={sub} />
                      ))}
                    </div>
                  )}
                </div>
              )
            }
            const cls = ['h10-ds-navitem', entry.active ? 'on' : ''].filter(Boolean).join(' ')
            const inner = (
              <>
                <span className="ico">{entry.icon}</span>
                <span className="lbl">{entry.label}</span>
                {entry.badge != null && <span className="h10-ds-navbadge">{entry.badge}</span>}
              </>
            )
            return entry.href ? (
              <a key={entry.id} className={cls} href={entry.href} aria-current={entry.active ? 'page' : undefined}>
                {inner}
              </a>
            ) : (
              <button key={entry.id} type="button" className={cls} onClick={entry.onClick} aria-current={entry.active ? 'page' : undefined}>
                {inner}
              </button>
            )
          })}
        </nav>
        {footer != null && <div className="h10-ds-railft">{footer}</div>}
      </aside>
      <main className="h10-ds-main">{children}</main>
    </div>
  )
}
