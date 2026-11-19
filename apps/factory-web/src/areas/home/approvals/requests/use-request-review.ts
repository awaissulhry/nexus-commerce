'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { DEFAULT_TIME_ZONE } from '../../../../lib/i18n/format'
import { getWorkOrder, updateWorkOrder } from '../../../production/_shared/api'
import { liftProductionHold, listProductionHolds } from '../../../production/work-orders/daily/api'
import { readProblem } from '../../../sales/quotes/problems'
import type { Tone } from '../../../sales/quotes/model'
import type { Loaded } from '../../../sales/quotes/record/record-model'
import type { RequestFacts } from '../words/request-words'
import { getTask } from '../api'
import { acceptBatch, acceptProduction, acceptSales, counterRequest, getImpact, getRequest, listBatch, refuseBatch, refuseRequest, type BrandRequest, type RequestImpactRead, type RequestRecord, type Words } from './api'
// F-SA-245: an id no listed row names may be a work-order change.
import { getWorkOrderChange } from '../work-order-changes/api'
// F-SA-241: the apply plan; after Accept each next step's own command (Stop now's hold, a work-order change carried out).
// F-SA-242: the words in the order's conversation through the thread's own send (the composer's portal reply call, untouched).
import { applyWorkOrderChange } from '../work-order-changes/api'
import { changeProblemOf } from '../work-order-changes/model'
import { placeProductionHold } from '../../../production/work-orders/daily/api'
import { postPortalReplyKeyed, readMessageLanguage } from '../../../_shared/record-thread/api'
import { portalRefusal } from '../../../_shared/record-thread/state'
import { getApplyPlan, type ApplyPlan } from './api'
import {
  CR,
  doneCommandsOf,
  atAcceptOf, // F-OP-116
  leftToRun,
  NO_CHOICES,
  reachOf,
  runInOrder,
  stoppableOf,
  tellRefusalOf,
  tellsNow,
  type ApplyChoices,
  type CommandState,
  type DoneCommand,
  type DoneView,
  type TellTick,
} from './model'
import {
  answerProblem,
  batchFactsOf,
  batchItemsOf,
  batchLinesOf,
  batchRefusalsOf,
  batchResultsOf,
  counterBodyOf,
  doneWordsOf,
  followUpOf,
  hasTwoAccepts,
  noticeFactsOf,
  type CounterDraft,
  type FollowUp,
  type RequestActions,
  type RequestDialog,
  type RequestReviewModel,
} from './model'

/**
 * F-PR-08 — the container of a customer request's review window in Home › Approvals (Approvals.tsx mounts it; the view draws
 * `RequestReviewModel`): reads the request (`GET /production/brand-requests/:id` + its impact) or the batch (`?batchId=`), keeps the
 * words the customer reads, answers through each kind's own route (./api), re-reads a batch before Accept all / Refuse all, and hands
 * the inbox a notice — with "Lift the hold" or "Clear rush" when the accept offers one (R-23). Every write carries an Idempotency-Key.
 * F-SA-240: two hosts, one engine — Home › Approvals (Approvals.tsx: its inbox rows) and every other door of the same window (the
 * order page, the order's thread, the customer's Work tab) through use-request-review-door.ts. Nothing here knows the inbox.
 */

/** A notice the inbox shows after an answer (keys of approvals-depth `notice.*`). */
export interface RequestNotice {
  readonly key: string
  readonly tone: Tone
  readonly params?: Record<string, string | number>
  readonly request?: RequestFacts
  /** What the answer said beside (urgent use, a rush left alone, a re-promise not made), in both languages. */
  readonly lines?: readonly Words[]
  readonly followUp?: FollowUp
}

