'use client'

import type { ReactNode } from 'react'
import { CornerDownRight } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { Button, InfoTip, Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { MessageCard } from '../../../../../lib/record-thread/card/view/MessageCard'
import { WIDTH_NS } from '../../../../../lib/record-thread/head/view/WidthMenu' // F-OP-204: the Head's words (width, ⋯)
import { RecordTypeIcon } from '../../../../search/RecordTypeIcon'
import { PickedDockColumn } from '../../ThreadPick' // F-OP-204: the dock's one card
import { opensItself, type AllOfCustomerModel, type FeedItem, type FeedKindChoice, type FeedView, type Words } from '../model'
import { FeedHead } from './FeedHead' // F-OP-204
import '../all-of-customer.css'

/** The catalogues the view reads (the host loads them: WithMessages). F-OP-204: + the Head's (FeedHead's width menu and ⋯). */
export const ALL_OF_CUSTOMER_NS = ['record-thread', 'record-thread-card', WIDTH_NS] as const

/** A record a line belongs to (the door's target). */
export interface FeedRecordRef {
  readonly type: string
  readonly id: string
}

export interface AllOfCustomerFeedActions {
  readonly onView?: (view: FeedView) => void
  readonly onKind?: (kind: FeedKindChoice) => void
  readonly onShowNew?: () => void
  readonly onOlder?: () => void
  readonly onRetry?: () => void
  /**
   * "Answer in its conversation", and a plain click on a line's chip: the host switches the dock to that record's ONE conversation,
   * at that message (B-TH-050's `?message=`). Without it the door is a link to the message on its record's page.
   */
  readonly onAnswer?: (record: FeedRecordRef, messageId: string) => void
  /** A file of a message: the host's viewer. Without it the file is opened in its conversation (onAnswer). */
  readonly onOpenFile?: (fileId: string, record: FeedRecordRef, messageId: string) => void
}

/**
 * F-OP-204 (order page plan N4; 11-dock §0.2, §1, §3; RC1) — All of <Customer> in the dock's ONE card (PickedDockColumn: the same
 * `section.fw-rt-column.is-docked` as a thread): the pick band first (its whose-line says it is read only and how to write, the host's
 * choice), the Head row (FeedHead: title, View ▾, Kind ▾, "N new · Show", the width menu, ⋯), the feed that scrolls, and the fixed foot
 * — the host's own (the order page's "Write in: This order · General") with the info icon that says what seeing a line does.
 */
export function AllOfCustomerDock({ label, model, actions, foot, customerHref }: { label: string; model: AllOfCustomerModel; actions?: AllOfCustomerFeedActions; foot?: ReactNode; customerHref?: string | null }) {
  return (
    <PickedDockColumn
      label={label}
      head={<FeedHead title={label} model={model} actions={actions} customerHref={customerHref ?? null} />}
      body={<AllOfCustomerFeed model={model} actions={actions} />}
      foot={<DockFoot>{foot}</DockFoot>}
    />
  )
}

/** The card's foot: the host's doors, then ONE info icon (the rule: key hints and the like only in the foot's info icon). */
function DockFoot({ children }: { children?: ReactNode }) {
  const t = useT('record-thread')
  return (
    <>
      {children}
      <span className="fw-aoc-foot-tip">
        <InfoTip tip={t('allOfCustomer.readMarks')} />
      </span>
    </>
  )
}

/**
 * F-SA-261 (sales page plan R4, P9, N4, N5; 10-order-page §6.2, 11-customer-page §9.2) — "All of <Customer>", the read-only merged
 * feed the dock pickers mount (F-SA-262 on the order page, F-SA-279 on the customer page): each message with its record chip (a real
 * link to the record — ⌘-click a new tab — and, clicked, the dock's switch to that conversation), the conversation's own card READ
 * ONLY, a "New" dot, and its door; Show older at the foot; what is left out said in words. Draws its model only.
 * F-OP-204: the body of the card — its one line, View ▾, Kind ▾ and "N new · Show" moved to the pick band and FeedHead.
 */
export function AllOfCustomerFeed({ model, actions }: { model: AllOfCustomerModel; actions?: AllOfCustomerFeedActions | undefined }) {
  const t = useT('record-thread')
  const customer = model.customerName
  const words = (text: Words) => t(text.key, text.params)

  return (
    <div className="fw-aoc">
      {model.status === 'loading' || model.status === 'idle' ? (
        <div className="fw-aoc-loading" aria-busy="true" aria-label={t('allOfCustomer.loading', { customer })}>
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} height={72} radius={8} />
          ))}
        </div>
      ) : model.status === 'failed' ? (
        <div className="fw-aoc-state" role="alert">
          <p>{t('allOfCustomer.failed')}</p>
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {t('allOfCustomer.retry')}
          </Button>
        </div>
      ) : model.status === 'gone' ? (
        <p className="fw-aoc-state">{t('allOfCustomer.gone')}</p>
      ) : model.items.length === 0 ? (
        <EmptyState className="fw-aoc-empty" title={t('allOfCustomer.empty', { customer })} description={model.view !== 'all' || model.kind !== 'every' ? t('allOfCustomer.emptyFiltered') : undefined} />
      ) : (
        <ol className="fw-aoc-list" aria-label={t('allOfCustomer.feedLabel', { customer })}>
          {model.items.map((item) => (
            <FeedLine key={item.key} item={item} model={model} actions={actions} chip={words(item.chip)} />
          ))}
        </ol>
      )}

      {model.status === 'ready' && (
        <footer className="fw-aoc-foot">
          {model.more ? (
            <Button size="sm" variant="quiet" aria-busy={model.older === 'loading'} onClick={() => actions?.onOlder?.()}>
              {t(model.older === 'loading' ? 'allOfCustomer.olderLoading' : model.older === 'failed' ? 'allOfCustomer.olderFailed' : 'allOfCustomer.showOlder')}
            </Button>
          ) : model.olderThreads > 0 ? (
            <p className="fw-aoc-note">{t('allOfCustomer.older', { count: model.olderThreads })}</p>
          ) : null}
          {model.threadsNotShown > 0 && <p className="fw-aoc-note">{t('allOfCustomer.notShown', { count: model.threadsNotShown, customer })}</p>}
        </footer>
      )}
    </div>
  )
}

