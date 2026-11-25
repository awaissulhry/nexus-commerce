'use client'

import { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../lib/i18n/provider'
import { DOCK_FROM, THIRD_BELOW } from '../../../lib/record-frame/model' // pp-w1 (w1.1, L8): the office's first-width rule
import { PORTAL_DOCK_FROM, portalArrivalCleaned, portalArrivalOf, portalFrameMode, PORTAL_THREAD_PARAM, type PortalFrameMode } from './model'
// ---- F-SA-264: the widths and Hide / Show (⌘J), kept per person. pp-w1 (w1.1): the thread head's ⋯ draws them; the band its button.
import { usePortalBandThread, usePortalPersonId } from '../frame'
import { bandThreadOf, DEFAULT_PORTAL_DOCK_WIDTH, isPortalDockWidth, isPortalThreadKey, PORTAL_DOCK_COLUMNS_OF, PORTAL_DOCK_WIDTHS, portalFirstWidth, readPortalDock, writePortalDock, type PortalDockWidth } from './model'
// ---- end F-SA-264
import './record-frame.css'

/**
 * B-TH-273 — the portal record frame (threads plan PL3, PL4; design kit §2; picture 22 "Portal record pages (one rule)"): one place
 * for the record's conversation on every portal record page, like the office's RecordFrame (factory-only, the portal's own copy:
 * the views never import each other).
 *
 * - From 1280 px the conversation (the portal's PortalThread: the ONE partner face of the shared thread, lib/record-thread/partner —
 *   two sides, never an office note) is DOCKED on the right, sticky under the band while the body scrolls, its messages scrolling
 *   inside, the box at its foot on screen from the first load (G2). No Messages tab, no Ask modal: ONE conversation per page.
 * - Below 1280 px the body leads and the band's "Messages (2 new)" (the person's own new messages) opens the conversation full width,
 *   one view of the window's height (G3); its Back returns to the same tab and scroll (the browser's Back too: `?thread=open`).
 * - The frame's ⋯ "Ask a question" focuses the docked box (PortalShell sends `PORTAL_ASK_EVENT` to `#messages`, the dock); narrower,
 *   the full-width view opens first. An old `?tab=messages`, `?thread=new` or `#messages` shows the conversation on arrival (R-8).
 * - Notices stay in the body column, never above the conversation. A page with no conversation for the person (a missing record)
 *   passes `thread={null}`: no dock and no button.
 * - F-SA-264 (sales page plan N6, R6, P11) and pp-w1 (w1.1, L3, L8): the dock has ONE head row, the thread's own — the frame hands
 *   PortalThread its `width` + `choose` (the office RecordFrameState's names), and the head's ⋯ draws a third · 40 % · half, Hide
 *   and back to the first width. The first width is the office's (a third below 1600 px, 40 % from 1600); a chosen one is kept.
 *   Hidden, the body takes the whole width and the band's "Messages (2 new)" brings it back; ⌘J hides and shows it (narrower: opens
 *   and closes the full-width view). The width and "hidden" are kept on this device per person (a private window keeps nothing). A
 *   hidden conversation is not on screen: it marks nothing read.
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
  // pp-w1 (w1.1; reverses F-SA-246's door above the conversation): the record's ask is the band's ONE "Ask for a change…".
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
  /** pp-w1 (w1.1; the office RecordFrameState's names): the dock's width while docked and shown (null: narrower, hidden or none). */
  readonly width: PortalDockWidth | null
  /** pp-w1 (w1.1): a width, Hide, or back to the first width (`reset`: the office's rule, the person's choice forgotten). */
  readonly choose: (choice: PortalDockWidth | 'hide' | 'reset') => void
}

const FrameContext = createContext<PortalRecordFrameState | null>(null)

/** The frame around the conversation, or null outside a PortalRecordFrame (the request page, a project, a pop-up). */
export function usePortalRecordFrame(): PortalRecordFrameState | null {
  return useContext(FrameContext)
}