export interface RequestReviewHost {
  readonly api: ApiClient
  /** What the address opens as a customer request (null: none). */
  readonly openId: string | null
  readonly openAs: 'request' | 'batch' | null
  readonly offline: boolean
  /** The reader holds the price grain (a counter's fee is theirs to set). */
  readonly price: boolean
  /** The order's page (with the company prefix). F-SA-240: '' — no link (the door is that order's own page). */
  readonly orderHref: (request: Pick<BrandRequest, 'orderId' | 'orderNumber' | 'companyId'>) => string
  /** The reader may lift a customer's pause (workorders.hold). */
  readonly mayLift: boolean
  /** After an answer: the notice, and what opens next (the batch the request came from while others of it wait; else the next row). */
  readonly onAnswered: (answered: { readonly id: string; readonly notice: RequestNotice; readonly then: string | null }) => void
  /** The list changed under the window (a refusal that reads again). */
  readonly onReload: () => void
  /** F-SA-241: the done view's primary button — Close (a door, the default) or Next request › (Home › Approvals). */
  readonly doneNext?: 'close' | 'next'
}

// ---- F-SA-241: Stop now's production hold — the office's note, the words the customer reads beside "On hold" in its language ----
const STOP_REASON = 'OTHER'
const stopNote = (order: string): string => `Stopped at the order change of ${order}: no new bundle until planning decides.`
const STOP_WORDS = { en: 'Paused while your change is carried out.', it: 'In pausa mentre eseguiamo la vostra modifica.' } as const
const NO_TELL: TellTick = Object.freeze({ chosen: null, reach: 'portal', sent: 'no', compose: null })
// ---- end F-SA-241

const loadedOf = <T,>(result: PromiseSettledResult<T>): Loaded<T> => {
  if (result.status === 'fulfilled') return { status: 'ready', value: result.value }
  const error = result.reason
  if (isApiError(error) && error.kind === 'not_found') return { status: 'not_found' }
  if (isApiError(error) && error.kind === 'forbidden') return { status: 'forbidden' }
  return { status: 'error', problem: readProblem(error) }
}

/** Today in the company's zone (`YYYY-MM-DD`): the first date a counter-offer may name. */
export const todayIn = (now: Date, timeZone: string = DEFAULT_TIME_ZONE): string => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

