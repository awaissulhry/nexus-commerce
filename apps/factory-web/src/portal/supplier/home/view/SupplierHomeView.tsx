'use client'

import type { ReactNode } from 'react'
import { AlertCircle, MessageSquare, Truck } from 'lucide-react'
import { Banner, MetricStrip, type Metric } from '@nexus/ui/components'
import { RefPair } from '@nexus/ui/components/RefPair/index'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { quantityWords } from '../../../../lib/po-answer/lines'
import { ConfirmAllDialog, type ConfirmAllModel } from '../../orders/view/Dialogs'
import { useOrderWords } from '../../orders/words'
import type { Conversation } from '../api'
import { upcomingHref, type Tile, type UpcomingLine } from '../model'
import '../../orders/supplier-orders.css'

/**
 * SCR-189 — the supplier's Home (design portal.supplier.home): To do (the frame's one task list, passed in as `tasks`), At a
 * glance (five counts, each a link to its list), Next deliveries (the next ten lines by date, in the supplier's words),
 * Recent messages (our last three) and, once, quietly, "Free for suppliers" (SCM-102). No price anywhere (C2).
 */

type Section<T> = { state: 'loading' | 'error' | 'ready'; items: readonly T[] } | null

export interface SupplierHomeViewModel {
  prefix: string
  tiles: { state: 'loading' | 'error' | 'ready'; items: readonly Tile[] }
  /** null: the person does not see deliveries (not drawn). */
  upcoming: Section<UpcomingLine>
  messages: Section<Conversation & { href: string }>
  freeNote: boolean
  /** A confirmation made from a To-do row just now. */
  confirmed: { documentNumber: string; count: number } | null
  dialog: ConfirmAllModel | null
}

export interface SupplierHomeActions {
  onRetryTiles?: () => void
  onRetryUpcoming?: () => void
  onRetryMessages?: () => void
  onHideFreeNote?: () => void
  onHideConfirmed?: () => void
  dialog?: { onRef?: (value: string) => void; onConfirm?: () => void; onClose?: () => void }
}

