'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowDown, ChevronsUpDown, History, Lock, MailOpen, Mail, Tablet, WifiOff } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { rightWords } from '../../../i18n/messages'
import { useLocale, useT } from '../../../i18n/provider'
import type { Translate } from '../../../i18n/messages'
import type { Locale } from '../../../i18n/locales'
import { authorWords, type CardContext, type CardMessage } from '../../card/model'
import { MessageCard, type CardActions } from '../../card/view/MessageCard'
import { dayOf, dayWord, shortDateOf, timeOf } from '../../parts/time'
import { arrivedAtEnd, feedRows, gistOf, PAGE_SIZE, verbKey, walkTarget, whoWords, type FeedEvent, type FeedRow } from '../model'
import '../../parts/parts.css'
import '../feed.css'

export interface FeedModel {
  /** ready: the messages are read; loading: the first read; error: it failed; forbidden: the reader may not read threads. */
  state: 'loading' | 'error' | 'forbidden' | 'ready'
  messages: readonly CardMessage[]
  events: readonly FeedEvent[]
  context: CardContext
  /** Older messages exist ("Show 50 earlier"). */
  more: boolean
  /** The older page: reading, or it failed ("Could not load earlier messages · Retry"). */
  older?: 'idle' | 'loading' | 'failed'
  /** No network: the messages until then, and since when. */
  offline?: { since: string } | null
  /** Now, for Today / Yesterday (ISO). */
  now: string
  /** Design cases: "12 earlier messages" already open; messages opened in place; the "2 new messages" bar. */
  runOpen?: boolean
  openIds?: readonly string[]
  newCount?: number
  // ---- B-TH-229: the reader's own reading on arrival (B-TH-027): the line "New since your last visit" above the first new
  // message, the read ones folded, the feed opening there; the count is the Head's "2 new".
  firstNewId?: string | null
  newSince?: number
  // ---- end B-TH-229
}

export interface FeedActions extends CardActions {
  /** "Show 50 earlier" and its Retry. */
  onOlder?: () => void
  /** "Try again" after the thread could not be read. */
  onReload?: () => void
  /** B-TH-229: the newest message that was on screen for a second (the container marks the thread read up to it, T1-F04). */
  onSeen?: (messageId: string) => void
}

/**
 * The feed (B-TH-204, T4; picture 1): a record's messages oldest first in one scrolling column (role feed; each message an
 * article), day lines, older messages folded by age, quiet record steps and grouped field changes, the "N new messages" bar when
 * the reader is higher up (nothing jumps under the pointer), and every state in words. J / K walk the messages while the feed has
 * the focus. Draws its model; the container reads and re-reads.
 */
