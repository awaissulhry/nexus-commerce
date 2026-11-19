'use client'

import { useState, type Dispatch, type SetStateAction } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { getSdi, recordDepositPayment, sendDepositLink, sendToSdi, type DepositLinkAnswer, type DepositReceived, type SdiStatus } from '../api'
import type { useStepUp } from '../hooks'
// B-W2a-80: the schedule card's verbs (B-W2a-F2's note): open a before-shipping step, invoice a paid step.
import { useScheduleSteps } from './schedule/use-schedule-steps'
import type { OrderRecordActions, OrderRecordModel, Part, RecordActsBase, RecordDialog } from './record-model'

export type MoneyActsModel = Pick<OrderRecordModel, 'sentLink' | 'recorded' | 'scheduleSteps'>
export type MoneyActsActions = Pick<OrderRecordActions, 'onSendLink' | 'onRecordPayment' | 'onSendSdi' | 'scheduleSteps'>

/**
 * F-OP-134 (N-5): the Money tab's acts — the deposits and payments: the bank-details page, the payment (with the TD02: a fresh
 * authenticator code), the TD02's send to SDI, and the payment schedule's verbs (B-W2a-80). Mounted by the container
 * (OrderRecord.tsx), which hands what it returns to the view as plain props; a view never imports it. Each SDI state is the
 * container's read (it reads them with the order's parts); a send puts its answer in place.
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
  },
): { model: MoneyActsModel; actions: MoneyActsActions; opened: (next: RecordDialog | null) => void } {
  const { api, orderId, current, write, setNotice, loadParts, permissions, sdi, setSdi, stepUp, onInvoiced } = input
  const { ensureFresh, guard } = stepUp
  const [sentLink, setSentLink] = useState<DepositLinkAnswer | null>(null)
  const [recorded, setRecorded] = useState<DepositReceived | null>(null)

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
    onSendLink: (requestId, message) =>
      void write(
        async () => {
          setSentLink(await sendDepositLink(api, requestId, message))
          return null
        },
        null,
        true,
      ),
    onRecordPayment: (requestId, input) => {
      // One key for the write and its repeat after the code: the API answers the second from its receipt.
      const key = newIdempotencyKey()
      const body = { depositRequestId: requestId, amount: input.amount, receivedOn: input.receivedOn, externalRef: input.reference, internalNote: input.note || null, issueDepositInvoice: input.issue }
      void write(
        async () => {
          if (input.issue) await ensureFresh('stepUp.sentence.td02')
          setRecorded(await guard('stepUp.sentence.td02', () => recordDepositPayment(api, body, key)))
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
  }

  return {
    model: { sentLink, recorded, scheduleSteps: scheduleSteps.model },
    actions,
    // A dialog opens or closes: the page sent and the payment recorded by the last one are not said again.
    opened: () => {
      setSentLink(null)
      setRecorded(null)
    },
  }
}
