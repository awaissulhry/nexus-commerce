'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { businessDate } from '@nexus/factory-domain/core/time'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { zxingCamera } from '../../../camera'
import { useFloor } from '../../../FloorApp'
import { useFloorKeys } from '../../../keys'
import type { FrameAction, FrameModel } from '../../../frame/view/FloorFrameView'
import type { TaskProblem } from '../../shared/task-api'
import { uploadDdtPhoto } from '../api'
import { ddtFromPad, ddtNumberOf } from '../model'
import { fetchMaterials, fetchStart, fetchUnplanned, postUnplanned, type Material, type UnplannedReceipt, type UnplannedStart } from './api'
import { addLine, emptyDraft, firstStage, lineOf, removeLine, sendHeld, unplannedBody, type Draft, type UnplannedStage } from './model'
import { UnplannedView, type UnplannedAction } from './view/UnplannedView'

/**
 * The live SCR-378 (B-W2b-300; opened from Receive goods' first step, `/floor/receive`): goods that came without a purchase
 * order. Reads where such goods wait and our suppliers once, finds a material by the code typed or scanned, keeps the draft
 * on screen, then ONE post with its Idempotency-Key (kept while the body is the same: a lost answer is sent again, never taken
 * in twice). The DDT photo stays on this tablet (memory only) until the receipt exists, then it goes as the receipt's photo
 * (Retry when it fails). Online only: offline the draft stays and the post is held with the reason.
 */
