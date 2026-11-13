'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { readProblem, type Phrase } from '../../../_shared/stock/model'
import { listSubstitutions, withdrawSubstitute } from './api'
import { askProblem, type SubCan } from './model'
import type { SubstitutesActions, SubstitutesModel } from './view/SubstitutesSection'

/**
 * B-W2b-320 — the Picking page's substitutes (container hook): the tile "Substitutes waiting for approval" (`GET
 * /inventory/substitutions` tiles, the site of the address) read with the page, the list behind it once opened (waiting
 * and approved, or all), and Withdraw N with one reason (one call each at the version read).
 */
export function useSubstitutes(api: ApiClient, options: { siteId: string | null; can: SubCan; open: boolean; focus: string | null; onChanged: () => void }) {
  const { siteId, can } = options
  const [waiting, setWaiting] = useState<number | null>(null)
  const [list, setList] = useState<Omit<SubstitutesModel, 'withdraw' | 'focus'>>({ status: options.focus ? 'ALL' : 'OPEN', rows: null, problem: null, more: false })
  const [withdraw, setWithdraw] = useState<SubstitutesModel['withdraw']>(null)

  const load = useCallback(
    async (status: 'OPEN' | 'ALL' = list.status) => {
      if (!can.view) return
      try {
        const answer = await listSubstitutions(api, { siteId, status: options.open ? status : 'WAITING', limit: options.open ? 200 : 1 })
        setWaiting(answer.tiles.waiting)
        if (options.open) setList({ status, rows: answer.substitutions, problem: null, more: answer.more })
      } catch (error) {
        if (options.open) setList((current) => ({ ...current, status, rows: null, problem: readProblem(error) }))
      }
    },
    [api, siteId, can.view, options.open, list.status],
  )
  // Read again when the site or the section's opening changes (a status is read by its own action).
  const latest = useRef(load)
  latest.current = load
  useEffect(() => {
    void latest.current()
  }, [api, siteId, can.view, options.open])

  const confirmWithdraw = useCallback(async () => {
    if (!withdraw || withdraw.busy || !withdraw.reason.trim()) return
    setWithdraw({ ...withdraw, busy: true, problem: null })
    let done = 0
    let problem: Phrase | null = null
    for (const id of withdraw.ids) {
      const row = list.rows?.find((entry) => entry.id === id)
      if (!row) continue
      try {
        await withdrawSubstitute(api, row, withdraw.reason.trim())
        done += 1
      } catch (error) {
        problem ??= askProblem(error)
      }
    }
    setWithdraw((current) => (current ? { ...current, busy: false, done, problem } : current))
    void load()
    options.onChanged()
  }, [api, withdraw, list.rows, load, options])

  const model: SubstitutesModel = { ...list, focus: options.focus, withdraw }
  const actions: SubstitutesActions = {
    onStatus: (status) => {
      setList((current) => ({ ...current, status, rows: null }))
      void load(status)
    },
    onRetry: () => void load(),
    onWithdraw: (ids) => setWithdraw(ids && ids.length > 0 ? { ids: [...ids], reason: '', busy: false, problem: null, done: null } : null),
    onWithdrawReason: (reason) => setWithdraw((current) => (current ? { ...current, reason } : current)),
    onConfirmWithdraw: () => void confirmWithdraw(),
  }
  return { waiting, model, actions, reread: () => void load() }
}
