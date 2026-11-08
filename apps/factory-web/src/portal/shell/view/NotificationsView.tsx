'use client'

import type { KeyboardEvent, MouseEvent } from 'react'
import Link from 'next/link'
import { AlertCircle, CheckCheck } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'

/**
 * pop:notifications — the bell's list (design portal.frame; PLT-148): newest first, what changed, on which record, when; an
 * unread mark; "Mark all as read"; each row a real link to the record and tab (⌘-click opens a new tab). ↑ ↓ move between
 * rows, Enter opens, Esc closes. Under the bell on a desktop, a full-height sheet on a phone (the DS Modal `sheet`).
 */

export interface NotificationRow {
  id: string
  /** What happened, in the person's language. */
  sentence: string
  /** The record as the partner reads it. */
  record: string
  /** When (written). */
  when: string
  read: boolean
  href: string
  /** Rows folded into this one ("and 2 more like it"). */
  more: number
}

export interface NotificationsViewModel {
  open: boolean
  state: 'loading' | 'error' | 'ready'
  rows: readonly NotificationRow[]
  unread: number
  /** Marking all as read is running. */
  marking?: boolean
  /** Why "Mark all as read" cannot act (a preview reads only). */
  markHeld?: string | null
}

export interface NotificationsViewProps {
  model: NotificationsViewModel
  anchor?: HTMLElement | null
  onClose: () => void
  onMarkAll?: () => void
  onRetry?: () => void
  /** A row was opened (the container marks it read and navigates). */
  onOpen?: (row: NotificationRow, event: MouseEvent<HTMLAnchorElement>) => void
}

export function NotificationsView({ model, anchor, onClose, onMarkAll, onRetry, onOpen }: NotificationsViewProps) {
  const t = useT('portal')
  const move = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('a.fw-pnote')]
    const at = links.indexOf(document.activeElement as HTMLAnchorElement)
    event.preventDefault()
    const next = at < 0 ? 0 : Math.min(links.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))
    links[next]?.focus()
  }
  return (
    <Modal
      open={model.open}
      onClose={onClose}
      sheet
      anchor={anchor}
      size="md"
      title={t('bell.title')}
      subtitle={model.state === 'ready' ? (model.unread > 0 ? t('bell.unread', { count: model.unread }) : t('bell.none')) : undefined}
      headerActions={
        model.state === 'ready' && model.unread > 0 && onMarkAll ? (
          <Button size="sm" variant="quiet" onClick={onMarkAll} heldReason={model.marking ? t('bell.marking') : (model.markHeld ?? null)}>
            <CheckCheck size={15} aria-hidden /> {t('bell.markAll')}
          </Button>
        ) : undefined
      }
    >
      {model.state === 'loading' ? (
        <div className="fw-pnotes-loading" role="status" aria-label={t('state.loading')}>
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} height={44} />
          ))}
        </div>
      ) : model.state === 'error' ? (
        <div className="fw-pstate" role="alert">
          <AlertCircle size={18} aria-hidden />
          <span>{t('bell.failed')}</span>
          {onRetry ? <Button onClick={onRetry}>{t('state.retry')}</Button> : null}
        </div>
      ) : model.rows.length === 0 ? (
        <EmptyState title={t('bell.emptyTitle')} description={t('bell.empty')} />
      ) : (
        <ul className="fw-pnotes" onKeyDown={move}>
          {model.rows.map((row) => (
            <li key={row.id}>
              <Link href={row.href} className={row.read ? 'fw-pnote' : 'fw-pnote unread'} onClick={(event) => onOpen?.(row, event)}>
                <span className="fw-pnote-mark" aria-hidden="true" />
                <span className="fw-pnote-text">
                  <span className="fw-pnote-sentence">
                    {row.read ? null : <span className="fw-sr">{t('bell.unreadMark')} </span>}
                    {row.sentence}
                  </span>
                  <span className="fw-pnote-meta">
                    {row.record} · {row.when}
                    {row.more > 0 ? ` · ${t('bell.alsoMore', { count: row.more })}` : ''}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
