'use client'

import { useCallback, useEffect, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem } from '../../_shared/model'
import { getProposal, listProposals } from '../proposal/api'
import { batchOf, batchTouched, proposalsToRead, type InvoiceBatch } from './model'
import { PaymentBatchCard } from './view/PaymentBatchCard'

/**
 * The payment section's container on a supplier invoice's Payment tab (B-W2b-425 on B-W2b-403's API): lists the company's
 * proposals (payables.view), reads the newest that are not cancelled and finds the invoice's line. Live: a proposal or the
 * invoice that moves reads it again.
 */
export function PaymentBatch({ invoiceId, companyId, prefix, version }: { invoiceId: string; companyId: string; prefix: string; version: number }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const [batch, setBatch] = useState<InvoiceBatch | null | undefined>(undefined)
  const [more, setMore] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const read = useCallback(async () => {
    try {
      const look = proposalsToRead(await listProposals(api, { companyId }))
      const proposals = await Promise.all(look.ids.map((id) => getProposal(api, id)))
      setBatch(batchOf(proposals, invoiceId))
      setMore(look.more)
      setProblem(null)
    } catch (error) {
      setProblem(readProblem(error))
    }
  }, [api, companyId, invoiceId])
  useEffect(() => {
    void read()
  }, [read, version])
  const reread = useCoalesced(() => void read(), 800)
  useLive(
    (change) => {
      if (batchTouched(change)) reread()
    },
    () => reread(),
  )
  return <PaymentBatchCard model={{ prefix, batch, more, problem, cost: session.permissions.includes('money.cost') }} actions={{ onRetry: () => void read() }} />
}
