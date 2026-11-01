'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import {
  applyMoves,
  cancelLeaving,
  createEmployee,
  createFloorWorker,
  createLoan,
  createTeam,
  employeeFromWorker,
  findAgencies,
  leavingPreview,
  lineCheck,
  linkWorker,
  previewMoves,
  startLeaving,
  stepDone,
  stepSkip,
  type Leaver,
  type LeaverStep,
  type UnlinkedWorker,
} from '../_shared/api'
import { fieldOf, problemOf, todayIn, zonedInstant, type PeopleCan } from '../_shared/model'
import type { Notice } from '../_shared/parts'
import type { DialogActions, EmployeesDialog, NewDraft, Person } from './view-model'

/**
 * The pop-ups' container (People › Employees and an employee's record share it): what each one reads while it is open
 * (the leaving preview for the day typed, the loan's skill check for the line chosen, the agencies found, the moves'
 * review) and the one command each sends — with its own Idempotency-Key, the version read — and what follows (the list
 * or the record read again, a notice in words). A refusal stays in the dialog, at its field when it names one.
 */

export interface DialogsOptions {
  api: ApiClient
  can: PeopleCan
  timeZone: string
  /** After a write: read what shows it again. */
  onChanged: () => void
  /** After New employee: open the record. */
  onCreated?: (id: string) => void
  /** A notice on the page (a success, a partial refusal). */
  onNotice: (notice: Notice) => void
  /** Closing New employee / Import clears its address term. */
  onClosed?: (kind: EmployeesDialog['kind']) => void
}

export const blankNewDraft = (siteId: string | null, today: string): NewDraft => ({
  firstName: '',
  lastName: '',
  employeeCode: '',
  kind: 'EMPLOYEE',
  agency: null,
  siteId,
  jobRole: '',
  startDate: today,
  endDate: '',
  locale: 'it',
  floorSignIn: false,
})

