'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import type { LiveChange } from '../../../record-panels/model'
import {
  createPlan,
  lockMachine,
  makeJob,
  movePlan,
  readBodies,
  readMachineChoices,
  readOwners,
  readPlan,
  readResult,
  readTypes,
  recordResult,
  uploadReport,
  type CheckPlan,
  type StepAnswer,
} from './api'
import {
  EMPTY_PLAN,
  moveHeld,
  newResultDraft,
  planBody,
  planHeld,
  problemOf,
  readProblemOf,
  resultBody,
  resultHeld,
  type MoveDraft,
  type PageSection,
  type PlanDraft,
  type PreventiveAddress,
  type PreventiveCan,
  type ResultDraft,
} from './model'
import type { MoveState, PageNotice, PlanNewState, PlanOpenState, PreventivePageActions, PreventivePageModel, ResultNewState, ResultOpenState } from './view-model'

export interface DialogDeps {
  api: ApiClient
  address: PreventiveAddress
  go: (change: Partial<PreventiveAddress>) => void
  siteId: string | null
  today: string
  can: PreventiveCan
  /** The plans list as read (Move N names its rows; the Plan window walks them). */
  plans: readonly CheckPlan[]
  onChanged: (...sections: PageSection[]) => void
  onNotice: (notice: PageNotice | null) => void
}

type DialogState = Pick<PreventivePageModel, 'planNew' | 'resultNew' | 'planOpen' | 'resultOpen' | 'move'>
type DialogActions = Pick<
  PreventivePageActions,
  'onPlanDraft' | 'onPickMachine' | 'onCreatePlan' | 'onResultDraft' | 'onPickResultMachine' | 'onSaveResult' | 'onRetryPlan' | 'onRetryResult' | 'onResultStep' | 'onLockNote' | 'onMakeJob' | 'onLock' | 'onReports' | 'onMoveDraft' | 'onMove' | 'onMoveMany'
>

/** A write's own key, asked once per press (a second press while busy is held by the view). */
const key = () => newIdempotencyKey()

/** What a saved result says on top of its window: saved, with the job made and the machine locked when they were. */
function savedOf(answer: StepAnswer): ResultOpenState['saved'] {
  if (answer.job && answer.lock) return { key: 'done.savedJobLock', params: { number: answer.job.number } }
  if (answer.job) return { key: 'done.savedJob', params: { number: answer.job.number } }
  if (answer.lock) return { key: 'done.savedLock' }
  return { key: 'done.saved' }
}

/**
 * The SCR-266 dialogs (B-W2b-142), each opened by the address so a link or Back opens and closes it: New plan (`?new=1`),
 * Record a check result (`?record=1|<plan>`, `?corrects=<result>`: the result, its job and its lock in ONE call, then the
 * report files), the Plan window (`?plan=`), the result's window (`?result=`: Make a job, Lock as unsafe, reports), Move a
 * check (`?move=<plan>&date=`) and Move N (the lists' bulk action, not in the address). Every write carries its own
 * Idempotency-Key (a plan's move its version read just before); a refusal stays in the dialog in our words (at its field
 * when the API names one); a lost answer is "not known", never "saved".
 */
