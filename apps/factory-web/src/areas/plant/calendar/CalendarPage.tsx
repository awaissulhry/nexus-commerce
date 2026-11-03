'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { DEFAULT_TIME_ZONE } from '../../../lib/i18n/format'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useCoalesced, useLive } from '../_shared/hooks'
import { markDeadlineDone, readCalendar, readCounts, readDeadline, readNotices, readOrganisation, type CalendarAnswer, type CalendarItem, type CountsAnswer, type NoticesAnswer, type Organisation } from './api'
import { calendarAddressOf, calendarAddressText, calendarCan, doneRefusedFirst, listWindow, monthWindow, openTargetOf, pageKey, problemOf, readProblemOf, sectionsOfChange, todayIn, withAddress, type CalendarAddress, type PageSection as Section } from './model'
import { useCalendarDialogs } from './use-dialogs'
import type { PageNotice, Read } from './view-model'
import { CalendarPageView } from './view/CalendarPageView'

/**
 * `/w/<company>/plant/calendar` (SCR-267; B-W2b-120; design plant.calendar): the four reads — the tiles (GET
 * /safety/calendar/counts), the calendar of the month shown or the List's window (GET /safety/calendar), the safety
 * organisation (GET /safety/organisation) and the RLS notices (GET /safety/rls-notices) — each loads and fails on its own
 * (a failed read is said with Try again, never drawn as empty), all with the top bar's site. The address holds the view,
 * the month, the tile, the window and every dialog (`model.ts` calendarAddressOf). Live: an appointment, a notice, a
 * deadline of this page and the other pages' deadline events read the parts they move again (coalesced). Mark done N runs
 * one call per deadline, each at the version read just before. The dialogs live in `use-dialogs.ts`.
 */
