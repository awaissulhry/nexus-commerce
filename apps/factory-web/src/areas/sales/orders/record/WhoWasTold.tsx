'use client'

import { useEffect, useState } from 'react'
import { useOfficeApi } from '../../../../lib/session/context'
import { readProblem } from '../model'
import { readWhoWasTold } from './told'
import { WhoWasToldWindow, type WhoWasToldRead } from './view/WhoWasToldDialog'

/**
 * F-SA-244 — the Who was told window's container (end check: a view fetches nothing): it reads Who was told of ONE change
 * (`GET /sales/orders/:orderId/told?messageId=`) and hands the window its read; Try again reads it once more.
 */
export function WhoWasToldDialog({ orderId, messageId, onClose }: { orderId: string; messageId: string; onClose: () => void }) {
  const api = useOfficeApi()
  const [read, setRead] = useState<WhoWasToldRead>({ state: 'loading' })
  const [seq, setSeq] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setRead({ state: 'loading' })
    readWhoWasTold(api, orderId, messageId, controller.signal)
      .then((told) => setRead({ state: 'ready', told }))
      .catch((error: unknown) => {
        if ((error as { name?: string } | null)?.name !== 'AbortError') setRead({ state: 'error', problem: readProblem(error) })
      })
    return () => controller.abort()
  }, [api, orderId, messageId, seq])
  return <WhoWasToldWindow read={read} onRetry={() => setSeq((value) => value + 1)} onClose={onClose} />
}
