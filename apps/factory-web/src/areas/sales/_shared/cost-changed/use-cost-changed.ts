'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { getCostSheet } from '../../../products/styles/api'
import { costChangesOf, sheetKeysOf, type CostLine, type CostSheetCells } from './model'

export interface CostChangedInput {
  api: ApiClient
  /** The document's company (the cost sheet is read for it). */
  companyId: string | null
  lines: readonly CostLine[]
  /** Read only where it shows: the cost grain held and the lines on screen. */
  enabled: boolean
}

/**
 * The cost sheets of a document's priced lines, read once per style revision while the lines are on screen (the cost grain;
 * a sheet the role may not read — costing.view — or that fails is left out: its lines show no mark), and how far each line's
 * cost moved since it was priced (B-W2b-380, XF6:02). Read again when the lines change.
 */
export function useCostChanged(input: CostChangedInput): ReadonlyMap<string, number | null> {
  const { api, companyId, lines, enabled } = input
  const wanted = useMemo(() => (enabled ? sheetKeysOf(lines) : []), [enabled, lines])
  const key = `${companyId ?? ''}|${wanted.map((entry) => entry.key).join(',')}`
  const [sheets, setSheets] = useState<ReadonlyMap<string, CostSheetCells>>(new Map())
  useEffect(() => {
    if (wanted.length === 0) return setSheets(new Map())
    let live = true
    void Promise.all(
      wanted.map((entry) =>
        getCostSheet(api, entry.styleId, entry.revisionId, companyId)
          .then((sheet) => [entry.key, sheet as CostSheetCells] as const)
          .catch(() => null),
      ),
    ).then((found) => live && setSheets(new Map(found.flatMap((entry) => (entry ? [entry] : [])))))
    return () => {
      live = false
    }
    // The key names the company and the revisions.
  }, [api, key])
  return useMemo(() => (enabled ? costChangesOf(lines, sheets) : new Map<string, number | null>()), [enabled, lines, sheets])
}
