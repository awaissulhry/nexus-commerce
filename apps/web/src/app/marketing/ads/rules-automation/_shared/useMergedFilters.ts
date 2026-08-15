'use client'

/**
 * FB.2 — one filter state, split between the URL and the page.
 *
 * The merged bar holds two kinds of control that used to live in two places:
 *
 *   · **URL-backed** — scope grains and the server-side chips. These are what a link has to
 *     reproduce, and the page already owns them as query params.
 *   · **Page-local** — the numeric ranges (Spend, ACoS, Clicks…). These were `AdsDataGrid`'s own
 *     state and stay that way in spirit; the page just holds them now, because one bar means one
 *     state object.
 *
 * `AdsFilterBar` sees a single `FilterState` and cannot tell the two apart, which is the point: the
 * operator sets a portfolio and a spend range in the same panel, with one Clear.
 *
 * 🔴 The URL is the SOURCE for its own keys, never a copy of them. `merged` spreads `urlValues`
 * LAST, so a back-button navigation wins over whatever the panel last emitted. Mirroring URL keys
 * into local state instead would give one value two owners, and the loser shows up as a control
 * that snaps back a tick after you set it.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { FilterState } from '../../campaigns/_grid/AdsDataGrid'

export function useMergedFilters({ urlValues, onUrlChange }: {
  /** the `__`-keyed values currently in the URL — the page builds this from `useSearchParams`.
   *  Multiselects live here as ARRAYS, the shape `MultiSelect` needs; the patch below joins them. */
  urlValues: FilterState
  /** the page's URL writer; receives every URL key as a STRING (arrays comma-joined, the spelling
   *  every page in this section already uses for a multi-valued param), with `''` when cleared */
  onUrlChange: (patch: Record<string, string>) => void
}): { filterState: FilterState; setFilterState: (next: FilterState) => void } {
  // Only the keys the URL does NOT own. Ranges, and any multiselect a page keeps off the address bar.
  const [local, setLocal] = useState<FilterState>({})

  const urlKey = JSON.stringify(urlValues)
  const urlRef = useRef(urlValues)
  urlRef.current = urlValues

  const filterState = useMemo<FilterState>(
    () => ({ ...local, ...urlValues }),
    // urlValues is rebuilt on every render by the page; key off its CONTENT, or this memo never hits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [local, urlKey],
  )

  const setFilterState = useCallback((next: FilterState) => {
    const owned = urlRef.current
    const patch: Record<string, string> = {}
    const rest: FilterState = {}
    for (const [k, v] of Object.entries(next)) {
      if (k in owned) patch[k] = Array.isArray(v) ? v.join(',') : typeof v === 'string' ? v : ''
      else rest[k] = v
    }
    // Clear sets `{}`, so a URL key that simply stopped being mentioned is being cleared, not left
    // alone. Saying so explicitly is what makes one Clear clear the whole bar.
    for (const k of Object.keys(owned)) if (!(k in patch)) patch[k] = ''
    setLocal(rest)
    // Typing in a range input calls this on every keystroke with the URL keys untouched. Writing an
    // identical address bar each time is a navigation the operator did not ask for, so only write
    // when a URL-owned value actually moved.
    const asString = (v: unknown) => (Array.isArray(v) ? v.join(',') : typeof v === 'string' ? v : '')
    const moved = Object.entries(patch).some(([k, v]) => v !== asString(owned[k]))
    if (moved) onUrlChange(patch)
  }, [onUrlChange])

  return { filterState, setFilterState }
}