export function Feed({ model, actions, remind }: { model: FeedModel; actions?: FeedActions; remind?: (messageId: string) => ReactNode }) {
  const t = useT('record-thread-feed')
  const locale = useLocale()
  const [openIds, setOpenIds] = useState<readonly string[]>(model.openIds ?? [])
  const [runOpen, setRunOpen] = useState(model.runOpen ?? false)
  const [shownChanges, setShownChanges] = useState<ReadonlySet<string>>(new Set())
  const [newCount, setNewCount] = useState(model.newCount ?? 0)
  const [announce, setAnnounce] = useState('')
  const feedRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const ids = useMemo(() => [...model.messages].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map((message) => message.id), [model.messages])
  const previousIds = useRef<readonly string[]>(ids)
  const keptFromBottom = useRef<number | null>(null)

  const rows = useMemo(
    () => (model.state === 'ready' ? feedRows({ messages: model.messages, events: model.events, openIds, anchorId: model.context.anchorId ?? null, runOpen, firstNewId: model.firstNewId ?? null, newCount: model.newSince ?? 0 }) : []),
    [model.state, model.messages, model.events, openIds, model.context.anchorId, runOpen, model.firstNewId, model.newSince],
  )
  const today = dayOf(model.now)

  // The first read: open at the message a link names (unfolded and focused), else at the line "New since your last visit"
  // (B-TH-229, T4-F01), else at the newest message. New messages below the screen wait behind the bar.
  const opened = useRef(false)
  useLayoutEffect(() => {
    const feed = feedRef.current
    if (!feed || opened.current || model.state !== 'ready') return
    opened.current = true
    const anchor = model.context.anchorId ? feed.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(model.context.anchorId)}"]`) : null
    const line = feed.querySelector<HTMLElement>('[data-feed-new]')
    if (anchor) {
      anchor.scrollIntoView({ block: 'center' })
      anchor.focus({ preventScroll: true })
    } else if (line) {
      feed.scrollTop = Math.max(0, feed.scrollTop + line.getBoundingClientRect().top - feed.getBoundingClientRect().top - 8)
      atBottom.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48
      if (!atBottom.current) setNewCount(model.newSince ?? 0)
    } else feed.scrollTop = feed.scrollHeight
  }, [model.state, model.context.anchorId, model.newSince, rows])

  // B-TH-229 (T1-F04): what the person has seen — the newest message on screen for a second while the page is in view — goes to
  // the container, which marks the thread read up to it (forward only, once). Never a "seen by" list: the mark is the reader's own.
  const onSeen = actions?.onSeen
  useEffect(() => {
    const feed = feedRef.current
    if (!feed || model.state !== 'ready' || !onSeen || typeof IntersectionObserver === 'undefined') return
    const visible = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      timer = null
      if (document.visibilityState !== 'visible') return
      let best = -1
      for (const id of visible) best = Math.max(best, ids.indexOf(id))
      if (best >= 0) onSeen(ids[best])
    }
    const later = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, 1_000)
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.messageId
          if (!id) continue
          const tall = entry.rootBounds ? entry.intersectionRect.height >= entry.rootBounds.height * 0.6 : false
          if (entry.isIntersecting && (entry.intersectionRatio >= 0.6 || tall)) visible.add(id)
          else visible.delete(id)
        }
        later()
      },
      { root: feed, threshold: [0, 0.6, 1] },
    )
    for (const element of feed.querySelectorAll<HTMLElement>('[data-message-id]')) observer.observe(element)
    const onVisible = () => document.visibilityState === 'visible' && later()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisible)
      if (timer) clearTimeout(timer)
    }
  }, [model.state, rows, ids, onSeen])

  // Live: a page of older messages keeps the reader where they were; new messages at the end follow the reader at the bottom,
  // and otherwise wait behind the bar. A message the reader is sending always shows.
  useLayoutEffect(() => {
    const feed = feedRef.current
    const before = previousIds.current
    previousIds.current = ids
    if (!feed || before === ids) return
    if (keptFromBottom.current !== null) {
      feed.scrollTop = feed.scrollHeight - keptFromBottom.current
      keptFromBottom.current = null
      return
    }
    const arrived = arrivedAtEnd(before, ids)
    if (arrived === 0) return
    const mine = model.messages.some((message) => message.outbox && !before.includes(message.id))
    if (atBottom.current || mine) {
      feed.scrollTop = feed.scrollHeight
    } else {
      setNewCount((count) => count + arrived)
    }
    setAnnounce(t('live.arrived', { count: arrived }))
  }, [ids, model.messages, t])

  const onScroll = useCallback(() => {
    const feed = feedRef.current
    if (!feed) return
    atBottom.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48
    if (atBottom.current) setNewCount(0)
  }, [])

  const older = () => {
    const feed = feedRef.current
    if (feed) keptFromBottom.current = feed.scrollHeight - feed.scrollTop
    actions?.onOlder?.()
  }

  const toBottom = () => {
    const feed = feedRef.current
    if (feed) feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' })
    setNewCount(0)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const key = event.key.toLowerCase()
    if (key !== 'j' && key !== 'k') return
    const target = event.target as HTMLElement
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) return
    const feed = feedRef.current
    if (!feed) return
    const items = [...feed.querySelectorAll<HTMLElement>('[data-feed-item]')]
    const current = target.closest<HTMLElement>('[data-feed-item]')
    const next = walkTarget(
      items.map((item) => item.dataset.feedItem ?? ''),
      current?.dataset.feedItem ?? null,
      key,
    )
    const element = items.find((item) => item.dataset.feedItem === next)
    if (element) {
      event.preventDefault()
      element.focus()
      element.scrollIntoView({ block: 'nearest' })
    }
  }

  useEffect(() => setNewCount(model.newCount ?? 0), [model.newCount])

  if (model.state === 'loading') {
    return (
      <div className="fw-rt-feedwrap">
        <div className="fw-rt-state" aria-busy="true">
          <p className="fw-rt-sr" role="status">
            {t('state.loading')}
          </p>
          {[0, 1, 2].map((index) => (
            <div key={index} className="fw-rt-skel-card" aria-hidden="true">
              <span className="fw-rt-skel-row">
                <Skeleton width={24} height={24} radius="50%" />
                <Skeleton width={index === 1 ? 140 : 110} height={12} />
              </span>
              <Skeleton height={10} />
              <Skeleton width="70%" height={10} />
            </div>
          ))}
        </div>
      </div>
    )
  }
  if (model.state === 'error') {
    return (
      <div className="fw-rt-feedwrap">
        <div className="fw-rt-state is-center">
          <Banner tone="danger" title={t('state.error')} action={actions?.onReload ? <Button size="sm" onClick={actions.onReload}>{t('state.tryAgain')}</Button> : undefined}>
            {t('state.errorBody')}
          </Banner>
        </div>
      </div>
    )
  }
  if (model.state === 'forbidden') {
    return (
      <div className="fw-rt-feedwrap">
        <div className="fw-rt-state is-center">
          <EmptyState icon={<Lock size={22} aria-hidden />} title={t('state.forbidden')} description={t('state.forbiddenBody', { right: rightWords(locale, 'threads.read') })} />
        </div>
      </div>
    )
  }

  return (
    <div className="fw-rt-feedwrap">
      {model.offline && (
        <Banner tone="warning" className="fw-rt-offline" icon={<WifiOff size={16} aria-hidden />} title={t('state.offline', { time: timeOf(model.offline.since, locale) })}>
          {t('state.offlineBody')}
        </Banner>
      )}
      <div ref={feedRef} className="fw-rt-feed" role="feed" tabIndex={0} aria-label={t('feed.label')} aria-busy={model.older === 'loading'} onScroll={onScroll} onKeyDown={onKeyDown}>
        {model.messages.length === 0 && model.events.length === 0 ? (
          <EmptyState icon={<MailOpen size={22} aria-hidden />} title={t('state.empty')} description={t('state.emptyBody')} />
        ) : (
          <>
            {model.more &&
              (model.older === 'failed' ? (
                <p className="fw-rt-older-failed" role="alert">
                  <span>{t('older.failed')}</span>
                  <Button size="sm" onClick={older}>
                    {t('older.retry')}
                  </Button>
                </p>
              ) : (
                <div className="fw-rt-older">
                  <Button size="sm" variant="quiet" onClick={older} heldReason={model.older === 'loading' ? t('older.loading') : null}>
                    {t('older.show', { count: PAGE_SIZE })}
                  </Button>
                </div>
              ))}
            {rows.map((row) => (
              <Row
                key={row.key}
                row={row}
                t={t}
                locale={locale}
                today={today}
                context={model.context}
                actions={actions}
                remind={remind}
                showChanges={shownChanges.has(row.key)}
                onToggleChanges={() =>
                  setShownChanges((set) => {
                    const next = new Set(set)
                    if (next.has(row.key)) next.delete(row.key)
                    else next.add(row.key)
                    return next
                  })
                }
                onOpenRun={() => setRunOpen(true)}
                onOpenMessage={(id) => setOpenIds((list) => [...list, id])}
              />
            ))}
          </>
        )}
      </div>
      {newCount > 0 && (
        <Button size="sm" variant="primary" className="fw-rt-newbar" onClick={toBottom}>
          {t('live.bar', { count: newCount })} <ArrowDown size={14} aria-hidden />
        </Button>
      )}
      <p className="fw-rt-sr" aria-live="polite">
        {announce}
      </p>
    </div>
  )
}

