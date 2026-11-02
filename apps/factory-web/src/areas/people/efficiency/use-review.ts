'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { decide, getOperation, type OperationDetail } from './api'
import { decisionBody, efficiencyProblem, EMPTY_DECISION, type DecisionChoice, type DecisionDraft, type EfficiencyProblem } from './model'

export type DetailRead = { status: 'loading' } | { status: 'ready'; value: OperationDetail } | { status: 'error'; problem: EfficiencyProblem }

export interface ReviewDetailState {
  read: DetailRead
  draft: DecisionDraft
  busy: boolean
  problem: EfficiencyProblem | null
  /** The decision just recorded: "Change" then sends the person to Products. */
  done: { decision: DecisionChoice; styleId: string } | null
}

export interface ReviewDetailActions {
  onRetry: () => void
  onDraft: (change: Partial<DecisionDraft>) => void
  onDecide: () => void
}

/**
 * The standard review's DetailModal (`?open=<routing operation>`): the operation's figures and history, and one decision.
 * The decision goes with the last decision read (`basedOn`): when someone decided first the API answers 409 REVIEW_MOVED,
 * the draft stays and the record is read again, so nobody overrules a decision they never saw. The default window is the
 * review's own (the API's), not the page's period.
 */
export function useReviewDetail(api: ApiClient, siteId: string | null, open: string | null, onDecided: () => void) {
  const [read, setRead] = useState<DetailRead>({ status: 'loading' })
  const [draft, setDraft] = useState<DecisionDraft>(EMPTY_DECISION)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<EfficiencyProblem | null>(null)
  const [done, setDone] = useState<ReviewDetailState['done']>(null)
  const turn = useRef(0)

  const load = useCallback(async () => {
    if (!open || !siteId) return
    const mine = ++turn.current
    try {
      const value = await getOperation(api, open, { siteId })
      if (mine === turn.current) setRead({ status: 'ready', value })
    } catch (error) {
      if (mine === turn.current) setRead({ status: 'error', problem: efficiencyProblem(error) })
    }
  }, [api, open, siteId])

  useEffect(() => {
    setRead({ status: 'loading' })
    setDraft(EMPTY_DECISION)
    setProblem(null)
    setDone(null)
    void load()
  }, [load])

  const send = useCallback(async () => {
    if (read.status !== 'ready' || !siteId || !open || !draft.decision) return
    setBusy(true)
    setProblem(null)
    try {
      const answer = await decide(api, open, decisionBody(siteId, draft, read.value.review.lastDecision?.id ?? null))
      setDone({ decision: draft.decision, styleId: answer.style.id })
      setDraft(EMPTY_DECISION)
      onDecided()
      await load()
    } catch (error) {
      setProblem(efficiencyProblem(error))
      await load()
    } finally {
      setBusy(false)
    }
  }, [api, draft, load, onDecided, open, read, siteId])

  const actions = useMemo<ReviewDetailActions>(
    () => ({
      onRetry: () => {
        setRead({ status: 'loading' })
        void load()
      },
      onDraft: (change) => {
        setDone(null)
        setDraft((current) => ({ ...current, ...change }))
      },
      onDecide: () => void send(),
    }),
    [load, send],
  )

  return { state: { read, draft, busy, problem, done } satisfies ReviewDetailState, actions }
}
