'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem } from '../../_shared/model'
import { payProblem, type Phrase } from '../../payments/riba/depth'
import { areaCheck, openAreaClaim, type AreaLine } from './api'
import { areaCanOf, areaTouched } from './model'
import { AreaCheckCard } from './view/AreaCheckCard'

/**
 * The leather area check's container on a supplier invoice's Match tab (B-W2b-425 on B-W2b-403's API): reads each leather
 * line's check (payables.view) and opens an area claim for a short line (one write with an Idempotency-Key; the claim's own
 * rights are the API's). Live: the invoice, a receipt posted or a claim that moves reads it again.
 */
export function AreaCheck({ invoiceId, prefix, version }: { invoiceId: string; prefix: string; version: number }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => areaCanOf(session.permissions), [session.permissions])
  const [lines, setLines] = useState<AreaLine[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [claimProblem, setClaimProblem] = useState<{ lineId: string; phrase: Phrase } | null>(null)
  const [opened, setOpened] = useState<{ lineId: string; claim: { id: string; number: string } } | null>(null)

  const read = useCallback(async () => {
    try {
      setLines(await areaCheck(api, invoiceId))
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
      if (areaTouched(change)) reread()
    },
    () => reread(),
    can.view,
  )

  const claim = (line: AreaLine) => {
    if (busy) return
    setBusy(line.lineId)
    setClaimProblem(null)
    const key = newIdempotencyKey()
    void (async () => {
      try {
        const answer = await openAreaClaim(api, invoiceId, line.lineId, key)
        setOpened({ lineId: line.lineId, claim: answer })
        void read()
      } catch (error) {
        const words = payProblem(error, 'area', ['NOTHING_TO_CLAIM'])
        setClaimProblem({ lineId: line.lineId, phrase: words })
        void read()
      } finally {
        setBusy(null)
      }
    })()
  }

  return <AreaCheckCard model={{ prefix, can, lines, problem, busy, claimProblem, opened }} actions={{ onRetry: () => void read(), onClaim: claim }} />
}
