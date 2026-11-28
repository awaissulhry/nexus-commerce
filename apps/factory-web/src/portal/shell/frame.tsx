'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import type { MenuItemDef } from '@nexus/ui/components'
import type { TabItem } from '@nexus/ui/components'
import type { PromiseReasonCode } from '@nexus/factory-domain/sales/portal-orders/promise'
import type { LifeNote, OrderLife } from '@nexus/factory-domain/sales/order-life' // owb-po5.1: the nine life words
import { browserApi } from '../../lib/api/browser'
import type { HealthState } from '../../lib/production/model'
import type { ApiClient } from '../../lib/api/client'
import { createLiveBus, type LiveBus, type LiveChange, type LiveSource, type LiveState } from '../../shell/live/bus'
import type { MyAccess, PortalMe } from './api'
import type { PortalKind } from './nav/portal-nav'

/**
 * What every portal page reads from its frame (B-W2b-173): the session, the address prefix, the API client, the band it
 * fills, the unsaved-work guard it registers, and the tab's ONE live channel. Pages never build their own: they call these
 * hooks inside the portal layout.
 */

export interface PortalFrameValue {
  me: PortalMe
  /** `/p/<party code>`. */
  prefix: string
  kinds: readonly PortalKind[]
  /** The API for portal pages: same-origin `/api`, the CSRF header on writes; each answer moves the frame's idle clock. */
  api: ApiClient
  /** GET /portal/access once the frame read it: the role, what it allows, the end of access, the admins (null: not yet). */
  access: MyAccess | null
  /** Opens the conversation about a record (`Party` = the account), its composer focused (the ⋯ "Ask a question"). */
  ask: (record: { type: string; id: string; label?: string | null } | null) => void
  /** Reads the badges and the task list again (a page that answered a request). */
  refreshTasks: () => void
}

const FrameContext = createContext<PortalFrameValue | null>(null)

export function PortalFrameProvider({ value, children }: { value: PortalFrameValue; children?: ReactNode }) {
  return <FrameContext.Provider value={value}>{children}</FrameContext.Provider>
}

/** The portal session and its tools. Only inside the portal layout. */
export function usePortalFrame(): PortalFrameValue {
  const frame = useContext(FrameContext)
  if (!frame) throw new Error('usePortalFrame: outside the portal layout')
  return frame
}

// ---- F-SA-264: the record frame keeps its dock layout per signed-in person; outside the portal layout (a design case) nobody: null.
export function usePortalPersonId(): string | null {
  return useContext(FrameContext)?.me.user.id ?? null
}
// ---- end F-SA-264

/** The API client of a portal page. */
export const usePortalApi = (): ApiClient => usePortalFrame().api

/** The browser client for portal pages, telling `onCall` after each answer (the API slid the session's idle end then). */
export function portalBrowserApi(onCall: (at: number) => void): ApiClient {
  const api = browserApi()
  const told = <T,>(work: Promise<T>): Promise<T> =>
    work.then(
      (value) => {
        onCall(Date.now())
        return value
      },
      (error: unknown) => {
        // An answer (even a refusal) is a request the API saw; a network error is not.
        if ((error as { status?: number } | null)?.status) onCall(Date.now())
        throw error
      },
    )
  return {
    request: (method, path, options) => told(api.request(method, path, options)),
    get: (path, options) => told(api.get(path, options)),
    post: (path, options) => told(api.post(path, options)),
    bytes: (path, options) => told(api.bytes(path, options)),
  }
}

// ── the page band ────────────────────────────────────────────────────────────────────────────────────────────────────
export interface PortalBandAction {
  id: string
  label: string
  onClick?: () => void
  href?: string
  variant?: 'primary' | 'secondary'
  /** Why it cannot act now (held: focusable, says why). */
  heldReason?: string | null
}

