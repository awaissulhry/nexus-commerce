'use client'

/**
 * PES.1 — the runtime half of the frame's contract: the providers, and the hooks other lanes call.
 *
 * One import for a consuming lane (`import { useStudioScope } from '../contracts'`), and one place
 * where the studio's shared state actually lives. Nothing here reaches into a tab; every tab
 * reaches in here.
 *
 * State model, deliberate: scope · market · locale · tab · open record all live in the URL. A
 * studio link is therefore a coordinate someone can send to a colleague, reload, or walk back
 * through with the browser's own back button — which is also exactly what PES.4 asked for its
 * drawer. Scope controls use `replaceState`; product task navigation and opening a record use
 * `pushState`, so Back returns to the previous task without a history entry for every scope control.
 * They are history calls rather
 * than `router.*` because this route's server output does not depend on the query string — see
 * `flushUrl`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useSearchParams } from 'next/navigation'
import { usePathname, useRouter } from '@/lib/workspaces/navigation'
import { registerProfileChanges } from '@/lib/workspaces/unsaved-changes'

import { getBackendUrl } from '@/lib/backend-url'
import { streamsEnabled } from '@/lib/sync/dev-stream-gate'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { useListingEvents } from '@/lib/sync/use-listing-events'

import { readLastMarket, writeLastMarket } from './lastMarket'
import { primaryStudioAccount } from './accountScope'
import { useWorkspaceDestination, type DestinationState } from './useWorkspaceDestination'
import { createWorkspaceSaveStore } from './workspaceSave'
import { studioChannelViewPatch } from './navigationHref'
import { parseReadinessResponse } from './readiness'
import {
  leaveConfirmMessage,
  pendingWrites,
  shouldInterceptLeave,
} from './saveState'
import { isViewChipVisible } from './viewChips'
import {
  channelServesMarket,
  defaultLocaleFor,
  localeLabel,
  defaultMarket,
  historyStateIsInternal,
  deriveScopeOptions,
  tabAvailable,
} from './scopes'
import {
  MASTER_SCOPE,
  STUDIO_TABS,
  type MarketplaceLite,
  type SaveReporter,
  type ScopeReadinessQuery,
  type StudioCoordinate,
  type StudioFamily,
  type StudioProduct,
  type StudioRecordValue,
  type StudioSaveState,
  type StudioScopeId,
  type StudioScopeOptions,
  type StudioTabId,
  type ViewChip,
} from './types'

export * from './types'
export {
  EMPTY_VIEW_CHIP_CELLS,
  isViewChipVisible,
  viewChipColumns,
  viewChipCountLabel,
  viewChipHasCell,
  viewChipIsAlarm,
  viewChipRows,
} from './viewChips'
export {
  channelLabel,
  channelServesMarket,
  deriveScopeOptions,
  flattenGrouped,
  localeLabel,
  marketLabel,
} from './scopes'

/* ── URL plumbing ────────────────────────────────────────────────────────────────────────── */

const URL_KEYS = {
  scope: 'scope',
  market: 'market',
  locale: 'locale',
  tab: 'tab',
  record: 'rec',
  cell: 'cell',
  chip: 'chip',
} as const

/**
 * 🔴 Patch the keys you were given; never rewrite the ones you were not.
 *
 * The merged ads filter bar shipped a writer that applied "this value is the default, drop the
 * key" to EVERY key it held, so choosing a campaign silently deleted a live `?status=all` and
 * moved the grid back to Enabled without saying so (measured on prod, fixed in `6ec0d57ac` —
 * reference_one_filter_bar_merged_scope, Trap 1). This studio has six keys and five writers, which
 * is the same shape. So: start from what is in the URL, touch only what changed, and let
 * `undefined` mean "delete this one key".
 */
function patchSearch(current: URLSearchParams, patch: Record<string, string | undefined>): string {
  const next = new URLSearchParams(current.toString())
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === '') next.delete(k)
    else next.set(k, v)
  }
  return next.toString()
}

/* ── scope / market / locale / tab ───────────────────────────────────────────────────────── */

export interface StudioScopeValue {
  /** Editors with explicit Save can protect a scope change before their draft is unmounted. */
  registerScopeChangeGuard(guard: () => boolean): () => void
  /** Consult explicit-save editors before changing an in-workspace view. */
  canChangeEditor?(): boolean
  registerShopifyLocales?(accountId: string, locales: { locale: string; primary: boolean; published: boolean }[]): void
  accountId?: string
  listingId?: string
  destination: DestinationState
  scopeError: string | null
  setListing(id?: string): void
  setAccount(id: string): void
  accounts: NonNullable<MarketplaceLite['accounts']>
  /** `'master'` or a channel key. */
  scope: StudioScopeId
  market: string | null
  locale: string | null
  tab: StudioTabId
  /** `null` on master — master has no channel coordinate. */
  coordinate: StudioCoordinate | null
  /** Everything the marketplace table says exists. */
  options: StudioScopeOptions
  /** The rows the options were derived from, for a lane that needs a marketplace's own fields. */
  marketplaces: MarketplaceLite[]
  setScope(scope: StudioScopeId): void
  setMarket(code: string): void
  setLocale(code: string): void
  setTab(tab: StudioTabId, channel?: string): void
}

const ScopeCtx = createContext<StudioScopeValue | null>(null)

export function useStudioScope(): StudioScopeValue {
  const v = useContext(ScopeCtx)
  if (!v) throw new Error('useStudioScope() outside <StudioStateProvider>')
  return v
}

/* ── the product ─────────────────────────────────────────────────────────────────────────── */

const ProductCtx = createContext<StudioProduct | null>(null)
const FamilyCtx = createContext<StudioFamily | null>(null)

/** The family a variation belongs to, or `null` on a parent/standalone product (parity 1.29). */
export function useStudioFamily(): StudioFamily | null {
  return useContext(FamilyCtx)
}

