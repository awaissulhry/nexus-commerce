'use client'

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { applyMoneyPlan, fromDdtsCandidates, getSdi, previewMoneyPlan, recordDepositPayment, sendDepositLink, sendToSdi, undoDepositPayment, type DepositLinkAnswer, type DepositReceived, type MoneyPlanBody, type Order, type SdiStatus } from '../api'
import type { useStepUp } from '../hooks'
import { readProblem } from '../model'
// B-W2a-80: the schedule card's verbs (B-W2a-F2's note): open a before-shipping step, invoice a paid step.
import { useScheduleSteps } from './schedule/use-schedule-steps'
import type { MoneyPlanState, OrderRecordActions, OrderRecordModel, Part, RecordActsBase, RecordDialog } from './record-model'
// ---- F-OM-201 / 202 ----
import { listTerms, type PaymentTerms } from '../../../finance/settings/terms/api'
import { getParty, type PartyContact } from '../../quotes/api'
import { fromDdtsHref } from '../list/sheet/overall'
import { planRefusalOf, softLockedOf, type PlanRefusal } from './money/plan'
// ---- end F-OM-201 / 202
import { isApiError } from '../../../../lib/api/errors' // F-OM-301: a check that moved meanwhile is read again
import { acceptPriceDifference, undoPriceAcceptance } from '../price-check/api' // F-OM-301 (B-OM-020)

export type MoneyActsModel = Pick<OrderRecordModel, 'sentLink' | 'recorded' | 'scheduleSteps' | 'moneyPlan'>
export type MoneyActsActions = Pick<OrderRecordActions, 'onSendLink' | 'onRecordPayment' | 'onSendSdi' | 'scheduleSteps' | 'onPlanPreview' | 'onPlanAct' | 'onUndoPayment' | 'onPriceAccept' | 'onPriceUnaccept'>

/**
 * F-OP-134 (N-5): the Money tab's acts — the deposits and payments: the bank-details page, the payment (with the TD02: a fresh
 * authenticator code), the TD02's send to SDI, and the payment schedule's verbs (B-W2a-80). Mounted by the container
 * (OrderRecord.tsx), which hands what it returns to the view as plain props; a view never imports it. Each SDI state is the
 * container's read (it reads them with the order's parts); a send puts its answer in place.
 *
 * F-OM-201 / 202 (order MONEY tab): + the plan's hand windows — the act's preview (before → after, read again as it is typed; an
 * older answer: none), the act through the page's one write (a fresh code when the server asks one: the terms always), its refusal
 * in this page's words; Undo this payment…; the customer's contacts for Send the page… (parties.view); the payment terms library
 * for Change payment terms… (paymentterms.view); a SOFT-locked month's reason when the API asks it; "Invoice shipped goods…" (this
 * order's DDTs not yet invoiced: Finance's own From-DDTs window, invoices.manage).
 */
