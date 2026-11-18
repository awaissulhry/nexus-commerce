'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { useApprovalHistory } from '../../../shell/panels/approvals/use-approval-history'
import { approveQuote, getQuote, listApprovals, rejectQuote, type ApprovalRow, type ApprovalsAnswer, type QuoteDetail } from '../../sales/quotes/api'
import { abilitiesOf, grainsOf, nextAfter } from '../../sales/quotes/model'
import { readProblem, writeProblem } from '../../sales/quotes/problems'
import type { Loaded } from '../../sales/quotes/record/record-model'
import { fetchToday } from '../today/api'
import { queueItem } from '../today/links'
import type { TodayAnswer } from '../today/model'
import { useTodayLive } from '../today/live'
import { approveTask, getTask, listRejectReasons, listTasks, rejectTask, stepUp, type RejectReason, type TaskDetail, type TaskList } from './api'
import { controlsOf, countsOf, decisionProblem, heldOf, inboxAddress, listedTarget, nextReview, rowsOf, TILE_OF, type InboxControls, type InboxRow } from './inbox'
import type { BulkLine, InboxDialog, InboxViewModel, ReviewTab } from './model'
import { InboxView } from './view/InboxView'
import { CustomerOverrideProvider } from '../../_shared/customer-override/CustomerOverride' // F-PR-09
// B-W2b-188 (PLT-089): the person's own "e-mail me approvals" switch.
import { MailMeSwitch } from '../../../record-panels/approvals/mail-me/MailMeSwitch'
// B-W2b-382 (XF7:01, XF7:02): the request in words from its codes; its record's page (its parent's) also for the review alone.
import { subjectAddress } from './subject-links/subject-link'
// B-TH-270 (PL6): the request's thread docked in the review window (its Conversation tab went).
import { RequestThread } from './words/RequestThread'
// F-PR-08: a customer's requests — their own source, their review window, the follow-up after an accept (R-23).
import { recordAddress } from '../../../lib/records/record-links'
import { listWaitingRequests, type BrandRequestList } from './requests/api'
import { requestGroupsOf, type FollowUp } from './requests/model'
import { clearRush, liftCustomerPause, probeOpen, useRequestReview, type RequestNotice } from './requests/use-request-review'

// F-PR-08: a customer's request asked, answered, countered or withdrawn reads the inbox again too.
const isApprovalChange = (type: string) => type.startsWith('approval.') || type.startsWith('quote.') || type === 'change_order.changed' || type === 'smv_version.changed' || type.startsWith('inspection_plan.') || type.startsWith('order_change_request.')

/**
 * `/w/<company>/home/approvals` (SCR-030; B-W2b-307, PLT-085): ONE inbox of every request that needs a yes, from three
 * sources each read with the person's own rights — the approval engine's requests (`GET /approvals/tasks?tile=`), W1's
 * quote approvals (`GET /sales/quote-approvals?view=`) and every other approval Today knows (`GET /home/today?category=
 * APPROVAL`: change orders, SMV changes, inspection plan versions, NCR decisions, portal and supplier requests …, each
 * decided on its own page). The address holds the view, the filters and the review (`?view=&kind=&q=&changed=1&open=`).
 * A request opens its review (`GET /approvals/tasks/:id`, the re-check), is approved with the version as read (a signed
 * rule: the step-up first), rejected with a reason code and words; Approve N re-reads each request first and approves
 * the current ones one by one. After a decision the next request opens. Live: approval.*, quote.* and the decided
 * records' events read the inbox again.
 * F-PR-08: a fourth source, a customer's requests (`GET /production/brand-requests?status=WAITING`, requests/), answered in their own
 * review window (requests/use-request-review.ts); `?open=` of an id no row names is asked (an engine request, a customer request, a
 * batch) and opens the neutral "not there any more" when none knows it (another customer's, PW-H01b).
 */
