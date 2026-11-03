'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { DEFAULT_TIME_ZONE } from '../../../lib/i18n/format'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useCoalesced, useLive } from '../_shared/hooks'
import { readCalendar, readCounts, readPlans, readResults, reportAddress, type CalendarAnswer, type CheckPlan, type CheckResult, type CountsAnswer } from './api'
import { listWindow, monthWindow, preventiveAddressOf, preventiveAddressText, preventiveCan, readProblemOf, sectionsOfChange, todayIn, withAddress, type PageSection, type PreventiveAddress } from './model'
import { usePreventiveDialogs } from './use-dialogs'
import type { PageNotice, Paged, Read } from './view-model'
import { PreventivePageView } from './view/PreventivePageView'

/**
 * `/w/<company>/plant/preventive` (SCR-266; B-W2b-142 on B-W2b-124's API; design plant.preventive): the four reads — the
 * tiles (GET /plant/checks/counts), the calendar of the month shown or the List's window (GET /plant/checks/calendar), the
 * plans (GET /plant/checks/plans, page by page) and the check register (GET /plant/checks/results, page by page) — each
 * loads and fails on its own (a failed read is said with Try again, never drawn as empty), all with the top bar's site.
 * The address holds the view, the month, the filters and every dialog (`model.ts` preventiveAddressOf). Live: a plan, a
 * result, a reminder, a type, a job of a check, a lock read the parts they move again (coalesced). The dialogs live in
 * `use-dialogs.ts`.
 */
