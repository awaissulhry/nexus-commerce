'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { TIME_ZONE, todayIn } from '../../_shared/model'
import { readAbsenceCodes, readEmployeeDays, readPersonMonth, readSight, type AbsenceCode, type EmployeeDays, type PersonMonth } from '../api'
import { attendanceCan, isGateClosed, monthOfDay, monthRange, readProblem, type ManualReason } from '../model'
import { useDayRecord } from '../use-day'
import { EmployeeAttendanceView, type EmployeeAttendanceModel } from './view/EmployeeAttendanceView'

/**
 * The employee's Attendance tab (design people.employees rec:Employee tab attendance): one person's month, the same as the LUL
 * calendar, inside one record; `?month=` holds the month, `?day=` the Day detail (the same window as the Attendance page). Behind
 * the ATTENDANCE gate of the person's site: the gate is read first, and shut says why and shows nothing.
 */
export function EmployeeAttendance({ employeeId, siteId }: { employeeId: string; siteId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => attendanceCan(session.permissions), [session.permissions])
  const today = todayIn(TIME_ZONE)
  const asked = params?.get('month') ?? ''
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) ? asked : monthOfDay(today)
  const dayId = params?.get('day') || null
  const companyId = session.company?.id ?? null

  const go = useCallback(
    (change: Record<string, string | null>) => {
      const next = new URLSearchParams(params?.toString() ?? '')
      for (const [name, value] of Object.entries(change)) {
        if (value) next.set(name, value)
        else next.delete(name)
      }
      router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    },
    [params, pathname, router],
  )

  const [gate, setGate] = useState<EmployeeAttendanceModel['gate']>('reading')
  const [days, setDays] = useState<EmployeeDays | null>(null)
  const [status, setStatus] = useState<PersonMonth | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [codes, setCodes] = useState<AbsenceCode[]>([])
  const onGateClosed = useCallback(() => setGate('closed'), [])

  useEffect(() => {
    if (!can.view) return
    let live = true
    readSight(api, siteId)
      .then((sight) => live && setGate(sight.open ? 'open' : 'closed'))
      .catch(() => live && setGate('failed'))
    return () => {
      live = false
    }
  }, [api, can.view, siteId])

  const read = useCallback((quiet = false) => {
    if (gate !== 'open') return
    const range = monthRange(month)
    setProblem(null)
    if (!quiet) setDays(null)
    readEmployeeDays(api, employeeId, range.from, range.to)
      .then(setDays)
      .catch((error: unknown) => (isGateClosed(error) ? setGate('closed') : setProblem(readProblem(error))))
    readPersonMonth(api, employeeId, month).then(setStatus).catch(() => setStatus(null))
  }, [api, employeeId, month, gate])
  useEffect(() => read(), [read])
  useEffect(() => {
    if (gate === 'open' && companyId) readAbsenceCodes(api, companyId).then(setCodes).catch(() => setCodes([]))
  }, [api, gate, companyId])

  const t = useMemo(() => createTranslator(locale, messagesFor(locale, ['attendance']).attendance ?? {}), [locale])
  const reasonWords = useCallback((code: ManualReason) => t(`reason.${code}`), [t])
  const day = useDayRecord({ api, dayId: gate === 'open' ? dayId : null, reasonWords, onChanged: () => read(true), onGateClosed })

  const model: EmployeeAttendanceModel = { prefix, can, gate, month, today, now: Date.now(), days, status, problem, day: day.state, codes }
  return <EmployeeAttendanceView model={model} actions={{ onMonth: (next) => go({ month: next, day: null }), onOpenDay: (id) => go({ day: id }), onRetry: () => read(), day: day.actions }} />
}
