'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { attendanceSight, getAttendance, getEarnings, type AttendanceReport, type EarningsReport } from '../api'
import { earningsRange, monthOf, reportsAddressOf, reportsCan, reportsProblem, type ReportsProblem } from '../model'
import { ReportsPrintView, type PrintRead } from './view/ReportsPrintView'

const asked = <T,>(reading: Promise<T>, set: (read: PrintRead<T>) => void, stillLive: () => boolean) =>
  reading.then(
    (value) => stillLive() && set({ value, problem: null }),
    (error: unknown) => stillLive() && set({ value: null, problem: reportsProblem(error) as ReportsProblem }),
  )

/**
 * `/w/<company>/people/reports/print?month=&to=&group=&team=&earnings=` (SCR-264 tab:pdf): the two reports for paper or a PDF, the
 * filters on top. Groups only: the earnings per worker never reaches this page.
 */
export function ReportsPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const params = useSearchParams()
  const can = useMemo(() => reportsCan(session.permissions), [session.permissions])
  const address = useMemo(() => reportsAddressOf(params), [params])
  const siteId = scope.siteId
  const companyId = session.company?.id ?? null
  const [at] = useState(() => new Date().toISOString())
  const [today] = useState(() => monthOf(new Date()))
  const month = address.month ?? today
  const [attendance, setAttendance] = useState<PrintRead<AttendanceReport>>({ value: null, problem: null })
  const [earnings, setEarnings] = useState<PrintRead<EarningsReport>>({ value: null, problem: null })

  useEffect(() => {
    if (!can.attendance || !siteId) return
    let live = true
    attendanceSight(api, siteId)
      .then((sight) => {
        if (!sight.open) return live && setAttendance({ value: null, problem: { ns: 'people-reports', words: { key: 'attendance.gateOff' } } })
        return asked(getAttendance(api, { siteId, month, groupBy: address.group, teamId: address.teamId }), setAttendance, () => live)
      })
      .catch((error: unknown) => live && setAttendance({ value: null, problem: reportsProblem(error) }))
    return () => {
      live = false
    }
  }, [api, can.attendance, siteId, month, address.group, address.teamId])

  useEffect(() => {
    if (!can.earnings || !can.pay || !companyId) return
    let live = true
    void asked(getEarnings(api, { companyId, ...earningsRange(month, address.to), siteId }), setEarnings, () => live)
    return () => {
      live = false
    }
  }, [api, can.earnings, can.pay, companyId, month, address.to, siteId])

  return <ReportsPrintView model={{ person: session.user.displayName, at, company: session.company?.name ?? '', site: scope.site?.name ?? null, month, can, address, attendance, earnings, noSite: !siteId }} />
}