export function SupplierHomeView({ model, actions, tasks }: { model: SupplierHomeViewModel; actions?: SupplierHomeActions; tasks: ReactNode }) {
  const words = useOrderWords()
  const { t, day, at } = words
  const ds = useDsWords()
  const failed = (text: string, onRetry?: () => void) => (
    <div className="fw-pstate" role="alert">
      <AlertCircle size={18} aria-hidden />
      <span>{text}</span>
      {onRetry ? <Button onClick={onRetry}>{t('state.retry')}</Button> : null}
    </div>
  )
  const loading = (height: number) => (
    <div className="fw-pso-stack" role="status" aria-label={t('state.loading')}>
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} height={height} />
      ))}
    </div>
  )

  const metrics: Metric[] = model.tiles.items.map((tile) => {
    const value = model.tiles.state === 'loading' ? <Skeleton width={36} height={22} /> : tile.value === null ? '—' : String(tile.value)
    const base = { label: t(tile.label), value, hint: tile.value === null && model.tiles.state === 'ready' ? t('tiles.unknown') : t(tile.hint), ...(tile.tone && (tile.value ?? 0) > 0 ? { accent: tile.tone === 'danger' ? 'var(--nds-danger)' : 'var(--nds-warning)' } : {}) }
    return tile.href ? { ...base, href: `${model.prefix}${tile.href}` } : base
  })

  return (
    <div className="fw-psh">
      {model.confirmed ? (
        <Banner
          tone="success"
          title={t('home.confirmed', { number: model.confirmed.documentNumber, count: model.confirmed.count })}
          action={
            <Button size="sm" onClick={() => actions?.onHideConfirmed?.()}>
              {t('home.hide')}
            </Button>
          }
        />
      ) : null}
      <div className="fw-psh-grid">
        <div className="fw-psh-main">
          {tasks}
        </div>
        <div className="fw-psh-side">
          <section className="fw-psh-section" aria-labelledby="fw-psh-glance">
            <h2 id="fw-psh-glance" className="fw-psh-title">{t('home.glance')}</h2>
            {model.tiles.state === 'error' ? failed(t('tiles.failed'), actions?.onRetryTiles) : <MetricStrip metrics={metrics} minTileWidth={150} />}
          </section>
        </div>
      </div>
      {model.upcoming ? (
        <section className="fw-psh-section" aria-labelledby="fw-psh-upcoming">
          <h2 id="fw-psh-upcoming" className="fw-psh-title">{t('home.upcoming')}</h2>
          {model.upcoming.state === 'loading' ? (
            loading(52)
          ) : model.upcoming.state === 'error' ? (
            failed(t('home.upcomingFailed'), actions?.onRetryUpcoming)
          ) : model.upcoming.items.length === 0 ? (
            <p className="fw-pso-hint fw-psh-empty">
              <Truck size={16} aria-hidden /> {t('home.upcomingEmpty')}
            </p>
          ) : (
            <ul className="fw-pso-rows" aria-label={t('home.upcoming')}>
              {model.upcoming.items.map((line) => (
                <li key={line.id}>
                  <a className="fw-pso-row fw-pso-pressable" href={upcomingHref(model.prefix, line)}>
                    <span className="fw-pso-row-main">
                      <strong>
                        {line.code} · {line.name}
                      </strong>
                      <span className="fw-pso-sub">
                        {[line.colour ? t('lines.colour', { colour: line.colour }) : null, quantityWords(line.open, line.uom, words), t('home.order', { number: line.documentNumber, seq: line.seq })].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="fw-psh-dates">
                      <span>{t('home.needed', { date: day(line.needDate) })}</span>
                      <span className="fw-pso-sub">{line.confirmedDate ? t('home.confirmedFor', { date: day(line.confirmedDate) }) : t('home.notConfirmed')}</span>
                    </span>
                    <span className="fw-psh-mark">
                      {line.late ? <Pill tone="danger">{t('home.late')}</Pill> : line.announced ? <Pill tone="info">{t('home.announced')}</Pill> : <Pill tone="neutral">{t('home.notAnnounced')}</Pill>}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {model.messages ? (
        <section className="fw-psh-section" aria-labelledby="fw-psh-messages">
          <h2 id="fw-psh-messages" className="fw-psh-title">{t('home.messages')}</h2>
          {model.messages.state === 'loading' ? (
            loading(52)
          ) : model.messages.state === 'error' ? (
            failed(t('home.messagesFailed'), actions?.onRetryMessages)
          ) : model.messages.items.length === 0 ? (
            <p className="fw-pso-hint fw-psh-empty">
              <MessageSquare size={16} aria-hidden /> {t('home.messagesEmpty')}
            </p>
          ) : (
            <ul className="fw-pso-rows" aria-label={t('home.messages')}>
              {model.messages.items.map((conversation) => (
                <li key={conversation.thread.id} className="fw-pso-row">
                  <span className="fw-pso-row-main">
                    <span className="fw-psh-from">
                      <strong>{conversation.last.authorName ?? t('home.fromUs')}</strong>
                      <span className="fw-pso-sub">{at(conversation.last.at)}</span>
                    </span>
                    {conversation.record.theirRef || conversation.record.ourRef ? (
                      <RefPair theirs={conversation.record.theirRef} ours={conversation.record.ourRef} theirsLabel={t('ref.yours')} oursLabel={t('ref.ours')} size="sm" copy={false} labels={ds.refPair} />
                    ) : null}
                    <span className="fw-psh-excerpt">{conversation.last.excerpt}</span>
                  </span>
                  <Button size="sm" asChild>
                    <a href={conversation.href} aria-label={t('home.replyTo', { record: conversation.record.ourRef ?? conversation.record.theirRef ?? '' })}>
                      {t('home.reply')}
                    </a>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {model.freeNote ? (
        <Banner
          tone="info"
          title={t('home.freeTitle')}
          action={
            <Button size="sm" onClick={() => actions?.onHideFreeNote?.()}>
              {t('home.hide')}
            </Button>
          }
        >
          {t('home.freeBody')}
        </Banner>
      ) : null}
      {model.dialog ? <ConfirmAllDialog model={model.dialog} actions={actions?.dialog} /> : null}
    </div>
  )
}
