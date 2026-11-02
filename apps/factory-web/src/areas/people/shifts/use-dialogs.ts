'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { getEmployee } from '../_shared/api'
import { minutesOfHours } from '../_shared/model'
import type { Notice } from '../_shared/parts'
import { applyAssign, applyCopy, checkOvertime, createRequest, previewAssign, previewCopy, publishRoster, setDefaultShift, type AssignBody, type PlanPreview, type ShiftChoice } from './api'
import { copyWeeks, minuteOfClock, pickOf, plannedOfPreview, problemOf, setOfOption, personRows, type CellRef, type DayRange, type PlannedCell, type SheetRow, type Words } from './model'
import type { AssignDraft, OvertimeDraft, ShiftsDialog } from './view-model'

export interface DialogArgs {
  readonly api: ApiClient
  readonly siteId: string | null
  readonly range: DayRange
  readonly lineId: string | null
  readonly teamId: string | null
  readonly today: string
  readonly rows: readonly SheetRow[]
  readonly choices: readonly ShiftChoice[]
  readonly drafts: { drafts: number; people: number }
  readonly onNotice: (notice: Notice | null) => void
  /** A write landed: the sheet reads again. */
  readonly onChanged: () => void
  /** A request was made: its row, and ⌘Z's memory of an assignment. */
  readonly onRequests: () => void
  readonly remember: (batch: readonly PlannedCell[]) => void
  readonly undoBatch: (batch: readonly PlannedCell[], done?: (stored: boolean) => void) => void
  readonly onPicked: () => void
}

const WORKING_WEEK = [1, 2, 3, 4, 5, 6, 7]
const CHECK_MS = 350

const key = (words: Words): string => words.key