export function useMoneyActs(
  input: RecordActsBase & {
    readonly permissions: readonly string[]
    readonly sdi: Record<string, Part<SdiStatus>> | null
    readonly setSdi: Dispatch<SetStateAction<Record<string, Part<SdiStatus>> | null>>
    /** The record's step-up (a fresh authenticator code before the TD02, the SDI send and a waive). */
    readonly stepUp: Pick<ReturnType<typeof useStepUp>, 'ensureFresh' | 'guard'>
    /** A paid step was invoiced: its TD02 draft opens in Finance (the container goes there). */
    readonly onInvoiced: (invoiceId: string) => void
    /** F-OM-203: the order as read (its shipped DDTs not yet invoiced are looked up for "Invoice shipped goods…"); null: not read. */
    readonly order: Order | null
    readonly prefix: string
    /** F-OM-301 / 302: Money's own reads that a write here changes (the price check, the margin): read again after it. */
    readonly rereads?: { readonly priceCheck?: () => void; readonly margin?: () => void }
  },
): { model: MoneyActsModel; actions: MoneyActsActions; opened: (next: RecordDialog | null) => void } {
  const { api, orderId, current, write, setNotice, loadParts, permissions, sdi, setSdi, stepUp, onInvoiced, order, prefix, rereads } = input
  const { ensureFresh, guard } = stepUp
  const [sentLink, setSentLink] = useState<DepositLinkAnswer | null>(null)
  const [recorded, setRecorded] = useState<DepositReceived | null>(null)
  // ---- F-OM-201 / 202 ----
  const [preview, setPreview] = useState<MoneyPlanState['preview']>(null)
  const [refused, setRefused] = useState<PlanRefusal | null>(null)
  const [terms, setTerms] = useState<Part<PaymentTerms[]> | null>(null)
  const [contacts, setContacts] = useState<Part<PartyContact[]> | null>(null)
  const [lockAsked, setLockAsked] = useState(false)
  const [invoiceShipped, setInvoiceShipped] = useState<MoneyPlanState['invoiceShipped']>(null)
  const previewRead = useRef<AbortController | null>(null)
  const mayInvoice = permissions.includes('invoices.manage')

  // "Invoice shipped goods…": only while the order's settlement says shipped goods wait for their invoice (and the reader drafts them).
  const waitsForInvoice = !!order && mayInvoice && order.settlement.missing.some((gap) => gap.code === 'NOT_INVOICED')
  const orderKey = order ? `${order.id}:${order.version}` : null
  useEffect(() => {
    if (!waitsForInvoice || !order) {
      setInvoiceShipped(null)
      return
    }
    const abort = new AbortController()
    fromDdtsCandidates(api, [order.id], abort.signal)
      .then((answer) => {
        const draft = answer.drafts.find((entry) => entry.orders.some((other) => other.id === order.id) && entry.body.ddtIds.length > 0) ?? null
        setInvoiceShipped(draft ? { href: fromDdtsHref(prefix, draft) } : null)
      })
      .catch(() => setInvoiceShipped(null))
    return () => abort.abort()
    // The read follows the order's id and version (a new shipment or invoice moves it), not each new object of the same read.
  }, [api, orderKey, waitsForInvoice, prefix])
  // ---- end F-OM-201 / 202

  // B-W2a-80: the schedule card's verbs (B-W2a-F2's note): open a before-shipping step, invoice a paid step.
  const scheduleSteps = useScheduleSteps({
    api,
    orderId,
    permissions,
    reload: () => {
      const value = current.current
      if (value) loadParts(value)
    },
    onNotice: (words, tone) => setNotice({ tone, words }),
    onInvoiced,
    // B-W2b-16: the owner's waive asks a fresh code (the record's step-up).
    stepUp: { ensureFresh, guard },
  })

  const actions: MoneyActsActions = {
    scheduleSteps: scheduleSteps.actions,
    onSendLink: (requestId, message, contactId) =>
      void write(
        async () => {
          setSentLink(await sendDepositLink(api, requestId, message, contactId))
          return null
        },
        null,
        true,
      ),
    onRecordPayment: (requestId, input) => {
      // One key for the write and its repeat after the code: the API answers the second from its receipt.
      const key = newIdempotencyKey()
      // F-OM-202 (P1-B1): a SOFT-locked month's reason goes with it once the window asked one.
      const body = { depositRequestId: requestId, amount: input.amount, receivedOn: input.receivedOn, externalRef: input.reference, internalNote: input.note || null, issueDepositInvoice: input.issue, ...(input.lockReason?.trim() ? { periodLockOverride: { reason: input.lockReason.trim() } } : {}) }
      void write(
        async () => {
          try {
            if (input.issue) await ensureFresh('stepUp.sentence.td02')
            setRecorded(await guard('stepUp.sentence.td02', () => recordDepositPayment(api, body, key)))
          } catch (error) {
            if (softLockedOf(error)) setLockAsked(true)
            throw error
          }
          return null
        },
        null,
        true,
      )
    },
    onSendSdi: (invoiceId) => {
      const key = newIdempotencyKey()
      void write(
        async () => {
          const before = sdi?.[invoiceId]?.value ?? (await getSdi(api, invoiceId))
          await ensureFresh('stepUp.sentence.sdi')
          const answer = await guard('stepUp.sentence.sdi', () => sendToSdi(api, invoiceId, before.version, key))
          setSdi((known) => ({ ...(known ?? {}), [invoiceId]: { value: answer, problem: null } }))
          return null
        },
        'notice.sdiSent',
      )
    },
    // ---- F-OM-201: the plan's hand windows ----
    onPlanPreview: (body: MoneyPlanBody) => {
      previewRead.current?.abort()
      const abort = new AbortController()
      previewRead.current = abort
      setPreview((known) => ({ value: known?.value ?? null, problem: null }))
      previewMoneyPlan(api, orderId, body, abort.signal)
        .then((answer) => {
          if (!abort.signal.aborted) setPreview({ value: answer, problem: null })
        })
        .catch((error: unknown) => {
          if (!abort.signal.aborted) setPreview({ value: null, problem: readProblem(error) })
        })
    },
    onPlanAct: (body: MoneyPlanBody) => {
      // One key for the act and its repeat after a fresh code (the API answers the second from its receipt).
      const key = newIdempotencyKey()
      const sentence = body.act === 'CHANGE_TERMS' ? 'moneyTab.stepUp.terms' : 'moneyTab.stepUp.plan'
      // The preview said a fresh code follows (new terms; a short deposit beyond the tolerance): ask it first, else when the server asks.
      const fresh = body.act === 'CHANGE_TERMS' || preview?.value?.preview?.needsFreshCode === true
      setRefused(null)
      void write(async () => {
        try {
          if (fresh) await ensureFresh(sentence)
          return await guard(sentence, () => applyMoneyPlan(api, orderId, body, key))
        } catch (error) {
          setRefused(planRefusalOf(error))
          throw error
        }
      }, 'moneyTab.notice.planChanged')
    },
    // ---- F-OM-202 (B-OM-017): Undo this payment… ----
    onUndoPayment: ({ paymentId, requestId, reason, lockReason }) => {
      const key = newIdempotencyKey()
      void write(async () => {
        try {
          await undoDepositPayment(api, paymentId, { depositRequestId: requestId, reason: reason.trim(), ...(lockReason?.trim() ? { periodLockOverride: { reason: lockReason.trim() } } : {}) }, key)
        } catch (error) {
          if (softLockedOf(error)) setLockAsked(true)
          throw error
        }
        return null
      }, 'moneyTab.notice.undone')
    },
    // ---- F-OM-301 (B-OM-020): accept a price difference by hand, or undo the acceptance — then the price check is read again (a
    // check that moved meanwhile is refused: it is read again too, and the window says why).
    onPriceAccept: (body) => {
      const key = newIdempotencyKey()
      void write(async () => {
        try {
          await acceptPriceDifference(api, orderId, body, key)
        } catch (error) {
          if (isApiError(error) && error.kind === 'conflict') rereads?.priceCheck?.()
          throw error
        }
        rereads?.priceCheck?.()
        return null
      }, 'moneyTab.notice.priceAccepted')
    },
    onPriceUnaccept: (reason) => {
      const key = newIdempotencyKey()
      void write(async () => {
        await undoPriceAcceptance(api, orderId, { reason: reason.trim() }, key)
        rereads?.priceCheck?.()
        return null
      }, 'moneyTab.notice.priceUnaccepted')
    },
  }

  return {
    model: { sentLink, recorded, scheduleSteps: scheduleSteps.model, moneyPlan: { preview, refused, terms, contacts, lockAsked, invoiceShipped } },
    actions,
    // A dialog opens or closes: the page sent and the payment recorded by the last one are not said again.
    // F-OM-201 / 202: nor its preview, refusal or locked month; the window that needs a list reads it as it opens.
    opened: (next) => {
      setSentLink(null)
      setRecorded(null)
      previewRead.current?.abort()
      setPreview(null)
      setRefused(null)
      setLockAsked(false)
      const value = current.current
      if (next?.kind === 'depositLink' && value && permissions.includes('parties.view')) {
        setContacts({ value: null, problem: null })
        getParty(api, value.partyId)
          .then((party) => setContacts({ value: party.contacts, problem: null }))
          .catch((error: unknown) => setContacts({ value: null, problem: readProblem(error) }))
      }
      if (next?.kind === 'moneyPlan' && next.act === 'CHANGE_TERMS' && value) {
        setTerms({ value: null, problem: null })
        listTerms(api, value.companyId, 'ACTIVE')
          .then((list) => setTerms({ value: list, problem: null }))
          .catch((error: unknown) => setTerms({ value: null, problem: readProblem(error) }))
      }
    },
  }
}