/**
 * The record the studio is open on.
 *
 * The provider has always held this — it needs the id to ask for readiness — but never published
 * it, so every tab was re-deriving identity for itself and PES.2 had fallen back to
 * `useParams().id`. That is two sources for one fact, and the id is the cheap half: a lane that
 * re-derives it from the route has the id and NOT the sku, status or productType, so the next
 * thing it needs is a second fetch of a record the frame already loaded.
 *
 * Same one-definition rule as the readiness vocabulary — asked for by PES.2, 2026-09-01.
 */
export function useStudioProduct(): StudioProduct {
  const v = useContext(ProductCtx)
  if (!v) throw new Error('useStudioProduct() outside <StudioStateProvider>')
  return v
}

/* ── the open record (PES.4's drawer) ────────────────────────────────────────────────────── */

const RecordCtx = createContext<StudioRecordValue | null>(null)

export function useStudioRecord(): StudioRecordValue {
  const v = useContext(RecordCtx)
  if (!v) throw new Error('useStudioRecord() outside <StudioStateProvider>')
  return v
}

/* ── View-bar chips ──────────────────────────────────────────────────────────────────────── */

export interface ViewChipsValue {
  /** Registered chips that should be on screen, in registration order. */
  chips: ViewChip[]
  activeId: string | null
  /** The active chip, or `null` — including when the URL names one nobody registered. */
  active: ViewChip | null
  setActive(id: string | null): void
}

const ViewChipsCtx = createContext<ViewChipsValue | null>(null)

/**
 * The View bar's filtered views — `⚠ Missing required (7)`, `✦ AI drafts (3)`, and whatever comes
 * next.
 *
 * 🔴 The frame owns the REGISTRY, not the bar. The View bar is rendered inside the Sheet tab and
 * belongs to PES.2 (master) / PES.3 (channel); this is the mechanism they render, so that adding a
 * chip is one `useRegisterViewChip()` call from whichever lane owns the data — never a new control
 * in someone else's toolbar, and never a second bar.
 *
 * Selecting a chip is a VIEW, so it lives in the URL (`?chip=`) like every other piece of studio
 * state, and is single-select on purpose: two active chips would need union-or-intersection
 * semantics that nobody has specified, and guessing one would filter a sheet by a rule the operator
 * never chose.
 */
export function useViewChips(): ViewChipsValue {
  const v = useContext(ViewChipsCtx)
  if (!v) throw new Error('useViewChips() outside <StudioStateProvider>')
  return v
}

const RegisterCtx = createContext<((chip: ViewChip | null, id: string) => void) | null>(null)

/**
 * Publish a chip into the View bar. Pass `null` to withdraw one.
 *
 * ⚠ Memoise the chip. It is an effect dependency, so a fresh object literal every render
 * re-registers on every render — the same identity trap the grid's memoisation guard exists for.
 *
 * The producer owns the count and the cells: PES.2 derives `missing-required` from the sheet's own
 * readiness rows, PES.8 derives `ai-drafts` from `GET /api/products/ai/drafts`. The frame never
 * computes either — it has no rows.
 */
export function useRegisterViewChip(id: string, chip: ViewChip | null): void {
  const register = useContext(RegisterCtx)
  if (!register) throw new Error('useRegisterViewChip() outside <StudioStateProvider>')
  useEffect(() => {
    register(chip, id)
    return () => register(null, id)
  }, [register, chip, id])
}

/* ── autosave ────────────────────────────────────────────────────────────────────────────── */

interface SaveCtxValue {
  state: StudioSaveState
  reporter: SaveReporter
  manualMessage: string | null
  setManualMessage(message: string | null): void
}

const SaveCtx = createContext<SaveCtxValue | null>(null)
export function useManualSaveMessage(message: string | null) {
  const setter = useContext(SaveCtx)?.setManualMessage
  useEffect(() => { setter?.(message); return () => setter?.(null) }, [setter, message])
}
export function useStudioSaveMessage() { return useContext(SaveCtx)?.manualMessage ?? null }

/** What the header reads. */
export function useStudioSave(): StudioSaveState {
  const v = useContext(SaveCtx)
  if (!v) throw new Error('useStudioSave() outside <StudioStateProvider>')
  return v.state
}

/** What PES.2 / PES.3 call as each cell write leaves and lands. */
export function useSaveReporter(): SaveReporter {
  const v = useContext(SaveCtx)
  if (!v) throw new Error('useSaveReporter() outside <StudioStateProvider>')
  return v.reporter
}

function useSaveMachine(scopeKey: string): SaveCtxValue {
  const [, redraw] = useState(0)
  const [manualMessage, setManualMessage] = useState<string | null>(null)
  const store = useRef<ReturnType<typeof createWorkspaceSaveStore>>()
  if (!store.current) store.current = createWorkspaceSaveStore(() => redraw(n => n + 1))
  return { ...store.current.forScope(scopeKey), manualMessage, setManualMessage }
}

/* ── readiness ───────────────────────────────────────────────────────────────────────────── */

/**
 * When the footer starts saying "still measuring". Display only — the request continues.
 * A few seconds, per §3.6(4): long enough not to flash on a warm read, short enough that a cold one
 * does not look stalled.
 */
