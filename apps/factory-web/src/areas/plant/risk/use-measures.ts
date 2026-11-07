'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { addMeasure, editMeasure, fileAddress, listSheets, moveMeasure, readMeasure, readOwners, uploadFile, type Assessment, type Measure, type Owner } from './api'
import { EMPTY_MEASURE, measureBodyOf, measureDraftOf, measureEditOf, moveAsks, problemOf, readProblemOf, type MeasureStatus, type RiskCan } from './model'
import type { CellState, MeasureActions, MeasureDialogState, MoveState, PageNotice, Read } from './view-model'

export interface MeasureDeskInput {
  readonly api: ApiClient
  readonly can: RiskCan
  readonly companyId: string | null
  readonly locale: string
  /** A measure as the API answered it after a write: the list shows it at once. */
  readonly onMeasure: (measure: Measure) => void
  /** After a write: the tiles, the record's figures, the list read again. */
  readonly onWritten: () => void
  readonly onNotice: (notice: PageNotice) => void
  /** The assessment a new measure is for (its site's roles, its versions). */
  readonly assessmentOf: (id: string) => Assessment | null
}

/**
 * ONE hook for the improvement plan's writes (the page's section and the record's plan tab share it): the inline cells
 * (owner, due: PATCH with the version read; the status: POST …/status, a move to done or cancelled asking first), Add measure,
 * a measure's own window (edit, its evidence files, its moves), the owners to choose from. Each write carries its own
 * Idempotency-Key; what the API refuses is said in our words at the cell or in the dialog.
 */