export function usePreventiveDialogs(deps: DialogDeps): { state: DialogState; actions: DialogActions; onLive: (change: LiveChange) => void } {
  const { api, address, go, siteId, today, can, onChanged, onNotice } = deps
  const [planNew, setPlanNew] = useState<PlanNewState | null>(null)
  const [resultNew, setResultNew] = useState<ResultNewState | null>(null)
  const [planOpen, setPlanOpen] = useState<PlanOpenState | null>(null)
  const [resultOpen, setResultOpen] = useState<ResultOpenState | null>(null)
  const [move, setMove] = useState<MoveState | null>(null)
  /** What the result's window says once it opens after Save result. */
  const justSaved = useRef<{ id: string; saved: ResultOpenState['saved']; problem: ResultOpenState['problem'] } | null>(null)

  // ---- New plan -----------------------------------------------------------------------------------------------------------

  useEffect(() => {
    if (!address.newPlan) {
      setPlanNew(null)
      return
    }
    setPlanNew({ draft: EMPTY_PLAN, machines: { status: 'loading' }, types: null, bodies: null, owners: null, busy: false, problem: null })
    let live = true
    readMachineChoices(api, siteId).then(
      (machines) => live && setPlanNew((current) => current && { ...current, machines: { status: 'ready', value: machines } }),
      (error: unknown) => live && setPlanNew((current) => current && { ...current, machines: { status: 'error', problem: readProblemOf(error) } }),
    )
    return () => {
      live = false
    }
  }, [address.newPlan, api, siteId])

  const pickPlanMachine = (machineId: string) => {
    const open = planNew
    if (!open) return
    const machine = open.machines.status === 'ready' ? (open.machines.value.find((entry) => entry.id === machineId) ?? null) : null
    setPlanNew({ ...open, draft: { ...open.draft, machineId, checkTypeId: '', ownerId: '', outsideBodyPartyId: '', replace: false, replaceReason: '' }, types: machine ? { status: 'loading' } : null, bodies: machine && can.parties ? { status: 'loading' } : null, owners: machine ? { status: 'loading' } : null, problem: null })
    if (!machine) return
    const patch = (change: Partial<PlanNewState>) => setPlanNew((current) => (current && current.draft.machineId === machineId ? { ...current, ...change } : current))
    readTypes(api, machine.class.id).then(
      (types) => patch({ types: { status: 'ready', value: types } }),
      (error: unknown) => patch({ types: { status: 'error', problem: readProblemOf(error) } }),
    )
    if (can.parties) {
      readBodies(api, machine.companyId).then(
        (bodies) => patch({ bodies: { status: 'ready', value: bodies } }),
        (error: unknown) => patch({ bodies: { status: 'error', problem: readProblemOf(error) } }),
      )
    }
    readOwners(api, machine.siteId).then(
      (owners) => setPlanNew((current) => (current && current.draft.machineId === machineId ? { ...current, owners: { status: 'ready', value: owners }, draft: current.draft.ownerId ? current.draft : { ...current.draft, ownerId: owners.find((owner) => owner.me)?.id ?? '' } } : current)),
      (error: unknown) => patch({ owners: { status: 'error', problem: readProblemOf(error) } }),
    )
  }

  const createNow = () => {
    const open = planNew
    if (!open || open.busy || !can.manage || planHeld(open.draft)) return
    setPlanNew({ ...open, busy: true, problem: null })
    createPlan(api, planBody(open.draft), key()).then(
      (answer) => {
        setPlanNew(null)
        go({ newPlan: false, plan: answer.plan.id })
        onNotice({ tone: 'success', key: answer.replacedPlanId ? 'done.planReplaced' : 'done.planMade', params: { machine: answer.plan.machine.assetNumber } })
        onChanged('plans', 'calendar', 'counts')
      },
      (error: unknown) => setPlanNew((current) => current && { ...current, busy: false, problem: problemOf(error) }),
    )
  }

  // ---- Record a check result -------------------------------------------------------------------------------------------------

  const recordPlanId = address.record && address.record !== 'new' ? address.record : null
  useEffect(() => {
    if (!address.record && !address.corrects) {
      setResultNew(null)
      return
    }
    let live = true
    const patch = (change: Partial<ResultNewState> | ((current: ResultNewState) => Partial<ResultNewState>)) =>
      live && setResultNew((current) => current && { ...current, ...(typeof change === 'function' ? change(current) : change) })
    const base: ResultNewState = { draft: newResultDraft(today), plan: null, corrects: null, machines: null, types: null, bodies: null, busy: false, uploading: false, problem: null }
    if (address.corrects) {
      setResultNew({ ...base, corrects: { status: 'loading' } })
      readResult(api, address.corrects).then(
        (record) => {
          const old = record.result
          patch((current) => ({
            corrects: { status: 'ready', value: old },
            draft: { ...current.draft, machineId: old.machine.id, checkTypeId: old.checkType.id, performedOn: old.performedOn, outcome: old.outcome, remarks: old.remarks ?? '', performedBy: old.performedBy, outsideBodyPartyId: old.outsideBody?.id ?? '', nextDueOn: old.nextDueOn ?? '' },
          }))
        },
        (error: unknown) => patch({ corrects: { status: 'error', problem: readProblemOf(error) } }),
      )
    } else if (recordPlanId) {
      setResultNew({ ...base, plan: { status: 'loading' } })
      readPlan(api, recordPlanId).then(
        (record) => patch((current) => ({ plan: { status: 'ready', value: record.plan }, draft: { ...current.draft, performedBy: current.draft.performedBy || (record.plan.outsideBody?.name ?? ''), outsideBodyPartyId: current.draft.outsideBodyPartyId || (record.plan.outsideBody?.id ?? '') } })),
        (error: unknown) => patch({ plan: { status: 'error', problem: readProblemOf(error) } }),
      )
    } else {
      setResultNew({ ...base, machines: { status: 'loading' } })
      readMachineChoices(api, siteId).then(
        (machines) => patch({ machines: { status: 'ready', value: machines } }),
        (error: unknown) => patch({ machines: { status: 'error', problem: readProblemOf(error) } }),
      )
    }
    return () => {
      live = false
    }
    // A new dialog per address (the plan or the result it was opened for).
  }, [address.record, address.corrects, api, siteId])

  const pickResultMachine = (machineId: string) => {
    const open = resultNew
    if (!open) return
    const machine = open.machines?.status === 'ready' ? (open.machines.value.find((entry) => entry.id === machineId) ?? null) : null
    setResultNew({ ...open, draft: { ...open.draft, machineId, checkTypeId: '' }, types: machine ? { status: 'loading' } : null, problem: null })
    if (!machine) return
    readTypes(api, machine.class.id).then(
      (types) => setResultNew((current) => (current && current.draft.machineId === machineId ? { ...current, types: { status: 'ready', value: types } } : current)),
      (error: unknown) => setResultNew((current) => (current && current.draft.machineId === machineId ? { ...current, types: { status: 'error', problem: readProblemOf(error) } } : current)),
    )
  }

  const saveResult = () => {
    const open = resultNew
    if (!open || open.busy || open.uploading) return
    const plan = open.plan?.status === 'ready' ? open.plan.value : null
    const corrects = open.corrects?.status === 'ready' ? open.corrects.value : null
    if ((open.plan && !plan) || (open.corrects && !corrects)) return
    const picked = open.machines?.status === 'ready' ? (open.machines.value.find((entry) => entry.id === open.draft.machineId) ?? null) : null
    const context = { planId: plan?.id ?? null, correctsId: corrects?.id ?? null, machineLocked: plan?.machine.locked ?? picked?.locked ?? false, can }
    if (resultHeld(open.draft, context, today)) return
    setResultNew({ ...open, busy: true, problem: null })
    const files = open.draft.files
    recordResult(api, resultBody(open.draft, context), key()).then(
      async (answer) => {
        onChanged('register', 'plans', 'calendar', 'counts')
        let problem: ResultOpenState['problem'] = null
        if (files.length > 0) {
          setResultNew((current) => current && { ...current, busy: false, uploading: true })
          try {
            for (const file of files) await uploadReport(api, answer.result.id, file, key)
          } catch {
            problem = { key: 'problem.uploadAfter', field: null }
          }
        }
        justSaved.current = { id: answer.result.id, saved: savedOf(answer), problem }
        setResultNew(null)
        go({ record: null, corrects: null, plan: null, result: answer.result.id })
      },
      (error: unknown) => setResultNew((current) => current && { ...current, busy: false, problem: problemOf(error) }),
    )
  }

  // ---- the Plan window ----------------------------------------------------------------------------------------------------

  const planIdRef = useRef<string | null>(null)
  planIdRef.current = address.plan
  const readPlanNow = useCallback(
    (id: string) =>
      readPlan(api, id).then(
        (record) => {
          if (planIdRef.current === id) setPlanOpen((current) => (current?.id === id ? { ...current, read: { status: 'ready', value: record } } : current))
        },
        (error: unknown) => {
          if (planIdRef.current === id) setPlanOpen((current) => (current?.id === id ? { ...current, read: { status: 'error', problem: readProblemOf(error) } } : current))
        },
      ),
    [api],
  )
  useEffect(() => {
    if (!address.plan) {
      setPlanOpen(null)
      return
    }
    setPlanOpen({ id: address.plan, read: { status: 'loading' } })
    void readPlanNow(address.plan)
  }, [address.plan, readPlanNow])

  // ---- the result's window ------------------------------------------------------------------------------------------------

  const resultIdRef = useRef<string | null>(null)
  resultIdRef.current = address.result
  const readResultNow = useCallback(
    (id: string) =>
      readResult(api, id).then(
        (record) => {
          if (resultIdRef.current === id) setResultOpen((current) => (current?.id === id ? { ...current, read: { status: 'ready', value: record } } : current))
        },
        (error: unknown) => {
          if (resultIdRef.current === id) setResultOpen((current) => (current?.id === id ? { ...current, read: { status: 'error', problem: readProblemOf(error) } } : current))
        },
      ),
    [api],
  )
  useEffect(() => {
    if (!address.result) {
      setResultOpen(null)
      return
    }
    const fresh = justSaved.current?.id === address.result ? justSaved.current : null
    justSaved.current = null
    setResultOpen({ id: address.result, read: { status: 'loading' }, step: 'view', lockNote: '', busy: false, uploading: false, problem: fresh?.problem ?? null, saved: fresh?.saved ?? null })
    void readResultNow(address.result)
  }, [address.result, readResultNow])

  const patchResult = (change: Partial<ResultOpenState>) => setResultOpen((current) => current && { ...current, ...change })

  /** A write on the open result: busy, then read it again and say what was done. */
  const resultWrite = (work: (id: string) => Promise<unknown>, saved: (value: unknown) => ResultOpenState['saved'], sections: PageSection[]) => {
    const open = resultOpen
    if (!open || open.busy || open.read.status !== 'ready') return
    patchResult({ busy: true, problem: null, saved: null })
    work(open.id).then(
      async (value) => {
        await readResultNow(open.id)
        patchResult({ busy: false, step: 'view', lockNote: '', saved: saved(value) })
        onChanged(...sections)
      },
      (error: unknown) => patchResult({ busy: false, problem: problemOf(error) }),
    )
  }

  // ---- Move a check, Move N ------------------------------------------------------------------------------------------------

  const openMove = useCallback(
    (ids: readonly string[], bulk: boolean, date: string | null) => {
      setMove({ plans: { status: 'loading' }, draft: { nextDueOn: date ?? '', reason: '' }, busy: false, problem: null, bulk })
      Promise.all(ids.map((id) => readPlan(api, id).then((record) => record.plan))).then(
        (plans) => setMove((current) => current && { ...current, plans: { status: 'ready', value: plans }, draft: current.draft.nextDueOn || plans.length !== 1 ? current.draft : { ...current.draft, nextDueOn: plans[0]!.nextDueOn } }),
        (error: unknown) => setMove((current) => current && { ...current, plans: { status: 'error', problem: readProblemOf(error) } }),
      )
    },
    [api],
  )
  useEffect(() => {
    if (address.move) openMove([address.move], false, address.date)
    else setMove((current) => (current && !current.bulk ? null : current))
  }, [address.move, address.date, openMove])

  const moveNow = async () => {
    const open = move
    if (!open || open.busy || open.plans.status !== 'ready' || !can.manage) return
    const plans = open.plans.value
    if (moveHeld(open.draft, plans)) return
    const draft = open.draft
    setMove({ ...open, busy: true, problem: null })
    if (!open.bulk) {
      const plan = plans[0]!
      try {
        const moved = await movePlan(api, plan.id, { version: plan.version, nextDueOn: draft.nextDueOn, reason: draft.reason.trim() }, key())
        setMove(null)
        go({ move: null, date: null })
        onNotice({ tone: 'success', key: 'done.moved', params: { machine: moved.machine.assetNumber, date: moved.nextDueOn } })
        onChanged('plans', 'calendar', 'counts')
      } catch (error) {
        setMove((current) => current && { ...current, busy: false, problem: problemOf(error) })
      }
      return
    }
    let done = 0
    const refused: { label: string; key: string }[] = []
    for (const plan of plans) {
      try {
        await movePlan(api, plan.id, { version: plan.version, nextDueOn: draft.nextDueOn, reason: draft.reason.trim() }, key())
        done += 1
      } catch (error) {
        refused.push({ label: `${plan.machine.assetNumber} · ${plan.checkType.code}`, key: problemOf(error).key })
      }
    }
    setMove(null)
    onNotice({ tone: refused.length > 0 ? 'warning' : 'success', key: 'bulk.moveResult', params: { count: done }, refused })
    onChanged('plans', 'calendar', 'counts')
  }

  // ---- live ----------------------------------------------------------------------------------------------------------------

  const onLive = (change: LiveChange) => {
    const fields = change.fields as Record<string, unknown>
    if (planOpen && (change.type === 'machine_check_plan.changed' || change.type === 'machine_check.recorded' || change.type === 'machine_check.due') && fields.planId === planOpen.id) void readPlanNow(planOpen.id)
    if (resultOpen && !resultOpen.busy && (change.type.startsWith('maintenance_job.') || change.type === 'machine_check.recorded' || change.type === 'maintenance_request.locked' || change.type === 'maintenance_request.signed_safe')) void readResultNow(resultOpen.id)
  }

  // ---- the actions ---------------------------------------------------------------------------------------------------------

  const actions: DialogActions = {
    onPlanDraft: (draft: PlanDraft) => setPlanNew((current) => current && { ...current, draft, problem: current.problem?.key === 'refusal.PLAN_EXISTS' ? current.problem : null }),
    onPickMachine: pickPlanMachine,
    onCreatePlan: createNow,

    onResultDraft: (draft: ResultDraft) => setResultNew((current) => current && { ...current, draft, problem: null }),
    onPickResultMachine: pickResultMachine,
    onSaveResult: saveResult,

    onRetryPlan: () => {
      if (!planOpen) return
      setPlanOpen({ ...planOpen, read: { status: 'loading' } })
      void readPlanNow(planOpen.id)
    },
    onRetryResult: () => {
      if (!resultOpen) return
      patchResult({ read: { status: 'loading' } })
      void readResultNow(resultOpen.id)
    },
    onResultStep: (step) => patchResult({ step, problem: null, saved: null }),
    onLockNote: (lockNote) => patchResult({ lockNote }),
    onMakeJob: () =>
      resultWrite(
        (id) => makeJob(api, id, key()),
        (answer) => ({ key: 'done.job', params: { number: (answer as StepAnswer).job?.number ?? '—' } }),
        ['register'],
      ),
    onLock: () => {
      const note = resultOpen?.lockNote ?? ''
      resultWrite((id) => lockMachine(api, id, note, key()), () => ({ key: 'done.locked' }), ['register', 'plans', 'calendar'])
    },
    onReports: (files: File[]) => {
      const open = resultOpen
      if (!open || open.uploading || files.length === 0) return
      patchResult({ uploading: true, problem: null, saved: null })
      ;(async () => {
        for (const file of files) await uploadReport(api, open.id, file, key)
      })().then(
        async () => {
          await readResultNow(open.id)
          patchResult({ uploading: false, saved: { key: 'done.reports', params: { count: files.length } } })
          onChanged('register', 'counts')
        },
        (error: unknown) => patchResult({ uploading: false, problem: problemOf(error) }),
      )
    },

    onMoveDraft: (draft: MoveDraft) => setMove((current) => current && { ...current, draft, problem: null }),
    onMove: () => void moveNow(),
    onMoveMany: (ids) => {
      if (!ids || ids.length === 0) return setMove(null)
      openMove(ids, true, null)
    },
  }

  return { state: { planNew, resultNew, planOpen, resultOpen, move }, actions, onLive }
}
