'use client'

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { ArrowLeft, MessageSquare } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../lib/i18n/provider'
import { messagesButtonWords, PORTAL_DOCK_FROM, portalArrivalCleaned, portalArrivalOf, portalFrameMode, PORTAL_THREAD_PARAM, type PortalFrameMode } from './model'
// ---- F-SA-264: the width menu and Hide / Show (⌘J), kept per person.
import { Columns2, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { ToolbarButton } from '@nexus/ui/primitives'
import { usePortalPersonId } from '../frame'
import { DEFAULT_PORTAL_DOCK_WIDTH, isPortalThreadKey, PORTAL_DOCK_COLUMNS_OF, PORTAL_DOCK_WIDTHS, readPortalDock, showButtonWords, writePortalDock, type PortalDockWidth } from './model'
// ---- end F-SA-264
import './record-frame.css'

/**
 * B-TH-273 — the portal record frame (threads plan PL3, PL4; design kit §2; picture 22 "Portal record pages (one rule)"): one place
 * for the record's conversation on every portal record page, like the office's RecordFrame (factory-only, the portal's own copy:
 * the views never import each other).
 *
 * - From 1280 px the conversation (the portal's PortalThread on the DS PartnerThread: two sides, never an office note) is DOCKED on
 *   the right at ~40 % (a 3 : 2 grid), sticky under the band while the body scrolls, its messages scrolling inside, the box at its
 *   foot. No Messages tab, no Ask modal: ONE conversation per page.
 * - Below 1280 px the body leads and a "Messages" button ("Messages (2 new)": the person's own new messages) opens the conversation
 *   full width; its Back returns to the same tab and scroll (the browser's Back too: `?thread=open` is in the history).
 * - The frame's ⋯ "Ask a question" focuses the docked box (PortalShell sends `PORTAL_ASK_EVENT` to `#messages`, the dock); narrower,
 *   the full-width view opens first. An old `?tab=messages`, `?thread=new` or `#messages` shows the conversation on arrival (R-8).
 * - Notices stay in the body column, never above the conversation. A page with no conversation for the person (a missing record)
 *   passes `thread={null}`: no dock and no button.
 * - F-SA-264 (sales page plan N6, R6, P11): docked, the conversation's top row holds the width menu (a third · 40 % · half) and
 *   "Hide the conversation"; hidden, the body takes the whole width and "Show the conversation" brings it back; ⌘J hides and shows it
 *   (narrower: opens and closes the full-width view). The width and "hidden" are kept on this device per person (a private window
 *   keeps nothing). A hidden conversation is not on screen: it marks nothing read.
 */

/** PortalShell's "Ask a question" on a page whose conversation is docked: sent to `#messages`; the frame shows and focuses its box. */
export const PORTAL_ASK_EVENT = 'fw-portal-ask'

export interface PortalRecordFrameProps {
  /** The record's conversation (PortalThread live; the design's ThreadView), or null where the person has none here. */
  readonly thread: ReactNode | null
  /** The conversation's region name ("Messages about order 12"). */
  readonly threadLabel: string
  /** The record's body: its tabs' content and its one notice. */
  readonly children: ReactNode
  /** The design review: the docked or the narrow layout whatever the window, the narrow view open, a new-message count. */
  // F-SA-264: + the dock's width and whether it is hidden.
  readonly design?: { readonly mode: PortalFrameMode; readonly viewOpen?: boolean; readonly newCount?: number; readonly width?: PortalDockWidth; readonly hidden?: boolean }
}

/** What the conversation inside reads of its frame: whether it is on screen (it marks messages read only then), and the count. */
export interface PortalRecordFrameState {
  readonly mode: PortalFrameMode
  /** The conversation is on screen: docked, or the narrow page's full-width view is open. */
  readonly onScreen: boolean
  /** The conversation tells the frame how many messages are new to the person ("Messages (2 new)"). */
  readonly reportNew: (count: number) => void
  /** A body part shows the conversation (narrower: opens the full-width view), its box focused when asked. */
  readonly showThread: (focus?: boolean) => void
}

const FrameContext = createContext<PortalRecordFrameState | null>(null)

/** The frame around the conversation, or null outside a PortalRecordFrame (the request page, a project, a pop-up). */
export function usePortalRecordFrame(): PortalRecordFrameState | null {
  return useContext(FrameContext)
}

function useMedia(query: string, initial: boolean): boolean {
  const [matches, setMatches] = useState(initial)
  useEffect(() => {
    const list = window.matchMedia(query)
    setMatches(list.matches)
    const onChange = () => setMatches(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])
  return matches
}

function scrollerOf(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight >= node.clientHeight) return node
  }
  return null
}

