'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isApiError } from '../../../../../lib/api/errors'
import type { ApiClient } from '../../../../../lib/api/client'
import { listMachineClasses, type MachineClassChoice } from '../../../operations/depth/api'
import { useOffline } from '../../../operations/depth/online'
import { readProblem } from '../../problems'
import type { StyleNotice } from '../../record/record-model'
import { getDepth, getStyleOptions, getTimes, listCheckpointPlans, setCheckpoint, setStepMinutes, setStepSettings, setVariants, type PlanRow, type RevisionRef, type RoutingDepth, type RoutingTimesView, type StyleOptionsView } from './api'
import { sizeCellBody, type CellMark, type DepthDialog, type Part, type RoutingDepthActions, type RoutingDepthModel } from './model'

/**
 * The Routing tab's depth, its container hook (B-W2b-235 on B-W2b-215's and B-W2b-225's API): reads the routing in depth and
 * its times while the tab is open (again when the revision in view or a revision's state changes, and on `reload` — the
 * studio's live and reconnect re-read), and does what the tab asks through the studio's ONE write queue (`write`: one write
 * at a time, the band's save words, a 409 reads the style again). Every write moves the revision's version by one, which
 * the BOM and the routing share (`versionOf` / `onVersion`); `onChanged` lets the studio read its routing and cost again.
 * The pickers are read when their dialog opens: Quality's plans (quality.plans.view), the style's options, the machine
 * classes (plant.view).
 */
