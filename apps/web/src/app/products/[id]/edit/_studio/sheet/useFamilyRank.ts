'use client'

/**
 * The Information page's row order — the Matrix's (Owner, 2026-10-07, Option A).
 *
 * Reads the same family read the Matrix reads (`useFamilyProjections`, on the market and language `familyReadScope` picks for
 * both pages) and ranks this page's rows with `familyRank`: the same axes (`familyAxes`) and the same
 * rule (`orderByAxisValues`). The Shared product page and every market page sort by this rank.
 *
 * Until the family read answers, or when it fails, the rank is built from no axes: the parent first, then the SKU —
 * what the Matrix shows in that moment too.
 */
import { useEffect, useMemo, useRef } from 'react'

import { useStudioScope } from '../contracts'
import { useFamilyProjections } from '../variants/family/useFamilyProjections'

import { familyRank, familyReadScope, type FamilyAxisColumn, type FamilyOrderRow } from './familyOrder'

export interface FamilyRankRead {
  /** Product id → place in the family order. */
  rank: ReadonlyMap<string, number>
  /** Read the family again — the page's Reload calls it, as the Matrix's Reload reads its family again. */
  reload: () => void
}

export function useFamilyRank(productId: string, rows: readonly FamilyOrderRow[], columns: readonly FamilyAxisColumn[] | undefined): FamilyRankRead {
  const { market, locale } = familyReadScope(useStudioScope())
  const { projections, reload } = useFamilyProjections(productId, market, locale)
  /* A row added, deleted or imported changes the family: read it again, so a new variation takes its place at once.
     Not on every save — the family read builds a whole Shared sheet on the server. An empty list (the sheet between two
     reads) says nothing about the family and is skipped. */
  const members = useMemo(() => [...new Set(rows.map((r) => r.id))].sort().join('\n'), [rows])
  const seen = useRef('')
  useEffect(() => {
    if (!members || seen.current === members) return
    const known = seen.current
    seen.current = members
    if (known) reload()
  }, [members, reload])
  const rank = useMemo(() => familyRank(projections, columns ?? [], rows), [projections, columns, rows])
  return { rank, reload }
}
