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
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { Banner, useNarrow } from '@/design-system/components'
import { FilterBar, type FilterDimension } from '@/design-system/patterns'
import { scopeDimensions } from './scopeFilterModel'
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

export function AdsScopeFilter({ filter, unfiltered = 'Rules' }: {
  filter: ScopeFilter
  /** What this page filters itself (not the server), for the words when the lists are not read: "Rules", "Rules and sources". */
  unfiltered?: string
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
  const dimensions = useMemo<FilterDimension[]>(() => lists.map((d) => ({
    key: d.key,
    label: d.label,
    kind: 'multiselect',
    options: d.options,
    value: d.value,
    onChange: (next: string[]) => set(d.key, next),
    placeholder: d.placeholder,
    searchable: true,
    heldReason: d.heldReason,
  })), [lists, set])

  return (
    <>
      {state === 'failed' && (
        <Banner tone="danger" title="Filter lists not read" action={<Button size="sm" variant="secondary" onClick={filter.retry}>Try again</Button>}>
          {error}{filter.active ? ` · ${unfiltered} show unfiltered until they are read.` : ''}
        </Banner>
      )}
      <FilterBar
        dimensions={dimensions}
        activeCount={count}
        onClear={() => clear()}
        open={open}
        onOpenChange={onOpenChange}
      />
    </>
  )
}
