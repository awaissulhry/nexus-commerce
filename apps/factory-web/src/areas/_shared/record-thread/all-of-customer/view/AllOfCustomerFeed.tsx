'use client'

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { CornerDownRight, Lock, Paperclip } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, InfoTip, Skeleton } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayOf } from '../../../../../lib/record-thread/parts/time' // F-OP-205: a line's time
import { MessageCard } from '../../../../../lib/record-thread/card/view/MessageCard'
import { WIDTH_NS } from '../../../../../lib/record-thread/head/view/WidthMenu' // F-OP-204: the Head's words (width, ⋯)
import { RecordTypeIcon } from '../../../../search/RecordTypeIcon'
import { PickedDockColumn } from '../../ThreadPick' // F-OP-204: the dock's one card
import { opensItself, type AllOfCustomerModel, type FeedItem, type FeedKindChoice, type FeedView, type Words } from '../model'
import { lineTimeOf } from '../model' // F-OP-205
import { feedKeyOf, linePlaceOf, rovingIndexOf } from '../keys' // F-OP-206: the list's keys, one tab stop
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
   * "Answer" (its name: "Answer in the thread of <record>"), and a plain click on a line's chip: the host switches the dock to that record's ONE conversation,
   * at that message (B-TH-050's `?message=`). Without it the door is a link to the message on its record's page.
   */
  readonly onAnswer?: (record: FeedRecordRef, messageId: string) => void
  /** A file of a message: the host's viewer. Without it the file is opened in its conversation (onAnswer). */
  readonly onOpenFile?: (fileId: string, record: FeedRecordRef, messageId: string) => void
  /** F-OP-205: the empty feed's door — "Write the first one in <thread>" (the host's own thread, the box on Office note). */
  readonly writeFirst?: { readonly thread: string; readonly onWrite: () => void }
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

/**
 * The card's foot: the host's doors, then ONE info icon (the rule: key hints only in the foot's info icon) — F-OP-206: the list's keys
 * and that seeing a line marks nothing read.
 */
function DockFoot({ children }: { children?: ReactNode }) {
  const t = useT('record-thread')
  return (
    <>
      {children}
      <span className="fw-aoc-foot-tip">
        <InfoTip tip={t('allOfCustomer.keysTip')} />
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
  // F-OP-205: a line opens its whole card in place on the person's act (More, or Space), and closes again; nothing opens by itself.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (key: string) =>
    setOpened((now) => {
      const next = new Set(now)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const filtered = model.view !== 'all' || model.kind !== 'every'
  const today = dayOf(new Date())
  // F-OP-206 (11-dock §3.3, D7): ONE tab stop for the list — the line last focused holds it; J / K and the arrows walk the lines.
  const [active, setActive] = useState(0)
  const lineRefs = useRef<Array<HTMLElement | null>>([])
  const roving = rovingIndexOf(active, model.items.length)
  const moveTo = (index: number) => {
    setActive(index)
    lineRefs.current[index]?.focus()
  }

  // F-OP-205 (11-dock §3.5): every state inside the card — the pick band, the Head and the foot stay; only the body says it.
  return (
    <div className="fw-aoc">
      {model.status === 'loading' || model.status === 'idle' ? (
        <div className="fw-aoc-loading" aria-busy="true" aria-label={t('allOfCustomer.loading', { customer })}>
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} height={64} radius={8} />
          ))}
        </div>
      ) : model.status === 'failed' ? (
        <Banner
          tone="danger"
          title={t('allOfCustomer.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('allOfCustomer.retry')}
            </Button>
          }
        />
      ) : model.status === 'gone' ? (
        <EmptyState className="fw-aoc-empty" icon={<Lock size={20} aria-hidden />} title={t('allOfCustomer.gone')} />
      ) : model.items.length === 0 && filtered ? (
        <EmptyState
          className="fw-aoc-empty"
          title={t('allOfCustomer.empty', { customer })}
          description={t('allOfCustomer.emptyFiltered')}
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                actions?.onView?.('all')
                actions?.onKind?.('every')
              }}
            >
              {t('allOfCustomer.showEverything')}
            </Button>
          }
        />
      ) : model.items.length === 0 ? (
        <EmptyState
          className="fw-aoc-empty"
          title={t('allOfCustomer.empty', { customer })}
          {...(actions?.writeFirst
            ? {
                action: (
                  <Button size="sm" variant="secondary" onClick={actions.writeFirst.onWrite}>
                    {t('allOfCustomer.writeFirst', { thread: actions.writeFirst.thread })}
                  </Button>
                ),
              }
            : {})}
        />
      ) : (
        // F-OP-206: a feed (busy while older lines are read), each line an article with its place in it.
        <div className="fw-aoc-list" role="feed" aria-busy={model.older === 'loading'} aria-label={t('allOfCustomer.feedLabel', { customer })}>
          {model.items.map((item, index) => (
            <FeedLine
              key={item.key}
              item={item}
              model={model}
              actions={actions}
              chip={words(item.chip)}
              open={opened.has(item.key)}
              onToggle={() => toggle(item.key)}
              today={today}
              place={linePlaceOf(index, model.items.length, model.more)}
              current={index === roving}
              lineRef={(element) => {
                lineRefs.current[index] = element
              }}
              onFocusLine={() => setActive(index)}
              onKey={(event) => {
                const act = feedKeyOf(event, index, model.items.length)
                if (!act) return false
                if (act.kind === 'move') moveTo(act.to)
                return act
              }}
            />
          ))}
        </div>
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

/**
 * One message of the feed, as ONE compact line (F-OP-205, 11-dock §3.2): row 1 its record chip (a real link: ⌘-click a new tab; a plain
 * click switches the dock to that conversation), the "New" dot, who reads it and its time; row 2 "author: words" (two lines at most);
 * row 3 at most three file chips and "+N"; the edge in the audience's colour. More opens the conversation's own card READ ONLY in
 * place (aria-expanded), Less closes it; the door answers in its conversation.
 */
function FeedLine({
  item,
  model,
  actions,
  chip,
  open,
  onToggle,
  today,
  place,
  current,
  lineRef,
  onFocusLine,
  onKey,
}: {
  item: FeedItem
  model: AllOfCustomerModel
  actions: AllOfCustomerFeedActions | undefined
  chip: string
  open: boolean
  onToggle: () => void
  today: string
  /** F-OP-206: its place in the feed, whether it holds the list's one tab stop, and the list's keys (a move is the list's own). */
  place: { readonly posinset: number; readonly setsize: number }
  current: boolean
  lineRef: (element: HTMLElement | null) => void
  onFocusLine: () => void
  onKey: (event: KeyboardEvent<HTMLElement>) => ReturnType<typeof feedKeyOf> | false
}) {
  const t = useT('record-thread')
  const tc = useT('record-thread-card')
  const locale = useLocale()
  const answer = actions?.onAnswer
  const openFile = (fileId: string) => (actions?.onOpenFile ? actions.onOpenFile(fileId, item.record, item.key) : answer?.(item.record, item.key))
  const { line, card } = item
  const author = 'text' in line.author ? line.author.text : tc(line.author.key)
  const gist = 'text' in line.gist ? line.gist.text : line.gist.ns === 'record-thread-card' ? tc(line.gist.key) : t(line.gist.key)
  const wholeId = `fw-aoc-whole-${item.key}`
  // F-OP-206: the line is named by its chip, its writer and its time; only the line holding the tab stop lets Tab into its controls.
  const base = `fw-aoc-${item.key}`
  const inner = current ? undefined : -1
  const doorButton = useRef<HTMLButtonElement>(null)
  const doorLink = useRef<HTMLAnchorElement>(null)
  return (
    <article
      ref={lineRef}
      className={`fw-aoc-line is-${line.audience}${item.isNew ? ' is-new' : ''}`}
      tabIndex={current ? 0 : -1}
      aria-posinset={place.posinset}
      aria-setsize={place.setsize}
      aria-labelledby={`${base}-chip ${base}-author ${base}-time`}
      onFocus={onFocusLine}
      onKeyDown={(event) => {
        // Keys on the line itself only: a control inside keeps its own (Enter on a button presses it).
        if (event.target !== event.currentTarget) return
        const act = onKey(event)
        if (!act) return
        event.preventDefault()
        if (act.kind === 'expand') onToggle()
        else if (act.kind === 'answer') (doorButton.current ?? doorLink.current)?.click()
      }}
    >
      <div className="fw-aoc-line-top">
        <a
          className="fw-aoc-chip"
          tabIndex={inner}
          href={item.href}
          title={t('allOfCustomer.openRecord', { record: chip })}
          onClick={(event) => {
            if (!answer || opensItself(event)) return
            event.preventDefault()
            answer(item.record, item.key)
          }}
        >
          <RecordTypeIcon type={item.record.type} size={14} />
          <span id={`${base}-chip`}>{chip}</span>
        </a>
        {item.isNew && (
          <span className="fw-aoc-new">
            <span className="fw-aoc-dot" aria-hidden />
            {t('allOfCustomer.new')}
          </span>
        )}
        <span className="fw-aoc-audience">{line.audience === 'shared' ? t('allOfCustomer.audience.shared', { customer: model.customerName }) : t('allOfCustomer.audience.office')}</span>
        <time id={`${base}-time`} className="fw-aoc-time" dateTime={card.at}>
          {lineTimeOf(card.at, locale, today)}
        </time>
      </div>
      <p className="fw-aoc-gist">
        <span id={`${base}-author`} className="fw-aoc-author">
          {author}:
        </span>{' '}
        {gist}
      </p>
      {(line.files.shown.length > 0 || line.files.more > 0) && (
        <div className="fw-aoc-files">
          {line.files.shown.map((file) => (
            <button key={file.id} type="button" className="fw-aoc-file" tabIndex={inner} title={file.name} onClick={() => openFile(file.id)}>
              <Paperclip size={12} aria-hidden />
              <span>{file.name}</span>
            </button>
          ))}
          {line.files.more > 0 && (
            <span className="fw-aoc-file is-more" aria-label={t('allOfCustomer.moreFiles', { count: line.files.more })}>
              +{line.files.more}
            </span>
          )}
        </div>
      )}
      <div className="fw-aoc-doors">
        <Button size="sm" variant="quiet" tabIndex={inner} aria-expanded={open} aria-controls={wholeId} onClick={onToggle}>
          {t(open ? 'allOfCustomer.less' : 'allOfCustomer.more')}
        </Button>
        {answer ? (
          <Button ref={doorButton} size="sm" variant="quiet" tabIndex={inner} aria-label={t('allOfCustomer.answerLabel', { record: chip })} onClick={() => answer(item.record, item.key)}>
            <CornerDownRight size={14} aria-hidden /> {t('allOfCustomer.answer')}
          </Button>
        ) : (
          <a
            ref={doorLink}
            className="nds-btn sm quiet"
            tabIndex={inner}
            href={item.messageHref}
            aria-label={t('allOfCustomer.answerLabel', { record: chip })}
          >
            <CornerDownRight size={14} aria-hidden /> {t('allOfCustomer.answer')}
          </a>
        )}
      </div>
      <div id={wholeId} className="fw-aoc-whole" hidden={!open}>
        {open && <MessageCard message={card} context={model.card} readOnly actions={{ onOpenFile: openFile }} />}
      </div>
    </article>
  )
}
