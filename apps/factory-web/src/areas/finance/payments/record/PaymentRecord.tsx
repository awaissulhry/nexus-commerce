'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { allocatePayment, getPayment, openItems, reverseAllocation, voidPayment, type Payment } from '../../_shared/api'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { abilitiesOf, allocationsOf, readProblem, romeToday, writeProblem } from '../../_shared/model'
import type { Loaded } from '../../invoices/record/record-model'
import { paymentTabOf, type PaymentDialog, type PaymentRecordModel } from './record-model'
import { PaymentRecordView } from './view/PaymentRecordView'

/**
 * `/w/<company>/finance/payments/<id>` (SCR-082 record): loads the payment (payments.view; the API checks its company and
 * customer) and does what the view asks, one write at a time with the payment's version: place the rest on the
 * customer's open items (read when the dialog opens), take an allocation back with a reason, void a payment typed by
 * mistake once nothing is placed. Live: a payment event that names it reads it again.
 */
export function PaymentRecord({ paymentId }: { paymentId: string }) {
  return (
    <WithMessages namespaces={['finance', 'lists']}>
      <RecordContainer paymentId={paymentId} />
    </WithMessages>
  )
}

function RecordContainer({ paymentId }: { paymentId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = paymentTabOf(params?.get('tab'))
  const prefix = pathname.replace(/\/finance\/payments\/[^/]+\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const [payment, setPayment] = useState<Loaded<Payment>>({ status: 'loading' })
  const current = useRef<Payment | null>(null)
  const [items, setItems] = useState<PaymentRecordModel['items']>({ value: null, problem: null })
  const [notice, setNotice] = useState<PaymentRecordModel['notice']>(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<PaymentDialog | null>(null)
  const [dialogProblem, setDialogProblem] = useState<PaymentRecordModel['dialogProblem']>(null)

  const load = useCallback(async () => {
    try {
      const next = await getPayment(api, paymentId)
      current.current = next
      setPayment({ status: 'ready', value: next })
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setPayment({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setPayment({ status: 'forbidden' })
      else setPayment({ status: 'error', problem: readProblem(error) })
    }
  }, [api, paymentId])

  useEffect(() => {
    void load()
  }, [load])

  const reread = useCoalesced(() => void load(), 700)
  const live = useLive(
    (change) => {
      if (change.type.startsWith('payment.') && Object.values(change.fields).includes(paymentId)) reread()
    },
    () => void load(),
  )

  const readItems = useCallback(async () => {
    const value = current.current
    if (!value) return
    setItems({ value: null, problem: null })
    try {
      setItems({ value: await openItems(api, value.companyId, value.partyId), problem: null })
    } catch (error) {
      setItems({ value: null, problem: readProblem(error) })
    }
  }, [api])

  const write = useCallback(
    async (run: () => Promise<Payment>, success: string) => {
      if (busy) return
      setBusy(true)
      setDialogProblem(null)
      try {
        const next = await run()
        current.current = next
        setPayment({ status: 'ready', value: next })
        setDialog(null)
        setNotice({ tone: 'success', words: { key: success } })
      } catch (error) {
        const words = writeProblem(error)
        setDialogProblem(words)
        if (words.reload) void load()
      } finally {
        setBusy(false)
      }
    },
    [busy, load],
  )

  const version = () => current.current?.version ?? 1
  const model: PaymentRecordModel = { prefix, can, today: romeToday(), tab, payment, items, live, notice, busy, dialog, dialogProblem }

  return (
    <PaymentRecordView
      model={model}
      actions={{
        onRetry: () => void load(),
        onDismissNotice: () => setNotice(null),
        onDialog: (next) => {
          setDialog(next)
          setDialogProblem(null)
          if (next?.kind === 'place') void readItems()
        },
        onRetryItems: () => void readItems(),
        onPlace: (plan) => void write(() => allocatePayment(api, paymentId, version(), allocationsOf(items.value ?? [], plan)), 'notice.placed'),
        onReverse: (allocationId, note) => void write(() => reverseAllocation(api, paymentId, allocationId, note), 'notice.takenBack'),
        onVoid: (reason) => void write(() => voidPayment(api, paymentId, version(), reason), 'notice.voided'),
      }}
    />
  )
}
