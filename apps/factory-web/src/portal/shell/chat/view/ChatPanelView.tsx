'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, MessageSquare } from 'lucide-react'
import { Drawer, EmptyState } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import type { ChatRecord, ChatRow } from '../model'
import '../chat.css'

/**
 * owb-po5.4 (plan § 5d, design `chatDock`) — the Chat panel beside the page, from the top bar's Chat button: the list of the person's
 * chats (newest first, each with its new messages), one chat (the frame's PortalThread: the same thread as everywhere, `children`),
 * the back arrow to the list. Esc and Close shut it (the DS Drawer); the page stays where it was. No quiet line is ever counted.
 */

export interface ChatPanelModel {
  open: boolean
  /** The chat shown; null: the list. */
  record: ChatRecord | null
  state: 'loading' | 'error' | 'ready'
  rows: readonly ChatRow[]
}

export interface ChatPanelActions {
  onClose?: () => void
  onBack?: () => void
  onPick?: (record: ChatRecord) => void
  onRetry?: () => void
}

export function ChatPanelView({ model, actions, children }: { model: ChatPanelModel; actions?: ChatPanelActions; children?: ReactNode }) {
  const t = useT('portal')
  return (
    <Drawer
      open={model.open}
      onClose={() => actions?.onClose?.()}
      side="right"
      backdrop="transparent"
      width={440}
      className="fw-pchat"
      title={model.record ? (model.record.label ?? t('chat.title')) : t('chat.title')}
      closeLabel={t('chat.close')}
    >
      {model.record ? (
        <div className="fw-pchat-one">
          <Button size="sm" variant="quiet" className="fw-pchat-back" onClick={() => actions?.onBack?.()}>
            <ArrowLeft size={14} aria-hidden /> {t('chat.back')}
          </Button>
          <div className="fw-pchat-thread">{children}</div>
        </div>
      ) : model.state === 'loading' ? (
        <p className="fw-pchat-quiet" role="status">
          {t('chat.reading')}
        </p>
      ) : model.state === 'error' ? (
        <div className="fw-pchat-quiet" role="alert">
          <span>{t('chat.failed')}</span>
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {t('chat.retry')}
          </Button>
        </div>
      ) : model.rows.length === 0 ? (
        <EmptyState icon={<MessageSquare size={22} aria-hidden />} title={t('chat.none')} />
      ) : (
        <ul className="fw-pchat-list" aria-label={t('chat.list')}>
          {model.rows.map((row) => (
            <li key={row.key}>
              <button type="button" className="fw-pchat-row" onClick={() => actions?.onPick?.(row.record)} aria-label={row.newCount > 0 ? t('chat.rowNew', { name: row.title, count: row.newCount }) : row.title}>
                <span className="fw-pchat-row-text">
                  <span className="fw-pchat-row-title">{row.title}</span>
                  {row.subtitle ? <span className="fw-pchat-row-sub">{row.subtitle}</span> : null}
                  {row.excerpt ? <span className="fw-pchat-row-sub">{row.excerpt}</span> : null}
                </span>
                {row.newCount > 0 ? <Pill tone="info">{t('chat.new', { count: row.newCount })}</Pill> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  )
}
