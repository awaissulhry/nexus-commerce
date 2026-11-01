'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useLiveBus } from '../../../../shell/live/use-live'
import {
  createFloorWorker,
  employeeAudit,
  endLoan,
  findAgencies,
  getEmployee,
  linesFromFloor,
  linesFromTree,
  linkWorker,
  listEmployees,
  listTeams,
  removeLoan,
  updateEmployee,
  whatYouSee,
  type AuditEntry,
  type EmployeeFields,
  type EmployeeRecord as EmployeeRecordValue,
  type Ref,
  type SiteLine,
  type Team,
} from '../../_shared/api'
import { fieldOf, minutesOfHours, ORDER_KEY, peopleCan, problemOf, readProblem, TIME_ZONE } from '../../_shared/model'
import type { Loaded, Notice, SightState } from '../../_shared/parts'
import { useEmployeeDialogs } from '../use-dialogs'
import { EMPLOYEE_TABS, personOf, type EditDraft, type EmployeeRecordModel, type EmployeeTab, type Rows } from '../view-model'
import { EmployeeRecordView } from './view/EmployeeRecordView'

/**
 * `/w/<company>/people/employees/<id>` (SCR-085; `?tab=profile|job|documents|activity`): the privacy note's rules for the
 * person's site first, then the record, again on its live changes; the explicit edit of Identity and Job (only what
 * changed is sent, with the version read; the employee code checked against the register when the field is left, the
 * server's refusal at its field); the floor sign-in made with Admin › Users' own command; the pop-ups through
 * use-dialogs.ts; Activity from the record's audit (audit.read).
 */
