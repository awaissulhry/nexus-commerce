'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import type { Locale } from '../../../../../lib/i18n/locales'
import { readProblem } from '../../../../_shared/stock/model'
import { PART_LOADING, part, type Part } from '../../../lots/shared/model'
import { correctGrading, readGrading, readMeasures, recordMeasure, type GradingView, type MeasuresView } from './api'
import {
  applyHeldKey,
  draftOf,
  EMPTY_MEASURE,
  gradingRefusal,
  measureBodyOf,
  measureDraftHeldKey,
  measureRefusal,
  patchOf,
  type GradingActions,
  type GradingCan,
  type GradingDraft,
  type GradingModel,
  type GradingTab,
  type MeasureDialogModel,
} from './grading-model'

/**
 * The container of the hide record's "Measurements & grade" and "Defects & photos" tabs (B-W2b-131): reads the hide's
 * grading (`GET /inventory/hides/:hideId/grading`) once either tab is opened and its measures (`…/measures`) on the grade
 * tab, keeps each tab's form, sends a correction at the version the form started from (`PATCH …/grading`, one
 * Idempotency-Key per Apply, kept for a retry of the same form), measures again (`POST …/measures`, one key per dialog;
 * "Correct the area…" asks the stock correction with it), and reads again on the hide's live events (`reload`) without
 * losing what is being typed.
 */
