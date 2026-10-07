'use client'

/**
 * The Information page's row order — the Matrix's (Owner, 2026-10-07, Option A).
 *
 * Reads the family the Matrix reads (`/studio/family`, on the market and language `familyReadScope` picks for both
 * pages) in its ORDER view — the same axes and axis values without the per-channel projection reads — and ranks this
 * page's rows with `familyRank`: the same axes (`familyAxes`) and the same rule (`orderByAxisValues`).
 *
 * - A product with no family (not a parent, no parent) has nothing to order: no read, the rank is ready at once.
 * - `settled` is false until the FIRST read answers. The page holds its rows until then, so they never move under a
 *   focused cell (AG keeps focus by row index: a re-order after the first paint would leave the cursor on another SKU).
 * - A failed read keeps the last order that was read; before any, the rows fall back to parent then SKU — what the
 *   Matrix shows then too — and `error` says so on the page.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import { useStudioProduct, useStudioScope } from '../contracts'
import { EMPTY_PROJECTIONS, type FamilyProjections } from '../variants/family/projections'
import { useFamilyProjections } from '../variants/family/useFamilyProjections'

import { familyRank, familyReadScope, type FamilyAxisColumn, type FamilyOrderRow } from './familyOrder'

export interface FamilyRankRead {
  /** Product id → place in the family order. */
  rank: ReadonlyMap<string, number>
  /** The first read has answered (or there is nothing to read). Until then the page holds its rows. */
  settled: boolean
  /** The family order could not be read; the rows keep the last order read (parent then SKU before any). */
  error: string | null
  /** Read the family again — the page's Reload calls it, as the Matrix's Reload reads its family again. */
  reload: () => void
}

export function useFamilyRank(productId: string, rows: readonly FamilyOrderRow[], columns: readonly FamilyAxisColumn[] | undefined): FamilyRankRead {
  const product = useStudioProduct()
  const inFamily = product.isParent || !!product.parentId
  const { market, locale } = familyReadScope(useStudioScope())
  const { projections, loading, error, reload } = useFamilyProjections(inFamily ? productId : '', market, locale, 'order')
  /* A row added, deleted or imported changes the family: read it again, so a new variation takes its place at once.
     Not on every save — the family read builds a whole Shared sheet on the server. An empty list (the sheet between two
     reads) says nothing about the family and is skipped. */
  const members = useMemo(() => [...new Set(rows.map((r) => r.id))].sort().join('\n'), [rows])
  const seen = useRef('')
  useEffect(() => {
    if (!inFamily || !members || seen.current === members) return
    const known = seen.current
    seen.current = members
    if (known) reload()
  }, [inFamily, members, reload])
  const [answered, setAnswered] = useState(false)
  useEffect(() => { if (inFamily && !loading) setAnswered(true) }, [inFamily, loading])
  /* The last order that was read survives a failed re-read: `useFamilyProjections` clears to EMPTY on an error. */
  const lastRead = useRef<FamilyProjections>(EMPTY_PROJECTIONS)
  if (projections !== EMPTY_PROJECTIONS) lastRead.current = projections
  const source = projections === EMPTY_PROJECTIONS ? lastRead.current : projections
  const rank = useMemo(() => familyRank(source, columns ?? [], rows), [source, columns, rows])
  return { rank, settled: !inFamily || answered, error: inFamily ? error : null, reload }
}
