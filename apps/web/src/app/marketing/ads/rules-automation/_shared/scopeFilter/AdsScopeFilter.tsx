'use client'

/**
 * The filter bar of the Bid, Keyword Harvest and Negative Targeting pages (2026-10-12; the Owner chose: a new bar like
 * the /products filters, more than one pick per list, filtered by the server, the same on the three pages). It sits under
 * the tab bar, above the tiles, and every number and row of the page follows it.
 *
 *   Filters                                                                                    Hide ▴
 *   Portfolio        Campaign         Ad group         Product
 *   [All ▾]          [2 selected ▾]   [All ▾]          [All ▾]
 *                                                                                              Clear
 *
 * The DS `FilterBar` (the /products panel) with four searchable multiselects; the lists, their narrowing and their
 * counts are `scopeFilterModel.scopeDimensions`. Hidden, its header says what is filtered and offers Clear. Open or
 * hidden is remembered for the person, per phone and desktop (a phone starts hidden: one "Show filters" button, the table
 * on the first screen). A list it cannot offer yet is held with the reason (read, or nothing in this market).
 *
 * 2026-10-26 (the Negative Targeting redesign, BRIEF D4) — optional, every other page unchanged: `layout="inline"` draws
 * the DS FilterBar in one row (a phone: one "Filters (n)" button and its sheet); `extraDimensions` are the page's own
 * fields after the four lists (Kind, Show), `extraActive` how many of them filter and `clearExtra` their address params,
 * so ONE Clear empties the whole bar in one address change. `scopeChips` says every pick as a removable chip's words
 * ("Campaign: Rain jacket | IT | Auto"), for the page's TokenChips under the bar.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { Banner, useNarrow } from '@/design-system/components'
import { FilterBar, type FilterBarLayout, type FilterDimension } from '@/design-system/patterns'
import { scopeDimensions, type ScopeDimension, type ScopeKey } from './scopeFilterModel'
import type { ScopeFilter } from './useScopeFilter'

const OPEN_KEY = 'nexus.ads.scopeFilter.open'

/** The person's last open / hidden on this kind of screen, or null (not chosen yet). */
function readOpen(phone: boolean): boolean | null {
  try {
    const v = window.localStorage.getItem(`${OPEN_KEY}.${phone ? 'phone' : 'desk'}`)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

/** One pick as a chip: "Campaign: Rain jacket | IT | Auto", and the words of its × ("Show every campaign, not only …"). */
export interface ScopeChip { key: ScopeKey; id: string; text: string; removeLabel: string }

/** Every pick of the four lists as a chip, in the bar's order; a pick the lists do not name yet shows by its id. PURE. */
export function scopeChips(lists: readonly ScopeDimension[]): ScopeChip[] {
  return lists.flatMap((d) => d.value.map((id) => {
    const name = d.options.find((o) => o.value === id)?.label ?? id
    return { key: d.key, id, text: `${d.label}: ${name}`, removeLabel: `Show every ${d.label.toLowerCase()}, not only ${name}` }
  }))
}

export function AdsScopeFilter({ filter, unfiltered = 'Rules', layout, extraDimensions, extraActive = 0, clearExtra }: {
  filter: ScopeFilter
  /** What this page filters itself (not the server), for the words when the lists are not read: "Rules", "Rules and sources". */
  unfiltered?: string
  /** The DS FilterBar's layout. Default `panel` (the Bid and Keyword Harvest pages, as they are). */
  layout?: FilterBarLayout
  /** The page's own fields after the four lists (Negative Targeting: Kind, Show). */
  extraDimensions?: readonly FilterDimension[]
  /** How many of `extraDimensions` filter now: added to the bar's count (Clear, the phone's "Filters (n)"). */
  extraActive?: number
  /** The page's own params that Clear empties too, in the same address change. */
  clearExtra?: Readonly<Record<string, string | null>>
}) {
  const phone = useNarrow()
  const [chosen, setChosen] = useState<boolean | null>(null)
  useEffect(() => { setChosen(readOpen(phone)) }, [phone])
  const open = chosen ?? !phone
  const onOpenChange = useCallback((next: boolean) => {
    setChosen(next)
    try { window.localStorage.setItem(`${OPEN_KEY}.${phone ? 'phone' : 'desk'}`, next ? '1' : '0') } catch { /* kept for this visit */ }
  }, [phone])

  const { picks, index, state, error, set, clear, count } = filter
  const lists = useMemo(() => scopeDimensions(picks, index, state, error), [picks, index, state, error])
  const dimensions = useMemo<FilterDimension[]>(() => [...lists.map((d): FilterDimension => ({
    key: d.key,
    label: d.label,
    kind: 'multiselect',
    options: d.options,
    value: d.value,
    onChange: (next: string[]) => set(d.key, next),
    placeholder: d.placeholder,
    searchable: true,
    heldReason: d.heldReason,
  })), ...(extraDimensions ?? [])], [lists, set, extraDimensions])

  return (
    <>
      {state === 'failed' && (
        <Banner tone="danger" title="Filter lists not read" action={<Button size="sm" variant="secondary" onClick={filter.retry}>Try again</Button>}>
          {error}{filter.active ? ` · ${unfiltered} show unfiltered until they are read.` : ''}
        </Banner>
      )}
      <FilterBar
        {...(layout ? { layout } : {})}
        dimensions={dimensions}
        activeCount={count + extraActive}
        onClear={() => clear(clearExtra)}
        open={open}
        onOpenChange={onOpenChange}
      />
    </>
  )
}
