'use client'

import type { ReactNode } from 'react'

export interface ShellNavItem {
  id: string
  label: ReactNode
  icon: ReactNode
  href?: string
  active?: boolean
  badge?: ReactNode
  onClick?: () => void
}

export interface AppShellProps {
  brand: { mark: ReactNode; name: ReactNode }
  nav: ShellNavItem[]
  footer?: ReactNode
  children: ReactNode
}

/**
 * App frame (H10 rail + content). Collapsed 66px icon rail that hover-expands
 * (pure CSS); the `.on` item is the active route. Fills its parent — wrap in a
 * `100dvh` container for a full-page layout (the catalog demos it in a box).
 */
export function AppShell({ brand, nav, footer, children }: AppShellProps) {
  return (
    <div className="h10-ds-shell">
      <aside className="h10-ds-rail">
        <div className="h10-ds-brand">
          <span className="mark">{brand.mark}</span>
          <span className="name">{brand.name}</span>
        </div>
        <nav className="h10-ds-nav">
          {nav.map((item) => {
            const cls = ['h10-ds-navitem', item.active ? 'on' : ''].filter(Boolean).join(' ')
            const inner = (
              <>
                <span className="ico">{item.icon}</span>
                <span className="lbl">{item.label}</span>
                {item.badge != null && <span className="h10-ds-navbadge">{item.badge}</span>}
              </>
            )
            return item.href ? (
              <a key={item.id} className={cls} href={item.href} aria-current={item.active ? 'page' : undefined}>
                {inner}
              </a>
            ) : (
              <button key={item.id} type="button" className={cls} onClick={item.onClick} aria-current={item.active ? 'page' : undefined}>
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
