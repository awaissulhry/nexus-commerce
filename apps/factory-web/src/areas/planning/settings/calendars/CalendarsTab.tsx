'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLive } from '../../../_shared/buying/hooks'
import {
  archiveCalendar,
  archivePattern,
  capacityCell,
  capacityOver,
  createCalendar,
  createPattern,
  editCalendar,
  editPattern,
  getCalendar,
  listCalendars,
  listLanes,
  listPatterns,
  removeDays,
  saveSegments,
  setDays,
  workingTime,
  type Calendar,
  type OwnerRef,
  type Pattern,
  type SiteLanes,
} from '../api'
import { readProblem, writeProblem, type TabHost } from '../model'
import { weekBaseOf, yearRange } from './kinds'
import {
  chainAbove,
  chosenOwner,
  dayPlanOf,
  freeSpans,
  lanesReached,
  ownCalendarOf,
  ownerKey,
  ownerOfCalendar,
  ownerOfKey,
  NEW_PATTERN,
  ownersOf,
  patternDraftOf,
  patternRefusalRow,
  rowsOfPattern,
  segmentsOfRows,
  siteToday,
  takenDates,
  type ClosureDraft,
  type DayDraft,
  type PatternDraft,
  type WeekDraft,
} from './model'
import { CalendarsView, type CalendarsModel, type ClosureImpact, type Notice } from './view/CalendarsView'

interface Base {
  calendars: Calendar[]
  lanes: SiteLanes
  patterns: Pattern[]
}

/** A write's refusal in words: a company calendar or pattern reaches every site (a site-limited planner is refused). */
function refusalKey(error: unknown, wholeCompany: boolean): string {
  if (isApiError(error) && error.kind === 'forbidden' && wholeCompany) return 'cal.problem.wholeCompany'
  return writeProblem(error).key
}

/**
 * Planning settings › Calendars & shifts (SCR-124): reads the company's calendars (`GET /calendars?companyId=`), the
 * site's lines and workshops (`GET /planning/lanes`) and the shift patterns, then the shown owner's year (`GET
 * /calendars/working-time` + its own calendar's days). Keeps a day's exception, a closure over several calendars (one
 * POST …/days per calendar; an owner without a calendar gets one first; a 409 names the days already set → keep them or
 * replace them), the owner's week and pattern, making or dropping its own calendar, and the shift patterns — each
 * write with its own Idempotency-Key and the version read. The closure's "lanes and work orders affected" come from the
 * capacity service for those days. Live `calendar.changed` / `calendar.shift_pattern_changed` of the company from
 * someone else → "Changed by someone else · Reload". Address: `?owner=SCOPE:id` (or `?cal=` a calendar), `?month=`,
 * `?view=year`, `?pattern=<id>|new`.
 */
