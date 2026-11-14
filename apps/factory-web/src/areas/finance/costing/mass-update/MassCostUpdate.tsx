'use client'

import { useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { isStepUpCancelled, useStepUp } from '../../_shared/hooks'
import { applyMassUpdate, findMaterials, previewMassUpdate, type MassApplyView, type MassPreviewView, type MaterialRow } from './api'
import { changesOf, massAbilitiesOf, massProblem, massRefusal, priceRowOf, type PriceRow } from './model'
import { MassUpdateDialog, type MassStep, type MassUpdateModel } from './view/MassUpdateDialog'

/**
 * Finance › Costing › Mass cost update (B-W2b-430), the container the Standard vs actual band mounts (CostingView's `mass`
 * slot): finds materials, keeps the new prices typed, asks the preview (POST …/preview), applies it with the preview's hash
 * after a fresh code (asked first; a late 403 `stepUp` asks again and the apply runs once more with the same key). STALE: the
 * effect is read again and shown before anything is written; NOT_RECOMPUTED: the person may leave the missing inputs out.
 */
export function MassCostUpdate({ prefix }: { prefix: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => massAbilitiesOf(session.permissions), [session.permissions])
  const { stepUp, guard, ensureFresh, submitStepUp, cancelStepUp } = useStepUp(api)
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<MassStep>('prices')
  const [rows, setRows] = useState<readonly PriceRow[]>([])
  const [search, setSearch] = useState<MassUpdateModel['search']>({ text: '', results: null, busy: false, problem: null })
  const [preview, setPreview] = useState<MassPreviewView | null>(null)
  const [applied, setApplied] = useState<MassApplyView | null>(null)
  const [leaveOut, setLeaveOut] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const attempt = useRef<string | null>(null)

  const reset = () => {
    setStep('prices')
    setRows([])
    setSearch({ text: '', results: null, busy: false, problem: null })
    setPreview(null)
    setApplied(null)
    setLeaveOut(false)
    setNote('')
    setProblem(null)
    setStale(false)
    attempt.current = null
  }

  const runPreview = async (again: boolean) => {
    setBusy(true)
    setProblem(again ? 'massRefusal.STALE' : null)
    setStale(again)
    try {
      setPreview(await previewMassUpdate(api, changesOf(rows)))
      setStep('effect')
      attempt.current = null
    } catch (error) {
      setProblem(massProblem(error))
      setStale(false)
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    if (!preview || busy) return
    attempt.current ??= newIdempotencyKey()
    const key = attempt.current
    setBusy(true)
    setProblem(null)
    setStale(false)
    try {
      await ensureFresh('mass.stepUp.sentence')
      const answer = await guard('mass.stepUp.sentence', () => applyMassUpdate(api, { changes: changesOf(rows), previewHash: preview.previewHash, ...(leaveOut ? { leaveOutMissing: true } : {}), ...(note.trim() ? { note: note.trim() } : {}) }, key))
      attempt.current = null
      setApplied(answer)
      setStep('done')
    } catch (error) {
      if (isStepUpCancelled(error)) return
      const code = massRefusal(error)
      attempt.current = null
      if (code === 'STALE') {
        setBusy(false)
        await runPreview(true)
        return
      }
      setProblem(massProblem(error))
    } finally {
      setBusy(false)
    }
  }

  const model: MassUpdateModel = {
    prefix,
    can,
    open,
    step,
    rows,
    search,
    preview,
    applied,
    leaveOut,
    note,
    busy,
    problem,
    stale,
    stepUp: { open: stepUp.open, busy: stepUp.busy, problem: stepUp.problem ? stepUp.problem.replace('stepUp.problem.', 'verStepUp.problem.') : null },
  }

  return (
    <MassUpdateDialog
      model={model}
      actions={{
        onOpen: () => {
          reset()
          setOpen(true)
        },
        onClose: () => {
          setOpen(false)
          reset()
        },
        onSearch: (text) => {
          setSearch({ text, results: search.results, busy: true, problem: null })
          findMaterials(api, text)
            .then((results) => setSearch({ text, results, busy: false, problem: null }))
            .catch(() => setSearch({ text, results: null, busy: false, problem: 'mass.problem.search' }))
        },
        onAdd: (material: MaterialRow) => setRows((current) => (current.some((row) => row.itemId === material.id) ? current : [...current, priceRowOf(material)])),
        onPrice: (itemId, text) => setRows((current) => current.map((row) => (row.itemId === itemId ? { ...row, newPrice: text } : row))),
        onRemove: (itemId) => setRows((current) => current.filter((row) => row.itemId !== itemId)),
        onPreview: () => void runPreview(false),
        onBack: () => {
          setStep('prices')
          setProblem(null)
          setStale(false)
        },
        onLeaveOut: setLeaveOut,
        onNote: setNote,
        onApply: () => void apply(),
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
      }}
    />
  )
}
