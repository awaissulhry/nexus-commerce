'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useCoalesced, useLive } from '../../_shared/buying/hooks'
import { liveMatches } from '../../quality/_shared/hooks'
import { whatYouSee } from '../_shared/api'
import { readProblem } from '../_shared/model'
import type { SightState } from '../_shared/parts'
import { getCell, getMatrix, setLevel, type MatrixRow, type SkillLevel } from './api'
import { cellKey, className, dialogPerson, levelChange, levelOf, skillsAddressOf, skillsAddressText, skillsCan, skillsProblem, type CellRef, type SkillsAddress } from './model'
import { useSkillDialogs } from './use-skill-dialogs'
import type { CellState } from './view/CellPopover'
import { SkillsView, type MatrixState, type SkillNotice, type SkillsActions } from './view/SkillsView'
import { dueListPeople } from './training/api'
import { lensesFor, trainingAddressOf, trainingAddressText, trainingCan, type TrainingAddress } from './training/model'
import { useTraining, type PersonOption } from './training/use-training'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'

const LIVE = ['employee_skill.changed', 'machine_authorisation.changed', 'skill.changed', 'training.recorded', 'training_requirement.changed', 'role_sheet.changed']
const OWN_MS = 5000

/**
 * `/w/<company>/people/skills?tile=&show=&sort=&line=&team=&q=` (SCR-160): the privacy rules first, then the matrix of the
 * top bar's site (GET /people/skills/matrix, people.skills.view) with every column, so the tiles stay true whatever Show
 * says; line and team narrow the rows read, as each row shows them. A level (1–4 or the cell) is one command with the
 * cell's version; dialogs through `use-skill-dialogs.ts`. Live changes of others wait behind "N updates · Show": rows never
 * move under the cursor.
 */
