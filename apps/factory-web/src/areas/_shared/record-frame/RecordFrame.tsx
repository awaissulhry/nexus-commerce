'use client'

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { usePathname, useSearchParams } from 'next/navigation'
import { ArrowLeft, Info, Keyboard, MessageSquare, MoreHorizontal } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Kbd, ToolbarButton } from '@nexus/ui/primitives'
import { Modal } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { useBandSlot } from '../../../shell/office/band-slot'
import type { DockWidth } from '../../../lib/record-thread/head/model'
import { useThreadWidth } from '../../../lib/record-thread/head/use-thread-width'
import { usePrintMode } from '../../../shell/print/print-mode'
import { arrivalOf, DOCK_COLUMNS, DOCK_FROM, dockWidth, FRAME_KEYS, frameMode, isThreadKey, PHONE_BELOW, type FrameMode } from './model'
import type { FrameFilesAsk } from './model' // B-TH-264 follow-up
// B-TH-229: "Thread · 2 new".
import { threadButtonWords } from './model'
import './record-frame.css'

export const FRAME_NS = 'record-frame'

/** The record band's parts (one row: the shell's dense DetailHeader where the shell has a band row). */
export interface RecordBand {
  /** The way back to the list, as the page's own link (`<Link href>Orders</Link>`: ⌘-click works). */
  readonly back: ReactElement
  /** "SO-2026-0142 · Brand Alpha". */
  readonly title: ReactNode
  /** The ONE status pill. */
  readonly status?: ReactNode
  /** Identity that travels with the title: the customer's PO, "From QT-…" (on a phone behind the band's "i"). */
  readonly meta?: ReactNode
  /** The primary step by state (one button). */
  readonly primary?: ReactNode
  /** The band's ⋯ lines (the frame adds its "Keyboard" line at the end, PR-14). */
  readonly more?: readonly MenuItemDef[]
  /** The ⋯ button's accessible name ("More actions"). */
  readonly moreLabel?: string
  // ---- TH-6 part B (PR-14: key hints only in the band menu's ONE "Keyboard" line): the record's own keys (a certificate's k / r, a
  // lot's c / r), listed first in the frame's Keyboard window, in the page's words — no second keys line, no "?" overlay.
  readonly keys?: readonly { readonly keys: readonly string[]; readonly label: string }[]
  // ---- end TH-6 part B
}

export interface RecordFrameProps {
  readonly recordType: string
  readonly personId: string | null
  readonly band: RecordBand
  /** The docked thread (the office's OfficeRecordThread docked), or null where this person has no thread here. */
  readonly thread: ReactNode | null
  /** The thread's region name ("Thread of SO-2026-0142 · Brand Alpha"). */
  readonly threadLabel: string
  /** The tab shows a wide grid (lines, a BOM, sizes, cost, cutting): one third under 1600 px unless a width was chosen. */
  readonly wide?: boolean
  /** What the print view (`?print=1`) shows of the thread under the body (the record panels' print form); absent: nothing. */
  readonly printThread?: ReactNode
  /** The record's body: its tabs, its one notice, the tab's content. */
  readonly children: ReactNode
  // ---- B-TH-269 (R-10; 08-tabs: User and Worker threads never dock open): the thread docks CLOSED on arrival; the band's Thread
  // button, ⌘J or an old `?tab=activity` address shows it. A person's own choice to show it lasts while the page is open.
  readonly closed?: boolean
  // ---- end B-TH-269
}

// B-TH-264 follow-up: the body's files in the thread's ONE viewer (the types live in model.ts).
export type { FrameFile, FrameFilesAsk } from './model'

