'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { useOfficeApi } from '../../../../../lib/session/context'
import { failed, LOADING, ready, writeWords } from '../shared/depth'
import { readSplit, splitByHand, splitByRule } from './api'
import { handBody, splitHeld, SPLIT_REFUSALS, type SplitActions, type SplitModel } from './model'
import { SplitDialog } from './view/SplitDialog'

/**
 * Split… (SCR-593): opened from the record's ⋯ on a DRAFT; reads `GET …/split` (shipping.view), then ONE `POST …/split` or
 * `…/split-by-rule` on the shipment's version with its own Idempotency-Key. `onDone` makes the record read itself again.
 */
export function Split({ shipmentId, prefix, onClose, onDone }: { shipmentId: string; prefix: string; onClose: () => void; onDone: () => void }) {
  const api = useOfficeApi()
  const [model, setModel] = useState<SplitModel>({ preview: LOADING, mode: 'hand', quantities: {}, reason: null, transportBy: 'CARRIER', carrierCode: '', serviceCode: '', busy: false, problem: null, made: null, prefix })
  const latest = useRef(model)
  latest.current = model
  const key = useRef(newIdempotencyKey())

  const load = useCallback(async () => {
    setModel((state) => ({ ...state, preview: LOADING }))
    try {
      const preview = await readSplit(api, shipmentId)
      setModel((state) => ({ ...state, preview: ready(preview), mode: preview.splittable ? state.mode : preview.rules.some((rule) => rule.shipments.length > 0) ? 'rule' : state.mode }))
    } catch (error) {
      setModel((state) => ({ ...state, preview: failed(error) }))
    }
  }, [api, shipmentId])

  useEffect(() => {
    void load()
  }, [load])

  const actions = useMemo<SplitActions>(
    () => ({
      onRetry: () => void load(),
      onMode: (mode) => setModel((state) => ({ ...state, mode, problem: null })),
      onQuantity: (lineId, quantity) => setModel((state) => ({ ...state, quantities: { ...state.quantities, [lineId]: quantity }, problem: null })),
      onReason: (reason) => setModel((state) => ({ ...state, reason, problem: null })),
      onDelivery: (next) => setModel((state) => ({ ...state, ...next, problem: null })),
      onClose,
      onSplit: () => {
        const state = latest.current
        if (state.preview.state !== 'ready' || splitHeld(state, state.preview.value)) return
        const preview = state.preview.value
        const body = state.mode === 'hand' ? handBody(state, preview) : null
        if (state.mode === 'hand' && !body) return
        setModel((current) => ({ ...current, busy: true, problem: null }))
        const run = state.mode === 'rule' ? splitByRule(api, shipmentId, preview.version, key.current) : splitByHand(api, shipmentId, body!, key.current)
        run
          .then((made) => {
            key.current = newIdempotencyKey()
            setModel((current) => ({ ...current, busy: false, made }))
            onDone()
          })
          .catch((error: unknown) => {
            const problem = writeWords(error, 'split.refusal', SPLIT_REFUSALS)
            setModel((current) => ({ ...current, busy: false, problem: { key: problem.key, params: problem.params } }))
            if (problem.reload) void load()
          })
      },
    }),
    [api, shipmentId, load, onClose, onDone],
  )

  return <SplitDialog model={model} actions={actions} />
}
