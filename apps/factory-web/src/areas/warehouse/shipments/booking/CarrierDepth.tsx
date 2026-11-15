'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLive } from '../hooks'
import { failed, LOADING, ready, touchesShipment, writeWords, type DepthAbilities } from '../queue/shared/depth'
import { arrangeTransport, checkLabels, readLabelJobs, readTransport, reprintLabels, typeStatus, typeTrackingNumber, type Transport } from './api'
import { arrangeBody, arrangeProblem, OWN_TRANSPORT_REFUSALS, reasonProblem, REPRINT_REFUSALS, reprintHeld, statusProblem, trackingProblem, type ReprintActions, type ReprintModel, type TransportActions, type TransportModel } from './model'
import { ReprintView } from './view/ReprintView'

/**
 * Carrier & label › How it travels (SCR-595), used by the record: reads `GET …/own-transport` (shipping.view) once the record
 * knows its shipment and, for a person who packs, the check before printing (`GET …/labels/check`, shipping.pack); again when
 * the record's version moves, on this shipment's events and on reconnect. Each change is one write with the shipment's
 * version as read; `onChanged` makes the record read itself again (the band, the DDT, the next step follow the arrangement).
 * The arrangement also tells the record that a carrier booked by hand buys no label (its next step).
 */
export function useOwnTransport(shipmentId: string, version: number, can: DepthAbilities, onChanged: () => void): { model: TransportModel; actions: TransportActions; arrangement: Transport['arrangement'] | null } {
  const api = useOfficeApi()
  const [model, setModel] = useState<TransportModel>({ transport: LOADING, check: can.pack ? LOADING : null, can: { manage: can.manage, pack: can.pack }, dialog: null, busy: false, problem: null, done: null })
  const latest = useRef(model)
  latest.current = model
  const keys = useRef<Record<string, string>>({})
  const changed = useRef(onChanged)
  changed.current = onChanged

  const loadCheck = useCallback(
    async (quiet: boolean) => {
      if (!can.pack) return
      try {
        const check = await checkLabels(api, shipmentId)
        setModel((state) => ({ ...state, check: ready(check) }))
      } catch (error) {
        setModel((state) => (quiet && state.check?.state === 'ready' ? state : { ...state, check: failed(error) }))
      }
    },
    [api, shipmentId, can.pack],
  )

  const load = useCallback(
    async (quiet = false) => {
      if (!shipmentId) return
      if (!quiet) setModel((state) => ({ ...state, transport: LOADING }))
      try {
        const transport = await readTransport(api, shipmentId)
        setModel((state) => ({ ...state, transport: ready(transport) }))
        if (transport.arrangement === 'CARRIER') void loadCheck(quiet)
      } catch (error) {
        setModel((state) => (quiet && state.transport.state === 'ready' ? state : { ...state, transport: failed(error) }))
      }
    },
    [api, shipmentId, loadCheck],
  )

  useEffect(() => {
    void load(true)
  }, [load, version])

  useLive(
    (change) => {
      if (touchesShipment(change, shipmentId)) void load(true)
    },
    () => void load(true),
  )

  const write = useCallback(
    async (name: string, run: (key: string, transport: Transport) => Promise<Transport>, done: string) => {
      const state = latest.current
      if (state.busy || state.transport.state !== 'ready') return
      const transport = state.transport.value
      const key = (keys.current[name] ??= newIdempotencyKey())
      setModel((current) => ({ ...current, busy: true, problem: null, done: null }))
      try {
        const next = await run(key, transport)
        delete keys.current[name]
        setModel((current) => ({ ...current, busy: false, transport: ready(next), dialog: null, done: { key: done } }))
        changed.current()
      } catch (error) {
        const problem = writeWords(error, 'transport.refusal', OWN_TRANSPORT_REFUSALS)
        setModel((current) => ({ ...current, busy: false, problem: { key: problem.key, params: problem.params } }))
        if (problem.reload) void load(true)
      }
    },
    [load],
  )

  const actions = useMemo<TransportActions>(
    () => ({
      onRetry: () => void load(),
      onRetryCheck: () => void loadCheck(false),
      onDialog: (dialog) => setModel((state) => ({ ...state, dialog, problem: null, done: null })),
      onArrange: () => {
        const dialog = latest.current.dialog
        if (dialog?.kind !== 'arrange' || arrangeProblem(dialog)) return
        void write(`arrange:${dialog.mode}`, (key, transport) => arrangeTransport(api, shipmentId, arrangeBody(dialog, transport.shipment.version), key), dialog.mode === 'OWN_VAN' ? 'transport.done.ownVan' : 'transport.done.manual')
      },
      onTracking: () => {
        const dialog = latest.current.dialog
        if (dialog?.kind !== 'tracking' || trackingProblem(dialog)) return
        const text = dialog.text.trim()
        void write('tracking', (key, transport) => typeTrackingNumber(api, shipmentId, { version: transport.shipment.version, trackingNumber: text === '' ? null : text }, key), text === '' ? 'transport.done.trackingCleared' : 'transport.done.tracking')
      },
      onStatus: () => {
        const state = latest.current
        const dialog = state.dialog
        if (dialog?.kind !== 'status' || !dialog.status || state.transport.state !== 'ready' || statusProblem(dialog, state.transport.value)) return
        const status = dialog.status
        void write(
          `status:${status}`,
          (key, transport) =>
            typeStatus(
              api,
              shipmentId,
              {
                version: transport.shipment.version,
                status,
                ...(dialog.occurredAt ? { occurredAt: new Date(dialog.occurredAt).toISOString() } : {}),
                description: dialog.description.trim() || null,
                location: dialog.location.trim() || null,
              },
              key,
            ),
          status === 'DELIVERED' ? 'transport.done.delivered' : status === 'RETURNED' ? 'transport.done.returned' : 'transport.done.status',
        )
      },
    }),
    [api, shipmentId, load, loadCheck, write],
  )

  return { model, actions, arrangement: model.transport.state === 'ready' ? model.transport.value.arrangement : null }
}

