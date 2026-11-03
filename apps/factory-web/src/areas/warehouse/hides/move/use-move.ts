'use client'

import { useCallback, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { listLocations, type HideRow } from '../../../_shared/stock/api'
import { readProblem } from '../../../_shared/stock/model'
import { movable, moveHeldKey, moveHides, moveProblem, placesOf, transferHide, type MoveDialogActions, type MoveDialogModel } from './move-model'

/**
 * The Move N hides dialog's container part (Hides' selection row, B-W2b-131): opens on the hides chosen (each free to move or
 * left out with why), lists the site's active places, and moves each free hide whole as its own transfer, one after the
 * other (one Idempotency-Key per dialog and hide: a retry never moves a hide twice); a refusal names its hide and the others
 * still go. `onDone` runs once they were sent (the page reads again).
 */
export function useMoveHides(api: ApiClient, onDone: () => void) {
  const [model, setModel] = useState<MoveDialogModel | null>(null)
  const latest = useRef(model)
  latest.current = model
  const key = useRef<string | null>(null)

  const loadPlaces = useCallback(
    (siteId: string) => {
      setModel((current) => (current ? { ...current, places: { value: null, problem: null } } : current))
      listLocations(api, { siteId })
        .then((answer) => setModel((current) => (current ? { ...current, places: { value: placesOf(answer.sites.find((site) => site.id === siteId)?.locations ?? []), problem: null } } : current)))
        .catch((error: unknown) => setModel((current) => (current ? { ...current, places: { value: null, problem: readProblem(error) } } : current)))
    },
    [api],
  )

  const open = useCallback(
    (rows: readonly HideRow[]) => {
      if (rows.length === 0) return
      key.current = newIdempotencyKey()
      const siteId = rows[0]!.siteId
      setModel({ siteId, hides: moveHides(rows), places: { value: null, problem: null }, toLocationId: null, note: '', posting: false, results: null, problem: null })
      loadPlaces(siteId)
    },
    [loadPlaces],
  )

  const actions: MoveDialogActions = {
    onPlace: (toLocationId) => setModel((current) => (current ? { ...current, toLocationId, problem: null } : current)),
    onNote: (note) => setModel((current) => (current ? { ...current, note } : current)),
    onRetryPlaces: () => latest.current && loadPlaces(latest.current.siteId),
    onClose: () => setModel(null),
    onMove: () => {
      const current = latest.current
      if (!current || !key.current || moveHeldKey(current)) return
      const hides = movable(current)
      const dialogKey = key.current
      setModel({ ...current, posting: true, problem: null })
      void (async () => {
        const results: Record<string, { moved: true } | { moved: false; problem: ReturnType<typeof moveProblem> }> = {}
        for (const hide of hides) {
          try {
            await transferHide(api, { siteId: current.siteId, itemId: hide.itemId, hideId: hide.id, fromLocationId: hide.from!.id, toLocationId: current.toLocationId!, quantity: hide.quantity, note: current.note }, `${dialogKey}:${hide.id}`)
            results[hide.id] = { moved: true }
          } catch (error) {
            results[hide.id] = { moved: false, problem: moveProblem(error) }
          }
        }
        setModel((now) => (now ? { ...now, posting: false, results } : now))
        onDone()
      })()
    },
  }
  return { model, open, actions }
}
