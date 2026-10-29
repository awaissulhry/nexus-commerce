'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { editWorker, issueBadge, listCompanies, listRoles, listWorkers, resetPin, revokeBadge, setWorkerRoles, setWorkerStatus, type Role, type Worker } from '../../shared/api'
import { problemKey, problemNotice, type Notice } from '../../shared/model'
import type { RevealModel } from '../../shared/view/OneTimeReveal'
import { useRecordTab, useThreadDock } from '../../shared/record-hooks'
import { isStepUpCancelled, useStepUp } from '../../shared/step-up'
import { WORKER_TABS, type WorkerDialog, type WorkerProfileDraft } from './model'
import { WorkerRecordView } from './view/WorkerRecordView'

/**
 * `/w/<company>/admin/users/floor/<id>` (SCR-011 floor): the worker comes from `GET /auth/floor/workers` (no read of one
 * worker exists), the floor roles from `GET /auth/roles`. A badge and a PIN reset take an Idempotency-Key and a fresh
 * code; their secret is shown once (a repeat answers null: ask again). A role change too asks for a fresh code.
 */
export function WorkerRecord({ workerId }: { workerId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = useRecordTab(WORKER_TABS)
  const { dockOpen, toggleDock } = useThreadDock('Worker')
  const [worker, setWorker] = useState<Worker | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [siteName, setSiteName] = useState<string | null>(null)
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [floorRoles, setFloorRoles] = useState<Role[] | null>(null)
  const [dialog, setDialog] = useState<WorkerDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [reveal, setReveal] = useState<RevealModel | null>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const keys = useRef<{ badge: string | null; pin: string | null }>({ badge: null, pin: null })

  const load = useCallback(async () => {
    try {
      const found = (await listWorkers(api)).find((item) => item.id === workerId) ?? null
      setWorker(found)
      setProblem(found ? null : 'problem.notFound')
      if (found && held.has('companies.view')) {
        const companies = await listCompanies(api).catch(() => [])
        const site = companies.flatMap((company) => company.sites).find((item) => item.id === found.siteId)
        setSiteName(site?.name ?? null)
        setCompanyId(site?.companyId ?? null)
      }
    } catch (error) {
      setProblem(problemKey(error))
    }
    if (held.has('roles.view')) listRoles(api).then((roles) => setFloorRoles(roles.filter((role) => role.audience === 'floor')), () => setFloorRoles(null))
  }, [api, held, workerId])
  useEffect(() => {
    void load()
  }, [load])

  const change = async (sentence: string, work: () => Promise<Worker | void>, done: string | null): Promise<boolean> => {
    setBusy(true)
    setDialogProblem(null)
    try {
      const next = await guard(sentence, work)
      if (next) setWorker(next)
      setDialog(null)
      if (done) setNotice({ key: done, tone: 'success' })
      void load()
      return true
    } catch (error) {
      if (!isStepUpCancelled(error)) {
        setDialogProblem(problemNotice(error).key)
        if (isApiError(error) && error.kind === 'conflict') void load()
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <WorkerRecordView
      model={{
        prefix,
        tab,
        worker,
        problem: worker ? null : problem,
        siteName,
        floorRoles,
        me: session.user.id,
        can: { manage: held.has('workers.manage'), credentials: held.has('workers.credentials'), roles: held.has('workers.roles') },
        dialog,
        busy,
        dialogProblem,
        notice,
        reveal,
        stepUp,
        dockOpen,
      }}
      panels={worker ? <RecordPanels record={{ type: 'Worker', id: worker.id, companyId, siteId: worker.siteId }} title={worker.displayName} /> : null}
      actions={{
        onDialog: (next) => {
          setDialog(next)
          setDialogProblem(null)
        },
        onSaveProfile: (draft: WorkerProfileDraft) =>
          worker
            ? change('stepUp.sentence.default', () => editWorker(api, worker.id, { version: worker.version, displayName: draft.displayName.trim(), locale: draft.locale, employeeCode: draft.employeeCode.trim() || null }), 'worker.done.saved')
            : Promise.resolve(false),
        onIssueBadge: () => {
          if (!worker) return Promise.resolve(false)
          keys.current.badge ??= newIdempotencyKey()
          return change(
            'stepUp.sentence.badge',
            async () => {
              const answer = await issueBadge(api, worker.id, keys.current.badge!)
              keys.current.badge = null
              setReveal({ kind: 'badge', value: answer.code, printed: answer.printed, owner: worker.displayName })
            },
            null,
          )
        },
        onMarkLost: (status) => (worker?.badge ? change('stepUp.sentence.badge', async () => void (await revokeBadge(api, worker.badge!.id, status)), 'worker.done.lost') : Promise.resolve(false)),
        onResetPin: () => {
          if (!worker) return Promise.resolve(false)
          keys.current.pin ??= newIdempotencyKey()
          return change(
            'stepUp.sentence.pin',
            async () => {
              const answer = await resetPin(api, worker.id, keys.current.pin!)
              keys.current.pin = null
              setReveal({ kind: 'pin', value: answer.pin, owner: worker.displayName })
            },
            null,
          )
        },
        onSaveRoles: (roleIds) => (worker ? change('stepUp.sentence.workerRoles', () => setWorkerRoles(api, worker.id, roleIds), 'worker.done.roles') : Promise.resolve(false)),
        onStatus: (action, reason) => (worker ? change('stepUp.sentence.default', () => setWorkerStatus(api, worker.id, action, { version: worker.version, ...(reason ? { reason } : {}) }), `worker.done.${action}`) : Promise.resolve(false)),
        onRevealClose: () => {
          setReveal(null)
          setNotice({ key: 'worker.done.revealed', tone: 'success' })
        },
        onStepUp: (code) => void submitStepUp(code),
        onStepUpClose: cancelStepUp,
        onDock: toggleDock,
        onRetry: () => {
          setProblem(null)
          setWorker(null)
          void load()
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
