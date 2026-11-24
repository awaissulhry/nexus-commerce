'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, InfoTip, Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { MessageCard } from '../../../../../lib/record-thread/card/view/MessageCard'
import { copyTextOf } from '../../../../../lib/record-thread/card/model' // tw- W2.5: Copy text
import { shouldLoadOlder } from '../../../../../lib/record-thread/feed/model' // tw- T.0: the record thread's own rule
import { tonesFor } from '../../../../../lib/record-thread/parts/tones' // tw- fx2 (G-7)
import { HEAD_NS } from '../../../../../lib/record-thread/head/view/RecordThreadHead' // F-OP-204: the Head's words (width, ⋮)
import { RecordTypeIcon } from '../../../../search/RecordTypeIcon'
import { PickedDockColumn } from '../../ThreadPick' // F-OP-204: the dock's one card
import { opensItself, type AllOfCustomerModel, type FeedKindChoice, type FeedView, type Words } from '../model'
import { answerOf, type FeedDoor } from '../model' // F-OP-207
import { feedRowsOf } from '../model' // tw- W2.5: oldest at the top, a run ends where the record changes
import { feedKeyOf, linePlaceOf, rovingIndexOf } from '../keys' // F-OP-206: the list's keys, one tab stop
import { FeedHead } from './FeedHead' // F-OP-204
import '../../../../../lib/record-thread/feed/feed.css' // tw- T.0: the thread's sentinel, its older pill and Retry
import '../all-of-customer.css'

/** The catalogues the view reads (the host loads them: WithMessages). F-OP-204: + the Head's (FeedHead's width menu and ⋯). */
export const ALL_OF_CUSTOMER_NS = ['record-thread', 'record-thread-card', HEAD_NS, /* tw- fx2 (G-8): the ONE unread band */ 'record-thread-feed'] as const

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
  // ---- F-OP-207: Answer in place — the threads the dock can write in, and the frame's compose ask (absent: the door as before).
  readonly canAnswer?: (record: FeedRecordRef) => boolean
  readonly onCompose?: (ask: Extract<FeedDoor, { kind: 'answer' }>['ask']) => void
  // ---- end F-OP-207
  /** F-OP-208: where the person scrolled the list (the container keeps it for the next visit). */
  readonly onScroll?: (top: number) => void
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
      {/* tw- W2.5 (10-design §10): with no door of the host's, the foot is ONE line — read only, and how to write. */}
      {children ?? <span className="fw-aoc-readonly">{t('allOfCustomer.readOnly')}</span>}
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
/*
 * tw- W2.5 (THE THREAD REBUILD; 10-design §9, S1 "one face"): the SAME bubbles as a thread, read only — oldest at the top, the newest
 * at the bottom (the list opens there), Show older at the top; a record chip on top of the first bubble of each record's run (a run
 * ends where the record changes, and by the thread's own rule: the sender, who reads it, the day); each bubble's menu: Answer in its
 * thread · Copy text · Copy link. The compact lines (`fw-aoc-line`) went.
 */
