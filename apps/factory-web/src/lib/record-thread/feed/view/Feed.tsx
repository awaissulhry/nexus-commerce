'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronDown, Lock, MailOpen, Pin, WifiOff } from 'lucide-react'
// B-TH-255: the pills of what the View hides and of the mail that waits for a person.
import { EyeOff, MailWarning } from 'lucide-react'
import Link from 'next/link'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { rightWords } from '../../../i18n/messages'
import { useLocale, useT } from '../../../i18n/provider'
import type { Translate } from '../../../i18n/messages'
import type { Locale } from '../../../i18n/locales'
import { replyWay, type CardContext, type CardMessage } from '../../card/model'
import { MessageCard, type CardActions } from '../../card/view/MessageCard'
import { dayOf, dayWord, timeOf } from '../../parts/time'
import { arrivedAtEnd, byTime, feedRows, shouldLoadOlder, walkTarget, whoWords, type FeedEvent, type FeedPin, type FeedRow } from '../model'
import { stepsWordsOf, stepVerbKey } from '../model' // F-OP-214: other modules' words, the run of steps
import { hiddenNewLine, waitingMailLine, type FeedWaitingMail } from '../model' // B-TH-255
import '../../parts/parts.css'
import '../feed.css'

export interface FeedModel {
  /** ready: the messages are read; loading: the first read; error: it failed; forbidden: the reader may not read threads. */
  state: 'loading' | 'error' | 'forbidden' | 'ready'
  messages: readonly CardMessage[]
  events: readonly FeedEvent[]
  context: CardContext
  /** Older messages exist (the top of the list reads the next page as the person scrolls up). */
  more: boolean
  /** The older page: reading ("Reading earlier messages…"), or it failed ("Could not load earlier messages · Retry"). */
  older?: 'idle' | 'loading' | 'failed'
  /** No network: the messages until then, and since when. */
  offline?: { since: string } | null
  /** Now, for Today / Yesterday (ISO). */
  now: string
  /** Messages that arrived while the reader was higher up: the round down button's count (design cases set it). */
  newCount?: number
  // ---- B-TH-229: the reader's own reading on arrival (B-TH-027): the band "3 unread messages" above the first new message, the
  // feed opening there; the count rides on the down button while the reader is above them.
  firstNewId?: string | null
  newSince?: number
  // ---- end B-TH-229
  // ---- B-TH-255 (B-TH-079): the messages new to the reader that the Head's View hides (the API's `hiddenNew` for the view; 0 or absent
  // on All), and the mail for this conversation that waits for a person (the office read's `waitingMail`; null: none).
  hiddenNew?: number
  waitingMail?: FeedWaitingMail | null
  // ---- end B-TH-255
  // ---- tw- W1.3 / W1.4 (THE THREAD REBUILD): the row a jump lights up (the container's: `seq` restarts it); the pins with who pinned
  // them ("Alex Demo pinned a message", office only); paper (R18: every message alone, its name, who reads it in words).
  flash?: { readonly id: string; readonly seq: number } | null
  pins?: readonly FeedPin[]
  paper?: boolean
  // ---- end tw- W1.3 / W1.4
}

export interface FeedActions extends CardActions {
  /** The next older page (the top of the list as the person scrolls up), and its Retry. */
  onOlder?: () => void
  /** "Try again" after the thread could not be read. */
  onReload?: () => void
  /** B-TH-229: the newest message that was on screen for a second (the container marks the thread read up to it, T1-F04). */
  onSeen?: (messageId: string) => void
  /** B-TH-255: "Show all" on the pill of what the View hides (the Head's View back to All). */
  onShowAll?: () => void
}

/** The floating day fades this long after scrolling stops (10-design §7). */
const FLOAT_MS = 1200

/**
 * The feed (B-TH-204, T4; tw- W1.3 THE THREAD REBUILD, 10-design §3, §6, §7): a record's messages oldest first in one scrolling
 * column (role feed; each message an article) — bubbles on two sides in runs, no fold: older pages load as the person scrolls up
 * (a pill only while one is read); every row that is not a message is a centred pill (the day, a step, changes, a pin); the day
 * floats at the top while scrolling; the band "3 unread messages" and the thread opens there; the round down button whenever the
 * reader is higher up, with the count of what arrived below (nothing jumps under the pointer); a jump lights the whole row. J / K walk
 * the messages and R answers the focused one while the feed has the focus. Draws its model; the container reads and re-reads.
 */
