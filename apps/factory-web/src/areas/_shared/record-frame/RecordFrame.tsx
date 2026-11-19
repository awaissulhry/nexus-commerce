'use client'

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { usePathname, useSearchParams } from 'next/navigation'
import { ArrowLeft, Keyboard, MessageSquare, MoreHorizontal } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Kbd } from '@nexus/ui/primitives'
import { Modal } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { useBandSlot } from '../../../shell/office/band-slot'
import type { DockWidth } from '../../../lib/record-thread/head/model'
import { useThreadWidth } from '../../../lib/record-thread/head/use-thread-width'
import { usePrintMode } from '../../../shell/print/print-mode'
import { arrivalOf, DOCK_COLUMNS, DOCK_FROM, dockWidth, frameMode, isThreadKey, PHONE_BELOW, type FrameMode } from './model'
import { showsOnArrival, type DockDefault } from './model' // F-SA-263
import { viewOpenOf } from './model' // F-SA-262
import type { DiscussAsk, FrameDoor, ShowInThreadAsk } from './model' // F-SA-265
import type { FrameAnswer } from './model' // F-SA-244
import type { FrameFilesAsk } from './model' // B-TH-264 follow-up
import { askRecordOf, type ComposeAsk, type FrameDoorAsk, type FrameRecord } from './model' // F-OP-212: every ask names its record
import { frameKeysFor } from './model' // F-OP-206
import { currentAddress, keptScopeOf, withThread, writeSearch } from './address' // F-OP-209: the ONE writer of `thread=`
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
  /** Identity that travels with the title: the customer's PO, "From QT-…" (F-OP-302: what does not fit folds behind "+N"). */
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
  // ---- F-SA-263 (sales page plan N6, P11; 10-order-page §5, §6.3): each tab its own default width (replaces the `wide` boolean).
  /**
   * The tab's dock width when the person chose none: a width, or `grid` for a wide grid tab (the lines, a BOM, sizes, cost, cutting:
   * one third under 1600 px, 40 % from 1600). Absent: 40 %.
   */
  readonly defaultWidth?: DockDefault
  /**
   * The tab on screen, for a page that keeps its dock across tabs: hiding the dock is kept per person + record type (⌘J, the band's
   * button, `?tab=activity` or `?thread=` show it again); a private window keeps nothing. Absent: "hidden" lasts while the page is
   * open (every other record page, as before). F-OP-301 (walk #5): the person's chosen width is ONE per person + record type on every
   * tab (the menu's "Default width" clears it): the dock never changes its width when the page tab changes.
   */
  readonly dockTab?: string
  // ---- end F-SA-263
  /** What the print view (`?print=1`) shows of the thread under the body (ThreadPrint: the thread for paper, B-TH-280); absent: nothing. */
  readonly printThread?: ReactNode
  /** The record's body: its tabs, its one notice, the tab's content. */
  readonly children: ReactNode
  // ---- B-TH-269 (R-10; 08-tabs: User and Worker threads never dock open): the thread docks CLOSED on arrival; the band's Thread
  // button, ⌘J or an old `?tab=activity` address shows it. A person's own choice to show it lasts while the page is open.
  readonly closed?: boolean
  // ---- end B-TH-269
  // ---- B-TH-280: the record's custom fields (Admin › Fields & lists; record-panels/custom-fields RecordCustomFields), drawn at the end
  // of the body column — the page passes it on its first tab only; absent: nothing. The print view prints it after the body.
  readonly fields?: ReactNode
  // ---- end B-TH-280
  // ---- F-SA-279 (11-customer-page §3.7): below 1280 px the band's button names the conversation the dock holds now ("Thread · SO-…",
  // in the page's words) — a row of the customer's Work tab picked it; absent: "Thread" (or "Thread · 2 new").
  readonly threadButton?: string | null
  // ---- end F-SA-279
  // ---- F-SA-244: the page's ONE review window, opened from the conversation (the customer's ask's Answer…); absent: not offered.
  readonly answer?: FrameAnswer
  // ---- end F-SA-244
  // ---- F-OP-212 (11-dock §5): the page's own record (the order, the customer, the work order): every ask that names no record is for
  // it, and only its thread takes it (the page's dock moves its pick there first). Absent: asks name no record (the page's one thread).
  readonly record?: FrameRecord
  // ---- end F-OP-212
}

