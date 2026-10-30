import type { QueueItem } from './model'

/**
 * Safe app updates (PLT-241; B-W2a-42; design floor.sync "A new version waits for this queue to empty"): the floor app
 * on a tablet runs the version its page was served with (the floor layout writes it in); every few minutes, when the
 * tablet comes back into view and after a send, it asks the server which version it serves now (`/floor/version`). A
 * newer one is put on only when NOTHING can be lost:
 *
 *   1. the offline queue is empty — no action waiting or due again (a refusal that may pass later), no send in flight:
 *      a queued scan is never at risk, whatever the next version does with the tablet's storage;
 *   2. the network is there — the floor app has no offline shell yet (B-W0-30 gap): a reload offline would not open;
 *   3. the screen holds nothing typed — Home, sign-in, the queue screen or enrolment (a task screen half filled in waits
 *      until the person is done or signed out by the idle timer).
 * Then the page reloads once for that version (a second reload for the same version is never tried: a cache that keeps
 * serving the old page cannot make the tablet loop). Pure rules plus a small watcher; the floor app wires it.
 */

export const FLOOR_VERSION_PATH = '/floor/version'
/** How often a tablet asks for the version while the app is open. */
export const VERSION_CHECK_MS = 5 * 60_000
/** The screens a reload may happen on: nothing typed is lost there. */
export const RESTING_PATHS: readonly string[] = ['/floor', '/floor/sign-in', '/floor/sync', '/floor/enrol']

export type UpdateStep = 'none' | 'waitQueue' | 'waitNetwork' | 'waitScreen' | 'apply'

/** Actions still to send from this tablet (anyone's): waiting, or refused but due again. The device report's count too. */
export const queuedCount = (items: readonly QueueItem[]): number => items.filter((item) => item.state === 'waiting' || (item.state === 'refused' && item.refusal !== null && !item.refusal.final)).length

export function updateStep(input: { running: string; latest: string | null; queued: number; sending: boolean; online: boolean; path: string; triedFor?: string | null }): UpdateStep {
  if (!input.latest || input.latest === input.running || input.triedFor === input.latest) return 'none'
  if (input.queued > 0 || input.sending) return 'waitQueue'
  if (!input.online) return 'waitNetwork'
  if (!RESTING_PATHS.includes(input.path)) return 'waitScreen'
  return 'apply'
}

export interface UpdateSnapshot {
  /** The version this page runs. */
  readonly running: string
  /** The server's version at the last check (null: not asked yet, or no answer). */
  readonly latest: string | null
  readonly checkedAt: string | null
  /** The version a reload was already tried for (kept for the tab's life). */
  readonly triedFor: string | null
}

export interface UpdaterOptions {
  readonly fetchLatest?: () => Promise<string | null>
  readonly now?: () => Date
  /** Where the tried version is kept across the reload (sessionStorage in the browser). */
  readonly memory?: { get(): string | null; set(value: string): void }
  readonly reload?: () => void
}

const TRIED_KEY = 'nexus-floor-update-tried'

function sessionMemory(): UpdaterOptions['memory'] {
  return {
    get: () => {
      try {
        return globalThis.sessionStorage?.getItem(TRIED_KEY) ?? null
      } catch {
        return null
      }
    },
    set: (value) => {
      try {
        globalThis.sessionStorage?.setItem(TRIED_KEY, value)
      } catch {
        // A browser that refuses storage: at worst one more reload later.
      }
    },
  }
}

async function fetchVersion(): Promise<string | null> {
  try {
    const answer = await fetch(FLOOR_VERSION_PATH, { cache: 'no-store', credentials: 'same-origin' })
    if (!answer.ok) return null
    const body = (await answer.json()) as { version?: unknown }
    return typeof body.version === 'string' && body.version !== '' ? body.version : null
  } catch {
    return null
  }
}

export class AppUpdater {
  private snapshot: UpdateSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly fetchLatest: () => Promise<string | null>
  private readonly now: () => Date
  private readonly memory: NonNullable<UpdaterOptions['memory']>
  private readonly doReload: () => void

  constructor(running: string, options: UpdaterOptions = {}) {
    this.fetchLatest = options.fetchLatest ?? fetchVersion
    this.now = options.now ?? (() => new Date())
    this.memory = options.memory ?? sessionMemory()!
    this.doReload = options.reload ?? (() => globalThis.location?.reload())
    this.snapshot = { running, latest: null, checkedAt: null, triedFor: this.memory.get() }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): UpdateSnapshot => this.snapshot

  /** Asks the server once; no answer keeps what was known. */
  async check(): Promise<void> {
    const latest = await this.fetchLatest()
    if (latest === null) return
    this.snapshot = { ...this.snapshot, latest, checkedAt: this.now().toISOString() }
    for (const listener of this.listeners) listener()
  }

  /** Puts the new version on (the caller checked updateStep says `apply`): once per version. */
  apply(): void {
    const latest = this.snapshot.latest
    if (!latest || latest === this.snapshot.running || this.snapshot.triedFor === latest) return
    this.memory.set(latest)
    this.snapshot = { ...this.snapshot, triedFor: latest }
    this.doReload()
  }
}
