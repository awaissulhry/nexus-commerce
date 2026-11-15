'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import type { Payment } from '../../_shared/api'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem } from '../../_shared/model'
import { payProblem, scoped, type PayProblem, type Phrase } from '../riba/depth'
import { paymentWriteOffs, reverseWriteOff, writeOff, WRITE_OFF_REFUSALS, type PaymentWriteOffs } from './api'
import { writeOffCanOf } from './model'
import { WriteOffCard, type WriteOffDialog } from './view/WriteOffCard'

/**
 * The write-off card's container on a payment's Allocation tab (B-W2b-425 on B-W2b-393's API): reads the payment's
 * write-offs and what may be written off (payments.view), writes the whole difference off with its reason or takes one
 * back with a note (payments.writeOff; one write each, an Idempotency-Key), then tells the record to read the payment
 * again (what is placed and left changes). Live: a payment event naming it reads the card again.
 */
export function WriteOffs({ payment, prefix, onChanged }: { payment: Payment; prefix: string; onChanged: () => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => writeOffCanOf(session.permissions), [session.permissions])
  const [answer, setAnswer] = useState<PaymentWriteOffs | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [dialog, setDialog] = useState<WriteOffDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [writeProblem, setWriteProblem] = useState<PayProblem | null>(null)
  const [notice, setNotice] = useState<Phrase | null>(null)

  const read = useCallback(async () => {
    try {
      setAnswer(await paymentWriteOffs(api, payment.id))
      setProblem(null)
    } catch (error) {
      setProblem(readProblem(error))
    }
  }, [api, payment.id])
  // The payment's version moves with every placement and write-off: read the card again with it.
  useEffect(() => {
    void read()
  }, [read, payment.version])
  const reread = useCoalesced(() => void read(), 700)
  useLive(
    (change) => {
      if (change.type.startsWith('payment.') && Object.values(change.fields).includes(payment.id)) reread()
    },
    () => reread(),
  )

  const run = async (work: () => Promise<unknown>, words: Phrase) => {
    if (busy) return
    setBusy(true)
    setWriteProblem(null)
    try {
      await work()
      setDialog(null)
      setNotice(words)
      onChanged()
      await read()
    } catch (error) {
      setWriteProblem(payProblem(error, 'writeOff', WRITE_OFF_REFUSALS, ['writeOff']))
      void read()
    } finally {
      setBusy(false)
    }
  }

  return (
    <WriteOffCard
      model={{ prefix, can, currency: payment.currency, voided: payment.status === 'VOIDED', answer, problem, people: payment.people, dialog, busy, writeProblem, notice }}
      actions={{
        onRetry: () => void read(),
        onDialog: (next) => {
          setDialog(next)
          setWriteProblem(null)
        },
        onDismissNotice: () => setNotice(null),
        onWriteOff: (possible, reason, note) => {
          const key = newIdempotencyKey()
          void run(() => writeOff(api, payment.id, { kind: possible.kind, ...(possible.allocationId ? { allocationId: possible.allocationId } : {}), reason, note: note || null }, key), { key: scoped('writeOff.notice.done') })
        },
        onTakeBack: (row, note) => {
          const key = newIdempotencyKey()
          void run(() => reverseWriteOff(api, payment.id, row.id, note, key), { key: scoped('writeOff.notice.takenBack') })
        },
      }}
    />
  )
}
