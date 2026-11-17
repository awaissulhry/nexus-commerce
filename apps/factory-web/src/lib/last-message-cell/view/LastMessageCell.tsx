'use client'

import Link from 'next/link'
import { formatTime, formatDate } from '../../i18n/format'
import { useLocale, useT } from '../../i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { cellOf, type Unread } from '../model'
import '../last-message-cell.css'

export const LAST_MESSAGE_NS = 'last-message'

/**
 * B-TH-230 — the New messages cell (O-SAL-ORD-LIST.grid-F15, O-SAL-INQ-LIST.list-F01, P-CUS-ORD-LIST.list): the reader's own new
 * messages on a record — "● 2 new · 10:42" — as a door (Owner rule "every cell is a door") to the record's thread at the first new
 * message; empty when nothing is new. Draws what it is given; the list reads the counts (one read per page).
 */
export function LastMessageCell({ unread, href, record }: { unread: Unread | undefined; href: string | null; record: string }) {
  return (
    <WithMessages namespaces={[LAST_MESSAGE_NS]}>
      <Cell unread={unread} href={href} record={record} />
    </WithMessages>
  )
}

function Cell({ unread, href, record }: { unread: Unread | undefined; href: string | null; record: string }) {
  const t = useT(LAST_MESSAGE_NS)
  const locale = useLocale()
  const cell = cellOf(unread)
  if (cell.kind === 'empty') return <span className="fw-lmc-empty" aria-label={t('cell.none')} />
  const words = t(cell.key, { count: cell.count })
  // Today: the time; another day: the date (in the reader's own day).
  const when = cell.lastAt ? (new Date(cell.lastAt).toDateString() === new Date().toDateString() ? formatTime(cell.lastAt, { locale }) : formatDate(cell.lastAt, { locale })) : null
  const label = t('cell.label', { count: cell.count, record })
  const body = (
    <>
      <span className="fw-lmc-dot" aria-hidden />
      <span className="fw-lmc-count">{words}</span>
      {when && <span className="fw-lmc-when">· {when}</span>}
    </>
  )
  if (!href)
    return (
      <span className="fw-lmc" title={label}>
        {body}
      </span>
    )
  return (
    <Link className="fw-lmc is-door" href={href} aria-label={label} title={label} data-door="">
      {body}
    </Link>
  )
}
