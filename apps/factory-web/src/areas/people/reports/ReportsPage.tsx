'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { defaultSectionLayout, readSectionLayout, writeSectionLayout, type SectionLayoutValue } from '@nexus/ui/patterns'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useCoalesced, useLive } from '../../_shared/buying/hooks'
import { liveMatches } from '../../quality/_shared/hooks'
import { csvText } from '../_shared/model'
import { privacyFirst } from '../efficiency/model'
import { attendanceSight, getAttendance, getDay, getDifferences, getEarnings, openEarningsByWorker, type AttendanceReport, type AttendanceSight, type DayRecord, type Differences, type EarningsReport, type EarningsWorkers } from './api'
import { absenceCodes, attendanceCsvRows, earningsCsvRows, earningsRange, LAYOUT_KEY, lineRows, monthOf, monthRows, monthText, NEW_SEND, reportsAddressOf, reportsAddressText, reportsCan, reportsProblem, sectionSpecs, type ReportsAddress, type ReportsProblem, type SendDraft } from './model'
import { ReportsView, type ReportCsvWords, type ReportRead, type ReportsDialog } from './view/ReportsView'

const ATTENDANCE_LIVE = ['attendance.month_closed', 'attendance.lul_sealed', 'attendance.day_corrected']
const EARNINGS_LIVE = ['pay_period.changed']

const saveCsv = (name: string, text: string) => {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }))
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
}

/**
 * `/w/<company>/people/reports?month=&to=&group=&team=&earnings=` (SCR-264): what the page shows is said first, then the attendance
 * report of the top bar's site (behind the site's ATTENDANCE purpose) and the earnings report of the company (with the pay
 * grain). Each section reads and fails on its own. The earnings per worker is opened by a click, recorded by the API, and
 * kept in this page's state: a new month or a reload closes it, because each opening is a new record.
 */