/** Assign shifts, Copy last week, Publish and Request overtime: each pop-up's state, its preview and its one write. */
export function useShiftDialogs({ api, siteId, range, lineId, teamId, today, rows, choices, drafts, onNotice, onChanged, onRequests, remember, undoBatch, onPicked }: DialogArgs) {
  const [dialog, setDialog] = useState<ShiftsDialog | null>(null)
  const batch = useRef<PlannedCell[]>([])
  const assignKey = useRef<string | null>(null)
  const copyKey = useRef<string | null>(null)
  const close = useCallback(() => setDialog(null), [])

  // ---- Assign ----------------------------------------------------------------------------------------------------------------
  const onAssign = useCallback(
    (cells: readonly CellRef[]) => {
      const people = personRows(rows)
      const pick = pickOf(cells)
      const chosen = pick.employeeIds.length > 0 ? people.filter((row) => pick.employeeIds.includes(row.row.employeeId)) : people
      const editable = chosen.filter((row) => row.row.canEdit)
      setDialog({
        kind: 'assign',
        draft: {
          people: editable.map((row) => ({ id: row.row.employeeId, name: row.row.name, defaultPattern: row.row.defaultPattern })),
          leftOut: chosen.length - editable.length,
          from: pick.from ?? range.from,
          to: pick.to ?? range.to,
          mode: 'days',
          option: '',
          weekdays: WORKING_WEEK,
          closedToo: false,
          busy: false,
          problem: null,
        },
      })
    },
    [rows, range],
  )
  const onAssignDraft = useCallback((patch: Partial<AssignDraft>) => setDialog((before) => (before?.kind === 'assign' ? { ...before, draft: { ...before.draft, ...patch, problem: null } } : before)), [])

  const assignBody = useCallback(
    (draft: AssignDraft): AssignBody | null => {
      const set = setOfOption(draft.option, choices)
      if (set === undefined) return null
      return { employeeIds: draft.people.map((person) => person.id), from: draft.from, to: draft.to, ...(draft.weekdays.length < 7 ? { weekdays: draft.weekdays } : {}), set, skipClosedDays: !draft.closedToo }
    },
    [choices],
  )

  const onAssignReview = useCallback(async () => {
    const current = dialog
    if (current?.kind !== 'assign' && current?.kind !== 'assign-review') return
    const { draft } = current
    if (draft.mode === 'default') {
      setDialog({ kind: 'default-review', draft, review: { phase: 'ready' }, refused: [] })
      return
    }
    const body = assignBody(draft)
    if (!body) return
    assignKey.current = newIdempotencyKey()
    setDialog({ kind: 'assign-review', draft, preview: null, review: { phase: 'reading' } })
    try {
      const preview = await previewAssign(api, body)
      setDialog({ kind: 'assign-review', draft, preview, review: { phase: 'ready' } })
    } catch (error) {
      setDialog({ kind: 'assign-review', draft, preview: null, review: { phase: 'failed', problem: key(problemOf(error)) } })
    }
  }, [api, assignBody, dialog])

  const onAssignBack = useCallback(() => setDialog((before) => (before?.kind === 'assign-review' || before?.kind === 'default-review' ? { kind: 'assign', draft: before.draft } : before)), [])

  const onAssignSave = useCallback(async () => {
    const current = dialog
    if (current?.kind === 'default-review') {
      const { draft } = current
      setDialog({ ...current, review: { phase: 'saving' } })
      const refused: Array<{ name: string; words: string }> = []
      let changed = 0
      for (const person of draft.people.filter((entry) => entry.defaultPattern?.id !== draft.option)) {
        try {
          const record = await getEmployee(api, person.id)
          await setDefaultShift(api, person.id, { version: record.employee.version, defaultShiftPatternId: draft.option })
          changed++
        } catch (error) {
          refused.push({ name: person.name, words: key(problemOf(error)) })
        }
      }
      onChanged()
      onPicked()
      setDialog({ kind: 'default-review', draft, review: { phase: 'done', changed, skipped: refused.length }, refused })
      return
    }
    if (current?.kind !== 'assign-review' || !current.preview) return
    const body = assignBody(current.draft)
    if (!body) return
    setDialog({ ...current, review: { phase: 'saving' } })
    try {
      const answer = await applyAssign(api, body, assignKey.current ?? undefined)
      batch.current = plannedOfPreview(current.preview)
      remember(batch.current)
      onChanged()
      onPicked()
      setDialog({ ...current, review: { phase: 'done', changed: answer.changed, skipped: answer.skipped } })
    } catch (error) {
      setDialog({ ...current, review: { phase: 'failed', problem: key(problemOf(error)) } })
    }
  }, [api, assignBody, dialog, onChanged, onPicked, remember])

  const undoLast = useCallback(() => {
    undoBatch(batch.current, () => {
      onChanged()
      setDialog(null)
    })
  }, [undoBatch, onChanged])

  // ---- Copy last week --------------------------------------------------------------------------------------------------------
  const copyBody = useCallback((week: string) => ({ siteId: siteId ?? '', week, ...(lineId ? { lineId } : {}), ...(teamId ? { teamId } : {}) }), [siteId, lineId, teamId])

  const readCopy = useCallback(async () => {
    const weeks = copyWeeks(range)
    copyKey.current = newIdempotencyKey()
    setDialog({ kind: 'copy', ...weeks, preview: null, review: { phase: 'reading' } })
    try {
      const preview: PlanPreview = await previewCopy(api, copyBody(weeks.week))
      setDialog({ kind: 'copy', ...weeks, preview, review: { phase: 'ready' } })
    } catch (error) {
      setDialog({ kind: 'copy', ...weeks, preview: null, review: { phase: 'failed', problem: key(problemOf(error)) } })
    }
  }, [api, copyBody, range])

  const onCopySave = useCallback(async () => {
    const current = dialog
    if (current?.kind !== 'copy' || !current.preview) return
    setDialog({ ...current, review: { phase: 'saving' } })
    try {
      const answer = await applyCopy(api, copyBody(current.week), copyKey.current ?? undefined)
      batch.current = plannedOfPreview(current.preview)
      remember(batch.current)
      onChanged()
      setDialog({ ...current, review: { phase: 'done', changed: answer.changed, skipped: answer.skipped } })
    } catch (error) {
      setDialog({ ...current, review: { phase: 'failed', problem: key(problemOf(error)) } })
    }
  }, [api, copyBody, dialog, onChanged, remember])

  // ---- Publish --------------------------------------------------------------------------------------------------------------
  const onPublish = useCallback(() => setDialog({ kind: 'publish', drafts: drafts.drafts, people: drafts.people, busy: false, problem: null }), [drafts])

  const onPublishSave = useCallback(async () => {
    const current = dialog
    if (current?.kind !== 'publish' || current.busy || !siteId) return
    setDialog({ ...current, busy: true, problem: null })
    try {
      const answer = await publishRoster(api, { siteId, from: range.from, to: range.to, ...(lineId ? { lineId } : {}), ...(teamId ? { teamId } : {}) })
      setDialog(null)
      onChanged()
      onNotice({ tone: 'success', words: { key: 'notice.published', params: { count: answer.published, people: answer.people } } })
    } catch (error) {
      setDialog({ ...current, busy: false, problem: key(problemOf(error)) })
    }
  }, [api, dialog, siteId, range, lineId, teamId, onChanged, onNotice])

  // ---- Request overtime -----------------------------------------------------------------------------------------------------
  const onOvertime = useCallback(
    (peopleIds?: readonly string[]) => {
      const start = today > range.from && today <= range.to ? today : range.from > today ? range.from : today
      setDialog({ kind: 'overtime', draft: { siteId, date: start, lineId, start: '', hours: '2', reason: '', picked: [...(peopleIds ?? [])], checks: null, checking: false, busy: false, problem: null, tried: false } })
    },
    [siteId, lineId, today, range],
  )
  const onOvertimeDraft = useCallback((patch: Partial<OvertimeDraft>) => setDialog((before) => (before?.kind === 'overtime' ? { ...before, draft: { ...before.draft, ...patch, problem: null } } : before)), [])

  // The picker's limit checks follow the people, the day and the hours.
  const overtime = dialog?.kind === 'overtime' ? dialog.draft : null
  const checkKey = overtime ? `${overtime.siteId}|${overtime.date}|${overtime.start}|${overtime.hours}|${overtime.picked.join(',')}` : ''
  const checkTicket = useRef(0)
  useEffect(() => {
    if (!overtime?.siteId || overtime.picked.length === 0) return
    const minutes = minutesOfHours(overtime.hours)
    const startMinute = minuteOfClock(overtime.start)
    if (!minutes || minutes < 1 || minutes > 720 || startMinute === undefined) return
    const ticket = ++checkTicket.current
    const site = overtime.siteId
    const body = { siteId: site, date: overtime.date, ...(startMinute !== null ? { startMinute } : {}), minutes, employeeIds: overtime.picked }
    const timer = setTimeout(() => {
      onOvertimeDraft({ checking: true })
      checkOvertime(api, body)
        .then((answer) => ticket === checkTicket.current && onOvertimeDraft({ checks: Object.fromEntries(answer.people.map((person) => [person.employeeId, person])), checking: false }))
        .catch((error: unknown) => ticket === checkTicket.current && onOvertimeDraft({ checking: false, problem: key(problemOf(error)) }))
    }, CHECK_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `checkKey` is every term of the check
  }, [checkKey, api, onOvertimeDraft])

  const onOvertimeSave = useCallback(
    async (ask: boolean) => {
      const current = dialog
      if (current?.kind !== 'overtime') return
      const { draft } = current
      const minutes = minutesOfHours(draft.hours)
      const startMinute = minuteOfClock(draft.start)
      const ready = !!draft.siteId && !!minutes && minutes >= 1 && minutes <= 720 && startMinute !== undefined && !!draft.reason.trim() && draft.picked.length > 0
      if (!ready) {
        setDialog({ kind: 'overtime', draft: { ...draft, tried: true } })
        return
      }
      setDialog({ kind: 'overtime', draft: { ...draft, busy: true, problem: null, tried: true } })
      try {
        const record = await createRequest(api, { siteId: draft.siteId!, lineId: draft.lineId, date: draft.date, startMinute, minutes: minutes!, reason: draft.reason.trim(), employeeIds: draft.picked, ask })
        setDialog(null)
        onPicked()
        onRequests()
        onNotice({ tone: 'success', words: { key: ask ? 'notice.requestAsked' : 'notice.requestDraft', params: { count: record.request.counts.asked } } })
      } catch (error) {
        setDialog({ kind: 'overtime', draft: { ...draft, busy: false, problem: key(problemOf(error)), tried: true } })
      }
    },
    [api, dialog, onNotice, onPicked, onRequests],
  )

  return { dialog, setDialog, close, onAssign, onAssignDraft, onAssignReview, onAssignBack, onAssignSave, undoLast, onCopy: readCopy, onCopyRetry: readCopy, onCopySave, onPublish, onPublishSave, onOvertime, onOvertimeDraft, onOvertimeSave }
}
