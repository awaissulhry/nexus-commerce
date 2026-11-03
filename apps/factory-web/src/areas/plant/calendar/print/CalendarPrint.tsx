'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { DEFAULT_TIME_ZONE } from '../../../../lib/i18n/format'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { readCalendar, type CalendarAnswer } from '../api'
import { calendarAddressOf, calendarCan, printWindow, readProblemOf, todayIn } from '../model'
import { CalendarPrintView } from './view/CalendarPrintView'

/**
 * `/w/<company>/plant/calendar/print?from=&to=` (SCR-267-cal-print, a new tab): the calendar for the periodic safety
 * meeting, read once with the top bar's site (GET /safety/calendar with `late`: what is still open from before the window
 * is on the paper too; safety.view). Default window: this month and the next 11.
 */
export function CalendarPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const params = useSearchParams()
  const can = useMemo(() => calendarCan(session.permissions), [session.permissions])
  const address = useMemo(() => calendarAddressOf(params), [params])
  const [at] = useState(() => new Date().toISOString())
  const [localToday] = useState(() => todayIn(DEFAULT_TIME_ZONE))
  const span = printWindow(localToday, address)
  const [calendar, setCalendar] = useState<{ value: CalendarAnswer | null; problem: string | null }>({ value: null, problem: null })
  const siteId = scope.siteId
  const { from, to } = span

  useEffect(() => {
    if (!can.view) return
    let live = true
    setCalendar({ value: null, problem: null })
    readCalendar(api, { from, to, siteId, late: true }).then(
      (value) => live && setCalendar({ value, problem: null }),
      (error: unknown) => live && setCalendar({ value: null, problem: readProblemOf(error) }),
    )
    return () => {
      live = false
    }
  }, [api, can.view, from, to, siteId])

  return <CalendarPrintView model={{ person: session.user.displayName, at, company: session.company?.name ?? '', site: scope.site?.name ?? null, allSites: scope.allSites, window: span, canView: can.view, calendar }} />
}
