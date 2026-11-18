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
  /** The order's page (with the company prefix). */
  readonly orderHref: (request: Pick<BrandRequest, 'orderId' | 'orderNumber' | 'companyId'>) => string
  /** The reader may lift a customer's pause (workorders.hold). */
  readonly mayLift: boolean
  /** After an answer: the notice, and what opens next (the batch the request came from while others of it wait; else the next row). */
  readonly onAnswered: (answered: { readonly id: string; readonly notice: RequestNotice; readonly then: string | null }) => void
  /** The list changed under the window (a refusal that reads again). */
  readonly onReload: () => void
}

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

  const read = useCallback(async () => {
    if (!openId || !openAs) return
    if (openAs === 'request') {
      setRecord((current) => (current?.id === openId && current.value.status === 'ready' ? current : { id: openId, value: { status: 'loading' } }))
      setImpact((current) => (current?.id === openId && current.value.status === 'ready' ? current : { id: openId, value: { status: 'loading' } }))
      // One after another is not needed: two reads of the API, each its own answer (the impact may fail alone: the request still draws).
      const [request, effect] = await Promise.allSettled([getRequest(api, openId), getImpact(api, openId)])
      setRecord({ id: openId, value: loadedOf(request) })
      setImpact({ id: openId, value: loadedOf(effect) })
      return
    }
    setBatch((current) => (current?.id === openId && current.value.status === 'ready' ? current : { id: openId, value: { status: 'loading' } }))
    const [requests] = await Promise.allSettled([listBatch(api, openId)])
    // A batch nobody of it is reached of reads empty: the same "not found" as another customer's request (PW-12, PW-H01b).
    setBatch({ id: openId, value: requests.status === 'fulfilled' && requests.value.length === 0 ? { status: 'not_found' } : loadedOf(requests) })
  }, [api, openId, openAs])

  useEffect(() => {
    setWords('')
    setDialog(null)
    setProblem(null)
    void read()
  }, [read])

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

  const accept = async (rushFloor: boolean) => {
    if (!request || busy) return
    setBusy(true)
    setProblem(null)
    try {
      if (request.answeredIn === 'SALES') {
        const done = await acceptSales(api, request.id, { version: request.version, answer: words })
        answered({ key: 'notice.requestAccepted', tone: 'success', request: noticeFactsOf(request), lines: doneWordsOf(done) }, request)
      } else {
        const done = await acceptProduction(api, request.id, { version: request.version, answer: words, ...(hasTwoAccepts(request) ? { rushFloor } : {}) })
        const followUp = followUpOf(request.id, done)
        answered({ key: hasTwoAccepts(request) && rushFloor ? 'notice.requestRushed' : 'notice.requestAccepted', tone: 'success', request: noticeFactsOf(request), lines: doneWordsOf(done), ...(followUp ? { followUp } : {}) }, request)
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
    try {
      await refuseRequest(api, request, { version: request.version, answer: words })
      answered({ key: 'notice.requestRefused', tone: 'success', request: noticeFactsOf(request) }, request)
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
      setDialog({ kind: 'batch', answer, rushFloor, lines: batchLinesOf(now, answer), state: { phase: 'ready' } })
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
        ? { ...common, as: 'request', record: record?.id === openId ? record.value : { status: 'loading' }, impact: impact?.id === openId ? impact.value : { status: 'loading' } }
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
export async function probeOpen(api: ApiClient, id: string, can: { readonly tasks: boolean; readonly requests: boolean }): Promise<'task' | 'request' | 'batch' | 'none'> {
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
