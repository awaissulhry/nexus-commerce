'use client'

/**
 * RA.SB — the scope contract: which market, which grain, which dates.
 *
 * The operator asked to see statistics and take action by date range and by
 * portfolio / market / product / campaign, "without overcomplicating the UI".
 * Those are not four views and four date pickers on six pages — they are ONE
 * state, held in the URL, that every page in the section reads.
 *
 * ## Why the URL and not a context value
 *
 * `AdsPageHeader` has always held its date range in a local `useState` ("the
 * header owns the state for now"), so the range was per-page, unshareable, and
 * lost on refresh. Putting scope in the URL makes it bookmarkable, shareable,
 * survivable and back/forward-correct — and it is the same choice DPS.3 already
 * made when it moved the tab bar off `useState` so every tab became addressable.
 *
 * ## 🔴 Why the preset keys here are the SERVER's, not the DateRangePicker's
 *
 * `_shell/DateRangePicker.tsx` exports its own `DATE_PRESETS`, and they are a
 * DIFFERENT VOCABULARY from `ads-core/date-range.ts`'s `RangePreset`, which is
 * what the API actually resolves:
 *
 *   picker:  today yesterday thisWeek lastWeek thisMonth lastMonth last3m
 *            last12m last18m last24m thisQuarter lastQuarter latest7
 *            latest30 latest60
 *   server:  today yesterday last7 last14 last30 last90 wtd mtd last_month
 *            qtd ytd last_year lifetime custom window
 *
 * Only `today` and `yesterday` exist in both. `resolveRange`'s `default:` branch
 * falls back to `windowDays` (default **7**) for anything it does not recognise —
 * silently. So sending the picker's key would have made "Latest 30 days" return
 * SEVEN days of data under a 30-day label, and "Last 12 Months" the same. Two
 * further mismatches hide inside the names that look shared: the picker's
 * `thisWeek` starts **Sunday** while the server's `wtd` starts **Monday (ISO)**,
 * and the picker computes in **browser-local** time while the server anchors to
 * **Europe/Rome** because the daily fact tables are Rome calendar days stored at
 * UTC midnight.
 *
 * This is the fifth two-vocabularies defect in this programme (after EXACT/_EXACT,
 * the rule-tab filter word, expressionType vs isNegative, and the ToS-IS location
 * key), so the rule is stated rather than left to be rediscovered:
 *
 *   **The server owns the date vocabulary. The client sends a key it understands
 *   and NEVER its own computed dates for a preset, so Rome anchoring stays
 *   authoritative. Resolved dates for display come back in the response's
 *   `range` echo — they are never recomputed here.**
 *
 * A `custom` range is the one case the client supplies dates, which is exactly
 * the case `resolveRange` accepts them for.
 */

import { useCallback, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

// ── dates ────────────────────────────────────────────────────────────────

/** Keys are `ads-core/date-range.ts`'s `RangePreset`. Do not invent one here. */
export const SCOPE_PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'last14', label: 'Last 14 days' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'last90', label: 'Last 90 days' },
  { key: 'wtd', label: 'Week to date' },
  { key: 'mtd', label: 'Month to date' },
  { key: 'last_month', label: 'Last month' },
  { key: 'qtd', label: 'Quarter to date' },
  { key: 'ytd', label: 'Year to date' },
  { key: 'last_year', label: 'Last year' },
  { key: 'lifetime', label: 'Lifetime' },
] as const

export type ScopePreset = (typeof SCOPE_PRESETS)[number]['key'] | 'custom'

const PRESET_KEYS = new Set<string>(SCOPE_PRESETS.map((p) => p.key))

/**
 * 30 days, not the console's usual 7.
 *
 * Deliberate and stated so it reads as a decision rather than a drift: the unit
 * of activity on these pages is a RULE EXECUTION, and executions are sparse —
 * plenty of rules fire weekly or on a schedule. A 7-day default would show a
 * large share of the 51 with nothing to say and invite the reading that they are
 * broken. Every other console page keeps its own default; this is the one
 * section where the shorter window actively misleads.
 */
export const DEFAULT_PRESET: ScopePreset = 'last30'

export function presetLabel(preset: ScopePreset): string {
  return SCOPE_PRESETS.find((p) => p.key === preset)?.label ?? 'Custom range'
}

// ── grains ───────────────────────────────────────────────────────────────

/**
 * The grains you can narrow to WITHIN the chosen market.
 *
 * Market is deliberately NOT one of them. It is its own always-present control,
 * because it composes with every grain: "the DE view" is market=DE + account,
 * and "this portfolio in DE" is market=DE + portfolio. Modelling market as a
 * fifth grain would make those mutually exclusive and put two controls on screen
 * that mean the same thing — the overcomplication this bar exists to avoid.
 *
 * `account` is the absence of a narrowing, never a fabricated default.
 *
 * Measured reach (scripts/_ra1-grain.mts, prod 2026-08-10) — these are NOT
 * equivalent, and the UI must say so rather than imply parity:
 *   · campaign   220/220 campaigns
 *   · product    220/220 reachable via AdProductAd → AdGroup → Campaign
 *   · portfolio   72/220 — only 33%. 148 campaigns carry no portfolioId at all.
 */
export const SCOPE_GRAINS = [
  { key: 'account', label: 'Entire account', noun: 'account' },
  { key: 'portfolio', label: 'Portfolio', noun: 'portfolio' },
  { key: 'product', label: 'Product line', noun: 'product line' },
  { key: 'campaign', label: 'Campaign', noun: 'campaign' },
] as const

export type ScopeGrain = (typeof SCOPE_GRAINS)[number]['key']

