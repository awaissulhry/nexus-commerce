'use client'

import type { KeyboardEvent, MouseEvent } from 'react'
import Link from 'next/link'
import type { AreaNav } from '@nexus/ui/patterns/shell/index'
import { useT } from '../../../lib/i18n/provider'
import type { BadgeWords } from '../model'

/**
 * The portal's rail (design portal.frame › rail; anatomy D5): the partner's 3–6 areas, ALWAYS labelled — icon and label side
 * by side from 1024 px, the label under the icon from 720 px (partners are occasional users: icons alone fail them); under
 * 720 px the bottom bar takes over. A badge counts only what waits for this person, and its spoken name carries its noun
 * ("Orders, 2 to confirm"); an unknown count shows nothing, never 0. ↑ ↓ move between rows, Enter opens.
 *
 * COMPOSED here because the DS `AppRail` has no labels at rest (only a 344 px pinned column) and names every badge
 * "N pending" in English (anatomy D5, `badgeLabel`): a missing DS part, named in the step's notes.
 */

export interface PortalRailProps {
  /** The person's areas, labels already in their language. */
  nav: AreaNav
  /** The current area's id. */
  current: string | null
  /** The badges by the task list's area; null: none known. */
  badges: Readonly<Record<string, BadgeWords>> | null
  toHref: (address: string) => string
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>, href: string) => void
}

export function PortalRail({ nav, current, badges, toHref, onNavigate }: PortalRailProps) {
  const t = useT('portal')
  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('a.fw-prail-row')]
    const at = links.indexOf(document.activeElement as HTMLAnchorElement)
    if (at < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length
    links[next]?.focus()
  }
  return (
    <nav className="fw-prail" aria-label={t('rail.label')} onKeyDown={moveFocus}>
      <ul className="fw-prail-list">
        {nav.areas.map((area) => {
          const badge = area.badge ? (badges?.[area.badge] ?? null) : null
          const Icon = area.icon
          const href = toHref(area.href)
          const isCurrent = area.id === current
          return (
            <li key={area.id}>
              <Link
                href={href}
                className={isCurrent ? 'fw-prail-row on' : 'fw-prail-row'}
                aria-current={isCurrent ? 'page' : undefined}
                aria-label={badge ? t('rail.withBadge', { area: area.label, badge: badge.words }) : area.label}
                onClick={(event) => onNavigate?.(event, href)}
              >
                <span className="fw-prail-ico" aria-hidden="true">
                  <Icon size={20} strokeWidth={1.75} />
                  {badge ? <span className="fw-prail-badge">{badge.count > 99 ? '99+' : badge.count}</span> : null}
                </span>
                <span className="fw-prail-lbl">{area.label}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