function Row({
  row,
  t,
  locale,
  today,
  context,
  actions,
  remind,
  showChanges,
  onToggleChanges,
  onOpenRun,
  onOpenMessage,
}: {
  row: FeedRow
  t: Translate
  locale: Locale
  today: string
  context: CardContext
  actions?: FeedActions
  remind?: (messageId: string) => ReactNode
  showChanges: boolean
  onToggleChanges: () => void
  onOpenRun: () => void
  onOpenMessage: (id: string) => void
}) {
  const card = useT('record-thread-card')
  if (row.kind === 'day') {
    const word = dayWord(row.day, today, locale)
    return (
      <p className="fw-rt-day" title={t('day.zone')}>
        <span>{word.kind === 'date' ? word.text : t(`day.${word.kind}`)}</span>
      </p>
    )
  }
  if (row.kind === 'new') {
    // B-TH-229 (T4-F04): one line above the first new message; 200+ new says so.
    return (
      <p className="fw-rt-newline" data-feed-new="" role="separator" aria-label={t('unread.line', { count: row.count })}>
        <span>{row.count > 200 ? t('unread.lineMany') : t('unread.line', { count: row.count })}</span>
      </p>
    )
  }
  if (row.kind === 'fold') {
    return (
      <button type="button" className="fw-rt-fold" data-feed-item="fold" onClick={onOpenRun} aria-label={t('fold.label', { count: row.count })}>
        <ChevronsUpDown size={14} aria-hidden />
        <span>{t('fold.count', { count: row.count })}</span>
        <span className="fw-rt-fold-range">{t('fold.range', { from: shortDateOf(row.from, locale, today), to: shortDateOf(row.to, locale, today) })}</span>
        <span className="fw-rt-fold-act">{t('fold.show')}</span>
      </button>
    )
  }
  if (row.kind === 'folded') {
    const message = row.message
    const who = authorWords(message)
    const author = 'text' in who ? who.text : card(who.key)
    const Icon = message.kind === 'note' || message.kind === 'floor' ? (message.kind === 'floor' ? Tablet : Lock) : Mail
    return (
      <button
        type="button"
        className={`fw-rt-line is-${message.kind}`}
        data-feed-item={message.id}
        data-message-id={message.id}
        onClick={() => onOpenMessage(message.id)}
        aria-label={t('folded.label', { author, time: timeOf(message.at, locale) })}
      >
        <Icon size={13} aria-hidden />
        <span className="fw-rt-line-who">{author}</span>
        <span className="fw-rt-line-gist">{gistOf(message.body)}</span>
        <time dateTime={message.at}>{timeOf(message.at, locale)}</time>
      </button>
    )
  }
  if (row.kind === 'message') {
    return (
      <div className="fw-rt-feed-item" data-feed-wrap={row.message.id}>
        <MessageCard message={row.message} context={context} actions={actions} remind={remind?.(row.message.id)} />
      </div>
    )
  }
  if (row.kind === 'step') {
    const event = row.event
    const who = whoWords(event)
    return (
      <p className="fw-rt-event">
        <History size={14} aria-hidden />
        <span>
          {t('step.text', { who: 'text' in who ? who.text : t(who.key), verb: t(verbKey(event.verb)) })}
          {event.status && (event.status.from || event.status.to) ? ` · ${t('step.status', { from: event.status.from ?? '—', to: event.status.to ?? '—' })}` : ''}
        </span>
        <time dateTime={event.at}>{timeOf(event.at, locale)}</time>
      </p>
    )
  }
  const first = row.events[0]
  const who = whoWords(first)
  const lines = row.events.flatMap((event) => (event.values.length > 0 ? event.values.map((value) => `${value.field}: ${value.before} → ${value.after}`) : event.fields.length > 0 ? [t('changes.fields', { fields: event.fields.join(', ') })] : []))
  const count = row.events.reduce((sum, event) => sum + Math.max(1, event.values.length || event.fields.length), 0)
  const listId = `changes-${first.id}`
  return (
    <>
      <p className="fw-rt-event">
        <History size={14} aria-hidden />
        <span>
          {t('changes.text', { count, who: 'text' in who ? who.text : t(who.key) })}
          {lines.length > 0 && (
            <>
              {' · '}
              <Button size="sm" variant="link" aria-expanded={showChanges} aria-controls={listId} onClick={onToggleChanges}>
                {t(showChanges ? 'changes.hide' : 'changes.show')}
              </Button>
            </>
          )}
        </span>
        <time dateTime={row.events[row.events.length - 1].at}>{timeOf(row.events[row.events.length - 1].at, locale)}</time>
      </p>
      {lines.length > 0 && (
        <ul id={listId} className="fw-rt-changes" hidden={!showChanges}>
          {lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
    </>
  )
}
