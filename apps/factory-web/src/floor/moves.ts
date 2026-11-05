import { TASK_ROUTES } from './tasks/routes'

/**
 * A floor move with the network gone (B-W2b-F6). Every floor page is dynamic (the root layout reads a cookie), so a move asks the
 * server for its page. When that fetch fails, Next falls back to a full page load ("Falling back to browser navigation"), which
 * ends on the browser's error page: a kiosk tablet has no reload button. Three parts keep the worker on the floor:
 *
 *  - `FLOOR_PAGES` are prefetched whole while online (FloorApp), and `experimental.staleTimes.static` in next.config.ts keeps them
 *    for a day; a page once on screen, which Next does not prefetch, stays by its `unstable_dynamicStaleTime` (each page.tsx). A
 *    page is a thin shell around a client screen, so what is kept holds no data. A move between them needs no network;
 *  - `experimental.useOffline` makes Next wait for the network instead of that full page load;
 *  - `FloorMoves` is what the screens call for a page the tablet does not hold: the move that waits is taken back, so it cannot fire
 *    when the network returns, and the frame says why. No service worker and no offline shell (B-W0-30): a real reload offline
 *    still ends on the browser's error page.
 */

/** The pages a worker moves between: Home, every tile, and what the frame and the menu open. Enrol and the line TV are no moves. */
export const FLOOR_PAGES: readonly string[] = ['/floor', '/floor/scan', '/floor/sync', '/floor/notice', '/floor/sign-in', ...Object.values(TASK_ROUTES),
  // B-W2b-143: the safety data sheets at a cabinet (the cabinet QR, through Scan anything): no tile, held all the same.
  '/floor/sds']

/** While online the pages are asked for again this often: Next keeps what it holds, and fetches what went stale or failed. */
export const PREFETCH_EVERY_MS = 10 * 60_000
/** How long a tablet keeps a page (next.config.ts, each page.tsx); the test holds them equal. */
export const PAGE_STALE_SECONDS = 86_400
/** A move that has not landed by then asks whether the server answers: a slow answer is no reason to hold. */
export const MOVE_WAIT_MS = 900
export const REACHABLE_WAIT_MS = 1_500
/** The words stay this long; a person who tries again gets them again. */
export const HELD_SHOWN_MS = 8_000

export interface MoveDeps {
  readonly push: (path: string) => void
  readonly replace: (path: string) => void
  /** Where the screen is now (path and terms). */
  readonly at: () => string
  /** Whether the server answers. */
  readonly reachable: () => Promise<boolean>
  /** The frame says that this page opens when the network is back. */
  readonly held: (held: boolean) => void
}

export class FloorMoves {
  private waiting: { readonly from: string } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private shown: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: MoveDeps) {}

  readonly push = (path: string): void => this.go(path, 'push')
  readonly replace = (path: string): void => this.go(path, 'replace')

  /** The screen changed: the move landed. */
  readonly arrived = (): void => {
    this.stop()
    this.release()
  }

  private go(path: string, how: 'push' | 'replace'): void {
    this.stop()
    this.release()
    const from = this.deps.at()
    this.deps[how](path)
    if (from === path) return
    this.waiting = { from }
    this.wait()
  }

  private wait(): void {
    const move = this.waiting
    this.timer = setTimeout(() => void this.check(move), MOVE_WAIT_MS)
  }

  private async check(move: FloorMoves['waiting']): Promise<void> {
    const answers = await this.deps.reachable()
    if (this.waiting !== move || move === null) return
    if (answers) return this.wait()
    this.waiting = null
    // Back to where the screen is: the waiting move is dropped, and nothing jumps when the network returns.
    this.deps.replace(move.from)
    this.deps.held(true)
    this.shown = setTimeout(() => this.release(), HELD_SHOWN_MS)
  }

  private stop(): void {
    this.waiting = null
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private release(): void {
    if (this.shown !== null) clearTimeout(this.shown)
    this.shown = null
    this.deps.held(false)
  }
}

/** Whether the server answers: the WiFi may be up with the server out of reach, so `navigator.onLine` alone cannot say. */
export async function serverAnswers(): Promise<boolean> {
  if (!navigator.onLine) return false
  try {
    await fetch('/floor/version', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(REACHABLE_WAIT_MS) })
    return true
  } catch {
    return false
  }
}