export function useGrading(api: ApiClient, hideId: string, options: { tab: string; can: GradingCan; locale: Locale; onSaved?: () => void }) {
  const { tab, can, locale, onSaved } = options
  const wanted = tab === 'grade' || tab === 'defects'
  const [view, setView] = useState<Part<GradingView>>(PART_LOADING)
  const [measures, setMeasures] = useState<Part<MeasuresView>>(PART_LOADING)
  const [drafts, setDrafts] = useState<Record<GradingTab, GradingDraft | null>>({ grade: null, defects: null })
  const [saving, setSaving] = useState<GradingTab | null>(null)
  const [problem, setProblem] = useState<GradingModel['problem']>(null)
  const [saved, setSaved] = useState<GradingTab | null>(null)
  const [changedMeanwhile, setChangedMeanwhile] = useState(false)
  const [measure, setMeasure] = useState<MeasureDialogModel | null>(null)
  const asked = useRef({ grading: false, measures: false })
  const keys = useRef<Record<GradingTab, string | null>>({ grade: null, defects: null })
  const measureKey = useRef<string | null>(null)
  const latest = useRef({ view, drafts, measure, saving })
  latest.current = { view, drafts, measure, saving }

  /** A form the person did not touch follows the hide; a touched one keeps what was typed (Apply then answers stale). */
  const adopt = useCallback(
    (next: GradingView) => {
      const before = latest.current.view.value
      const forms = latest.current.drafts
      const result = { ...forms }
      let meanwhile = false
      for (const name of ['grade', 'defects'] as const) {
        const draft = forms[name]
        const untouched = !draft || !before || !patchOf(before, draft, name)
        if (untouched) result[name] = draftOf(next, locale)
        else if (before && next.hide.version !== before.hide.version) meanwhile = true
      }
      setView(part(next))
      setDrafts(result)
      if (meanwhile) setChangedMeanwhile(true)
    },
    [locale],
  )

  const loadGrading = useCallback(async () => {
    try {
      adopt(await readGrading(api, hideId))
    } catch (error) {
      setView((current) => (current.value ? current : { value: null, problem: readProblem(error) }))
    }
  }, [api, hideId, adopt])

  const loadMeasures = useCallback(async () => {
    try {
      setMeasures(part(await readMeasures(api, hideId)))
    } catch (error) {
      setMeasures((current) => (current.value ? current : { value: null, problem: readProblem(error) }))
    }
  }, [api, hideId])

  useEffect(() => {
    if (!wanted || asked.current.grading) return
    asked.current.grading = true
    void loadGrading()
  }, [wanted, loadGrading])

  useEffect(() => {
    if (tab !== 'grade' || asked.current.measures) return
    asked.current.measures = true
    void loadMeasures()
  }, [tab, loadMeasures])

  /** Read again what was asked already (a live event of the hide, a cut, a move). */
  const reload = useCallback(() => {
    if (asked.current.grading) void loadGrading()
    if (asked.current.measures) void loadMeasures()
  }, [loadGrading, loadMeasures])

  const apply = useCallback(
    async (name: GradingTab) => {
      const { view: read, drafts: forms, saving: busy } = latest.current
      const current = read.value
      const draft = forms[name]
      if (!current || !draft || busy || applyHeldKey(current, draft, name, can, false)) return
      const patch = patchOf(current, draft, name)
      if (!patch) return
      keys.current[name] ??= newIdempotencyKey()
      setSaving(name)
      setProblem(null)
      setSaved(null)
      try {
        const next = await correctGrading(api, hideId, patch, keys.current[name]!)
        keys.current[name] = null
        setChangedMeanwhile(false)
        setView(part(next))
        setDrafts((forms) => ({ grade: name === 'grade' || !forms.grade ? draftOf(next, locale) : { ...forms.grade, version: next.hide.version }, defects: name === 'defects' || !forms.defects ? draftOf(next, locale) : { ...forms.defects, version: next.hide.version } }))
        setSaved(name)
        onSaved?.()
      } catch (error) {
        const refused = gradingRefusal(error)
        setProblem({ tab: name, phrase: refused })
        // No answer: the same key on a retry (the office may have it). Anything else: a new key for the next Apply.
        if (refused.key !== 'stock:problem.offline') keys.current[name] = null
        // A newer version: read again; the form keeps what was typed and moves to the version now read, so the next Apply
        // is the person's choice after seeing the hide as it is (the notice says it changed meanwhile).
        if (refused.key === 'hd.grading.refused.stale') {
          readGrading(api, hideId)
            .then((next) => {
              adopt(next)
              setDrafts((now) => ({ grade: now.grade ? { ...now.grade, version: next.hide.version } : now.grade, defects: now.defects ? { ...now.defects, version: next.hide.version } : now.defects }))
            })
            .catch(() => undefined)
        }
      } finally {
        setSaving(null)
      }
    },
    [api, hideId, can, locale, onSaved, adopt],
  )

  const saveMeasure = useCallback(async () => {
    const dialog = latest.current.measure
    const hide = latest.current.view.value?.hide
    if (!dialog || dialog.done || !hide || measureDraftHeldKey(dialog.draft, dialog.posting)) return
    measureKey.current ??= newIdempotencyKey()
    setMeasure({ ...dialog, posting: true, problem: null })
    try {
      const done = await recordMeasure(api, hideId, measureBodyOf(dialog.draft, hide.area.uom), measureKey.current)
      setMeasure((now) => (now ? { ...now, posting: false, done } : now))
      void loadMeasures()
      void loadGrading()
      onSaved?.()
    } catch (error) {
      setMeasure((now) => (now ? { ...now, posting: false, problem: measureRefusal(error) } : now))
    }
  }, [api, hideId, loadMeasures, loadGrading, onSaved])

  const actions: GradingActions = {
    onDraft: (name, draft) => {
      setDrafts((forms) => ({ ...forms, [name]: draft }))
      keys.current[name] = null
      setSaved(null)
    },
    onApply: (name) => void apply(name),
    onDiscard: (name) => {
      const current = latest.current.view.value
      if (current) setDrafts((forms) => ({ ...forms, [name]: draftOf(current, locale) }))
      keys.current[name] = null
      setProblem(null)
      setChangedMeanwhile(false)
    },
    onRetry: () => {
      setView(PART_LOADING)
      void loadGrading()
    },
    onRetryMeasures: () => {
      setMeasures(PART_LOADING)
      void loadMeasures()
    },
    onDismissNotice: () => {
      setSaved(null)
      setProblem(null)
    },
    onMeasureOpen: (correcting) => {
      measureKey.current = newIdempotencyKey()
      setMeasure({ correcting, draft: { ...EMPTY_MEASURE, correctStock: correcting }, posting: false, problem: null, done: null })
    },
    onMeasureDraft: (draft) => setMeasure((now) => (now && !now.done ? { ...now, draft, problem: null } : now)),
    onMeasureSave: () => void saveMeasure(),
    onMeasureClose: () => {
      measureKey.current = null
      setMeasure(null)
    },
  }

  const model: GradingModel = { can, view, measures, gradeDraft: drafts.grade, defectsDraft: drafts.defects, saving, problem, saved, changedMeanwhile, measure }
  return { model, actions, reload }
}