const GRAIN_KEYS = new Set<string>(SCOPE_GRAINS.map((g) => g.key))

export interface AdsScope {
  /** Marketplace code, or '' meaning every connected market. */
  market: string
  grain: ScopeGrain
  /** The portfolio / product / campaign id when the grain needs one; null otherwise. */
  id: string | null
  preset: ScopePreset
  /** Only meaningful when preset === 'custom'. 'YYYY-MM-DD'. */
  start: string | null
  end: string | null
}

export const ACCOUNT_SCOPE: AdsScope = {
  market: '', grain: 'account', id: null, preset: DEFAULT_PRESET, start: null, end: null,
}

/** Read a scope out of URL params. Unknown values fall back rather than throw — a
 *  hand-edited or stale link must still render a page. */
export function parseScope(sp: URLSearchParams | ReadonlyURLSearchParamsLike): AdsScope {
  const get = (k: string) => sp.get(k) ?? ''
  const grainRaw = get('scope')
  const grain = (GRAIN_KEYS.has(grainRaw) ? grainRaw : 'account') as ScopeGrain
  const id = grain === 'account' ? null : (get('id') || null)

  const presetRaw = get('preset')
  const start = get('start') || null
  const end = get('end') || null
  const preset: ScopePreset =
    presetRaw === 'custom' && start && end ? 'custom'
      : PRESET_KEYS.has(presetRaw) ? (presetRaw as ScopePreset)
        : DEFAULT_PRESET

  return {
    market: get('market'),
    // A grain that needs an id but has none is not that grain — it is the
    // account. Otherwise a stale ?scope=portfolio with no id would silently
    // filter to nothing and read as "no data".
    grain: grain !== 'account' && !id ? 'account' : grain,
    id,
    preset,
    start: preset === 'custom' ? start : null,
    end: preset === 'custom' ? end : null,
  }
}

/** Minimal structural type so this file does not import Next's readonly params type. */
interface ReadonlyURLSearchParamsLike { get(name: string): string | null }

/** The scope as URL params — only what differs from the default, so a plain page
 *  URL stays clean and shareable. */
export function scopeToParams(scope: AdsScope): URLSearchParams {
  const p = new URLSearchParams()
  if (scope.market) p.set('market', scope.market)
  if (scope.grain !== 'account' && scope.id) { p.set('scope', scope.grain); p.set('id', scope.id) }
  if (scope.preset !== DEFAULT_PRESET) p.set('preset', scope.preset)
  if (scope.preset === 'custom' && scope.start && scope.end) { p.set('start', scope.start); p.set('end', scope.end) }
  return p
}

/**
 * The query string every data fetch in this section appends.
 *
 * Emits the SERVER's parameter names (`preset` / `startDate` / `endDate` /
 * `marketplace`), so a caller can hand the result straight to
 * `GET /advertising/*` and `resolveRange` will understand every key.
 *
 * `grain`/`id` are emitted as `scopeGrain`/`scopeId`. Endpoints that do not yet
 * understand them ignore them — but they must never be silently dropped by this
 * function, or a page would request account-wide data and label it "portfolio".
 */
export function scopeToQuery(scope: AdsScope): string {
  const p = new URLSearchParams()
  if (scope.market) p.set('marketplace', scope.market)
  if (scope.preset === 'custom' && scope.start && scope.end) {
    p.set('preset', 'custom')
    p.set('startDate', scope.start)
    p.set('endDate', scope.end)
  } else {
    p.set('preset', scope.preset)
  }
  if (scope.grain !== 'account' && scope.id) {
    p.set('scopeGrain', scope.grain)
    p.set('scopeId', scope.id)
  }
  return p.toString()
}

/** Stable key for memo/cache deps — changes exactly when the scope does. */
export function scopeKey(scope: AdsScope): string {
  return `${scope.market}|${scope.grain}|${scope.id ?? ''}|${scope.preset}|${scope.start ?? ''}|${scope.end ?? ''}`
}

// ── the hook ─────────────────────────────────────────────────────────────

export interface UseAdsScope {
  scope: AdsScope
  /** Patch one or more fields; the rest are preserved. Writes the URL. */
  setScope: (patch: Partial<AdsScope>) => void
  /** Ready-made query string for a data fetch. */
  query: string
  key: string
}

/**
 * The one reader of scope. Every page in the section uses this and keeps NO copy
 * of market, grain or dates — that single source is the whole of the
 * "everything stays in sync" requirement: not a push channel, but a value
 * nothing shadows.
 *
 * Requires a Suspense boundary above it (it reads `useSearchParams`), which the
 * section's pages already provide for `?tab=`.
 */
export function useAdsScope(): UseAdsScope {
  const sp = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const scope = useMemo(() => parseScope(sp), [sp])

  const setScope = useCallback((patch: Partial<AdsScope>) => {
    const next: AdsScope = { ...scope, ...patch }
    // Changing grain without naming a target returns to the account rather than
    // leaving a dangling id from the previous grain pointing at the wrong table.
    if (patch.grain != null && patch.id === undefined && patch.grain !== scope.grain) next.id = null
    if (next.grain === 'account') next.id = null

    const params = scopeToParams(next)
    // Preserve every param this bar does not own (?tab=, filters, a drawer id).
    sp.forEach((v, k) => {
      if (!['market', 'scope', 'id', 'preset', 'start', 'end'].includes(k)) params.set(k, v)
    })
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [scope, sp, router, pathname])

  return {
    scope,
    setScope,
    query: useMemo(() => scopeToQuery(scope), [scope]),
    key: useMemo(() => scopeKey(scope), [scope]),
  }
}