export function useRequestReview(host: RequestReviewHost): { readonly model: RequestReviewModel | null; readonly actions: RequestActions; readonly busy: boolean; readonly refresh: () => void } {
  const { api, openId, openAs } = host
  const hostRef = useRef(host)
  hostRef.current = host
  const [record, setRecord] = useState<{ id: string; value: Loaded<RequestRecord> } | null>(null)
  const [impact, setImpact] = useState<{ id: string; value: Loaded<RequestImpactRead> } | null>(null)
  const [batch, setBatch] = useState<{ id: string; value: Loaded<readonly BrandRequest[]> } | null>(null)
  const [words, setWords] = useState('')
  const [dialog, setDialog] = useState<RequestDialog | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // ---- F-SA-241 / F-SA-242: the plan, the choices, the done view and its commands' keys, the conversation tick ----
  const [plan, setPlan] = useState<{ id: string; value: Loaded<ApplyPlan> } | null>(null)
  const [choices, setChoices] = useState<ApplyChoices>(NO_CHOICES)
  const [done, setDone] = useState<(DoneView & { readonly id: string; readonly then: string | null }) | null>(null)
  const [tell, setTell] = useState<TellTick>(NO_TELL)
  const [portalGone, setPortalGone] = useState(false)
  const commandKeys = useRef(new Map<string, string>())
  // ---- end F-SA-241 / F-SA-242

  const read = useCallback(async () => {
    if (!openId || !openAs) return
    if (openAs === 'request') {
      setRecord((current) => (current?.id === openId && current.value.status === 'ready' ? current : { id: openId, value: { status: 'loading' } }))
      setImpact((current) => (current?.id === openId && current.value.status === 'ready' ? current : { id: openId, value: { status: 'loading' } }))
      // One after another is not needed: two reads of the API, each its own answer (the impact may fail alone: the request still draws).
      // F-SA-241: the apply plan beside them (orders.view; it may fail alone: the window draws today's "What accepting does").
      setPlan((current) => (current?.id === openId && current.value.status === 'ready' ? current : { id: openId, value: { status: 'loading' } }))
      const [request, effect, steps] = await Promise.allSettled([getRequest(api, openId), getImpact(api, openId), getApplyPlan(api, openId)])
      setRecord({ id: openId, value: loadedOf(request) })
      setImpact({ id: openId, value: loadedOf(effect) })
      setPlan({ id: openId, value: loadedOf(steps) })
      return
    }
    setBatch((current) => (current?.id === openId && current.value.status === 'ready' ? current : { id: openId, value: { status: 'loading' } }))
    const [requests] = await Promise.allSettled([listBatch(api, openId)])
    // A batch nobody of it is reached of reads empty: the same "not found" as another customer's request (PW-12, PW-H01b).
    setBatch({ id: openId, value: requests.status === 'fulfilled' && requests.value.length === 0 ? { status: 'not_found' } : loadedOf(requests) })
  }, [api, openId, openAs])

  // F-SA-241: the window's own state is kept while the SAME id stays open (a list read again after Accept may ask again what it is:
  // the done view must not be lost under it); another id — or the window closed — starts afresh.
  const shownId = useRef<string | null>(null)
  useEffect(() => {
    if (shownId.current !== openId) {
      shownId.current = openId
      setWords('')
      setDialog(null)
      setProblem(null)
      // F-SA-241 / F-SA-242: another request opens with nothing chosen and no done view.
      setChoices(NO_CHOICES)
      setDone(null)
      setTell(NO_TELL)
      setPortalGone(false)
      commandKeys.current.clear()
    }
    void read()
  }, [read, openId])

  const request = record && record.id === openId && record.value.status === 'ready' ? record.value.value.request : null
  const answered = (notice: RequestNotice, from: BrandRequest | null) => {
    const others = from?.batch && from.batch.waiting > 1 && from.batchId ? from.batchId : null
    hostRef.current.onAnswered({ id: openId ?? '', notice, then: others })
  }
  const failed = (error: unknown) => {
    const found = answerProblem(error)
    setProblem(found.key)
    if (found.reload) {
      void read()
      hostRef.current.onReload()
    }
  }

  // ---- F-SA-242: the words in the order's conversation (the thread's own portal reply, one key), after the answer took ----
  const tellNow = async (about: BrandRequest, text: string): Promise<TellTick['sent']> => {
    setTell((now) => ({ ...now, sent: 'sending' }))
    try {
      await postPortalReplyKeyed(api, { type: 'SalesOrder', id: about.orderId }, { body: text.trim(), attachments: [] }, newIdempotencyKey())
      setTell((now) => ({ ...now, sent: 'sent', compose: null }))
      return 'sent'
    } catch (error) {
      const key = tellRefusalOf(portalRefusal(error))
      if (key === `${CR}.tell.held.reach`) setPortalGone(true)
      const sent = { refused: key }
      setTell((now) => ({ ...now, sent }))
      return sent
    }
  }
  const currentTell = (): TellTick => ({ ...tell, reach: request ? reachOf(request, portalGone) : 'none' })

  // ---- F-SA-241: after Accept, each next step's own command — Stop now's hold, a work-order change carried out ----
  const keyOf = (command: DoneCommand): string => {
    const known = commandKeys.current.get(command.key)
    if (known) return known
    const key = newIdempotencyKey()
    commandKeys.current.set(command.key, key)
    return key
  }
  const runCommand = async (about: BrandRequest, command: DoneCommand): Promise<CommandState> => {
    try {
      if (command.kind === 'stop') {
        const language = await readMessageLanguage(api, about.party.id).catch(() => null)
        await placeProductionHold(api, command.workOrder.id, { reasonCode: STOP_REASON, note: stopNote(about.orderNumber), brandWords: language === 'it' ? STOP_WORDS.it : STOP_WORDS.en }, keyOf(command))
        return { phase: 'done' }
      }
      const change = await getWorkOrderChange(api, command.changeId)
      if (change.status === 'APPLIED') return { phase: 'done' }
      if (change.status !== 'PROPOSED') return { phase: 'refused', key: 'workOrderChange.refusal.DECIDED' }
      await applyWorkOrderChange(api, command.changeId, { version: change.version }, keyOf(command))
      return { phase: 'done' }
    } catch (error) {
      // A refusal of the rules: the next try is a new command (a new key); a lost answer keeps its key (never done twice).
      if (isApiError(error)) commandKeys.current.delete(command.key)
      if (command.kind === 'stop') return { phase: 'refused', key: `${CR}.next.refused.stop`, params: { order: command.workOrder.number } }
      const found = changeProblemOf(error)
      return { phase: 'refused', key: found.key, params: { lay: found.lay ?? '', order: command.workOrder?.number ?? '' } }
    }
  }
  const run = async (commands: readonly DoneCommand[]) => {
    if (!request || commands.length === 0) return
    const about = request
    setDone((now) => (now ? { ...now, running: true } : now))
    await runInOrder(
      commands,
      (command) => runCommand(about, command),
      (key, state) => setDone((now) => (now ? { ...now, states: { ...now.states, [key]: state } } : now)),
    )
    setDone((now) => (now ? { ...now, running: false } : now))
    // What the steps did shows in the plan read again (Done, Your turn …); the door's record read again too.
    if (openId) void getApplyPlan(api, openId).then((value) => setPlan({ id: openId, value: { status: 'ready', value } })).catch(() => undefined)
    hostRef.current.onReload()
  }
  // ---- end F-SA-241

  const accept = async (rushFloor: boolean) => {
    if (!request || busy) return
    setBusy(true)
    setProblem(null)
    const tick = currentTell()
    const told = tellsNow(tick, words)
    try {
      if (request.answeredIn === 'SALES') {
        // F-SA-241: the extra pieces' outcome chosen in the window goes with the Accept (B-SA-042); Stop now runs right after it.
        const accepted = await acceptSales(api, request.id, { version: request.version, answer: words, extraOutcome: choices.extraOutcome })
        const notice: RequestNotice = { key: 'notice.requestAccepted', tone: 'success', request: noticeFactsOf(request), lines: doneWordsOf(accepted) }
        const then = request.batch && request.batch.waiting > 1 && request.batchId ? request.batchId : null
        // The plan after Accept: what was done, what each next step is now (its record named).
        const after = await getApplyPlan(api, request.id).catch(() => null)
        if (after && openId) setPlan({ id: openId, value: { status: 'ready', value: after } })
        const known = plan?.id === openId && plan.value.status === 'ready' ? plan.value.value : null
        const stops = stoppableOf(known).filter((workOrder) => choices.stops.includes(workOrder.id))
        // F-OP-116 (R-17): what Accept already carried out is never applied again; B1: the applies first, the stops after.
        const commands = doneCommandsOf(after, stops, (accepted.workOrders?.applied ?? []).map((entry) => entry.changeId))
        setDone({ id: openId ?? request.id, then, notice: { key: notice.key, tone: notice.tone, lines: notice.lines ?? [] }, next: hostRef.current.doneNext ?? 'close', commands, states: {}, running: false })
        hostRef.current.onReload()
        // The request read again (it reads Accepted now); the done view stays over it.
        void read()
        if (told) void tellNow(request, words)
        // Stop now: the holds go at once, each its own command, stopping at the first refusal — F-OP-116 (B1): after the changes this
        // reader carries out now, so a hold never makes its own work order refuse them.
        const stopNow = atAcceptOf(commands)
        if (stopNow.length > 0) void run(stopNow)
      } else {
        const accepted = await acceptProduction(api, request.id, { version: request.version, answer: words, ...(hasTwoAccepts(request) ? { rushFloor } : {}) })
        const followUp = followUpOf(request.id, accepted)
        // F-SA-242: the words written in the conversation too, when ticked (said beside the notice).
        const sent = told ? await tellNow(request, words) : 'no'
        answered({ key: hasTwoAccepts(request) && rushFloor ? 'notice.requestRushed' : 'notice.requestAccepted', tone: 'success', request: noticeFactsOf(request), lines: [...doneWordsOf(accepted), ...tellLines(sent)], ...(followUp ? { followUp } : {}) }, request)
      }
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
    }
  }

  const refuse = async () => {
    if (!request || busy || words.trim() === '') return
    setBusy(true)
    setProblem(null)
    const told = tellsNow(currentTell(), words)
    try {
      await refuseRequest(api, request, { version: request.version, answer: words })
      // F-SA-242: the same words in the order's conversation, when ticked (said beside the notice).
      const sent = told ? await tellNow(request, words) : 'no'
      answered({ key: 'notice.requestRefused', tone: 'success', request: noticeFactsOf(request), lines: tellLines(sent) }, request)
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
    }
  }

  const counter = async (draft: CounterDraft) => {
    if (!request) return
    setBusy(true)
    setDialog({ kind: 'counter', busy: true, problem: null })
    try {
      await counterRequest(api, request.id, counterBodyOf(draft, request.version, hostRef.current.price && request.may.counterWithPrice))
      setDialog(null)
      answered({ key: 'notice.requestCountered', tone: 'success', request: noticeFactsOf(request) }, request)
    } catch (error) {
      const found = answerProblem(error)
      setDialog({ kind: 'counter', busy: false, problem: found.key })
      if (found.reload) {
        void read()
        hostRef.current.onReload()
      }
    } finally {
      setBusy(false)
    }
  }

  // ---- a batch: read again, each checked, the current ones answered one by one --------------------------------------------------
  const batchRead = async (answer: 'accept' | 'refuse', rushFloor: boolean) => {
    if (!openId) return
    setDialog({ kind: 'batch', answer, rushFloor, lines: null, state: { phase: 'reading' } })
    try {
      const now = await listBatch(api, openId)
      setBatch({ id: openId, value: now.length === 0 ? { status: 'not_found' } : { status: 'ready', value: now } })
      // F-CP-160: a priced counter-offer is left out for a reader without the price grain (in the money wall's words).
      setDialog({ kind: 'batch', answer, rushFloor, lines: batchLinesOf(now, answer, hostRef.current.price), state: { phase: 'ready' } })
    } catch (error) {
      setDialog({ kind: 'batch', answer, rushFloor, lines: null, state: { phase: 'failed', problem: answerProblem(error).key } })
    }
  }
  const batchSend = async () => {
    if (!openId || dialog?.kind !== 'batch' || !dialog.lines || busy) return
    const current = dialog
    const items = batchItemsOf(current.lines!)
    if (items.length === 0 || (current.answer === 'refuse' && words.trim() === '')) return
    // One kind per batch: rushFloor is sent only for a batch of "Urgent – asked" (any other kind refuses the field, even false).
    const lead = batch?.id === openId && batch.value.status === 'ready' ? batch.value.value[0] : undefined
    const rush = lead !== undefined && hasTwoAccepts(lead)
    setBusy(true)
    setDialog({ ...current, state: { phase: 'saving' } })
    const key = newIdempotencyKey()
    try {
      const result = current.answer === 'accept' ? await acceptBatch(api, openId, { items, answer: words, ...(rush ? { rushFloor: current.rushFloor } : {}) }, key) : await refuseBatch(api, openId, { items, answer: words }, key)
      setDialog({ ...current, state: { phase: 'done', results: batchResultsOf(result) } })
    } catch (error) {
      const refusals = batchRefusalsOf(error, items)
      setDialog({ ...current, state: refusals ? { phase: 'done', results: refusals } : { phase: 'failed', problem: answerProblem(error).key } })
    } finally {
      setBusy(false)
      hostRef.current.onReload()
    }
  }
  const closeDialog = () => {
    const current = dialog
    setDialog(null)
    if (current?.kind !== 'batch' || current.state.phase !== 'done') return
    const results = Object.values(current.state.results)
    const done = results.filter((result) => result.ok).length
    const lead = batch?.value.status === 'ready' ? (batch.value.value[0] ?? null) : null
    if (done === 0 || !lead) {
      void read()
      return
    }
    hostRef.current.onAnswered({ id: openId ?? '', notice: { key: current.answer === 'accept' ? 'notice.batchAccepted' : 'notice.batchRefused', tone: done === results.length ? 'success' : 'warning', params: { done, count: results.length }, request: batchFactsOf(lead) }, then: null })
  }

  const actions: RequestActions = {
    onWords: setWords,
    onAccept: (rushFloor) => void accept(rushFloor),
    onRefuse: () => void refuse(),
    onCounter: () => setDialog({ kind: 'counter', busy: false, problem: null }),
    onCounterSend: (draft) => void counter(draft),
    onBatch: (answer, rushFloor) => void batchRead(answer, rushFloor),
    onBatchConfirm: () => void batchSend(),
    onCloseDialog: closeDialog,
    onRetry: () => void read(),
    // ---- F-SA-241 ----
    onExtraOutcome: (outcome) => setChoices((now) => ({ ...now, extraOutcome: outcome })),
    onWorkChoice: (workOrderId, choice) => setChoices((now) => ({ ...now, stops: choice === 'STOP' ? [...new Set([...now.stops, workOrderId])] : now.stops.filter((id) => id !== workOrderId) })),
    onRunStep: (key) => {
      const command = done?.commands.find((entry) => entry.key === key)
      if (command && !done?.running) void run([command])
    },
    onRunAll: () => {
      if (done && !done.running) void run(leftToRun(done.commands, done.states))
    },
    onDoneClose: () => {
      const finished = done
      if (!finished) return
      setDone(null)
      hostRef.current.onAnswered({ id: finished.id, notice: { ...finished.notice, ...(request ? { request: noticeFactsOf(request) } : {}) }, then: finished.then })
    },
    // ---- F-SA-242 ----
    onTell: (on) => setTell((now) => ({ ...now, chosen: on })),
    onTellOpen: () => setTell((now) => ({ ...now, compose: words.trim() })),
    onTellWords: (text) => setTell((now) => (now.compose === null ? now : { ...now, compose: text })),
    onTellSend: () => {
      const text = tell.compose ?? ''
      if (!request || text.trim() === '' || tell.sent === 'sending') return
      void tellNow(request, text)
    },
    onTellClose: () => setTell((now) => ({ ...now, compose: null })),
  }

  const common = {
    id: openId ?? '',
    words,
    dialog,
    problem,
    orderHrefs: orderHrefsOf(request ? [request] : batch?.value.status === 'ready' ? batch.value.value : [], host.orderHref),
    today: todayIn(new Date()),
    can: { lift: host.mayLift },
  }
  const model: RequestReviewModel | null =
    !openId || !openAs
      ? null
      : openAs === 'request'
        ? {
            ...common,
            as: 'request',
            record: record?.id === openId ? record.value : { status: 'loading' },
            impact: impact?.id === openId ? impact.value : { status: 'loading' },
            // F-SA-241 / F-SA-242
            plan: plan?.id === openId ? plan.value : { status: 'loading' },
            choices,
            tell: { ...tell, reach: request ? reachOf(request, portalGone) : tell.reach },
            done: done && done.id === openId ? done : null,
          }
        : { ...common, as: 'batch', batch: batch?.id === openId ? batch.value : { status: 'loading' } }
  return { model, actions, busy, refresh: () => void read() }
}