/** One header per page (design portal.frame › band; anatomy §1.4): what a page puts in it. Unset: the navigation place. */
export interface PortalBand {
  title?: string | null
  back?: { href: string; label: string } | null
  /** Their reference first, ours second (RefPair). */
  refs?: { theirs?: string | null; ours?: string | null } | null
  /**
   * The lifecycle pill. owb-po5.1: an order (or a draft / sent request) names its life (`life` + `note`, the nine words): the shell
   * draws the SHARED StateChip (lib/order-cells, `{ life, note }`: the same chip as the orders sheet and the office); absent: the pill.
   */
  status?: { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; life?: OrderLife; note?: LifeNote | null } | null
  /** At most two; the primary last (on a phone it moves to the action bar above the bottom bar). */
  actions?: readonly PortalBandAction[]
  /** The ⋯ items; the frame ends them with "Ask a question" (about `ask`, else the account). */
  more?: readonly MenuItemDef[]
  /** Record pages: link tabs in a second row (counts, a problem mark). */
  tabs?: { items: TabItem[]; active: string; label: string } | null
  /** What "Ask a question" asks about (a record); absent: the account. */
  ask?: { type: string; id: string; label?: string | null } | null
  /** A read-only record: the notice's words key (the frame shows it in the notices' one banner). */
  readOnly?: { key: string; params?: Readonly<Record<string, string>> } | null
  /** The page's own keys, for the shortcuts dialog (`keys` as shown, words in the person's language). */
  keys?: readonly { keys: readonly string[]; words: string }[]
  /**
   * pp-w1 (w1.2; 10-design § 2): what follows the status pill on a record page, the office band's twins: the record's health, the
   * customer's own urgency and the record it was made from. Data only; absent: none (every other page draws as before).
   */
  chips?: PortalBandChips | null
  /**
   * pp-w1 (w1.1; 10-design § 4): the record frame's thread button before the ⋯ — "Messages (2 new)" while the conversation is not on
   * screen (hidden, or narrower with its view closed). Set by PortalRecordFrame (`usePortalBandThread`), never by a page.
   */
  thread?: PortalBandThread | null
  /**
   * owb-po5.1 (plan § 5i band: back · picture · title · chip · Chat · People · ONE primary): the order's picture before the title — the
   * shared RecordPicture from the frame's batch read; `onOpen` opens "The picture of the order" (null: a plain picture, no right to
   * change it). Data only; absent: no picture.
   */
  picture?: PortalBandPicture | null
  /**
   * owb-po6.4 (lead decision: the chat left the order page, design § 5d): the page has no docked conversation — the band's Chat opens
   * the top bar's panel at this record's chat (its new messages on the button). Absent: none (a page that docks keeps `thread`).
   */
  chat?: { readonly type: string; readonly id: string; readonly label: string | null } | null
  /** owb-po5.1: People — the order's people; absent or null: no button (no read of them yet: never a door to nowhere). */
  people?: { readonly count: number; readonly onOpen: () => void } | null
}

/** owb-po5.1: the band's picture button: whose picture (its record id, read by `customerOrder`), its name, and what a press does. */
export interface PortalBandPicture {
  readonly recordId: string
  /** owb-po6.4: whose batch read — an order's (default) or a Draft / Sent order's (`customerRequest`, web A's source). */
  readonly source?: 'customerOrder' | 'customerRequest'
  /** The record's name in words ("Your order 12"): the picture's name. */
  readonly number: string
  readonly onOpen: (() => void) | null
}

/** pp-w1 (w1.1): the band's thread button: the person's own new messages and what a click does (shows or opens the conversation). */
export interface PortalBandThread {
  readonly count: number
  readonly onClick: () => void
}

/** pp-w1 (w1.2): the band's chips. Customer-safe by shape: no note, no person, no amount. */
export interface PortalBandChips {
  /** Late or At risk only, never On track (the shared HealthPill, customer face): a person's raise carries its curated reason code only. */
  readonly health?: { readonly computed: HealthState | null; readonly raised?: { readonly reason: PromiseReasonCode } | null } | null
  /** "Urgent": the customer's own urgency, in the page's words; null: none. */
  readonly urgent?: string | null
  /** "Made from your request #7": its page, in the page's words; null: none. */
  readonly madeFrom?: { readonly href: string; readonly label: string } | null
}

type BandSetter = (band: PortalBand | null) => void
const BandContext = createContext<BandSetter | null>(null)
// pp-w1 (w1.1): the record frame's own part of the band (its thread button), set apart from the page's and drawn with it.
type BandThreadSetter = (thread: PortalBandThread | null) => void
const BandThreadContext = createContext<BandThreadSetter | null>(null)

export function PortalBandProvider({ set, children }: { set: BandSetter; children?: ReactNode }) {
  const page = useRef<PortalBand | null>(null)
  const thread = useRef<PortalBandThread | null>(null)
  const push = useCallback(() => set(page.current && thread.current ? { ...page.current, thread: thread.current } : page.current), [set])
  const setPage = useCallback<BandSetter>(
    (band) => {
      page.current = band
      push()
    },
    [push],
  )
  const setThread = useCallback<BandThreadSetter>(
    (next) => {
      thread.current = next
      push()
    },
    [push],
  )
  return (
    <BandContext.Provider value={setPage}>
      <BandThreadContext.Provider value={setThread}>{children}</BandThreadContext.Provider>
    </BandContext.Provider>
  )
}