export function PreventivePage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/plant\/preventive\/?$/, '')
  const can = useMemo(() => preventiveCan(session.permissions), [session.permissions])
  const address = useMemo(() => preventiveAddressOf(params), [params])
  const siteId = scope.siteId
  const [localToday] = useState(() => todayIn(DEFAULT_TIME_ZONE))

  const [counts, setCounts] = useState<Read<CountsAnswer>>({ status: 'loading' })
  const [calendar, setCalendar] = useState<Read<CalendarAnswer>>({ status: 'loading' })
  const [calendarReading, setCalendarReading] = useState(false)
  const [plans, setPlans] = useState<Read<Paged<CheckPlan>>>({ status: 'loading' })
  const [plansMore, setPlansMore] = useState(false)
  const [register, setRegister] = useState<Read<Paged<CheckResult>>>({ status: 'loading' })
  const [registerMore, setRegisterMore] = useState(false)
  const [readAt, setReadAt] = useState<string | null>(null)
  const [notice, setNotice] = useState<PageNotice | null>(null)
  const turns = useRef<Record<PageSection, number>>({ counts: 0, calendar: 0, plans: 0, register: 0 })

  const today = (calendar.status === 'ready' ? calendar.value.today : null) ?? (counts.status === 'ready' ? counts.value.today : null) ?? localToday
  const month = address.month ?? today.slice(0, 7)
  // The window from the browser's day (stable): the API's day only names "today" on screen.
  const span = address.view === 'list' ? listWindow(localToday) : monthWindow(address.month ?? localToday.slice(0, 7))

  /** One read of one section: the newest answer wins; a failure keeps nothing of an older answer on screen. */
  const settle = useCallback(<T,>(section: PageSection, set: (read: Read<T>) => void, reading: Promise<T>) => {
    const turn = ++turns.current[section]
    return reading.then(
      (value) => {
        if (turn !== turns.current[section]) return
        set({ status: 'ready', value })
        setReadAt(new Date().toISOString())
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
    return settle('calendar', setCalendar, readCalendar(api, { from, to, siteId })).finally(() => setCalendarReading(false))
  }, [api, can.view, settle, from, to, siteId])
  const plansQuery = useMemo(() => ({ siteId, status: address.ended ? ('ENDED' as const) : ('ACTIVE' as const), due: address.ended ? null : address.due }), [siteId, address.ended, address.due])
  const readPlansNow = useCallback(
    () => (can.view ? settle('plans', setPlans, readPlans(api, plansQuery).then((answer): Paged<CheckPlan> => ({ rows: answer.plans, next: answer.nextCursor, more: false }))) : Promise.resolve()),
    [api, can.view, settle, plansQuery],
  )
  const registerQuery = useMemo(() => ({ siteId, outcome: address.outcome, reportMissing: address.missing }), [siteId, address.outcome, address.missing])
  const readRegisterNow = useCallback(
    () => (can.view ? settle('register', setRegister, readResults(api, registerQuery).then((answer): Paged<CheckResult> => ({ rows: answer.results, next: answer.nextCursor, more: false }))) : Promise.resolve()),
    [api, can.view, settle, registerQuery],
  )

  useEffect(() => {
    setCounts({ status: 'loading' })
    void readCountsNow()
  }, [readCountsNow])
  // A new month keeps the last chips on screen while it reads; a new site or view starts afresh.
  const calendarKey = `${siteId ?? ''}|${address.view}`
  const shownKey = useRef<string | null>(null)
  useEffect(() => {
    if (shownKey.current !== calendarKey) setCalendar({ status: 'loading' })
    shownKey.current = calendarKey
    void readCalendarNow()
  }, [readCalendarNow, calendarKey])
  useEffect(() => {
    setPlans({ status: 'loading' })
    void readPlansNow()
  }, [readPlansNow])
  useEffect(() => {
    setRegister({ status: 'loading' })
    void readRegisterNow()
  }, [readRegisterNow])

  /** "Show more": the next page joins the rows (a read again starts from the first page). */
  const morePlans = () => {
    if (plans.status !== 'ready' || !plans.value.next || plansMore) return
    const current = plans.value
    const turn = turns.current.plans
    setPlansMore(true)
    readPlans(api, { ...plansQuery, cursor: current.next }).then(
      (answer) => {
        if (turn === turns.current.plans) setPlans({ status: 'ready', value: { rows: [...current.rows, ...answer.plans.filter((plan) => !current.rows.some((row) => row.id === plan.id))], next: answer.nextCursor, more: true } })
      },
      () => setNotice({ tone: 'warning', key: 'problem.more' }),
    ).finally(() => setPlansMore(false))
  }
  const moreRegister = () => {
    if (register.status !== 'ready' || !register.value.next || registerMore) return
    const current = register.value
    const turn = turns.current.register
    setRegisterMore(true)
    readResults(api, { ...registerQuery, cursor: current.next }).then(
      (answer) => {
        if (turn === turns.current.register) setRegister({ status: 'ready', value: { rows: [...current.rows, ...answer.results.filter((result) => !current.rows.some((row) => row.id === result.id))], next: answer.nextCursor, more: true } })
      },
      () => setNotice({ tone: 'warning', key: 'problem.more' }),
    ).finally(() => setRegisterMore(false))
  }

  const readers: Record<PageSection, () => Promise<void>> = { counts: readCountsNow, calendar: readCalendarNow, plans: readPlansNow, register: readRegisterNow }
  const readersRef = useRef(readers)
  readersRef.current = readers
  const dirty = useRef(new Set<PageSection>())
  const flush = useCoalesced(() => {
    const sections = [...dirty.current]
    dirty.current.clear()
    for (const section of sections) void readersRef.current[section]()
  }, 800)
  const reread = useCallback(
    (...sections: PageSection[]) => {
      for (const section of sections) dirty.current.add(section)
      flush()
    },
    [flush],
  )

  const go = useCallback((change: Partial<PreventiveAddress>) => router.replace(`${pathname}${preventiveAddressText(withAddress(address, change))}`, { scroll: false }), [router, pathname, address])

  const openReport = useCallback(
    (resultId: string, fileId: string) => {
      reportAddress(api, resultId, fileId).then(
        (url) => window.open(url, '_blank', 'noopener'),
        () => setNotice({ tone: 'danger', key: 'problem.file' }),
      )
    },
    [api],
  )

  const dialogs = usePreventiveDialogs({
    api,
    address,
    go,
    siteId,
    today,
    can,
    plans: plans.status === 'ready' ? plans.value.rows : [],
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
    () => reread('counts', 'calendar', 'plans', 'register'),
    can.view,
  )

  return (
    <PreventivePageView
      model={{
        prefix,
        path: pathname,
        can,
        scope,
        address,
        today,
        month,
        counts: can.view ? counts : { status: 'loading' },
        calendar: can.view ? calendar : { status: 'loading' },
        calendarReading,
        plans: can.view ? plans : { status: 'loading' },
        plansMore,
        register: can.view ? register : { status: 'loading' },
        registerMore,
        readAt,
        notice,
        ...dialogs.state,
      }}
      actions={{
        onAddress: go,
        onRetryCounts: () => {
          setCounts({ status: 'loading' })
          void readCountsNow()
        },
        onRetryCalendar: () => {
          setCalendar({ status: 'loading' })
          void readCalendarNow()
        },
        onRetryPlans: () => {
          setPlans({ status: 'loading' })
          void readPlansNow()
        },
        onRetryRegister: () => {
          setRegister({ status: 'loading' })
          void readRegisterNow()
        },
        onMorePlans: morePlans,
        onMoreRegister: moreRegister,
        onDismissNotice: () => setNotice(null),
        onOpenReport: openReport,
        ...dialogs.actions,
      }}
    />
  )
}