function focusBox(dock: HTMLElement | null): void {
  dock?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
}

// F-SA-264: this device's storage, or none (a private window that refuses it, the server).
const storageOf = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function PortalRecordFrame({ thread, threadLabel, children, design }: PortalRecordFrameProps) {
  const t = useT('portal')
  const pathname = usePathname()
  const params = useSearchParams()
  const root = useRef<HTMLDivElement>(null)
  const dock = useRef<HTMLElement>(null)
  const dockId = useId()
  const wide = useMedia(`(min-width: ${PORTAL_DOCK_FROM}px)`, true)
  const mode: PortalFrameMode = design?.mode ?? portalFrameMode(wide ? PORTAL_DOCK_FROM : PORTAL_DOCK_FROM - 1)
  const viewOpen = design?.viewOpen ?? params?.get(PORTAL_THREAD_PARAM) === 'open'
  const hasThread = thread !== null
  const [fresh, setFresh] = useState(design?.newCount ?? 0)
  const [focusAsked, setFocusAsked] = useState(false)
  const scrollKept = useRef<number | null>(null)
  // ---- F-SA-264: the dock's width and "hidden", as the person left them on this device (read before paint: no flash).
  const person = usePortalPersonId()
  // Kept for the signed-in person only (the design review and a page outside the portal layout keep nothing).
  const keepFor = design ? null : person
  const [width, setWidth] = useState<PortalDockWidth>(design?.width ?? DEFAULT_PORTAL_DOCK_WIDTH)
  const [hidden, setHiddenNow] = useState(design?.hidden ?? false)
  useLayoutEffect(() => {
    if (!keepFor) return
    const kept = readPortalDock(storageOf(), keepFor)
    setWidth(kept.width)
    setHiddenNow(kept.hidden)
  }, [keepFor])
  const setHidden = useCallback(
    (next: boolean) => {
      if (keepFor) writePortalDock(storageOf(), keepFor, { hidden: next })
      setHiddenNow(next)
    },
    [keepFor],
  )
  const chooseWidth = useCallback(
    (next: PortalDockWidth) => {
      if (keepFor) writePortalDock(storageOf(), keepFor, { width: next, hidden: false })
      setWidth(next)
      setHiddenNow(false)
    },
    [keepFor],
  )
  const docked = mode === 'docked'
  const dockHidden = docked && hidden && hasThread
  // ---- end F-SA-264

  const openView = useCallback(() => {
    const scroller = scrollerOf(root.current)
    scrollKept.current = scroller?.scrollTop ?? null
    const next = new URLSearchParams(window.location.search)
    next.set(PORTAL_THREAD_PARAM, 'open')
    window.history.pushState(null, '', `${pathname}?${next.toString()}`)
  }, [pathname])
  const closeView = useCallback(() => {
    if (!new URLSearchParams(window.location.search).has(PORTAL_THREAD_PARAM)) return
    if (scrollKept.current !== null) window.history.back()
    else {
      const next = new URLSearchParams(window.location.search)
      next.delete(PORTAL_THREAD_PARAM)
      const query = next.toString()
      window.history.replaceState(null, '', `${pathname}${query ? `?${query}` : ''}`)
    }
  }, [pathname])

  const showThread = useCallback(
    (focus = false) => {
      if (mode === 'stacked' && !viewOpen) openView()
      if (mode === 'docked' && hidden) setHidden(false) // F-SA-264: a hidden conversation shows again
      if (focus) setFocusAsked(true)
    },
    [mode, viewOpen, openView, hidden, setHidden],
  )

  // ---- F-SA-264: ⌘J (Ctrl J) — docked: hide / show; narrower: open / close the full-width view. Not in the design review.
  const toggleThread = useCallback(() => {
    if (mode === 'docked') setHidden(!hidden)
    else if (viewOpen) closeView()
    else openView()
  }, [mode, hidden, setHidden, viewOpen, closeView, openView])
  const latestToggle = useRef(toggleThread)
  latestToggle.current = toggleThread
  useEffect(() => {
    if (design || !hasThread) return
    const onKey = (event: KeyboardEvent) => {
      if (!isPortalThreadKey(event)) return
      event.preventDefault()
      latestToggle.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [design, hasThread])
  // ---- end F-SA-264

  // R-8: an old `?tab=messages` (a list's Messages link, a mail), `?thread=new` or `#messages` shows the conversation on arrival.
  useEffect(() => {
    if (design || !hasThread) return
    const asked = portalArrivalOf(window.location.search, window.location.hash)
    if (!asked.openThread) return
    const narrow = !window.matchMedia(`(min-width: ${PORTAL_DOCK_FROM}px)`).matches
    if (!narrow) setHidden(false) // F-SA-264: the address asks for the conversation: a hidden one shows again
    window.history.replaceState(null, '', `${window.location.pathname}${portalArrivalCleaned(window.location.search, narrow)}`)
    if (asked.focus) setFocusAsked(true)
    // Only on arrival.
  }, [])

  // "Ask a question" (the frame's ⋯): PortalShell asks the dock; the frame shows it and focuses the box.
  useEffect(() => {
    const element = dock.current
    if (!element) return
    const onAsk = (event: Event) => {
      event.preventDefault()
      showThread(true)
    }
    element.addEventListener(PORTAL_ASK_EVENT, onAsk)
    return () => element.removeEventListener(PORTAL_ASK_EVENT, onAsk)
  }, [showThread, hasThread])

  // The box takes the focus once it is on screen (after the full-width view opened).
  // F-SA-264: a hidden docked conversation is not on screen (it marks nothing read).
  const onScreen = (mode === 'docked' && !dockHidden) || viewOpen
  useEffect(() => {
    if (!focusAsked || !onScreen) return
    const timer = setTimeout(() => {
      dock.current?.scrollIntoView({ block: 'nearest' })
      focusBox(dock.current)
      setFocusAsked(false)
    }, 0)
    return () => clearTimeout(timer)
  }, [focusAsked, onScreen])

  // Back from the full-width view: the body as it was (the same tab and scroll); into it: from its top.
  useLayoutEffect(() => {
    if (design) return
    const scroller = scrollerOf(root.current)
    if (!scroller) return
    if (viewOpen && mode === 'stacked') scroller.scrollTop = 0
    else if (!viewOpen && scrollKept.current !== null) {
      scroller.scrollTop = scrollKept.current
      scrollKept.current = null
    }
  }, [viewOpen, mode, design])

  // The dock's top and height: under the sticky band, down to the window's foot (above a phone's bottom and action bars).
  useLayoutEffect(() => {
    const element = root.current
    if (!element || design) return
    const measure = () => {
      const scroller = scrollerOf(element)
      const band = scroller?.querySelector<HTMLElement>(':scope > .fw-pband') ?? null
      const bars = [...document.querySelectorAll<HTMLElement>('.nds-bottombar, .nds-pab:not(.inline)')].reduce((sum, bar) => sum + (getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect().height : 0), 0)
      const top = (band?.getBoundingClientRect().height ?? 0) + 16
      const room = (scroller?.clientHeight ?? window.innerHeight) - top - 16 - bars
      element.style.setProperty('--fw-prf-top', `${Math.round(top)}px`)
      element.style.setProperty('--fw-prf-h', `${Math.max(360, Math.round(room))}px`)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    const scroller = scrollerOf(element)
    if (scroller) observer?.observe(scroller)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [design])

  const state = useMemo<PortalRecordFrameState>(() => ({ mode, onScreen, reportNew: setFresh, showThread }), [mode, onScreen, showThread])

  const words = messagesButtonWords(fresh)
  // ---- F-SA-264: hidden, the body's bar brings it back ("Show the conversation (2 new)"); docked, its top row has the width menu and Hide.
  const showWords = showButtonWords(fresh)
  const showButton = dockHidden ? (
    <div className="fw-prf-bar">
      <Button size="sm" variant={fresh > 0 ? 'primary' : 'secondary'} aria-controls={dockId} aria-expanded={false} aria-keyshortcuts="Meta+J Control+J" title={`${t('record.frame.show')} (⌘J)`} onClick={() => setHidden(false)}>
        <PanelRightOpen size={14} aria-hidden /> <span>{t(showWords.key, showWords.count === undefined ? undefined : { count: showWords.count })}</span>
      </Button>
    </div>
  ) : null
  const widthItems: MenuItemDef[] = PORTAL_DOCK_WIDTHS.map((entry) => ({ id: entry, label: t(`record.frame.${entry}`), checked: entry === width, onSelect: () => chooseWidth(entry) }))
  const tools =
    hasThread && docked ? (
      <div className="fw-prf-tools">
        <Menu align="right" label={<Columns2 size={16} aria-hidden />} items={widthItems} triggerProps={{ className: 'nds-btn sm icon', 'aria-label': t('record.frame.width') }} />
        <ToolbarButton icon={<PanelRightClose size={16} aria-hidden />} label={t('record.frame.hide')} shortcut="⌘J" tooltipAlign="end" aria-keyshortcuts="Meta+J Control+J" onClick={() => setHidden(true)} />
      </div>
    ) : null
  // ---- end F-SA-264
  const button =
    hasThread && mode === 'stacked' && !viewOpen ? (
      <div className="fw-prf-bar">
        <Button
          size="sm"
          variant={fresh > 0 ? 'primary' : 'secondary'}
          aria-controls={dockId}
          aria-expanded={false}
          aria-label={words.label ? t(words.label.key, { count: words.label.count }) : undefined}
          onClick={() => showThread(false)}
        >
          <MessageSquare size={14} aria-hidden /> <span>{t(words.key, words.count === undefined ? undefined : { count: words.count })}</span>
        </Button>
      </div>
    ) : null

  return (
    <FrameContext.Provider value={state}>
      <div
        ref={root}
        className={`fw-prf${hasThread ? ' has-thread' : ''}${dockHidden ? ' is-hidden' : '' /* F-SA-264 */}`}
        data-mode={mode}
        data-view={mode === 'stacked' && viewOpen ? 'thread' : 'body'}
        data-width={width /* F-SA-264 */}
        style={{ ['--fw-prf-cols' as string]: PORTAL_DOCK_COLUMNS_OF[width] /* F-SA-264: the person's width (40 % by default) */ }}
      >
        <div className="fw-prf-body">
          {button}
          {showButton /* F-SA-264 */}
          {children}
        </div>
        {hasThread ? (
          <aside ref={dock} id="messages" className="fw-prf-dock" aria-label={threadLabel}>
            {mode === 'stacked' && viewOpen ? (
              <div className="fw-prf-back">
                <Button size="sm" variant="quiet" onClick={closeView}>
                  <ArrowLeft size={14} aria-hidden /> {t('record.frame.back')}
                </Button>
              </div>
            ) : null}
            {tools /* F-SA-264 */}
            <div id={dockId} className="fw-prf-thread">
              {thread}
            </div>
          </aside>
        ) : null}
      </div>
    </FrameContext.Provider>
  )
}