export function ReportsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = pathname.replace(/\/people\/reports\/?$/, '')
  const can = useMemo(() => reportsCan(session.permissions), [session.permissions])
  const address = useMemo(() => reportsAddressOf(params), [params])
  const siteId = scope.siteId
  const companyId = session.company?.id ?? null
  const [today] = useState(() => monthOf(new Date()))
  const month = address.month ?? today
  const range = useMemo(() => earningsRange(month, address.to), [month, address.to])

  const [sight, setSight] = useState<ReportRead<AttendanceSight>>({ status: 'idle' })
  const [attendance, setAttendance] = useState<ReportRead<AttendanceReport>>({ status: 'idle' })
  const [earnings, setEarnings] = useState<ReportRead<EarningsReport>>({ status: 'idle' })
  const [workers, setWorkers] = useState<ReportRead<EarningsWorkers>>({ status: 'idle' })
  const [teams, setTeams] = useState<{ id: string; label: string }[]>([])
  const [dialog, setDialog] = useState<ReportsDialog | null>(null)
  const [arranging, setArranging] = useState(false)
  const [asOf, setAsOf] = useState<string | null>(null)
  const specs = useMemo(() => sectionSpecs((id) => id), [])
  const [layout, setLayout] = useState<SectionLayoutValue>(() => defaultSectionLayout(specs))
  const dayTurn = useRef(0)

  useEffect(() => setLayout(readSectionLayout(LAYOUT_KEY, specs)), [specs])

  // Said before anything is read.
  const readSight = useCallback(() => {
    if (!can.attendance || !siteId) {
      setSight({ status: 'idle' })
      return () => undefined
    }
    let live = true
    setSight({ status: 'loading' })
    attendanceSight(api, siteId)
      .then((value) => live && setSight({ status: 'ready', value }))
      .catch((error: unknown) => live && setSight({ status: 'error', problem: reportsProblem(error) }))
    return () => {
      live = false
    }
  }, [api, can.attendance, siteId])
  useEffect(() => readSight(), [readSight])

  const sightOpen = sight.status === 'ready' && sight.value.open
  const readAttendance = useCallback(async () => {
    if (!siteId || !sightOpen) return
    try {
      const value = await getAttendance(api, { siteId, month, groupBy: address.group, teamId: address.teamId })
      setAttendance({ status: 'ready', value })
      setAsOf(new Date().toISOString())
    } catch (error) {
      setAttendance({ status: 'error', problem: reportsProblem(error) })
    }
  }, [api, siteId, sightOpen, month, address.group, address.teamId])

  useEffect(() => {
    if (!sightOpen) return setAttendance({ status: 'idle' })
    setAttendance({ status: 'loading' })
    void readAttendance()
  }, [sightOpen, readAttendance])

  useEffect(() => {
    if (attendance.status !== 'ready' || attendance.value.groupBy !== 'team') return
    setTeams((current) => {
      const all = new Map(current.map((entry) => [entry.id, entry.label]))
      for (const row of attendance.value.groups) if (row.id && row.code) all.set(row.id, `${row.code} · ${row.name ?? ''}`)
      return [...all].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label))
    })
  }, [attendance])

  const readEarnings = useCallback(async () => {
    if (!companyId || !can.earnings || !can.pay) return
    try {
      const value = await getEarnings(api, { companyId, ...range, siteId })
      setEarnings({ status: 'ready', value })
      setAsOf(value.asOf)
    } catch (error) {
      setEarnings({ status: 'error', problem: reportsProblem(error) })
    }
  }, [api, can.earnings, can.pay, companyId, range, siteId])

  useEffect(() => {
    setWorkers({ status: 'idle' })
    if (!can.earnings || !can.pay) return setEarnings({ status: 'idle' })
    setEarnings({ status: 'loading' })
    void readEarnings()
  }, [can.earnings, can.pay, readEarnings])

  const refreshAttendance = useCoalesced(() => void readAttendance(), 1000)
  const refreshEarnings = useCoalesced(() => void readEarnings(), 1000)
  useLive(
    (change) => {
      if (liveMatches(change, ATTENDANCE_LIVE)) refreshAttendance()
      else if (liveMatches(change, EARNINGS_LIVE)) refreshEarnings()
    },
    () => {
      void readAttendance()
      void readEarnings()
    },
    can.attendance || can.earnings,
  )

  const go = (change: Partial<ReportsAddress>) => router.replace(`${pathname}${reportsAddressText({ ...address, ...change })}`)

  const openWorkers = () => {
    if (!companyId || !can.records) return
    setWorkers({ status: 'loading' })
    openEarningsByWorker(api, { companyId, ...range, siteId })
      .then((value) => setWorkers({ status: 'ready', value }))
      .catch((error: unknown) => setWorkers({ status: 'error', problem: reportsProblem(error) as ReportsProblem }))
  }

  const openDifferences = () => {
    if (!siteId) return
    setDialog({ kind: 'differences', read: { status: 'loading' } })
    getDifferences(api, siteId, month)
      .then((value: Differences) => setDialog((current) => (current?.kind === 'differences' ? { ...current, read: { status: 'ready', value } } : current)))
      .catch((error: unknown) => setDialog((current) => (current?.kind === 'differences' ? { ...current, read: { status: 'error', problem: reportsProblem(error) } } : current)))
  }

  const openDay = (dayId: string) => {
    const turn = ++dayTurn.current
    setDialog({ kind: 'day', read: { status: 'loading' } })
    getDay(api, dayId)
      .then((value: DayRecord) => turn === dayTurn.current && setDialog({ kind: 'day', read: { status: 'ready', value } }))
      .catch((error: unknown) => turn === dayTurn.current && setDialog({ kind: 'day', read: { status: 'error', problem: reportsProblem(error) } }))
  }

  const exportAttendance = (words: ReportCsvWords) => {
    if (attendance.status !== 'ready') return
    const report = attendance.value
    const codes = absenceCodes(report.groups)
    saveCsv(`attendance-${report.month}.csv`, csvText([...words.header, ...codes], attendanceCsvRows(report, codes, { noGroup: words.none, tooFew: words.tooFew }, locale)))
  }

  const exportEarnings = (words: ReportCsvWords) => {
    if (earnings.status !== 'ready') return
    const report = earnings.value
    const rows = address.earnings === 'month' ? monthRows(report, locale) : lineRows(report)
    saveCsv(`earnings-${report.from}-${report.to}.csv`, csvText(words.header, earningsCsvRows(rows, { noLine: words.none, tooFew: words.tooFew }, locale)))
  }

  return (
    <ReportsView
      model={{
        prefix,
        scope,
        can,
        address,
        month,
        today,
        monthWords: monthText(month, locale),
        sight,
        attendance,
        earnings,
        workers,
        teams,
        asOf,
        dialog,
        layout,
        specs,
        arranging,
      }}
      actions={{
        onAddress: go,
        onRetrySight: () => void readSight(),
        onRetryAttendance: () => {
          setAttendance({ status: 'loading' })
          void readAttendance()
        },
        onRetryEarnings: () => {
          setEarnings({ status: 'loading' })
          void readEarnings()
        },
        onWorkers: openWorkers,
        onCloseWorkers: () => setWorkers({ status: 'idle' }),
        onDifferences: openDifferences,
        onDay: openDay,
        onCloseDialog: () => setDialog(null),
        onSend: () => setDialog({ kind: 'send', draft: NEW_SEND }),
        onSendDraft: (change: Partial<SendDraft>) => setDialog((current) => (current?.kind === 'send' ? { ...current, draft: { ...current.draft, ...change } } : current)),
        onExportAttendance: exportAttendance,
        onExportEarnings: exportEarnings,
        onArrange: setArranging,
        onArranged: (order) => {
          const next = { ...layout, order: privacyFirst(order) }
          setLayout(next)
          writeSectionLayout(LAYOUT_KEY, next)
          setArranging(false)
        },
      }}
    />
  )
}
