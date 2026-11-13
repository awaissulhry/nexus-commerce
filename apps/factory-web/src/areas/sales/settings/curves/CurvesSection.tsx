'use client'

import { useCallback, useEffect, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLiveChanges } from '../../../../record-panels/live'
import { readProblem, writeProblem } from '../../quotes/problems'
import { mayKeep } from '../templates/model'
import { createCurve, listCurves, listScales, setCurvesStatus, updateCurve, type SizeCurve } from './api'
import { curveProblems, draftOfCurve, movableCurves, sharesBody, type CurveStatusFilter } from './model'
import type { CurveDialogModel } from './view/CurveDialog'
import { CurvesView, type CurvesModel } from './view/CurvesView'

/**
 * Sales settings › Size curves (B-W2b-316; SCR-235's section, mounted by SalesSettingsPage): reads every curve (one scale
 * shown at a time), opens one (or a new one: the scales come from the product library), saves with the curve's version,
 * archives and restores the ticked ones all or none. Live `size_curve.changed` reads the list again.
 */
export function SizeCurvesSection() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const may = mayKeep(session.permissions)
  const companyId = session.company?.id ?? null
  const [curves, setCurves] = useState<CurvesModel['curves']>({ status: 'loading' })
  const [scaleId, setScaleId] = useState('')
  const [status, setStatus] = useState<CurveStatusFilter>('ACTIVE')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<CurvesModel['notice']>(null)
  const [dialog, setDialog] = useState<(CurveDialogModel & { curve: SizeCurve | null }) | null>(null)

  const load = useCallback(async () => {
    try {
      setCurves({ status: 'ready', value: await listCurves(api, { status: 'ALL' }) })
    } catch (error) {
      setCurves({ status: 'error', problem: readProblem(error) })
    }
  }, [api])
  useEffect(() => {
    void load()
  }, [load])
  useLiveChanges({ onChange: (change) => change.type === 'size_curve.changed' && void load(), onReconnect: () => void load() })

  const companies = session.companies.map((company) => ({ id: company.id, code: company.code, name: company.name }))
  const open = (id: string | 'new') => {
    if (id === 'new') {
      setDialog({ mode: 'new', curve: null, draft: { name: '', scaleId: scaleId, companyId: companyId ?? '', shares: {} }, scales: { status: 'loading', items: [] }, companies, archived: false, mayKeep: may, saving: false, problem: null })
      listScales(api, companyId)
        .then((items) => setDialog((current) => (current ? { ...current, scales: { status: 'ready', items } } : current)))
        .catch(() => setDialog((current) => (current ? { ...current, scales: { status: 'error', items: [] } } : current)))
      return
    }
    const curve = curves.status === 'ready' ? curves.value.find((entry) => entry.id === id) : undefined
    if (!curve) return
    setDialog({ mode: 'edit', curve, draft: draftOfCurve(curve), scales: { status: 'ready', items: [{ id: curve.sizeScale.id, code: curve.sizeScale.code, name: curve.sizeScale.name, codes: curve.sizeScale.sizes }] }, companies, archived: curve.status === 'ARCHIVED', mayKeep: may, saving: false, problem: null })
  }

  const save = async () => {
    const current = dialog
    if (!current || current.saving || curveProblems(current.draft).length > 0) return
    const scale = current.scales.items.find((entry) => entry.id === current.draft.scaleId)
    if (!scale) return
    setDialog({ ...current, saving: true, problem: null })
    try {
      const shares = sharesBody(current.draft, scale.codes)
      if (current.mode === 'new') await createCurve(api, { companyId: current.draft.companyId || null, sizeScaleId: scale.id, name: current.draft.name.trim(), shares })
      else if (current.curve) await updateCurve(api, current.curve, { name: current.draft.name.trim(), shares })
      setDialog(null)
      setScaleId(scale.id)
      setNotice({ words: { key: current.mode === 'new' ? 'curve.done.created' : 'curve.done.saved', params: { name: current.draft.name.trim() } }, tone: 'success' })
      void load()
    } catch (error) {
      setDialog((state) => (state ? { ...state, saving: false, problem: { ns: 'sales', key: writeProblem(error).key } } : state))
    }
  }

  const move = async (to: 'archive' | 'restore') => {
    if (curves.status !== 'ready') return
    const chosen = movableCurves(curves.value, selected, to)
    if (chosen.length === 0) return
    setBusy(true)
    try {
      await setCurvesStatus(api, chosen, to === 'archive' ? 'ARCHIVED' : 'ACTIVE')
      setNotice({ words: { key: to === 'archive' ? 'curve.done.archived' : 'curve.done.restored', params: { count: chosen.length } }, tone: 'success' })
      setSelected([])
    } catch (error) {
      setNotice({ words: { ns: 'sales', key: writeProblem(error).key }, tone: 'danger' })
    } finally {
      setBusy(false)
      void load()
    }
  }

  const model: CurvesModel = { curves, scaleId, status, selected, mayKeep: may, busy, notice, dialog }
  return (
    <CurvesView
      model={model}
      actions={{
        onScale: (id) => {
          setScaleId(id)
          setSelected([])
        },
        onStatus: setStatus,
        onSelect: setSelected,
        onOpen: open,
        onMove: (to) => void move(to),
        onRetry: () => void load(),
        onDismissNotice: () => setNotice(null),
        dialog: {
          onDraft: (patch) => setDialog((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current)),
          onSave: () => void save(),
          onClose: () => setDialog(null),
        },
      }}
    />
  )
}