/** What the docked thread reads of its frame: the width (null where it is not docked), the chooser, the phone head, the way back. */
export interface RecordFrameState {
  readonly mode: FrameMode
  readonly width: DockWidth | null
  readonly phone: boolean
  readonly choose: (choice: DockWidth | 'hide' | 'reset') => void
  /** Stacked: back from the full-width thread to the body (same tab, same scroll). */
  readonly close: () => void
  /** The door the address asked for on arrival (`panel=approvals`), once; the thread clears it. */
  readonly door: 'approve' | null
  readonly clearDoor: () => void
  /** B-TH-229: the thread tells the band how many messages are new to the reader ("Thread · 2 new"). */
  readonly reportNew?: (count: number) => void
  // ---- B-TH-262 (R-ACT; 08-tabs R-ACT "the sample Approval tab's Ask the customer opens the Ask popover"): a part of the body opens
  // one of the thread's doors — the thread shows (docked) or opens full width (narrower), then the door opens, as `panel=approvals` does.
  readonly openDoor?: (door: 'approve') => void
  // ---- end B-TH-262
  // ---- B-TH-264 follow-up: the body's files in the thread's ONE viewer. `openFiles` is there only where the page has a thread (else
  // the body opens the file as before); the thread reads `filesAsk` once and clears it.
  readonly openFiles?: (ask: FrameFilesAsk) => void
  readonly filesAsk?: FrameFilesAsk | null
  readonly clearFiles?: () => void
  // ---- end B-TH-264 follow-up
  // ---- B-TH-268 (a body part's way to the thread: the invoice's Send copy): show the docked thread, or open it full width below
  // 1280 px (Back returns to the tab) — there only where the page has a thread.
  readonly showThread?: () => void
  // ---- end B-TH-268
}

const FrameContext = createContext<RecordFrameState | null>(null)

/** The frame around the thread, or null outside a RecordFrame (Incoming's pane, a full page). */
export function useRecordFrame(): RecordFrameState | null {
  return useContext(FrameContext)
}

/** The address term that keeps the full-width thread open below 1280 px (Back closes it: the browser's history holds it). */
const THREAD_PARAM = 'thread'

/**
 * "Back keeps place": the page's scroll per address (the record and its tab), kept in this tab's session storage while the person
 * scrolls, and given back when the browser's Back or Forward returns to that address (the office page scrolls inside the shell, so
 * the browser's own restoration does not reach it). A per-tab convenience: storage that is closed forgets quietly.
 */
const PLACE_KEY = 'factory.record.place'
let lastTraversal = 0
if (typeof window !== 'undefined') window.addEventListener('popstate', () => (lastTraversal = Date.now()))

