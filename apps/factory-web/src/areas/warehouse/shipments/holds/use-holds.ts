'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLive } from '../hooks'
import { failed, LOADING, ready, touchesShipment, writeWords, type DepthAbilities } from '../queue/shared/depth'
import { placeHold, readHolds, releaseHold, type Holds } from './api'
import { HOLD_REFUSALS, initialHolds, placeProblem, reasonChoices, releaseProblem, type HoldsPanelActions, type HoldsPanelModel } from './model'

/**
 * The record's holds (SCR-592): reads `GET …/holds` (shipping.view) once the record knows its shipment (an empty id reads
 * nothing), again on a hold or split event of this shipment and on reconnect, and when `version` moves (the record changed); places and releases one hold at a time, each with its own
 * Idempotency-Key. `onChanged` tells the record (its band, its next step) that a hold moved.
 */
export function useShipmentHolds(shipmentId: string, version: number, can: DepthAbilities, onChanged?: () => void): { model: HoldsPanelModel; actions: HoldsPanelActions; holds: Holds | null } {
  const api = useOfficeApi()
  const [model, setModel] = useState<HoldsPanelModel>({ ...initialHolds, can: { holdsManage: can.holdsManage, holdsRelease: can.holdsRelease } })
  const latest = useRef(model)
  latest.current = model
  const keys = useRef<Record<string, string>>({})
  const changed = useRef(onChanged)
  changed.current = onChanged

  const load = useCallback(
    async (quiet = false) => {
      // The record's shipment is not read yet: nothing to ask.
      if (!shipmentId) return
      if (!quiet) setModel((state) => ({ ...state, holds: state.holds.state === 'ready' ? state.holds : LOADING }))
      try {
        const holds = await readHolds(api, shipmentId)
        setModel((state) => ({ ...state, holds: ready(holds) }))
      } catch (error) {
        setModel((state) => (quiet && state.holds.state === 'ready' ? state : { ...state, holds: failed(error) }))
      }
    },
    [api, shipmentId],
  )

  useEffect(() => {
    void load(true)
  }, [load, version])

  useLive(
    (change) => {
      if ((change.type === 'shipment.hold_placed' || change.type === 'shipment.hold_released' || change.type === 'shipment.split') && touchesShipment(change, shipmentId)) void load(true)
    },
    () => void load(true),
  )

  const write = useCallback(
    async (name: string, run: (key: string) => Promise<Holds>, done: string) => {
      if (latest.current.busy) return
      const key = (keys.current[name] ??= newIdempotencyKey())
      setModel((state) => ({ ...state, busy: true, problem: null, done: null }))
      try {
        const holds = await run(key)
        delete keys.current[name]
        setModel((state) => ({ ...state, busy: false, holds: ready(holds), dialog: null, done: { key: done } }))
        changed.current?.()
      } catch (error) {
        const problem = writeWords(error, 'holds.refusal', HOLD_REFUSALS)
        setModel((state) => ({ ...state, busy: false, problem: { key: problem.key, params: problem.params } }))
        if (problem.reload) void load(true)
      }
    },
    [load],
  )

  const actions = useMemo<HoldsPanelActions>(
    () => ({
      onRetry: () => void load(),
      onDialog: (dialog) => setModel((state) => ({ ...state, dialog, problem: null, done: null })),
      onPlace: () => {
        const { dialog, holds } = latest.current
        if (dialog?.kind !== 'place' || holds.state !== 'ready') return
        const problem = placeProblem(dialog, reasonChoices(holds.value))
        if (problem || !dialog.reason) return setModel((state) => ({ ...state, problem }))
        const reason = dialog.reason
        const text = dialog.text.trim()
        void write(`place:${reason}`, (key) => placeHold(api, shipmentId, { reason, words: text === '' ? null : text }, key), 'holds.done.placed')
      },
      onRelease: () => {
        const { dialog } = latest.current
        if (dialog?.kind !== 'release') return
        const problem = releaseProblem(dialog)
        if (problem) return setModel((state) => ({ ...state, problem }))
        const holdId = dialog.holdId
        const text = dialog.text.trim()
        void write(`release:${holdId}`, (key) => releaseHold(api, shipmentId, holdId, text, key), 'holds.done.released')
      },
    }),
    [api, shipmentId, load, write],
  )

  return { model, actions, holds: model.holds.state === 'ready' ? model.holds.value : null }
}
