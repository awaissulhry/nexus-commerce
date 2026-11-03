'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { readProblem } from '../../../library/model'
import { createRule, editRule, getGrades, type GradeRuleRow, type GradesView } from './api'
import { cellPlan, defaultPlans, markKey, refusalOf, type CellPlan, type GradeCell, type GradeMark, type GradesActions, type GradesModel, type GradesPart, type WriteKind } from './grades-model'

/**
 * The "Grades and usable area" section's container hook (B-W2b-131; PRD-031): reads the leather's grades when the Properties
 * tab shows a leather (`enabled`), and writes one change at a time (a chain: a rule's next change goes at the version the
 * last one answered). A cell saves by itself: it shows the text typed with its mark until the server answers, then the row
 * as the API answers it; a refusal keeps the stored value with "!" and our words, and a rule changed meanwhile reads the
 * section again. Offline (the browser says so) a cell's change waits on this page, marked, and goes when the connection is
 * back; nothing else is kept. `reload` is for a live `inventory.grade_rule_changed` of this material from elsewhere.
 */
export function useGrades({ api, materialId, enabled, archived }: { api: ApiClient; materialId: string; enabled: boolean; archived: boolean }): {
  model: GradesModel
  actions: GradesActions
  reload: () => void
} {
  const [part, setPart] = useState<GradesPart>({ status: 'idle' })
  const valueRef = useRef<GradesView | null>(null)
  const [marks, setMarks] = useState<Record<string, GradeMark>>({})
  const [selected, setSelected] = useState<string[]>([])
  const [offline, setOffline] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<GradesModel['notice']>(null)
  const chain = useRef<Promise<void>>(Promise.resolve())
  const pending = useRef(0)
  const waiting = useRef(new Map<string, { gradeId: string; cell: GradeCell; text: string }>())

  const setValue = useCallback((next: GradesView) => {
    valueRef.current = next
    setPart({ status: 'ready', value: next })
    setSelected((current) => current.filter((id) => next.grades.some((row) => row.grade.id === id)))
  }, [])

  const load = useCallback(() => {
    setPart((current) => (current.status === 'ready' ? current : { status: 'loading' }))
    getGrades(api, materialId)
      .then(setValue)
      .catch((error: unknown) => setPart({ status: 'error', problem: readProblem(error) }))
  }, [api, materialId, setValue])

  useEffect(() => {
    if (!enabled) {
      valueRef.current = null
      setPart({ status: 'idle' })
      return
    }
    setMarks({})
    setSelected([])
    load()
  }, [enabled, load])

  /** A live change from elsewhere: read again, never while one of ours is on its way (its answer is the row). */
  const reload = useCallback(() => {
    if (enabled && valueRef.current && pending.current === 0) load()
  }, [enabled, load])

  const setMark = (key: string, mark: GradeMark | null) =>
    setMarks((current) => {
      const next = { ...current }
      if (mark) next[key] = mark
      else delete next[key]
      return next
    })

  /** The row as the API answered it, in its place. */
  const putRow = (row: GradeRuleRow) => {
    const view = valueRef.current
    if (!view) return
    setValue({ ...view, grades: view.grades.map((entry) => (entry.grade.id === row.grade.id ? row : entry)) })
  }

  /** One write in the chain; resolves with the refusal's key (null: written). `kind` is read once the write has run. */
  const enqueue = (kind: WriteKind | (() => WriteKind), work: () => Promise<GradeRuleRow>): Promise<string | null> => {
    pending.current += 1
    setBusy(true)
    const run = chain.current.then(async () => {
      try {
        putRow(await work())
        return null
      } catch (error) {
        // A cell whose plan became a problem at its turn (the row moved meanwhile): its own words.
        const planned = (error as { planProblem?: string } | null)?.planProblem
        if (planned) return planned
        const refusal = refusalOf(error, typeof kind === 'function' ? kind() : kind)
        if (refusal.reload) load()
        return refusal.key
      } finally {
        pending.current -= 1
        if (pending.current === 0) setBusy(false)
      }
    })
    chain.current = run.then(() => undefined)
    return run
  }

  /** A cell's plan, sent now: the row read at the moment it is sent (the version the last write answered). */
  const send = (gradeId: string, cell: GradeCell, text: string) => {
    const key = markKey(gradeId, cell)
    setMark(key, { state: 'saving', value: text })
    let kind: WriteKind = 'edit'
    void enqueue(() => kind, async () => {
      const row = valueRef.current?.grades.find((entry) => entry.grade.id === gradeId)
      if (!row) throw Object.assign(new Error('gone'), { planProblem: 'material.grades.problem.gone' })
      const plan: CellPlan = cellPlan(row, cell, text)
      if (plan.kind === 'none') return row
      if (plan.kind === 'problem') throw Object.assign(new Error(plan.problem), { planProblem: plan.problem })
      kind = plan.kind
      return plan.kind === 'create' ? createRule(api, materialId, plan.body) : editRule(api, materialId, plan.rule, plan.patch)
    }).then((problem) => setMark(key, problem ? { state: 'refused', problem } : null))
  }

  // Offline: what waits is sent when the browser is back online, in the order typed.
  useEffect(() => {
    const update = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false)
    update()
    const flush = () => {
      update()
      const entries = [...waiting.current.values()]
      waiting.current.clear()
      for (const entry of entries) send(entry.gradeId, entry.cell, entry.text)
    }
    window.addEventListener('online', flush)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', flush)
      window.removeEventListener('offline', update)
    }
  })

  const actions: GradesActions = {
    onRetry: load,
    onSelect: (ids) => setSelected(ids),
    onDismissNotice: () => setNotice(null),
    onCell: (row, cell, text) => {
      const key = markKey(row.grade.id, cell)
      const plan = cellPlan(row, cell, text)
      if (plan.kind === 'problem') {
        setMark(key, { state: 'refused', value: text, problem: plan.problem })
        return
      }
      if (plan.kind === 'none') {
        setMark(key, null)
        return
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        waiting.current.set(key, { gradeId: row.grade.id, cell, text })
        setMark(key, { state: 'waiting', value: text })
        setOffline(true)
        return
      }
      send(row.grade.id, cell, text)
    },
    onDefault: (gradeIds) => {
      const view = valueRef.current
      if (!view) return
      const plans = defaultPlans(view.grades, gradeIds)
      void Promise.all(plans.map((plan) => enqueue('retire', () => editRule(api, materialId, plan.rule, { active: false })))).then((problems) => {
        const refused = problems.find((problem) => problem !== null)
        setNotice(refused ? { key: refused, tone: 'danger' } : { key: 'material.grades.notice.default', tone: 'success', params: { count: plans.length } })
        if (!refused) setSelected([])
      })
    },
    onUseAgain: (row, ruleId) => {
      const rule = row.retiredRules.find((entry) => entry.id === ruleId)
      if (!rule) return
      void enqueue('reactivate', () => editRule(api, materialId, rule, { active: true })).then((problem) =>
        setNotice(problem ? { key: problem, tone: 'danger' } : { key: 'material.grades.notice.usedAgain', tone: 'success', params: { grade: row.grade.code } }),
      )
    },
  }

  const model = useMemo<GradesModel>(() => ({ part, marks, selected, offline, busy, archived, notice }), [part, marks, selected, offline, busy, archived, notice])
  return { model, actions, reload }
}