export function AllOfCustomerFeed({ model, actions }: { model: AllOfCustomerModel; actions?: AllOfCustomerFeedActions | undefined }) {
  const t = useT('record-thread')
  const customer = model.customerName
  const words = (text: Words) => t(text.key, text.params)
  const filtered = model.view !== 'all' || model.kind !== 'every'
  const rows = useMemo(() => feedRowsOf(model.items), [model.items])
  // tw- fx2 (walk G-7): one colour per person inside this list.
  const listModel = useMemo(() => ({ ...model, card: { ...model.card, tones: tonesFor(model.items.map((item) => item.card.senderKey)) } }), [model])
  // tw- fx2 (walk G-8): the reader's new messages are said ONCE — the feed's own band above the first of them.
  const feedWords = useT('record-thread-feed')
  const firstNew = rows.findIndex((row) => row.item.isNew)
  const newCount = rows.filter((row) => row.item.isNew).length
  const unreadWords = newCount > 200 ? feedWords('unread.lineMany') : feedWords('unread.line', { count: newCount })
  // F-OP-206 (11-dock §3.3, D7): ONE tab stop for the list — the line last focused holds it; J / K and the arrows walk the lines.
  const [active, setActive] = useState(-1) // -1: the newest (the list opens at the bottom)
  const lineRefs = useRef<Array<HTMLElement | null>>([])
  const roving = rovingIndexOf(active < 0 ? rows.length - 1 : active, rows.length)
  const moveTo = (index: number) => {
    setActive(index)
    lineRefs.current[index]?.focus()
  }
  // F-OP-208 (11-dock §3.6): a revisit draws the list where it was scrolled (the card's body scrolls, never the page); the person's
  // scrolling is kept for the next visit.
  const root = useRef<HTMLDivElement>(null)
  const keepScroll = useRef(actions?.onScroll)
  keepScroll.current = actions?.onScroll
  const scrolledTo = model.scrollTop
  useLayoutEffect(() => {
    const scroller = root.current?.closest<HTMLElement>('.fw-rt-scroll')
    if (!scroller) return
    // tw- W2.5: the first visit opens at the newest (the bottom); a revisit where the person was.
    scroller.scrollTop = scrolledTo > 0 ? scrolledTo : scroller.scrollHeight
    const onScroll = () => keepScroll.current?.(scroller.scrollTop)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- once per visit
  // tw- T.0 (one behaviour per act): the top of the list reads the next older page ONCE per page as the person reaches it — the record
  // thread's own sentinel and rule (`shouldLoadOlder`, 240 px ahead); no button.
  const topRef = useRef<HTMLDivElement>(null)
  const askedAt = useRef<number | null>(null)
  const onOlder = actions?.onOlder
  const olderState = model.older
  const count = model.items.length
  useEffect(() => {
    const top = topRef.current
    const scroller = root.current?.closest<HTMLElement>('.fw-rt-scroll') ?? null
    if (!top || model.status !== 'ready' || !onOlder || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        if (!shouldLoadOlder({ more: model.more, older: olderState, count, askedAt: askedAt.current })) return
        askedAt.current = count
        onOlder()
      },
      { root: scroller, rootMargin: '240px 0px 0px 0px' },
    )
    observer.observe(top)
    return () => observer.disconnect()
  }, [model.status, model.more, olderState, count, onOlder])
  // tw- W2.5: older messages come in at the TOP — the person keeps what they were reading (the list keeps its distance from the bottom).
  const oldest = rows[0]?.item.key ?? null
  const kept = useRef<{ oldest: string | null; fromBottom: number }>({ oldest, fromBottom: 0 })
  useLayoutEffect(() => {
    const scroller = root.current?.closest<HTMLElement>('.fw-rt-scroll')
    // The first messages read after the skeleton: at the newest too (unless the person's own place was kept).
    if (scroller && kept.current.oldest === null && oldest !== null && scrolledTo === 0) scroller.scrollTop = scroller.scrollHeight
    else if (scroller && kept.current.oldest !== null && oldest !== kept.current.oldest) scroller.scrollTop = scroller.scrollHeight - kept.current.fromBottom
    kept.current = { oldest, fromBottom: scroller ? scroller.scrollHeight - scroller.scrollTop : 0 }
  })

  // F-OP-205 (11-dock §3.5): every state inside the card — the pick band, the Head and the foot stay; only the body says it.
  return (
    <div ref={root} className="fw-aoc">
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
        // F-OP-206: a feed (busy while older messages are read), each message an article with its place in it. tw- T.0: older messages
        // come ON SCROLL — the same top sentinel as the record thread (one behaviour per act); Retry only on a failed page.
        <div className="fw-aoc-list" role="feed" aria-busy={model.older === 'loading'} aria-label={t('allOfCustomer.feedLabel', { customer })}>
          <div ref={topRef} className="fw-rt-sentinel" aria-hidden="true" />
          {model.more && model.older === 'loading' && (
            <div className="fw-rt-pillrow" role="status">
              <span className="fw-rt-pill">{t('allOfCustomer.olderLoading')}</span>
            </div>
          )}
          {model.more && model.older === 'failed' && (
            <p className="fw-rt-older-failed" role="alert">
              <Button size="sm" onClick={() => actions?.onOlder?.()}>
                {t('allOfCustomer.olderFailed')}
              </Button>
            </p>
          )}
          {rows.flatMap((row, index) => [
            // tw- fx2 (walk G-8): ONE "N unread messages" band above the first new message — no "• New" on each message. One flat
            // keyed list, so an older page loaded on top keeps every bubble (no remount).
            ...(index === firstNew
              ? [
                  <div key="unread" className="fw-rt-unread" data-feed-new="" role="separator" aria-label={unreadWords}>
                    <span className="fw-rt-pill is-unread">{unreadWords}</span>
                  </div>,
                ]
              : []),
            <FeedBubble
              key={row.item.key}
              row={row}
              model={listModel}
              actions={actions}
              chip={words(row.item.chip)}
              place={linePlaceOf(index, rows.length, model.more)}
              current={index === roving}
              lineRef={(element) => {
                lineRefs.current[index] = element
              }}
              onFocusLine={() => setActive(index)}
              onKey={(event) => {
                const act = feedKeyOf(event, index, rows.length)
                if (!act) return false
                if (act.kind === 'move') moveTo(act.to)
                return act
              }}
            />,
          ])}
        </div>
      )}

      {model.status === 'ready' && (
        <footer className="fw-aoc-foot">
          {!model.more && model.olderThreads > 0 ? (
            <p className="fw-aoc-note">{t('allOfCustomer.older', { count: model.olderThreads })}</p>
          ) : null}
          {model.threadsNotShown > 0 && <p className="fw-aoc-note">{t('allOfCustomer.notShown', { count: model.threadsNotShown, customer })}</p>}
        </footer>
      )}
    </div>
  )
}