/**
 * pp-w1 (w1.1): the record frame puts its thread button in the band (null takes it away; it leaves with the frame). The band is set
 * again only when the count or the button's presence changes; a click always reaches the frame's latest one.
 */
export function usePortalBandThread(thread: PortalBandThread | null): void {
  const set = useContext(BandThreadContext)
  const latest = useRef(thread)
  latest.current = thread
  const count = thread ? thread.count : null
  useEffect(() => {
    set?.(count === null ? null : { count, onClick: () => latest.current?.onClick() })
  }, [set, count])
  useEffect(() => () => set?.(null), [set])
}

/**
 * A page fills the frame's band with this (and it empties when the page leaves). The band is set again only when its data
 * changes; its callbacks always reach the page's latest ones (an action never runs a stale closure).
 */
export function usePortalBand(band: PortalBand | null): void {
  const set = useContext(BandContext)
  const latest = useRef(band)
  latest.current = band
  const key = JSON.stringify(band, (name, value) => (typeof value === 'function' ? `fn:${name}` : value))
  useEffect(() => {
    set?.(bandCalling(latest))
  }, [set, key])
  useEffect(() => () => set?.(null), [set])
}

/** The band with each callback calling the page's latest one, found by its id. */
export function bandCalling(latest: { readonly current: PortalBand | null }): PortalBand | null {
  const band = latest.current
  if (!band) return null
  return {
    ...band,
    ...(band.actions ? { actions: band.actions.map((action) => (action.onClick ? { ...action, onClick: () => latest.current?.actions?.find((next) => next.id === action.id)?.onClick?.() } : action)) } : {}),
    ...(band.more ? { more: band.more.map((item) => (item.onSelect ? { ...item, onSelect: () => latest.current?.more?.find((next) => next.id === item.id)?.onSelect?.() } : item)) } : {}),
    // owb-po5.1: the picture's and People's presses reach the page's latest ones too.
    ...(band.picture?.onOpen ? { picture: { ...band.picture, onOpen: () => latest.current?.picture?.onOpen?.() } } : {}),
    ...(band.people ? { people: { ...band.people, onOpen: () => latest.current?.people?.onOpen() } } : {}),
  }
}

// ── the unsaved-work guard (pop:unsaved-guard) ───────────────────────────────────────────────────────────────────────
export interface UnsavedGuard {
  /** There is typed work that leaving would lose. */
  dirty: boolean
  /** What would be lost, in one line in the person's language ("Your message to us is not sent yet."). */
  what: string
  /** Sends or saves it, when the page can do so from the dialog. */
  save?: (() => Promise<boolean>) | null
}

export interface GuardRegistry {
  register: (id: string, guard: UnsavedGuard | null) => void
}
const GuardContext = createContext<GuardRegistry | null>(null)

export function PortalGuardProvider({ registry, children }: { registry: GuardRegistry; children?: ReactNode }) {
  return <GuardContext.Provider value={registry}>{children}</GuardContext.Provider>
}

/** A page with typed work registers it: leaving through a link, the menu or the browser asks first. */
export function usePortalUnsaved(id: string, guard: UnsavedGuard): void {
  const registry = useContext(GuardContext)
  const latest = useRef(guard)
  latest.current = guard
  useEffect(() => {
    registry?.register(id, latest.current)
  }, [registry, id, guard.dirty, guard.what])
  useEffect(() => () => registry?.register(id, null), [registry, id])
}

// ── the live channel (one per tab: GET /portal/live) ─────────────────────────────────────────────────────────────────
let portalBus: LiveBus | null = null
/** The tab's one portal bus: the browser's EventSource on `/api/portal/live` (none during a server render). */
export function portalLiveBus(): LiveBus {
  if (!portalBus) {
    portalBus = createLiveBus({
      open: typeof window !== 'undefined' && typeof EventSource !== 'undefined' ? () => new EventSource('/api/portal/live', { withCredentials: true }) as unknown as LiveSource : null,
    })
  }
  return portalBus
}

/** A portal page listens to the tab's one live channel (hints only: it reads its part again). */
export function usePortalLive(handlers: { onChange?: (change: LiveChange) => void; onReconnect?: () => void }, enabled = true): LiveState {
  const latest = useRef(handlers)
  latest.current = handlers
  useEffect(() => {
    if (!enabled) return
    return portalLiveBus().subscribe({ onChange: (change) => latest.current.onChange?.(change), onResync: () => latest.current.onReconnect?.() })
  }, [enabled])
  return useSyncExternalStore(
    (onState) => portalLiveBus().watch(onState),
    () => portalLiveBus().state(),
    () => 'connecting' as LiveState,
  )
}
