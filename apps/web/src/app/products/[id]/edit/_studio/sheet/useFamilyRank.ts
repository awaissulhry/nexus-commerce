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
import { useMemo } from 'react'

import { useStudioScope } from '../contracts'
import { useFamilyProjections } from '../variants/family/useFamilyProjections'

import { familyRank, familyReadScope, type FamilyAxisColumn, type FamilyOrderRow } from './familyOrder'

export function useFamilyRank(productId: string, rows: readonly FamilyOrderRow[], columns: readonly FamilyAxisColumn[] | undefined): ReadonlyMap<string, number> {
  const { market, locale } = familyReadScope(useStudioScope())
  const { projections } = useFamilyProjections(productId, market, locale)
  return useMemo(() => familyRank(projections, columns ?? [], rows), [projections, columns, rows])
}