export function EmployeeRecord({ employeeId }: { employeeId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => peopleCan(session.permissions), [session.permissions])
  const asked = params?.get('tab') ?? ''
  const tab: EmployeeTab = (EMPLOYEE_TABS as readonly string[]).includes(asked) ? (asked as EmployeeTab) : 'profile'
  const [origin, setOrigin] = useState('')
  useEffect(() => setOrigin(window.location.origin), [])

  const [loaded, setLoaded] = useState<Loaded<EmployeeRecordValue>>({ status: 'loading' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [sight, setSight] = useState<SightState>({ status: 'loading' })
  const load = useCallback(async () => {
    try {
      const value = await getEmployee(api, employeeId)
      setLoaded({ status: 'ready', value })
      setAsOf(new Date().toISOString())
      return value
    } catch (error) {
      setLoaded(isApiError(error) && error.kind === 'not_found' ? { status: 'notFound' } : isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
      return null
    }
  }, [api, employeeId])

  // The note first (the person's site is not known before the record: the session's one site, else the record's).
  useEffect(() => {
    if (!can.view) {
      setLoaded({ status: 'forbidden' })
      setSight({ status: 'failed' })
      return
    }
    let live = true
    const first = session.sites.length === 1 ? session.sites[0]!.id : null
    const sightOf = (siteId: string) =>
      whatYouSee(api, siteId)
        .then((value) => live && setSight({ status: 'ready', sight: value }))
        .catch(() => live && setSight({ status: 'failed' }))
    void (async () => {
      if (first) await sightOf(first)
      const value = await load()
      if (live && value && value.employee.site.id !== first) await sightOf(value.employee.site.id)
      else if (live && !value && !first) setSight({ status: 'failed' })
    })()
    return () => {
      live = false
    }
  }, [api, can.view, load, session.sites])

  const value = loaded.status === 'ready' ? loaded.value : null
  const siteId = value?.employee.site.id ?? null
  const live = useLiveBus(
    {
      onChange: (change) => {
        const fields = change.fields as Record<string, unknown>
        if (fields.employeeId === employeeId || (Array.isArray(fields.employeeIds) && fields.employeeIds.includes(employeeId))) void load()
      },
      onReconnect: () => void load(),
    },
    can.view,
  )

  // ---- lines and teams of the person's site (the job's home line, a loan, a team change) ------------------------------------
  const [lines, setLines] = useState<SiteLine[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  useEffect(() => {
    if (!siteId) return
    const read = can.sites ? linesFromTree(api, siteId) : can.floorLines ? linesFromFloor(api, siteId) : Promise.resolve([] as SiteLine[])
    read.then(setLines).catch(() => setLines([]))
    listTeams(api, siteId)
      .then((answer) => setTeams(answer.teams))
      .catch(() => setTeams([]))
  }, [api, siteId, can.sites, can.floorLines])
  const knownLines = useMemo<SiteLine[]>(() => {
    if (lines.length > 0) return lines
    const seen = new Map<string, SiteLine>()
    for (const team of teams) if (team.line && !seen.has(team.line.id)) seen.set(team.line.id, { ...team.line, siteId: team.site.id, teams: [] })
    return [...seen.values()]
  }, [lines, teams])

  // ---- Activity -------------------------------------------------------------------------------------------------------------
  const [audit, setAudit] = useState<Rows<AuditEntry> | null>(null)
  useEffect(() => {
    if (tab !== 'activity' || !can.audit || !value) return
    setAudit({ items: null, problem: null })
    employeeAudit(api, employeeId)
      .then((items) => setAudit({ items, problem: null }))
      .catch((error: unknown) => setAudit({ items: null, problem: readProblem(error) }))
  }, [api, employeeId, tab, can.audit, value])

  // ---- J / K: neighbours in the list last opened ----------------------------------------------------------------------------
  const [neighbours, setNeighbours] = useState<{ prev: string | null; next: string | null }>({ prev: null, next: null })
  useEffect(() => {
    try {
      const order = JSON.parse(window.sessionStorage.getItem(ORDER_KEY) ?? '[]') as unknown
      if (!Array.isArray(order)) return
      const index = order.indexOf(employeeId)
      if (index === -1) return
      setNeighbours({ prev: typeof order[index - 1] === 'string' ? (order[index - 1] as string) : null, next: typeof order[index + 1] === 'string' ? (order[index + 1] as string) : null })
    } catch {
      // No order kept: J / K do nothing.
    }
  }, [employeeId])

  // ---- the explicit edit ----------------------------------------------------------------------------------------------------
  const [notice, setNotice] = useState<Notice | null>(null)
  const [edit, setEdit] = useState<EmployeeRecordModel['edit']>(null)
  const [agencies, setAgencies] = useState<Ref[] | null>(null)
  const startEdit = useCallback(
    (section: 'identity' | 'job') => {
      if (!value) return
      const employee = value.employee
      const draft: EditDraft = {
        firstName: employee.firstName,
        lastName: employee.lastName,
        displayName: employee.displayName,
        employeeCode: employee.employeeCode ?? '',
        kind: employee.kind,
        agency: employee.agency,
        locale: employee.locale,
        startDate: employee.startDate,
        endDate: employee.endDate ?? '',
        department: employee.department ?? '',
        jobRole: employee.jobRole ?? '',
        homeLineId: employee.homeLine?.id ?? null,
        contract: employee.contract,
        hours: employee.weeklyMinutes === null ? '' : String(employee.weeklyMinutes / 60).replace('.', session.user.locale === 'en' ? '.' : ','),
      }
      setEdit({ section, draft, busy: false, problem: null, field: null, codeTaken: false })
    },
    [value, session.user.locale],
  )

  const codeLeft = useCallback(async () => {
    if (!edit || !value) return
    const code = edit.draft.employeeCode.trim()
    if (!code || code === (value.employee.employeeCode ?? '')) {
      setEdit((current) => (current ? { ...current, codeTaken: false } : current))
      return
    }
    try {
      const page = await listEmployees(api, { q: code, rows: 'ALL', limit: 20 })
      const taken = page.employees.some((row) => row.id !== value.employee.id && row.employeeCode === code)
      setEdit((current) => (current ? { ...current, codeTaken: taken } : current))
    } catch {
      // The server checks it again on Apply.
    }
  }, [api, edit, value])

  const apply = useCallback(async () => {
    if (!edit || !value || edit.busy) return
    const employee = value.employee
    const draft = edit.draft
    const body: EmployeeFields = {}
    if (edit.section === 'identity') {
      if (draft.firstName.trim() !== employee.firstName) body.firstName = draft.firstName.trim()
      if (draft.lastName.trim() !== employee.lastName) body.lastName = draft.lastName.trim()
      if (draft.displayName.trim() !== employee.displayName) body.displayName = draft.displayName.trim()
      if ((draft.employeeCode.trim() || null) !== employee.employeeCode) body.employeeCode = draft.employeeCode.trim() || null
      if (draft.kind !== employee.kind) body.kind = draft.kind
      if ((draft.agency?.id ?? null) !== (employee.agency?.id ?? null)) body.agencyPartyId = draft.agency?.id ?? null
      if (draft.locale !== employee.locale) body.locale = draft.locale
      if (draft.startDate !== employee.startDate) body.startDate = draft.startDate
      if ((draft.endDate || null) !== employee.endDate) body.endDate = draft.endDate || null
    } else {
      if ((draft.department.trim() || null) !== employee.department) body.department = draft.department.trim() || null
      if ((draft.jobRole.trim() || null) !== employee.jobRole) body.jobRole = draft.jobRole.trim() || null
      if (draft.homeLineId !== (employee.homeLine?.id ?? null)) body.homeLineId = draft.homeLineId
      if (draft.contract !== employee.contract) body.contract = draft.contract
      const minutes = minutesOfHours(draft.hours)
      if (minutes !== undefined && minutes !== employee.weeklyMinutes) body.weeklyMinutes = minutes
    }
    if (Object.keys(body).length === 0) {
      setEdit(null)
      return
    }
    setEdit({ ...edit, busy: true, problem: null, field: null })
    try {
      await updateEmployee(api, employee.id, { version: employee.version, ...body })
      setEdit(null)
      setNotice({ tone: 'success', words: { key: 'notice.saved' } })
      void load()
    } catch (error) {
      setEdit((current) => (current ? { ...current, busy: false, problem: problemOf(error), field: fieldOf(error) } : current))
    }
  }, [api, edit, value, load])

  const findAgency = useCallback(
    (text: string) => {
      if (!can.parties || text.trim().length < 2) {
        setAgencies(null)
        return
      }
      findAgencies(api, text)
        .then(setAgencies)
        .catch(() => setAgencies([]))
    },
    [api, can.parties],
  )

  // ---- the floor sign-in (Admin › Users' own command, then linked) ------------------------------------------------------------
  const createSignIn = useCallback(async () => {
    if (!value) return
    const employee = value.employee
    try {
      const worker = await createFloorWorker(api, { siteId: employee.site.id, displayName: employee.displayName, locale: employee.locale, ...(employee.employeeCode ? { employeeCode: employee.employeeCode } : {}) })
      await linkWorker(api, employee.id, { version: employee.version, workerId: worker.id })
      setNotice({ tone: 'success', words: { key: 'notice.signInMade' } })
      void load()
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: 'notice.signInNotMade' }, detail: problemOf(error) })
    }
  }, [api, value, load])

  const loanStep = useCallback(
    async (loanId: string, end: boolean) => {
      const loan = value?.loans.find((entry) => entry.id === loanId)
      if (!loan) return
      try {
        if (end) await endLoan(api, loanId, { version: loan.version })
        else await removeLoan(api, loanId, { version: loan.version })
        void load()
      } catch (error) {
        setNotice({ tone: 'danger', words: { key: 'notice.loanRefused' }, detail: problemOf(error) })
      }
    },
    [api, value, load],
  )

  const dialogs = useEmployeeDialogs({ api, can, timeZone: TIME_ZONE, onChanged: () => void load(), onNotice: setNotice })
  const person = value ? personOf(value.employee) : null
  const leaver = value?.leaving?.status === 'OPEN' ? { ...value.leaving, employee: { id: value.employee.id, name: value.employee.name, displayName: value.employee.displayName, employeeCode: value.employee.employeeCode, kind: value.employee.kind, site: value.employee.site, companyId: value.employee.companyId }, openSteps: value.leaving.steps.filter((step) => step.status === 'OPEN').length } : null

  const model: EmployeeRecordModel = {
    prefix,
    origin,
    can,
    tab,
    loaded,
    sight,
    asOf,
    live,
    edit,
    lines: knownLines,
    agencies,
    teams,
    audit,
    dialog: dialogs.dialog,
    notice,
    neighbours,
    timeZone: TIME_ZONE,
  }

  return (
    <EmployeeRecordView
      model={model}
      actions={{
        onRetry: () => void load(),
        onEdit: startEdit,
        onDraft: (patch) => setEdit((current) => (current ? { ...current, draft: { ...current.draft, ...patch }, ...(patch.employeeCode !== undefined ? { codeTaken: false } : {}), problem: null, field: null } : current)),
        onCodeLeft: () => void codeLeft(),
        onApply: () => void apply(),
        onDiscard: () => setEdit(null),
        onFindAgency: findAgency,
        onLoan: () => person && dialogs.openLoan(person),
        onEndLoan: (loanId) => void loanStep(loanId, true),
        onRemoveLoan: (loanId) => void loanStep(loanId, false),
        onLeaver: () => person && dialogs.openLeaver(person),
        onCancelLeaving: () => leaver && dialogs.openCancelLeaving(leaver),
        onBadge: () => person && dialogs.openBadges([person]),
        onTeamChange: () => person && dialogs.openTeamChange([person]),
        onCreateSignIn: () => void createSignIn(),
        onStepDone: (step) => leaver && void dialogs.markStepDone(leaver, step),
        onStepSkip: (step) => leaver && dialogs.openSkip(leaver, step),
        onDismissNotice: () => setNotice(null),
        dialog: dialogs.actions,
      }}
    />
  )
}
