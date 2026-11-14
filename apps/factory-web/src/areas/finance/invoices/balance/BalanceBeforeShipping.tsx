'use client'

import { useCallback, useEffect, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { openItems, type Invoice, type OpenItem, type Related } from '../../_shared/api'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem, type Phrase } from '../../_shared/model'
import { depthProblem, type DepthProblem } from '../test-mode/depth'
import { balanceHolds, balanceTouched, releaseHold, type BalanceHold } from './api'
import { balanceOrdersOf, HOLD_REFUSALS, type BalanceOrder } from './model'
import { BalanceView } from './view/BalanceView'

/**
 * Balance before shipping's container (B-W2b-417 on B-W2b-386's holds and the payments' open items): the customer's open
 * items of the invoice's company (payments.view) and the shipments held for an unpaid balance (shipping.view), matched to
 * the invoice's orders; lets one go with the reason (one write, an Idempotency-Key). Without payments.view nothing is
 * read (the open balance is a payment's read); without shipping.view the holds are said as not readable.
 */
export function BalanceBeforeShipping({ invoice, related, prefix }: { invoice: Invoice; related: Related | null; prefix: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const held = new Set(session.permissions)
  const mayRead = held.has('payments.view')
  const mayHolds = held.has('shipping.view')
  const [orders, setOrders] = useState<BalanceOrder[] | null>(null)
  const [holdsUnknown, setHoldsUnknown] = useState(!mayHolds)
  const [problem, setProblem] = useState<string | null>(null)
  const [releasing, setReleasing] = useState<BalanceHold | null>(null)
  const [words, setWords] = useState('')
  const [busy, setBusy] = useState(false)
  const [writeProblem, setWriteProblem] = useState<DepthProblem | null>(null)
  const [notice, setNotice] = useState<Phrase | null>(null)

  const read = useCallback(async () => {
    if (!mayRead || !related || related.orders.length === 0) {
      setOrders([])
      return
    }
    try {
      const items: OpenItem[] = await openItems(api, invoice.companyId, invoice.buyerPartyId)
      let holds: BalanceHold[] = []
      let unknown = !mayHolds
      if (mayHolds) {
        try {
          holds = await balanceHolds(api)
        } catch {
          unknown = true
        }
      }
      setHoldsUnknown(unknown)
      setOrders(balanceOrdersOf(related, items, holds))
      setProblem(null)
    } catch (error) {
      setProblem(readProblem(error))
    }
  }, [api, invoice.buyerPartyId, invoice.companyId, mayHolds, mayRead, related])
  useEffect(() => {
    void read()
  }, [read])
  const reread = useCoalesced(() => void read(), 900)
  useLive(
    (change) => {
      if (balanceTouched(change)) reread()
    },
    () => reread(),
    mayRead,
  )

  return (
    <BalanceView
      model={{ prefix, price: held.has('money.price'), recordPayments: held.has('payments.record'), orders, problem, holdsUnknown, releasing, words, busy, writeProblem, notice }}
      actions={{
        onRetry: () => void read(),
        onRelease: (hold) => {
          setReleasing(hold)
          setWords('')
          setWriteProblem(null)
        },
        onWords: setWords,
        onDismissNotice: () => setNotice(null),
        onConfirmRelease: () => {
          const hold = releasing
          if (busy || !hold) return
          setBusy(true)
          setWriteProblem(null)
          void (async () => {
            try {
              await releaseHold(api, hold, words.trim(), newIdempotencyKey())
              setReleasing(null)
              setNotice({ key: 'balance.released', params: { number: hold.shipment.number } })
              await read()
            } catch (error) {
              const answer = depthProblem(error, HOLD_REFUSALS)
              setWriteProblem(answer)
              if (answer.reload) void read()
            } finally {
              setBusy(false)
            }
          })()
        },
      }}
    />
  )
}
