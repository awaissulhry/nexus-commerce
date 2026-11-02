'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { useLiveBus } from '../../../shell/live/use-live'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { linesFromFloor, linesFromTree, listEmployees, listTeams, type Ref, type SiteLine } from '../_shared/api'
import { csvText, TIME_ZONE, todayIn } from '../_shared/model'
import type { Notice, SightState } from '../_shared/parts'
import { addManualEntry, approveEntry, readAbsenceCodes, readEntry, readSight, rejectEntry, reopenEntry, type AbsenceCode, type EntryRecord } from './api'
import {
  attendanceAddressOf,
  attendanceAddressText,
  attendanceCan,
  daysCsvRows,
  gateOf,
  isGateClosed,
  isLimitBlocked,
  limitsOf,
  manualBodyOf,
  monthOfDay,
  problemOf,
  readProblem,
  reasonOf,
  seesThePage,
  showMeOf,
  type AttendanceAddress,
  type ManualDraft,
  type ManualReason,
} from './model'
import { useAttendance } from './use-attendance'
import { useDayRecord } from './use-day'
import type { Loaded } from '../_shared/parts'
import type { AttendanceActions, AttendanceModel, EntryState, PageDialog, TeamRef } from './view-model'
import { AttendanceView } from './view/AttendanceView'

const SITE_EVENTS = new Set(['attendance.day_changed', 'attendance.anomaly_raised', 'attendance.clock_event', 'attendance.day_corrected'])

/**
 * `/w/<company>/people/attendance` (SCR-157): the address holds the month and team or line, the tile or filter, the open day
 * (`?open=`) and overtime entry (`?entry=`); the site is the top bar's. The legal text comes first: the site's ATTENDANCE gate is
 * read before anything else, and with the gate shut the page says why and reads nothing of a person. A list never carries a
 * name or minutes; those open one record at a time. Live: a clock event or a changed day counts in "N updates · Show" (rows
 * never move under the cursor), the tiles and Who is in now re-read by themselves.
 */
