'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { getWorkOrder } from '../_shared/api'
import { useCoalesced, useLive } from '../_shared/hooks'
import { abilitiesOf, readProblem } from '../_shared/model'
import { useProductionCustomers } from '../_shared/customer/use-customers'
import { NOTES_NS, openHeld, targetsOfRecord as noteTargetsOfRecord } from '../_shared/notes/model'
import { useNoteDialog } from '../_shared/notes/use-note-dialog'
import { WithMessages } from '../../../record-panels/i18n'
import { SUPERVISOR_NS } from '../../_shared/production-supervisor/model'
import { getOpenIssues, getOverview, type Issues, type Overview } from './api'
import { ISSUES_LIMIT, nextIssuesLimit, overviewAddress, overviewQueryOf, overviewTermsOf, overviewTouches, OVERVIEW_PATH } from './model'
import { OverviewView, type OverviewModel } from './view/OverviewView'

/**
 * `/w/<company>/production/overview` (F-PR-04; production plan §5, 06-tree A.1): Production's first page. Reads GET /production/overview
 * (B-PR-33: every customer the person reaches, walled by the API) with the page's customer filter (`?party=`, the Production pages'
 * one filter) and "Only mine" (`?supervisor=me`, carried to every Work orders door), and the open issues (B-PR-45 GET
 * /production/issues, oldest first, `mine` with Only mine). Both read again on the events the overview names (a burst is one read).
 * Most urgent's row ⋯ "Ask the supervisor" reads that work order once (its orders, customer and company) and opens THE note dialog
 * (F-PR-22) over it, as the work order band does. Nothing here adds customers up: every figure is the API's.
 */
export function OverviewPage() {
  return (
    <WithMessages namespaces={['production', NOTES_NS, SUPERVISOR_NS]}>
      <OverviewContainer />
    </WithMessages>
  )
}

function OverviewContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/production\/overview\/?$/, '')
  const search = params?.toString() ?? ''
  const terms = useMemo(() => overviewTermsOf(params), [search])
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const names = session.permissions.includes('parties.view')
  // The customer filter's options: the Work orders list's own (the same permission, workorders.view).
  const customers = useProductionCustomers('work-orders')

  const [overview, setOverview] = useState<{ value: Overview | null; problem: string | null }>({ value: null, problem: null })
  const [issues, setIssues] = useState<{ value: Issues | null; problem: string | null }>({ value: null, problem: null })
  const [issuesLimit, setIssuesLimit] = useState(ISSUES_LIMIT)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [asking, setAsking] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const readId = useRef(0)
  const issuesId = useRef(0)
  const readKey = JSON.stringify(overviewQueryOf(terms))

  const loadOverview = useCallback(() => {
    const id = ++readId.current
    setOverview((current) => ({ value: current.value, problem: null }))
    getOverview(api, overviewQueryOf(terms))
      .then((value) => {
        if (id !== readId.current) return
        setOverview({ value, problem: null })
        setAsOf(value.asOf)
        setNow(Date.now())
      })
      .catch((error: unknown) => {
        if (id === readId.current) setOverview({ value: null, problem: readProblem(error) })
      })
  }, [api, readKey])

  const loadIssues = useCallback(() => {
    const id = ++issuesId.current
    setIssues((current) => ({ value: current.value, problem: null }))
    getOpenIssues(api, { partyId: terms.party ?? undefined, mine: terms.mine, limit: issuesLimit })
      .then((value) => id === issuesId.current && setIssues({ value, problem: null }))
      .catch((error: unknown) => {
        if (id === issuesId.current) setIssues({ value: null, problem: readProblem(error) })
      })
  }, [api, readKey, issuesLimit])

  // A new filter starts the page afresh (nothing of the earlier filter stays on screen).
  useEffect(() => {
    setOverview({ value: null, problem: null })
    setIssues({ value: null, problem: null })
    setIssuesLimit(ISSUES_LIMIT)
  }, [readKey])
  useEffect(() => loadOverview(), [loadOverview])
  useEffect(() => loadIssues(), [loadIssues])

  const events = overview.value?.live.events ?? []
  const eventsRef = useRef(events)
  eventsRef.current = events
  const reread = useCoalesced(() => {
    loadOverview()
    loadIssues()
  }, 1500)
  const live = useLive(
    (change) => {
      if (overviewTouches(change, eventsRef.current)) reread()
    },
    () => {
      loadOverview()
      loadIssues()
    },
  )

  // ---- F-PR-22: THE note dialog, opened over one Most urgent work order (its orders, customer and company read first) ----
  const noteCan = session.permissions.includes('threads.post')
  const note = useNoteDialog(api, { can: noteCan, onDone: () => loadIssues() })
  const askSupervisor = useCallback(
    (workOrderId: string) => {
      if (asking || openHeld(noteCan, 1)) return
      setAsking(workOrderId)
      setNotice(null)
      getWorkOrder(api, workOrderId)
        .then((workOrder) => note.open(noteTargetsOfRecord(workOrder, names), 'band'))
        .catch((error: unknown) => setNotice(readProblem(error)))
        .finally(() => setAsking(null))
    },
    [api, asking, noteCan, names, note.open],
  )

  const model: OverviewModel = {
    prefix,
    can,
    terms,
    names,
    overview,
    issues,
    asOf,
    now,
    live,
    customers: customers.state,
    noteCan,
    asking,
    notice,
    note: note.model,
  }

  return (
    <OverviewView
      model={model}
      actions={{
        onRetry: loadOverview,
        onRetryIssues: loadIssues,
        onCustomer: customers.onPick,
        onMine: (mine) => router.replace(overviewAddress(`${prefix}${OVERVIEW_PATH}`, { ...terms, mine }), { scroll: false }),
        onMoreIssues: () => setIssuesLimit((limit) => nextIssuesLimit(limit)),
        onAsk: askSupervisor,
        onDismissNotice: () => setNotice(null),
        note: note.actions,
      }}
    />
  )
}