const orderHrefsOf = (requests: readonly Pick<BrandRequest, 'orderId' | 'orderNumber' | 'companyId'>[], href: RequestReviewHost['orderHref']): Record<string, string> => Object.fromEntries(requests.map((request) => [request.orderId, href(request)]))

// ---- `?open=<id>` of a request not listed: what it is ---------------------------------------------------------------------------

/**
 * An id the address opens that no listed row names (a link from the work order's Customer card, the bell, Sales › Incoming): an
 * approval request of the engine, a customer request, or a customer's batch — asked in that order, each only with its read right. An
 * id none of them knows (or another customer's, PW-H01b: the API's "not found") opens the window's neutral "not found".
 */
export async function probeOpen(api: ApiClient, id: string, can: { readonly tasks: boolean; readonly requests: boolean; /* F-SA-245 */ readonly changes?: boolean }): Promise<'task' | 'request' | 'batch' | 'change' | 'none'> {
  if (can.tasks) {
    try {
      await getTask(api, id)
      return 'task'
    } catch (error) {
      // Not an engine request: try the customer's; any other failure is the task review's to say (with Try again).
      if (!(isApiError(error) && error.kind === 'not_found')) return 'task'
    }
  }
  if (can.requests) {
    try {
      await getRequest(api, id)
      return 'request'
    } catch (error) {
      if (!(isApiError(error) && error.kind === 'not_found')) return 'request'
    }
    try {
      if ((await listBatch(api, id)).length > 0) return 'batch'
    } catch {
      // Not a batch either.
    }
  }
  // F-SA-245: a work-order change (the bell's link, the work order's band): its decide window; another customer's answers 404.
  if (can.changes) {
    try {
      await getWorkOrderChange(api, id)
      return 'change'
    } catch (error) {
      if (!(isApiError(error) && error.kind === 'not_found')) return 'change'
    }
  }
  return 'none'
}

