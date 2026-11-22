'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLive } from '../hooks'
import { failed, LOADING, ready, touchesShipment, writeWords, type DepthAbilities } from '../queue/shared/depth'
import { arrangeTransport, checkLabels, readLabelJobs, readTransport, reprintLabels, typeStatus, typeTrackingNumber, type Transport } from './api'
import { arrangeBody, arrangeProblem, OWN_TRANSPORT_REFUSALS, reasonProblem, REPRINT_REFUSALS, reprintHeld, statusProblem, trackingBody, trackingProblem, type ReprintActions, type ReprintModel, type TransportActions, type TransportModel } from './model'
import { setExpectedArrival } from './api' // F-OS-203 (B-OS-016)
import { ETA_REFUSALS, etaBody, etaProblem, statusBody } from './model' // F-OS-203 (B-OS-015, B-OS-016)
// F-OS-301 (B-OS-022): the parcels' numbers in the same write; "Send the shipping notice again" = the notice's own route after it.
import { noticeOffered, parcelChangesOf } from './model'
import { sendNotice } from '../notice/api'
import { NOTICE_HELD } from '../notice/model'
import { words, type Words } from '../queue/shared/depth'
import { ReprintView } from './view/ReprintView'

/**
 * Carrier & label › How it travels (SCR-595), used by the record: reads `GET …/own-transport` (shipping.view) once the record
 * knows its shipment and, for a person who packs, the check before printing (`GET …/labels/check`, shipping.pack); again when
 * the record's version moves, on this shipment's events and on reconnect. Each change is one write with the shipment's
 * version as read; `onChanged` makes the record read itself again (the band, the DDT, the next step follow the arrangement).
 * The arrangement also tells the record that a carrier booked by hand buys no label (its next step).
 */
export function useOwnTransport(shipmentId: string, version: number, can: DepthAbilities, onChanged: (/* F-OS-301: what was said */ done?: Words) => void): { model: TransportModel; actions: TransportActions; arrangement: Transport['arrangement'] | null } {
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
    async (name: string, run: (key: string, transport: Transport) => Promise<Transport | WriteOutcome>, done: string, refusals: readonly string[] = OWN_TRANSPORT_REFUSALS, prefix = 'transport.refusal') => {
      const state = latest.current
      if (state.busy || state.transport.state !== 'ready') return
      const transport = state.transport.value
      const key = (keys.current[name] ??= newIdempotencyKey())
      setModel((current) => ({ ...current, busy: true, problem: null, done: null }))
      try {
        const answer = await run(key, transport)
        // F-OS-301: a write may say more than its done words (the numbers saved, and whether the notice went).
        const outcome: WriteOutcome = 'next' in answer ? answer : { next: answer, done: { key: done }, problem: null }
        delete keys.current[name]
        setModel((current) => ({ ...current, busy: false, transport: ready(outcome.next), dialog: null, done: outcome.done, problem: outcome.problem }))
        changed.current(outcome.done)
      } catch (error) {
        const problem = writeWords(error, prefix, refusals)
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
        const loaded = latest.current.transport
        // op-fx4: the number on record now (an emptied box clears it, its link with it). F-OS-301: each parcel and the reason too.
        if (dialog?.kind !== 'tracking' || loaded.state !== 'ready' || trackingProblem(dialog, loaded.value.shipment.manualTrackingNumber, loaded.value)) return
        const text = dialog.text.trim()
        const parcels = parcelChangesOf(dialog, loaded.value).length > 0
        const notify = dialog.notify === true && noticeOffered(loaded.value)
        // F-OP-135: the link typed beside the number goes with it (blank clears it). F-OS-301 (B-OS-022): the parcels' numbers in the same
        // ONE write; then, only when ticked, the shipping notice again by its own route (the numbers stay saved if it cannot go).
        void write(
          'tracking',
          async (key, transport): Promise<WriteOutcome> => {
            const next = await typeTrackingNumber(api, shipmentId, trackingBody(dialog, transport.shipment.version, transport), key)
            const saved = words(parcels ? 'door.tracking.done' : text === '' ? 'transport.done.trackingCleared' : 'transport.done.tracking')
            if (!notify) return { next, done: saved, problem: null }
            try {
              await sendNotice(api, shipmentId, null, (keys.current.notice ??= newIdempotencyKey()))
              delete keys.current.notice
              return { next, done: words('door.tracking.doneNotice'), problem: null }
            } catch (error) {
              const why = writeWords(error, 'notice.why', NOTICE_HELD)
              return { next, done: words('door.tracking.doneNoticeHeld'), problem: { key: why.key, params: why.params } }
            }
          },
          'transport.done.tracking',
        )
      },
      onStatus: () => {
        const state = latest.current
        const dialog = state.dialog
        if (dialog?.kind !== 'status' || !dialog.status || state.transport.state !== 'ready' || statusProblem(dialog, state.transport.value)) return
        const status = dialog.status
        // F-OS-203 (B-OS-015): over a carrier's labels, delivered or came back goes with its reason (statusBody).
        void write(`status:${status}`, (key, transport) => typeStatus(api, shipmentId, statusBody(dialog, transport, status), key), status === 'DELIVERED' ? 'transport.done.delivered' : status === 'RETURNED' ? 'transport.done.returned' : 'transport.done.status')
      },
      // F-OS-203 (B-OS-016): the expected arrival typed by hand (a carrier's feed refuses it: CARRIER_FED, in words).
      onEta: () => {
        const state = latest.current
        const dialog = state.dialog
        if (dialog?.kind !== 'eta' || state.transport.state !== 'ready' || etaProblem(dialog, state.transport.value)) return
        void write('eta', (key, transport) => setExpectedArrival(api, shipmentId, etaBody(dialog, transport), key), 'door.eta.done', ETA_REFUSALS, 'door.eta.refusal')
      },
    }),
    [api, shipmentId, load, loadCheck, write],
  )

  return { model, actions, arrangement: model.transport.state === 'ready' ? model.transport.value.arrangement : null }
}

/** F-OS-301: what a write says when it says more than its done words — the read after it, the words, and a problem after the save. */
interface WriteOutcome {
  readonly next: Transport
  readonly done: Words
  readonly problem: Words | null
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