export function SkillsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = pathname.replace(/\/people\/skills\/?$/, '')
  const can = useMemo(() => skillsCan(session.permissions), [session.permissions])
  const address = useMemo(() => skillsAddressOf(params), [params])
  const siteId = scope.siteId
  // B-W2b-146: the training part — its rights, its lens and terms in the address (`?view=courses|needs|instruction`).
  const trainingRights = useMemo(() => trainingCan(session.permissions), [session.permissions])
  const lenses = useMemo(() => lensesFor(trainingRights), [trainingRights])
  const trainingAddress = useMemo(() => trainingAddressOf(params, trainingRights), [params, trainingRights])
  const onMatrix = trainingAddress.lens === 'matrix'

  const [sight, setSight] = useState<SightState>({ status: 'loading' })
  const [matrix, setMatrix] = useState<MatrixState>({ status: 'loading' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<SkillNotice | null>(null)
  const [cell, setCell] = useState<CellState | null>(null)
  const [saving, setSaving] = useState<string[]>([])
  const ownUntil = useRef(0)
  const value = matrix.status === 'ready' ? matrix.value : null

  // Said before any person is read: the rules of the site first, then the rows.
  useEffect(() => {
    if (!can.view) return
    if (!siteId) return setSight({ status: 'allSites' })
    let live = true
    setSight({ status: 'loading' })
    whatYouSee(api, siteId)
      .then((answer) => live && setSight({ status: 'ready', sight: answer }))
      .catch(() => live && setSight({ status: 'failed' }))
    return () => {
      live = false
    }
  }, [api, can.view, siteId])

  const read = useCallback(async () => {
    try {
      const answer = await getMatrix(api, { siteId, tile: address.tile, sort: address.sort, q: address.q })
      setMatrix({ status: 'ready', value: answer })
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      setMatrix({ status: 'error', problem: readProblem(error) })
    }
  }, [api, siteId, address.tile, address.sort, address.q])

  useEffect(() => {
    if (can.view && sight.status !== 'loading') void read()
  }, [can.view, sight.status, read])

  // Without the matrix (a safety officer: safety.view, no people.skills.view) the dialogs name the people of the due list,
  // the register the safety readers keep (art. 37).
  const [duePeople, setDuePeople] = useState<PersonOption[]>([])
  useEffect(() => {
    if (can.view || !trainingRights.view) return
    let alive = true
    dueListPeople(api, { companyId: session.company?.id ?? null, siteId }).then(
      (people) => alive && setDuePeople(people),
      () => alive && setDuePeople([]),
    )
    return () => {
      alive = false
    }
  }, [api, can.view, trainingRights.view, session.company?.id, siteId])

  const later = useCoalesced(() => setUpdates((count) => count + 1), 1000)
  const live = useLive(
    (change) => {
      if (liveMatches(change, LIVE) && Date.now() > ownUntil.current) later()
    },
    () => void read(),
    can.view,
  )

  const dialogs = useSkillDialogs(api, { today: value?.today ?? '', companyId: session.company?.id ?? null }, (done, words) => {
    ownUntil.current = Date.now() + OWN_MS
    setNotice({ tone: 'success', ns: 'skills', key: done, ...(words ? { params: words } : {}) })
    void read()
  })

  const go = (change: Partial<SkillsAddress>) => router.replace(`${pathname}${skillsAddressText({ ...address, ...change }, params ? new URLSearchParams(params.toString()) : null)}`)
  const goTraining = useCallback(
    (change: Partial<TrainingAddress>) => router.replace(`${pathname}${trainingAddressText({ ...trainingAddress, ...change }, params ? new URLSearchParams(params.toString()) : null, lenses[0] ?? 'matrix')}`, { scroll: false }),
    [router, pathname, trainingAddress, params, lenses],
  )
  const people = useMemo<PersonOption[]>(() => (value ? value.rows.map((row) => ({ employeeId: row.employeeId, name: row.name, companyId: row.companyId, siteId: row.siteId })) : duePeople), [value, duePeople])
  const localToday = useMemo(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date()), [])
  const trainingToday = value?.today ?? localToday
  const training = useTraining(api, trainingRights, trainingAddress, { companyId: session.company?.id ?? null, siteId, today: trainingToday, people }, goTraining, (key, words) => {
    ownUntil.current = Date.now() + OWN_MS
    setNotice({ tone: key.startsWith('refusal.') || key.startsWith('problem.') ? 'danger' : key.endsWith('Some') || key === 'done.recordedNoCertificate' ? 'warning' : 'success', ns: 'training', key, ...(words ? { params: words } : {}) })
    if (onMatrix && can.view) void read()
  })
  const requirementsValue = training.requirements.status === 'ready' ? training.requirements.value : null
  const coursesValue = training.courses.status === 'ready' ? training.courses.value : null

  const openCell = useCallback(
    (ref: CellRef | null, title?: string) => {
      if (!ref) return setCell(null)
      const label = title ?? ''
      setCell({ cell: ref, title: label, detail: null, problem: null })
      getCell(api, { employeeId: ref.employeeId, ...(ref.kind === 'skill' ? { skillId: ref.skillId } : ref.kind === 'machine' ? { machineClassId: ref.classId } : {}) })
        .then((detail) => setCell((current) => (current && cellKey(current.cell) === cellKey(ref) ? { ...current, detail } : current)))
        .catch((error: unknown) => setCell((current) => (current && cellKey(current.cell) === cellKey(ref) ? { ...current, problem: skillsProblem(error) } : current)))
    },
    [api],
  )

  const setRowLevel = (row: MatrixRow, skillId: string, level: SkillLevel) => {
    if (!row.canManage) return setNotice({ tone: 'warning', ns: 'skills', key: 'held.noManage' })
    const body = levelChange(row.employeeId, skillId, levelOf(row, skillId), level)
    if (!body) return
    const key = cellKey({ employeeId: row.employeeId, kind: 'skill', skillId })
    setSaving((current) => [...current, key])
    setNotice(null)
    ownUntil.current = Date.now() + OWN_MS
    setLevel(api, body)
      .then(({ level: saved }) =>
        setMatrix((current) =>
          current.status !== 'ready'
            ? current
            : {
                ...current,
                value: {
                  ...current.value,
                  rows: current.value.rows.map((entry) =>
                    entry.employeeId !== row.employeeId
                      ? entry
                      : { ...entry, levels: [...entry.levels.filter((item) => item.skillId !== skillId), { skillId, levelId: saved.id, level: saved.level, since: saved.since, traineeUntil: saved.traineeUntil, trainee: saved.trainee, signedOffOn: saved.signedOffOn, version: saved.version }] },
                  ),
                },
              },
        ),
      )
      .catch((error: unknown) => {
        const problem = skillsProblem(error)
        setNotice({ tone: 'danger', ns: problem.ns, key: problem.words.key, ...(problem.words.params ? { params: { ...problem.words.params } } : {}) })
      })
      .finally(() => setSaving((current) => current.filter((entry) => entry !== key)))
  }

  /** The person of the open cell, and what the cell's detail read. */
  const cellRow = cell && value ? (value.rows.find((row) => row.employeeId === cell.cell.employeeId) ?? null) : null
  const skillLabel = cell?.title ?? ''

  const actions: SkillsActions = {
    onAddress: go,
    onRetry: () => {
      setMatrix({ status: 'loading' })
      void read()
    },
    onShowUpdates: () => void read(),
    onDismissNotice: () => setNotice(null),
    onCell: (ref, title) => {
      // A course cell holds its facts already (the matrix's DueCell): nothing more is read.
      if (ref?.kind === 'course') return setCell({ cell: ref, title: title ?? '', detail: null, problem: null })
      openCell(ref, title)
    },
    onSetLevel: setRowLevel,
    onAuthoriseMany: (people) => dialogs.open.authorise(people, people.length > 0),
    onCatalogue: () => dialogs.open.catalogue(),
    onLevel: (level) => {
      if (cell?.cell.kind === 'skill' && cellRow) setRowLevel(cellRow, cell.cell.skillId, level)
    },
    onTrainee: () => {
      if (cell?.cell.kind !== 'skill' || !cellRow) return
      const current = cell.detail?.levels.find((row) => row.removedAt === null) ?? null
      dialogs.open.level(dialogPerson(cellRow), { skillId: cell.cell.skillId, skillLabel, level: current?.level ?? null, until: current?.traineeUntil ?? null, version: current?.version ?? null, hasTrainee: Boolean(current?.traineeUntil) })
    },
    onSignOff: () => {
      const current = cell?.detail?.levels.find((row) => row.removedAt === null)
      if (cell?.cell.kind === 'skill' && cellRow && current) dialogs.open.signOff(dialogPerson(cellRow), { skillId: cell.cell.skillId, skillLabel, levelId: current.id, version: current.version, since: current.since })
    },
    onRemove: () => {
      const current = cell?.detail?.levels.find((row) => row.removedAt === null)
      if (cellRow && current) dialogs.open.removeLevel(dialogPerson(cellRow), { skillLabel, levelId: current.id, version: current.version })
    },
    onAuthorise: () => {
      if (cell?.cell.kind === 'machine' && cellRow) dialogs.open.authorise([dialogPerson(cellRow)], true, cell.cell.classId)
    },
    onValidUntil: () => {
      const current = cell?.detail?.authorisations.find((row) => row.revokedAt === null)
      if (cellRow && current) dialogs.open.validUntil(dialogPerson(cellRow), { classLabel: className(current.machineClass, locale), id: current.id, version: current.version, from: current.authorisedOn, until: current.validUntil })
    },
    onRevoke: () => {
      const current = cell?.detail?.authorisations.find((row) => row.revokedAt === null)
      if (cellRow && current) dialogs.open.revoke(dialogPerson(cellRow), { classLabel: className(current.machineClass, locale), id: current.id, version: current.version })
    },
    dialog: dialogs.actions,
    training: {
      onLens: (lens) => goTraining({ lens, course: null, need: null, q: '' }),
      onAddress: goTraining,
      onRetry: () => (trainingAddress.lens === 'courses' ? training.retry.courses() : trainingAddress.lens === 'needs' ? training.retry.needs() : training.retry.instruction()),
      onCourse: training.open.course,
      onStandard: training.open.standard,
      onArchiveMany: (rows) => void training.archiveMany(rows),
      onNeed: training.open.need,
      onClassCourses: training.actions.onClassCourses,
      onInstruction: () => training.open.instruction(),
      onEntry: training.open.entry,
      onPaperMany: (rows) => void training.paperMany(rows),
      onRecord: (chosen, courseId) => training.open.record(chosen.map((person) => ({ employeeId: person.employeeId, name: person.name, companyId: person.companyId, siteId: person.siteId })), courseId ?? null),
      dialog: training.actions,
    },
  }

  return (
    <SkillsView
      model={{
        prefix,
        scope,
        can,
        address,
        sight,
        matrix,
        asOf,
        live,
        updates,
        notice,
        cell,
        saving,
        dialogs: { dialog: dialogs.dialog, rows: value?.rows ?? [], classes: value?.machineClasses ?? [], skills: value?.skills ?? [], sites: value?.sites ?? [], today: value?.today ?? '', signer: session.user.displayName, stepUp: dialogs.stepUp },
        training: trainingRights.view
          ? {
              can: trainingRights,
              address: trainingAddress,
              lenses,
              courses: training.courses,
              requirements: training.requirements,
              instruction: training.instruction,
              today: trainingToday,
              dialogs: {
                dialog: training.dialog,
                can: trainingRights,
                courses: training.activeCourses,
                people,
                machineClasses: requirementsValue?.machineClasses ?? [],
                today: trainingToday,
                canAddGroupWide: coursesValue?.canAddGroupWide ?? false,
                riskHref: OFFICE_PAGES.has('/plant/risk') ? `${prefix}/plant/risk` : null,
                prefix,
              },
            }
          : null,
      }}
      actions={actions}
    />
  )
}
