'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLive } from '../../../_shared/buying/hooks'
import { liveMatches } from '../../../quality/_shared/hooks'
import { problemOf } from '../../_shared/model'
import { getEmployeeSkills, getMatrix, listSkills, setLevel, type Authorisation, type EmployeeLevel, type Matrix, type Skill, type SkillLevel } from '../api'
import { className, skillName, skillsCan, skillsProblem, type DialogPerson } from '../model'
import { useLocale } from '../../../../lib/i18n/provider'
import { useSkillDialogs } from '../use-skill-dialogs'
import { EmployeeSkillsView, type EmployeeSkillsActions, type EmployeeSkillsModel } from './view/EmployeeSkillsView'
import { EmployeeTraining } from './training/EmployeeTraining'

const LIVE = ['employee_skill.changed', 'machine_authorisation.changed']

/**
 * People › Employees › the record's Skills & training tab (design people.employees rec:Employee/skills, GET
 * /people/employees/:id/skills, people.skills.view): what this person can do and may operate, who decided and when. The
 * dialogs are the matrix's own. W2b-2 (B-W2b-146): Safety training and hands-on instruction below (`training/`).
 */
export function EmployeeSkills({ employeeId }: { employeeId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const can = useMemo(() => skillsCan(session.permissions), [session.permissions])
  const [loaded, setLoaded] = useState<EmployeeSkillsModel['loaded']>({ status: 'loading' })
  const [context, setContext] = useState<{ matrix: Matrix | null; skills: Skill[] }>({ matrix: null, skills: [] })
  const [notice, setNotice] = useState<EmployeeSkillsModel['notice']>(null)
  const value = loaded.status === 'ready' ? loaded.value : null

  const read = useCallback(async () => {
    if (!can.view) return
    try {
      setLoaded({ status: 'ready', value: await getEmployeeSkills(api, employeeId) })
    } catch (error) {
      setLoaded({ status: 'error', problem: problemOf(error).key })
    }
  }, [api, employeeId, can.view])
  useEffect(() => void read(), [read])
  const [catalogue, setCatalogue] = useState<Skill[]>([])
  useEffect(() => {
    if (can.view) void listSkills(api, { status: 'ALL' }).then((answer) => setCatalogue(answer.skills)).catch(() => undefined)
  }, [api, can.view])
  const names = useMemo(() => Object.fromEntries(catalogue.map((skill) => [skill.id, skillName(skill, locale)])), [catalogue, locale])
  useLive((change) => liveMatches(change, LIVE) && change.fields.employeeId === employeeId && void read(), () => void read(), can.view)

  const dialogs = useSkillDialogs(api, { today: value?.today ?? '', companyId: value?.employee.companyId ?? null }, (done, params) => {
    setNotice({ tone: 'success', ns: 'skills', key: done, ...(params ? { params } : {}) })
    void read()
  })

  // What the dialogs choose from (the classes, the skills, the trainers of the person's site), read when one first opens.
  const siteId = value?.employee.siteId ?? null
  const withContext = useCallback(async () => {
    if (context.matrix || !siteId) return
    const [matrix, list] = await Promise.all([getMatrix(api, { siteId }), listSkills(api, { status: 'ACTIVE', companyId: value?.employee.companyId ?? null })])
    setContext({ matrix, skills: list.skills })
  }, [api, context.matrix, siteId, value?.employee.companyId])

  const person: DialogPerson | null = value ? { employeeId, name: value.employee.name, companyId: value.employee.companyId, siteId: value.employee.siteId } : null
  const levelLabel = (row: EmployeeLevel) => names[row.skill.id] ?? row.skill.name
  const after = (open: () => void) =>
    void withContext()
      .then(open)
      .catch((error: unknown) => {
        const problem = skillsProblem(error)
        setNotice({ tone: 'danger', ns: problem.ns, key: problem.words.key })
      })

  const actions: EmployeeSkillsActions = {
    onRetry: () => void read(),
    onDismissNotice: () => setNotice(null),
    onAddLevel: () => person && after(() => dialogs.open.level(person, { skillId: null, skillLabel: null, level: null, until: null, version: null, hasTrainee: false })),
    onAuthorise: () => person && after(() => dialogs.open.authorise([person], true)),
    onSetLevel: (row: EmployeeLevel, level: SkillLevel) => {
      setNotice(null)
      setLevel(api, { employeeId, skillId: row.skill.id, level, version: row.version })
        .then(() => {
          setNotice({ tone: 'success', ns: 'skills', key: 'done.level' })
          return read()
        })
        .catch((error: unknown) => {
          const problem = skillsProblem(error)
          setNotice({ tone: 'danger', ns: problem.ns, key: problem.words.key })
        })
    },
    onTrainee: (row: EmployeeLevel) => person && after(() => dialogs.open.level(person, { skillId: row.skill.id, skillLabel: levelLabel(row), level: row.level, until: row.traineeUntil, version: row.version, hasTrainee: Boolean(row.traineeUntil) })),
    onSignOff: (row: EmployeeLevel) => person && after(() => dialogs.open.signOff(person, { skillId: row.skill.id, skillLabel: levelLabel(row), levelId: row.id, version: row.version, since: row.since })),
    onRemove: (row: EmployeeLevel) => person && dialogs.open.removeLevel(person, { skillLabel: levelLabel(row), levelId: row.id, version: row.version }),
    onValidUntil: (row: Authorisation) => person && dialogs.open.validUntil(person, { classLabel: className(row.machineClass, locale), id: row.id, version: row.version, from: row.authorisedOn, until: row.validUntil }),
    onRevoke: (row: Authorisation) => person && dialogs.open.revoke(person, { classLabel: className(row.machineClass, locale), id: row.id, version: row.version }),
    dialog: dialogs.actions,
  }

  const held = new Set((value?.levels ?? []).map((row) => row.skill.id))
  return (
    <>
    <EmployeeSkillsView
      model={{
        can,
        loaded,
        notice,
        names,
        dialogs: { dialog: dialogs.dialog, rows: context.matrix?.rows ?? [], classes: context.matrix?.machineClasses ?? [], skills: context.skills.filter((skill) => !held.has(skill.id)).map((skill) => ({ ...skill, name: skillName(skill, locale) })), sites: context.matrix?.sites ?? [], today: value?.today ?? '', signer: session.user.displayName, stepUp: dialogs.stepUp },
      }}
      actions={actions}
    />
    {/* B-W2b-146: Safety training and hands-on instruction (safety.view), below the skills. */}
    <EmployeeTraining employeeId={employeeId} />
    </>
  )
}

