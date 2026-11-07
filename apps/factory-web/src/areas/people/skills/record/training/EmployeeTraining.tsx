'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { companyPrefix } from '../../../../../lib/session/session'
import { useLive } from '../../../../_shared/buying/hooks'
import { liveMatches } from '../../../../quality/_shared/hooks'
import { getPersonTraining } from '../../training/api'
import { readProblemOf, trainingCan, type TrainingAddress } from '../../training/model'
import { useTraining } from '../../training/use-training'
import { EmployeeTrainingView, type EmployeeTrainingModel } from './view/EmployeeTrainingView'

const LIVE = ['training.recorded', 'instruction.changed', 'training_requirement.changed', 'role_sheet.changed', 'safety_course.changed']
/** The tab opens no lens and no address-driven pop-up: only Record training and Add entry. */
const NO_LENS: TrainingAddress = { lens: 'matrix', status: 'ACTIVE', course: null, need: null, entries: 'all', q: '' }

/**
 * The W2b-2 sections of Employee › Skills & training (B-W2b-146): GET /safety/training/people/:id (safety.view) — the person's
 * records, DueCells with the Needed rows, their instruction entries; Record training and Add entry are the Skills page's own
 * pop-ups for this person (`use-training.ts`). Live: a record or an entry about this person reads the tab again.
 */
export function EmployeeTraining({ employeeId }: { employeeId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => trainingCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const [loaded, setLoaded] = useState<EmployeeTrainingModel['loaded']>({ status: 'loading' })
  const [notice, setNotice] = useState<EmployeeTrainingModel['notice']>(null)
  const value = loaded.status === 'ready' ? loaded.value : null

  const read = useCallback(async () => {
    if (!can.view) return
    try {
      setLoaded({ status: 'ready', value: await getPersonTraining(api, employeeId) })
    } catch (error) {
      setLoaded({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, can.view, employeeId])

  useEffect(() => void read(), [read])
  useLive(
    (change) => {
      const fields = change.fields as Record<string, unknown>
      if (liveMatches(change, LIVE) && (fields.employeeId === employeeId || (Array.isArray(fields.employeeIds) && fields.employeeIds.includes(employeeId)) || change.type !== 'training.recorded')) void read()
    },
    () => void read(),
    can.view,
  )

  const person = value ? { employeeId, name: value.employee.name, companyId: value.employee.companyId, siteId: value.employee.siteId } : null
  const training = useTraining(api, can, NO_LENS, { companyId: value?.employee.companyId ?? session.company?.id ?? null, siteId: value?.employee.siteId ?? null, today: value?.today ?? '', people: person ? [person] : [] }, () => undefined, (key, params) => {
    setNotice({ tone: key.startsWith('refusal.') || key.startsWith('problem.') ? 'danger' : key === 'done.recordedNoCertificate' ? 'warning' : 'success', key, ...(params ? { params } : {}) })
    void read()
  })

  return (
    <EmployeeTrainingView
      model={{
        allowed: can.view,
        loaded,
        prefix,
        notice,
        dialogs: { dialog: training.dialog, can, courses: training.activeCourses, people: person ? [person] : [], machineClasses: training.requirements.status === 'ready' ? training.requirements.value.machineClasses : [], today: value?.today ?? '', canAddGroupWide: false, riskHref: null, prefix },
      }}
      actions={{
        onRetry: () => void read(),
        onDismissNotice: () => setNotice(null),
        onRecord: (courseId) => person && training.open.record([person], courseId),
        onInstruction: () => person && training.open.instruction(person.employeeId),
        dialog: training.actions,
      }}
    />
  )
}
