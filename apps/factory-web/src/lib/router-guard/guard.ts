/**
 * fx-12 (the customer page that reloaded itself, Owner's test server 2026-11-19): the guard over the Next router's own requests.
 *
 * What looped: a tab opened while the test server ran its build (`next start`) stayed open when the server switched to `next dev`
 * on the same address. That tab's router (the build's) cannot read a dev server's answer. With `experimental.useOffline` (on for
 * the floor tablets, B-W2b-F6: a move with the network gone waits instead of a full page load) Next 16 takes ANY request it cannot
 * read as "offline", asks the server whether it answers (a HEAD of the page), hears yes, and asks again at once: the four tabs of
 * the strip (prefetched by the build's router) were asked about 480 times each, two rounds a second, each a full server render of
 * the page, until the API answered 429. No address of ours was written in that loop: the address stayed the same throughout.
 *
 * The guard, installed once for every view (the root layout), wraps `window.fetch` and looks only at the router's requests (the
 * `rsc: 1` header; everything else passes untouched):
 *   - another build: the server says which it is (`x-factory-web-build`, next.config.ts headers: `dev` under `next dev`, `build`
 *     after `next build`); a router of the other one never hands such an answer to Next. From then on every router request of the
 *     tab is refused at once as an abort, before the network: Next does then what it does without `useOffline` — a navigation
 *     becomes a full page load (the server's own build arrives and the tab is whole again), a prefetch waits 10 s and asks the guard
 *     again (no request leaves the tab).
 *   - a router stuck on one address (any other answer Next keeps failing to read): the same address asked STUCK_COUNT times within
 *     STUCK_WINDOW_MS is refused the same way for STUCK_HOLD_MS (a navigation: a full page load; a prefetch: nothing sent).
 * An abort is the one failure Next never takes as "offline" (offline.ts checkOfflineError): the floor's real offline (a failed
 * connection) is left to Next as before.
 */

/** The header the server names its build with (next.config.ts). */
export const WEB_BUILD_HEADER = 'x-factory-web-build'

/** A build: the dev server's or the one `next build` made. */
export type WebBuild = 'dev' | 'build'

/** The build of this tab's code: what NODE_ENV was when it was compiled. */
export const webBuildOf = (nodeEnv: string | undefined): WebBuild => (nodeEnv === 'production' ? 'build' : 'dev')

/** The same address this many times within the window: the router is stuck (a normal page asks an address once or twice). */
export const STUCK_COUNT = 12
export const STUCK_WINDOW_MS = 10_000
/** How long a stuck address is refused before the router may ask the server again. */
export const STUCK_HOLD_MS = 60_000

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]

/** The router's request (Next sends `rsc: 1` with every navigation, prefetch, refresh and connectivity check). */
export function isRouterRequest(input: FetchInput, init?: FetchInit): boolean {
  const own = init?.headers ? new Headers(init.headers) : null
  if (own?.get('rsc') === '1') return true
  return typeof Request !== 'undefined' && input instanceof Request && input.headers.get('rsc') === '1'
}

/** The address a router request is about: its path and terms without the router's own cache term (`_rsc`). */
export function routerTarget(input: FetchInput, origin: string): string {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const url = new URL(href, origin)
  url.searchParams.delete('_rsc')
  return `${url.pathname}${url.search}`
}

/** What the guard does with one router request. */
export type GuardStep = { readonly kind: 'send' } | { readonly kind: 'refuse'; readonly why: 'build' | 'stuck' }

/** The guard's memory for one tab: whether the server is of another build, and when each address was asked lately. */
export class RouterGuardState {
  private otherBuild = false
  private readonly asked = new Map<string, number[]>()
  private readonly held = new Map<string, number>()

  constructor(private readonly own: WebBuild) {}

  /** Before a router request leaves the tab. */
  before(target: string, now: number): GuardStep {
    if (this.otherBuild) return { kind: 'refuse', why: 'build' }
    const until = this.held.get(target)
    if (until !== undefined && now < until) return { kind: 'refuse', why: 'stuck' }
    if (until !== undefined) this.held.delete(target)
    const recent = (this.asked.get(target) ?? []).filter((at) => now - at < STUCK_WINDOW_MS)
    recent.push(now)
    this.asked.set(target, recent)
    if (recent.length >= STUCK_COUNT) {
      this.asked.delete(target)
      this.held.set(target, now + STUCK_HOLD_MS)
      return { kind: 'refuse', why: 'stuck' }
    }
    // Forget the addresses not asked lately (a long session asks many).
    if (this.asked.size > 200) for (const [key, times] of this.asked) if (times.every((at) => now - at >= STUCK_WINDOW_MS)) this.asked.delete(key)
    return { kind: 'send' }
  }

  /** After its answer arrived: true when the server is of another build (the answer must not reach the router). */
  after(served: string | null): boolean {
    if (served !== 'dev' && served !== 'build') return false
    if (served !== this.own) this.otherBuild = true
    return this.otherBuild
  }
}

/** The refusal Next reads as "not offline": an abort. */
const refusal = () => new DOMException('fx-12: the router guard refused this request', 'AbortError')

/**
 * Wraps the window's fetch with the guard (once; a second install keeps the first). Returns the undo (tests, a remount).
 */
export function installRouterGuard(win: Pick<Window, 'fetch' | 'location'>, own: WebBuild, now: () => number = Date.now): () => void {
  const raw = win.fetch as typeof fetch & { __fx12Guard?: true }
  if (raw.__fx12Guard) return () => {}
  const original = (input: FetchInput, init?: FetchInit) => raw.call(win, input, init)
  const state = new RouterGuardState(own)
  const guarded = (async (input: FetchInput, init?: FetchInit) => {
    if (!isRouterRequest(input, init)) return original(input, init)
    if (state.before(routerTarget(input, win.location.origin), now()).kind === 'refuse') throw refusal()
    const answer = await original(input, init)
    if (state.after(answer.headers.get(WEB_BUILD_HEADER))) {
      void answer.body?.cancel().catch(() => {})
      throw refusal()
    }
    return answer
  }) as typeof fetch & { __fx12Guard?: true }
  guarded.__fx12Guard = true
  win.fetch = guarded
  return () => {
    if (win.fetch === guarded) win.fetch = raw
  }
}
