'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useLiveChanges } from '../../../../record-panels/live'
import { readProblem, writeProblem, type Notice, type WriteProblem } from '../../library/model'
import { approveSmv, getMinutes, proposeSmv, rejectSmv, type OperationMinutesView } from './api'
import { useOffline } from './online'
import { proposeBodyOf, type MinutesActions, type MinutesDialog, type MinutesModel, type Part, type Place, type SmvCan } from './model'

/**
 * The Minutes tab's and Propose SMV change's container hook (B-W2b-235 on B-W2b-215's API): reads the operation's minutes
 * (its SMV and how it is built, the versions, what a change reaches) while `operationId` is set and `enabled`; sends a
 * proposal, an approval or a rejection, one at a time, each with its own Idempotency-Key and the version read (a 409 reads
 * it again and says why); live `smv_version.changed` / `operation.smv_changed` of this operation read it again. The
 * operation record and the list (the SMV cell, the tile's rows) use it; `onChanged` tells the host its own read moved.
 */
export function useOperationMinutes({
  api,
  operationId,
  enabled,
  userId,
  can,
  connections,
  onChanged,
}: {
  api: ApiClient
  operationId: string | null
  enabled: boolean
  userId: string | null
  can: SmvCan
  connections: { pieceRates: Place; changes: Place }
  /** The operation's own numbers may have moved (a change took effect): the host reads it again. */
  onChanged?: () => void
}): { model: MinutesModel; actions: MinutesActions; reload: () => void } {
  const [part, setPart] = useState<Part<OperationMinutesView>>({ status: 'idle' })
  const [dialog, setDialog] = useState<MinutesDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<WriteProblem | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const writing = useRef(false)
  const seq = useRef(0)
  const changed = useRef(onChanged)
  changed.current = onChanged
  const offline = useOffline()

  const load = useCallback(() => {
    if (!operationId || !enabled) return
    const mine = ++seq.current
    setPart((current) => (current.status === 'ready' && current.value.operation.id === operationId ? current : { status: 'loading' }))
    getMinutes(api, operationId)
      .then((value) => mine === seq.current && setPart({ status: 'ready', value }))
      .catch((error: unknown) => mine === seq.current && setPart({ status: 'error', problem: readProblem(error) }))
  }, [api, operationId, enabled])

  useEffect(() => {
    if (!operationId || !enabled) {
      setPart({ status: 'idle' })
      return
    }
    setRefused(null)
    load()
  }, [load, operationId, enabled])

  useLiveChanges({
    onChange: (change) => {
      if (writing.current || !operationId) return
      if ((change.type === 'smv_version.changed' || change.type === 'operation.smv_changed') && change.fields.operationId === operationId) load()
    },
  })

  /** One write; true when the server took it. */
  const write = async (work: (view: OperationMinutesView) => Promise<OperationMinutesView>, done: Notice): Promise<boolean> => {
    if (part.status !== 'ready' || writing.current) return false
    writing.current = true
    setBusy(true)
    setRefused(null)
    try {
      setPart({ status: 'ready', value: await work(part.value) })
      setNotice(done)
      setDialog(null)
      changed.current?.()
      return true
    } catch (error) {
      const problem = writeProblem(error)
      setRefused(problem)
      if (problem.reload) load()
      return false
    } finally {
      writing.current = false
      setBusy(false)
    }
  }

  const actions: MinutesActions = {
    onRetry: load,
    onDialog: (next) => {
      setRefused(null)
      setDialog(next)
    },
    onPropose: (draft) =>
      write(async (view) => (await proposeSmv(api, view.operation.id, proposeBodyOf(draft, view))).minutes, { key: draft.replace ? 'notice.replaced' : 'notice.proposed', tone: 'success', params: { code: part.status === 'ready' ? part.value.operation.code : '' } }),
    onApprove: async (version, note) => {
      let tookEffect = false
      const ok = await write(
        async (view) => {
          const answer = await approveSmv(api, view.operation.id, version, note)
          tookEffect = answer.tookEffect
          return answer.minutes
        },
        { key: 'notice.approved', tone: 'success', params: { number: version.number } },
      )
      if (ok && !tookEffect) setNotice({ key: 'notice.approvedWaits', tone: 'success', params: { number: version.number, day: version.effectiveFrom } })
      return ok
    },
    onReject: (version, note) => write((view) => rejectSmv(api, view.operation.id, version, note), { key: 'notice.rejected', tone: 'info', params: { number: version.number } }),
    onDismissNotice: () => setNotice(null),
  }

  const model = useMemo<MinutesModel>(() => ({ part, dialog, busy, refused, notice, userId, can, connections, offline }), [part, dialog, busy, refused, notice, userId, can, connections, offline])
  return { model, actions, reload: load }
}
