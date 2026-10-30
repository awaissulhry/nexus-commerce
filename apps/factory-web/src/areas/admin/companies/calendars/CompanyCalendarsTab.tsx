'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLive } from '../../../_shared/buying/hooks'
import { createCalendar, editCalendar, getCalendar, listCalendars, listPatterns, loadHolidays, removeDays, setDays, workingTime, type Calendar, type CalendarDayRow, type Pattern, type WorkingTime } from '../../../planning/settings/api'
import { yearRange } from '../../../planning/settings/calendars/kinds'
import { readProblem } from '../../../planning/settings/model'
import type { Site } from '../../shared/api'
import { companyWriteProblem, conflictDates, dayIn, type CompanyCalendarsModel, type HolidayDraft, type SiteDays, type WriteOutcome } from './model'
import { CompanyCalendarsView } from './view/CompanyCalendarsView'

/** Our own write's live echo is not "someone else" (ms). */
const OWN_ECHO_MS = 6000

/**
 * The Company record's Calendars tab (SCR-008; design admin.org rec:Company/calendars/calendar): reads the company's
 * ACTIVE calendar (`GET /calendars?scope=COMPANY&companyId=`), its dated days of the shown year (`GET /calendars/:id`),
 * the year as the calendars service resolves it (`GET /calendars/working-time?companyId=`), the shift patterns, and its
 * sites' own calendars and days of that year (which dates a site opens or closes itself). Makes the company calendar,
 * saves the working week, adds and removes holidays and closures, loads the Italian public holidays, each write with
 * its own Idempotency-Key and the version read. Live `calendar.changed` of this company from someone else → Reload.
 */
