'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { useT } from '../../i18n/provider'
import { centreInList, revealInList } from '../parts/scroll' // tw- fx2 (G-1, G-3)
import { arrivedAtEnd, byTime, shouldLoadOlder, walkTarget } from './model'

/**
 * pt-w1 W1.3 (lane pt-, S4; ONE SHARED THREAD): the list's behaviour both doors run — moved out of the office Feed as it was (tw- W1.3,
 * THE THREAD REBUILD, 10-design §6, §7; tw- fx2 G-1, G-3, G-12): it opens at the message a link names, else at the unread band, else at
 * the newest (a list drawn hidden opens once it has a height); what the reader has seen goes to the host (only when it asks: `onSeen`);
 * the top sentinel reads the next older page ONCE per page and the reader stays where they were; new messages follow the reader at the
 * bottom, else wait behind the down button (its count, the reader's own); the day floats while scrolling; J / K walk the list and stop
 * there, R answers the focused message when the host says it may; a jump's flash. The view (`FeedShell`) draws the scroller; the host
 * draws each row. No card, office or portal code.
 */

/** A message as the list's behaviour needs it: its id, its time (the ONE order: time, then id), whether it is on its way from this reader. */
export interface FeedShellMessage {
  readonly id: string
  /** ISO instant (UTC). */
  readonly at: string
  /** On its way from this reader (the office's outbox): it always shows. */
  readonly outbox?: unknown
}

export interface FeedShellModel<M extends FeedShellMessage = FeedShellMessage> {
  /** ready: the messages are read; the other states draw no list. */
  readonly state: 'loading' | 'error' | 'forbidden' | 'ready'
  readonly messages: readonly M[]
  /** The message to show and focus on arrival (`?message=<id>`). */
  readonly context: { readonly anchorId?: string | null | undefined }
  /** Older messages exist (the top of the list reads the next page as the person scrolls up). */
  readonly more: boolean
  /** The older page: reading, or it failed (Retry). */
  readonly older?: 'idle' | 'loading' | 'failed' | undefined
  /** Messages that arrived while the reader was higher up: the down button's count (design cases set it). */
  readonly newCount?: number | undefined
  /** How many are new to the reader since their last visit (the band's number). */
  readonly newSince?: number | undefined
  /** The row a jump lights up (the host's: `seq` restarts it). */
  readonly flash?: { readonly id: string; readonly seq: number } | null | undefined
}

export interface FeedShellActions {
  /** The next older page (the top of the list as the person scrolls up), and its Retry. */
  readonly onOlder?: (() => void) | undefined
  /** B-TH-229: the newest message that was on screen for a second (the host marks the thread read up to it). Absent: nothing is reported. */
  readonly onSeen?: ((messageId: string) => void) | undefined
  /** R on a focused message. */
  readonly onReply?: ((messageId: string) => void) | undefined
}

/** What the view and the host's rows use. */
export interface FeedShellHandles {
  readonly feedRef: RefObject<HTMLDivElement | null>
  readonly topRef: RefObject<HTMLDivElement | null>
  readonly onScroll: () => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  readonly retryOlder: () => void
  readonly toBottom: () => void
  /** The flash of a row: the host's jump (until its animation ended), or a `?message=` arrival's. */
  readonly flashOf: (id: string) => { seq: number; onEnd: () => void } | null
  readonly newCount: number
  readonly scrolledUp: boolean
  readonly floatDay: { readonly text: string; readonly on: boolean } | null
  readonly announce: string
}

/** The floating day fades this long after scrolling stops (10-design §7). */
const FLOAT_MS = 1200

/**
 * The list's behaviour. `rows`: the host's rows (the list opens again when they change); `canReply`: whether R may answer that message
 * (its own way).
 */
export function useFeedShell<M extends FeedShellMessage>(model: FeedShellModel<M>, rows: unknown, actions: FeedShellActions | undefined, canReply: (message: M) => boolean): FeedShellHandles {
  const t = useT('record-thread-feed')
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

  // The first read: open at the message a link names (in view, focused, its row lit), else at the unread band (B-TH-229, T4-F01),
  // else at the newest message. New messages below the screen wait behind the down button.
  // tw- fx2 (G-1): a feed drawn hidden (the phone's thread view before it is opened) has no height yet — it opens once it has one.
  const opened = useRef(false)
  const [shown, setShown] = useState(0)
  useEffect(() => {
    const feed = feedRef.current
    if (!feed || opened.current || model.state !== 'ready' || feed.clientHeight > 0 || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (feed.clientHeight > 0) setShown((count) => count + 1)
    })
    observer.observe(feed)
    return () => observer.disconnect()
  }, [model.state, shown])
  useLayoutEffect(() => {
    const feed = feedRef.current
    if (!feed || opened.current || model.state !== 'ready') return
    if (feed.clientHeight === 0 && typeof ResizeObserver !== 'undefined') return // tw- fx2 (G-1): not shown yet
    opened.current = true
    const anchorId = model.context.anchorId ?? null
    const anchor = anchorId ? feed.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchorId)}"]`) : null
    const line = feed.querySelector<HTMLElement>('[data-feed-new]')
    if (anchor && anchorId) {
      centreInList(anchor) // tw- fx2 (G-3)
      anchor.focus({ preventScroll: true })
      setArrival(anchorId)
    } else if (line) {
      feed.scrollTop = Math.max(0, feed.scrollTop + line.getBoundingClientRect().top - feed.getBoundingClientRect().top - 8)
    } else feed.scrollTop = feed.scrollHeight
    atBottom.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48
    setScrolledUp(!atBottom.current)
    if (line && !atBottom.current) setNewCount(model.newSince ?? 0)
  }, [model.state, model.context.anchorId, model.newSince, rows, shown])

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
    // tw- W1.3 (Z6): R answers the FOCUSED message (its own way: the host's `canReply`); with no message in focus the column's R switches the box.
    if (key === 'r') {
      const id = target.closest<HTMLElement>('[data-message-id]')?.dataset.messageId
      const message = id ? model.messages.find((one) => one.id === id) : undefined
      if (message && actions?.onReply && canReply(message)) {
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
      // tw- fx2 (walk G-12): the list's J / K are the list's — a page's own list keys (a ListFrame's window listener) never get them too.
      event.stopPropagation()
      element.focus({ preventScroll: true })
      revealInList(element) // tw- fx2 (G-3): the list only
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

  return { feedRef, topRef, onScroll, onKeyDown, retryOlder, toBottom, flashOf, newCount, scrolledUp, floatDay, announce }
}
