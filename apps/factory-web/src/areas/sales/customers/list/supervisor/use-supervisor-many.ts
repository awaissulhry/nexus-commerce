'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { readPickList, setCustomerSupervisor } from '../../../../_shared/production-supervisor/api'
import { getProductionLimits } from '../../../../admin/users/partners/api'
import { pickProblemOf, supervisorProblemOf } from '../../portal/limits/model'
import { SUPERVISOR_READS_AT_ONCE, supervisorBodyOf, supervisorPlanOf, supervisorRestOf, type SupervisorManyActions, type SupervisorManyModel, type SupervisorOutcome, type SupervisorTarget, type SupervisorWhy } from './model'

/** A ticked customer the window opens on: its id and its name (the receipt names it). */
export interface SupervisorPick {
  readonly id: string
  readonly name: string
}

/** A customer's settings could not be read: out of the reader's reach, or not answered. */
function readWhyOf(error: unknown): SupervisorWhy {
  return isApiError(error) && (error.kind === 'not_found' || error.kind === 'forbidden') ? { ns: 'customers-list', key: 'supervisor.notReached' } : { ns: 'customers-list', key: 'supervisor.readFailed' }
}

/**
 * F-CL-104 (13-backend §8.5): the container of "Set production supervisor for N…" on the EXISTING calls — each customer's portal
 * settings read 5 at a time (its version, supervisor and backup), the first customer's pick list, then ONE pick written to each
 * customer one at a time with the version read (PUT /production/brands/:id/supervisor); closing the window or Stop ends it before the
 * next one. "Run the rest again" reads those customers again (fresh versions) and keeps the pick. The live event
 * `brand_production.supervisor_changed` re-reads any open card by itself.
 */
export function useSupervisorMany(api: ApiClient): { readonly model: SupervisorManyModel | null; readonly actions: SupervisorManyActions; readonly open: (customers: readonly SupervisorPick[], picked?: string | null) => void } {
  const [model, setModel] = useState<SupervisorManyModel | null>(null)
  const stop = useRef(false)
  const run = useRef(0)
  const latest = useRef(model)
  latest.current = model

  const open = useCallback(
    (rows: readonly SupervisorPick[], picked: string | null = null) => {
      if (rows.length === 0) return
      const token = ++run.current
      stop.current = false
      const targets: SupervisorTarget[] = rows.map((row) => ({ id: row.id, name: row.name, state: 'reading' }))
      setModel({ step: 'read', targets, people: { status: 'loading' }, picked, outcomes: {}, done: 0, stopping: false })
      const put = (target: SupervisorTarget) => run.current === token && setModel((now) => (now ? { ...now, targets: now.targets.map((entry) => (entry.id === target.id ? target : entry)) } : now))
      readPickList(api, { partyId: rows[0]!.id }).then(
        (list) => run.current === token && setModel((now) => (now ? { ...now, people: { status: 'ready', people: list.people, complete: list.complete } } : now)),
        (error: unknown) => {
          const pick = pickProblemOf(error)
          const why: SupervisorWhy = pick.status === 'held' ? { ns: pick.ns, key: pick.key } : { ns: 'portal-access', key: pick.status === 'error' ? pick.key : 'limits.supervisor.readFailed' }
          if (run.current === token) setModel((now) => (now ? { ...now, people: { status: 'error', why } } : now))
        },
      )
      let next = 0
      const worker = async () => {
        while (next < rows.length && run.current === token) {
          const row = rows[next++]!
          try {
            const read = await getProductionLimits(api, row.id)
            put({ id: row.id, name: row.name, state: 'read', version: read.production.version, supervisor: read.production.supervisor, backup: read.production.backup })
          } catch (error) {
            put({ id: row.id, name: row.name, state: 'unread', why: readWhyOf(error) })
          }
        }
      }
      void Promise.all(Array.from({ length: Math.min(SUPERVISOR_READS_AT_ONCE, rows.length) }, worker)).then(() => run.current === token && setModel((now) => (now ? { ...now, step: 'pick' } : now)))
    },
    [api],
  )

  const go = useCallback(async () => {
    const now = latest.current
    if (!now || now.step !== 'pick' || !now.picked) return
    const token = run.current
    const picked = now.picked
    const plan = supervisorPlanOf(now.targets, picked)
    if (plan.runs.length === 0) return
    stop.current = false
    setModel({ ...now, step: 'running', outcomes: {}, done: 0, stopping: false })
    const outcomes: Record<string, SupervisorOutcome> = {}
    let done = 0
    for (const target of plan.runs) {
      if (stop.current || run.current !== token) {
        outcomes[target.id] = { kind: 'notRun' }
        continue
      }
      try {
        await setCustomerSupervisor(api, target.id, supervisorBodyOf(target, picked), newIdempotencyKey())
        outcomes[target.id] = { kind: 'done' }
      } catch (error) {
        const why = supervisorProblemOf(error)
        outcomes[target.id] = { kind: 'failed', why: { ns: why.ns, key: why.key } }
      }
      done += 1
      const snapshot = { ...outcomes }
      if (run.current === token) setModel((current) => (current ? { ...current, outcomes: snapshot, done } : current))
    }
    if (run.current === token) setModel((current) => (current ? { ...current, step: 'done', outcomes: { ...outcomes }, stopping: false } : current))
  }, [api])

  const actions = useMemo<SupervisorManyActions>(
    () => ({
      onPick: (personId) => setModel((now) => (now && now.step === 'pick' ? { ...now, picked: personId } : now)),
      onGo: () => void go(),
      onStop: () => {
        stop.current = true
        setModel((now) => (now ? { ...now, stopping: true } : now))
      },
      onRunRest: () => {
        const now = latest.current
        if (!now || now.step !== 'done') return
        const rest = supervisorRestOf(supervisorPlanOf(now.targets, now.picked), now.outcomes)
        const again = now.targets.filter((target) => rest.includes(target.id)).map((target) => ({ id: target.id, name: target.name }))
        // Read again (fresh versions); the pick stays.
        if (again.length > 0) open(again, now.picked)
      },
      onClose: () => {
        // Closing stops the run before the next customer (the one being written finishes).
        stop.current = true
        run.current += 1
        setModel(null)
      },
    }),
    [go, open],
  )

  return { model, actions, open }
}