export function CompanyCalendarsTab({ company, sites, prefix, canManage }: { company: { id: string; legalName: string; timezone: string; status: string }; sites: readonly Site[]; prefix: string; canManage: boolean }) {
  const api = useOfficeApi()
  const today = dayIn(company.timezone)
  const [year, setYear] = useState(Number(today.slice(0, 4)))
  const [load, setLoad] = useState<CompanyCalendarsModel['load']>({ status: 'loading' })
  const [calendar, setCalendar] = useState<Calendar | null>(null)
  const [days, setDaysState] = useState<CalendarDayRow[]>([])
  const [working, setWorking] = useState<WorkingTime | null>(null)
  const [patterns, setPatterns] = useState<Pattern[]>([])
  const [siteDays, setSiteDays] = useState<SiteDays[]>([])
  const [busy, setBusy] = useState<CompanyCalendarsModel['busy']>(null)
  const [notice, setNotice] = useState<CompanyCalendarsModel['notice']>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const ownUntil = useRef(0)
  const calendarRef = useRef<Calendar | null>(null)
  calendarRef.current = calendar
  const sitesKey = sites.map((site) => site.id).join(',')

  const read = useCallback(
    async (shown: number) => {
      const range = yearRange(shown)
      try {
        const [own, all, shifts] = await Promise.all([listCalendars(api, { companyId: company.id, scope: 'COMPANY' }), listCalendars(api, { companyId: company.id }), listPatterns(api, company.id)])
        const current = own.find((entry) => entry.status === 'ACTIVE') ?? null
        const active = sites.filter((site) => site.status === 'ACTIVE')
        const siteCalendars = all.filter((entry) => entry.scope === 'SITE' && entry.status === 'ACTIVE')
        const [detail, resolved, ...perSite] = await Promise.all([
          current ? getCalendar(api, current.id, range) : Promise.resolve(null),
          current ? workingTime(api, { scope: 'COMPANY', id: company.id }, range) : Promise.resolve(null),
          ...active.map((site) => {
            const own = siteCalendars.find((entry) => entry.siteId === site.id)
            return own ? getCalendar(api, own.id, range).then((answer) => ({ site, calendar: answer.calendar, days: answer.days })) : Promise.resolve({ site, calendar: null, days: [] as CalendarDayRow[] })
          }),
        ])
        setCalendar(detail?.calendar ?? current)
        setDaysState(detail?.days ?? [])
        setWorking(resolved)
        setPatterns(shifts)
        setSiteDays(perSite.map((entry) => ({ site: { id: entry.site.id, code: entry.site.code, name: entry.site.name }, calendar: entry.calendar ? { id: entry.calendar.id, version: entry.calendar.version } : null, days: entry.days })))
        setLoad({ status: 'ready' })
        setChangedElsewhere(false)
      } catch (error) {
        setLoad({ status: 'error', problem: readProblem(error) })
      }
    },
    // The sites' ids are the dependency (the record passes a new array on every render).
    [api, company.id, sitesKey],
  )

  useEffect(() => {
    void read(year)
  }, [read, year])

  useLive(
    (change) => {
      if (change.type !== 'calendar.changed' || change.fields.companyId !== company.id) return
      if (Date.now() < ownUntil.current) return
      setChangedElsewhere(true)
    },
    () => void read(year),
  )

  /** One write: shown busy, its own key, then the year read again (the grid, the list and the sites' column). */
  const write = async (kind: NonNullable<CompanyCalendarsModel['busy']>, work: (key: string) => Promise<{ key: string; params?: Record<string, string | number> } | null>): Promise<WriteOutcome> => {
    setBusy(kind)
    setNotice(null)
    ownUntil.current = Date.now() + OWN_ECHO_MS
    try {
      const done = await work(newIdempotencyKey())
      ownUntil.current = Date.now() + OWN_ECHO_MS
      // The year is read again first: the notice comes with the calendar as it now is.
      await read(year)
      if (done) setNotice({ tone: 'success', key: done.key, params: done.params })
      return { ok: true }
    } catch (error) {
      ownUntil.current = 0
      const problem = companyWriteProblem(error)
      const conflict = conflictDates(error)
      if (problem === 'ps.problem.conflict') {
        setNotice({ tone: 'warning', key: problem })
        void read(year)
      } else if (conflict.length === 0) setNotice({ tone: 'danger', key: problem })
      return { ok: false, problem, conflict }
    } finally {
      setBusy(null)
    }
  }

  const model: CompanyCalendarsModel = {
    prefix,
    company: { id: company.id, legalName: company.legalName, timezone: company.timezone },
    year,
    today,
    load,
    calendar,
    days,
    working,
    patterns,
    sites: siteDays,
    canManage: canManage && company.status === 'ACTIVE',
    busy,
    notice,
    changedElsewhere,
  }

  return (
    <CompanyCalendarsView
      model={model}
      actions={{
        onYear: setYear,
        onRetry: () => {
          setLoad({ status: 'loading' })
          void read(year)
        },
        onReload: () => void read(year),
        onDismissNotice: () => setNotice(null),
        onCreate: () =>
          void write('create', async (key) => {
            await createCalendar(api, { scope: 'COMPANY', ownerId: company.id }, key)
            return { key: 'acal.done.created' }
          }),
        onSaveWeek: async (weekdays) => {
          const current = calendarRef.current
          if (!current) return false
          const outcome = await write('week', async (key) => {
            await editCalendar(api, current.id, { version: current.version, workingWeekdays: weekdays }, key)
            return { key: 'acal.done.week' }
          })
          return outcome.ok
        },
        onAdd: (draft: HolidayDraft, replace: boolean) => {
          const current = calendarRef.current
          if (!current) return Promise.resolve({ ok: false, problem: 'ps.problem.gone' })
          return write('add', async (key) => {
            const answer = await setDays(api, current.id, { version: current.version, from: draft.from, ...(draft.to && draft.to !== draft.from ? { to: draft.to } : {}), kind: draft.kind, name: draft.name.trim(), ...(replace ? { replace: true } : {}) }, key)
            return { key: answer.replaced > 0 ? 'acal.done.addedReplaced' : 'acal.done.added', params: { count: answer.days.length, replaced: answer.replaced, name: draft.name.trim() } }
          })
        },
        onRemove: (row) => {
          const current = calendarRef.current
          if (!current) return
          void write('remove', async (key) => {
            const answer = await removeDays(api, current.id, { version: current.version, from: row.from, ...(row.to !== row.from ? { to: row.to } : {}) }, key)
            return { key: 'acal.done.removed', params: { count: answer.removed.length, name: row.name } }
          })
        },
        onLoad: (shown) => {
          const current = calendarRef.current
          if (!current) return
          void write('load', async (key) => {
            const answer = await loadHolidays(api, current.id, { version: current.version, year: shown }, key)
            return { key: answer.skipped.length > 0 ? 'acal.done.loadedSkipped' : 'acal.done.loaded', params: { count: answer.added.length, skipped: answer.skipped.length, year: shown } }
          })
        },
      }}
    />
  )
}
