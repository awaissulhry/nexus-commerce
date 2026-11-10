'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { listPoms, listRules, lookAtPomPicture } from '../../../sizes/depth/api'
import { readProblemOf } from '../../../sizes/depth/model'
import type { StyleNotice } from '../record-model'
import { addPoints, applyGrade, getSpec, moveSpec, orderPoints, previewGrade, removePoints, startSpec, updateSpec, writeCells, type CellInput, type MeasurementSpecView } from './api'
import { cellProblemOf, movedPoints, specCellProblem, specMarkKey, specProblem, specRowsOf, type GradeState, type SpecActions, type SpecCan, type SpecDialog, type SpecMark, type SpecModel, type SpecPart } from './spec-model'

/**
 * The Measurement spec section's container hook (B-W2b-240; SCR-344): reads the spec of the revision in view while the
 * Sizes & measurements tab is open (a role without the BOM's read reads nothing), and does what the section asks through
 * the studio's ONE write queue (`write`), each write at the spec's version as it is when its turn comes. A cell saves by
 * itself: the value typed shows with its mark until the server answers; a refusal keeps the old value with "!" and our
 * words; offline it waits on this page, marked, and is sent when the connection is back. Apply grade rule reads its
 * preview again whenever the rule or "keep typed values" changes; the grade rules of the scale and the library's
 * garment points are read when their dialog opens.
 */
