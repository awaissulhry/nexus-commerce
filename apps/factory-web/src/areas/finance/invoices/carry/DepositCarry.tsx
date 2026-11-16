'use client'

import { useCallback, useEffect, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { openItems, type Invoice } from '../../_shared/api'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem, writeProblem, type Phrase } from '../../_shared/model'
import { carryDeposit, carryPreview, carryTouched } from './api'
import { depositsOf, type DepositToCarry } from './model'
import { DepositCarryView } from './view/DepositCarryView'

/**
 * B-W2b-GB02 (G088) — the container of "Deposit to carry" on an issued TD01/TD24's Deposits & payments: the customer's open
 * items of the invoice's company (payments.view) say which deposits paid without a deposit invoice wait for this invoice;
 * each is previewed (GET …/carry?invoiceId), then carried onto it on a confirm (POST …/carry, payments.record, one write
 * with its Idempotency-Key). Without payments.view nothing is read or drawn.
 */
export function DepositCarry({ invoice }: { invoice: Invoice }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const held = new Set(session.permissions)
  const mayRead = held.has('payments.view') && (invoice.docType === 'TD01' || invoice.docType === 'TD24') && invoice.status !== 'DRAFT'
  const [deposits, setDeposits] = useState<DepositToCarry[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<DepositToCarry | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Phrase | null>(null)
  const [notice, setNotice] = useState<Phrase | null>(null)

  const read = useCallback(async () => {
    if (!mayRead) {
      setDeposits([])
      return
    }
    try {
      const waiting = depositsOf(await openItems(api, invoice.companyId, invoice.buyerPartyId), invoice.id)
      setDeposits(waiting.map((entry) => ({ ...entry, preview: null })))
      setProblem(null)
      const previewed = await Promise.all(waiting.map(async (entry) => ({ ...entry, preview: await carryPreview(api, entry.depositRequestId, invoice.id) })))
      setDeposits(previewed)
    } catch (error) {
      setProblem(readProblem(error))
    }
  }, [api, invoice.buyerPartyId, invoice.companyId, invoice.id, mayRead])
  useEffect(() => {
    void read()
  }, [read])
  const reread = useCoalesced(() => void read(), 900)
  useLive((change) => (carryTouched(change) ? reread() : undefined), () => reread(), mayRead)

  const carry = async () => {
    if (!confirming || busy) return
    setBusy(true)
    setFailure(null)
    try {
      await carryDeposit(api, confirming.depositRequestId, invoice.id, newIdempotencyKey())
      setConfirming(null)
      setNotice({ key: 'carried', params: { invoice: invoice.number ?? '—' } })
      void read()
    } catch (error) {
      const words = writeProblem(error)
      setFailure(words.params ? { key: words.key, params: words.params } : { key: words.key })
      if (words.reload) void read()
    } finally {
      setBusy(false)
    }
  }

  return (
    <DepositCarryView
      model={{ invoiceId: invoice.id, invoiceNumber: invoice.number, price: held.has('money.price'), mayRecord: held.has('payments.record'), deposits, problem, confirming, busy, writeProblem: failure, notice }}
      actions={{
        onConfirm: (deposit) => {
          setConfirming(deposit)
          setFailure(null)
        },
        onCarry: () => void carry(),
        onRetry: () => void read(),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
