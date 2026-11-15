'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { openPresigned } from '../files'
import { useLive } from '../hooks'
import { failed, LOADING, ready, touchesShipment, writeWords, type DepthAbilities } from '../queue/shared/depth'
import { podFileLink, readPod, readProblems, recordPod, resolveProblem, uploadPodFile } from './api'
import { EXCEPTION_REFUSALS, NOTE_MAX, openParts, podProblem, type DeliveryActions, type DeliveryModel } from './model'
import { DeliveryView } from './view/DeliveryView'

/**
 * Tracking & delivery › Proof of delivery and Tracking problems (SCR-597): reads `GET …/pod` and `GET …/tracking-problems`
 * (shipping.view), again when the record's version moves, on this shipment's delivery events and on reconnect. Record the
 * proof uploads the image as a file of the shipment first (files.upload), then ONE `PUT …/pod` with the parts still open;
 * Download opens the proof's presigned GET; Resolve = `POST …/resolve` with the note.
 */
export function Delivery({ shipment, version, can, facts }: { shipment: { id: string; companyId: string }; version: number; can: DepthAbilities; facts: DeliveryModel['facts'] }) {
  const api = useOfficeApi()
  const shipmentId = shipment.id
  const [model, setModel] = useState<DeliveryModel>({ pod: LOADING, problems: LOADING, can: { manage: can.manage, readFiles: can.readFiles, uploadFiles: can.uploadFiles }, facts, dialog: null, busy: false, problem: null, done: null })
  const latest = useRef(model)
  latest.current = model
  const picked = useRef<File | null>(null)
  const keys = useRef<Record<string, string>>({})

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setModel((state) => ({ ...state, pod: LOADING, problems: LOADING }))
      const [pod, problems] = await Promise.allSettled([readPod(api, shipmentId), readProblems(api, shipmentId)])
      setModel((state) => ({
        ...state,
        pod: pod.status === 'fulfilled' ? ready(pod.value) : quiet && state.pod.state === 'ready' ? state.pod : failed(pod.reason),
        problems: problems.status === 'fulfilled' ? ready(problems.value) : quiet && state.problems.state === 'ready' ? state.problems : failed(problems.reason),
      }))
    },
    [api, shipmentId],
  )

  useEffect(() => {
    void load(true)
  }, [load, version])

  useLive(
    (change) => {
      if (touchesShipment(change, shipmentId) && (change.type.startsWith('shipment.pod') || change.type.startsWith('shipment.tracking') || change.type === 'shipment.status_changed')) void load(true)
    },
    () => void load(true),
  )

  const fail = useCallback(
    (error: unknown, prefix: string, known: readonly string[]) => {
      const problem = writeWords(error, prefix, known)
      setModel((state) => ({ ...state, busy: false, problem: { key: problem.key, params: problem.params } }))
      if (problem.reload) void load(true)
    },
    [load],
  )

  const actions = useMemo<DeliveryActions>(
    () => ({
      onRetry: () => void load(),
      onDialog: (dialog) => {
        if (dialog?.kind === 'pod') keys.current.pod = newIdempotencyKey()
        if (dialog?.kind === 'resolve') keys.current.resolve = newIdempotencyKey()
        if (!dialog || dialog.kind !== 'pod') picked.current = null
        setModel((state) => ({ ...state, dialog, problem: null, done: null }))
      },
      onPick: (file) => {
        picked.current = file
        setModel((state) => (state.dialog?.kind === 'pod' ? { ...state, dialog: { ...state.dialog, file: file ? { name: file.name, type: file.type, size: file.size } : null } } : state))
      },
      onRecord: () => {
        const state = latest.current
        const dialog = state.dialog
        if (dialog?.kind !== 'pod' || state.pod.state !== 'ready' || state.busy) return
        const pod = state.pod.value
        if (podProblem(dialog, pod, state.can)) return
        const parts = openParts(pod)
        const file = parts.image ? picked.current : null
        setModel((current) => ({ ...current, busy: true, problem: null }))
        void (async () => {
          try {
            const fileId = file ? await uploadPodFile(api, { id: shipmentId, companyId: shipment.companyId }, file) : null
            const body = {
              version: pod.shipment.version,
              ...(parts.signer && dialog.signedBy.trim() !== '' ? { signedBy: dialog.signedBy.trim() } : {}),
              ...(parts.time && dialog.signedAt ? { signedAt: new Date(dialog.signedAt).toISOString() } : {}),
              ...(fileId ? { fileId } : {}),
            }
            const next = await recordPod(api, shipmentId, body, keys.current.pod ?? newIdempotencyKey())
            picked.current = null
            setModel((current) => ({ ...current, busy: false, pod: ready(next), dialog: null, done: { key: 'pod.done' } }))
          } catch (error) {
            fail(error, 'pod.refusal', ['KEPT', 'NOT_DELIVERED'])
          }
        })()
      },
      onDownload: () => {
        setModel((state) => ({ ...state, busy: true, problem: null }))
        podFileLink(api, shipmentId)
          .then((download) => {
            openPresigned(download)
            setModel((state) => ({ ...state, busy: false }))
          })
          .catch((error: unknown) => fail(error, 'pod.refusal', []))
      },
      onResolve: () => {
        const state = latest.current
        const dialog = state.dialog
        if (dialog?.kind !== 'resolve' || state.busy || dialog.note.trim().length > NOTE_MAX) return
        setModel((current) => ({ ...current, busy: true, problem: null }))
        resolveProblem(api, shipmentId, dialog.problemId, dialog.note.trim() || null, keys.current.resolve ?? newIdempotencyKey())
          .then((problems) => setModel((current) => ({ ...current, busy: false, problems: ready(problems), dialog: null, done: { key: 'problems.done' } })))
          .catch((error: unknown) => fail(error, 'problems.refusal', EXCEPTION_REFUSALS))
      },
    }),
    [api, shipmentId, shipment.companyId, load, fail],
  )

  return <DeliveryView model={{ ...model, facts }} actions={actions} />
}
