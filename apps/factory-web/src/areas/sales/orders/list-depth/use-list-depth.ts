'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import type { OrderRow } from '../api'
import { getRowsDepth, setPriorities, setPriority, type PrioritiesAnswer, type PriorityLevel, type RowDepth } from '../depth/api'
import { depthCanOf, priorityBody, writeProblemOf, type DepthCan } from '../depth/model'
import type { Phrase } from '../model'

/** One cell's save: saving ↻, saved (fades), refused with the reason. */
export type CellSave = { state: 'saving' } | { state: 'saved' } | { state: 'refused'; reason: Phrase }

/** "Set priority" on a selection (or one row's URGENT, which asks its reason). */
export interface PriorityDialogState {
  ids: string[]
  /** One row edited inline: its version (the single route, with the version check). */
  single: { id: string; version: number } | null
  level: PriorityLevel
  reason: string
  busy: boolean
  problem: Phrase | null
  outcome: PrioritiesAnswer | null
}

export interface ListDepthModel {
  can: DepthCan
  /** Each row's W2b columns by order id (undefined: still reading; absent from the map after a failed read). */
  rows: ReadonlyMap<string, RowDepth> | null
  failed: boolean
  saves: ReadonlyMap<string, CellSave>
  dialog: PriorityDialogState | null
}

export interface ListDepthActions {
  onPriority?: (row: OrderRow, level: PriorityLevel) => void
  onSetPriority?: (ids: string[]) => void
  onDialog?: (next: Partial<PriorityDialogState> | null) => void
  onDialogGo?: () => void
}

/**
 * The orders list's W2b columns (B-W2b-323; GET /sales/orders/depth?orderIds= beside W1's list): priority and season of the rows
 * on screen, read again with the rows; the priority cell's inline save (PUT …/priority with the row's version: the row's version
 * moves) with its mark; Set priority on a selection (one command: what changed, stayed, was left out). `onSaved` tells the page a
 * row's new version (its next write sends it) and that the rows changed.
 */
export function useListDepth(api: ApiClient, rows: readonly OrderRow[] | null, permissions: readonly string[], onSaved: (changes: ReadonlyArray<{ id: string; version?: number }>) => void): { model: ListDepthModel; actions: ListDepthActions } {
  const can = useMemo(() => depthCanOf(permissions), [permissions])
  const [depth, setDepth] = useState<Map<string, RowDepth> | null>(null)
  const [failed, setFailed] = useState(false)
  const [saves, setSaves] = useState<Map<string, CellSave>>(new Map())
  const [dialog, setDialog] = useState<PriorityDialogState | null>(null)
  const keyRef = useRef<string>(newIdempotencyKey())
  const ids = useMemo(() => (rows ?? []).map((row) => row.id), [rows])
  const idsKey = ids.join(',')
  const versionsKey = (rows ?? []).map((row) => `${row.id}:${row.version}`).join(',')
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog

  useEffect(() => {
    if (!can.view || ids.length === 0) {
      setDepth(ids.length === 0 ? new Map() : null)
      return
    }
    const abort = new AbortController()
    setFailed(false)
    const chunks: string[][] = []
    for (let index = 0; index < ids.length; index += 200) chunks.push(ids.slice(index, index + 200))
    Promise.all(chunks.map((chunk) => getRowsDepth(api, chunk, abort.signal)))
      .then((answers) => !abort.signal.aborted && setDepth(new Map(answers.flat().map((row) => [row.orderId, row]))))
      .catch(() => {
        if (abort.signal.aborted) return
        setFailed(true)
        setDepth(new Map())
      })
    return () => abort.abort()
    // The rows' versions say when a row moved (a priority set elsewhere, a live re-read).
  }, [api, can.view, idsKey, versionsKey])

  const mark = useCallback((id: string, save: CellSave | null) => {
    setSaves((known) => {
      const next = new Map(known)
      if (save) next.set(id, save)
      else next.delete(id)
      return next
    })
    if (save?.state === 'saved') setTimeout(() => setSaves((known) => (known.get(id)?.state === 'saved' ? new Map([...known].filter(([key]) => key !== id)) : known)), 2400)
  }, [])

  const applyLevel = useCallback((id: string, level: PriorityLevel, reason: string | null) => {
    setDepth((known) => {
      if (!known) return known
      const row = known.get(id)
      if (!row) return known
      const next = new Map(known)
      next.set(id, { ...row, priority: { ...row.priority, level, urgentReason: reason } })
      return next
    })
  }, [])

  const actions: ListDepthActions = {
    onPriority: (row, level) => {
      if (level === 'URGENT') {
        keyRef.current = newIdempotencyKey()
        setDialog({ ids: [row.id], single: { id: row.id, version: row.version }, level, reason: depth?.get(row.id)?.priority.urgentReason ?? '', busy: false, problem: null, outcome: null })
        return
      }
      mark(row.id, { state: 'saving' })
      setPriority(api, row.id, { version: row.version, ...priorityBody(level, '') })
        .then((answer) => {
          applyLevel(row.id, answer.priorityLevel, answer.urgentReason)
          mark(row.id, { state: 'saved' })
          onSaved([{ id: row.id, version: answer.version }])
        })
        .catch((error: unknown) => mark(row.id, { state: 'refused', reason: writeProblemOf(error) }))
    },
    onSetPriority: (chosen) => {
      keyRef.current = newIdempotencyKey()
      setDialog({ ids: chosen, single: null, level: 'HIGH', reason: '', busy: false, problem: null, outcome: null })
    },
    onDialog: (next) => setDialog((known) => (next === null ? null : known ? { ...known, ...next, problem: null } : known)),
    onDialogGo: () => {
      const now = dialogRef.current
      if (!now || now.busy) return
      setDialog({ ...now, busy: true, problem: null })
      const body = priorityBody(now.level, now.reason)
      const run = now.single
        ? setPriority(api, now.single.id, { version: now.single.version, ...body }, keyRef.current).then((answer): PrioritiesAnswer => {
            onSaved([{ id: answer.orderId, version: answer.version }])
            return { priorityLevel: answer.priorityLevel, changed: answer.changed ? [answer.orderId] : [], unchanged: answer.changed ? [] : [answer.orderId], skipped: [], unknown: 0 }
          })
        : setPriorities(api, { orderIds: now.ids, ...body }, keyRef.current).then((answer) => {
            onSaved(answer.changed.map((id) => ({ id })))
            return answer
          })
      run
        .then((answer) => {
          for (const id of answer.changed) applyLevel(id, answer.priorityLevel, body.urgentReason)
          if (now.single) {
            mark(now.single.id, { state: 'saved' })
            setDialog(null)
          } else setDialog((known) => (known ? { ...known, busy: false, outcome: answer } : known))
        })
        .catch((error: unknown) => setDialog((known) => (known ? { ...known, busy: false, problem: writeProblemOf(error) } : known)))
    },
  }

  // The model keeps its identity until one of its parts moves (the list's columns are built from it); the actions reach the
  // latest state through a ref, so the grid's cells never re-mount on a re-render.
  const model = useMemo<ListDepthModel>(() => ({ can, rows: depth, failed, saves, dialog }), [can, depth, failed, saves, dialog])
  const latest = useRef(actions)
  latest.current = actions
  const stable = useMemo<ListDepthActions>(
    () => ({
      onPriority: (row, level) => latest.current.onPriority?.(row, level),
      onSetPriority: (chosen) => latest.current.onSetPriority?.(chosen),
      onDialog: (next) => latest.current.onDialog?.(next),
      onDialogGo: () => latest.current.onDialogGo?.(),
    }),
    [],
  )
  return { model, actions: stable }
}