export function CalendarPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/plant\/calendar\/?$/, '')
  const can = useMemo(() => calendarCan(session.permissions), [session.permissions])
  const address = useMemo(() => calendarAddressOf(params), [params])
  const siteId = scope.siteId
  const companyId = session.company?.id ?? null
  const [localToday] = useState(() => todayIn(DEFAULT_TIME_ZONE))

  const [counts, setCounts] = useState<Read<CountsAnswer>>({ status: 'loading' })
  const [calendar, setCalendar] = useState<Read<CalendarAnswer>>({ status: 'loading' })
  const [calendarReading, setCalendarReading] = useState(false)
  const [readAt, setReadAt] = useState<string | null>(null)
  const [organisation, setOrganisation] = useState<Read<Organisation>>({ status: 'loading' })
  const [notices, setNotices] = useState<Read<NoticesAnswer>>({ status: 'loading' })
  const [notice, setNotice] = useState<PageNotice | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const turns = useRef<Record<Section, number>>({ counts: 0, calendar: 0, organisation: 0, notices: 0 })

  const answeredToday = (calendar.status === 'ready' ? calendar.value.today : null) ?? (counts.status === 'ready' ? counts.value.today : null) ?? (organisation.status === 'ready' ? organisation.value.today : null)
  const today = answeredToday ?? localToday
  const month = address.month ?? today.slice(0, 7)
  // The window from the browser's day (stable): the API's day only names "today" on screen.
  const span = address.view === 'list' ? listWindow(localToday, address) : monthWindow(address.month ?? localToday.slice(0, 7))
  const late = address.view === 'list'

  /** One read of one section: the newest answer wins; a failure keeps nothing of an older answer on screen. */
  const settle = useCallback(<T,>(section: Section, set: (read: Read<T>) => void, reading: Promise<T>) => {
    const turn = ++turns.current[section]
    return reading.then(
      (value) => {
        if (turn === turns.current[section]) set({ status: 'ready', value })
      },
      (error: unknown) => {
        if (turn === turns.current[section]) set({ status: 'error', problem: readProblemOf(error) })
      },
    )
  }, [])

  const readCountsNow = useCallback(() => (can.view ? settle('counts', setCounts, readCounts(api, siteId)) : Promise.resolve()), [api, can.view, settle, siteId])
  const { from, to } = span
  const readCalendarNow = useCallback(() => {
    if (!can.view) return Promise.resolve()
    setCalendarReading(true)
    return settle('calendar', setCalendar, readCalendar(api, { from, to, siteId, late }).then((answer) => {
      setReadAt(new Date().toISOString())
      return answer
    })).finally(() => setCalendarReading(false))
  }, [api, can.view, settle, from, to, siteId, late])
  const readOrganisationNow = useCallback(() => (can.view ? settle('organisation', setOrganisation, readOrganisation(api, { siteId, ended: address.ended })) : Promise.resolve()), [api, can.view, settle, siteId, address.ended])
  const readNoticesNow = useCallback(() => (can.view ? settle('notices', setNotices, readNotices(api)) : Promise.resolve()), [api, can.view, settle])

  useEffect(() => {
    setCounts({ status: 'loading' })
    void readCountsNow()
  }, [readCountsNow])
  // A new month keeps the last items on screen while it reads ("Reading again…"); a new site or view starts afresh.
  const calendarKey = `${siteId ?? ''}|${late ? 'list' : 'month'}`
  const shownKey = useRef<string | null>(null)
  useEffect(() => {
    if (shownKey.current !== calendarKey) setCalendar({ status: 'loading' })
    shownKey.current = calendarKey
    void readCalendarNow()
  }, [readCalendarNow, calendarKey])
  useEffect(() => {
    setOrganisation({ status: 'loading' })
    void readOrganisationNow()
  }, [readOrganisationNow])
  useEffect(() => {
    setNotices({ status: 'loading' })
    void readNoticesNow()
  }, [readNoticesNow])

  const readers: Record<Section, () => Promise<void>> = { counts: readCountsNow, calendar: readCalendarNow, organisation: readOrganisationNow, notices: readNoticesNow }
  const readersRef = useRef(readers)
  readersRef.current = readers
  const dirty = useRef(new Set<Section>())
  const flush = useCoalesced(() => {
    const sections = [...dirty.current]
    dirty.current.clear()
    for (const section of sections) void readersRef.current[section]()
  }, 800)
  const reread = useCallback(
    (...sections: Section[]) => {
      for (const section of sections) dirty.current.add(section)
      flush()
    },
    [flush],
  )

  const go = useCallback((change: Partial<CalendarAddress>) => router.replace(`${pathname}${calendarAddressText(withAddress(address, change))}`, { scroll: false }), [router, pathname, address])

  const dialogs = useCalendarDialogs({
    api,
    address,
    go,
    companyId,
    siteId,
    today,
    can,
    calendar: calendar.status === 'ready' ? calendar.value : null,
    notices: notices.status === 'ready' ? notices.value.notices : [],
    appointments: organisation.status === 'ready' ? organisation.value.appointments : [],
    onChanged: reread,
    onNotice: setNotice,
  })

  useLive(
    (change) => {
      const sections = sectionsOfChange(change)
      if (sections.length === 0) return
      reread(...sections)
      dialogs.onLive(change)
    },
    () => reread('counts', 'calendar', 'organisation', 'notices'),
    can.view,
  )

  /** Mark done N: a deadline whose evidence is asked and missing stays (said); each other one at the version read now. */
  const bulkDone = async (items: readonly CalendarItem[]) => {
    if (bulkBusy) return
    setBulkBusy(true)
    setNotice(null)
    let done = 0
    const refused: { label: string; key: string }[] = []
    for (const item of items) {
      const label = item.params.title?.trim() || item.dueOn
      if (doneRefusedFirst(item)) {
        refused.push({ label, key: 'held.evidenceFirst' })
        continue
      }
      if (!item.recordId) continue
      try {
        const record = await readDeadline(api, item.recordId)
        await markDeadlineDone(api, record.deadline.id, { version: record.deadline.version }, newIdempotencyKey())
        done += 1
      } catch (error) {
        refused.push({ label, key: problemOf(error).key })
      }
    }
    setBulkBusy(false)
    setNotice({ tone: refused.length > 0 ? 'warning' : 'success', key: 'bulk.doneResult', params: { count: done }, refused })
    reread('calendar', 'counts')
  }

  return (
    <CalendarPageView
      model={{
        prefix,
        can,
        scope,
        companyId,
        address,
        today,
        month,
        counts: can.view ? counts : { status: 'loading' },
        calendar: can.view ? calendar : { status: 'loading' },
        calendarReading,
        readAt,
        organisation: can.view ? organisation : { status: 'loading' },
        notices: can.view ? notices : { status: 'loading' },
        notice,
        bulkBusy,
        ...dialogs.state,
      }}
      actions={{
        onAddress: go,
        onNavigate: (href) => router.push(`${prefix}${href}`),
        onRetryCounts: () => {
          setCounts({ status: 'loading' })
          void readCountsNow()
        },
        onRetryCalendar: () => {
          setCalendar({ status: 'loading' })
          void readCalendarNow()
        },
        onRetryOrganisation: () => {
          setOrganisation({ status: 'loading' })
          void readOrganisationNow()
        },
        onRetryNotices: () => {
          setNotices({ status: 'loading' })
          void readNoticesNow()
        },
        onDismissNotice: () => setNotice(null),
        onKept: (item) => {
          const target = openTargetOf(item, OFFICE_PAGES)
          if (target.kind === 'kept') setNotice({ tone: 'info', key: 'kept.notice', sub: { page: pageKey(target.page) } })
        },
        onBulkDone: bulkDone,
        ...dialogs.actions,
      }}
    />
  )
}
