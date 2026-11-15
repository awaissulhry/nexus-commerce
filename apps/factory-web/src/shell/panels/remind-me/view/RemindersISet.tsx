'use client'

import { AlarmClock, Check, MessageSquare, RefreshCw, Trash2 } from 'lucide-react'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { Reminder } from '../api'
import { whenWords } from '../model'
import '../remind-me.css'

/** What the record's Remind me part shows: my reminders on the record, as read. */
export interface RemindersISetModel {
  readonly reminders: { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: string } | { readonly status: 'ready'; readonly items: readonly Reminder[] }
  /** Why changing is held now (offline, a change in flight): a message key of `home-mywork`, or null. */
  readonly held: string | null
  /** A notice after a change (a message key of `home-mywork`), or null. */
  readonly notice: { readonly key: string; readonly tone: 'success' | 'warning' | 'danger' } | null
}

export interface RemindersISetActions {
  onRemind?: () => void
  onDone?: (reminder: Reminder) => void
  onRemove?: (reminder: Reminder) => void
  onRetry?: () => void
}

/**
 * The record's "Remind me" and "Reminders I set" (design shell.panels side panel "Tasks on this record (W2a) … · Reminders I set
 * (W2b)", popup remind-me "⋯ › Remind me"): the Remind me button beside Follow, and my open reminders on this record — when each
 * comes back (or that it came back), my note, Done and Remove. Only mine: nobody else sees them. It draws ONE model.
 */
export function RemindersISet({ model, actions }: { model: RemindersISetModel; actions?: RemindersISetActions }) {
  return (
    <WithMessages namespaces={['home-mywork']}>
      <Reminders model={model} actions={actions} />
    </WithMessages>
  )
}

function Reminders({ model, actions }: { model: RemindersISetModel; actions?: RemindersISetActions }) {
  const t = useT('home-mywork')
  const locale = useLocale()
  const items = model.reminders.status === 'ready' ? model.reminders.items : []
  const held = model.held ? t(model.held) : null
  return (
    <section className="fw-remind-set" aria-label={t('set.label')}>
      <div className="fw-remind-set-head">
        <Button size="sm" variant="secondary" heldReason={held} onClick={() => actions?.onRemind?.()}>
          <AlarmClock size={14} aria-hidden /> {t('set.remind')}
        </Button>
        {model.reminders.status === 'ready' && items.length > 0 && <span className="fw-remind-muted">{t('set.count', { count: items.length })}</span>}
        <span role="status" className="fw-remind-set-notice">
          {model.notice && <Tag tone={model.notice.tone}>{t(model.notice.key)}</Tag>}
        </span>
      </div>
      {model.reminders.status === 'loading' ? (
        <Skeleton height={20} />
      ) : model.reminders.status === 'error' ? (
        <p className="fw-remind-muted">
          {t(model.reminders.problem)}{' '}
          <Button size="sm" variant="link" onClick={() => actions?.onRetry?.()}>
            {t('retry')}
          </Button>
        </p>
      ) : items.length > 0 ? (
        <ul className="fw-remind-set-list" aria-label={t('set.title')}>
          {items.map((reminder) => {
            const when = whenWords(reminder)
            return (
              <li key={reminder.id} className={reminder.state === 'CAME_BACK' ? 'fw-remind-set-item is-back' : 'fw-remind-set-item'}>
                <span className="fw-remind-set-text">
                  <span className="fw-remind-set-when">
                    {reminder.kind === 'ON_CHANGE' && reminder.state === 'WAITING' ? <RefreshCw size={12} aria-hidden /> : <AlarmClock size={12} aria-hidden />}{' '}
                    {t(when.key, { at: when.at ? formatDateTime(when.at, { locale }) : '' })}
                    {reminder.messageId && (
                      <>
                        {' · '}
                        <MessageSquare size={12} aria-hidden /> {t('set.message')}
                      </>
                    )}
                  </span>
                  {reminder.note && <span className="fw-remind-set-note">{reminder.note}</span>}
                </span>
                <span className="fw-remind-set-actions">
                  <Button size="sm" variant="quiet" heldReason={held} aria-label={t('set.done', { record: reminder.record.label })} onClick={() => actions?.onDone?.(reminder)}>
                    <Check size={14} aria-hidden />
                  </Button>
                  <Button size="sm" variant="quiet" heldReason={held} aria-label={t('set.remove', { record: reminder.record.label })} onClick={() => actions?.onRemove?.(reminder)}>
                    <Trash2 size={14} aria-hidden />
                  </Button>
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
