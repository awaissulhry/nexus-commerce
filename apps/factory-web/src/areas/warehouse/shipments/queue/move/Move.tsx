'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { useOfficeApi } from '../../../../../lib/session/context'
import { failed, LOADING, ready, type Words } from '../shared/depth'
import { readSplit } from '../split/api'
import { mergeShipment, moveGarments, readMoveTargets, type Moved } from './api'
import { initialMove, mergeBody, moveBody, moveHeld, moveProblem, type MoveActions, type MoveMode, type MoveModel } from './model'
import { MoveDialog } from './view/MoveDialog'

/**
 * F-OS-203 (order SHIPMENTS tab; 18-lead-settles L6) — Move garments to… / Merge into…, the container of ONE dialog for both pages
 * (Warehouse's record ⋯ and the order's Shipments row ⋯): reads what may move (`GET …/split`) and the targets
 * (`GET …/move-targets`), then ONE `POST …/move` or `…/merge` with both versions and its own Idempotency-Key. `onDone` says what
 * moved (the page reads itself again and says it once, with the door to the target).
 */
export function Move({ shipmentId, number, mode, onClose, onDone }: { shipmentId: string; number: string; mode: MoveMode; onClose: () => void; onDone: (done: { words: Words; target: { id: string; number: string } }) => void }) {
  const api = useOfficeApi()
  const [model, setModel] = useState<MoveModel>(() => initialMove(mode))
  const latest = useRef(model)
  latest.current = model
  const key = useRef(newIdempotencyKey())

  const load = useCallback(async () => {
    setModel((state) => ({ ...state, preview: LOADING, targets: LOADING }))
    const [preview, targets] = await Promise.allSettled([readSplit(api, shipmentId), readMoveTargets(api, shipmentId)])
    setModel((state) => ({
      ...state,
      preview: preview.status === 'fulfilled' ? ready(preview.value) : failed(preview.reason),
      targets: targets.status === 'fulfilled' ? ready(targets.value) : failed(targets.reason),
      // A single target that may take them is picked for the person.
      targetId: state.targetId ?? (targets.status === 'fulfilled' && targets.value.targets.length === 1 ? targets.value.targets[0]!.id : null),
    }))
  }, [api, shipmentId])

  useEffect(() => {
    void load()
  }, [load])

  const actions = useMemo<MoveActions>(
    () => ({
      onRetry: () => void load(),
      onTarget: (targetId) => setModel((state) => ({ ...state, targetId, problem: null })),
      onQuantity: (lineId, quantity) => setModel((state) => ({ ...state, quantities: { ...state.quantities, [lineId]: quantity }, problem: null })),
      onReason: (reason) => setModel((state) => ({ ...state, reason, problem: null })),
      onWords: (text) => setModel((state) => ({ ...state, words: text })),
      onClose,
      onGo: () => {
        const state = latest.current
        if (state.busy || state.preview.state !== 'ready' || state.targets.state !== 'ready') return
        const preview = state.preview.value
        const targets = state.targets.value
        if (moveHeld(state, preview, targets)) return
        const target = targets.targets.find((entry) => entry.id === state.targetId)
        if (!target) return
        // The target's version is the move-targets read's own (the API checks it under the lock); absent there: the API reads it.
        let run: Promise<Moved> | null = null
        if (state.mode === 'merge') {
          const body = mergeBody(state, preview)
          if (body) run = mergeShipment(api, shipmentId, body, key.current)
        } else {
          const body = moveBody(state, preview, targets)
          if (body) run = moveGarments(api, shipmentId, body, key.current)
        }
        if (!run) return
        setModel((current) => ({ ...current, busy: true, problem: null }))
        run
          .then((moved) => {
            key.current = newIdempotencyKey()
            setModel((current) => ({ ...current, busy: false }))
            onDone({ words: moved.moved.merged ? { key: 'move.done.merged', params: { number, into: moved.shipment.number } } : { key: 'move.done.moved', params: { count: moved.moved.garments, number: moved.shipment.number } }, target: { id: moved.shipment.id, number: moved.shipment.number } })
          })
          .catch((error: unknown) => {
            const problem = moveProblem(error)
            setModel((current) => ({ ...current, busy: false, problem: { key: problem.key, ...(problem.params ? { params: problem.params } : {}) } }))
            if (problem.reload) void load()
          })
      },
    }),
    [api, shipmentId, number, load, onClose, onDone],
  )

  return <MoveDialog number={number} model={model} actions={actions} />
}
