'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import type { Notice } from '../_shared/parts'
import {
  approveAsHr,
  approveAsLead,
  approveDays,
  approveEntry,
  closeMonth,
  prepareTimesheets,
  readCounts,
  readDays,
  readEntries,
  readEntryCounts,
  readMonthPanel,
  readTimesheets,
  readWhoIsIn,
  sealMonth,
  setDayAbsence,
  type DayCounts,
  type DayRecord,
  type DayRow,
  type EntryCounts,
  type EntryRow,
  type TimesheetRow,
  type WhoIsIn,
} from './api'
import { blockingLimit, daysFilterOf, heldByReason, isCleanDay, isGateClosed, monthRange, problemOf, readProblem, timesheetVerb, type AttendanceAddress, type AttendanceCan, type Words } from './model'
import type { CellState, PageDialog, PanelState, Rows } from './view-model'

/**
 * The reads and the writes of the list parts of People › Attendance: Days (pages of 100; the tile "Absences without a code"
 * has no API filter, so its pages are read to the end here and narrowed), the tiles, Overtime to approve, Timesheets, the
 * Month close and Who is in now. Nothing runs until the page has the site's gate open. A read refused by the gate says so
 * upwards (`onGateClosed`): the page then shows the reason and drops all it held.
 */

const PAGE = 100
const ALL = 500
const CHUNK = 200

const none = <T,>(): Rows<T> => ({ items: null, more: false, problem: null })

export interface UseAttendance {
  days: Rows<DayRow>
  selected: string[]
  setSelected: (ids: string[]) => void
  updates: number
  tiles: { days: DayCounts | null; entries: EntryCounts | null; problem: string | null }
  cells: Readonly<Record<string, CellState>>
  approving: boolean
  overtime: Rows<EntryRow> & { all: boolean; selected: string[]; busy: boolean }
  timesheets: Rows<TimesheetRow> & { canPrepare: boolean; selected: string[]; busy: boolean }
  panel: PanelState
  panelBusy: boolean
  who: { value: WhoIsIn | null; problem: string | null; stale: boolean }
  asOf: string | null
  readList: (quiet?: boolean) => Promise<void>
  moreDays: () => void
  readTiles: () => void
  readOvertime: () => void
  moreOvertime: () => void
  setOvertimeAll: (all: boolean) => void
  setEntriesSelected: (ids: string[]) => void
  bulkEntries: () => void
  readSheets: () => void
  moreSheets: () => void
  setSheetsSelected: (ids: string[]) => void
  bulkSheets: () => void
  prepare: () => void
  readPanel: () => void
  seal: () => void
  close: (phrase: string, onDone: () => void, onProblem: (words: Words) => void) => void
  readWho: () => void
  approveClean: () => void
  approveSelected: () => void
  approveOne: (row: DayRow) => void
  inlineCode: (row: DayRow, codeId: string) => void
  dayChanged: (day: DayRecord) => void
  noteUpdate: () => void
  showUpdates: () => void
}