/** One message of the feed: its chip, its card (read only), its door. */
function FeedLine({ item, model, actions, chip }: { item: FeedItem; model: AllOfCustomerModel; actions: AllOfCustomerFeedActions | undefined; chip: string }) {
  const t = useT('record-thread')
  const answer = actions?.onAnswer
  const openFile = (fileId: string) => (actions?.onOpenFile ? actions.onOpenFile(fileId, item.record, item.key) : answer?.(item.record, item.key))
  return (
    <li className={`fw-aoc-item${item.isNew ? ' is-new' : ''}`}>
      <div className="fw-aoc-chiprow">
        <a
          className="fw-aoc-chip"
          href={item.href}
          title={t('allOfCustomer.openRecord', { record: chip })}
          onClick={(event) => {
            if (!answer || opensItself(event)) return
            event.preventDefault()
            answer(item.record, item.key)
          }}
        >
          <RecordTypeIcon type={item.record.type} size={14} />
          <span>{chip}</span>
        </a>
        {item.isNew && (
          <span className="fw-aoc-new">
            <span className="fw-aoc-dot" aria-hidden />
            {t('allOfCustomer.new')}
          </span>
        )}
      </div>
      <MessageCard message={item.card} context={model.card} readOnly actions={{ onOpenFile: openFile }} />
      <div className="fw-aoc-doors">
        {answer ? (
          <Button size="sm" variant="quiet" aria-label={t('allOfCustomer.answerLabel', { record: chip })} onClick={() => answer(item.record, item.key)}>
            <CornerDownRight size={14} aria-hidden /> {t('allOfCustomer.answer')}
          </Button>
        ) : (
          <a className="nds-btn sm quiet" href={item.messageHref} aria-label={t('allOfCustomer.answerLabel', { record: chip })}>
            <CornerDownRight size={14} aria-hidden /> {t('allOfCustomer.answer')}
          </a>
        )}
      </div>
    </li>
  )
}