// ---- the follow-ups (R-23): Lift the hold, Clear rush -----------------------------------------------------------------------------

/**
 * Lift the hold: on each work order the accepted pause held, the customer's own holds of THIS request (BRAND, standing, its request
 * id) lifted with why — a work order still held by another hold stays held under it. Each work order on its own: one that fails is
 * named, the others go on.
 */
export async function liftCustomerPause(api: ApiClient, followUp: FollowUp, reason: string): Promise<{ readonly lifted: string[]; readonly none: string[]; readonly failed: string[] }> {
  const lifted: string[] = []
  const none: string[] = []
  const failed: string[] = []
  for (const workOrder of followUp.workOrders) {
    try {
      const read = await listProductionHolds(api, workOrder.id)
      const holds = read.holds.filter((hold) => hold.kind === 'BRAND' && hold.status === 'ACTIVE' && hold.requestId === followUp.requestId)
      if (holds.length === 0) {
        none.push(workOrder.number)
        continue
      }
      for (const hold of holds) await liftProductionHold(api, workOrder.id, hold.id, { version: hold.version, reason: reason.trim() })
      lifted.push(workOrder.number)
    } catch {
      failed.push(workOrder.number)
    }
  }
  return { lifted, none, failed }
}

/** Clear rush: the rush flag off on the work orders this accept rushed (each read first for its version; one not rushed any more is left). */
export async function clearRush(api: ApiClient, followUp: FollowUp): Promise<{ readonly cleared: string[]; readonly failed: string[] }> {
  const cleared: string[] = []
  const failed: string[] = []
  for (const workOrder of followUp.workOrders) {
    try {
      const now = await getWorkOrder(api, workOrder.id)
      if (now.rush) await updateWorkOrder(api, workOrder.id, { version: now.version, rush: false })
      cleared.push(workOrder.number)
    } catch {
      failed.push(workOrder.number)
    }
  }
  return { cleared, failed }
}

// ---- F-SA-242: what became of the words in the conversation, said beside the notice ----
function tellLines(sent: TellTick['sent']): Words[] {
  if (sent === 'sent') return [{ en: 'Also written in the order’s conversation.', it: 'Scritto anche nella conversazione dell’ordine.' }]
  if (typeof sent === 'object') return [{ en: 'Not written in the order’s conversation: write it there.', it: 'Non scritto nella conversazione dell’ordine: scrivilo lì.' }]
  return []
}
// ---- end F-SA-242