export function useAttendance(input: {
  api: ApiClient
  enabled: boolean
  can: AttendanceCan
  companyId: string | null
  siteId: string | null
  month: string
  today: string
  address: AttendanceAddress
  onNotice: (notice: Notice | null) => void
  onDialog: (dialog: PageDialog | null) => void
  onGateClosed: () => void
}): UseAttendance {
  const { api, enabled, can, companyId, siteId, month, today, address, onNotice, onDialog, onGateClosed } = input
  const range = useMemo(() => monthRange(month), [month])
  const { teamId, lineId } = address
  const filter = useMemo(() => daysFilterOf(address), [address])

  const shut = useCallback(
    (error: unknown): boolean => {
      if (!isGateClosed(error)) return false
      onGateClosed()
      return true
    },
    [onGateClosed],
  )

  // ---- days -------------------------------------------------------------------------------------------------------------------
  const [days, setDays] = useState<Rows<DayRow>>(none)
  const [selected, setSelected] = useState<string[]>([])
  const [updates, setUpdates] = useState(0)
  const [cells, setCells] = useState<Record<string, CellState>>({})
  const [approving, setApproving] = useState(false)
  const [asOf, setAsOf] = useState<string | null>(null)
  const cursor = useRef<string | null>(null)
  const turn = useRef(0)

  const narrowed = useCallback((rows: readonly DayRow[]) => (filter.onlyMissingCode ? rows.filter((row) => row.absence === 'MISSING') : [...rows]), [filter.onlyMissingCode])

  const readList = useCallback(
    async (quiet = false) => {
      if (!enabled || !can.view || !siteId) return
      const mine = ++turn.current
      if (!quiet) setDays(none)
      const query = { siteId, ...range, teamId, lineId, status: filter.status, anomaly: filter.anomaly, manual: filter.manual }
      try {
        const page = await readDays(api, { ...query, limit: filter.onlyMissingCode ? ALL : PAGE })
        let rows = page.days
        let next = page.nextCursor
        // No API filter for this tile: every page of the month, then narrowed (a month of a site stays a few pages).
        while (filter.onlyMissingCode && next) {
          const more = await readDays(api, { ...query, limit: ALL, cursor: next })
          if (turn.current !== mine) return
          rows = [...rows, ...more.days]
          next = more.nextCursor
        }
        if (turn.current !== mine) return
        cursor.current = next
        setDays({ items: narrowed(rows), more: next !== null, problem: null })
        setUpdates(0)
        setAsOf(new Date().toISOString())
      } catch (error) {
        if (turn.current !== mine || shut(error)) return
        setDays({ items: null, more: false, problem: readProblem(error) })
      }
    },
    [api, enabled, can.view, siteId, range, teamId, lineId, filter, narrowed, shut],
  )

  const moreDays = useCallback(() => {
    if (!siteId || !cursor.current) return
    readDays(api, { siteId, ...range, teamId, lineId, status: filter.status, anomaly: filter.anomaly, manual: filter.manual, cursor: cursor.current, limit: PAGE })
      .then((page) => {
        cursor.current = page.nextCursor
        setDays((rows) => ({ items: [...(rows.items ?? []), ...narrowed(page.days)], more: page.nextCursor !== null, problem: null }))
      })
      .catch((error: unknown) => {
        if (!shut(error)) onNotice({ tone: 'danger', words: { key: 'days.failed' } })
      })
  }, [api, siteId, range, teamId, lineId, filter, narrowed, shut, onNotice])

  // ---- tiles ------------------------------------------------------------------------------------------------------------------
  const [tiles, setTiles] = useState<UseAttendance['tiles']>({ days: null, entries: null, problem: null })
  const readTiles = useCallback(() => {
    if (!enabled || !can.view || !siteId) return
    Promise.all([readCounts(api, { siteId, ...range, teamId, lineId }), readEntryCounts(api, { siteId, ...range, teamId, lineId })])
      .then(([counts, entries]) => setTiles({ days: counts, entries, problem: null }))
      .catch((error: unknown) => {
        if (!shut(error)) setTiles((was) => ({ ...was, problem: readProblem(error) }))
      })
  }, [api, enabled, can.view, siteId, range, teamId, lineId, shut])

  // ---- overtime ---------------------------------------------------------------------------------------------------------------
  const [entries, setEntries] = useState<Rows<EntryRow>>(none)
  const [overtimeAll, setOvertimeAll] = useState(false)
  const [entriesSelected, setEntriesSelected] = useState<string[]>([])
  const [entriesBusy, setEntriesBusy] = useState(false)
  const entryCursor = useRef<string | null>(null)
  const readOvertime = useCallback(() => {
    if (!enabled || !can.view || !siteId) return
    readEntries(api, { siteId, ...range, teamId, lineId, status: overtimeAll ? null : 'PENDING', limit: PAGE })
      .then((page) => {
        entryCursor.current = page.nextCursor
        setEntries({ items: page.entries, more: page.nextCursor !== null, problem: null })
      })
      .catch((error: unknown) => {
        if (!shut(error)) setEntries({ items: null, more: false, problem: readProblem(error) })
      })
  }, [api, enabled, can.view, siteId, range, teamId, lineId, overtimeAll, shut])
  const moreOvertime = useCallback(() => {
    if (!siteId || !entryCursor.current) return
    readEntries(api, { siteId, ...range, teamId, lineId, status: overtimeAll ? null : 'PENDING', limit: PAGE, cursor: entryCursor.current })
      .then((page) => {
        entryCursor.current = page.nextCursor
        setEntries((rows) => ({ items: [...(rows.items ?? []), ...page.entries], more: page.nextCursor !== null, problem: null }))
      })
      .catch(() => onNotice({ tone: 'danger', words: { key: 'overtime.failed' } }))
  }, [api, siteId, range, teamId, lineId, overtimeAll, onNotice])

  const bulkEntries = useCallback(() => {
    const rows = (entries.items ?? []).filter((row) => entriesSelected.includes(row.id) && row.status === 'PENDING')
    if (rows.length === 0 || entriesBusy) return
    setEntriesBusy(true)
    void (async () => {
      let done = 0
      let held = 0
      // A limit that blocks is a decision for one record, with a reason: never overridden from a list.
      for (const row of rows) {
        if (blockingLimit(row.checks)) {
          held += 1
          continue
        }
        try {
          await approveEntry(api, row.id, { version: row.version })
          done += 1
        } catch (error) {
          if (shut(error)) break
          held += 1
        }
      }
      setEntriesBusy(false)
      setEntriesSelected([])
      onNotice(held > 0 ? { tone: 'warning', words: { key: 'overtime.bulkHeld', params: { done, held } } } : { tone: 'success', words: { key: 'overtime.bulkDone', params: { done, count: done } } })
      readOvertime()
      readTiles()
    })()
  }, [api, entries.items, entriesSelected, entriesBusy, shut, onNotice, readOvertime, readTiles])

  // ---- timesheets -------------------------------------------------------------------------------------------------------------
  const [sheets, setSheets] = useState<Rows<TimesheetRow>>(none)
  const [canPrepare, setCanPrepare] = useState(false)
  const [sheetsSelected, setSheetsSelected] = useState<string[]>([])
  const [sheetsBusy, setSheetsBusy] = useState(false)
  const sheetCursor = useRef<string | null>(null)
  const seesSheets = can.view || can.timesheetLead || can.timesheetHr
  const readSheets = useCallback(() => {
    if (!enabled || !seesSheets || !siteId) return
    readTimesheets(api, { siteId, month, teamId, lineId, limit: PAGE })
      .then((page) => {
        sheetCursor.current = page.nextCursor
        setCanPrepare(page.canPrepare)
        setSheets({ items: page.timesheets, more: page.nextCursor !== null, problem: null })
      })
      .catch((error: unknown) => {
        if (!shut(error)) setSheets({ items: null, more: false, problem: readProblem(error) })
      })
  }, [api, enabled, seesSheets, siteId, month, teamId, lineId, shut])
  const moreSheets = useCallback(() => {
    if (!siteId || !sheetCursor.current) return
    readTimesheets(api, { siteId, month, teamId, lineId, limit: PAGE, cursor: sheetCursor.current })
      .then((page) => {
        sheetCursor.current = page.nextCursor
        setSheets((rows) => ({ items: [...(rows.items ?? []), ...page.timesheets], more: page.nextCursor !== null, problem: null }))
      })
      .catch(() => onNotice({ tone: 'danger', words: { key: 'timesheets.failed' } }))
  }, [api, siteId, month, teamId, lineId, onNotice])

  const prepare = useCallback(() => {
    if (!siteId || sheetsBusy) return
    setSheetsBusy(true)
    prepareTimesheets(api, { siteId, month })
      .then((answer) => {
        onNotice({ tone: 'success', words: { key: 'timesheets.prepared', params: { created: answer.created, existing: answer.existing } } })
        readSheets()
      })
      .catch((error: unknown) => {
        if (!shut(error)) onNotice({ tone: 'danger', words: problemOf(error, 'timesheet') })
      })
      .finally(() => setSheetsBusy(false))
  }, [api, siteId, month, sheetsBusy, onNotice, readSheets, shut])

  const bulkSheets = useCallback(() => {
    const rows = (sheets.items ?? []).filter((row) => sheetsSelected.includes(row.id) && row.ready && timesheetVerb(row, can))
    if (rows.length === 0 || sheetsBusy) return
    setSheetsBusy(true)
    void (async () => {
      let done = 0
      let held = 0
      for (const row of rows) {
        try {
          await (timesheetVerb(row, can) === 'lead' ? approveAsLead : approveAsHr)(api, row.id, row.version)
          done += 1
        } catch (error) {
          if (shut(error)) break
          held += 1
        }
      }
      setSheetsBusy(false)
      setSheetsSelected([])
      onNotice(held > 0 ? { tone: 'warning', words: { key: 'timesheets.bulkHeld', params: { done, held } } } : { tone: 'success', words: { key: 'timesheets.bulkDone', params: { done, count: done } } })
      readSheets()
    })()
  }, [api, sheets.items, sheetsSelected, sheetsBusy, can, shut, onNotice, readSheets])

  // ---- the month close --------------------------------------------------------------------------------------------------------
  const [panel, setPanel] = useState<PanelState>({ status: 'hidden' })
  const [panelBusy, setPanelBusy] = useState(false)
  const readPanel = useCallback(() => {
    if (!enabled || !can.view || !companyId) {
      setPanel({ status: 'hidden' })
      return
    }
    setPanel((was) => (was.status === 'ready' && was.value.month === month ? was : { status: 'loading' }))
    readMonthPanel(api, companyId, month)
      .then((value) => setPanel({ status: 'ready', value }))
      .catch((error: unknown) => {
        // The close is the whole company's: someone who does not reach every site has no panel, and is told why.
        if (isApiError(error) && error.kind === 'not_found') setPanel({ status: 'noReach' })
        else if (!shut(error)) setPanel({ status: 'error', problem: readProblem(error) })
      })
  }, [api, enabled, can.view, companyId, month, shut])

  const seal = useCallback(() => {
    if (panel.status !== 'ready' || !panel.value.closeId || panelBusy) return
    setPanelBusy(true)
    sealMonth(api, panel.value.closeId)
      .then((value) => setPanel({ status: 'ready', value }))
      .catch((error: unknown) => {
        if (!shut(error)) onNotice({ tone: 'danger', words: problemOf(error, 'close') })
      })
      .finally(() => setPanelBusy(false))
  }, [api, panel, panelBusy, shut, onNotice])

  const close = useCallback<UseAttendance['close']>(
    (phrase, onDone, onProblem) => {
      if (!companyId) return
      closeMonth(api, { companyId, month, phrase })
        .then((value) => {
          setPanel({ status: 'ready', value })
          onDone()
          onNotice({ tone: 'success', words: { key: value.seal?.sealed ? 'close.done' : 'close.doneUnsealed' } })
          void readList(true)
          readTiles()
          readOvertime()
          readSheets()
        })
        .catch((error: unknown) => {
          if (!shut(error)) onProblem(problemOf(error, 'close'))
          readPanel()
        })
    },
    [api, companyId, month, onNotice, readList, readTiles, readOvertime, readSheets, readPanel, shut],
  )

  // ---- who is in now ----------------------------------------------------------------------------------------------------------
  const [who, setWho] = useState<UseAttendance['who']>({ value: null, problem: null, stale: false })
  const readWho = useCallback(() => {
    if (!enabled || !(can.view || can.rollCall) || !siteId) return
    readWhoIsIn(api, siteId)
      .then((value) => setWho({ value, problem: null, stale: false }))
      .catch((error: unknown) => {
        if (shut(error)) return
        // Offline: the last known list stays, with its time.
        setWho((was) => (was.value ? { ...was, stale: true } : { value: null, problem: readProblem(error), stale: false }))
      })
  }, [api, enabled, can.view, can.rollCall, siteId, shut])

  // ---- first reads ------------------------------------------------------------------------------------------------------------
  useEffect(() => {
    setSelected([])
    void readList()
  }, [readList])
  useEffect(() => readTiles(), [readTiles])
  useEffect(() => readOvertime(), [readOvertime])
  useEffect(() => readSheets(), [readSheets])
  useEffect(() => readPanel(), [readPanel])
  useEffect(() => readWho(), [readWho])

  // A read for another site or a closed gate leaves nothing behind.
  useEffect(() => {
    if (enabled) return
    setDays(none)
    setEntries(none)
    setSheets(none)
    setTiles({ days: null, entries: null, problem: null })
    setPanel({ status: 'hidden' })
    setWho({ value: null, problem: null, stale: false })
  }, [enabled])

  // ---- approving --------------------------------------------------------------------------------------------------------------
  const afterApproval = useCallback(
    async (ids: readonly string[], rows: readonly DayRow[]) => {
      const approved: string[] = []
      const held: Array<{ dayId: string; codes: Parameters<typeof heldByReason>[0][number]['codes'] }> = []
      for (let at = 0; at < ids.length; at += CHUNK) {
        const answer = await approveDays(api, ids.slice(at, at + CHUNK))
        approved.push(...answer.approved)
        held.push(...answer.held)
      }
      setSelected([])
      await readList(true)
      readTiles()
      readOvertime()
      readPanel()
      if (held.length > 0) onDialog({ kind: 'held', approved: approved.length, groups: heldByReason(held, rows) })
      else onNotice({ tone: 'success', words: { key: 'days.approved', params: { count: approved.length } } })
    },
    [api, readList, readTiles, readOvertime, readPanel, onDialog, onNotice],
  )

  const approveSelected = useCallback(() => {
    if (approving || selected.length === 0) return
    setApproving(true)
    afterApproval(selected, days.items ?? [])
      .catch((error: unknown) => {
        if (!shut(error)) onNotice({ tone: 'danger', words: problemOf(error) })
      })
      .finally(() => setApproving(false))
  }, [approving, selected, days.items, afterApproval, shut, onNotice])

  const approveClean = useCallback(() => {
    if (approving || !siteId) return
    setApproving(true)
    void (async () => {
      // Every open day of the selection, not only the rows on screen.
      let rows: DayRow[] = []
      let next: string | null = null
      do {
        const page: Awaited<ReturnType<typeof readDays>> = await readDays(api, { siteId, ...range, teamId, lineId, status: 'OPEN', limit: ALL, cursor: next })
        rows = [...rows, ...page.days]
        next = page.nextCursor
      } while (next)
      const clean = rows.filter((row) => isCleanDay(row, today))
      if (clean.length === 0) onNotice({ tone: 'info', words: { key: 'days.noneClean' } })
      else await afterApproval(clean.map((row) => row.id), rows)
    })()
      .catch((error: unknown) => {
        if (!shut(error)) onNotice({ tone: 'danger', words: problemOf(error) })
      })
      .finally(() => setApproving(false))
  }, [api, approving, siteId, range, teamId, lineId, today, afterApproval, shut, onNotice])

  const approveOne = useCallback(
    (row: DayRow) => {
      if (approving) return
      setApproving(true)
      afterApproval([row.id], [row])
        .catch((error: unknown) => {
          if (!shut(error)) onNotice({ tone: 'danger', words: problemOf(error) })
        })
        .finally(() => setApproving(false))
    },
    [approving, afterApproval, shut, onNotice],
  )

  const inlineCode = useCallback(
    (row: DayRow, codeId: string) => {
      setCells((was) => ({ ...was, [row.id]: { state: 'saving' } }))
      setDayAbsence(api, row.id, { version: row.version, codeId })
        .then((day) => {
          setCells(({ [row.id]: _done, ...rest }) => rest)
          setDays((rows) => ({ ...rows, items: (rows.items ?? []).map((entry) => (entry.id === row.id ? { ...entry, absence: 'CODED', version: day.version, status: day.status } : entry)) }))
          readTiles()
        })
        .catch((error: unknown) => {
          if (shut(error)) return
          setCells((was) => ({ ...was, [row.id]: { state: 'failed', words: problemOf(error) } }))
          void readList(true)
        })
    },
    [api, readTiles, readList, shut],
  )

  /** A day's record changed: its row follows at once, the tiles and the close's checklist after. */
  const dayChanged = useCallback(
    (day: DayRecord) => {
      const open = day.anomalies.filter((entry) => entry.resolvedAt === null)
      setDays((rows) => ({ ...rows, items: rows.items?.map((entry) => (entry.id === day.id ? { ...entry, status: day.status, version: day.version, manual: day.manual, approvedAt: day.approvedAt, absence: day.absences.length > 0 ? 'CODED' : entry.absence === 'CODED' ? 'NONE' : entry.absence, presence: day.figures.firstInAt !== null, anomalies: { open: open.length, kinds: [...new Set(open.map((item) => item.kind))] } } : entry)) ?? null }))
      readTiles()
      readOvertime()
      readPanel()
    },
    [readTiles, readOvertime, readPanel],
  )

  const noteUpdate = useCallback(() => setUpdates((count) => count + 1), [])
  const showUpdates = useCallback(() => void readList(true), [readList])

  return {
    days,
    selected,
    setSelected,
    updates,
    tiles,
    cells,
    approving,
    overtime: { ...entries, all: overtimeAll, selected: entriesSelected, busy: entriesBusy },
    timesheets: { ...sheets, canPrepare, selected: sheetsSelected, busy: sheetsBusy },
    panel,
    panelBusy,
    who,
    asOf,
    readList,
    moreDays,
    readTiles,
    readOvertime,
    moreOvertime,
    setOvertimeAll,
    setEntriesSelected,
    bulkEntries,
    readSheets,
    moreSheets,
    setSheetsSelected,
    bulkSheets,
    prepare,
    readPanel,
    seal,
    close,
    readWho,
    approveClean,
    approveSelected,
    approveOne,
    inlineCode,
    dayChanged,
    noteUpdate,
    showUpdates,
  }
}