export function useEmployeeDialogs(options: DialogsOptions) {
  const { api, can, timeZone } = options
  const latestOptions = useRef(options)
  latestOptions.current = options
  const [dialog, setDialog] = useState<EmployeesDialog | null>(null)
  const latest = useRef(dialog)
  latest.current = dialog
  const set = useCallback(<K extends EmployeesDialog['kind']>(kind: K, patch: Partial<Extract<EmployeesDialog, { kind: K }>>) => setDialog((current) => (current?.kind === kind ? ({ ...current, ...patch } as EmployeesDialog) : current)), [])

  // ---- the leaving preview follows the day typed ----------------------------------------------------------------------------
  const leaverKey = dialog?.kind === 'leaver' ? `${dialog.person.id}|${dialog.lastWorkingDay}|${dialog.exitVisit}` : null
  useEffect(() => {
    const current = latest.current
    if (current?.kind !== 'leaver' || !current.lastWorkingDay) return
    let live = true
    set('leaver', { reading: true, preview: null })
    leavingPreview(api, current.person.id, current.lastWorkingDay, current.exitVisit)
      .then((preview) => live && set('leaver', { preview, reading: false }))
      .catch((error: unknown) => live && set('leaver', { reading: false, problem: problemOf(error) }))
    return () => {
      live = false
    }
  }, [api, leaverKey, set])

  // ---- the loan's skill check follows the line chosen -----------------------------------------------------------------------
  const loanKey = dialog?.kind === 'loan' ? `${dialog.person.id}|${dialog.toLineId}` : null
  useEffect(() => {
    const current = latest.current
    if (current?.kind !== 'loan' || !current.toLineId || !can.skills) return
    let live = true
    set('loan', { check: 'loading' })
    lineCheck(api, current.person.id, current.toLineId)
      .then((check) => live && set('loan', { check }))
      .catch(() => live && set('loan', { check: 'none' }))
    return () => {
      live = false
    }
  }, [api, loanKey, can.skills, set])

  // ---- openers --------------------------------------------------------------------------------------------------------------
  const openNew = useCallback((siteId: string | null) => setDialog((current) => (current?.kind === 'new' ? current : { kind: 'new', draft: blankNewDraft(siteId, todayIn(timeZone)), agencies: null, busy: false, problem: null, field: null })), [timeZone])
  const openLoan = useCallback(
    (person: Person) => {
      const today = todayIn(timeZone)
      const now = new Date()
      const quarter = new Date(Math.ceil(now.getTime() / 900_000) * 900_000).toISOString()
      setDialog({ kind: 'loan', person, toLineId: null, toTeamId: null, startsAt: quarter, endsAt: zonedInstant(today, '18:00', timeZone), reason: '', check: null, busy: false, problem: null, field: null })
    },
    [timeZone],
  )
  const openLeaver = useCallback((person: Person) => setDialog({ kind: 'leaver', person, lastWorkingDay: '', exitVisit: false, preview: null, reading: false, busy: false, problem: null }), [])
  const openBadges = useCallback((people: Person[]) => setDialog({ kind: 'badges', people }), [])
  const openTeamChange = useCallback((people: Person[]) => setDialog({ kind: 'teamChange', people, teamId: null, rows: null, state: { phase: 'reading' }, reviewing: false }), [])
  const openAddTeam = useCallback((siteId: string | null) => setDialog({ kind: 'addTeam', siteId, lineId: null, code: '', name: '', busy: false, problem: null, field: null }), [])
  const openSkip = useCallback((leaver: Leaver, step: LeaverStep) => setDialog({ kind: 'skip', leaver, step, reason: '', busy: false, problem: null }), [])
  const openCancelLeaving = useCallback((leaver: Leaver) => setDialog({ kind: 'cancelLeaving', leaver, reason: '', busy: false, problem: null }), [])
  const openLink = useCallback((workers: UnlinkedWorker[]) => setDialog({ kind: 'link', workers, busy: false, refused: [] }), [])

  const close = useCallback(() => {
    const kind = latest.current?.kind
    setDialog(null)
    if (kind) latestOptions.current.onClosed?.(kind)
  }, [])

  /** A leaver step ticked by hand (no dialog: the step and its version are on screen). */
  const markStepDone = useCallback(
    async (leaver: Leaver, step: LeaverStep) => {
      try {
        await stepDone(api, leaver.id, step.id, { version: step.version })
        latestOptions.current.onChanged()
      } catch (error) {
        latestOptions.current.onNotice({ tone: 'danger', words: { key: 'notice.stepRefused' }, detail: problemOf(error) })
      }
    },
    [api],
  )

  // ---- the one command of each dialog ---------------------------------------------------------------------------------------
  const review = useCallback(async () => {
    const current = latest.current
    if (current?.kind !== 'teamChange') return
    setDialog({ ...current, reviewing: true, state: { phase: 'reading' }, rows: null })
    try {
      const answer = await previewMoves(
        api,
        current.people.map((person) => ({ employeeId: person.id, teamId: current.teamId })),
      )
      set('teamChange', { rows: answer.rows, state: { phase: 'ready' } })
    } catch (error) {
      set('teamChange', { state: { phase: 'failed', error: problemOf(error).key } })
    }
  }, [api, set])

  const moveKey = useRef<string | null>(null)
  const submit = useCallback(async () => {
    const current = latest.current
    if (!current) return
    const { onChanged, onNotice, onCreated } = latestOptions.current
    switch (current.kind) {
      case 'new': {
        if (current.busy) return
        const draft = current.draft
        set('new', { busy: true, problem: null, field: null })
        try {
          const employee = await createEmployee(api, {
            siteId: draft.siteId!,
            firstName: draft.firstName.trim(),
            lastName: draft.lastName.trim(),
            startDate: draft.startDate,
            kind: draft.kind,
            locale: draft.locale,
            ...(draft.employeeCode.trim() ? { employeeCode: draft.employeeCode.trim() } : {}),
            ...(draft.kind === 'AGENCY' && draft.agency ? { agencyPartyId: draft.agency.id } : {}),
            ...(draft.endDate ? { endDate: draft.endDate } : {}),
            ...(draft.jobRole.trim() ? { jobRole: draft.jobRole.trim() } : {}),
          })
          // "Also create floor sign-in": the worker (Admin › Users' command), then linked; the badge and PIN are set there.
          if (draft.floorSignIn && can.manageWorkers) {
            try {
              const worker = await createFloorWorker(api, { siteId: employee.site.id, displayName: employee.displayName, locale: employee.locale, ...(employee.employeeCode ? { employeeCode: employee.employeeCode } : {}) })
              await linkWorker(api, employee.id, { version: employee.version, workerId: worker.id })
            } catch (error) {
              onNotice({ tone: 'warning', words: { key: 'notice.signInNotMade' }, detail: problemOf(error) })
            }
          }
          setDialog(null)
          onChanged()
          onCreated?.(employee.id)
        } catch (error) {
          set('new', { busy: false, problem: problemOf(error), field: fieldOf(error) })
        }
        return
      }
      case 'loan': {
        if (current.busy || !current.toLineId) return
        set('loan', { busy: true, problem: null, field: null })
        try {
          await createLoan(api, { employeeId: current.person.id, toLineId: current.toLineId, ...(current.toTeamId ? { toTeamId: current.toTeamId } : {}), startsAt: current.startsAt, endsAt: current.endsAt, reason: current.reason.trim() })
          setDialog(null)
          onNotice({ tone: 'success', words: { key: 'notice.loaned', params: { name: current.person.name } } })
          onChanged()
        } catch (error) {
          set('loan', { busy: false, problem: problemOf(error), field: fieldOf(error) })
        }
        return
      }
      case 'leaver': {
        if (current.busy || !current.lastWorkingDay) return
        set('leaver', { busy: true, problem: null })
        try {
          await startLeaving(api, current.person.id, { lastWorkingDay: current.lastWorkingDay, exitVisit: current.exitVisit })
          setDialog(null)
          onNotice({ tone: 'success', words: { key: 'notice.leaving', params: { name: current.person.name } } })
          onChanged()
        } catch (error) {
          set('leaver', { busy: false, problem: problemOf(error) })
        }
        return
      }
      case 'teamChange': {
        if (current.state.phase !== 'ready' || !current.rows) return
        const moving = current.rows.filter((row) => row.change === 'MOVE' && !row.conflict)
        if (moving.length === 0) return
        set('teamChange', { state: { phase: 'saving' } })
        moveKey.current ??= newIdempotencyKey()
        try {
          const answer = await applyMoves(
            api,
            moving.map((row) => ({ employeeId: row.employeeId, teamId: current.teamId })),
            moveKey.current,
          )
          moveKey.current = null
          // The words are message keys of `people` (teamChange.result.*): the dialog says them.
          const results = Object.fromEntries(current.rows.map((row) => [row.employeeId, { ok: row.conflict === null && (row.change === 'NONE' || answer.rows.some((moved) => moved.employeeId === row.employeeId && moved.change === 'MOVE')), words: row.conflict ? 'refused' : row.change === 'MOVE' ? 'moved' : 'already' }]))
          set('teamChange', { state: { phase: 'done', results } })
          onChanged()
        } catch (error) {
          moveKey.current = null
          set('teamChange', { state: { phase: 'failed', error: problemOf(error).key } })
        }
        return
      }
      case 'addTeam': {
        if (current.busy || !current.siteId) return
        set('addTeam', { busy: true, problem: null, field: null })
        try {
          await createTeam(api, { siteId: current.siteId, ...(current.lineId ? { lineId: current.lineId } : {}), code: current.code.trim().toUpperCase(), name: current.name.trim() })
          setDialog(null)
          onNotice({ tone: 'success', words: { key: 'notice.teamAdded', params: { team: current.code.trim().toUpperCase() } } })
          onChanged()
        } catch (error) {
          set('addTeam', { busy: false, problem: problemOf(error), field: fieldOf(error) })
        }
        return
      }
      case 'skip': {
        if (current.busy) return
        set('skip', { busy: true, problem: null })
        try {
          await stepSkip(api, current.leaver.id, current.step.id, { version: current.step.version, reason: current.reason.trim() })
          setDialog(null)
          onChanged()
        } catch (error) {
          set('skip', { busy: false, problem: problemOf(error) })
        }
        return
      }
      case 'cancelLeaving': {
        if (current.busy) return
        set('cancelLeaving', { busy: true, problem: null })
        try {
          await cancelLeaving(api, current.leaver.id, { version: current.leaver.version, reason: current.reason.trim() })
          setDialog(null)
          onNotice({ tone: 'success', words: { key: 'notice.leavingCancelled', params: { name: current.leaver.employee.name } } })
          onChanged()
        } catch (error) {
          set('cancelLeaving', { busy: false, problem: problemOf(error) })
        }
        return
      }
      case 'link': {
        if (current.busy) return
        set('link', { busy: true, refused: [] })
        const refused: Array<{ name: string; words: ReturnType<typeof problemOf> }> = []
        let made = 0
        for (const worker of current.workers) {
          try {
            await employeeFromWorker(api, { workerId: worker.id })
            made += 1
          } catch (error) {
            refused.push({ name: worker.displayName, words: problemOf(error) })
          }
        }
        onChanged()
        if (made > 0) onNotice({ tone: 'success', words: { key: 'notice.linked', params: { count: made } } })
        if (refused.length === 0) setDialog(null)
        else set('link', { busy: false, refused, workers: current.workers.filter((worker) => refused.some((entry) => entry.name === worker.displayName)) })
        return
      }
      case 'badges':
        return
    }
  }, [api, can.manageWorkers, set])

  const findAgency = useCallback(
    (text: string) => {
      if (!can.parties || text.trim().length < 2) {
        set('new', { agencies: null })
        return
      }
      findAgencies(api, text)
        .then((agencies) => set('new', { agencies }))
        .catch(() => set('new', { agencies: [] }))
    },
    [api, can.parties, set],
  )

  const actions: DialogActions = {
    onClose: close,
    onSubmit: () => void submit(),
    onNewDraft: (patch) => setDialog((current) => (current?.kind === 'new' ? { ...current, draft: { ...current.draft, ...patch }, field: null, problem: null } : current)),
    onFindAgency: findAgency,
    onLoan: (patch) => set('loan', { ...patch, field: null, problem: null, ...(patch.toLineId !== undefined ? { check: null } : {}) }),
    onLeaver: (patch) => set('leaver', { ...patch, problem: null }),
    onTeam: (teamId) => set('teamChange', { teamId }),
    onReview: () => void review(),
    onAddTeam: (patch) => set('addTeam', { ...patch, field: null, problem: null }),
    onReason: (reason) => setDialog((current) => (current?.kind === 'skip' || current?.kind === 'cancelLeaving' ? { ...current, reason } : current)),
  }

  return { dialog, setDialog, actions, openNew, openLoan, openLeaver, openBadges, openTeamChange, openAddTeam, openSkip, openCancelLeaving, openLink, markStepDone }
}