const SLOW_AFTER_MS = 4_000
/**
 * The only thing that reports FAILURE. Must sit above the measured cold worst case (§3.6(1)).
 *
 * ⚠ PROVISIONAL AND DELIBERATELY GENEROUS. What PES.5 established (2026-09-02):
 *
 * - **There is NO server-side timeout on this route.** It runs to completion however long the
 *   schema reads take, so this constant is the ONLY deadline in the system — there is no server
 *   number to sit just above.
 * - **A client abort does not cancel the server's work.** The query keeps running and warms the
 *   cache, which is why a retry after an abort looks fast for a reason that has nothing to do with
 *   the retry. So aborting buys almost nothing and can flatter a wrong diagnosis.
 * - **The cold cost is per (product-type set × market × channel-narrowing), cached in-process for
 *   5 minutes.** Not per session and not per product: an operator crossing markets on one product
 *   pays a cold read per market. The first read after any restart is the worst case by
 *   construction; there is no warm-up on boot.
 * - **The worst case is NOT yet known and must not be guessed.** BE.1 measured 62.8s; a genuinely
 *   cold read here measured 4.4s. A 14× disagreement between two honest measurements, and the 62.8
 *   may have landed inside the Neon outage window rather than reflecting a cold start — encoding it
 *   would make an outage the definition of "working slowly".
 * - **Any number measured before 2026-09-01 afternoon is measuring different code** — PES.5's
 *   per-channel column builds are now genuinely narrowed rather than five identical builds, so the
 *   ceiling must be re-derived after BE.1's dedupe lands.
 *
 * Until that measurement exists: an over-generous ceiling costs a skeleton, an under-generous one
 * reports a working system as broken. 15s already made that mistake once.
 */
const CEILING_MS = 180_000

const ReadinessCtx = createContext<ScopeReadinessQuery>({ status: 'loading' })

/**
 * Per-scope readiness for the current market.
 *
 * 🔴 The frame never computes a percentage. It has the product's identity and nothing else — no
 * schema, no required-field set, no channel caps — so any number it produced would be a guess
 * wearing a completeness label (feedback_100_percent_honest_ui). Until PES.5's endpoint answers,
 * this reports `unavailable` and the chips say so.
 */
export function useScopeReadiness(): ScopeReadinessQuery {
  return useContext(ReadinessCtx)
}

function useReadinessQuery(productId: string, market: string | null, nonce: number, channel?: string, accountId?: string, listingId?: string, locale?: string | null): ScopeReadinessQuery {
  const [query, setQuery] = useState<ScopeReadinessQuery>({ status: 'loading' })
  const queryCoordinate = JSON.stringify([productId, market, channel, accountId, listingId, locale])

  useEffect(() => {
    if (!market) {
      setQuery({ status: 'unavailable', reason: 'No market selected.' })
      return
    }
    let cancelled = false
    /*
     * Keep the last good answer across a REFRESH; discard it when the COORDINATE changes.
     *
     * A live-refresh re-read (same product, same market — the nonce moved) keeps its values on
     * screen and swaps them when the new ones land: otherwise every event blanks the chips, and
     * under a burst they never settle ⟦measured: three refetches in ~3s left every chip in
     * `loading`⟧.
     *
     * 🔴 But a market or product change is a DIFFERENT QUESTION, and the old answer is not a stale
     * version of the new one — it is the right answer to something else. Measured 2026-09-01:
     * switching IT → DE left `Amazon 71%` on screen for the whole of the new read, and 71% was
     * IT's number sitting under a bar that said DE. Showing a value under the wrong coordinate is
     * worse than showing no value, because nothing on screen says it is the wrong one.
     */
    const coordinate = queryCoordinate
    setQuery((prev) =>
      prev.status === 'ready' && prev.coordinate === coordinate ? prev : { status: 'loading' },
    )

    // Client-side on purpose: under RBAC enforce the Next server cannot read the API-origin
    // session cookie, so a server fetch comes back 401 (reference_rbac_enforce_ssr).
    const params = new URLSearchParams({ market })
    if (locale) params.set('locale', locale)
    if (channel) params.set('channel', channel)
    // Read every unambiguous account/market coordinate so scope chips and projection columns agree.
    if (listingId) params.set('listingId', listingId)
    if (accountId) params.set('accountId', accountId)
    const url = `${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/readiness?${params}`

    /*
     * 🔴 A DEADLINE IS NOT A FAILURE BOUNDARY (UX.1 §3.6, ruling #243).
     *
     * This used to abort at 15s and render "Readiness did not answer within 15s". BE.1 then measured
     * the COLD read at **62.8s** (1.49s warm) — so on every cold process the frame told the operator
     * the system was broken at the exact moment it was working slowly, and the message read as a
     * diagnosis because it named a real timeout. That is worse than the eternal skeleton it was
     * added to prevent: a skeleton says "not yet", a failure says "no".
     *
     * So the wait is bounded only where a wait stops being plausible. `SLOW_AFTER_MS` changes what
     * is DISPLAYED (the footer says it is still measuring) without touching the request;
     * `CEILING_MS` is the only thing that reports failure, and it sits far above the measured cold
     * worst case. A request that would still be useful is never aborted.
     *
     * ⚠ PROVISIONAL: 180s is generous by design, and the measurements below are why it stays that
     * way. Readings so far, each on a DIFFERENT starting state — they are not competing estimates
     * of one number, and averaging them would be meaningless:
     *
     *   62.8s  BE.1 — cold read (1.49s warm). The largest observed, and the one 180s is sized on.
     *   12.06s hub #273 — readiness as the FIRST request on a genuinely cold process.
     *   9.8–12.7s  hub #273 — other markets' sheet loads; so an operator's realistic worst case is
     *          at least 12–13s even away from a process start.
     *   4.11–4.86s hub #273 — cold for a MARKET on an already-warm process (four readings). This is
     *          the state my own 4.4s was taken in, which is why it agreed with these and not 12.06.
     *   0.256s / 1.49s  steady state. NEVER size a ceiling on this.
     *
     * The ceiling may tighten to roughly 3× the operator worst case once PES.5 measures DE/ES/FR —
     * but only if 62.8s is explicitly retired, because an unexplained outlier is still a reading.
     * Also still open with PES.5: whether ANY server-side timeout exists on the route. It does not
     * today, which makes this constant the only deadline in the whole system.
     */
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), CEILING_MS)
    const slowTimer = setTimeout(() => {
      // Display-only: the read is still in flight and still wanted.
      setQuery((prev) => (prev.status === 'loading' ? { status: 'loading', slow: true } : prev))
    }, SLOW_AFTER_MS)

    void (async () => {
      try {
        const res = await fetch(url, { cache: 'no-store', signal: abort.signal })
        if (cancelled) return
        if (res.status === 404) {
          setQuery({
            status: 'unavailable',
            reason: 'Readiness is not served yet (PES.5 owns GET /api/products/:id/readiness).',
          })
          return
        }
        if (!res.ok) {
          setQuery({ status: 'error', message: `Readiness request failed (${res.status}).` })
          return
        }
        const json: unknown = await res.json()
        if (cancelled) return
        setQuery({ status: 'ready', byScope: parseReadinessResponse(json), at: Date.now(), coordinate })
      } catch (e) {
        if (cancelled) return
        const timedOut = e instanceof DOMException && e.name === 'AbortError'
        setQuery({
          status: 'error',
          message: timedOut
            ? `Readiness did not answer within ${Math.round(CEILING_MS / 1000)}s.`
            : e instanceof Error
              ? e.message
              : 'Readiness request failed.',
        })
      } finally {
        clearTimeout(deadline)
        clearTimeout(slowTimer)
      }
    })()

    return () => {
      cancelled = true
      clearTimeout(deadline)
      clearTimeout(slowTimer)
      abort.abort()
    }
    // `nonce` is the live-refresh signal: bumping it re-runs this effect, which is how a
    // `listing.updated` event turns into a fresh readiness read.
  }, [productId, market, nonce, channel, accountId, listingId, locale, queryCoordinate])

  return query.status === 'ready' && query.coordinate !== queryCoordinate ? { status: 'loading' } : query
}