// B-TH-264 follow-up: the body's files in the thread's ONE viewer (the types live in model.ts).
export type { FrameFile, FrameFilesAsk } from './model'
export type { DiscussAbout, DiscussAsk, ShowInThreadAsk } from './model' // F-SA-265
export type { FrameAnswer } from './model' // F-SA-244

/** What the docked thread reads of its frame: the width (null where it is not docked), the chooser, the phone head, the way back. */
export interface RecordFrameState {
  readonly mode: FrameMode
  readonly width: DockWidth | null
  readonly phone: boolean
  readonly choose: (choice: DockWidth | 'hide' | 'reset') => void
  /** Stacked: back from the full-width thread to the body (same tab, same scroll). */
  readonly close: () => void
  /**
   * The door the address asked for on arrival (`panel=approvals`), once; the thread clears it. F-SA-265: or the body's Followers….
   * F-OP-212: with the thread it is for (only that thread takes it).
   */
  readonly door: FrameDoorAsk | null
  readonly clearDoor: () => void
  /** B-TH-229: the thread tells the band how many messages are new to the reader ("Thread · 2 new"). */
  readonly reportNew?: (count: number) => void
  // ---- B-TH-262 (R-ACT; 08-tabs R-ACT "the sample Approval tab's Ask the customer opens the Ask popover"): a part of the body opens
  // one of the thread's doors — the thread shows (docked) or opens full width (narrower), then the door opens, as `panel=approvals` does.
  readonly openDoor?: (door: FrameDoor, record?: FrameRecord) => void // F-OP-212: the record (absent: the page's own)
  // ---- end B-TH-262
  // ---- B-TH-264 follow-up: the body's files in the thread's ONE viewer. `openFiles` is there only where the page has a thread (else
  // the body opens the file as before); the thread reads `filesAsk` once and clears it.
  readonly openFiles?: (ask: FrameFilesAsk) => void
  readonly filesAsk?: FrameFilesAsk | null
  readonly clearFiles?: () => void
  // ---- end B-TH-264 follow-up
  // ---- B-TH-265: a part of the band or body shows the thread with no door (the work order's "Open the order's thread" in Order files):
  // docked, it shows (if hidden); narrower, the full-width thread opens. (TH-6 part B's invoice Send copy uses it too, B-TH-268.)
  readonly showThread?: () => void
  // ---- end B-TH-265
  // ---- F-OP-209 (11-dock §4): the ONE writer of `thread=` — the dock's pick (a scope, `open` below 1280 px, null: This order's own),
  // the message a line opens its thread at; a history replace only when the address changes, a push only when the narrow view opens.
  readonly setThread?: (value: string | null, options?: SetThreadOptions) => void
  // ---- end F-OP-209
  // ---- F-SA-265 (10-order-page §6.4): Discuss — a row of the body opens the conversation about it: the dock shows (narrower: the
  // full-width conversation), the page's pick goes to the record's own conversation, the box opens on Office note with the chip
  // "About: …". Show in thread — a history row shows its step in the conversation. The thread reads each ask once and clears it.
  readonly discuss?: (ask: DiscussAsk) => void
  readonly discussAsk?: DiscussAsk | null
  readonly clearDiscuss?: () => void
  readonly showInThread?: (ask: ShowInThreadAsk) => void
  readonly showAsk?: ShowInThreadAsk | null
  readonly clearShow?: () => void
  // ---- end F-SA-265
  // ---- F-SA-244: the door kind beside openDoor('approve') — the conversation asks the page's review window to open on a request.
  readonly answer?: FrameAnswer
  // ---- end F-SA-244
  // ---- F-OP-212 (review N-1): Answer / Reply in the thread — the thread of the ask's record opens at the message with the box focused
  // (Reply: the card's own Reply; Office note otherwise). The thread shows first; only that record's thread reads the ask, once.
  readonly compose?: (ask: ComposeAsk) => void
  readonly composeAsk?: ComposeAsk | null
  readonly clearCompose?: () => void
  // ---- end F-OP-212
}