export function Approvals() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const controls = controlsOf(params)
  const controlsRef = useRef(controls)
  controlsRef.current = controls
  const prefix = pathname.replace(/\/home\/approvals\/?$/, '')
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const grains = useMemo(() => grainsOf(session.permissions), [session.permissions])
  const quoteCan = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  // F-PR-08: `requests` — the customer requests (GET /production/brand-requests: orders.view or workorders.view; the API walls them).
  const can = useMemo(() => ({ quotes: quoteCan, tasks: held.has('approvals.view'), decide: held.has('approvals.decide') || quoteCan.approve, today: held.has('home.view'), rules: held.has('approvals.view'), requests: held.has('orders.view') || held.has('workorders.view'), lift: held.has('workorders.hold'), rush: held.has('workorders.manage') }), [quoteCan, held])
  const companies = useMemo(() => Object.fromEntries(session.companies.map((company) => [company.id, company.name])), [session.companies])

  const [tasks, setTasks] = useState<TaskList | null>(null)
  const [quotes, setQuotes] = useState<ApprovalsAnswer | null>(null)
  const [today, setToday] = useState<TodayAnswer | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState<InboxViewModel['notice']>(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<InboxDialog | null>(null)
  const [detail, setDetail] = useState<{ id: string; value: Loaded<TaskDetail> } | null>(null)
  const [quoteReview, setQuoteReview] = useState<{ id: string; quote: Loaded<QuoteDetail> } | null>(null)
  const [quoteRejecting, setQuoteRejecting] = useState(false)
  const [comment, setComment] = useState('')
  const [tab, setTab] = useState<ReviewTab>('change')
  const rowsRef = useRef<InboxRow[]>([])
  // F-PR-08: the customer requests read; what an id no listed row names turned out to be; Lift the hold's why.
  const [requests, setRequests] = useState<BrandRequestList | null>(null)
  const [probed, setProbed] = useState<{ id: string; as: 'task' | 'request' | 'batch' | 'none' } | null>(null)
  const [followUpDialog, setFollowUpDialog] = useState<InboxViewModel['followUpDialog']>(null)

  const go = useCallback((next: Partial<InboxControls>) => router.replace(`${pathname}${inboxAddress({ ...controlsRef.current, ...next })}`, { scroll: false }), [router, pathname])
  // F-PR-08: a customer request's order page (with the company prefix).
  const orderPage = useCallback((request: { readonly orderId: string; readonly orderNumber: string; readonly companyId: string }) => `${prefix}${recordAddress({ type: 'SalesOrder', id: request.orderId, label: request.orderNumber, companyId: request.companyId, siteId: null }, OFFICE_PAGES)}`, [prefix])

  // ---- the three sources ---------------------------------------------------------------------------------------------------
  const load = useCallback(async () => {
    const view = controlsRef.current.view
    const [task, quote, attention, asked] = await Promise.allSettled([
      can.tasks ? listTasks(api, TILE_OF[view]) : Promise.resolve(null),
      can.quotes.view ? listApprovals(api, view === 'overdue' ? 'waiting' : view) : Promise.resolve(null),
      can.today ? fetchToday(api, { category: 'APPROVAL', limit: 200 }) : Promise.resolve(null),
      // F-PR-08: what waits of the customers' requests, as far as this reader reaches (no customer filter: the API's wall).
      can.requests ? listWaitingRequests(api) : Promise.resolve(null),
    ])
    if (view !== controlsRef.current.view) return
    const failed = [task, quote, attention, asked].filter((result) => result.status === 'rejected') as PromiseRejectedResult[]
    setTasks(task.status === 'fulfilled' ? task.value : null)
    setQuotes(quote.status === 'fulfilled' ? quote.value : null)
    setToday(attention.status === 'fulfilled' ? attention.value : null)
    setRequests(asked.status === 'fulfilled' ? asked.value : null)
    const reads = [can.tasks, can.quotes.view, can.today, can.requests].filter(Boolean).length
    setProblem(failed.length > 0 && failed.length >= reads ? readProblem(failed[0]!.reason) : null)
    setNotice((current) => (failed.length > 0 && failed.length < reads ? { key: 'notice.partial', tone: 'warning' } : current?.key === 'notice.partial' ? null : current))
    setLoaded(true)
  }, [api, can])

  useEffect(() => {
    setLoaded(false)
    void load()
  }, [controls.view, load])

  const rows: InboxRow[] | null = useMemo(() => {
    if (!loaded) return null
    const view = controls.view
    const built = rowsOf(view, { tasks: tasks?.rows ?? [], quotes: view === 'overdue' ? [] : (quotes?.approvals ?? []), items: today?.items ?? [], requests: requests ? requestGroupsOf(requests.items) : null })
    return built.map((row): InboxRow => {
      // B-W2b-377: a subject with no page of its own (a credit check, a bank account, a return or receipt line) opens its parent's.
      if (row.task) return { ...row, href: subjectAddress(row.task, prefix, OFFICE_PAGES) }
      if (row.quote) return { ...row, href: `${prefix}/sales/quotes/${row.quote.quoteId}?tab=approval` }
      // F-PR-08: a customer's request: its order's page (a batch's group has none of its own: its window lists the orders).
      if (row.request) {
        const lead = row.request.requests[0]!
        return { ...row, href: row.request.requests.length > 1 ? null : orderPage(lead) }
      }
      return { ...row, href: row.item ? queueItem(row.item, prefix).href : null }
    })
  }, [loaded, tasks, quotes, today, requests, controls.view, prefix])
  rowsRef.current = rows ?? []

  const counts = countsOf({
    tasks: tasks ? (Object.fromEntries(tasks.tiles.map((tile) => [tile.tile, tile.count])) as Record<'WAITING_FOR_ME' | 'OVERDUE' | 'ASKED_BY_ME' | 'DECIDED_7_DAYS', number>) : null,
    quotes: quotes ? quotes.counts : null,
    today: today ? { items: today.items } : null,
    // F-PR-08: the customer requests waiting for me, as their rows (a batch one).
    requests: requests ? { rows: requestGroupsOf(requests.items).length } : null,
    reads: { tasks: can.tasks, quotes: can.quotes.view, today: can.today, requests: can.requests },
  })

  // ---- the review (`?open=`) -----------------------------------------------------------------------------------------------
  const openId = controls.open
  const quoteRow = openId ? (rows?.find((row) => row.quote?.id === openId)?.quote ?? null) : null
  // F-PR-08: what the id opens — a listed row says it; an id no row names (the Customer card's link, the bell, Incoming) is asked
  // (an engine request, a customer request, a batch); none of them, or another customer's (PW-H01b): the neutral "not found".
  const listed = openId && rows ? listedTarget(rows, openId) : null
  const target = !openId || rows === null ? null : (listed ?? (probed?.id === openId ? probed.as : null))
  useEffect(() => {
    if (!openId || rows === null || listed !== null || probed?.id === openId) return
    let gone = false
    void probeOpen(api, openId, { tasks: can.tasks, requests: can.requests }).then((as) => {
      if (!gone) setProbed({ id: openId, as })
    })
    return () => {
      gone = true
    }
  }, [api, openId, rows === null, listed, probed?.id, can.tasks, can.requests])
  const isTask = target === 'task' || target === 'none'
  const readTask = useCallback(async () => {
    if (!openId || target !== 'task') return
    setDetail((current) => (current?.id === openId && current.value.status === 'ready' ? current : { id: openId, value: { status: 'loading' } }))
    try {
      setDetail({ id: openId, value: { status: 'ready', value: await getTask(api, openId) } })
    } catch (error) {
      setDetail({ id: openId, value: isApiError(error) && error.kind === 'not_found' ? { status: 'not_found' } : isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) } })
    }
  }, [api, openId, target])
  useEffect(() => {
    setComment('')
    setTab('change')
    setDialog(null)
    void readTask()
  }, [readTask])

  const quoteId = quoteRow?.quoteId ?? null
  const readQuote = useCallback(async () => {
    if (!openId || !quoteId) return
    setQuoteReview({ id: openId, quote: { status: 'loading' } })
    try {
      setQuoteReview({ id: openId, quote: { status: 'ready', value: await getQuote(api, quoteId) } })
    } catch (error) {
      setQuoteReview({ id: openId, quote: isApiError(error) && error.kind === 'not_found' ? { status: 'not_found' } : isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) } })
    }
  }, [api, openId, quoteId])
  useEffect(() => {
    void readQuote()
  }, [readQuote])

  const task = detail && detail.id === openId && detail.value.status === 'ready' ? detail.value.value : null
  // The record's history when the reader may view the record; else the review shows the request's own lines.
  const history = useApprovalHistory({ api, record: task ? { type: task.record.type, id: task.record.id } : null, allowed: can.tasks, held })

  const live = useTodayLive(
    {
      onChange: (type) => {
        if (!isApprovalChange(type)) return
        void load()
        if (!busy && !dialog) {
          void readTask()
          if (quoteId) void readQuote()
          // F-PR-08: the open customer request read again (its words typed are kept).
          if (requestTarget && !requestReview.model?.dialog) requestReview.refresh()
        }
        if (type.startsWith('approval.')) history.refresh()
      },
      onReconnect: () => void load(),
    },
    true,
  )
  const offline = live === 'offline'

  // ---- F-PR-08: a customer's request or batch in the review window -----------------------------------------------------------
  const afterRequest = async (answered: { readonly id: string; readonly notice: RequestNotice; readonly then: string | null }) => {
    setNotice(answered.notice)
    const before = rowsRef.current
    await load()
    // A request answered alone from its batch goes back to the batch while others of it wait; else the next request opens.
    const next = answered.then ?? nextReview(before, answered.id)
    go({ open: next && next !== answered.id ? next : null })
  }
  const requestTarget = target === 'request' || target === 'batch' ? target : null
  const requestReview = useRequestReview({
    api,
    openId: requestTarget ? openId : null,
    openAs: requestTarget,
    offline,
    price: grains.price,
    orderHref: orderPage,
    mayLift: held.has('workorders.hold'),
    onAnswered: (answered) => void afterRequest(answered),
    onReload: () => void load(),
  })
  // R-23: "Clear rush" at once (each work order read for its version), "Lift the hold" with why (the dialog).
  const followUpNow = async (followUp: FollowUp) => {
    if (followUp.kind === 'lift') {
      setFollowUpDialog({ followUp, busy: false, problem: null })
      return
    }
    setBusy(true)
    try {
      const result = await clearRush(api, followUp)
      setNotice(result.failed.length > 0 ? { key: 'notice.rushNotCleared', tone: 'warning', params: { orders: result.failed.join(', ') } } : { key: 'notice.rushCleared', tone: 'success', params: { orders: result.cleared.join(', ') } })
    } finally {
      setBusy(false)
    }
  }
  const liftNow = async (reason: string) => {
    const current = followUpDialog
    if (!current) return
    setFollowUpDialog({ ...current, busy: true, problem: null })
    setBusy(true)
    try {
      const result = await liftCustomerPause(api, current.followUp, reason)
      setFollowUpDialog(null)
      setNotice(
        result.failed.length > 0
          ? { key: 'notice.holdNotLifted', tone: 'warning', params: { orders: result.failed.join(', ') } }
          : result.lifted.length > 0
            ? { key: 'notice.holdLifted', tone: 'success', params: { orders: result.lifted.join(', ') } }
            : { key: 'notice.holdNothing', tone: 'info' },
      )
      void load()
      requestReview.refresh()
    } finally {
      setBusy(false)
    }
  }
  // ---- end F-PR-08

  // ---- deciding a request of the engine ------------------------------------------------------------------------------------
  const afterDecision = async (decided: TaskDetail, key: string) => {
    const decidedId = decided.id
    setNotice({ key, tone: 'success', request: { kindLabel: decided.kindLabel, record: decided.record } })
    setDialog(null)
    const before = rowsRef.current
    await load()
    const next = nextReview(before, decidedId)
    go({ open: next && next !== decidedId ? next : null })
  }
  const failed = (error: unknown) => {
    const problem = decisionProblem(isApiError(error) ? error : null)
    setNotice({ key: problem.key, tone: 'danger' })
    if (problem.reload) {
      void load()
      void readTask()
    }
  }
  const approveNow = async (code: string | null) => {
    if (!task) return
    setBusy(true)
    setNotice(null)
    try {
      if (code) {
        await stepUp(api, code)
      }
      await approveTask(api, task, comment)
      await afterDecision(task, task.signatureMeaning ? 'notice.signed' : 'notice.approved')
    } catch (error) {
      if (dialog?.kind === 'sign' || code !== null) {
        const problem = decisionProblem(isApiError(error) ? error : null)
        if (problem.reload) {
          setDialog(null)
          failed(error)
        } else setDialog({ kind: 'sign', busy: false, problem: isApiError(error) && (error.kind === 'invalid' || error.kind === 'step_up' || error.kind === 'rate_limited') ? 'sign.codeWrong' : problem.key })
      } else failed(error)
    } finally {
      setBusy(false)
    }
  }
  const readReasons = useCallback(async () => {
    setDialog((current) => (current?.kind === 'reject' ? { ...current, reasons: { status: 'loading' } } : { kind: 'reject', reasons: { status: 'loading' }, busy: false }))
    try {
      const reasons: RejectReason[] = await listRejectReasons(api)
      setDialog((current) => (current?.kind === 'reject' ? { ...current, reasons: { status: 'ready', value: reasons } } : current))
    } catch (error) {
      setDialog((current) => (current?.kind === 'reject' ? { ...current, reasons: { status: 'error', problem: readProblem(error) } } : current))
    }
  }, [api])
  const rejectNow = async (reasonCode: string, reason: string) => {
    if (!task) return
    setBusy(true)
    setDialog((current) => (current?.kind === 'reject' ? { ...current, busy: true } : current))
    try {
      await rejectTask(api, task, reasonCode, reason)
      await afterDecision(task, 'notice.rejected')
    } catch (error) {
      setDialog(null)
      failed(error)
    } finally {
      setBusy(false)
    }
  }

  // ---- Approve N: each re-read, the current ones approved one by one ----------------------------------------------------
  const bulkRead = async (keys: readonly string[]) => {
    setDialog({ kind: 'bulk', keys, lines: null, state: { phase: 'reading' } })
    const chosen = rowsRef.current.filter((row) => keys.includes(row.key) && row.task)
    try {
      const lines: BulkLine[] = []
      for (const row of chosen) {
        const now = await getTask(api, row.task!.id).catch(() => null)
        // Its row as read now, through the inbox's own rule (status, mine, changed, gone, not mine), then: signed one by one.
        const leftOut = !now ? 'inbox.held.gone' : (heldOf({ ...row, task: now }, { offline: false, busy: false }) ?? (now.signatureMeaning || now.requireStepUp ? 'inbox.held.signedOneByOne' : null))
        const read = now ?? row.task!
        lines.push({ key: row.key, id: read.id, version: read.version, request: { kindLabel: read.kindLabel, record: read.record }, leftOut })
      }
      setDialog({ kind: 'bulk', keys, lines, state: { phase: 'ready' } })
    } catch (error) {
      setDialog({ kind: 'bulk', keys, lines: null, state: { phase: 'failed', error: readProblem(error) } })
    }
  }
  const bulkApprove = async () => {
    if (dialog?.kind !== 'bulk' || !dialog.lines) return
    const lines = dialog.lines.filter((line) => line.leftOut === null)
    setBusy(true)
    const results: Record<string, { ok: boolean; words: string }> = {}
    let done = 0
    for (const line of lines) {
      setDialog({ ...dialog, state: { phase: 'saving', done } })
      try {
        await approveTask(api, { id: line.id, version: line.version }, null)
        results[line.key] = { ok: true, words: 'approved' }
      } catch (error) {
        results[line.key] = { ok: false, words: decisionProblem(isApiError(error) ? error : null).key }
      }
      done++
    }
    setBusy(false)
    setDialog({ ...dialog, state: { phase: 'done', results } })
    void load()
  }

  // ---- W1's quote review ---------------------------------------------------------------------------------------------------
  const decideQuote = async (work: (current: { id: string; version: number }) => Promise<QuoteDetail>, done: string): Promise<boolean> => {
    if (!quoteRow) return false
    const quote = quoteReview?.quote.status === 'ready' ? quoteReview.quote.value : null
    setBusy(true)
    setNotice(null)
    try {
      await work({ id: quoteRow.quoteId, version: quote?.version ?? quoteRow.quoteVersion })
      setQuoteRejecting(false)
      const quoteRows = rowsRef.current.flatMap((row) => (row.quote ? [row.quote] : [])) as ApprovalRow[]
      const next = nextAfter(quoteRows, quoteRow.id)
      await load()
      setNotice({ key: done === 'notice.approved' ? 'notice.quoteApproved' : 'notice.quoteRejected', tone: 'success', params: { number: quoteRow.number } })
      go({ open: next && rowsRef.current.some((row) => row.quote?.id === next) ? next : null })
      return true
    } catch (error) {
      const problem = writeProblem(error)
      setNotice({ key: problem.key, tone: 'danger' })
      if (problem.reload) {
        void load()
        void readQuote()
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  const model: InboxViewModel = {
    prefix,
    me: session.user.id,
    grains,
    can,
    controls,
    rows: { items: rows, problem },
    counts,
    changedSinceAsked: tasks?.notice.changedSinceAsked ?? 0,
    capped: (tasks?.nextCursor ?? null) !== null || (quotes?.counts.capped ?? false) || (today?.nextCursor ?? null) !== null || (requests ? requests.count > requests.items.length : false),
    companies,
    asOf: tasks?.asOf ?? today?.asOf ?? quotes?.at ?? null,
    offline,
    busy: busy || requestReview.busy,
    notice,
    quoteReview: openId && quoteRow ? (quoteReview && quoteReview.id === openId ? quoteReview : { id: openId, quote: { status: 'loading' } }) : null,
    quoteRejecting,
    // F-PR-08: an id nobody knows (or another customer's request, PW-H01b) opens the window's neutral "not there any more".
    taskReview: openId && isTask ? { id: openId, detail: target === 'none' ? { status: 'not_found' } : detail && detail.id === openId ? detail.value : { status: 'loading' }, history: history.model, comment, tab, recordHref: task ? subjectAddress(task, prefix, OFFICE_PAGES) : null } : null,
    dialog,
    requestReview: requestReview.model,
    followUpDialog,
  }

  const page = (
    <InboxView
      model={model}
      mailSwitch={<MailMeSwitch api={api} />}
      thread={task && held.has('threads.read') ? <RequestThread task={task} /> : undefined}
      actions={{
        onControls: (next) => go(next),
        onRetry: () => {
          setLoaded(false)
          void load()
        },
        onDismissNotice: () => setNotice(null),
        onOpen: (id) => {
          setQuoteRejecting(false)
          go({ open: id })
        },
        onRetryReview: () => void readTask(),
        onTab: setTab,
        onComment: setComment,
        onApprove: () => {
          if (!task) return
          if (task.signatureMeaning !== null || task.requireStepUp) setDialog({ kind: 'sign', busy: false, problem: null })
          else void approveNow(null)
        },
        onSign: (code) => {
          setDialog({ kind: 'sign', busy: true, problem: null })
          void approveNow(code || null)
        },
        onReject: () => void readReasons(),
        onRejectConfirm: (code, reason) => void rejectNow(code, reason),
        onRetryReasons: () => void readReasons(),
        onCloseDialog: () => {
          if (dialog?.kind === 'bulk' && dialog.state.phase === 'done') void load()
          setDialog(null)
          setFollowUpDialog(null)
        },
        onBulk: (keys) => void bulkRead(keys),
        onBulkConfirm: () => void bulkApprove(),
        history: history.actions,
        // F-PR-08: the customer request window; the notice's Clear rush / Lift the hold.
        request: { ...requestReview.actions, onLift: (followUp) => setFollowUpDialog({ followUp, busy: false, problem: null }) },
        onFollowUp: (followUp) => void followUpNow(followUp),
        onLiftConfirm: (reason) => void liftNow(reason),
        quote: {
          onRetryReview: () => void readQuote(),
          onApprove: (note) => decideQuote((current) => approveQuote(api, current, note || null), 'notice.approved'),
          onReject: (reason) => decideQuote((current) => rejectQuote(api, current, reason), 'notice.rejected'),
          onRejecting: setQuoteRejecting,
        },
      }}
    />
  )
  // F-PR-09: "Decide for <customer>" / "Reverse" on a counter-offer read the request window and the inbox again once done.
  return (
    <CustomerOverrideProvider
      onDone={() => {
        requestReview.refresh()
        void load()
      }}
    >
      {page}
    </CustomerOverrideProvider>
  )
}
