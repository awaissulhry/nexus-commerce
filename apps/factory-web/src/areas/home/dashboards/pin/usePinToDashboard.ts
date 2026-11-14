'use client'

import { useCallback, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { getBoards, getLayout, saveLayout, type DashboardKey } from '../api'
import { dashboardsHref, DEFAULT_ADDRESS, pinnableOf, readProblem, withPinned, writeProblem } from '../model'
import type { PinActions, PinModel } from './view/PinDialog'

/**
 * The container of "Save as dashboard" (follow-up DB1:01) for a W2b-5 report page: opened from the page's ⋯, it reads the
 * dashboards (mine first), and pins the chosen panels to my arrangement of the chosen dashboard on the server — the layout read
 * first and saved at its version, so a pin never drops what I arranged before. A report page renders `PinDialog` with this.
 */
export function usePinToDashboard(api: ApiClient, area: string, prefix: string): { model: PinModel; actions: PinActions; open: () => void } {
  const panels = pinnableOf(area)
  const closed: PinModel = { open: false, area, panels, boards: { status: 'loading' }, board: null, chosen: panels, busy: false, done: null, problem: null }
  const [model, setModel] = useState<PinModel>(closed)

  const open = useCallback(() => {
    setModel({ ...closed, open: true })
    getBoards(api)
      .then((answer) => setModel((current) => ({ ...current, boards: { status: 'ready', value: answer.boards }, board: answer.boards.find((entry) => entry.mine)?.key ?? answer.boards[0]?.key ?? null })))
      .catch((error: unknown) => setModel((current) => ({ ...current, boards: { status: 'error', problem: readProblem(error) } })))
    // `closed` is rebuilt each render from the same area and panels: opening always starts from it.
  }, [api, area])

  const pin = (board: DashboardKey, chosen: readonly string[]) => {
    setModel((current) => ({ ...current, busy: true, problem: null }))
    getLayout(api, board)
      .then((layout) => saveLayout(api, board, { panels: withPinned(layout.panels, chosen), version: layout.version }))
      .then(() => setModel((current) => ({ ...current, busy: false, done: dashboardsHref(prefix, { ...DEFAULT_ADDRESS, board }) })))
      .catch((error: unknown) => setModel((current) => ({ ...current, busy: false, problem: writeProblem(error) })))
  }

  return {
    model,
    open,
    actions: {
      onBoard: (board) => setModel((current) => ({ ...current, board, done: null, problem: null })),
      onChosen: (ids) => setModel((current) => ({ ...current, chosen: ids, done: null, problem: null })),
      onPin: () => (model.board ? pin(model.board, model.chosen) : undefined),
      onClose: () => setModel(closed),
    },
  }
}