export function Feed({ model, actions, remind }: { model: FeedModel; actions?: FeedActions; remind?: (messageId: string) => ReactNode }) {
  const t = useT('record-thread-feed')
  const locale = useLocale()
  const [shownChanges, setShownChanges] = useState<ReadonlySet<string>>(new Set())
  const [newCount, setNewCount] = useState(model.newCount ?? 0)
  const [scrolledUp, setScrolledUp] = useState(false)
  const [announce, setAnnounce] = useState('')
  const [floatDay, setFloatDay] = useState<{ text: string; on: boolean } | null>(null)
  // tw- W1.3: a flash that ended (its seq) and the one of a `?message=` arrival — both cleared by the row's own animation end.
  const [flashDone, setFlashDone] = useState<number | null>(null)
  const [arrival, setArrival] = useState<string | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const askedAt = useRef<number | null>(null)
  const frame = useRef<number | null>(null)
  const floatTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // tw- W1.1 (B15): the same order as the rows — time, then id.
  const ids = useMemo(() => [...model.messages].sort(byTime).map((message) => message.id), [model.messages])
  const previousIds = useRef<readonly string[]>(ids)
  const keptFromBottom = useRef<number | null>(null)

  const rows = useMemo(
    () => (model.state === 'ready' ? feedRows({ messages: model.messages, events: model.events, firstNewId: model.firstNewId ?? null, newCount: model.newSince ?? 0, pins: model.pins ?? [], paper: model.paper === true }) : []),
    [model.state, model.messages, model.events, model.firstNewId, model.newSince, model.pins, model.paper],
  )
  const today = dayOf(model.now)

  // The first read: open at the message a link names (in view, focused, its row lit), else at the unread band (B-TH-229, T4-F01),
  // else at the newest message. New messages below the screen wait behind the down button.
  const opened = useRef(false)
  useLayoutEffect(() => {
    const feed = feedRef.current
    if (!feed || opened.current || model.state !== 'ready') return
    opened.current = true
    const anchorId = model.context.anchorId ?? null
    const anchor = anchorId ? feed.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchorId)}"]`) : null
    const line = feed.querySelector<HTMLElement>('[data-feed-new]')
    if (anchor && anchorId) {
      anchor.scrollIntoView({ block: 'center' })
      anchor.focus({ preventScroll: true })
      setArrival(anchorId)
    } else if (line) {
      feed.scrollTop = Math.max(0, feed.scrollTop + line.getBoundingClientRect().top - feed.getBoundingClientRect().top - 8)
    } else feed.scrollTop = feed.scrollHeight
    atBottom.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48
    setScrolledUp(!atBottom.current)
    if (line && !atBottom.current) setNewCount(model.newSince ?? 0)
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

  // tw- W1.3 (D10, W-153): the top of the list reads the next older page ONCE per page as the person reaches it (no "Show 50
  // earlier"); the reader stays where they were.
  const onOlder = actions?.onOlder
  const more = model.more
  const older = model.older ?? 'idle'
  useEffect(() => {
    const feed = feedRef.current
    const top = topRef.current
    if (!feed || !top || model.state !== 'ready' || !onOlder || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        if (!shouldLoadOlder({ more, older, count: ids.length, askedAt: askedAt.current })) return
        askedAt.current = ids.length
        keptFromBottom.current = feed.scrollHeight - feed.scrollTop
        onOlder()
      },
      { root: feed, rootMargin: '240px 0px 0px 0px' },
    )
    observer.observe(top)
    return () => observer.disconnect()
  }, [model.state, onOlder, more, older, ids.length])

  // Live: a page of older messages keeps the reader where they were; new messages at the end follow the reader at the bottom,
  // and otherwise wait behind the down button (its count). A message the reader is sending always shows.
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

  // tw- W1.3 (W-150): the day of the top message floats while scrolling, then fades; never over a day pill that is there itself.
  const placeFloat = useCallback(() => {
    const feed = feedRef.current
    if (!feed) return
    const top = feed.getBoundingClientRect().top
    let text: string | null = null
    for (const item of feed.querySelectorAll<HTMLElement>('[data-day]')) {
      if (item.getBoundingClientRect().bottom > top + 4) {
        text = item.dataset.day ?? null
        break
      }
    }
    const pillThere = [...feed.querySelectorAll<HTMLElement>('.fw-rt-pillrow.is-day')].some((pill) => {
      const box = pill.getBoundingClientRect()
      return box.bottom > top - 4 && box.top < top + 44
    })
    setFloatDay(text && !pillThere && feed.scrollTop > 0 ? { text, on: true } : null)
    if (floatTimer.current) clearTimeout(floatTimer.current)
    floatTimer.current = setTimeout(() => setFloatDay((now) => (now ? { ...now, on: false } : now)), FLOAT_MS)
  }, [])
  useEffect(
    () => () => {
      if (floatTimer.current) clearTimeout(floatTimer.current)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    [],
  )

  const onScroll = useCallback(() => {
    const feed = feedRef.current
    if (!feed) return
    atBottom.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48
    setScrolledUp(!atBottom.current)
    if (atBottom.current) setNewCount(0)
    if (frame.current === null)
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        placeFloat()
      })
  }, [placeFloat])

  const retryOlder = () => {
    const feed = feedRef.current
    if (feed) keptFromBottom.current = feed.scrollHeight - feed.scrollTop
    askedAt.current = ids.length
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
    const target = event.target as HTMLElement
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable || target.closest('[role="menu"]')) return
    const feed = feedRef.current
    if (!feed) return
    // tw- W1.3 (Z6): R answers the FOCUSED message (its own way, `replyWay`); with no message in focus the column's R switches the box.
    if (key === 'r') {
      const id = target.closest<HTMLElement>('[data-message-id]')?.dataset.messageId
      const message = id ? model.messages.find((one) => one.id === id) : undefined
      if (message && actions?.onReply && replyWay(message, model.context) !== null) {
        event.preventDefault()
        event.stopPropagation()
        actions.onReply(message.id)
      }
      return
    }
    if (key !== 'j' && key !== 'k') return
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

  // The flash of a row: the container's jump (until its animation ended), or a `?message=` arrival's.
  const jump = model.flash ?? null
  const flashOf = (id: string): { seq: number; onEnd: () => void } | null => {
    if (jump && jump.id === id && jump.seq !== flashDone) return { seq: jump.seq, onEnd: () => setFlashDone(jump.seq) }
    if (arrival === id) return { seq: 0, onEnd: () => setArrival(null) }
    return null
  }

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
          <>
            <div className="fw-rt-empty">
              <EmptyState icon={<MailOpen size={22} aria-hidden />} title={t('state.empty')} description={t('state.emptyBody')} />
            </div>
            {/* B-TH-255: a view that hides everything, or mail that waits, still says so under the empty state. */}
            <EndLines model={model} actions={actions} t={t} />
          </>
        ) : (
          <>
            <div ref={topRef} className="fw-rt-sentinel" aria-hidden="true" />
            {model.more && model.older === 'loading' && (
              <div className="fw-rt-pillrow" role="status">
                <span className="fw-rt-pill">{t('older.loading')}</span>
              </div>
            )}
            {model.more && model.older === 'failed' && (
              <p className="fw-rt-older-failed" role="alert">
                <span>{t('older.failed')}</span>
                <Button size="sm" onClick={retryOlder}>
                  {t('older.retry')}
                </Button>
              </p>
            )}
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
                paper={model.paper === true}
                flash={row.kind === 'message' ? flashOf(row.message.id) : null}
                showChanges={shownChanges.has(row.key)}
                onToggleChanges={() =>
                  setShownChanges((set) => {
                    const next = new Set(set)
                    if (next.has(row.key)) next.delete(row.key)
                    else next.add(row.key)
                    return next
                  })
                }
              />
            ))}
            {/* B-TH-255: what the View hides and the mail that waits for a person, at the end where new messages arrive. */}
            <EndLines model={model} actions={actions} t={t} />
          </>
        )}
      </div>
      {floatDay && (
        <p className={`fw-rt-float${floatDay.on ? ' is-on' : ''}`} aria-hidden="true">
          <span className="fw-rt-pill is-day">{floatDay.text}</span>
        </p>
      )}
      {(scrolledUp || newCount > 0) && (
        <button type="button" className="fw-rt-down" aria-label={t('down.label')} onClick={toBottom}>
          <ChevronDown size={20} aria-hidden />
          {newCount > 0 && <span className="fw-rt-down-n">{newCount > 999 ? '999+' : newCount}</span>}
        </button>
      )}
      <p className="fw-rt-sr" aria-live="polite">
        {announce}
      </p>
    </div>
  )
}

