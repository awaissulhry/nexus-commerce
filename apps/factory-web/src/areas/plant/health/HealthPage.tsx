'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { DEFAULT_TIME_ZONE, formatDate } from '../../../lib/i18n/format'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useCoalesced, useLive } from '../_shared/hooks'
import {
  bookVisits,
  editPlan,
  listJudgements,
  listVisits,
  moveVisit,
  openJudgement,
  openVisit,
  planVisits as sendPlanVisits,
  readDoctors,
  readFrame,
  readPeople,
  readPlans,
  readProposals,
  readViews,
  recordJudgement,
  showJudgements,
  uploadCopy,
  voidJudgement,
  type HealthFrame,
  type HealthPlan,
  type PickedPerson,
  type VisitRow,
} from './api'
import {
  addressOf,
  addressTerms,
  bookBody,
  bookHeld,
  healthCan,
  healthOfChange,
  judgementBody,
  judgementFilterOf,
  judgementHeld,
  moveHeld,
  newBookDraft,
  newJudgementDraft,
  pageMode,
  planBody,
  planDraftOf,
  planHeld,
  planItemsOf,
  planVisitsHeld,
  problemOf,
  proposalKey,
  readProblemOf,
  todayIn,
  visitQueryOf,
  voidHeld,
  withAddress,
  type HealthAddress,
} from './model'
import type { BookDialogState, DueState, JudgementDialogState, JudgementsState, JudgementWindowState, PageNotice, PlanDialogState, PlanVisitsState, Read, Shown, VisitWindowState, WhoLookedState } from './view-model'
import { HealthView } from './view/HealthView'

/** Own writes echo back as live events: for this long they do not count as "updates" (the page re-read already). */
const QUIET_MS = 4000

/**
 * `/w/<company>/plant/health` (SCR-212; B-W2b-148 on B-W2b-135's API; design plant.health). The protected page reads its note
 * FIRST — GET /safety/health (the privacy words, live use, the tiles as counts: nothing recorded) — and only once it is on
 * screen the due list (POST …/visits/list: names, so every read is a recorded LIST view), the anonymised judgements and the plans
 * per role (no person). Live changes re-read the counts and the plans by themselves and wait behind "N updates · Show" for the two
 * lists (a re-read of the due list is a recorded view: the person asks for it). Names and values live in this container's state
 * only: never the address (ids and filters only), browser storage, a saved view or an export. The address opens Record a
 * judgement (`?judge=1|<visit>`), Plan visits (`?planVisits=1`), a visit (`?visit=`), a judgement (`?judgement=`) and a role's
 * plan (`?plan=`); Mark booked and Show open from the chosen rows. The safety officer (the plans) and the data protection
 * officer (the view log) get the page without its person sections.
 */