function useMedia(query: string, initial: boolean): boolean {
  const [matches, setMatches] = useState(initial)
  // pp-w1 (w1.1): read before paint — the dock's mode and its first width never jump (40 % to a third at 1440) after it drew.
  useLayoutEffect(() => {
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

/** The conversation's box takes the focus; false while the thread has not drawn it yet (or it is still disabled). */
function focusBox(dock: HTMLElement | null): boolean {
  const box = dock?.querySelector<HTMLTextAreaElement>('textarea:not([disabled])') ?? null
  box?.focus()
  return box !== null
}

/** pp-fx4 (walk W-03): how long an asked focus waits for the thread to draw its box. */
const BOX_WAIT_MS = 10_000

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
  // pp-w1 (w1.1, L8): the width the person chose (null: none — the office's first width at this window: a third below 1600 px).
  const [chosen, setChosen] = useState<PortalDockWidth | null>(design?.width ?? null)
  const roomy = useMedia(`(min-width: ${THIRD_BELOW}px)`, true)
  const width: PortalDockWidth = chosen ?? (design ? DEFAULT_PORTAL_DOCK_WIDTH : portalFirstWidth(roomy ? THIRD_BELOW : DOCK_FROM))
  const [hidden, setHiddenNow] = useState(design?.hidden ?? false)
  useLayoutEffect(() => {
    if (!keepFor) return
    const kept = readPortalDock(storageOf(), keepFor)
    setChosen(kept.width)
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
      setChosen(next)
      setHiddenNow(false)
    },
    [keepFor],
  )
  // pp-w1 (w1.1): the thread head's ⋯ — a width, Hide, or back to the first width (the choice forgotten on this device).
  const choose = useCallback(
    (choice: PortalDockWidth | 'hide' | 'reset') => {
      if (choice === 'hide') return setHidden(true)
      if (choice === 'reset') {
        if (keepFor) writePortalDock(storageOf(), keepFor, { width: null, hidden: false })
        setChosen(null)
        setHiddenNow(false)
        return
      }
      chooseWidth(choice)
    },
    [keepFor, setHidden, chooseWidth],
  )
  const chooseFromHead = useCallback((value: string) => (value === 'hide' || value === 'reset' || isPortalDockWidth(value) ? choose(value) : undefined), [choose])
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
  // pp-fx4 (walk W-03): on arrival (`?tab=messages`) the conversation still loads — no box yet. The ask waits for the box (it takes the
  // focus the moment the thread draws it), unless the person moved the focus meanwhile; it gives up after BOX_WAIT_MS.
  useEffect(() => {
    if (!focusAsked || !onScreen) return
    const element = dock.current
    let observer: MutationObserver | null = null
    const settle = (): boolean => {
      if (!focusBox(element)) return false
      element?.scrollIntoView({ block: 'nearest' })
      return true
    }
    const done = () => {
      observer?.disconnect()
      setFocusAsked(false)
    }
    const timer = setTimeout(() => {
      if (settle()) return done()
      if (!element || typeof MutationObserver === 'undefined') return done()
      const waitingFrom = document.activeElement
      observer = new MutationObserver(() => {
        const active = document.activeElement
        if (active !== waitingFrom && active && active !== document.body && !element.contains(active)) return done() // the person moved on
        if (settle()) done()
      })
      observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] })
    }, 0)
    const giveUp = setTimeout(done, BOX_WAIT_MS)
    return () => {
      clearTimeout(timer)
      clearTimeout(giveUp)
      observer?.disconnect()
    }
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
  // pp-w1 (G2, G3): the height counts from the dock's REAL top — at the first load it sits lower than its sticky top (the main's
  // padding, the body above the grid), so the foot and Send are on screen at once; narrower, the open full-width view gets the same
  // height (one view of the window less the bars, its list scrolling inside). Measured again when the view opens or the dock shows.
  useLayoutEffect(() => {
    const element = root.current
    if (!element || design) return
    const measure = () => {
      const scroller = scrollerOf(element)
      const band = scroller?.querySelector<HTMLElement>(':scope > .fw-pband') ?? null
      // pp-fx4 (walk W-06): the room ends where the page stops being visible — the scroller's foot, or the top of a phone's fixed bar
      // over it. The action bar's spacer already shortens the scroller: its bar is not counted twice (the open view was 391 px, its
      // list 188 px). A bar not drawn (from 720 px, or stepped aside) has no box and counts for nothing.
      const scrollerTop = scroller?.getBoundingClientRect().top ?? 0
      const visibleFoot = [...document.querySelectorAll<HTMLElement>('.nds-bottombar, .nds-pab:not(.inline)')].reduce((foot, bar) => {
        const box = bar.getBoundingClientRect()
        return box.height > 0 && box.top > scrollerTop ? Math.min(foot, box.top) : foot
      }, scrollerTop + (scroller?.clientHeight ?? window.innerHeight))
      const sticky = (band?.getBoundingClientRect().height ?? 0) + 16
      const shown = dock.current && getComputedStyle(dock.current).display !== 'none' ? dock.current : null
      const real = shown && scroller ? shown.getBoundingClientRect().top - scrollerTop : sticky
      const top = Math.max(sticky, real)
      const room = visibleFoot - scrollerTop - top - 16
      element.style.setProperty('--fw-prf-top', `${Math.round(sticky)}px`)
      element.style.setProperty('--fw-prf-h', `${Math.max(360, Math.round(room))}px`)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    const scroller = scrollerOf(element)
    if (scroller) observer?.observe(scroller)
    // pp-fx4 (walk W-04): the dock's top moves after the first measure — the page fills the band after mounting (a supplier order's band
    // grows by its tabs row, 47 px), and the body above the frame loads (notices). The band and the main are watched too.
    const band = scroller?.querySelector<HTMLElement>(':scope > .fw-pband') ?? null
    if (band) observer?.observe(band)
    const main = element.closest('main')
    if (main) observer?.observe(main)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [design, mode, viewOpen, dockHidden])

  // pp-w1 (w1.1, L3): the dock's ONE head row is the thread's: docked and shown, it gets the widths and the chooser (its ⋯).
  const headWidth = docked && hasThread && !dockHidden ? width : null
  const state = useMemo<PortalRecordFrameState>(() => ({ mode, onScreen, reportNew: setFresh, showThread, width: headWidth, choose }), [mode, onScreen, showThread, headWidth, choose])
  const threadNode =
    headWidth !== null && isValidElement<{ width?: unknown; choose?: unknown }>(thread) && typeof thread.type !== 'string' ? cloneElement(thread, { width: { widths: PORTAL_DOCK_WIDTHS, current: headWidth }, choose: chooseFromHead }) : thread

  // pp-w1 (w1.1; 10-design § 4, P0-B4): not on screen (hidden, or narrower with its view closed), the conversation's button is in the
  // band, before the ⋯ — "Messages (2 new)" — never a lone row of the body. The design review draws it from its own band.
  const bandThread = design ? null : bandThreadOf({ hasThread, mode, hidden: dockHidden, viewOpen, count: fresh })
  usePortalBandThread(bandThread ? { count: bandThread.count, onClick: () => showThread(false) } : null)

  return (
    <FrameContext.Provider value={state}>
      <div
        ref={root}
        className={`fw-prf${hasThread ? ' has-thread' : ''}${dockHidden ? ' is-hidden' : '' /* F-SA-264 */}`}
        data-mode={mode}
        data-view={mode === 'stacked' && viewOpen ? 'thread' : 'body'}
        data-width={width /* F-SA-264 */}
        style={{ ['--fw-prf-cols' as string]: PORTAL_DOCK_COLUMNS_OF[width] /* F-SA-264: the person's width; pp-w1 (L8): until chosen, the office's first width */ }}
      >
        <div className="fw-prf-body">{children}</div>
        {hasThread ? (
          <aside ref={dock} id="messages" className="fw-prf-dock" aria-label={threadLabel}>
            {mode === 'stacked' && viewOpen ? (
              <div className="fw-prf-back">
                <Button size="sm" variant="quiet" onClick={closeView}>
                  <ArrowLeft size={14} aria-hidden /> {t('record.frame.back')}
                </Button>
              </div>
            ) : null}
            <div id={dockId} className="fw-prf-thread">
              {threadNode}
            </div>
          </aside>
        ) : null}
      </div>
    </FrameContext.Provider>
  )
}