export function AttendancePage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => attendanceCan(session.permissions), [session.permissions])
  const address = useMemo(() => attendanceAddressOf(params), [params])
  const today = todayIn(TIME_ZONE)
  const month = address.month ?? monthOfDay(today)
  const siteId = scope.siteId
  const companyId = session.company?.id ?? null

  const go = useCallback(
    (next: Partial<AttendanceAddress>) => {
      const keep = new URLSearchParams(params?.toString() ?? '')
      router.replace(`${pathname}${attendanceAddressText({ ...address, ...next }, keep)}`, { scroll: false })
    },
    [router, pathname, address, params],
  )

  const t = useMemo(() => createTranslator(locale, messagesFor(locale, ['attendance']).attendance ?? {}), [locale])
  const reasonWords = useCallback((code: ManualReason) => t(`reason.${code}`), [t])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<PageDialog | null>(null)
  const [help, setHelp] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // ---- the legal text first: the site's gate before any person ------------------------------------------------------------------
  const [sight, setSight] = useState<SightState>({ status: 'loading' })
  const [gateShut, setGateShut] = useState(false)
  useEffect(() => {
    let live = true
    setGateShut(false)
    if (!siteId) {
      setSight({ status: 'allSites' })
      return
    }
    setSight({ status: 'loading' })
    readSight(api, siteId)
      .then((value) => live && setSight({ status: 'ready', sight: value }))
      .catch(() => live && setSight({ status: 'failed' }))
    return () => {
      live = false
    }
  }, [api, siteId])
  const gate = gateOf(sight, gateShut)
  const enabled = gate === 'open' && seesThePage(can)
  const onGateClosed = useCallback(() => setGateShut(true), [])

  const attendance = useAttendance({ api, enabled, can, companyId, siteId, month, today, address, onNotice: setNotice, onDialog: setDialog, onGateClosed })

  // ---- the lists behind the filters and the codes ---------------------------------------------------------------------------------
  const [lines, setLines] = useState<Array<SiteLine | Ref>>([])
  const [teams, setTeams] = useState<TeamRef[]>([])
  const [codes, setCodes] = useState<AbsenceCode[]>([])
  useEffect(() => {
    if (!enabled || !can.view || !siteId) return
    const teamRead = can.people ? listTeams(api, siteId).then((answer) => answer.teams) : Promise.resolve([])
    const lineRead = can.sites ? linesFromTree(api, siteId) : can.floorLines ? linesFromFloor(api, siteId) : Promise.resolve([] as SiteLine[])
    void Promise.all([teamRead.catch(() => []), lineRead.catch(() => [] as SiteLine[])]).then(([found, known]) => {
      setTeams(found.map((team) => ({ id: team.id, code: team.code, name: team.name, lineId: team.line?.id ?? null })))
      if (known.length > 0) setLines(known)
      else {
        const seen = new Map<string, Ref>()
        for (const team of found) if (team.line) seen.set(team.line.id, team.line)
        setLines([...seen.values()])
      }
    })
    if (companyId) readAbsenceCodes(api, companyId).then(setCodes).catch(() => setCodes([]))
  }, [api, enabled, can.view, can.people, can.sites, can.floorLines, siteId, companyId])

  // ---- one person's day --------------------------------------------------------------------------------------------------------
  const day = useDayRecord({ api, dayId: enabled && can.view ? address.open : null, reasonWords, onChanged: attendance.dayChanged, onGateClosed })

  // `e` on a row: the day opens with its Fix a day (when the person may).
  const fixWhenRead = useRef(false)
  useEffect(() => {
    const state = day.state
    if (!fixWhenRead.current || state?.loaded.status !== 'ready') return
    fixWhenRead.current = false
    if (state.loaded.value.actions.fix) day.actions.onFix()
  })

  // ---- one overtime entry ------------------------------------------------------------------------------------------------------
  const entryId = enabled && can.view ? address.entry : null
  const [entryLoaded, setEntryLoaded] = useState<Loaded<EntryRecord>>({ status: 'loading' })
  const [entryBusy, setEntryBusy] = useState(false)
  const [entryProblem, setEntryProblem] = useState<EntryState['problem']>(null)
  const [entryDialog, setEntryDialog] = useState<EntryState['dialog']>(null)
  const readOne = useCallback(() => {
    if (!entryId) return
    readEntry(api, entryId)
      .then((value) => setEntryLoaded({ status: 'ready', value }))
      .catch((error: unknown) => {
        if (isGateClosed(error)) setGateShut(true)
        setEntryLoaded(isApiError(error) && error.kind === 'not_found' ? { status: 'notFound' } : isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
      })
  }, [api, entryId])
  useEffect(() => {
    setEntryLoaded({ status: 'loading' })
    setEntryProblem(null)
    setEntryDialog(null)
    readOne()
  }, [readOne])
  const entryValue = entryLoaded.status === 'ready' ? entryLoaded.value : null
  const entryTook = useCallback(
    (value: EntryRecord) => {
      setEntryLoaded({ status: 'ready', value })
      setEntryProblem(null)
      setEntryDialog(null)
      attendance.readOvertime()
      attendance.readTiles()
      attendance.readPanel()
    },
    [attendance],
  )
  const entryApprove = useCallback(
    (overrideReason?: string) => {
      if (!entryValue) return
      setEntryBusy(true)
      setEntryProblem(null)
      approveEntry(api, entryValue.id, { version: entryValue.version, ...(overrideReason ? { overrideReason } : {}) })
        .then(entryTook)
        .catch((error: unknown) => {
          if (isLimitBlocked(error) && !overrideReason) setEntryDialog({ kind: 'override', rules: limitsOf(error), reason: '', busy: false, problem: null })
          else if (entryDialog) setEntryDialog({ ...entryDialog, busy: false, problem: problemOf(error, 'entry') })
          else setEntryProblem(problemOf(error, 'entry'))
          readOne()
        })
        .finally(() => setEntryBusy(false))
    },
    [api, entryValue, entryDialog, entryTook, readOne],
  )

  // ---- live ---------------------------------------------------------------------------------------------------------------------
  const latest = useRef(attendance)
  latest.current = attendance
  const quiet = useRef<ReturnType<typeof setTimeout> | null>(null)
  const quietPanel = useRef<ReturnType<typeof setTimeout> | null>(null)
  const live = useLiveBus(
    {
      onChange: (change) => {
        const site = change.siteId ?? (typeof change.fields.siteId === 'string' ? change.fields.siteId : null)
        if (SITE_EVENTS.has(change.type) && site && site !== siteId) return
        if (SITE_EVENTS.has(change.type)) {
          latest.current.noteUpdate()
          if (!quiet.current) {
            quiet.current = setTimeout(() => {
              quiet.current = null
              setNow(Date.now())
              latest.current.readTiles()
              latest.current.readWho()
            }, 1000)
          }
        }
        if (change.type === 'overtime_entry.changed') latest.current.readOvertime()
        if (change.type === 'timesheet.changed' || change.type === 'timesheet.prepared') latest.current.readSheets()
        if (change.type === 'attendance.month_closed' || change.type === 'attendance.lul_sealed' || change.type === 'labour_day.closed' || change.type === 'attendance.day_changed') {
          if (!quietPanel.current) {
            quietPanel.current = setTimeout(() => {
              quietPanel.current = null
              latest.current.readPanel()
            }, 3000)
          }
        }
      },
      onReconnect: () => {
        void latest.current.readList(true)
        latest.current.readTiles()
        latest.current.readWho()
      },
    },
    enabled,
  )

  // ---- the address opens the pop-ups --------------------------------------------------------------------------------------------
  const manualDraft = useCallback((): ManualDraft => ({ choice: 'TIMES', employeeId: '', employeeName: '', date: today, in: '', out: '', offSite: false, codeId: '', hours: '', documentRef: '', reasonCode: '', reason: '' }), [today])
  useEffect(() => {
    if (!enabled || !can.manage) return
    if (address.isNew && dialog?.kind !== 'manual') setDialog({ kind: 'manual', draft: manualDraft(), people: null, busy: false, problem: null })
    if (address.isClose && dialog?.kind !== 'close') setDialog({ kind: 'close', typed: '', busy: false, problem: null })
    // Only the address opens them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, can.manage, address.isNew, address.isClose])
  const closeDialog = useCallback(() => {
    setDialog(null)
    if (address.isNew || address.isClose) go({ isNew: false, isClose: false })
  }, [address.isNew, address.isClose, go])

  const onExport = useCallback(() => {
    const rows = attendance.days.items
    if (!rows) return
    const teamText = (id: string | null) => teams.find((team) => team.id === id)?.code ?? ''
    const lineText = (id: string | null) => lines.find((line) => line.id === id)?.code ?? ''
    const text = csvText(
      [t('csv.date'), t('csv.team'), t('csv.line'), t('csv.planned'), t('csv.clocked'), t('csv.anomalies'), t('csv.manual'), t('csv.absence'), t('csv.status')],
      daysCsvRows(rows, { status: (status) => t(`status.${status}`), team: teamText, line: lineText, absence: (state) => t(`absence.${state}`), kinds: (row) => row.anomalies.kinds.map((kind) => t(`anomalyKind.${kind}`)).join(', '), yes: t('common.yes'), no: t('common.no') }),
    )
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }))
    link.download = `attendance-${month}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  }, [attendance.days.items, teams, lines, t, month])

  const entryState: EntryState | null = entryId ? { id: entryId, loaded: entryLoaded, busy: entryBusy, problem: entryProblem, dialog: entryDialog } : null

  const model: AttendanceModel = {
    prefix,
    can,
    address,
    month,
    today,
    now,
    scope,
    gate,
    lines,
    teams,
    codes,
    tiles: attendance.tiles,
    days: attendance.days,
    selected: attendance.selected,
    updates: attendance.updates,
    cells: attendance.cells,
    approving: attendance.approving,
    overtime: attendance.overtime,
    timesheets: attendance.timesheets,
    panel: attendance.panel,
    panelBusy: attendance.panelBusy,
    who: attendance.who,
    day: day.state,
    entry: entryState,
    dialog,
    notice,
    asOf: attendance.asOf,
    live,
    help,
  }

  const actions: AttendanceActions = {
    onMonth: (next) => go({ month: next }),
    onLine: (lineId) => go({ lineId, teamId: null }),
    onTeam: (teamId) => go({ teamId }),
    onTile: (tile) => go({ tile, status: null, anomaly: null, manual: false }),
    onStatus: (status) => go({ status, tile: null }),
    onAnomaly: (anomaly) => go({ anomaly, tile: null }),
    onManualFilter: (manual) => go({ manual, tile: null }),
    onClearFilters: () => go({ tile: null, status: null, anomaly: null, manual: false }),
    onRetryDays: () => void attendance.readList(false),
    onMoreDays: attendance.moreDays,
    onShowUpdates: attendance.showUpdates,
    onSelectDays: attendance.setSelected,
    onApproveSelected: attendance.approveSelected,
    onApproveClean: attendance.approveClean,
    onApproveFocused: attendance.approveOne,
    onFixFocused: (row) => {
      fixWhenRead.current = true
      go({ open: row.id })
    },
    onInlineCode: attendance.inlineCode,
    onOpenDay: (open) => go({ open }),
    day: day.actions,
    onOpenEntry: (entry) => go({ entry }),
    onEntryApprove: () => entryApprove(),
    onEntryReject: () => setEntryDialog({ kind: 'reject', reason: '', busy: false, problem: null }),
    onEntryReopen: () => setEntryDialog({ kind: 'reopen', reason: '', busy: false, problem: null }),
    onEntryReason: (reason) => setEntryDialog((was) => (was ? { ...was, reason, problem: null } : was)),
    onEntrySave: () => {
      if (!entryValue || !entryDialog || entryDialog.busy) return
      const reason = entryDialog.reason.trim()
      if (entryDialog.kind === 'override') {
        setEntryDialog({ ...entryDialog, busy: true })
        entryApprove(reason)
        return
      }
      setEntryDialog({ ...entryDialog, busy: true, problem: null })
      ;(entryDialog.kind === 'reject' ? rejectEntry : reopenEntry)(api, entryValue.id, { version: entryValue.version, reason })
        .then(entryTook)
        .catch((error: unknown) => setEntryDialog((was) => (was ? { ...was, busy: false, problem: problemOf(error, 'entry') } : was)))
    },
    onEntryClose: () => setEntryDialog(null),
    onRetryEntry: readOne,
    onOvertimeAll: attendance.setOvertimeAll,
    onMoreOvertime: attendance.moreOvertime,
    onRetryOvertime: attendance.readOvertime,
    onSelectEntries: attendance.setEntriesSelected,
    onBulkEntries: attendance.bulkEntries,
    onPrepare: attendance.prepare,
    onMoreTimesheets: attendance.moreSheets,
    onRetryTimesheets: attendance.readSheets,
    onSelectTimesheets: attendance.setSheetsSelected,
    onBulkTimesheets: attendance.bulkSheets,
    onRetryPanel: attendance.readPanel,
    onShowItem: (item) => {
      const target = showMeOf(item)
      if ('tile' in target) go({ tile: target.tile, status: null, anomaly: null, manual: false })
      else if ('manual' in target) go({ manual: true, tile: null, status: null, anomaly: null })
      else if ('section' in target) document.getElementById('fw-at-overtime')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      else router.push(`${prefix}${target.page}`)
      if ('tile' in target || 'manual' in target) document.getElementById('fw-at-days')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    },
    onSeal: attendance.seal,
    onCloseMonth: () => setDialog({ kind: 'close', typed: '', busy: false, problem: null }),
    onCloseTyped: (typed) => setDialog((was) => (was?.kind === 'close' ? { ...was, typed, problem: null } : was)),
    onCloseSave: () => {
      if (dialog?.kind !== 'close' || dialog.busy) return
      const { typed } = dialog
      setDialog({ ...dialog, busy: true, problem: null })
      attendance.close(
        typed,
        closeDialog,
        (words) => setDialog((was) => (was?.kind === 'close' ? { ...was, busy: false, problem: words } : was)),
      )
    },
    onRetryWho: attendance.readWho,
    onManual: () => setDialog({ kind: 'manual', draft: manualDraft(), people: null, busy: false, problem: null }),
    onManualDraft: (change) => setDialog((was) => (was?.kind === 'manual' ? { ...was, draft: { ...was.draft, ...change }, problem: null } : was)),
    onFindPerson: (text) => {
      if (!siteId || text.trim().length < 2) {
        setDialog((was) => (was?.kind === 'manual' ? { ...was, people: null } : was))
        return
      }
      listEmployees(api, { siteId, q: text, limit: 20 })
        .then((page) => setDialog((was) => (was?.kind === 'manual' ? { ...was, people: page.employees.map((row) => ({ id: row.id, name: row.name, code: row.employeeCode })) } : was)))
        .catch(() => setDialog((was) => (was?.kind === 'manual' ? { ...was, people: [] } : was)))
    },
    onManualSave: () => {
      if (dialog?.kind !== 'manual' || dialog.busy) return
      const { draft } = dialog
      setDialog({ ...dialog, busy: true, problem: null })
      addManualEntry(api, manualBodyOf(draft, reasonOf(draft, reasonWords)))
        .then((record) => {
          closeDialog()
          setNotice({ tone: 'success', words: { key: 'manual.done' } })
          void attendance.readList(true)
          attendance.readTiles()
          attendance.readPanel()
          go({ open: record.id, isNew: false })
        })
        .catch((error: unknown) => setDialog((was) => (was?.kind === 'manual' ? { ...was, busy: false, problem: problemOf(error) } : was)))
    },
    onCloseDialog: closeDialog,
    onDismissNotice: () => setNotice(null),
    onHelp: setHelp,
    onExport,
  }

  return <AttendanceView model={model} actions={actions} />
}