export function FloorUnplanned({ frame, onFrame, ddtCode, onBack }: { frame: FrameModel; onFrame: (action: FrameAction) => void; ddtCode: string | null; onBack: () => void }) {
  const store = useFloor()
  const feedback = useConfirmFeedback()
  const { me, api, online, sessionEnded } = store
  const may = Boolean(me?.permissions.includes('inventory.receive'))

  const [stage, setStage] = useState<UnplannedStage>('supplier')
  const [start, setStart] = useState<UnplannedStart | null>(null)
  const [supplierQuery, setSupplierQuery] = useState('')
  const [materials, setMaterials] = useState<Material[] | null>(null)
  const [materialQuery, setMaterialQuery] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(() => ({ ...emptyDraft(), ddtNumber: ddtCode }))
  const [moreDays, setMoreDays] = useState(false)
  const [camera, setCamera] = useState(false)
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null)
  const [busy, setBusy] = useState<'post' | 'read' | null>(null)
  const [problem, setProblem] = useState<{ problem: TaskProblem; code: string | null } | null>(null)
  const [done, setDone] = useState<{ receipt: UnplannedReceipt; photo: 'sending' | 'sent' | 'failed' | null } | null>(null)
  const postKey = useRef<{ body: string; key: string } | null>(null)
  const lineKeys = useRef(0)

  const fail = useCallback(
    (found: TaskProblem, code: string | null = null) => {
      if (found.kind === 'signedOut') return void sessionEnded()
      feedback(found.kind === 'offline' || found.kind === 'unavailable' ? 'warning' : 'error')
      setProblem({ problem: found, code })
    },
    [feedback, sessionEnded],
  )

  const load = useCallback(async () => {
    const answer = await fetchStart(api)
    if (!answer.ok) return fail(answer.problem)
    setStart(answer.value)
  }, [api, fail])

  useEffect(() => {
    if (may) void load()
  }, [load, may])

  // Leaving with the draft clears the photo kept in memory.
  useEffect(() => () => {
    if (photo) URL.revokeObjectURL(photo.url)
  }, [photo])

  const findMaterial = async (code: string) => {
    const q = code.trim()
    if (!q) return
    setMaterialQuery(q)
    setBusy('read')
    const answer = await fetchMaterials(api, q)
    setBusy(null)
    if (!answer.ok) return fail(answer.problem)
    setMaterials(answer.value)
    // A scanned code that names one material exactly opens it.
    const exact = answer.value.filter((row) => row.code.toLowerCase() === q.toLowerCase())
    if (exact.length === 1) pickMaterial(exact[0]!)
  }

  const pickMaterial = (material: Material) => {
    feedback('success')
    setDraft((current) => ({ ...current, editing: lineOf(material, `l-${++lineKeys.current}`) }))
    setStage('quantity')
  }

  const sendPhoto = async (receipt: UnplannedReceipt, blob: Blob) => {
    setDone({ receipt, photo: 'sending' })
    const answer = await uploadDdtPhoto(api, receipt.id, blob, `${receipt.number}-ddt.jpg`)
    if (answer.ok) {
      const again = await fetchUnplanned(api, receipt.id)
      setDone({ receipt: again.ok ? again.value : receipt, photo: 'sent' })
    } else setDone({ receipt, photo: 'failed' })
  }

  const post = async () => {
    const holding = start?.holding ?? null
    if (sendHeld(draft, { online: navigator.onLine && online, holding, busy: busy === 'post' }) !== null) return void feedback('warning')
    const body = unplannedBody(draft, holding)
    const text = JSON.stringify(body)
    if (!postKey.current || postKey.current.body !== text) postKey.current = { body: text, key: newIdempotencyKey() }
    setBusy('post')
    const answer = await postUnplanned(api, body, postKey.current.key)
    setBusy(null)
    if (!answer.ok) return fail(answer.problem)
    feedback('success')
    postKey.current = null
    setDone({ receipt: answer.value, photo: photo ? 'sending' : null })
    setStage('done')
    if (photo) void sendPhoto(answer.value, photo.blob)
  }

  const next = () => {
    if (photo) URL.revokeObjectURL(photo.url)
    setPhoto(null)
    setDraft(emptyDraft())
    setDone(null)
    setMaterials(null)
    setMaterialQuery(null)
    setStage('supplier')
    onBack()
  }

  const onAction = (action: UnplannedAction) => {
    switch (action.type) {
      case 'back':
        return onBack()
      case 'supplierQuery':
        return setSupplierQuery(action.value.trim())
      case 'supplier': {
        const row = start?.suppliers.find((entry) => entry.id === action.id)
        if (!row) return
        feedback('success')
        setDraft((current) => ({ ...current, supplier: row }))
        return setStage(draft.lines.length > 0 ? 'lines' : 'material')
      }
      case 'materialScan':
        return void findMaterial(action.code)
      case 'material': {
        const row = materials?.find((entry) => entry.id === action.id)
        if (row) pickMaterial(row)
        return
      }
      case 'colour':
        return setDraft((current) => (current.editing ? { ...current, editing: { ...current.editing, colour: current.editing.material.colours.find((colour) => colour.id === action.id) ?? null } } : current))
      case 'quantity':
        return setDraft((current) => (current.editing ? { ...current, editing: { ...current.editing, quantity: action.value } } : current))
      case 'hideCount':
        return setDraft((current) => (current.editing ? { ...current, editing: { ...current.editing, hideCount: action.value && action.value > 0 ? Math.trunc(action.value) : null } } : current))
      case 'addLine': {
        const after = addLine(draft)
        if (after === draft) return void feedback('warning')
        feedback('success')
        setDraft(after)
        setMaterials(null)
        setMaterialQuery(null)
        return setStage('lines')
      }
      case 'editLine': {
        const line = draft.lines.find((entry) => entry.key === action.key)
        if (!line) return
        setDraft({ ...draft, editing: line })
        return setStage('quantity')
      }
      case 'removeLine':
        return setDraft(removeLine(draft, action.key))
      case 'toStage':
        if (action.stage !== 'quantity') setDraft((current) => ({ ...current, editing: null }))
        setCamera(false)
        return setStage(action.stage)
      case 'ddtScan':
        return setDraft((current) => ({ ...current, ddtNumber: ddtNumberOf(action.code) }))
      case 'ddtPad':
        return setDraft((current) => ({ ...current, ddtNumber: ddtFromPad(action.value) }))
      case 'ddtClear':
        return setDraft((current) => ({ ...current, ddtNumber: null }))
      case 'ddtDate':
        return setDraft((current) => ({ ...current, ddtDate: action.date }))
      case 'ddtMoreDays':
        return setMoreDays((open) => !open)
      case 'ddtCamera':
        return setCamera(action.open)
      case 'ddtPhoto':
        feedback('success')
        setCamera(false)
        return setPhoto((current) => {
          if (current) URL.revokeObjectURL(current.url)
          return { blob: action.photo.photo, url: URL.createObjectURL(action.photo.photo) }
        })
      case 'ddtPhotoRemove':
        return setPhoto((current) => {
          if (current) URL.revokeObjectURL(current.url)
          return null
        })
      case 'placeScan':
        feedback('success')
        setDraft((current) => ({ ...current, placeCode: action.code.trim() || null }))
        return setStage('lines')
      case 'placeClear':
        return setDraft((current) => ({ ...current, placeCode: null }))
      case 'post':
        return void post()
      case 'photoRetry':
        if (done && photo) void sendPhoto(done.receipt, photo.blob)
        return
      case 'next':
        return next()
      case 'dismiss':
        setProblem(null)
        if (!start) return void load()
        return setStage(stage === 'done' ? 'done' : firstStage(draft) === 'supplier' ? 'supplier' : stage)
      case 'retry':
        setProblem(null)
        return void (start ? post() : load())
    }
  }

  useFloorKeys({
    enter: problem ? () => onAction({ type: 'dismiss' }) : stage === 'quantity' ? () => onAction({ type: 'addLine' }) : stage === 'lines' ? () => void post() : stage === 'done' ? next : null,
    escape: problem ? () => onAction({ type: 'dismiss' }) : stage === 'quantity' || stage === 'ddt' || stage === 'place' ? () => onAction({ type: 'toStage', stage: draft.lines.length > 0 ? 'lines' : 'material' }) : stage === 'done' ? next : onBack,
  })

  if (!me) return null
  return (
    <UnplannedView
      model={{
        frame,
        online,
        held: me.notice.blocksScans,
        stage: !may ? 'noPermission' : start ? stage : 'loading',
        start,
        supplierQuery,
        materials,
        materialQuery,
        draft,
        ddt: { today: businessDate(new Date()), moreDays, camera, photo: photo ? { url: photo.url } : null },
        busy,
        problem,
        done,
      }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