export function useSpec({
  api,
  styleId,
  revisionId,
  scaleId,
  loadKey,
  enabled,
  can,
  write,
}: {
  api: ApiClient
  styleId: string
  revisionId: string | null
  scaleId: string | null
  loadKey: string | null
  enabled: boolean
  can: SpecCan
  write: (work: () => Promise<void>, done?: StyleNotice) => Promise<boolean>
}): { model: SpecModel; actions: SpecActions; reload: () => void } {
  const [part, setPart] = useState<SpecPart>({ status: 'idle' })
  const valueRef = useRef<MeasurementSpecView | null>(null)
  const [marks, setMarks] = useState<Record<string, SpecMark>>({})
  const [selected, setSelected] = useState<string[]>([])
  const [dialog, setDialog] = useState<SpecDialog | null>(null)
  const [notice, setNotice] = useState<SpecModel['notice']>(null)
  const [offline, setOffline] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rules, setRules] = useState<SpecModel['rules']>(null)
  const [library, setLibrary] = useState<SpecModel['library']>(null)
  const [grade, setGrade] = useState<GradeState | null>(null)
  const [looks, setLooks] = useState<SpecModel['looks']>({})
  const [refused, setRefused] = useState<SpecModel['refused']>(null)
  const waiting = useRef(new Map<string, { pointId: string; size: string; value: string | null }>())
  const previewSeq = useRef(0)

  const setValue = useCallback((next: MeasurementSpecView) => {
    valueRef.current = next
    setPart({ status: 'ready', value: next })
    setSelected((current) => current.filter((id) => next.points.some((point) => point.pointOfMeasureId === id)))
  }, [])

  const load = useCallback(
    (id: string) => {
      setPart((current) => (current.status === 'ready' && current.value.revision.id === id ? current : { status: 'loading' }))
      getSpec(api, styleId, id)
        .then(setValue)
        .catch((error: unknown) => setPart({ status: 'error', problem: readProblemOf(error) }))
    },
    [api, styleId, setValue],
  )

  useEffect(() => {
    if (!enabled || !revisionId) {
      valueRef.current = null
      setPart({ status: 'idle' })
      return
    }
    setMarks({})
    setSelected([])
    load(revisionId)
    // The key holds the revision in view and every revision's state.
  }, [loadKey, enabled])

  const reload = useCallback(() => {
    if (enabled && revisionId && valueRef.current) load(revisionId)
  }, [enabled, revisionId, load])

  const setMark = (key: string, mark: SpecMark | null) =>
    setMarks((current) => {
      const next = { ...current }
      if (mark) next[key] = mark
      else delete next[key]
      return next
    })

  /** One write through the studio's queue, at the spec's version when its turn comes. */
  const run = async (work: (revision: string, version: number) => Promise<MeasurementSpecView>, quiet = false): Promise<{ ok: boolean; failure: unknown }> => {
    let failure: unknown = null
    setBusy(true)
    if (!quiet) setRefused(null)
    const ok = await write(async () => {
      if (!revisionId) return
      try {
        setValue(await work(revisionId, valueRef.current?.spec?.version ?? 1))
      } catch (error) {
        failure = error
        throw error
      }
    })
    setBusy(false)
    if (!ok && !quiet) {
      const problem = specProblem(failure)
      setRefused({ key: problem.key, messages: problem.messages })
      if (problem.reload && revisionId) load(revisionId)
    }
    return { ok, failure }
  }

  const sendCell = async (pointId: string, size: string, value: string | null) => {
    const key = specMarkKey(pointId, size)
    setMark(key, { state: 'saving', value })
    const { ok, failure } = await run((revision, version) => writeCells(api, styleId, revision, version, [{ pointOfMeasureId: pointId, size, nominal: value }]), true)
    setMark(key, ok ? null : { state: 'refused', problem: specCellProblem(failure) })
  }

  useEffect(() => {
    const update = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false)
    update()
    const flush = () => {
      update()
      const entries = [...waiting.current.values()]
      waiting.current.clear()
      void entries.reduce<Promise<void>>((chain, entry) => chain.then(() => sendCell(entry.pointId, entry.size, entry.value)), Promise.resolve())
    }
    window.addEventListener('online', flush)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', flush)
      window.removeEventListener('offline', update)
    }
  })

  const readPreview = (ruleId: string, keepOverrides: boolean) => {
    const mine = ++previewSeq.current
    setGrade({ ruleId, keepOverrides, preview: ruleId ? { status: 'loading' } : { status: 'idle' } })
    if (!ruleId || !revisionId) return
    previewGrade(api, styleId, revisionId, ruleId, keepOverrides)
      .then((value) => mine === previewSeq.current && setGrade({ ruleId, keepOverrides, preview: { status: 'ready', value } }))
      .catch((error: unknown) => mine === previewSeq.current && setGrade({ ruleId, keepOverrides, preview: { status: 'error', problem: specProblem(error).key } }))
  }

  const readRules = () => {
    if (rules !== null || !scaleId || !can.library) {
      if (!can.library || !scaleId) setRules([])
      return
    }
    listRules(api, { scaleId, status: 'ACTIVE', limit: 200 })
      .then((page) => setRules(page.rules.map((rule) => ({ id: rule.id, code: rule.code, name: rule.name, baseSize: rule.baseSize, format: rule.format }))))
      .catch(() => setRules([]))
  }

  const openDialog = (next: SpecDialog | null) => {
    setDialog(next)
    setRefused(null)
    if (next?.kind === 'grade') {
      readRules()
      const view = valueRef.current
      const ruleId = view?.spec?.gradeRule?.status === 'ACTIVE' ? view.spec.gradeRule.id : ''
      readPreview(ruleId, true)
    } else setGrade(null)
    if (next?.kind === 'settings' || next?.kind === 'start') readRules()
    if (next?.kind === 'add' && library === null) {
      if (!can.library) setLibrary([])
      else
        listPoms(api, { kind: 'GARMENT', status: 'ACTIVE', limit: 200 })
          .then((page) => setLibrary(page.points.map((point) => ({ id: point.id, code: point.code, name: point.name, uom: point.uom, defaultTolerance: point.defaultTolerance }))))
          .catch(() => setLibrary([]))
    }
  }

  const done = (key: string, params?: Record<string, string | number>) => {
    setDialog(null)
    setNotice({ key, tone: 'success', params })
  }

  const actions: SpecActions = {
    onRetry: () => revisionId && load(revisionId),
    onSelect: setSelected,
    onDialog: openDialog,
    onDismissNotice: () => setNotice(null),
    onCell: (pointId, size, value) => {
      const key = specMarkKey(pointId, size)
      const problem = cellProblemOf(value)
      if (problem) return setMark(key, { state: 'refused', value, problem })
      const before = valueRef.current?.points.find((point) => point.pointOfMeasureId === pointId)?.cells.find((cell) => cell.size === size)?.value ?? null
      if ((before === null && value === null) || (before !== null && value !== null && Number(before.nominal) === Number(value))) return setMark(key, null)
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        waiting.current.set(key, { pointId, size, value })
        setOffline(true)
        return setMark(key, { state: 'waiting', value })
      }
      void sendCell(pointId, size, value)
    },
    onRefused: (pointId, size) => setMark(specMarkKey(pointId, size), { state: 'refused', problem: 'spec.problem.notNumber' }),
    onStart: async (body) => {
      const { ok } = await run((revision) => startSpec(api, styleId, revision, { baseSize: body.baseSize, gradeRuleId: body.gradeRuleId, ...(body.copyFromSpecId ? { copyFromSpecId: body.copyFromSpecId } : {}) }))
      if (ok) done('spec.notice.started')
      return ok
    },
    onSettings: async (patch) => {
      const { ok } = await run((revision, version) => updateSpec(api, styleId, revision, version, patch))
      if (ok) done('spec.notice.settings')
      return ok
    },
    onAdd: async (points) => {
      const { ok } = await run((revision, version) => addPoints(api, styleId, revision, version, points))
      if (ok) done('spec.notice.added', { count: points.length })
      return ok
    },
    onCells: async (cells, words) => {
      const { ok } = await run((revision, version) => writeCells(api, styleId, revision, version, cells))
      if (ok) done(words.key, words.params)
      return ok
    },
    onRemove: async (ids) => {
      const { ok } = await run((revision, version) => removePoints(api, styleId, revision, version, ids))
      if (ok) {
        setSelected([])
        done('spec.notice.removed', { count: ids.length })
      }
      return ok
    },
    onMove: (pointId, delta) => {
      const view = valueRef.current
      const order = view ? movedPoints(specRowsOf(view), pointId, delta) : null
      if (order) void run((revision, version) => orderPoints(api, styleId, revision, version, order))
    },
    onGrade: (ruleId, keepOverrides) => readPreview(ruleId, keepOverrides),
    onApplyGrade: async () => {
      const current = grade
      if (!current?.ruleId) return false
      let written = 0
      const { ok } = await run(async (revision, version) => {
        const answer = await applyGrade(api, styleId, revision, version, current.ruleId, current.keepOverrides)
        written = answer.applied.cells.filter((cell) => cell.action === 'ADD' || cell.action === 'CHANGE' || cell.action === 'OVERWRITE').length
        return answer.spec
      })
      if (ok) {
        setGrade(null)
        done('spec.notice.graded', { count: written })
      }
      return ok
    },
    onSpecMove: async (move, reason) => {
      const { ok } = await run((revision, version) => moveSpec(api, styleId, revision, move, version, reason))
      if (ok) done(`spec.notice.${move}`)
      return ok
    },
    onLook: (pointId) => {
      if (looks[pointId]?.state === 'ready' || looks[pointId]?.state === 'loading') return
      setLooks((current) => ({ ...current, [pointId]: { state: 'loading' } }))
      lookAtPomPicture(api, pointId)
        .then((url) => setLooks((current) => ({ ...current, [pointId]: { state: 'ready', url } })))
        .catch(() => setLooks((current) => ({ ...current, [pointId]: { state: 'error' } })))
    },
  }

  const model = useMemo<SpecModel>(() => ({ part, can, marks, selected, dialog, offline, notice, busy, rules, library, grade, looks, refused }), [part, can, marks, selected, dialog, offline, notice, busy, rules, library, grade, looks, refused])
  return { model, actions, reload }
}

export type { CellInput }
