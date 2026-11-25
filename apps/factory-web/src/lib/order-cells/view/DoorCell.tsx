'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import type { Translate } from '../../i18n/messages'
import type { Door, Phrase } from '../model'
import '../order-cells.css'

const say = (t: Translate, phrase: Phrase) => t(phrase.key, phrase.params)

/**
 * B-TH-225 / B-TH-226 (threads plan TH-1a; Owner rule 2026-11-16 "every cell is a door") — a cell's value as its door: the link
 * (⌘-click: a new tab), the words with the reason on hover, or plain words. pg-w1: moved here from the Orders sheet's parts (they
 * re-export it: its office importers stay as they are), unchanged — a mechanism like the list frame: the tips are the host's (`t`),
 * each host builds its own doors. The office's sheet, Incoming and the portal's list draw this same cell.
 */
export function DoorCell({ door, t, children, strong }: { door: Door; t: Translate; children: ReactNode; strong?: boolean }) {
  if (door && 'href' in door)
    return (
      <Link className={strong ? 'fw-sheet-door strong' : 'fw-sheet-door'} href={door.href} title={say(t, door.tip)} data-door="">
        {children}
      </Link>
    )
  if (door && 'held' in door)
    return (
      <span className="fw-sheet-held" tabIndex={0} title={say(t, door.held)} aria-label={`${typeof children === 'string' ? children : ''} — ${say(t, door.held)}`.replace(/^ — /, '')}>
        {children}
      </span>
    )
  return <span className="fw-sheet-plain">{children}</span>
}