/* ── live refresh (parity 8.20) ──────────────────────────────────────────────────────────── */

/**
 * 🔴 The studio has to LEARN that the record changed under it.
 *
 * `/products/next` shipped a rebuild that dropped exactly this and looked complete, because the
 * markup matched and only the HOOKS were missing (reference_products_next_lost_live_refresh). The
 * old edit page kept one SSE pipe open for the whole page and let each tab subscribe; the studio
 * does the same, at the frame, so there is ONE pipe rather than one per tab.
 *
 * `useListingEvents()` is the pipe — it re-emits onto the invalidation channel, so PES.2/3/4/7 can
 * each `useInvalidationChannel(...)` for their own data without opening a second EventSource. The
 * frame refreshes only what the FRAME owns: readiness.
 *
 * Returns a nonce the readiness query depends on.
 */
function useLiveRefresh(productId: string): number {
  const [nonce, setNonce] = useState(0)

  /*
   * One pipe for the whole studio — and OFF by default against a local backend.
   *
   * Measured 2026-09-01: adding this pipe was what tipped `127.0.0.1:8091` over its six-connection
   * limit, and readiness — which had been fine minutes earlier — stopped completing at all. Proven
   * by removing the pipe: the same read went from hanging indefinitely to returning, chips and all.
   * A stream that starves the page it is meant to keep fresh is worse than no stream.
   *
   * `enableDevStreams(true)` in the console re-opens it for a live-refresh pass. Against a deployed
   * backend (HTTP/2) nothing changes — the gate returns true.
   */
  useListingEvents(streamsEnabled())

  // Coalesce a burst into ONE refetch. A bulk write, or another lane working against the same API,
  // emits many events in a second; readiness is a whole-product recompute and does not need to run
  // once per event to be current.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  useInvalidationChannel(
    ['product.updated', 'listing.updated', 'channel-pricing.updated'],
    (event) => {
      // A `product.updated` for a DIFFERENT product is not our business; listing/pricing events do
      // not carry a productId reliably, so those always re-pull (readiness is one cheap GET).
      if (event.type === 'product.updated' && event.id && event.id !== productId) return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        setNonce((n) => n + 1)
      }, 800)
    },
  )

  return nonce
}

/* ── in-flight write guard (parity 8.19) ─────────────────────────────────────────────────── */

/**
 * 🔴 Autosave does NOT make a navigation guard unnecessary — it changes what is at risk.
 *
 * The old page guarded UNSAVED edits. There are none here. But a per-cell autosave means writes are
 * IN FLIGHT, and leaving mid-flight loses them with no prompt and no trace. The state that says so
 * already exists (`{kind:'saving', pending:N}`), so the guard is nearly free.
 *
 * Two exits, because they are genuinely different events: `beforeunload` catches closing the tab,
 * reloading and leaving the origin; a capture-phase click catches an in-app `<a>`, which never fires
 * `beforeunload` at all. Missing the second is how "it only loses work when I click Products" bugs
 * happen.
 */
function useInFlightGuard(state: StudioSaveState): void {
  const profileGuardId = useId()
  // 🔴 `pendingWrites`, not `state.kind === 'saving'`. Found while extracting these decisions for
  // test: an ERROR state carries its own `pending`, so after a refusal the writes still in flight
  // were left unguarded by the original check — the moment an operator is most likely to navigate
  // away is right after seeing something go red.
  const pending = pendingWrites(state)
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  useEffect(() => registerProfileChanges(profileGuardId, {
    isDirty: () => pendingRef.current > 0,
    canDiscard: () => false,
    discard: () => { throw new Error('Wait for the product changes already being saved before switching profiles.') },
    save: async () => {
      const deadline = Date.now() + 30_000
      while (pendingRef.current > 0) {
        if (Date.now() > deadline) throw new Error('Product changes are still saving. Stay here and check their status before switching profiles.')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    },
  }), [profileGuardId])

  useEffect(() => {
    if (!pending) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Modern browsers show their own wording; returnValue is what still arms the prompt.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [pending])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      // Let the operator's own modifiers through: a ⌘-click opens a new tab and leaves this one —
      // and its in-flight writes — exactly where they are.
      const anchor = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      let dest: { origin: string; pathname: string } | null = null
      if (anchor) {
        try {
          const u = new URL(anchor.href, window.location.href)
          dest = { origin: u.origin, pathname: u.pathname }
        } catch {
          dest = null
        }
      }
      // Every exemption lives in `shouldInterceptLeave` (saveState.ts), where it is asserted.
      if (
        !shouldInterceptLeave({
          pending: pendingRef.current,
          defaultPrevented: e.defaultPrevented,
          button: e.button,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          anchorTarget: anchor?.target || null,
          href: anchor ? (anchor.getAttribute('href') ?? '') : null,
          dest,
          currentOrigin: window.location.origin,
          currentPathname: window.location.pathname,
        })
      ) {
        return
      }
      const ok = window.confirm(leaveConfirmMessage(pendingRef.current))
      if (!ok) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    // Capture phase: Next's Link handles the click on bubble, so a listener there would run too late.
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])
}

