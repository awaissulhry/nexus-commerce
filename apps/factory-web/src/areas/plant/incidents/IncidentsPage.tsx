'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { DEFAULT_TIME_ZONE } from '../../../lib/i18n/format'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useCoalesced, useLive } from '../_shared/hooks'
import { markSeen, readCounts, readIncidents, readMachines, readPeople, readPlaces, reportIncident, showPeople, uploadPhoto, type CountsAnswer, type IncidentRow } from './api'
import { addressOf, addressTerms, incidentOfChange, incidentsCan, INCIDENTS_PATH, listQueryOf, newReportDraft, problemOf, readProblemOf, reportBody, reportHeld, reportHeldFirst, tileActive, tileFilter, todayIn, withAddress, type IncidentsAddress } from './model'
import type { ListState, PageNotice, Read, ReportDialogState, ShowPeople } from './view-model'
import { IncidentsView } from './view/IncidentsView'

/**
 * `/w/<company>/plant/incidents` (SCR-210; B-W2b-149 on B-W2b-125's API; design plant.incidents): two reads with the top bar's
 * site — the counts (GET /safety/incidents/counts: the tiles, the critical banner, the band's chip) and the anonymised list (GET
 * /safety/incidents, 50 a page with its cursor) — each loading and failing on its own. The address holds the list's filters
 * and the Report dialog (`?new=1`). Live: an incident reported, changed, seen, an action or a filing re-reads both
 * (coalesced). "Show people" is one recorded read (POST /safety/incidents/people) of this page's incidents, kept in this
 * container's state only and dropped with a new read of the list. Report an incident: POST /safety/incidents, then each photo.
 */
