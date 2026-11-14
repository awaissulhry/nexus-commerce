'use client'

import { useCallback } from 'react'
import { useT } from '../../../../../lib/i18n/provider'
import type { WorkOrderCostRow } from '../../api'
import { CLOSE_NS } from '../../../../production/work-orders/close/model'
import { COSTING_NAMESPACE } from '../../model'
import { costStateOf, type CostState } from '../model'

/**
 * SCR-463 — the Status of Work orders: standard vs actual (design finance.costing sec:wos "status (open · closed W2b)"):
 * open (info), final once completed (success), closed (neutral: nothing changes on it any more but a reversal).
 */
export const COST_STATE_TONE: Readonly<Record<CostState, 'info' | 'success' | 'neutral'>> = Object.freeze({ open: 'info', final: 'success', closed: 'neutral' })

/** A status in words: open and final are Standard vs actual's, closed the close's (B-W2b-424). For the cells and the CSV. */
export function useCostStateWords(): (row: Pick<WorkOrderCostRow, 'final' | 'workOrder'>) => string {
  const t = useT(COSTING_NAMESPACE)
  const tc = useT(CLOSE_NS)
  return useCallback(
    (row) => {
      const state = costStateOf(row)
      return state === 'closed' ? tc('costState.closed') : t(`state.${state}`)
    },
    [t, tc],
  )
}
