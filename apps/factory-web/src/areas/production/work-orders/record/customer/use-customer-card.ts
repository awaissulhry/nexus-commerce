'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import { getProductionLimits } from '../../../../admin/users/partners/api'
import { isStepUpCancelled } from '../../../../quality/_shared/hooks'
import type { WorkOrder } from '../../../_shared/api'
import { readProblem, type Phrase } from '../../../_shared/model'
import { getCustomerUrgency, listCustomerIssues, listOrderApprovals, listOrderRequests, setBackUrgency, unlockUrgency } from './api'
import { cardCustomersOf, urgencyOutcomeOf, urgencyProblemOf, type CardPart, type CustomerBlock, type CustomerCardActions, type CustomerCardModel, type UrgencyDialog, type UrgencyOutcome } from './model'

const LOADING = { value: null, problem: null } as const

/** The page's step-up guard (quality/_shared/hooks useStepUp): asks a fresh code when the API wants one, then runs the write again. */
type Guard = <T>(sentence: string, work: () => Promise<T>) => Promise<T>

/**
 * F-PR-05b — the Customer card's container part (the view draws it and fetches nothing): while the Overview shows, per customer of the
 * work order (its own only, PW-07) its requests and approvals on these orders, its urgency, its open problems and its limits — each
 * read once per read of the work order (its version), each failing on its own (Try again) — and the urgency writes: Set to regular,
 * Lock, Unlock (production.brand.override; the page's step-up asks a fresh code; no second person). After a write the card reads
 * again and says per order what was done.
 */
export function useCustomerCard(api: ApiClient, workOrder: WorkOrder | null, permissions: readonly string[], enabled: boolean, guard: Guard, onNotice: (words: Phrase) => void): { model: CustomerCardModel | null; actions: CustomerCardActions } {
  const customers = useMemo(() => (workOrder ? cardCustomersOf(workOrder) : []), [workOrder])
  const key = customers.map((customer) => `${customer.partyId}:${customer.orders.map((order) => order.id).join(',')}`).join('|')
  const approvalsView = permissions.includes('partners.approvals.view')
  const partnersView = permissions.includes('partners.view')
  const [blocks, setBlocks] = useState<CustomerBlock[]>([])
  const [dialog, setDialog] = useState<UrgencyDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Phrase | null>(null)
  const [outcome, setOutcome] = useState<UrgencyOutcome | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const turn = useRef(0)
  const noticeRef = useRef(onNotice)
  noticeRef.current = onNotice

  const read = useCallback(() => {
    const mine = ++turn.current
    setNow(Date.now())
    setBlocks(customers.map((customer) => ({ customer, requests: LOADING, approvals: approvalsView ? LOADING : null, urgency: LOADING, issues: LOADING, limits: partnersView ? LOADING : null })))
    const patch = (partyId: string, part: Partial<Omit<CustomerBlock, 'customer'>>) => {
      if (mine === turn.current) setBlocks((current) => current.map((block) => (block.customer.partyId === partyId ? { ...block, ...part } : block)))
    }
    const failed = (error: unknown): CardPart<never> => ({ value: null, problem: readProblem(error) })
    for (const customer of customers) {
      const ids = customer.orders.map((order) => order.id)
      Promise.all(ids.map((orderId) => listOrderRequests(api, orderId)))
        .then((lists) => patch(customer.partyId, { requests: { value: lists.flat(), problem: null } }))
        .catch((error: unknown) => patch(customer.partyId, { requests: failed(error) }))
      if (approvalsView)
        Promise.all(ids.map((orderId) => listOrderApprovals(api, orderId)))
          .then((lists) => patch(customer.partyId, { approvals: { value: lists.flat(), problem: null } }))
          .catch((error: unknown) => patch(customer.partyId, { approvals: failed(error) }))
      getCustomerUrgency(api, customer.partyId)
        .then((value) => patch(customer.partyId, { urgency: { value, problem: null } }))
        .catch((error: unknown) => patch(customer.partyId, { urgency: failed(error) }))
      listCustomerIssues(api, customer.partyId)
        .then((value) => patch(customer.partyId, { issues: { value, problem: null } }))
        .catch((error: unknown) => patch(customer.partyId, { issues: failed(error) }))
      if (partnersView)
        getProductionLimits(api, customer.partyId)
          .then((value) => patch(customer.partyId, { limits: { value, problem: null } }))
          .catch((error: unknown) => patch(customer.partyId, { limits: failed(error) }))
    }
  }, [api, key, approvalsView, partnersView])

  useEffect(() => {
    if (enabled && customers.length > 0) read()
  }, [enabled, read, workOrder?.version])

  const actions: CustomerCardActions = {
    onDialog: (next) => {
      setProblem(null)
      setDialog(next)
    },
    onUrgency: (input) => {
      if (busy) return
      setBusy(true)
      setProblem(null)
      const orderIds = input.orders.map((order) => order.id)
      const idempotencyKey = newIdempotencyKey()
      guard('stepUp.urgencySentence', () => (input.act === 'unlock' ? unlockUrgency(api, { orderIds }, idempotencyKey) : setBackUrgency(api, { orderIds, reason: input.reason.trim(), lock: input.act === 'lock' || input.lock }, idempotencyKey)))
        .then((answer) => {
          const done = urgencyOutcomeOf(input.act, answer, input.orders)
          setOutcome(done)
          setDialog(null)
          noticeRef.current({ key: `customerCard.urgency.notice.${input.act}`, params: { count: done.done.length } })
          read()
        })
        .catch((error: unknown) => {
          if (!isStepUpCancelled(error)) {
            setProblem(urgencyProblemOf(error))
            read()
          }
        })
        .finally(() => setBusy(false))
    },
    onDismissOutcome: () => setOutcome(null),
    onRetry: read,
  }

  // Before the first read answers (or after the work order's customers changed), every part reads as loading, never as empty.
  const shown = blocks.length === customers.length && blocks.every((block, index) => block.customer.partyId === customers[index]!.partyId) ? blocks : customers.map((customer) => ({ customer, requests: LOADING, approvals: approvalsView ? LOADING : null, urgency: LOADING, issues: LOADING, limits: partnersView ? LOADING : null }))
  return { model: customers.length === 0 ? null : { blocks: shown, dialog, busy, problem, outcome, now }, actions }
}