/**
 * tw- W2.5 — one message of the feed as the thread's own bubble, READ ONLY (MessageCard `readOnly`: its words, files, foot — no
 * Reply, no Pin), with the record chip on top of its record's run (a real link: ⌘-click a new tab; a plain click switches the dock to
 * that thread) and "New" when it is new to the reader. Its menu: Answer in its thread (the frame's compose ask, else the dock's switch,
 * else its record's page at the message) · Copy text · Copy link. Enter on it answers; a record no longer there has no door.
 */
function FeedBubble({
  row,
  model,
  actions,
  chip,
  place,
  current,
  lineRef,
  onFocusLine,
  onKey,
}: {
  row: ReturnType<typeof feedRowsOf>[number]
  model: AllOfCustomerModel
  actions: AllOfCustomerFeedActions | undefined
  chip: string
  /** F-OP-206: its place in the feed, whether it holds the list's one tab stop, and the list's keys (a move is the list's own). */
  place: { readonly posinset: number; readonly setsize: number }
  current: boolean
  lineRef: (element: HTMLElement | null) => void
  onFocusLine: () => void
  onKey: (event: KeyboardEvent<HTMLElement>) => ReturnType<typeof feedKeyOf> | false
}) {
  const t = useT('record-thread')
  const { item } = row
  const answer = actions?.onAnswer
  const door: FeedDoor | null = actions?.canAnswer && actions.onCompose ? answerOf(item, actions.canAnswer) : null // F-OP-207
  const openFile = (fileId: string) => (actions?.onOpenFile ? actions.onOpenFile(fileId, item.record, item.key) : answer?.(item.record, item.key))
  const base = `fw-aoc-${item.key}`
  const inner = current ? undefined : -1
  // Answer in its thread: the frame's compose ask (F-OP-207), else the dock's switch at the message, else the message on its page.
  const answerThere = item.gone
    ? undefined
    : () => {
        if (door?.kind === 'answer') actions?.onCompose?.(door.ask)
        else if (door?.kind === 'open') window.location.assign(door.href)
        else if (answer) answer(item.record, item.key)
        else window.location.assign(item.messageHref)
      }
  const copy = (words: string | null) => {
    if (words !== null) void navigator.clipboard?.writeText(words).catch(() => undefined)
  }
  return (
    <article
      ref={lineRef}
      className={`fw-aoc-item${row.recordStart ? ' is-recstart' : ''}`}
      tabIndex={current ? 0 : -1}
      aria-posinset={place.posinset}
      aria-setsize={place.setsize}
      aria-labelledby={`${base}-chip message-${item.key}`}
      onFocus={onFocusLine}
      onKeyDown={(event) => {
        // Keys on the message itself only: a control inside keeps its own (Enter on a button presses it).
        if (event.target !== event.currentTarget) return
        const act = onKey(event)
        if (!act) return
        event.preventDefault()
        // tw- fx2 (walk G-12): the list's keys are the list's — a host's own J / K (a sheet beside it) never gets them too.
        event.stopPropagation()
        if (act.kind === 'answer') answerThere?.()
      }}
    >
      {row.recordStart ? (
        <p className="fw-aoc-recrow">
          {item.gone ? (
            // F-OP-305 (walk #13): the true words, no link — the record is no longer there.
            <span className="fw-aoc-chip is-gone">
              <RecordTypeIcon type={item.record.type} size={14} />
              <span id={`${base}-chip`}>{chip}</span>
            </span>
          ) : (
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
          )}
        </p>
      ) : (
        <span id={`${base}-chip`} className="nds-vh">
          {chip}
        </span>
      )}
      <MessageCard
        message={item.card}
        context={model.card}
        run={row.place}
        readOnly
        actions={{
          onOpenFile: openFile,
          ...(answerThere ? { onAnswerThere: () => answerThere() } : {}),
          onCopyText: () => copy(copyTextOf(item.card)),
          onCopyLink: () => copy(`${window.location.origin}${item.messageHref}`),
        }}
      />
    </article>
  )
}