export function IncidentsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/plant\/incidents\/?$/, '')
  const can = useMemo(() => incidentsCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const siteId = scope.siteId
  const companyId = session.company?.id ?? null
  const [today] = useState(() => todayIn(DEFAULT_TIME_ZONE))

  const [counts, setCounts] = useState<Read<CountsAnswer>>({ status: 'loading' })
  const [list, setList] = useState<Read<ListState>>({ status: 'loading' })
  const [listMore, setListMore] = useState(false)
  const [readAt, setReadAt] = useState<string | null>(null)
  const [people, setPeople] = useState<ShowPeople>({ state: 'hidden' })
  const [notice, setNotice] = useState<PageNotice | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [bulkBusy, setBulkBusy] = useState(false)
  const [report, setReport] = useState<ReportDialogState | null>(null)
  const turns = useRef({ counts: 0, list: 0 })
  const query = useMemo(() => listQueryOf(address, siteId), [address, siteId])

  const readCountsNow = useCallback(() => {
    if (!can.view) return Promise.resolve()
    const turn = ++turns.current.counts
    return readCounts(api, siteId).then(
      (value) => {
        if (turn === turns.current.counts) setCounts({ status: 'ready', value })
      },
      (error: unknown) => {
        if (turn === turns.current.counts) setCounts({ status: 'error', problem: readProblemOf(error) })
      },
    )
  }, [api, can.view, siteId])

  const readListNow = useCallback(() => {
    if (!can.view) return Promise.resolve()
    const turn = ++turns.current.list
    return readIncidents(api, query, null).then(
      (answer) => {
        if (turn !== turns.current.list) return
        setList({ status: 'ready', value: { rows: answer.incidents, nextCursor: answer.nextCursor, canReport: answer.canReport, now: answer.now } })
        setReadAt(new Date().toISOString())
        // A new read of the rows forgets the people shown (they were read for the rows then on screen).
        setPeople((current) => (current.state === 'shown' ? { state: 'hidden' } : current))
        setSelected((current) => current.filter((id) => answer.incidents.some((row) => row.id === id)))
      },
      (error: unknown) => {
        if (turn === turns.current.list) setList({ status: 'error', problem: readProblemOf(error) })
      },
    )
  }, [api, can.view, query])

  useEffect(() => {
    setCounts({ status: 'loading' })
    void readCountsNow()
  }, [readCountsNow])
  useEffect(() => {
    setList({ status: 'loading' })
    setPeople({ state: 'hidden' })
    void readListNow()
  }, [readListNow])

  const reread = useCoalesced(() => {
    void readCountsNow()
    void readListNow()
  }, 800)
  useLive(
    (change) => {
      if (incidentOfChange(change).moves) reread()
    },
    () => reread(),
    can.view,
  )

  const go = useCallback((change: Partial<IncidentsAddress>) => router.replace(`${pathname}${addressTerms(withAddress(address, change))}`, { scroll: false }), [router, pathname, address])

  // ---- the Report dialog: opened by the address, its pickers read once when it opens ------------------------------------------
  const heldFirst = reportHeldFirst(can, companyId)
  const reportSite = scope.siteId ?? (scope.sites.length === 1 ? scope.sites[0]!.id : null)
  useEffect(() => {
    if (!address.report || heldFirst) {
      setReport(null)
      return
    }
    setReport((current) => current ?? { draft: newReportDraft(new Date().toISOString()), places: can.plantView ? { status: 'loading' } : null, machines: null, people: can.pickPeople ? { status: 'loading' } : null, peopleQuery: '', photos: [], capturing: false, busy: false, problem: null, siteId: reportSite })
  }, [address.report, heldFirst, can.plantView, can.pickPeople, reportSite])

  const reportOpen = report !== null
  const reportSiteId = report?.siteId ?? null
  useEffect(() => {
    if (!reportOpen || !can.plantView) return
    let live = true
    readPlaces(api).then(
      (value) => live && setReport((current) => (current ? { ...current, places: { status: 'ready', value } } : current)),
      (error: unknown) => live && setReport((current) => (current ? { ...current, places: { status: 'error', problem: readProblemOf(error) } } : current)),
    )
    return () => {
      live = false
    }
  }, [api, reportOpen, can.plantView])
  useEffect(() => {
    if (!reportOpen || !can.plantView || !reportSiteId) return
    let live = true
    setReport((current) => (current ? { ...current, machines: { status: 'loading' } } : current))
    readMachines(api, reportSiteId).then(
      (value) => live && setReport((current) => (current ? { ...current, machines: { status: 'ready', value } } : current)),
      (error: unknown) => live && setReport((current) => (current ? { ...current, machines: { status: 'error', problem: readProblemOf(error) } } : current)),
    )
    return () => {
      live = false
    }
  }, [api, reportOpen, can.plantView, reportSiteId])
  const peopleQuery = report?.peopleQuery ?? ''
  useEffect(() => {
    if (!reportOpen || !can.pickPeople || !companyId) return
    let live = true
    const timer = setTimeout(() => {
      readPeople(api, companyId, peopleQuery.trim() || null).then(
        (value) => live && setReport((current) => (current ? { ...current, people: { status: 'ready', value } } : current)),
        (error: unknown) => live && setReport((current) => (current ? { ...current, people: { status: 'error', problem: readProblemOf(error) } } : current)),
      )
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [api, reportOpen, can.pickPeople, companyId, peopleQuery])

  const reportKey = useRef<string>(newIdempotencyKey())
  const sendReport = async () => {
    if (!report || report.busy || !companyId || !report.siteId) return
    if (reportHeld(report.draft, new Date())) return
    setReport({ ...report, busy: true, problem: null })
    try {
      const incident = await reportIncident(api, reportBody(report.draft, { companyId, siteId: report.siteId }), reportKey.current)
      let unsent = 0
      for (const [index, photo] of report.photos.entries()) {
        try {
          await uploadPhoto(api, incident.id, photo.marked ?? photo.photo, `photo-${index + 1}.jpg`, `${reportKey.current}.photo.${index}`)
        } catch {
          unsent += 1
        }
      }
      reportKey.current = newIdempotencyKey()
      setReport(null)
      go({ report: false })
      setNotice({ tone: unsent > 0 ? 'warning' : 'success', key: unsent > 0 ? 'notice.reportedPhotos' : 'notice.reported', params: { number: incident.number, count: unsent }, open: { id: incident.id, number: incident.number } })
      reread()
    } catch (error) {
      setReport((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  // ---- "Show people" ---------------------------------------------------------------------------------------------------------
  const rows = list.status === 'ready' ? list.value.rows : []
  const show = async () => {
    const ids = rows.slice(0, 100).map((row) => row.id)
    if (ids.length === 0) return
    setPeople({ state: 'reading' })
    try {
      const answer = await showPeople(api, ids)
      setPeople({ state: 'shown', byIncident: Object.fromEntries(answer.map((entry) => [entry.id, entry.people])), at: new Date().toISOString(), count: ids.length })
    } catch (error) {
      setPeople({ state: 'error', problem: readProblemOf(error) })
    }
  }

  // ---- Mark seen N ---------------------------------------------------------------------------------------------------------
  const bulkSeen = async (picked: readonly IncidentRow[]) => {
    if (bulkBusy || picked.length === 0) return
    setBulkBusy(true)
    setNotice(null)
    let done = 0
    const refused: { label: string; key: string }[] = []
    for (const row of picked) {
      try {
        await markSeen(api, row.id, newIdempotencyKey())
        done += 1
      } catch (error) {
        refused.push({ label: row.number, key: problemOf(error).key })
      }
    }
    setBulkBusy(false)
    setSelected([])
    setNotice({ tone: refused.length > 0 ? 'warning' : 'success', key: 'notice.seen', params: { count: done }, refused })
    reread()
  }

  const more = async () => {
    if (list.status !== 'ready' || !list.value.nextCursor || listMore) return
    setListMore(true)
    try {
      const answer = await readIncidents(api, query, list.value.nextCursor)
      setList((current) => (current.status === 'ready' ? { status: 'ready', value: { ...current.value, rows: [...current.value.rows, ...answer.incidents.filter((row) => !current.value.rows.some((seen) => seen.id === row.id))], nextCursor: answer.nextCursor } } : current))
    } catch (error) {
      setNotice({ tone: 'warning', key: readProblemOf(error) === 'problem.read' ? 'notice.moreFailed' : readProblemOf(error) })
    } finally {
      setListMore(false)
    }
  }

  return (
    <IncidentsView
      model={{
        prefix,
        can,
        scope,
        companyId,
        address,
        today,
        counts: can.view ? counts : { status: 'loading' },
        list: can.view ? list : { status: 'loading' },
        listMore,
        readAt,
        people,
        report,
        notice,
        selected,
        bulkBusy,
        reportHeld: heldFirst ?? (list.status === 'ready' && !list.value.canReport ? 'held.noReport' : null),
      }}
      actions={{
        onAddress: go,
        onTile: (tile) => {
          const filter = tileFilter(tile, today)
          if (!filter) return
          go(tileActive(tile, address, today) ? { rows: null, status: null, from: null, to: null, q: null } : { ...filter, q: null })
        },
        onRetryCounts: () => {
          setCounts({ status: 'loading' })
          void readCountsNow()
        },
        onRetryList: () => {
          setList({ status: 'loading' })
          void readListNow()
        },
        onMore: () => void more(),
        onOpen: (row) => router.push(`${prefix}${INCIDENTS_PATH}/${encodeURIComponent(row.id)}`),
        onAskPeople: () => setPeople({ state: 'confirm' }),
        onShowPeople: () => void show(),
        onHidePeople: () => setPeople({ state: 'hidden' }),
        onDismissNotice: () => setNotice(null),
        onBulkSeen: bulkSeen,
        onSelected: setSelected,
        onReportDraft: (draft) => setReport((current) => (current ? { ...current, draft, problem: null } : current)),
        onReportSite: (id) => setReport((current) => (current ? { ...current, siteId: id || null, draft: { ...current.draft, stationId: null, machineId: null } } : current)),
        onReportPeopleQuery: (q) => setReport((current) => (current ? { ...current, peopleQuery: q } : current)),
        onReportPerson: (person, key) =>
          setReport((current) => {
            if (!current) return current
            const people = key ? (person ? current.draft.people.map((entry) => (entry.key === key ? person : entry)) : current.draft.people.filter((entry) => entry.key !== key)) : person ? [...current.draft.people, person] : current.draft.people
            return { ...current, draft: { ...current.draft, people }, problem: null }
          }),
        onReportCapture: (open) => setReport((current) => (current ? { ...current, capturing: open } : current)),
        onReportPhoto: (photo) => setReport((current) => (current ? { ...current, photos: [...current.photos, photo].slice(0, 4), capturing: false } : current)),
        onReportRemovePhoto: (index) => setReport((current) => (current ? { ...current, photos: current.photos.filter((_, at) => at !== index) } : current)),
        onReportSend: () => void sendReport(),
        onReportClose: () => {
          setReport(null)
          go({ report: false })
        },
      }}
    />
  )
}