export function useMeasureDesk({ api, can, companyId, locale, onMeasure, onWritten, onNotice, assessmentOf }: MeasureDeskInput) {
  const [cells, setCells] = useState<Record<string, CellState>>({})
  const [owners, setOwners] = useState<Read<readonly Owner[]> | null>(null)
  const [dialog, setDialog] = useState<MeasureDialogState | null>(null)
  const [move, setMove] = useState<MoveState | null>(null)
  const moveFiles = useRef<File[]>([])
  const latest = useRef({ onMeasure, onWritten, onNotice, assessmentOf })
  latest.current = { onMeasure, onWritten, onNotice, assessmentOf }

  const readOwnersNow = useCallback(() => {
    if (!can.manage || !companyId) return
    setOwners({ status: 'loading' })
    readOwners(api, companyId).then(
      (value) => setOwners({ status: 'ready', value }),
      (error: unknown) => setOwners({ status: 'error', problem: readProblemOf(error) }),
    )
  }, [api, can.manage, companyId])
  useEffect(() => {
    readOwnersNow()
  }, [readOwnersNow])

  const mark = useCallback((key: string, cell: CellState | null) => {
    setCells((current) => {
      const next = { ...current }
      if (cell) next[key] = cell
      else delete next[key]
      return next
    })
    if (cell?.state === 'saved') setTimeout(() => setCells((current) => (current[key]?.state === 'saved' ? Object.fromEntries(Object.entries(current).filter(([name]) => name !== key)) : current)), 2400)
  }, [])

  // ---- the cells -------------------------------------------------------------------------------------------------------------

  const editCell = useCallback(
    (measure: Measure, change: { ownerId?: string | null; dueOn?: string | null }, cell: 'owner' | 'due') => {
      const key = `${measure.id}:${cell}`
      mark(key, { state: 'saving' })
      editMeasure(api, measure.id, { version: measure.version, ...change }, newIdempotencyKey()).then(
        (saved) => {
          mark(key, { state: 'saved' })
          latest.current.onMeasure(saved)
          latest.current.onWritten()
        },
        (error: unknown) => mark(key, { state: 'refused', key: problemOf(error).key }),
      )
    },
    [api, mark],
  )

  const runMove = useCallback(
    async (measure: Measure, to: MeasureStatus, extra: { evidenceNote?: string | null; reason?: string | null } = {}) => {
      const saved = await moveMeasure(api, measure.id, { version: measure.version, status: to, ...extra }, newIdempotencyKey())
      latest.current.onMeasure(saved)
      latest.current.onWritten()
      return saved
    },
    [api],
  )

  const startMove = useCallback(
    (measure: Measure, to: MeasureStatus) => {
      if (to === measure.status) return
      if (moveAsks(to)) {
        moveFiles.current = []
        setMove({ measure, to, evidenceNote: '', reason: '', files: [], busy: false, problem: null })
        return
      }
      const key = `${measure.id}:status`
      mark(key, { state: 'saving' })
      runMove(measure, to).then(
        (saved) => {
          mark(key, { state: 'saved' })
          setDialog((current) => (current?.id === saved.id && current.read?.status === 'ready' ? { ...current, read: { status: 'ready', value: { ...current.read.value, measure: saved } } } : current))
        },
        (error: unknown) => mark(key, { state: 'refused', key: problemOf(error).key }),
      )
    },
    [mark, runMove],
  )

  const applyMove = useCallback(async () => {
    if (!move || move.busy) return
    setMove({ ...move, busy: true, problem: null })
    try {
      for (const file of moveFiles.current) await uploadFile(api, { type: 'RiskMeasure', id: move.measure.id, companyId: move.measure.companyId }, file)
      const saved = await runMove(move.measure, move.to, move.to === 'DONE' ? { evidenceNote: move.evidenceNote.trim() || null } : { reason: move.reason.trim() || null })
      moveFiles.current = []
      setMove(null)
      latest.current.onNotice({ tone: 'success', key: `moved.${move.to}`, params: { measure: saved.title } })
      setDialog((current) => (current?.id === saved.id ? { ...current, read: current.read?.status === 'ready' ? { status: 'ready', value: { ...current.read.value, measure: saved } } : current.read } : current))
    } catch (error) {
      setMove((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }, [api, move, runMove])

  // ---- Add measure and a measure's window ---------------------------------------------------------------------------------------

  const readSheetsFor = useCallback(
    (assessmentId: string | null) => {
      const assessment = assessmentId ? latest.current.assessmentOf(assessmentId) : null
      if (!assessment) return setDialog((current) => (current ? { ...current, sheets: null } : current))
      setDialog((current) => (current ? { ...current, sheets: { status: 'loading' } } : current))
      listSheets(api, { siteId: assessment.siteId }).then(
        (answer) => setDialog((current) => (current && current.draft.assessmentId === assessmentId ? { ...current, sheets: { status: 'ready', value: answer.roleSheets } } : current)),
        (error: unknown) => setDialog((current) => (current && current.draft.assessmentId === assessmentId ? { ...current, sheets: { status: 'error', problem: readProblemOf(error) } } : current)),
      )
    },
    [api],
  )

  const openAdd = useCallback(
    (assessmentId: string | null) => {
      setDialog((current) =>
        current
          ? current.mode === 'add' && !current.draft.assessmentId && assessmentId
            ? { ...current, draft: { ...current.draft, assessmentId } }
            : current
          : { mode: 'add', id: null, read: null, draft: { ...EMPTY_MEASURE, assessmentId }, owners, sheets: null, busy: false, uploading: false, problem: null },
      )
      if (assessmentId) readSheetsFor(assessmentId)
      if (!owners) readOwnersNow()
    },
    [owners, readOwnersNow, readSheetsFor],
  )

  const openEdit = useCallback(
    (id: string) => {
      setDialog((current) => (current?.id === id ? current : { mode: 'edit', id, read: { status: 'loading' }, draft: { ...EMPTY_MEASURE }, owners, sheets: null, busy: false, uploading: false, problem: null }))
      readMeasure(api, id).then(
        (answer) => {
          setDialog((current) => (current?.id === id ? { ...current, read: { status: 'ready', value: { measure: answer.measure, canUpload: answer.canUpload } }, draft: measureDraftOf(answer.measure, locale) } : current))
          readSheetsFor(answer.measure.assessmentId)
        },
        (error: unknown) => setDialog((current) => (current?.id === id ? { ...current, read: { status: 'error', problem: readProblemOf(error) } } : current)),
      )
      if (!owners) readOwnersNow()
    },
    [api, locale, owners, readOwnersNow, readSheetsFor],
  )

  // The owners follow into an open dialog.
  useEffect(() => setDialog((current) => (current ? { ...current, owners } : current)), [owners])

  const close = useCallback(() => setDialog(null), [])

  const save = useCallback(async () => {
    if (!dialog || dialog.busy) return
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      if (dialog.mode === 'add') {
        if (!dialog.draft.assessmentId) return
        const measure = await addMeasure(
          api,
          { ...measureBodyOf(dialog.draft, can.cost), assessmentId: dialog.draft.assessmentId, source: dialog.draft.source, ...(dialog.draft.source === 'DVR' && dialog.draft.versionId ? { versionId: dialog.draft.versionId } : {}), status: dialog.draft.status },
          newIdempotencyKey(),
        )
        setDialog(null)
        latest.current.onMeasure(measure)
        latest.current.onNotice({ tone: 'success', key: 'notice.measureAdded', params: { measure: measure.title } })
      } else if (dialog.read?.status === 'ready') {
        const before = dialog.read.value.measure
        const canUpload = dialog.read.value.canUpload
        const measure = await editMeasure(api, before.id, { version: before.version, ...measureEditOf(before, dialog.draft, can.cost, locale) }, newIdempotencyKey())
        setDialog((current) => (current?.id === measure.id ? { ...current, busy: false, read: { status: 'ready', value: { measure, canUpload } }, draft: measureDraftOf(measure, locale) } : current))
        latest.current.onMeasure(measure)
        latest.current.onNotice({ tone: 'success', key: 'notice.measureSaved', params: { measure: measure.title } })
      }
      latest.current.onWritten()
    } catch (error) {
      setDialog((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }, [api, can.cost, dialog, locale])

  const addEvidence = useCallback(
    async (files: File[]) => {
      if (!dialog || dialog.read?.status !== 'ready' || dialog.uploading || files.length === 0) return
      const measure = dialog.read.value.measure
      setDialog({ ...dialog, uploading: true, problem: null })
      try {
        for (const file of files) await uploadFile(api, { type: 'RiskMeasure', id: measure.id, companyId: measure.companyId }, file)
        const answer = await readMeasure(api, measure.id)
        setDialog((current) => (current?.id === measure.id ? { ...current, uploading: false, read: { status: 'ready', value: { measure: answer.measure, canUpload: answer.canUpload } } } : current))
        latest.current.onMeasure(answer.measure)
      } catch (error) {
        setDialog((current) => (current ? { ...current, uploading: false, problem: problemOf(error) } : current))
      }
    },
    [api, dialog],
  )

  const openFile = useCallback(
    (fileId: string) => {
      fileAddress(api, fileId).then(
        (url) => window.open(url, '_blank', 'noopener'),
        (error: unknown) => latest.current.onNotice({ tone: 'warning', key: problemOf(error).key === 'problem.forbidden' ? 'problem.fileForbidden' : 'problem.file' }),
      )
    },
    [api],
  )

  const actions: MeasureActions = {
    onMeasureEdit: editCell,
    onMeasureMove: startMove,
    onMoveDraft: (change) => setMove((current) => (current ? { ...current, ...change, problem: null } : current)),
    onMoveFiles: (files) => {
      moveFiles.current = [...moveFiles.current, ...files]
      setMove((current) => (current ? { ...current, files: moveFiles.current.map((file) => ({ name: file.name, size: file.size })) } : current))
    },
    onMoveApply: () => void applyMove(),
    onMoveClose: () => {
      moveFiles.current = []
      setMove(null)
    },
    onMeasureDraft: (draft) => {
      const assessmentChanged = dialog?.draft.assessmentId !== draft.assessmentId
      setDialog((current) => (current ? { ...current, draft, problem: null } : current))
      if (assessmentChanged) readSheetsFor(draft.assessmentId)
    },
    onMeasureSave: () => void save(),
    onMeasureEvidence: (files) => void addEvidence(files),
    onOpenFile: openFile,
    onRetryOwners: readOwnersNow,
  }

  return { cells, owners, dialog, move, openAdd, openEdit, close, actions }
}