export function useRoutingDepth({
  api,
  styleId,
  revisionId,
  loadKey,
  enabled,
  canManage,
  companyId,
  readable,
  write,
  versionOf,
  onVersion,
  onChanged,
}: {
  api: ApiClient
  styleId: string
  revisionId: string | null
  loadKey: string | null
  enabled: boolean
  canManage: boolean
  /** The company a checkpoint plan is read for (the style's, else the page's). */
  companyId: string | null
  /** What the role reads besides the routing: Quality's plans, the machine classes. */
  readable: { plans: boolean; classes: boolean }
  write: (work: () => Promise<void>, done?: StyleNotice) => Promise<boolean>
  versionOf: (revisionId: string) => RevisionRef | null
  onVersion: (revision: RevisionRef) => void
  onChanged: () => void
}): { model: RoutingDepthModel; actions: RoutingDepthActions; reload: () => void } {
  const [depth, setDepth] = useState<Part<RoutingDepth>>({ status: 'idle' })
  const [times, setTimes] = useState<Part<RoutingTimesView>>({ status: 'idle' })
  const timesRef = useRef<RoutingTimesView | null>(null)
  const [dialog, setDialog] = useState<DepthDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [marks, setMarks] = useState<Record<string, CellMark>>({})
  const [plans, setPlans] = useState<PlanRow[] | null | 'forbidden' | 'failed'>(null)
  const [options, setOptions] = useState<StyleOptionsView | null | 'failed'>(null)
  const [classes, setClasses] = useState<MachineClassChoice[] | null>(null)
  const [notice, setNotice] = useState<StyleNotice | null>(null)
  const changed = useRef(onChanged)
  changed.current = onChanged
  const seq = useRef(0)
  const offline = useOffline()
  /** Size cells typed offline, by `${stepId}:${size}`: sent in the order typed when the browser is back online. */
  const waiting = useRef(new Map<string, { stepId: string; size: string; value: string | null }>())

  const setTimesValue = useCallback((next: RoutingTimesView) => {
    timesRef.current = next
    setTimes({ status: 'ready', value: next })
  }, [])

  const load = useCallback(
    (id: string) => {
      const mine = ++seq.current
      setDepth((current) => (current.status === 'ready' && current.value.revision.id === id ? current : { status: 'loading' }))
      setTimes((current) => (current.status === 'ready' && current.value.revision.id === id ? current : { status: 'loading' }))
      getDepth(api, styleId, id)
        .then((value) => mine === seq.current && setDepth({ status: 'ready', value }))
        .catch((error: unknown) => mine === seq.current && setDepth({ status: 'error', problem: readProblem(error) }))
      getTimes(api, styleId, id)
        .then((value) => mine === seq.current && setTimesValue(value))
        .catch((error: unknown) => mine === seq.current && setTimes({ status: 'error', problem: readProblem(error) }))
    },
    [api, styleId, setTimesValue],
  )

  useEffect(() => {
    if (!enabled || !revisionId) {
      timesRef.current = null
      setDepth({ status: 'idle' })
      setTimes({ status: 'idle' })
      return
    }
    setSelected([])
    setMarks({})
    load(revisionId)
    // The key holds the revision in view and every revision's state.
  }, [loadKey, enabled])

  const reload = useCallback(() => {
    if (enabled && revisionId) load(revisionId)
  }, [enabled, revisionId, load])

  /** One depth write per step through the studio's queue; the version moves by one per write. */
  const runDepth = async (stepIds: readonly string[], work: (target: RevisionRef, stepId: string) => Promise<RoutingDepth>, done?: StyleNotice): Promise<boolean> => {
    setBusy(true)
    const ok = await write(async () => {
      for (const stepId of stepIds) {
        const target = revisionId ? versionOf(revisionId) : null
        if (!target) return
        const next = await work(target, stepId)
        onVersion({ id: target.id, version: target.version + 1 })
        setDepth({ status: 'ready', value: next })
      }
      changed.current()
    })
    setBusy(false)
    // The studio's notice speaks its own catalogue: this tab's words are its own notice.
    setNotice(ok ? (done ?? null) : null)
    if (ok) setDialog(null)
    return ok
  }

  /** One minutes write through the studio's queue; the answer carries the revision's new version. */
  const runTimes = async (stepId: string, body: Parameters<typeof setStepMinutes>[4], done?: StyleNotice): Promise<boolean> => {
    setBusy(true)
    const ok = await write(async () => {
      const target = revisionId ? versionOf(revisionId) : null
      if (!target) return
      const next = await setStepMinutes(api, styleId, target, stepId, body)
      onVersion({ id: next.revision.id, version: next.revision.version })
      setTimesValue(next)
      changed.current()
    })
    setBusy(false)
    setNotice(ok ? (done ?? null) : null)
    return ok
  }

  const markOf = (key: string, mark: CellMark | null) =>
    setMarks((current) => {
      const next = { ...current }
      if (mark) next[key] = mark
      else delete next[key]
      return next
    })

  const actions: RoutingDepthActions = {
    onRetry: reload,
    onDialog: setDialog,
    onSelect: setSelected,
    onTimes: async (stepId, body) => {
      const ok = await runTimes(stepId, body, { key: 'depth.notice.times', tone: 'success' })
      if (ok) setDialog(null)
      return ok
    },
    onSizeCell: (stepId, size, value) => {
      const step = timesRef.current?.steps.find((entry) => entry.stepId === stepId)
      if (!step) return
      const key = `${stepId}:${size}`
      const planned = sizeCellBody(step, size, value)
      if ('problem' in planned) {
        markOf(key, { state: 'refused', value, problem: planned.problem })
        return
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        waiting.current.set(key, { stepId, size, value })
        markOf(key, { state: 'waiting', value })
        return
      }
      markOf(key, { state: 'saving', value })
      // A refusal is said by the studio's notice (its words); the cell keeps its old value with "!".
      void runTimes(stepId, planned.body).then((ok) => markOf(key, ok ? null : { state: 'refused', problem: 'times.problem.refused' }))
    },
    onVariants: (stepIds, body) => runDepth(stepIds, (target, stepId) => setVariants(api, styleId, target, stepId, body), { key: 'depth.notice.variants', tone: 'success', params: { count: stepIds.length } }),
    onCheckpoint: (stepId, planId) => runDepth([stepId], (target) => setCheckpoint(api, styleId, target, stepId, planId), { key: planId ? 'depth.notice.checkpoint' : 'depth.notice.checkpointOff', tone: 'success' }),
    onSettings: (stepId, change) => runDepth([stepId], (target) => setStepSettings(api, styleId, target, stepId, change), { key: 'fromLibrary' in change ? 'depth.notice.copied' : 'depth.notice.settings', tone: 'success', params: { count: 1 } }),
    onCopyLibrary: async (stepIds) => {
      const ok = await runDepth(stepIds, (target, stepId) => setStepSettings(api, styleId, target, stepId, { fromLibrary: true }), { key: 'depth.notice.copied', tone: 'success', params: { count: stepIds.length } })
      if (ok) setSelected([])
      return ok
    },
    onTypedRun: (stepId, standardMinutes) => runTimes(stepId, { run: { from: 'TYPED', standardMinutes } }),
    onUseLibrary: (stepId) => runTimes(stepId, { run: { from: 'VERSION' } }, { key: 'depth.notice.library', tone: 'success' }),
    onLoadPlans: () => {
      if (plans !== null && plans !== 'failed') return
      if (!readable.plans || !companyId) {
        setPlans('forbidden')
        return
      }
      listCheckpointPlans(api, companyId)
        .then(setPlans)
        .catch((error: unknown) => setPlans(isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : 'failed'))
    },
    onLoadOptions: () => {
      if (options !== null && options !== 'failed') return
      getStyleOptions(api, styleId)
        .then(setOptions)
        .catch(() => setOptions('failed'))
    },
    onLoadClasses: () => {
      if (classes !== null) return
      if (!readable.classes) {
        setClasses([])
        return
      }
      listMachineClasses(api)
        .then(setClasses)
        .catch(() => setClasses([]))
    },
    onDismissNotice: () => setNotice(null),
  }

  // Back online: what waits is sent, in the order typed.
  const onSizeCell = useRef(actions.onSizeCell)
  onSizeCell.current = actions.onSizeCell
  useEffect(() => {
    if (offline) return
    const entries = [...waiting.current.values()]
    waiting.current.clear()
    for (const entry of entries) onSizeCell.current?.(entry.stepId, entry.size, entry.value)
  }, [offline])

  const model = useMemo<RoutingDepthModel>(
    () => ({ depth, times, dialog, busy, selected, marks, plans, options, classes, notice, offline, canManage, companyId }),
    [depth, times, dialog, busy, selected, marks, plans, options, classes, notice, offline, canManage, companyId],
  )
  return { model, actions, reload }
}