function readPlaces(): Record<string, number> {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(PLACE_KEY) ?? '{}') as unknown
    return value && typeof value === 'object' ? (value as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function keepPlace(address: string, top: number): void {
  try {
    const places = readPlaces()
    places[address] = Math.round(top)
    const kept = Object.entries(places).slice(-30)
    window.sessionStorage.setItem(PLACE_KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // Only a convenience of this tab.
  }
}

function scrollerOf(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight >= node.clientHeight) return node
  }
  return null
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

/**
 * RecordFrame (B-TH-213; PL1, PL4): one place for the thread on a record page, factory-only. The record band sits IN the shell's area
 * band row (the band slot), the body takes ~60 % and the docked thread ~40 % (a 3 : 2 grid; one third on a wide grid tab under
 * 1600 px; 50 % or full from the thread's width menu), sticky while the body scrolls, open by default; ⌘J hides and shows it. Below
 * 1280 px the band's "Thread" button opens it full width (Back returns to the same tab and scroll); on a phone the band's details
 * are behind its "i". ONE thread per page.
 */
export function RecordFrame(props: RecordFrameProps) {
  return (
    <WithMessages namespaces={[FRAME_NS]}>
      <Frame {...props} />
    </WithMessages>
  )
}

function Frame({ recordType, personId, band, thread, threadLabel, wide = false, printThread, children, closed = false /* B-TH-269 */ }: RecordFrameProps) {
  const t = useT(FRAME_NS)
  const slot = useBandSlot()
  const printing = usePrintMode()
  const pathname = usePathname()
  const params = useSearchParams()
  const root = useRef<HTMLDivElement>(null)
  const dockId = useId()
  const docked = useMedia(`(min-width: ${DOCK_FROM}px)`, true)
  const phone = useMedia(`(max-width: ${PHONE_BELOW - 1}px)`, false)
  const wideViewport = useMedia('(min-width: 1600px)', false)
  const mode: FrameMode = frameMode(docked ? DOCK_FROM : DOCK_FROM - 1)
  const sizes = useThreadWidth(recordType, personId, { keys: false, startHidden: closed /* B-TH-269 (R-10) */ })
  const width = dockWidth({ chosen: sizes.width, remembered: sizes.remembered, wideTab: wide, viewport: wideViewport ? 1600 : 1440 })
  const hasThread = thread !== null
  const viewOpen = params?.get(THREAD_PARAM) === 'open'
  const [details, setDetails] = useState(false)
  const [keys, setKeys] = useState(false)
  const [door, setDoor] = useState<'approve' | null>(null)
  const [filesAsk, setFilesAsk] = useState<FrameFilesAsk | null>(null) // B-TH-264 follow-up
  // B-TH-229 (band-F05, PL1-F04): the reader's own new messages, as the docked thread read them.
  const [fresh, setFresh] = useState(0)
  const before = useRef<DockWidth>('forty')
  const scrollKept = useRef<number | null>(null)

  // The band row of the shell: claimed while this record is on screen (before paint: no flash of the crumbs).
  useLayoutEffect(() => slot.claim(), [slot.claim])

  // R-8: an old address that asked for Activity opens the thread (and `panel=approvals` its "Ask a partner to approve").
  useEffect(() => {
    const asked = arrivalOf(window.location.search)
    if (!asked.openThread) return
    const next = new URLSearchParams(window.location.search)
    if (next.get('tab') === 'activity') next.delete('tab')
    next.delete('panel')
    if (next.get(THREAD_PARAM) === 'new') next.delete(THREAD_PARAM) // B-TH-230: the New messages cell's door
    if (!window.matchMedia(`(min-width: ${DOCK_FROM}px)`).matches) next.set(THREAD_PARAM, 'open')
    else sizes.show()
    window.history.replaceState(null, '', `${window.location.pathname}${next.size > 0 ? `?${next.toString()}` : ''}${window.location.hash}`)
    if (asked.door) setDoor(asked.door)
    // Only on arrival.
  }, [])

  const openView = useCallback(() => {
    const scroller = scrollerOf(root.current)
    scrollKept.current = scroller?.scrollTop ?? null
    const next = new URLSearchParams(window.location.search)
    next.set(THREAD_PARAM, 'open')
    window.history.pushState(null, '', `${pathname}?${next.toString()}`)
  }, [pathname])
  const closeView = useCallback(() => {
    if (!new URLSearchParams(window.location.search).has(THREAD_PARAM)) return
    if (scrollKept.current !== null) window.history.back()
    else {
      const next = new URLSearchParams(window.location.search)
      next.delete(THREAD_PARAM)
      window.history.replaceState(null, '', `${pathname}${next.size > 0 ? `?${next.toString()}` : ''}`)
    }
  }, [pathname])
  // Back keeps place: the scroll of this address is kept while scrolling and given back after Back / Forward (once the body is tall
  // enough: the record reads its parts after the page comes back).
  const address = `${pathname}?${params?.toString() ?? ''}`
  useEffect(() => {
    const element = root.current
    const scroller = scrollerOf(element)
    if (!element || !scroller || printing) return
    const target = Date.now() - lastTraversal < 1500 ? readPlaces()[address] : undefined
    let observer: ResizeObserver | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    if (target && target > 0) {
      const restore = () => {
        if (scroller.scrollHeight - scroller.clientHeight < target) return false
        scroller.scrollTop = target
        observer?.disconnect()
        return true
      }
      if (!restore() && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => void restore())
        observer.observe(element)
        timer = setTimeout(() => observer?.disconnect(), 4000)
      }
    }
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => keepPlace(address, scroller.scrollTop))
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
      observer?.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [address, printing])

  // Back from the full-width thread: the body as it was (the same tab and scroll); into it: from its top.
  useLayoutEffect(() => {
    const scroller = scrollerOf(root.current)
    if (!scroller) return
    if (viewOpen && mode === 'stacked') scroller.scrollTop = 0
    else if (!viewOpen && scrollKept.current !== null) {
      scroller.scrollTop = scrollKept.current
      scrollKept.current = null
    }
  }, [viewOpen, mode])

  const choose = useCallback(
    (choice: DockWidth | 'hide' | 'reset') => {
      if (choice === 'full' && width !== 'full') before.current = width
      sizes.choose(choice)
    },
    [sizes, width],
  )
  const open = mode === 'docked' ? !sizes.hidden : viewOpen
  const toggle = useCallback(() => {
    if (mode === 'docked') sizes.toggle()
    else if (viewOpen) closeView()
    else openView()
  }, [mode, sizes, viewOpen, openView, closeView])

  // ⌘J the thread (docked: show / hide; narrower: open / close the full-width view); Esc from full width goes back.
  const latest = useRef({ toggle, width, choose })
  latest.current = { toggle, width, choose }
  useEffect(() => {
    if (!hasThread) return
    const onKey = (event: KeyboardEvent) => {
      if (isThreadKey(event)) {
        event.preventDefault()
        latest.current.toggle()
        return
      }
      if (event.key !== 'Escape' || latest.current.width !== 'full' || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')) return
      latest.current.choose(before.current === 'full' ? 'forty' : before.current)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasThread])

  // The dock's top and height: under the sticky band, down to the window's foot (above a phone's bottom bar).
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const measure = () => {
      const scroller = scrollerOf(element)
      const band = scroller?.querySelector<HTMLElement>(':scope > .fw-office-subheader') ?? null
      const bar = document.querySelector<HTMLElement>('.nds-bottombar')
      const barHeight = bar && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect().height : 0
      const top = (band?.getBoundingClientRect().height ?? 0) + 16
      const room = (scroller?.clientHeight ?? window.innerHeight) - top - 16 - barHeight
      element.style.setProperty('--fw-rcf-top', `${Math.round(top)}px`)
      element.style.setProperty('--fw-rcf-h', `${Math.max(360, Math.round(room))}px`)
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
  }, [])

  // B-TH-262: a body part's door (the sample's "Ask the customer"): show the thread, then the door.
  const openDoor = useCallback(
    (asked: 'approve') => {
      if (mode === 'docked') sizes.show()
      else if (!viewOpen) openView()
      setDoor(asked)
    },
    [mode, sizes, viewOpen, openView],
  )
  // B-TH-264 follow-up: the body's files in the thread's viewer (a window over the page: the dock need not be shown for it).
  const openFiles = useCallback((ask: FrameFilesAsk) => setFilesAsk(ask), [])
  const clearFiles = useCallback(() => setFilesAsk(null), [])
  // B-TH-268: a body part shows the thread (no door, no width remembered).
  const showThread = useCallback(() => {
    if (mode === 'docked') sizes.show()
    else if (!viewOpen) openView()
  }, [mode, sizes, viewOpen, openView])
  const state = useMemo<RecordFrameState>(
    () => ({ mode, width: mode === 'docked' ? width : null, phone, choose, close: closeView, door, clearDoor: () => setDoor(null), reportNew: setFresh, openDoor /* B-TH-262 */, ...(hasThread ? { openFiles, filesAsk, clearFiles, showThread } : {}) /* B-TH-264 follow-up, B-TH-268 */ }),
    [mode, width, phone, choose, closeView, door, openDoor, hasThread, openFiles, filesAsk, clearFiles, showThread],
  )

  const buttonWords = threadButtonWords(fresh) // B-TH-229
  const threadButton = hasThread ? (
    // The tonal tint says "open" (aria-pressed for screen readers); not `active`, whose primary hover would darken the tonal words.
    <Button
      size="sm"
      variant={open ? 'tonal' : 'secondary'}
      aria-pressed={open}
      aria-controls={dockId}
      aria-keyshortcuts="Meta+J Control+J"
      aria-label={buttonWords.label ? t(buttonWords.label.key, { count: buttonWords.label.count }) : undefined}
      onClick={toggle}
      title={t(mode === 'docked' ? 'thread.hintDocked' : 'thread.hintView')}
    >
      {/* B-TH-229: "Thread · 2 new" (99+ above 99), the same number as the thread's Head. */}
      <MessageSquare size={14} aria-hidden /> <span>{t(buttonWords.key, buttonWords.count === undefined ? undefined : { count: buttonWords.count })}</span>
      <span className="fw-rcf-keys" aria-hidden>
        <Kbd>⌘</Kbd>
        <Kbd>J</Kbd>
      </span>
    </Button>
  ) : null
  const header = (
    <DetailHeader
      dense
      className={viewOpen ? 'fw-rcf-hdr is-thread' : 'fw-rcf-hdr'}
      backAsChild
      backLabel={band.back}
      title={band.title}
      meta={
        band.status || band.meta ? (
          <span className="fw-rcf-meta">
            {band.status}
            {band.meta && <span className="fw-rcf-meta-more">{band.meta}</span>}
          </span>
        ) : undefined
      }
      status={slot.status ? <span className="fw-rcf-live">{slot.status}</span> : undefined}
      actions={
        <span className="fw-rcf-actions">
          {band.primary && <span className="fw-rcf-primary">{band.primary}</span>}
          {threadButton}
          {band.meta && phone && <ToolbarButton icon={<Info size={16} />} label={t('details.open')} onClick={() => setDetails(true)} />}
          <Menu
            label={<MoreHorizontal size={16} aria-label={band.moreLabel ?? t('more')} />}
            items={[...(band.more ?? []), ...(band.more?.length ? [{ id: 'sep-keys', separator: true }] : []), { id: 'keys', label: t('keys.line'), icon: <Keyboard size={15} aria-hidden />, description: t('keys.lineHint'), onSelect: () => setKeys(true) }]}
            align="right"
            triggerProps={{ 'aria-label': band.moreLabel ?? t('more') }}
          />
          {slot.actions}
        </span>
      }
    />
  )

  // The print view: the band, the body, then what the thread prints; no dock, no pop-ups.
  if (printing) {
    return (
      <div className="fw-rcf-print">
        {header}
        {children}
        {printThread}
      </div>
    )
  }

  return (
    <FrameContext.Provider value={state}>
      {slot.element ? createPortal(header, slot.element) : <div className="fw-rcf-band">{header}</div>}
      <div
        ref={root}
        className={`fw-rcf${hasThread ? ' has-thread' : ''}${mode === 'docked' && sizes.hidden ? ' is-hidden' : ''}`}
        data-width={width}
        data-view={viewOpen ? 'thread' : 'body'}
        style={{ ['--fw-rcf-cols' as string]: DOCK_COLUMNS[width] }}
      >
        <div className="fw-rcf-body">{children}</div>
        {hasThread && (
          <aside id={dockId} className="fw-rcf-dock" aria-label={threadLabel}>
            {mode === 'stacked' && viewOpen && (
              <div className="fw-rcf-back">
                <Button size="sm" variant="quiet" onClick={closeView}>
                  <ArrowLeft size={14} aria-hidden /> {t('thread.back')}
                </Button>
              </div>
            )}
            {thread}
          </aside>
        )}
      </div>
      {keys && (
        <Modal open size="sm" title={t('keys.title')} onClose={() => setKeys(false)}>
          <dl className="fw-rcf-keylist">
            {/* TH-6 part B: the record's own keys first, then the thread's. */}
            {(band.keys ?? []).map((entry) => (
              <div key={`own-${entry.keys.join('+')}`} className="fw-rcf-keyrow">
                <dt>
                  {entry.keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </dt>
                <dd>{entry.label}</dd>
              </div>
            ))}
            {FRAME_KEYS.map((entry) => (
              <div key={entry.words} className="fw-rcf-keyrow">
                <dt>
                  {entry.keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </dt>
                <dd>{t(entry.words)}</dd>
              </div>
            ))}
          </dl>
        </Modal>
      )}
      {details && band.meta && (
        <Modal open title={t('details.title')} onClose={() => setDetails(false)}>
          <div className="fw-rcf-details">
            {band.status}
            {band.meta}
          </div>
        </Modal>
      )}
    </FrameContext.Provider>
  )
}