/* ── the provider ────────────────────────────────────────────────────────────────────────── */

export interface StudioStateProviderProps {
  product: StudioProduct
  family?: StudioFamily | null
  marketplaces: MarketplaceLite[]
  children: ReactNode
}

export function StudioStateProvider({ product, family = null, marketplaces, children }: StudioStateProviderProps) {
  const scopeChangeGuards = useRef(new Set<() => boolean>())
  const registerScopeChangeGuard = useCallback((guard: () => boolean) => {
    scopeChangeGuards.current.add(guard)
    return () => { scopeChangeGuards.current.delete(guard) }
  }, [])
  const canChangeEditor = useCallback(() => [...scopeChangeGuards.current].every(guard => guard()), [])
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()

  const baseOptions = useMemo(() => deriveScopeOptions(marketplaces), [marketplaces])
  const [shopifyLocales, setShopifyLocales] = useState<{ accountId: string; locales: { locale: string; primary: boolean; published: boolean }[] } | null>(null)
  const registerShopifyLocales = useCallback((accountId: string, locales: { locale: string; primary: boolean; published: boolean }[]) => {
    setShopifyLocales(old => old?.accountId === accountId && JSON.stringify(old.locales) === JSON.stringify(locales) ? old : { accountId, locales })
  }, [])

  // ── read the URL, then fall back — never the other way round.
  const marketParam = search.get(URL_KEYS.market)
  const market = useMemo(() => {
    if (marketParam && baseOptions.markets.some((m) => m.code === marketParam)) return marketParam
    return defaultMarket(baseOptions)
  }, [marketParam, baseOptions])


  const scopeParam = search.get(URL_KEYS.scope)
  const scope: StudioScopeId = useMemo(() => {
    if (!scopeParam || scopeParam === MASTER_SCOPE) return MASTER_SCOPE
    // A channel that no longer exists, or one this market does not serve, falls back to master
    // rather than leaving the bar pointing at a coordinate that cannot be read.
    if (!baseOptions.channels.some((c) => c.id === scopeParam)) return MASTER_SCOPE
    if (market && !channelServesMarket(scopeParam, market, baseOptions)) return MASTER_SCOPE
    return scopeParam
  }, [scopeParam, baseOptions, market])

  const accounts = useMemo(() => marketplaces.find(m => m.channel === scope)?.accounts ?? [], [marketplaces, scope])
  const listingId = search.get('listing') ?? undefined
  const requestedAccount = scope === MASTER_SCOPE ? undefined : search.get('account') ?? (listingId ? undefined : primaryStudioAccount(accounts)?.id)
  const destination = useWorkspaceDestination(product.id, scope, market, requestedAccount, listingId)
  const accountId = requestedAccount ?? (destination.status === 'ready' ? destination.data.accountId : undefined)
  const storeLocales = scope === 'SHOPIFY' && shopifyLocales && shopifyLocales.accountId === accountId ? shopifyLocales.locales : null
  const localeParam = search.get(URL_KEYS.locale)
  const supportedLanguages = useMemo(() => marketplaces.find(m => m.channel === scope && m.code === market)?.languages ?? [], [marketplaces, scope, market])
  const options = useMemo(() => storeLocales ? { ...baseOptions, locales: storeLocales.map(l => ({ code: l.locale, label: localeLabel(l.locale) + (l.primary ? ' · primary' : '') })) }
    : ['AMAZON', 'EBAY'].includes(scope) ? { ...baseOptions, locales: supportedLanguages.map(code => ({ code, label: localeLabel(code) })) } : baseOptions,
  [baseOptions, storeLocales, scope, supportedLanguages])
  const localeError = localeParam && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(localeParam) ? 'This content language is invalid. Choose a language.'
    : ['AMAZON', 'EBAY'].includes(scope) && localeParam && !supportedLanguages.includes(localeParam.toLowerCase()) ? `Choose a supported content language for this destination: ${supportedLanguages.join(', ')}.` : null
  const scopeError = scopeParam && scopeParam !== scope ? 'This channel is unavailable in the selected market. Choose an available scope.'
    : marketParam && marketParam !== market ? 'This market is unavailable. Choose an available market.'
    : scope === MASTER_SCOPE && listingId ? 'A listing needs its channel and market. Choose a channel scope to continue.' : localeError

  const locale = useMemo(() => {
    if (scope === 'SHOPIFY') return (localeParam ? storeLocales?.find(l => l.locale.toLowerCase() === localeParam.toLowerCase())?.locale ?? localeParam : null) ?? storeLocales?.find(l => l.primary)?.locale ?? (market ? defaultLocaleFor(market, marketplaces, scope === MASTER_SCOPE ? undefined : scope) : null)
    if (localeParam) return localeParam
    return market ? defaultLocaleFor(market, marketplaces, scope === MASTER_SCOPE ? undefined : scope) : null
  }, [localeParam, options, market, marketplaces, scope, storeLocales])

  /*
   * The tab is validated against the CURRENT SCOPE, not just against the list of ids.
   *
   * `errors` exists only on a channel, so two things must not happen: a shared link to
   * `?tab=errors` on master must not strand the session on a tab the strip does not render, and
   * switching from a channel back to master must not leave it selected. Resolving here — the one
   * place the URL is read — covers both without a second effect racing the first.
   */
  const tabParam = search.get(URL_KEYS.tab)
  const tab: StudioTabId =
    tabParam && STUDIO_TABS.includes(tabParam as StudioTabId) && tabAvailable(tabParam as StudioTabId, scope)
      ? (tabParam as StudioTabId)
      : 'sheet'

  /**
   * Looking around does not make history.
   *
   * Scope, market and locale are `replace`: they are the studio's equivalent of the merged
   * ads filter bar, where four chips and two switchers would otherwise stack six back-steps for one
   * act of orienting yourself (reference_one_filter_bar_merged_scope).
   */
  /*
   * 🔴 ONE navigation per tick, whatever calls it.
   *
   * Both writers used to build the next URL from the `search` snapshot captured at RENDER. Two
   * writes in the same tick therefore both patched the PRE-jump query string and the second silently
   * won: `setTab('sheet')` then `record.open(row)` produced `?rec=…` with the tab change gone,
   * leaving the operator on the wrong surface with a drawer open that had nothing to render it
   * (measured by PES.3, 2026-09-01).
   *
   * Ordering cannot fix that — both reads are stale from the same snapshot — and a combined
   * `openRecordInTab()` would only fix the one pair somebody happened to hit. So writes COALESCE:
   * each call merges its patch into a pending set, and one microtask later a single navigation
   * applies all of them to the freshest URL. Every present and future pair is correct by
   * construction, and no caller changes.
   *
   * `replace` vs `push` is decided by the union: if ANY write in the tick was a history write
   * (opening a record or changing product task), the batch is a history entry. Scope controls
   * still make none.
   */
  const searchRef = useRef(search.toString())
  searchRef.current = search.toString()
  const pendingPatch = useRef<Record<string, string | undefined> | null>(null)
  const pendingIsHistory = useRef(false)
  const flushQueued = useRef(false)
  /*
   * 🔴 Set TRUE on mount, not just false on cleanup.
   *
   * StrictMode runs effects mount → cleanup → mount. A flag that is only ever set to `false` by the
   * cleanup latches off after that first double-invoke and never comes back — which silently
   * disabled EVERY url write in dev while looking perfectly correct in the source.
   */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const flushUrl = useCallback(() => {
    flushQueued.current = false
    const patch = pendingPatch.current
    pendingPatch.current = null
    const asHistory = pendingIsHistory.current
    pendingIsHistory.current = false
    if (!patch || !alive.current) return
    const qs = patchSearch(new URLSearchParams(searchRef.current), patch)
    const url = qs ? `${pathname}?${qs}` : pathname
    /*
     * 🔴 `history.pushState`/`replaceState`, NOT `router.push`/`router.replace`.
     *
     * The studio's whole state is in the query string, and `page.tsx` never reads `searchParams` —
     * the server's output is byte-identical for every scope, market, locale, tab and chip. But
     * `router.replace()` issues an RSC request for the route regardless, and `page.tsx` is
     * `force-dynamic` with `await loadStudioData(id)`, so every one of those re-executed the server
     * component and its API fetches. FE.1 measured a single view-chip toggle — which only filters
     * rows already in memory — at one RSC request of 703ms/579ms.
     *
     * Next patches both history methods (`app-router.js`: `applyUrlFromHistoryPushReplace` →
     * `ACTION_RESTORE`) precisely so an app can move its own URL state without a server round-trip:
     * the canonical URL is updated and `usePathname`/`useSearchParams` re-render with the new
     * values, and nothing is fetched. This is App Router shallow routing.
     *
     * It also removes a remount the frame was paying for elsewhere: the RSC response replaced the
     * tree, so the sheet lost sort, selection and scroll on every scope switch, and the header
     * un-collapsed on a gesture that never touched the scroller.
     *
     * `scroll: false` is not needed and has no equivalent — these do not scroll at all, which was
     * the intent both `router` calls were passing that option to express.
     *
     * Back/forward still work: `pushState` writes a real entry, and Next's own popstate handler
     * restores it — that is the same `ACTION_RESTORE` path, so closing the drawer with Back does
     * not round-trip either.
     *
     * 🔴 Pass a FRESH `{}`. Never `window.history.state`, and never a state carrying `__NA`.
     *
     * This is the opposite of what the previous comment here claimed, and the correction cost the
     * programme a morning, so the citation matters more than the rule. From the installed
     * `next/dist/client/components/app-router.js`:
     *
     * ```js
     * window.history.pushState = function pushState(data, _unused, url) {
     *   if (data?.__NA || data?._N) {
     *     return originalPushState(data, _unused, url)   // ← early return
     *   }
     *   data = copyNextJsInternalHistoryState(data)
     *   if (url) applyUrlFromHistoryPushReplace(url)     // ← the ONLY thing that updates
     *   return originalPushState(data, _unused, url)     //   usePathname / useSearchParams
     * }
     * ```
     *
     * `__NA: true` is on every history entry Next writes. So passing `window.history.state` takes
     * the early return, and the URL moves while **nothing re-renders** — a chip that does nothing,
     * a drawer that does not reflect its own write, scope and market switching dead. The failure is
     * silent and it is not local: the URL is right, so the bug looks like it is in the consumer.
     *
     * `{}` falls through to the branch that matters: `copyNextJsInternalHistoryState` copies `__NA`
     * and `__PRIVATE_NEXTJS_INTERNALS_TREE` back in, so the entry ends up with Next's internals
     * intact AND the router's canonical URL updated. `null` behaves identically once patched (it is
     * normalised to `{}` there) — `{}` is preferred only because it says so at the call site.
     *
     * The pre-patch worry that motivated the wrong version is not reachable here: AppRouter installs
     * the patch in its own effect, and this flush is a queued microtask driven by a gesture or by a
     * mount effect, both of which run after the effect flush that installs it.
     */
    /*
     * A fresh object, every time. The guard below is dead code by construction TODAY — that is the
     * point: it fires the moment someone reintroduces `window.history.state` here, which has now
     * been written twice and looked correct both times.
     */
    const state: object = {}
    if (process.env.NODE_ENV !== 'production' && historyStateIsInternal(state)) {
      throw new Error(
        "flushUrl: the history state passed here carries Next's __NA/_N, so pushState takes its " +
          'early return, skips applyUrlFromHistoryPushReplace, and every studio URL write stops ' +
          're-rendering while the URL still moves. Pass a fresh {} (app-router.js, pushState).',
      )
    }
    if (asHistory) window.history.pushState(state, '', url)
    else window.history.replaceState(state, '', url)
  }, [pathname])

  const enqueue = useCallback(
    (patch: Record<string, string | undefined>, asHistory: boolean) => {
      // Later keys win over earlier ones in the same tick, including `undefined` (delete) — the
      // caller that ran last is the one that meant it.
      pendingPatch.current = { ...(pendingPatch.current ?? {}), ...patch }
      if (asHistory) pendingIsHistory.current = true
      if (!flushQueued.current) {
        flushQueued.current = true
        queueMicrotask(flushUrl)
      }
    },
    [flushUrl],
  )

  /**
   * Looking around does not make history.
   *
   * Scope, market and locale are `replace`: they are the studio's equivalent of the merged
   * ads filter bar, where four chips and two switchers would otherwise stack six back-steps for one
   * act of orienting yourself (reference_one_filter_bar_merged_scope).
   */
  const push = useCallback(
    (patch: Record<string, string | undefined>, asHistory = false) => {
      const current = new URLSearchParams(searchRef.current)
      const changingScope = Object.entries(patch).some(([key, value]) =>
        ['scope', 'market', 'locale', 'account', 'listing', 'tab'].includes(key) && (value || null) !== current.get(key))
      if (changingScope && !canChangeEditor()) return
      enqueue(patch, asHistory)
    },
    [enqueue, canChangeEditor],
  )

  /**
   * Opening a record IS a navigation, and gets a history entry.
   *
   * PES.4 asked for a drawer that survives reload AND back/forward, and `replace` cannot give them
   * the second half — it writes no entry, so Back would leave the studio entirely rather than close
   * the panel. Expanding a row is the one thing here that an operator expects Back to undo, which
   * is exactly the line between this and the controls above.
   */
  const pushHistory = useCallback(
    (patch: Record<string, string | undefined>) => enqueue(patch, true),
    [enqueue],
  )

  /*
   * First visit of a session, with no `?market=` in the URL: restore the market this operator last
   * worked in. See `lastMarket.ts` — the computed default is a five-way tie broken alphabetically,
   * which is not a fact about anybody's catalogue.
   *
   * Deliberately an effect and not part of the `useMemo` above: `localStorage` does not exist during
   * SSR, so reading it in render would make the server's HTML and the client's first paint disagree.
   * The correction lands one tick later, replaces rather than pushes, and only ever fires when the
   * URL was silent.
   *
   * Goes through `push` like every other writer. It used to call `router.replace` directly, which
   * made it the one write that could not be coalesced — and therefore the one that could still lose
   * a key to a same-tick write from a consumer's own mount effect.
   */
  useEffect(() => {
    if (marketParam) return
    const remembered = readLastMarket()
    if (!remembered || remembered === market) return
    if (!options.markets.some((m) => m.code === remembered)) return
    push({ [URL_KEYS.market]: remembered })
  }, [marketParam, market, options.markets, push])


  const setScope = useCallback(
    (next: StudioScopeId) => {
      // The open record belongs to the scope that opened it: a row id from the master sheet is not
      // a row in a channel's alias tree, so carrying it across would open the drawer on nothing.
      push({
        account: undefined, listing: undefined,
        [URL_KEYS.scope]: next === MASTER_SCOPE ? undefined : next,
        [URL_KEYS.locale]: ['AMAZON', 'EBAY'].includes(next) ? undefined : localeParam ?? undefined,
        [URL_KEYS.market]: next !== MASTER_SCOPE && market && !channelServesMarket(next, market, options)
          ? options.channels.find(c => c.id === next)?.markets[0] : market ?? undefined,
        [URL_KEYS.record]: undefined,
        [URL_KEYS.cell]: undefined,
        // A chip counts cells in the scope that produced it: "Missing required (7)" is seven eBay
        // cells, and carrying it to Master would show a count that belongs to another sheet.
        [URL_KEYS.chip]: undefined,
      })
    },
    [push, market, options, localeParam],
  )

  const setMarket = useCallback(
    (code: string) => {
      // Changing market can strand the active channel scope (eBay is not in every market) and
      // changes the content language a session is looking at. Both are resolved HERE, in one URL
      // write, rather than by a second effect that would land as a separate history state.
      const strands = scope !== MASTER_SCOPE && !channelServesMarket(scope, code, options)
      const nextLocale = defaultLocaleFor(code, marketplaces, scope === MASTER_SCOPE || strands ? undefined : scope)
      writeLastMarket(code)
      push({
        [URL_KEYS.market]: code,
        account: strands ? undefined : accountId,
        listing: undefined,
        [URL_KEYS.scope]: strands ? undefined : scopeParam ?? undefined,
        // Only re-default the locale when the operator had not pinned one.
        [URL_KEYS.locale]: ['AMAZON', 'EBAY'].includes(scope) ? nextLocale ?? undefined : localeParam ?? (nextLocale ?? undefined),
        [URL_KEYS.record]: undefined,
        [URL_KEYS.cell]: undefined,
        [URL_KEYS.chip]: undefined,
      })
    },
    [push, scope, scopeParam, localeParam, options, marketplaces, accountId],
  )

  const setAccount = useCallback((id: string) => push({ account: id, listing: undefined, [URL_KEYS.record]: undefined, [URL_KEYS.cell]: undefined, [URL_KEYS.chip]: undefined }), [push])
  const setListing = useCallback((id?: string) => push({ account: accountId, listing: id, [URL_KEYS.record]: undefined, [URL_KEYS.cell]: undefined, [URL_KEYS.chip]: undefined }), [push, accountId])
  const setLocale = useCallback((code: string) => push({ [URL_KEYS.locale]: code }), [push])
  const setTab = useCallback(
    (next: StudioTabId, channel?: string) => {
      if (channel !== undefined) {
        const destination = options.channels.find(option => option.id === channel)
        if (!destination || !tabAvailable(next, channel)) return
        if (next !== tab || channel !== scope) push(studioChannelViewPatch(scope, market, destination, next), true)
      } else if (next !== tab) push({ [URL_KEYS.tab]: next === 'sheet' ? undefined : next }, true)
    },
    [push, tab, scope, market, options.channels],
  )

  const coordinate = useMemo<StudioCoordinate | null>(
    () => (scope === MASTER_SCOPE || !market ? null : { channel: scope, marketplace: market, accountId }),
    [scope, market, accountId],
  )

  const scopeValue = useMemo<StudioScopeValue>(
    () => ({
      accountId, accounts, setAccount, registerScopeChangeGuard, canChangeEditor, registerShopifyLocales, listingId, destination, scopeError, setListing,
      scope,
      market,
      locale,
      tab,
      coordinate,
      options,
      marketplaces,
      setScope,
      setMarket,
      setLocale,
      setTab,
    }),
    [accountId, accounts, setAccount, registerScopeChangeGuard, canChangeEditor, registerShopifyLocales, listingId, destination, scopeError, setListing, scope, market, locale, tab, coordinate, options, marketplaces, setScope, setMarket, setLocale, setTab],
  )

  const rowId = search.get(URL_KEYS.record)
  const colKey = search.get(URL_KEYS.cell)
  // How many opens this session put on the history stack, so `close()` can step back off it rather
  // than pushing a second entry that Back would then walk straight into the open drawer again.
  const opened = useRef(0)
  const openRecord = useCallback(
    (id: string, cell?: string) => {
      opened.current += 1
      pushHistory({ [URL_KEYS.record]: id, [URL_KEYS.cell]: cell })
    },
    [pushHistory],
  )
  const closeRecord = useCallback(() => {
    if (opened.current > 0) {
      opened.current -= 1
      router.back()
      return
    }
    // Arrived with `?rec=` already in the URL (a shared link, a reload): there is no entry of ours
    // to pop, so drop the keys in place.
    push({ [URL_KEYS.record]: undefined, [URL_KEYS.cell]: undefined })
  }, [router, push])
  const recordValue = useMemo<StudioRecordValue>(
    () => ({ rowId, colKey, open: openRecord, close: closeRecord }),
    [rowId, colKey, openRecord, closeRecord],
  )

  /*
   * The chip registry. Producers upsert into it from their own tabs; order is registration order,
   * which is stable because it is the order the tabs mount their producers in.
   */
  const [chipMap, setChipMap] = useState<Record<string, ViewChip>>({})
  const [chipOrder, setChipOrder] = useState<string[]>([])
  const registerChip = useCallback((chip: ViewChip | null, id: string) => {
    setChipMap((prev) => {
      if (!chip) {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      }
      if (prev[id] === chip) return prev
      return { ...prev, [id]: chip }
    })
    setChipOrder((prev) => (chip ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)))
  }, [])

  const chipParam = search.get(URL_KEYS.chip)
  const chips = useMemo(
    () => chipOrder.map((id) => chipMap[id]).filter((c): c is ViewChip => !!c && isViewChipVisible(c, chipParam)),
    [chipOrder, chipMap, chipParam],
  )
  // A chip id in the URL that nobody has registered (a stale link, a chip whose producer is on
  // another tab) is NOT active. It is left in the URL untouched so that returning to the tab that
  // owns it restores the view rather than silently dropping it.
  const activeChip = useMemo(
    () => (chipParam ? (chips.find((c) => c.id === chipParam) ?? null) : null),
    [chipParam, chips],
  )
  const setActiveChip = useCallback(
    (id: string | null) => push({ [URL_KEYS.chip]: id ?? undefined }),
    [push],
  )
  const viewChips = useMemo<ViewChipsValue>(
    () => ({ chips, activeId: chipParam, active: activeChip, setActive: setActiveChip }),
    [chips, chipParam, activeChip, setActiveChip],
  )

  const save = useSaveMachine(JSON.stringify([product.id, scope, market, locale, accountId, listingId]))
  useInFlightGuard(save.state)
  const liveNonce = useLiveRefresh(product.id)
  const readiness = useReadinessQuery(product.id, scopeError || (scope !== MASTER_SCOPE && destination.status !== 'ready') ? null : market, liveNonce, scope === MASTER_SCOPE ? undefined : scope, accountId, listingId, locale)

  return (
    <ProductCtx.Provider value={product}>
      <FamilyCtx.Provider value={family}>
      <ScopeCtx.Provider value={scopeValue}>
        <RecordCtx.Provider value={recordValue}>
          <SaveCtx.Provider value={save}>
            <ReadinessCtx.Provider value={readiness}>
            <RegisterCtx.Provider value={registerChip}>
              <ViewChipsCtx.Provider value={viewChips}>{children}</ViewChipsCtx.Provider>
            </RegisterCtx.Provider>
          </ReadinessCtx.Provider>
          </SaveCtx.Provider>
        </RecordCtx.Provider>
      </ScopeCtx.Provider>
      </FamilyCtx.Provider>
    </ProductCtx.Provider>
  )
}
