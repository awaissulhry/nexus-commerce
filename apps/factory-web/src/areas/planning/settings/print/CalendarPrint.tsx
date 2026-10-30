'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { listCalendars, listLanes, listPatterns, listPlanningSites, workingTime, type PlanningSite } from '../api'
import { yearRange } from '../calendars/kinds'
import { ownCalendarOf, siteToday } from '../calendars/model'
import { readProblem } from '../model'
import { CalendarPrintView, type CalendarPrintModel, type LaneDays } from './view/CalendarPrintView'

/**
 * `/w/<company>/planning/settings/calendar-print?site=&year=` (SCR-124-print): the site's year read once — its days
 * (`GET /calendars/working-time?siteId=`), the company's calendars and patterns, and each line's and workshop's year when
 * it has a calendar of its own — drawn for paper. Opened in a new tab from Calendars & shifts.
 */
export function CalendarPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const companyId = session.company?.id ?? null
  const siteParam = params?.get('site') ?? null
  const yearParam = Number(params?.get('year'))
  const [site, setSite] = useState<PlanningSite | null>(null)
  const [load, setLoad] = useState<CalendarPrintModel['load']>({ status: 'loading' })
  const printedAt = useMemo(() => new Date().toISOString(), [])
  const year = Number.isInteger(yearParam) && yearParam >= 2000 && yearParam <= 2100 ? yearParam : Number(siteToday(site?.timeZone ?? 'Europe/Rome').slice(0, 4))

  useEffect(() => {
    let live = true
    setLoad({ status: 'loading' })
    void (async () => {
      try {
        const sites = (await listPlanningSites(api, companyId)).map((entry) => entry.site)
        const chosen = sites.find((entry) => entry.id === siteParam) ?? sites[0] ?? null
        if (!live) return
        setSite(chosen)
        if (!chosen) {
          setLoad({ status: 'error', problem: 'ps.problem.gone' })
          return
        }
        const range = yearRange(year)
        const [time, calendars, patterns, lanes] = await Promise.all([
          workingTime(api, { scope: 'SITE', id: chosen.id }, range),
          listCalendars(api, { companyId: chosen.companyId }),
          listPatterns(api, chosen.companyId),
          listLanes(api, chosen.id),
        ])
        const own = [...lanes.lines, ...lanes.workCentres].filter((lane) => ownCalendarOf(calendars, { scope: lane.kind === 'LINE' ? 'LINE' : 'WORK_CENTRE', id: lane.id }))
        const laneDays: LaneDays[] = []
        for (const lane of own) laneDays.push({ code: lane.code, name: lane.name, time: await workingTime(api, { scope: lane.kind === 'LINE' ? 'LINE' : 'WORK_CENTRE', id: lane.id }, range) })
        if (live) setLoad({ status: 'ready', time, calendars, patterns, lanes: laneDays })
      } catch (error) {
        if (live) setLoad({ status: 'error', problem: readProblem(error) })
      }
    })()
    return () => {
      live = false
    }
  }, [api, companyId, siteParam, year])

  return <CalendarPrintView model={{ prefix: companyPrefix(session.company?.code ?? ''), person: session.user.displayName, companyName: session.company?.name ?? null, site, year, printedAt, load }} />
}
