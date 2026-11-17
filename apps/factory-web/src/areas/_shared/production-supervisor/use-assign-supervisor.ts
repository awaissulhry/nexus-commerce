'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { assignOrderSupervisors, readPickList } from './api'
import { assignProblemOf, commonPeople, resultOf, scopesOf, type AssignSupervisorActions, type AssignSupervisorModel, type SupervisorTarget } from './model'

/**
 * F-PR-21 — the one assign dialog's container part: `open(targets)` reads the pick list of each customer and company of the targets
 * (once each, all at once) and crosses them; `onAssign` sends ONE `POST /production/orders/supervisor` (one Idempotency-Key per dialog:
 * a second press after a lost answer is the same command) and keeps the answer as one line per order; `onDone` lets the page read its
 * rows or record again. Nothing is sent while a Send runs.
 */
export function useAssignSupervisor(api: ApiClient, onDone?: () => void) {
  const [model, setModel] = useState<AssignSupervisorModel | null>(null)
  const turn = useRef(0)
  const key = useRef<string | null>(null)
  const latest = useRef(model)
  latest.current = model
  const done = useRef(onDone)
  done.current = onDone

  const readPeople = useCallback(
    (targets: readonly SupervisorTarget[]) => {
      const mine = ++turn.current
      setModel((current) => (current ? { ...current, people: { status: 'loading' } } : current))
      Promise.all(scopesOf(targets).map((scope) => readPickList(api, scope)))
        .then((lists) => {
          if (mine !== turn.current) return
          const crossed = commonPeople(lists)
          setModel((current) => (current ? { ...current, people: { status: 'ready', people: crossed.people, complete: crossed.complete } } : current))
        })
        .catch((error: unknown) => {
          if (mine !== turn.current) return
          const problem = isApiError(error) && error.kind === 'not_found' ? 'problem.notFound' : isApiError(error) && error.kind === 'forbidden' ? 'problem.forbidden' : 'problem.people'
          setModel((current) => (current ? { ...current, people: { status: 'error', problem } } : current))
        })
    },
    [api],
  )

  /** Opens the dialog over these orders (at most ASSIGN_MAX: the caller holds a bigger selection with its words). */
  const open = useCallback(
    (targets: readonly SupervisorTarget[], extra: { readonly leftOut?: number; readonly current?: AssignSupervisorModel['current'] } = {}) => {
      key.current = newIdempotencyKey()
      setModel({ targets, leftOut: extra.leftOut ?? 0, current: extra.current ?? null, people: { status: 'loading' }, busy: false, problem: null, result: null })
      readPeople(targets)
    },
    [readPeople],
  )

  const actions = useMemo<AssignSupervisorActions>(
    () => ({
      onAssign: (supervisorId) => {
        const current = latest.current
        if (!current || current.busy || current.result) return
        setModel({ ...current, busy: true, problem: null })
        assignOrderSupervisors(api, { orderIds: current.targets.map((target) => target.orderId), supervisorId }, key.current ?? newIdempotencyKey())
          .then((answer) => {
            setModel((now) => (now ? { ...now, busy: false, result: resultOf(answer, now.targets) } : now))
            done.current?.()
          })
          .catch((error: unknown) => setModel((now) => (now ? { ...now, busy: false, problem: assignProblemOf(error) } : now)))
      },
      onRetry: () => {
        const current = latest.current
        if (current) readPeople(current.targets)
      },
      onClose: () => {
        turn.current++
        setModel(null)
      },
    }),
    [api, readPeople],
  )

  return { model, actions, open }
}