/** A day's words: Today, Yesterday, the weekday inside 7 days, then the date (parts/time). */
function dayText(day: string, today: string, locale: Locale, t: Translate): string {
  const word = dayWord(day, today, locale)
  return word.kind === 'date' ? word.text : t(`day.${word.kind}`)
}

function Row({
  row,
  t,
  locale,
  today,
  context,
  actions,
  remind,
  paper,
  flash,
  showChanges,
  onToggleChanges,
}: {
  row: FeedRow
  t: Translate
  locale: Locale
  today: string
  context: CardContext
  actions?: FeedActions
  remind?: (messageId: string) => ReactNode
  paper: boolean
  flash: { seq: number; onEnd: () => void } | null
  showChanges: boolean
  onToggleChanges: () => void
}) {
  if (row.kind === 'day') {
    // tw- W1.1 (S12): the day pill says the day; no time-zone tooltip per day.
    const words = dayText(row.day, today, locale, t)
    return (
      <div className="fw-rt-pillrow is-day" data-day={words}>
        <span className="fw-rt-pill is-day">{words}</span>
      </div>
    )
  }
  if (row.kind === 'new') {
    // B-TH-229 / tw- W1.3 (P12): ONE band above the first new message; 200+ says so; its count also rides on the down button.
    const words = row.count > 200 ? t('unread.lineMany') : t('unread.line', { count: row.count })
    return (
      <div className="fw-rt-unread" data-feed-new="" role="separator" aria-label={words}>
        <span className="fw-rt-pill is-unread">{words}</span>
      </div>
    )
  }
  if (row.kind === 'message') {
    return (
      <div className="fw-rt-feed-item" data-day={dayText(dayOf(row.message.at), today, locale, t)}>
        <MessageCard message={row.message} context={context} actions={actions} remind={remind?.(row.message.id)} run={row.run} flash={flash} paper={paper} />
      </div>
    )
  }
  if (row.kind === 'pin') {
    // tw- W1.3 (10-design §7): "Alex Demo pinned a message" — office only (the container hands office pins with who pinned them).
    return (
      <div className="fw-rt-pillrow">
        <p className="fw-rt-pill">
          <Pin size={13} aria-hidden />
          <span>{t('pinned.pill', { who: row.pin.by })}</span>
        </p>
      </div>
    )
  }
  if (row.kind === 'step') {
    const event = row.event
    const who = whoWords(event)
    return (
      // F-SA-265: "Show in the thread" (a history row of the page) finds its step by its id.
      <div className="fw-rt-pillrow">
        <p className="fw-rt-pill fw-rt-event" data-event-ids={event.id} tabIndex={-1}>
          <span>
            {t('step.text', { who: 'text' in who ? who.text : t(who.key), verb: t(stepVerbKey(event)) /* F-OP-214 */ })}
            {event.status && (event.status.from || event.status.to) ? ` · ${t('step.status', { from: event.status.from ?? '—', to: event.status.to ?? '—' })}` : ''}
          </span>
          <time dateTime={event.at}>{timeOf(event.at, locale)}</time>
        </p>
      </div>
    )
  }
  // ---- F-OP-214 (11-dock §6.1): a run of steps of the same actor within an hour — one pill, "5 steps by Nexus Factory · Show"; Show
  // lists each step in place (its words and time). A status step is never in a run.
  if (row.kind === 'steps') {
    const first = row.events[0]!
    const who = whoWords(first)
    const words = stepsWordsOf(row.events)
    const listId = `steps-${first.id}`
    const last = row.events[row.events.length - 1]!
    return (
      <div className="fw-rt-pillrow">
        <div className={`fw-rt-pill fw-rt-event${showChanges ? ' is-open' : ''}`} data-event-ids={row.events.map((event) => event.id).join(' ')} tabIndex={-1}>
          <p className="fw-rt-pill-line">
            <span>
              {t(words.key, { count: words.count, who: 'text' in who ? who.text : t(who.key) })}
              {' · '}
              <Button size="sm" variant="link" aria-expanded={showChanges} aria-controls={listId} onClick={onToggleChanges}>
                {t(showChanges ? 'changes.hide' : 'changes.show')}
              </Button>
            </span>
            <time dateTime={last.at}>{timeOf(last.at, locale)}</time>
          </p>
          <ul id={listId} className="fw-rt-changes" hidden={!showChanges}>
            {row.events.map((event) => (
              <li key={event.id}>
                {t(stepVerbKey(event))} · {timeOf(event.at, locale)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    )
  }
  // ---- end F-OP-214
  const first = row.events[0]
  const who = whoWords(first)
  const lines = row.events.flatMap((event) => (event.values.length > 0 ? event.values.map((value) => `${value.field}: ${value.before} → ${value.after}`) : event.fields.length > 0 ? [t('changes.fields', { fields: event.fields.join(', ') })] : []))
  const count = row.events.reduce((sum, event) => sum + Math.max(1, event.values.length || event.fields.length), 0)
  const listId = `changes-${first.id}`
  return (
    <div className="fw-rt-pillrow">
      {/* F-SA-265: "Show in the thread" finds a grouped change by any of its steps' ids. */}
      <div className={`fw-rt-pill fw-rt-event${showChanges ? ' is-open' : ''}`} data-event-ids={row.events.map((event) => event.id).join(' ')} tabIndex={-1}>
        <p className="fw-rt-pill-line">
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
      </div>
    </div>
  )
}

// ── B-TH-255 (B-TH-079; T1-F05, T4-F10) ─────────────────────────────────────────────────────────────────────────────

/**
 * The quiet pills at the end of the feed: "1 new message hidden by this view · Show all" while the Head's View hides news (T1-F05),
 * then the mail for this conversation that waits for a person (T4-F10) — for a reader with email.triage how many, why and Review
 * (Home › Mail to sort); for anyone else "A reply waits for a colleague to check it", never the sender or why (W07, W08, W22, W34).
 */
function EndLines({ model, actions, t }: { model: FeedModel; actions?: FeedActions; t: Translate }) {
  const hidden = hiddenNewLine(model.hiddenNew)
  const waiting = waitingMailLine(model.waitingMail)
  if (!hidden && !waiting) return null
  return (
    <>
      {hidden && (
        <div className="fw-rt-pillrow">
          <p className="fw-rt-pill fw-rt-endline is-hidden-new" role="status">
            <EyeOff size={13} aria-hidden />
            <span>{t('hidden.line', { count: hidden.count })}</span>
            {actions?.onShowAll && (
              <>
                <span aria-hidden>·</span>
                <Button size="sm" variant="link" onClick={actions.onShowAll}>
                  {t('hidden.showAll')}
                </Button>
              </>
            )}
          </p>
        </div>
      )}
      {waiting && (
        <div className="fw-rt-pillrow">
          <p className="fw-rt-pill fw-rt-endline is-waiting" role="note">
            <MailWarning size={13} aria-hidden />
            <span>{waiting.reasons.length > 0 ? t(`${waiting.key}Why`, { count: waiting.count, why: waiting.reasons.map((key) => t(key)).join(', ') }) : t(waiting.key, { count: waiting.count })}</span>
            {waiting.href && (
              <>
                <span aria-hidden>·</span>
                <Link className="fw-rt-endline-link" href={waiting.href}>
                  {t('waiting.open')}
                </Link>
              </>
            )}
          </p>
        </div>
      )}
    </>
  )
}
