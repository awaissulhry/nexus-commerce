'use client'

import Link from 'next/link'
import { MessageSquare } from 'lucide-react'
import type { Translate } from '../../i18n/messages'
import { cellOf as unreadCellOf, type Unread } from '../model'
import { dockClick } from './LastMessageCell'
import '../last-message-cell.css'

// pg-w1 (18-lead-settles Z10, D5): the bubble "2" and its header mark — ONE look for one fact on both faces (the office's Orders
// sheet and Work tab, the customer's portal list). Moved here from the Orders sheet's parts (they re-export both), unchanged; their
// css moved verbatim into last-message-cell.css. The words are the shared cell's own (`last-message`, the portal's in outside-words).

/**
 * F-CW-102 (10-design §3.5; lead settle S33): New messages as a count bubble — the reader's own new messages on the order ("2",
 * "99+"), a door to its thread at the first new one (a link; on a page with a dock, a button that docks it — ⌘ / Ctrl keeps the new
 * tab); nothing new: an empty cell with its words for a screen reader. The words are the shared cell's own (`last-message`).
 */
export function NewMessagesBubble({ unread, href, record, onOpen, l }: { unread: Unread | undefined; href: string | null; record: string; onOpen?: (() => void) | null; l: Translate }) {
  const cell = unreadCellOf(unread)
  if (cell.kind === 'empty') return <span className="nds-vh">{l('cell.none')}</span>
  const label = l('cell.label', { count: cell.count, record })
  const count = cell.key === 'cell.many' ? '99+' : String(cell.count)
  if (onOpen)
    return (
      <button type="button" className="fw-sheet-msgs" aria-label={label} title={label} data-door="" onClick={(event) => dockClick(event, href, onOpen)} onAuxClick={(event) => event.button === 1 && href && window.open(href, '_blank', 'noopener')}>
        {count}
      </button>
    )
  if (!href)
    return (
      <span className="fw-sheet-msgs" title={label}>
        {count}
      </span>
    )
  return (
    <Link className="fw-sheet-msgs" href={href} aria-label={label} title={label} data-door="">
      {count}
    </Link>
  )
}

/** F-CW-102 (S33): the New messages column's header in a narrow column — the message mark; the column's name stays its accessible name. */
export function MessagesHeader({ displayName }: { displayName?: string }) {
  return (
    <span className="fw-sheet-hicon" title={displayName}>
      <MessageSquare size={14} aria-hidden />
      <span className="nds-vh">{displayName}</span>
    </span>
  )
}
