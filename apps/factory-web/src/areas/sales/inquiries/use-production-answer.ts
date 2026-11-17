'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { readProductionSuggestion, setProductionAnswer, type InquiryView } from './api'
import { inquiriesCan, refusalCode, type Notice } from './model'
import {
  answersHere,
  companyToday,
  draftFromSuggestion,
  productionBodyOf,
  productionDraftOf,
  productionHeld,
  productionProblem,
  productionProblems,
  savedNotice,
  suggestionProblem,
  takeBackBodyOf,
  weekChoices,
  type PlantChoice,
  type ProductionActions,
  type ProductionEditor,
  type ProductionModel,
} from './production-answer'

/**
 * B-TH-290: production's answer on a request, the container (the reading pane and the request's full page share it through
 * use-inquiry): who types it (the record's productionAction, held with why), the editor in Details with the weeks offered, planning's
 * suggestion asked when the editor opens (GET …/suggestion, nothing written; only for a reader of promise dates; a company with
 * several plants: the person picks the plant), ONE PUT per attempt (one Idempotency-Key, kept while the same attempt is retried after
 * a network failure), the request as answered handed back to the record (`apply`), a version clash read again (`reload`).
 */
export function useProductionAnswer(view: InquiryView | null, offline: boolean, apply: (value: InquiryView, done: Notice) => void, reload: () => void): { model: ProductionModel | null; actions: ProductionActions } {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => inquiriesCan(session.permissions), [session.permissions])
  const [editor, setEditor] = useState<ProductionEditor | null>(null)
  const key = useRef<string | null>(null)
  const ask = useRef<AbortController | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const today = companyToday()
  // The plants a person may pick when the company has several: the sites of the session's company (the request's company only).
  const plants: PlantChoice[] = useMemo(() => (view && session.company?.id === view.companyId ? session.sites.map((site) => ({ id: site.id, name: site.name })) : []), [view?.companyId, session.company?.id, session.sites])

  // Another request opens: the editor closes, a question to planning in flight is dropped.
  const viewId = view?.id ?? null
  useEffect(() => {
    ask.current?.abort()
    key.current = null
    setEditor(null)
  }, [viewId])
  useEffect(() => () => ask.current?.abort(), [])

  const suggest = useCallback(
    (plantId: string | null) => {
      const now = viewRef.current
      if (!now || !can.promise) return
      ask.current?.abort()
      const controller = new AbortController()
      ask.current = controller
      setEditor((open) => (open ? { ...open, suggestion: { status: 'loading' }, plantId } : open))
      readProductionSuggestion(api, now.id, plantId, controller.signal)
        .then((value) => !controller.signal.aborted && setEditor((open) => (open ? { ...open, suggestion: { status: 'ready', value } } : open)))
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          const kind = isApiError(error) ? error.kind : null
          const paths = isApiError(error) ? error.issues.map(issuePath) : []
          const problem = suggestionProblem(kind, paths, plants.length)
          setEditor((open) => (open ? { ...open, suggestion: { status: 'error', problem }, plants: problem === 'production.suggest.several' ? plants : open.plants } : open))
        })
    },
    [api, can.promise, plants],
  )

  const open = useCallback(() => {
    const now = viewRef.current
    if (!now || !answersHere(now) || productionHeld(now, offline)) return
    key.current = null
    setEditor({ draft: productionDraftOf(now.production ?? null, today), weeks: weekChoices(today), suggestion: can.promise ? { status: 'loading' } : null, plants: null, plantId: null, busy: false, notice: null })
    suggest(null)
  }, [offline, today, can.promise, suggest])

  const send = useCallback(
    async (takeBack: boolean) => {
      const now = viewRef.current
      if (!now || !editor || editor.busy) return
      if (!takeBack) {
        const problems = productionProblems(editor.draft, today)
        if (problems.length > 0) return setEditor({ ...editor, notice: { key: problems[0]!, tone: 'danger' } })
      }
      setEditor({ ...editor, busy: true, notice: null })
      key.current ??= newIdempotencyKey()
      try {
        const value = await setProductionAnswer(api, now.id, takeBack ? takeBackBodyOf(now) : productionBodyOf(now, editor.draft), key.current)
        key.current = null
        ask.current?.abort()
        setEditor(null)
        apply(value, savedNotice(value))
      } catch (error) {
        const problem = productionProblem(refusalCode(error), isApiError(error) ? error.kind : null, now.number)
        if (!problem.retry) key.current = null
        setEditor((current) => (current ? { ...current, busy: false, notice: { ...problem.phrase, tone: 'danger' } } : current))
        if (problem.stale) reload()
      }
    },
    [api, editor, today, apply, reload],
  )

  const actions: ProductionActions = {
    onOpen: open,
    onDraft: (patch) => setEditor((current) => (current ? { ...current, draft: { ...current.draft, ...patch, ...(patch.answer === 'OK' ? { week: '' } : {}) }, notice: null } : current)),
    onSuggest: suggest,
    onUseSuggestion: () =>
      setEditor((current) => {
        if (!current || current.suggestion?.status !== 'ready') return current
        const draft = draftFromSuggestion(current.suggestion.value)
        return draft ? { ...current, draft, notice: null } : current
      }),
    onSave: () => void send(false),
    onTakeBack: () => void send(true),
    onClose: () => {
      ask.current?.abort()
      key.current = null
      setEditor(null)
    },
  }

  if (!view) return { model: null, actions }
  return { model: { current: view.production ?? null, answers: answersHere(view), held: productionHeld(view, offline), editor, today }, actions }
}