/** F-OP-209: how `setThread` writes — the message to open the thread at (absent: dropped), a push (the narrow view opening). */
export interface SetThreadOptions {
  readonly message?: string | null
  readonly push?: boolean
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

// ---- F-OP-302 (order page walk #10, #20): the band's identity pills are never cut. The pills that do not fit the band's track wrap
// onto a row the track clips (record-frame.css), and this counts them: each folded pill is hidden and inert (never focused unseen),
// and the band says "+N", which opens Details (status and every pill). The same at every width: on a phone the "i" is gone, so the
// band's tools fit one row.
export function foldedOf(box: { readonly top: number; readonly right: number; readonly bottom: number }, items: readonly { readonly top: number; readonly right: number }[]): boolean[] {
  return items.map((item) => item.top >= box.bottom - 1 || item.right > box.right + 1)
}

function useFoldedPills(): [(node: HTMLElement | null) => void, number] {
  const [count, setCount] = useState(0)
  const stop = useRef<(() => void) | null>(null)
  const ref = useCallback((node: HTMLElement | null) => {
    stop.current?.()
    stop.current = null
    if (!node) return setCount(0)
    const measure = () => {
      const items = [...node.children] as HTMLElement[]
      for (const item of items) item.style.visibility = ''
      const folded = foldedOf(node.getBoundingClientRect(), items.map((item) => item.getBoundingClientRect()))
      items.forEach((item, index) => {
        item.inert = folded[index]!
        if (folded[index]) item.style.visibility = 'hidden'
      })
      setCount(folded.filter(Boolean).length)
    }
    measure()
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    resize?.observe(node)
    const changes = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure)
    changes?.observe(node, { childList: true, subtree: true, characterData: true })
    stop.current = () => {
      resize?.disconnect()
      changes?.disconnect()
    }
  }, [])
  return [ref, count]
}
// ---- end F-OP-302

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
 * 1280 px the band's "Thread" button opens it full width (Back returns to the same tab and scroll); the pills that do not fit fold
 * behind "+N" (F-OP-302). ONE thread per page.
 */
export function RecordFrame(props: RecordFrameProps) {
  return (
    <WithMessages namespaces={[FRAME_NS]}>
      <Frame {...props} />
    </WithMessages>
  )
}

