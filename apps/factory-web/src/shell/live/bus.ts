/**
 * B-W2b-05 (COL-077, the W2a follow-up "one live bus per browser tab"): ONE connection to the live stream per browser
 * tab (`GET /live` through this app's `/api`, server-sent events), shared by the bell, the badges and every screen that
 * listens — before this, the bell and each page opened their own EventSource (B-W2a-40 note).
 *
 * The stream sends a small "record changed" hint per event the viewer may see (`event: change`, `data: {type, subject,
 * companyId, siteId, occurredAt, fields}`), a `ready` when the subscription is live, and pings. A hint is never data: a
 * screen reads the part again. Nothing is replayed, so after a break every listener is told to read everything again
 * (`resync`), and while the stream stays down the bus keeps ONE fallback poll for the whole tab: every `pollMs` it tells
 * every listener to read again (design 00 §1.6: "No page polls; the shell keeps one fallback poll while the channel is
 * down"). The connection opens with the first listener and closes with the last; the Office shell holds one listener for
 * as long as it is mounted, so an Office tab keeps exactly one stream.
 *
 * The state in words is the frame's (design shell.frame h.status): `connecting`, `live`, `offline` (the browser's
 * EventSource reconnects by itself; until `ready` comes again the tab is offline).
 */

/** What a listener receives: one hint. `companyId` and `siteId` are the record's, when it has them. */
export interface LiveChange {
  type: string
  fields: Record<string, unknown>
  companyId?: string | null
  siteId?: string | null
}

export type LiveState = 'connecting' | 'live' | 'offline'

export interface LiveListener {
  onChange?: (change: LiveChange) => void
  /** Read everything again: the stream came back after a break, or the fallback poll while it is down. */
  onResync?: () => void
}

/** The parts of the browser's EventSource the bus uses (a test passes its own). */
export interface LiveSource {
  readonly readyState: number
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void
  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void
  close(): void
}

export interface LiveBusOptions {
  /** Opens the stream; null: no stream in this environment (a server render, an old browser): the bus stays offline. */
  open: (() => LiveSource) | null
  /** The fallback poll while the stream is down (default 30 s). */
  pollMs?: number
  /**
   * How long the connection stays open after its last listener left (default 1 s): a page that replaces another, or
   * React's development double mount, takes it over instead of opening a new one. 0: closes at once.
   */
  graceMs?: number
  /** Timers (a test passes fake ones). */
  setInterval?: (run: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

export interface LiveBus {
  subscribe(listener: LiveListener): () => void
  state(): LiveState
  /** Called whenever the state changes (React's useSyncExternalStore). */
  watch(onState: () => void): () => void
  /** How many connections this bus opened in all (the live check counts one per tab). */
  opened(): number
}

/** A `change` message's data, or null when it is not one. */
export function parseLiveData(text: string): LiveChange | null {
  try {
    const value = JSON.parse(text) as unknown
    if (typeof value !== 'object' || value === null) return null
    const { type, fields, companyId, siteId } = value as { type?: unknown; fields?: unknown; companyId?: unknown; siteId?: unknown }
    if (typeof type !== 'string') return null
    return {
      type,
      fields: typeof fields === 'object' && fields !== null ? (fields as Record<string, unknown>) : {},
      companyId: typeof companyId === 'string' ? companyId : null,
      siteId: typeof siteId === 'string' ? siteId : null,
    }
  } catch {
    return null
  }
}

export const LIVE_POLL_MS = 30_000

export function createLiveBus(options: LiveBusOptions): LiveBus {
  const listeners = new Set<LiveListener>()
  const watchers = new Set<() => void>()
  const every = options.setInterval ?? ((run, ms) => globalThis.setInterval(run, ms))
  const stop = options.clearInterval ?? ((handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>))
  const pollMs = options.pollMs ?? LIVE_POLL_MS
  const graceMs = options.graceMs ?? 1000
  let source: LiveSource | null = null
  let closing: ReturnType<typeof setTimeout> | null = null
  let current: LiveState = options.open ? 'connecting' : 'offline'
  let readyOnce = false
  let poll: unknown = null
  let opened = 0

  const setState = (next: LiveState) => {
    if (next === current) return
    current = next
    // Down: one fallback poll for the tab; live again: the poll stops (the `ready` itself resyncs).
    if (next === 'live' && poll !== null) {
      stop(poll)
      poll = null
    } else if (next !== 'live' && poll === null && listeners.size > 0 && readyOnce) {
      poll = every(resyncAll, pollMs)
    }
    for (const watcher of [...watchers]) watcher()
  }
  const resyncAll = () => {
    for (const listener of [...listeners]) listener.onResync?.()
  }
  const onReady = () => {
    const again = readyOnce
    readyOnce = true
    setState('live')
    if (again) resyncAll()
  }
  const onChange = (event: MessageEvent<string>) => {
    const change = parseLiveData(event.data)
    if (!change) return
    for (const listener of [...listeners]) listener.onChange?.(change)
  }
  // The browser reconnects by itself (`retry: 5000`); until `ready` comes again the tab is offline. A closed source
  // (the server refused it) stays offline; the fallback poll keeps the screens fresh.
  const onError = () => setState('offline')

  const connect = () => {
    if (source || !options.open) return
    try {
      source = options.open()
    } catch {
      source = null
      setState('offline')
      return
    }
    opened += 1
    readyOnce = false
    setState('connecting')
    source.addEventListener('ready', onReady)
    source.addEventListener('change', onChange)
    source.addEventListener('error', onError)
  }
  const disconnect = () => {
    if (poll !== null) {
      stop(poll)
      poll = null
    }
    if (!source) return
    source.removeEventListener('ready', onReady)
    source.removeEventListener('change', onChange)
    source.removeEventListener('error', onError)
    source.close()
    source = null
    readyOnce = false
    current = options.open ? 'connecting' : 'offline'
    for (const watcher of [...watchers]) watcher()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (closing) {
        clearTimeout(closing)
        closing = null
      }
      connect()
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        if (graceMs <= 0) return disconnect()
        if (closing) clearTimeout(closing)
        closing = setTimeout(() => {
          closing = null
          if (listeners.size === 0) disconnect()
        }, graceMs)
      }
    },
    state: () => current,
    watch(onState) {
      watchers.add(onState)
      return () => watchers.delete(onState)
    },
    opened: () => opened,
  }
}

/** The tab's one bus: the browser's EventSource on `/api/live` (none during a server render). */
let tabBus: LiveBus | null = null
export function liveBus(): LiveBus {
  if (!tabBus) {
    tabBus = createLiveBus({
      open: typeof window !== 'undefined' && typeof EventSource !== 'undefined' ? () => new EventSource('/api/live') as unknown as LiveSource : null,
    })
    // Development builds only: the live check counts the tab's connections (never in a production build).
    if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') (window as unknown as { __nexusLiveBus?: LiveBus }).__nexusLiveBus = tabBus
  }
  return tabBus
}
