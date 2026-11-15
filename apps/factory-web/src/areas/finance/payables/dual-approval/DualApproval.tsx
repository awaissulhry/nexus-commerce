'use client'

import { useCallback, useEffect, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem } from '../../_shared/model'
import { invoiceDual, type InvoiceDual } from './api'
import { dualTouched } from './model'
import { DualApprovalCard } from './view/DualApprovalCard'

/**
 * Dual approval's container on a supplier invoice's Approval tab (B-W2b-425 on B-W2b-403's API): reads where the two yeses
 * stand (payables.view), again when the invoice moves (its version, or live).
 */
export function DualApproval({ invoiceId, version }: { invoiceId: string; version: number }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const [value, setValue] = useState<InvoiceDual | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const read = useCallback(async () => {
    try {
      setValue(await invoiceDual(api, invoiceId))
      setProblem(null)
    } catch (error) {
      setProblem(readProblem(error))
    }
  }, [api, invoiceId])
  useEffect(() => {
    void read()
  }, [read, version])
  const reread = useCoalesced(() => void read(), 700)
  useLive(
    (change) => {
      if (dualTouched(change)) reread()
    },
    () => reread(),
  )
  return <DualApprovalCard model={{ value, problem, me: session.user.id, cost: session.permissions.includes('money.cost') }} actions={{ onRetry: () => void read() }} />
}