/**
 * Carrier & label › Label prints (SCR-595): reads `GET …/label-jobs` (shipping.pack), again on a print or reprint event of
 * this shipment, when the record's version moves and on reconnect; Reprint = ONE `POST …/label-jobs/reprint` with the
 * reason and its own Idempotency-Key.
 */
export function ReprintCard({ shipmentId, version, can }: { shipmentId: string; version: number; can: DepthAbilities }) {
  const api = useOfficeApi()
  const [model, setModel] = useState<ReprintModel>({ jobs: LOADING, can: { pack: can.pack, printLabels: can.printLabels }, picked: [], dialog: null, busy: false, problem: null, done: null })
  const latest = useRef(model)
  latest.current = model
  const key = useRef<string | null>(null)

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setModel((state) => ({ ...state, jobs: LOADING }))
      try {
        const jobs = await readLabelJobs(api, shipmentId)
        setModel((state) => ({ ...state, jobs: ready(jobs) }))
      } catch (error) {
        setModel((state) => (quiet && state.jobs.state === 'ready' ? state : { ...state, jobs: failed(error) }))
      }
    },
    [api, shipmentId],
  )

  useEffect(() => {
    void load(true)
  }, [load, version])

  useLive(
    (change) => {
      if (change.type === 'print.job_changed' || change.type === 'print.job_queued' || ((change.type === 'shipping.label_reprinted' || change.type.startsWith('shipment.label')) && touchesShipment(change, shipmentId))) void load(true)
    },
    () => void load(true),
  )

  const actions = useMemo<ReprintActions>(
    () => ({
      onRetry: () => void load(),
      onPick: (jobIds) => {
        key.current = newIdempotencyKey()
        setModel((state) => ({ ...state, picked: jobIds, dialog: { reason: '' }, problem: null, done: null }))
      },
      onDialog: (dialog) => setModel((state) => ({ ...state, dialog, problem: null, picked: dialog ? state.picked : [] })),
      onReprint: () => {
        const state = latest.current
        if (!state.dialog || reprintHeld(state) || reasonProblem(state.dialog.reason)) return
        const body = { jobIds: [...state.picked], reason: state.dialog.reason.trim() }
        setModel((current) => ({ ...current, busy: true, problem: null }))
        reprintLabels(api, shipmentId, body, key.current ?? newIdempotencyKey())
          .then((done) => {
            key.current = null
            setModel((current) => ({ ...current, busy: false, dialog: null, picked: [], done }))
            void load(true)
          })
          .catch((error: unknown) => {
            const problem = writeWords(error, 'reprint.refusal', [...REPRINT_REFUSALS, 'REASON', 'PRINTER'])
            setModel((current) => ({ ...current, busy: false, problem: { key: problem.key, params: problem.params } }))
            if (problem.reload) void load(true)
          })
      },
    }),
    [api, shipmentId, load],
  )

  return <ReprintView model={model} actions={actions} />
}