export function CalendarsTab({ host }: { host: TabHost }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const { site, can } = host
  const companyId = site.companyId
  const today = useMemo(() => siteToday(site.timeZone), [site.timeZone])
  const monthParam = host.param('month')
  const month = monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : today.slice(0, 7)
  const view = host.param('view') === 'year' ? 'year' : 'month'
  const wantedKey = host.param('owner')
  const calParam = host.param('cal')
  const patternParam = host.param('pattern')

  const [load, setLoad] = useState<CalendarsModel['load']>({ status: 'loading' })
  const [base, setBase] = useState<Base | null>(null)
  const [year, setYear] = useState<CalendarsModel['year']>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [dayProblem, setDayProblem] = useState<string | null>(null)
  const [closureTaken, setClosureTaken] = useState<string[]>([])
  const [closureProblem, setClosureProblem] = useState<string | null>(null)
  const [impact, setImpact] = useState<ClosureImpact | null>(null)
  const [patternProblem, setPatternProblem] = useState<CalendarsModel['patternProblem']>(null)
  const ownUntil = useRef(0)
  const baseRef = useRef<Base | null>(null)
  baseRef.current = base

  const readBase = useCallback(async () => {
    if (!can.calendars) return
    try {
      const [calendars, lanes, patterns] = await Promise.all([listCalendars(api, { companyId }), listLanes(api, site.id), listPatterns(api, companyId)])
      setBase({ calendars: calendars.filter((calendar) => calendar.scope !== 'SUPPLIER'), lanes, patterns })
      setLoad({ status: 'ready' })
      setChangedElsewhere(false)
    } catch (error) {
      setLoad({ status: 'error', problem: readProblem(error) })
    }
  }, [api, can.calendars, companyId, site.id])
  useEffect(() => {
    void readBase()
  }, [readBase])

  const options = useMemo(() => (base ? ownersOf(site, session.company?.name ?? null, base.lanes, base.calendars) : []), [base, site, session.company?.name])
  const wanted: OwnerRef | null = ownerOfKey(wantedKey) ?? (base ? ownerOfCalendar(base.calendars, calParam) : null)
  const owner = options.length > 0 ? chosenOwner(options, wanted) : null
  const ownerRef: OwnerRef | null = owner ? { scope: owner.scope, id: owner.id } : null
  const yearNumber = Number(month.slice(0, 4))
  const ownId = owner?.calendar?.id ?? null

  const readYear = useCallback(async () => {
    if (!ownerRef) return
    try {
      const range = yearRange(yearNumber)
      const [time, own] = await Promise.all([workingTime(api, ownerRef, range), ownId ? getCalendar(api, ownId, range) : Promise.resolve(null)])
      setYear({ status: 'ready', time, own })
    } catch (error) {
      setYear({ status: 'error', problem: readProblem(error) })
    }
    // The owner's key and its own calendar decide what is read.
  }, [api, ownerRef?.scope, ownerRef?.id, ownId, yearNumber]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setYear({ status: 'loading' })
    void readYear()
  }, [readYear])

  useLive(
    (change) => {
      if (change.type !== 'calendar.changed' && change.type !== 'calendar.shift_pattern_changed') return
      if (change.fields.companyId && change.fields.companyId !== companyId) return
      if (Date.now() < ownUntil.current) return
      setChangedElsewhere(true)
    },
    () => {
      void readBase()
      void readYear()
    },
    can.calendars,
  )

  const mine = () => {
    ownUntil.current = Date.now() + 6000
  }
  const saved = () => {
    mine()
    host.onStatus({ kind: 'saved', at: new Date().toISOString() })
  }
  const putCalendar = (calendar: Calendar) =>
    setBase((current) => (current ? { ...current, calendars: [...current.calendars.filter((entry) => entry.id !== calendar.id), calendar] } : current))

  /** The owner's own calendar, made first when it has none (its week from the calendar above, else Monday to Friday). */
  const ensureOwn = async (target: OwnerRef): Promise<Calendar> => {
    const current = baseRef.current
    const found = current ? ownCalendarOf(current.calendars, target) : null
    if (found) return found
    const week = weekBaseOf(current ? chainAbove(current.calendars, target, site) : [], current?.patterns ?? [])
    const made = await createCalendar(api, { scope: target.scope, ownerId: target.id, workingWeekdays: [...week.weekdays] }, newIdempotencyKey())
    mine()
    putCalendar(made)
    return made
  }

  const run = async <V,>(work: () => Promise<V>): Promise<V> => {
    setBusy(true)
    host.onStatus({ kind: 'saving' })
    try {
      return await work()
    } finally {
      setBusy(false)
    }
  }

  const reached = (keys: readonly string[]) => {
    const lanes = baseRef.current?.lanes ?? null
    const out = new Map<string, ReturnType<typeof lanesReached>[number]>()
    for (const key of keys) {
      const ref = ownerOfKey(key)
      if (!ref || (ref.scope === 'SITE' && ref.id !== site.id)) continue
      for (const lane of lanesReached(ref, lanes)) out.set(`${lane.kind}:${lane.id}`, lane)
    }
    return [...out.values()]
  }

  // The closure's reach: what is booked on the lanes in those days (the capacity service), at most one read per lane.
  const impactTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const impactFor = (draft: ClosureDraft) => {
    if (impactTimer.current) clearTimeout(impactTimer.current)
    if (!draft.from || !draft.to || draft.to < draft.from || draft.targets.length === 0) {
      setImpact({ status: 'idle', lanes: [], otherSites: [] })
      return
    }
    const otherSites = host.sites.filter((entry) => entry.id !== site.id && draft.targets.includes(`SITE:${entry.id}`)).map((entry) => `${entry.code} · ${entry.name}`)
    const lanes = reached(draft.targets)
    setImpact({ status: 'loading', lanes: [], otherSites })
    impactTimer.current = setTimeout(() => {
      void (async () => {
        try {
          const over = lanes.length > 0 ? await capacityOver(api, { siteId: site.id, from: draft.from, to: draft.to }) : []
          const rows: ClosureImpact['lanes'] = []
          for (const lane of lanes.slice(0, 20)) {
            const found = over.find((entry) => entry.kind === lane.kind && entry.id === lane.id)
            const booked = Number(found?.overall.bookedMinutes ?? 0)
            let workOrders = 0
            if (booked > 0) {
              const cell = await capacityCell(api, { siteId: site.id, laneKind: lane.kind, laneId: lane.id, from: draft.from, to: draft.to })
              workOrders = new Set(cell.orders.map((order) => order.workOrder.id)).size
            }
            rows.push({ ...lane, bookedMinutes: booked, workOrders })
          }
          setImpact({ status: 'ready', lanes: rows, otherSites })
        } catch {
          setImpact({ status: 'error', lanes: [], otherSites })
        }
      })()
    }, 350)
  }

  // `?pattern=<id>|new` (a record link, the palette) opens the pattern editor once the patterns are read.
  const patterns = base?.patterns
  const openPattern = useMemo<CalendarsModel['dialog']>(() => {
    if (!patternParam || !patterns) return null
    if (patternParam === 'new') return { kind: 'pattern', draft: { ...NEW_PATTERN, rows: NEW_PATTERN.rows.map((row) => ({ ...row })) } }
    const pattern = patterns.find((entry) => entry.id === patternParam)
    return pattern ? { kind: 'pattern', draft: patternDraftOf(pattern) } : null
  }, [patternParam, patterns])

  const model: CalendarsModel = {
    prefix: host.prefix,
    site,
    companyName: session.company?.name ?? null,
    otherSites: host.sites.filter((entry) => entry.id !== site.id),
    can,
    today,
    load,
    calendars: base?.calendars ?? [],
    lanes: base?.lanes ?? null,
    patterns: base?.patterns ?? [],
    owner: ownerRef,
    view,
    month,
    year,
    busy,
    notice,
    changedElsewhere,
    dialog: openPattern,
    dayProblem,
    closureTaken,
    closureProblem,
    impact,
    patternProblem,
  }

  return (
    <CalendarsView
      model={model}
      actions={{
        onOwner: (key) => host.setParams({ owner: key, cal: null }),
        onMonth: (next) => host.setParams({ month: next }),
        onView: (next) => host.setParams({ view: next === 'year' ? 'year' : null }),
        onRetry: () => {
          setLoad({ status: 'loading' })
          void readBase()
          void readYear()
        },
        onReload: () => {
          void readBase()
          void readYear()
        },
        onDismissNotice: () => setNotice(null),
        onDialog: (dialog) => {
          setDayProblem(null)
          setClosureProblem(null)
          setClosureTaken([])
          setPatternProblem(null)
          if (dialog?.kind === 'closure') impactFor(dialog.draft)
          if (!dialog && patternParam) host.setParams({ pattern: null })
        },
        onSaveDay: async (date: string, draft: DayDraft) => {
          if (!ownerRef || year.status !== 'ready') return false
          const own = year.own?.days.find((day) => day.date === date) ?? null
          const plan = dayPlanOf(date, draft, own)
          if (plan.action === 'none') return true
          setDayProblem(null)
          try {
            await run(async () => {
              if (plan.action === 'remove') {
                const calendar = owner!.calendar!
                const answer = await removeDays(api, calendar.id, { version: calendar.version, from: date }, newIdempotencyKey())
                putCalendar(answer.calendar)
              } else {
                const calendar = await ensureOwn(ownerRef)
                const answer = await setDays(api, calendar.id, { ...plan.body, version: calendar.version }, newIdempotencyKey())
                putCalendar(answer.calendar)
              }
            })
            saved()
            // The days are read again first: the notice comes with the calendar as it now is.
            await readYear()
            setNotice({ tone: 'success', key: plan.action === 'remove' ? 'cal.notice.dayRemoved' : 'cal.notice.daySaved', params: { lanes: reached([ownerKey(ownerRef)]).map((lane) => lane.name).join(' · ') || '—' } })
            return true
          } catch (error) {
            host.onStatus({ kind: 'failed', count: 1 })
            setDayProblem(refusalKey(error, ownerRef.scope === 'COMPANY'))
            if (isApiError(error) && error.kind === 'conflict') void readBase()
            return false
          }
        },
        onClosureImpact: impactFor,
        onAddClosure: async (draft: ClosureDraft) => {
          setClosureProblem(null)
          const done: string[] = []
          const refused: { label: string; key: string }[] = []
          let taken: string[] = []
          await run(async () => {
            for (const key of draft.targets) {
              const target = ownerOfKey(key)
              if (!target) continue
              const label = labelOf(key)
              try {
                const calendar = await ensureOwn(target)
                const spans = draft.takenChoice === 'keep' ? freeSpans(draft.from, draft.to, draft.taken ?? []) : [{ from: draft.from, to: draft.to }]
                let version = calendar.version
                for (const span of spans) {
                  const answer = await setDays(api, calendar.id, { version, from: span.from, to: span.to, kind: 'CLOSURE', name: draft.reason.trim(), replace: draft.takenChoice === 'replace' }, newIdempotencyKey())
                  version = answer.calendar.version
                  putCalendar(answer.calendar)
                }
                done.push(label)
              } catch (error) {
                const dates = takenDates(error)
                if (dates.length > 0) taken = [...new Set([...taken, ...dates])].sort()
                else refused.push({ label, key: refusalKey(error, target.scope === 'COMPANY') })
              }
            }
          })
          mine()
          if (taken.length > 0) {
            setClosureTaken(taken)
            host.onStatus({ kind: 'failed', count: 1 })
            return false
          }
          if (done.length > 0) saved()
          void readBase()
          await readYear()
          if (refused.length > 0) {
            host.onStatus({ kind: 'failed', count: refused.length })
            setNotice({ tone: 'warning', key: 'cal.notice.closurePartly', params: { done: done.join(', ') || '—', refused: refused.map((entry) => entry.label).join(', '), count: refused.length } })
            setClosureProblem(refused[0]!.key)
          } else {
            setNotice({ tone: 'success', key: 'cal.notice.closureAdded', params: { where: done.join(', '), lanes: reached(draft.targets).map((lane) => lane.name).join(' · ') || '—' } })
          }
          return refused.length === 0
        },
        onSaveWeek: async (draft: WeekDraft) => {
          const calendar = owner?.calendar
          if (!calendar || !ownerRef) return false
          try {
            const next = await run(() => editCalendar(api, calendar.id, { version: calendar.version, workingWeekdays: draft.weekdays, shiftPatternId: draft.patternId || null }, newIdempotencyKey()))
            putCalendar(next)
            saved()
            await readYear()
            setNotice({ tone: 'success', key: 'cal.notice.weekSaved', params: { lanes: reached([ownerKey(ownerRef)]).map((lane) => lane.name).join(' · ') || '—' } })
            return true
          } catch (error) {
            host.onStatus({ kind: 'failed', count: 1 })
            setNotice({ tone: 'danger', key: refusalKey(error, ownerRef.scope === 'COMPANY') })
            if (isApiError(error) && error.kind === 'conflict') void readBase()
            return false
          }
        },
        onMakeOwn: async () => {
          if (!ownerRef) return false
          try {
            await run(() => ensureOwn(ownerRef))
            saved()
            setNotice({ tone: 'success', key: 'cal.notice.made', params: { name: owner?.name ?? '' } })
            return true
          } catch (error) {
            host.onStatus({ kind: 'failed', count: 1 })
            setNotice({ tone: 'danger', key: refusalKey(error, ownerRef.scope === 'COMPANY') })
            return false
          }
        },
        onFollowAbove: async () => {
          const calendar = owner?.calendar
          if (!calendar) return false
          try {
            const next = await run(() => archiveCalendar(api, calendar.id, { version: calendar.version }, newIdempotencyKey()))
            putCalendar(next)
            saved()
            setNotice({ tone: 'success', key: 'cal.notice.follows', params: { name: owner?.name ?? '' } })
            return true
          } catch (error) {
            host.onStatus({ kind: 'failed', count: 1 })
            setNotice({ tone: 'danger', key: writeProblem(error).key })
            return false
          }
        },
        onSavePattern: async (draft: PatternDraft) => {
          setPatternProblem(null)
          const { segments, rowOf } = segmentsOfRows(draft.rows)
          try {
            await run(async () => {
              if (draft.id === null) {
                await createPattern(api, { companyId: draft.everyCompany ? null : companyId, code: draft.code.trim().toUpperCase(), name: draft.name.trim(), description: draft.description.trim() || null, segments }, newIdempotencyKey())
                return
              }
              const before = baseRef.current?.patterns.find((pattern) => pattern.id === draft.id)
              let version = draft.version ?? before?.version ?? 1
              if (before && (before.name !== draft.name.trim() || (before.description ?? '') !== draft.description.trim())) {
                version = (await editPattern(api, draft.id, { version, name: draft.name.trim(), description: draft.description.trim() || null }, newIdempotencyKey())).version
              }
              const was = before ? JSON.stringify(segmentsOfRows(rowsOfPattern(before)).segments) : ''
              if (JSON.stringify(segments) !== was) await saveSegments(api, draft.id, { version, segments }, newIdempotencyKey())
            })
            saved()
            setNotice({ tone: 'success', key: draft.id ? 'cal.notice.patternSaved' : 'cal.notice.patternMade', params: { code: draft.code.trim().toUpperCase() } })
            if (patternParam) host.setParams({ pattern: null })
            await readBase()
            void readYear()
            return true
          } catch (error) {
            host.onStatus({ kind: 'failed', count: 1 })
            const problem = writeProblem(error)
            setPatternProblem({ key: isApiError(error) && error.kind === 'forbidden' ? 'cal.problem.wholeCompany' : problem.key === 'ps.problem.invalid' ? 'cal.pattern.problem.segment' : problem.key, row: patternRefusalRow(error, rowOf) })
            return false
          }
        },
        onArchivePatterns: async (ids: readonly string[]) => {
          let done = 0
          let refused = 0
          await run(async () => {
            for (const id of ids) {
              const pattern = baseRef.current?.patterns.find((entry) => entry.id === id)
              if (!pattern) continue
              try {
                await archivePattern(api, id, { version: pattern.version }, newIdempotencyKey())
                done += 1
              } catch {
                refused += 1
              }
            }
          })
          saved()
          setNotice({ tone: refused > 0 ? 'warning' : 'success', key: 'cal.notice.patternsArchived', params: { count: done, refused } })
          await readBase()
        },
      }}
    />
  )

  function labelOf(key: string): string {
    const option = options.find((entry) => entry.key === key)
    if (option) return option.scope === 'COMPANY' ? option.name : `${option.code} · ${option.name}`
    const other = host.sites.find((entry) => `SITE:${entry.id}` === key)
    return other ? `${other.code} · ${other.name}` : key
  }
}