function Frame({ recordType, personId, band, thread, threadLabel, defaultWidth /* F-SA-263 */, dockTab /* F-SA-263 */, printThread, children, closed = false /* B-TH-269 */, fields /* B-TH-280 */, threadButton: namedButton /* F-SA-279 */, answer /* F-SA-244 */, record /* F-OP-212 */ }: RecordFrameProps) {
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
  // F-SA-263: with `dockTab` "hidden" is kept per record type.
  // F-OP-301 (walk #5): the chosen width is one per record type (never per tab); `dockTab` keeps "hidden".
  const sizes = useThreadWidth(recordType, personId, { keys: false, startHidden: closed /* B-TH-269 (R-10) */, rememberHidden: dockTab !== undefined })
  const width = dockWidth({ chosen: sizes.remembered ? sizes.width : null, defaultWidth, viewport: wideViewport ? 1600 : 1440 })
  const hasThread = thread !== null
  // F-SA-262: a dock scope in the address (`general`, `project:…`, `wo:…`, `all`: the order page's pick) keeps the narrow view open too.
  const viewOpen = viewOpenOf(params?.get(THREAD_PARAM) ?? null)
  const [details, setDetails] = useState(false)
  const [metaRef, folded] = useFoldedPills() // F-OP-302
  const [keys, setKeys] = useState(false)
  const [door, setDoor] = useState<FrameDoorAsk | null>(null)
  // ---- F-OP-212: the page's own record, the one every ask that names none is for (kept by its type and id: a new object each render).
  const ownType = record?.type ?? null
  const ownId = record?.id ?? null
  const pageRecord = useMemo<FrameRecord | null>(() => (ownType && ownId ? { type: ownType, id: ownId } : null), [ownType, ownId])
  const pageRecordRef = useRef(pageRecord)
  pageRecordRef.current = pageRecord
  const [composeAsk, setComposeAsk] = useState<ComposeAsk | null>(null)
  // ---- end F-OP-212
  const [discussAsk, setDiscussAsk] = useState<DiscussAsk | null>(null) // F-SA-265
  const [showAsk, setShowAsk] = useState<ShowInThreadAsk | null>(null) // F-SA-265
  const [filesAsk, setFilesAsk] = useState<FrameFilesAsk | null>(null) // B-TH-264 follow-up
  // B-TH-229 (band-F05, PL1-F04): the reader's own new messages, as the docked thread read them.
  const [fresh, setFresh] = useState(0)
  const before = useRef<DockWidth>('forty')
  const scrollKept = useRef<number | null>(null)

  // The band row of the shell: claimed while this record is on screen (before paint: no flash of the crumbs).
  useLayoutEffect(() => slot.claim(), [slot.claim])

  // R-8: an old address that asked for Activity opens the thread (and `panel=approvals` its "Ask a partner to approve").
  // F-OP-212: read by the frame that has the thread — a page's frame while its record still loads has none (it is another mount), and
  // the door it took would be lost with it; the address waits for the frame with the thread (once per mount).
  const arrived = useRef(false)
  useEffect(() => {
    if (arrived.current || !hasThread) return
    arrived.current = true
    const asked = arrivalOf(window.location.search)
    // F-SA-263: any `?thread=` (a dock scope, the narrow view's `open`) shows a docked thread the person had hidden.
    if (!asked.openThread && showsOnArrival(window.location.search) && window.matchMedia(`(min-width: ${DOCK_FROM}px)`).matches) sizes.show()
    if (!asked.openThread) return
    const next = new URLSearchParams(window.location.search)
    if (next.get('tab') === 'activity') next.delete('tab')
    next.delete('panel')
    if (next.get(THREAD_PARAM) === 'new') next.delete(THREAD_PARAM) // B-TH-230: the New messages cell's door
    if (!window.matchMedia(`(min-width: ${DOCK_FROM}px)`).matches) next.set(THREAD_PARAM, 'open')
    else sizes.show()
    // F-OP-209: the arrival reads and cleans the address once, through the same history writer (nothing when it is the same).
    writeSearch(`${window.location.pathname}${next.size > 0 ? `?${next.toString()}` : ''}${window.location.hash}`)
    if (asked.door) setDoor({ door: asked.door, record: pageRecordRef.current }) // F-OP-212: the page's own thread takes it
    // Only on arrival.
  }, [hasThread]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- F-OP-209 (11-dock §4; RC4, RC5): the ONE writer of `thread=`. Never in render; the arrival above is the one exception that
  // reads the address and cleans it once. Below 1280 px the scope and the open view share the term: closing the view drops it, so
  // the frame keeps the scope (this page mount only) and the band's Thread button opens the view on it again.
  const setThread = useCallback((value: string | null, options: SetThreadOptions = {}) => {
    writeSearch(withThread(currentAddress(), value, { message: options.message ?? null }), { push: options.push === true })
  }, [])
  const term = params?.get(THREAD_PARAM) ?? null
  const keptScope = useRef<string | null>(null)
  useEffect(() => {
    keptScope.current = keptScopeOf(keptScope.current, term, mode)
  }, [term, mode])
  const openView = useCallback(() => {
    const scroller = scrollerOf(root.current)
    scrollKept.current = scroller?.scrollTop ?? null
    setThread(keptScope.current ?? 'open', { push: true })
  }, [setThread])
  const closeView = useCallback(() => {
    if (!new URLSearchParams(window.location.search).has(THREAD_PARAM)) return
    if (scrollKept.current !== null) window.history.back()
    else setThread(null)
  }, [setThread])
  // ---- end F-OP-209
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
    (asked: FrameDoor, about?: FrameRecord) => {
      if (mode === 'docked') sizes.show()
      else if (!viewOpen) openView()
      setDoor({ door: asked, record: askRecordOf(about, pageRecord) }) // F-OP-212
    },
    [mode, sizes, viewOpen, openView, pageRecord],
  )
  // B-TH-264 follow-up: the body's files in the thread's viewer (a window over the page: the dock need not be shown for it).
  // F-OP-212: in the viewer of the ask's record's thread (the page's own when the body names none).
  const openFiles = useCallback((ask: FrameFilesAsk) => setFilesAsk({ ...ask, record: askRecordOf(ask.record, pageRecord) }), [pageRecord])
  const clearFiles = useCallback(() => setFilesAsk(null), [])
  // ---- B-TH-265: show the thread (no door).
  const showThread = useCallback(() => {
    if (mode === 'docked') sizes.show()
    else if (!viewOpen) openView()
  }, [mode, sizes, viewOpen, openView])
  // ---- end B-TH-265
  // ---- F-SA-265: Discuss and Show in thread — the conversation shows, then reads the ask.
  const discuss = useCallback(
    (ask: DiscussAsk) => {
      showThread()
      setDiscussAsk(ask)
    },
    [showThread],
  )
  const showInThread = useCallback(
    (ask: ShowInThreadAsk) => {
      showThread()
      setShowAsk(ask)
    },
    [showThread],
  )
  const clearDiscuss = useCallback(() => setDiscussAsk(null), [])
  const clearShow = useCallback(() => setShowAsk(null), [])
  // ---- end F-SA-265
  // ---- F-OP-212: Answer / Reply in the thread — the conversation shows, then the ask's record's thread reads it.
  const compose = useCallback(
    (ask: ComposeAsk) => {
      showThread()
      setComposeAsk({ ...ask, record: askRecordOf(ask.record, pageRecord) })
    },
    [showThread, pageRecord],
  )
  const clearCompose = useCallback(() => setComposeAsk(null), [])
  // ---- end F-OP-212
  const state = useMemo<RecordFrameState>(
    () => ({
      mode,
      width: mode === 'docked' ? width : null,
      phone,
      choose,
      close: closeView,
      door,
      clearDoor: () => setDoor(null),
      reportNew: setFresh,
      openDoor /* B-TH-262 */,
      showThread /* B-TH-265 */,
      ...(hasThread ? { setThread } : {}) /* F-OP-209: the dock's pick writes the address here, and only here */,
      ...(hasThread ? { openFiles, filesAsk, clearFiles } : {}) /* B-TH-264 follow-up */,
      ...(hasThread ? { discuss, discussAsk, clearDiscuss, showInThread, showAsk, clearShow } : {}) /* F-SA-265: only where the page has a conversation */,
      ...(hasThread ? { compose, composeAsk, clearCompose } : {}) /* F-OP-212 */,
      ...(hasThread && answer ? { answer } : {}) /* F-SA-244: only where the page has the review window and a conversation */,
    }),
    [mode, width, phone, choose, closeView, door, openDoor, showThread, hasThread, setThread, openFiles, filesAsk, clearFiles, discuss, discussAsk, clearDiscuss, showInThread, showAsk, clearShow, answer, compose, composeAsk, clearCompose],
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
      {/* B-TH-229: "Thread · 2 new" (99+ above 99), the same number as the thread's Head. F-SA-279: narrower, the page's name of the
          conversation it holds ("Thread · SO-…"). */}
      <MessageSquare size={14} aria-hidden /> <span>{mode === 'stacked' && namedButton ? namedButton : t(buttonWords.key, buttonWords.count === undefined ? undefined : { count: buttonWords.count })}</span>
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
            {band.meta && (
              <span ref={metaRef} className="fw-rcf-meta-more">
                {band.meta}
              </span>
            )}
            {/* F-OP-302: the pills that do not fit, behind "+N" (Details shows the status and every pill). */}
            {band.meta && folded > 0 && (
              <Button size="sm" variant="quiet" className="fw-rcf-meta-fold" aria-label={t('details.more', { count: folded })} title={t('details.more', { count: folded })} onClick={() => setDetails(true)}>
                +{folded}
              </Button>
            )}
          </span>
        ) : undefined
      }
      status={slot.status ? <span className="fw-rcf-live">{slot.status}</span> : undefined}
      actions={
        <span className="fw-rcf-actions">
          {band.primary && <span className="fw-rcf-primary">{band.primary}</span>}
          {threadButton}
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
        {fields /* B-TH-280 */}
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
        <div className="fw-rcf-body">
          {children}
          {fields /* B-TH-280 */}
        </div>
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
            {frameKeysFor(pageRecord /* F-OP-206: All of <Customer>'s rows where the dock holds it */).map((entry) => (
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