export function HealthPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/plant\/health\/?$/, '')
  const can = useMemo(() => healthCan(session.permissions), [session.permissions])
  const mode = pageMode(can)
  const address = useMemo(() => addressOf(params), [params])
  const siteId = scope.siteId
  const companyId = session.company?.id ?? null

  const [frame, setFrame] = useState<Read<HealthFrame>>({ status: 'loading' })
  const [due, setDue] = useState<Read<DueState> | null>(null)
  const [dueMore, setDueMore] = useState(false)
  const [dueUpdates, setDueUpdates] = useState(0)
  const [judgements, setJudgements] = useState<Read<JudgementsState> | null>(null)
  const [judgementsMore, setJudgementsMore] = useState(false)
  const [judgementUpdates, setJudgementUpdates] = useState(0)
  const [shown, setShown] = useState<Shown>({ state: 'hidden' })
  const [plans, setPlans] = useState<Read<readonly HealthPlan[]> | null>(null)
  const [readAt, setReadAt] = useState<string | null>(null)
  const [notice, setNotice] = useState<PageNotice | null>(null)
  const [dueSelected, setDueSelected] = useState<string[]>([])
  const [judgementSelected, setJudgementSelected] = useState<string[]>([])
  const [whoLooked, setWhoLooked] = useState<WhoLookedState | null>(null)
  const [book, setBook] = useState<BookDialogState | null>(null)
  const [judge, setJudge] = useState<JudgementDialogState | null>(null)
  const [planVisits, setPlanVisits] = useState<PlanVisitsState | null>(null)
  const [visit, setVisit] = useState<VisitWindowState | null>(null)
  const [judgement, setJudgement] = useState<JudgementWindowState | null>(null)
  const [plan, setPlan] = useState<PlanDialogState | null>(null)
  const turns = useRef({ frame: 0, due: 0, judgements: 0, plans: 0 })
  const quietUntil = useRef(0)
  const windowVisit = useRef<VisitRow | null>(null)
  const keys = useRef({ book: newIdempotencyKey(), judge: newIdempotencyKey(), plan: newIdempotencyKey(), visit: newIdempotencyKey(), judgement: newIdempotencyKey(), planEdit: newIdempotencyKey() })

  const frameReady = frame.status === 'ready'
  const today = frame.status === 'ready' ? frame.value.today : todayIn(DEFAULT_TIME_ZONE)
  const { status: dueStatus, type: dueType } = address
  const visitQuery = useMemo(() => visitQueryOf({ ...address, status: dueStatus, type: dueType }, siteId), [dueStatus, dueType, siteId]) // eslint-disable-line react-hooks/exhaustive-deps
  const judgementFilter = judgementFilterOf(address)

  // ---- reads ------------------------------------------------------------------------------------------------------------------
  const readFrameNow = useCallback(() => {
    if (mode !== 'full') return Promise.resolve()
    const turn = ++turns.current.frame
    return readFrame(api, siteId).then(
      (value) => {
        if (turn !== turns.current.frame) return
        setFrame({ status: 'ready', value })
        setReadAt(new Date().toISOString())
      },
      (error: unknown) => turn === turns.current.frame && setFrame({ status: 'error', problem: readProblemOf(error) }),
    )
  }, [api, mode, siteId])

  const readDueNow = useCallback(() => {
    const turn = ++turns.current.due
    return listVisits(api, visitQuery).then(
      (answer) => {
        if (turn !== turns.current.due) return
        setDue({ status: 'ready', value: { rows: answer.visits, more: answer.more, at: new Date().toISOString() } })
        setDueUpdates(0)
        setDueSelected((current) => current.filter((id) => answer.visits.some((row) => row.id === id)))
      },
      (error: unknown) => turn === turns.current.due && setDue({ status: 'error', problem: readProblemOf(error) }),
    )
  }, [api, visitQuery])

  const readJudgementsNow = useCallback(() => {
    const turn = ++turns.current.judgements
    return listJudgements(api, siteId, judgementFilter).then(
      (answer) => {
        if (turn !== turns.current.judgements) return
        setJudgements({ status: 'ready', value: { rows: answer.judgements, more: answer.more } })
        setJudgementUpdates(0)
        // A new read of the rows forgets the values shown (they were read for the rows then on screen).
        setShown((current) => (current.state === 'shown' || current.state === 'error' ? { state: 'hidden' } : current))
        setJudgementSelected((current) => current.filter((id) => answer.judgements.some((row) => row.id === id)))
      },
      (error: unknown) => turn === turns.current.judgements && setJudgements({ status: 'error', problem: readProblemOf(error) }),
    )
  }, [api, siteId, judgementFilter])

  const readPlansNow = useCallback(() => {
    if (!can.plansRead) return Promise.resolve()
    const turn = ++turns.current.plans
    return readPlans(api, siteId).then(
      (value) => turn === turns.current.plans && setPlans({ status: 'ready', value }),
      (error: unknown) => turn === turns.current.plans && setPlans({ status: 'error', problem: readProblemOf(error) }),
    )
  }, [api, can.plansRead, siteId])

  // The note first: nothing that names a person is read before the frame (its words) is on screen.
  useEffect(() => {
    setFrame({ status: 'loading' })
    void readFrameNow()
  }, [readFrameNow])
  useEffect(() => {
    if (mode !== 'full' || !frameReady) return
    setDue({ status: 'loading' })
    void readDueNow()
  }, [mode, frameReady, readDueNow])
  useEffect(() => {
    if (mode !== 'full' || !frameReady) return
    setJudgements({ status: 'loading' })
    setShown({ state: 'hidden' })
    void readJudgementsNow()
  }, [mode, frameReady, readJudgementsNow])
  useEffect(() => {
    if (!can.plansRead || mode === 'none' || (mode === 'full' && !frameReady)) return
    setPlans({ status: 'loading' })
    void readPlansNow()
  }, [can.plansRead, mode, frameReady, readPlansNow])

  const rereadCounts = useCoalesced(() => void readFrameNow(), 800)
  const rereadPlans = useCoalesced(() => void readPlansNow(), 800)
  useLive(
    (change) => {
      const moves = healthOfChange(change)
      if (moves.plans) rereadPlans()
      if (moves.visits || moves.judgements) rereadCounts()
      if (Date.now() < quietUntil.current) return
      if (moves.visits) setDueUpdates((count) => count + 1)
      if (moves.judgements) setJudgementUpdates((count) => count + 1)
    },
    () => {
      rereadCounts()
      rereadPlans()
      setDueUpdates((count) => count + 1)
      setJudgementUpdates((count) => count + 1)
    },
    mode !== 'none',
  )

  /** After the person's own write: the counts and the lists read again (the due list's read is recorded, as asked). */
  const afterWrite = (parts: { due?: boolean; judgements?: boolean; plans?: boolean }) => {
    quietUntil.current = Date.now() + QUIET_MS
    void readFrameNow()
    if (parts.due) void readDueNow()
    if (parts.judgements) void readJudgementsNow()
    if (parts.plans) void readPlansNow()
  }

  const go = useCallback((change: Partial<HealthAddress>) => router.replace(`${pathname}${addressTerms(withAddress(address, change))}`, { scroll: false }), [router, pathname, address])

  // ---- a visit's window (`?visit=`): its own recorded read --------------------------------------------------------------------
  const openVisitNow = useCallback(
    (id: string) => {
      setVisit({ id, read: { status: 'loading' }, move: null, busy: false, problem: null })
      openVisit(api, id).then(
        (answer) => {
          windowVisit.current = answer.visit
          setVisit((current) => (current && current.id === id ? { ...current, read: { status: 'ready', value: { visit: answer.visit, at: new Date().toISOString() } } } : current))
        },
        (error: unknown) => setVisit((current) => (current && current.id === id ? { ...current, read: { status: 'error', problem: readProblemOf(error) } } : current)),
      )
    },
    [api],
  )
  useEffect(() => {
    if (!address.visit || mode !== 'full' || !frameReady) {
      setVisit(null)
      return
    }
    openVisitNow(address.visit)
  }, [address.visit, mode, frameReady, openVisitNow])

  // ---- a judgement's window (`?judgement=`) -------------------------------------------------------------------------------------
  const openJudgementNow = useCallback(
    (id: string) => {
      setJudgement({ id, read: { status: 'loading' }, mode: 'view', reason: null, copy: null, busy: false, problem: null })
      openJudgement(api, id).then(
        (answer) => setJudgement((current) => (current && current.id === id ? { ...current, read: { status: 'ready', value: { judgement: answer.judgement, at: new Date().toISOString() } } } : current)),
        (error: unknown) => setJudgement((current) => (current && current.id === id ? { ...current, read: { status: 'error', problem: readProblemOf(error) } } : current)),
      )
    },
    [api],
  )
  useEffect(() => {
    if (!address.judgement || mode !== 'full' || !frameReady) {
      setJudgement(null)
      return
    }
    openJudgementNow(address.judgement)
  }, [address.judgement, mode, frameReady, openJudgementNow])

  // ---- Record a judgement (`?judge=1|<visit>`) ------------------------------------------------------------------------------------
  const dueRows = due?.status === 'ready' ? due.value.rows : null
  useEffect(() => {
    if (!address.judge || mode !== 'full' || !frameReady) {
      setJudge(null)
      return
    }
    setJudge((current) => {
      if (current) return current
      const fromList = address.judge !== '1' ? (dueRows?.find((row) => row.id === address.judge) ?? null) : null
      const fromWindow = address.judge !== '1' && !fromList && windowVisit.current?.id === address.judge ? windowVisit.current : null
      return { draft: newJudgementDraft(today, fromList ?? fromWindow), fromWindow, picked: null, people: null, peopleQuery: '', copy: null, busy: false, problem: null, savedWithoutCopy: null }
    })
  }, [address.judge, mode, frameReady, dueRows, today])

  const judgeOpen = judge !== null && judge.draft.from === 'person' && !judge.picked
  const judgeQuery = judge?.peopleQuery ?? ''
  useEffect(() => {
    if (!judgeOpen || !can.pickPeople || !companyId) return
    let live = true
    setJudge((current) => (current ? { ...current, people: current.people ?? { status: 'loading' } } : current))
    const timer = setTimeout(() => {
      readPeople(api, companyId, judgeQuery.trim() || null).then(
        (value) => live && setJudge((current) => (current ? { ...current, people: { status: 'ready', value } } : current)),
        (error: unknown) => live && setJudge((current) => (current ? { ...current, people: { status: 'error', problem: readProblemOf(error) } } : current)),
      )
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [api, judgeOpen, can.pickPeople, companyId, judgeQuery])

  const saveJudgement = async () => {
    if (!judge || judge.busy) return
    if (judgementHeld(judge.draft, today)) return
    setJudge({ ...judge, busy: true, problem: null })
    const key = keys.current.judge
    try {
      const answer = await recordJudgement(api, judgementBody(judge.draft), key)
      keys.current.judge = newIdempotencyKey()
      if (judge.copy) {
        try {
          await uploadCopy(api, answer.judgement.id, judge.copy, judge.copy.name || 'copy.pdf', `${key}.copy`)
        } catch (error) {
          setJudge((current) => (current ? { ...current, busy: false, savedWithoutCopy: answer.judgement.id, problem: problemOf(error) } : current))
          afterWrite({ due: true, judgements: true })
          return
        }
      }
      setJudge(null)
      go({ judge: null })
      setNotice({ tone: 'success', key: answer.visit ? 'notice.judgedVisit' : 'notice.judged' })
      afterWrite({ due: true, judgements: true })
    } catch (error) {
      setJudge((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  // ---- Plan visits (`?planVisits=1`): the proposals are a recorded read ------------------------------------------------------------
  const readProposalsNow = useCallback(() => {
    readProposals(api, siteId).then(
      (answer) =>
        setPlanVisits((current) =>
          current ? { ...current, proposals: { status: 'ready', value: { proposals: answer.proposals, at: new Date().toISOString() } }, chosen: answer.proposals.map(proposalKey) } : current,
        ),
      (error: unknown) => setPlanVisits((current) => (current ? { ...current, proposals: { status: 'error', problem: readProblemOf(error) } } : current)),
    )
  }, [api, siteId])
  useEffect(() => {
    if (!address.planVisits || mode !== 'full' || !frameReady) {
      setPlanVisits(null)
      return
    }
    setPlanVisits({ proposals: { status: 'loading' }, chosen: [], byHand: [], picking: null, people: null, peopleQuery: '', busy: false, problem: null })
    readProposalsNow()
  }, [address.planVisits, mode, frameReady, readProposalsNow])

  const planPicking = planVisits?.picking ?? null
  const planQuery = planVisits?.peopleQuery ?? ''
  useEffect(() => {
    if (!planPicking || !can.pickPeople || !companyId) return
    let live = true
    const timer = setTimeout(() => {
      readPeople(api, companyId, planQuery.trim() || null).then(
        (value) => live && setPlanVisits((current) => (current ? { ...current, people: { status: 'ready', value } } : current)),
        (error: unknown) => live && setPlanVisits((current) => (current ? { ...current, people: { status: 'error', problem: readProblemOf(error) } } : current)),
      )
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [api, planPicking, can.pickPeople, companyId, planQuery])

  const savePlanVisits = async () => {
    if (!planVisits || planVisits.busy || planVisits.proposals.status !== 'ready') return
    const proposals = planVisits.proposals.value.proposals
    const chosen = new Set(planVisits.chosen)
    if (planVisitsHeld(proposals, chosen, planVisits.byHand)) return
    const items = planItemsOf(proposals, chosen, planVisits.byHand)
    setPlanVisits({ ...planVisits, busy: true, problem: null })
    try {
      const planned = await sendPlanVisits(api, items, keys.current.plan)
      keys.current.plan = newIdempotencyKey()
      setPlanVisits(null)
      go({ planVisits: false })
      setNotice({ tone: 'success', key: 'notice.planned', params: { count: planned.length } })
      afterWrite({ due: true })
    } catch (error) {
      const problem = problemOf(error)
      setPlanVisits((current) => (current ? { ...current, busy: false, problem: { ...problem, ...(problem.item !== null ? { params: { n: problem.item + 1 } } : {}) } } : current))
    }
  }

  // ---- Mark booked (the chosen open visits) ---------------------------------------------------------------------------------------
  const saveBook = async () => {
    if (!book || book.busy || !dueRows) return
    const rows = dueRows.filter((row) => book.ids.includes(row.id))
    if (bookHeld(rows, book.draft, today)) return
    setBook({ ...book, busy: true, problem: null })
    try {
      const booked = await bookVisits(api, bookBody(rows, book.draft), keys.current.book)
      keys.current.book = newIdempotencyKey()
      setBook(null)
      setDueSelected([])
      setNotice({ tone: 'success', key: 'notice.booked', params: { count: booked.length, day: formatDate(`${book.draft.on}T12:00:00Z`, { locale }) } })
      afterWrite({ due: true })
    } catch (error) {
      setBook((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  // ---- a visit's move ---------------------------------------------------------------------------------------------------------------
  const saveVisit = async () => {
    if (!visit || visit.busy || !visit.move || visit.read.status !== 'ready') return
    const row = visit.read.value.visit
    const move = visit.move
    if (moveHeld(row, move, today)) return
    setVisit({ ...visit, busy: true, problem: null })
    const key = keys.current.visit
    try {
      if (move.kind === 'book') await bookVisits(api, bookBody([row], { on: move.day, place: move.place }), key)
      else await moveVisit(api, row.id, row.version, move.kind === 'move' ? { kind: 'move', dueOn: move.day } : move.kind === 'done' ? { kind: 'done', doneOn: move.day } : move.kind === 'cancel' ? { kind: 'cancel', reason: move.reason! } : { kind: 'unbook' }, key)
      keys.current.visit = newIdempotencyKey()
      windowVisit.current = null
      setVisit(null)
      go({ visit: null })
      setNotice({ tone: 'success', key: `notice.visit.${move.kind}` })
      afterWrite({ due: true })
    } catch (error) {
      setVisit((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  // ---- a judgement's void or copy -----------------------------------------------------------------------------------------------
  const saveJudgementWindow = async () => {
    if (!judgement || judgement.busy || judgement.read.status !== 'ready') return
    const row = judgement.read.value.judgement
    if (judgement.mode === 'void' && voidHeld(judgement.reason, Boolean(row.voided))) return
    if (judgement.mode === 'copy' && !judgement.copy) return
    setJudgement({ ...judgement, busy: true, problem: null })
    const key = keys.current.judgement
    try {
      if (judgement.mode === 'void') await voidJudgement(api, row.id, { version: row.version, reason: judgement.reason! }, key)
      else await uploadCopy(api, row.id, judgement.copy!, judgement.copy!.name || 'copy.pdf', key)
      keys.current.judgement = newIdempotencyKey()
      setJudgement(null)
      go({ judgement: null })
      setNotice({ tone: 'success', key: judgement.mode === 'void' ? 'notice.voided' : 'notice.copied' })
      afterWrite({ due: judgement.mode === 'void', judgements: true })
    } catch (error) {
      setJudgement((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  // ---- a role's plan (`?plan=`) ---------------------------------------------------------------------------------------------------
  const planList = plans?.status === 'ready' ? plans.value : null
  useEffect(() => {
    if (!address.plan || !planList) {
      if (!address.plan) setPlan(null)
      return
    }
    const found = planList.find((row) => row.id === address.plan)
    if (!found) {
      setPlan(null)
      return
    }
    setPlan((current) => (current && current.plan.id === found.id ? current : { plan: found, draft: planDraftOf(found, today), doctors: can.plansRead ? { status: 'loading' } : null, busy: false, problem: null }))
  }, [address.plan, planList, today, can.plansRead])
  const planCompany = plan?.plan.companyId ?? null
  useEffect(() => {
    if (!planCompany || !can.plansRead) return
    let live = true
    readDoctors(api, planCompany).then(
      (value) => live && setPlan((current) => (current ? { ...current, doctors: { status: 'ready', value } } : current)),
      (error: unknown) => live && setPlan((current) => (current ? { ...current, doctors: { status: 'error', problem: readProblemOf(error) } } : current)),
    )
    return () => {
      live = false
    }
  }, [api, planCompany, can.plansRead])

  const savePlan = async () => {
    if (!plan || plan.busy) return
    if (planHeld(plan.plan, plan.draft, today)) return
    const body = planBody(plan.plan, plan.draft)
    if (!body) return
    setPlan({ ...plan, busy: true, problem: null })
    try {
      await editPlan(api, plan.plan.id, body, keys.current.planEdit)
      keys.current.planEdit = newIdempotencyKey()
      setPlan(null)
      go({ plan: null })
      setNotice({ tone: 'success', key: 'notice.planSaved', params: { role: plan.plan.role.name } })
      afterWrite({ plans: true })
    } catch (error) {
      setPlan((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  // ---- Show the judgements' values (one view recorded per row) -------------------------------------------------------------------
  const show = async () => {
    if (shown.state !== 'confirm' || shown.ids.length === 0) return
    const ids = shown.ids
    setShown({ state: 'reading', ids })
    try {
      const values = await showJudgements(api, ids)
      setShown({ state: 'shown', byId: Object.fromEntries(values.map((row) => [row.id, row])), at: new Date().toISOString() })
      setJudgementSelected([])
    } catch (error) {
      setShown({ state: 'error', problem: readProblemOf(error) })
    }
  }

  // ---- Who looked (HR, the DPO): read when it opens, forgotten when it closes ----------------------------------------------------
  const whoTurn = useRef(0)
  const onWhoLooked = (of: WhoLookedState['of'] | null) => {
    const turn = ++whoTurn.current
    if (!of) return setWhoLooked(null)
    setWhoLooked({ of, read: { status: 'loading' } })
    readViews(api, of).then(
      (value) => turn === whoTurn.current && setWhoLooked({ of, read: { status: 'ready', value } }),
      (error: unknown) => turn === whoTurn.current && setWhoLooked({ of, read: { status: 'error', problem: readProblemOf(error) } }),
    )
  }

  const more = async (kind: 'due' | 'judgements') => {
    if (kind === 'due') {
      if (due?.status !== 'ready' || !due.value.more || dueMore) return
      setDueMore(true)
      try {
        const answer = await listVisits(api, visitQuery, due.value.rows.length)
        setDue((current) => (current?.status === 'ready' ? { status: 'ready', value: { ...current.value, rows: [...current.value.rows, ...answer.visits.filter((row) => !current.value.rows.some((seen) => seen.id === row.id))], more: answer.more } } : current))
      } catch (error) {
        setNotice({ tone: 'warning', key: readProblemOf(error) === 'problem.read' ? 'notice.moreFailed' : readProblemOf(error) })
      } finally {
        setDueMore(false)
      }
      return
    }
    if (judgements?.status !== 'ready' || !judgements.value.more || judgementsMore) return
    setJudgementsMore(true)
    try {
      const answer = await listJudgements(api, siteId, judgementFilter, judgements.value.rows.length)
      setJudgements((current) => (current?.status === 'ready' ? { status: 'ready', value: { rows: [...current.value.rows, ...answer.judgements.filter((row) => !current.value.rows.some((seen) => seen.id === row.id))], more: answer.more } } : current))
    } catch (error) {
      setNotice({ tone: 'warning', key: readProblemOf(error) === 'problem.read' ? 'notice.moreFailed' : readProblemOf(error) })
    } finally {
      setJudgementsMore(false)
    }
  }

  const pick = (person: PickedPerson | null) =>
    setJudge((current) => (current ? { ...current, picked: person, draft: { ...current.draft, employeeId: person?.id ?? null, visitId: null }, problem: null } : current))

  return (
    <HealthView
      model={{
        prefix,
        can,
        scope,
        companyId,
        address,
        today,
        locale,
        frame: mode === 'full' ? frame : { status: 'loading' },
        due,
        dueMore,
        dueUpdates,
        judgements,
        judgementsMore,
        judgementUpdates,
        shown,
        plans,
        readAt,
        notice,
        dueSelected,
        judgementSelected,
        whoLooked,
        book,
        judge,
        planVisits,
        visit,
        judgement,
        plan,
      }}
      actions={{
        onAddress: go,
        onRetryFrame: () => {
          setFrame({ status: 'loading' })
          void readFrameNow()
        },
        onRetryDue: () => {
          setDue({ status: 'loading' })
          void readDueNow()
        },
        onRetryJudgements: () => {
          setJudgements({ status: 'loading' })
          void readJudgementsNow()
        },
        onRetryPlans: () => {
          setPlans({ status: 'loading' })
          void readPlansNow()
        },
        onDueMore: () => void more('due'),
        onDueUpdates: () => void readDueNow(),
        onJudgementsMore: () => void more('judgements'),
        onJudgementUpdates: () => void readJudgementsNow(),
        onDismissNotice: () => setNotice(null),
        onDueSelected: setDueSelected,
        onJudgementSelected: setJudgementSelected,
        onWhoLooked,
        onAskShow: (ids) => ids.length > 0 && setShown({ state: 'confirm', ids }),
        onShow: () => void show(),
        onHideShown: () => setShown({ state: 'hidden' }),
        onBook: (ids) => setBook({ ids, draft: newBookDraft(), busy: false, problem: null }),
        onBookDraft: (draft) => setBook((current) => (current ? { ...current, draft, problem: null } : current)),
        onBookSave: () => void saveBook(),
        onBookClose: () => setBook(null),
        onJudgeDraft: (draft) => setJudge((current) => (current ? { ...current, draft, problem: null, ...(draft.from !== current.draft.from ? { picked: null } : {}) } : current)),
        onJudgePeopleQuery: (q) => setJudge((current) => (current ? { ...current, peopleQuery: q } : current)),
        onJudgePick: pick,
        onJudgeCopy: (file) => setJudge((current) => (current ? { ...current, copy: file } : current)),
        onJudgeSave: () => void saveJudgement(),
        onJudgeClose: () => {
          const saved = judge?.savedWithoutCopy
          setJudge(null)
          go({ judge: null })
          if (saved) setNotice({ tone: 'warning', key: 'notice.judgedNoCopy' })
        },
        onPlanChosen: (chosen) => setPlanVisits((current) => (current ? { ...current, chosen: [...chosen], problem: null } : current)),
        onPlanByHand: (byHand) => setPlanVisits((current) => (current ? { ...current, byHand: [...byHand], problem: null } : current)),
        onPlanPick: (key) => setPlanVisits((current) => (current ? { ...current, picking: current.picking === key ? null : key, people: key ? { status: 'loading' } : null, peopleQuery: '' } : current)),
        onPlanPeopleQuery: (q) => setPlanVisits((current) => (current ? { ...current, peopleQuery: q } : current)),
        onPlanPerson: (key, person) =>
          setPlanVisits((current) => (current ? { ...current, picking: null, people: null, byHand: current.byHand.map((item) => (item.key === key ? { ...item, employeeId: person.id, name: person.name } : item)), problem: null } : current)),
        onPlanRetry: () => {
          setPlanVisits((current) => (current ? { ...current, proposals: { status: 'loading' } } : current))
          readProposalsNow()
        },
        onPlanSave: () => void savePlanVisits(),
        onPlanClose: () => {
          setPlanVisits(null)
          go({ planVisits: false })
        },
        onVisitMove: (move) => setVisit((current) => (current ? { ...current, move, problem: null } : current)),
        onVisitSave: () => void saveVisit(),
        onVisitRetry: () => address.visit && openVisitNow(address.visit),
        onVisitClose: () => {
          setVisit(null)
          go({ visit: null })
        },
        onJudgementMode: (next) => setJudgement((current) => (current ? { ...current, mode: next, problem: null, reason: null, copy: null } : current)),
        onJudgementReason: (reason) => setJudgement((current) => (current ? { ...current, reason } : current)),
        onJudgementCopy: (file) => setJudgement((current) => (current ? { ...current, copy: file } : current)),
        onJudgementSave: () => void saveJudgementWindow(),
        onJudgementRetry: () => address.judgement && openJudgementNow(address.judgement),
        onJudgementClose: () => {
          setJudgement(null)
          go({ judgement: null })
        },
        onPlanDraft: (draft) => setPlan((current) => (current ? { ...current, draft, problem: null } : current)),
        onPlanEditSave: () => void savePlan(),
        onPlanEditClose: () => {
          setPlan(null)
          go({ plan: null })
        },
      }}
    />
  )
}
