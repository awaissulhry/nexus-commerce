'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem, romeToday, type Phrase } from '../../_shared/model'
import { depthProblem, type DepthProblem } from '../test-mode/depth'
import { getQuarters, payQuarter, recountQuarter, stampDutyTouched, type Quarter, type Quarters } from './api'
import { QUARTER_REFUSALS, quarterName, taxAbilitiesOf } from './model'
import { StampDutyDialog } from './view/StampDutyDialog'

/**
 * "Stamp duty this quarter" (B-W2b-417 on B-W2b-392's API), opened from Invoices' ⋯: the address's company, this year by
 * default (last year one choice away); recounts a quarter and records its payment, each with an Idempotency-Key and the
 * quarter's version; reads again on a quarter's, the tax switches' or an issue's live event.
 */
export function StampDutyQuarters({ onClose }: { onClose: () => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => taxAbilitiesOf(session.permissions), [session.permissions])
  const price = session.permissions.includes('money.price')
  const companyId = session.company?.id ?? null
  const today = romeToday()
  const thisYear = Number(today.slice(0, 4))
  const [year, setYear] = useState(thisYear)
  const [quarters, setQuarters] = useState<{ value: Quarters | null; problem: string | null }>({ value: null, problem: null })
  const [paying, setPaying] = useState<Quarter | null>(null)
  const [paidOn, setPaidOn] = useState(today)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<DepthProblem | null>(null)
  const [notice, setNotice] = useState<Phrase | null>(null)

  const read = useCallback(async () => {
    if (!companyId) return
    try {
      setQuarters({ value: await getQuarters(api, companyId, year), problem: null })
    } catch (error) {
      setQuarters({ value: null, problem: readProblem(error) })
    }
  }, [api, companyId, year])
  useEffect(() => {
    setQuarters({ value: null, problem: null })
    void read()
  }, [read])
  const reread = useCoalesced(() => void read(), 900)
  useLive(
    (change) => {
      if (stampDutyTouched(change)) reread()
    },
    () => reread(),
  )

  const write = async (work: () => Promise<Phrase>) => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    setNotice(null)
    try {
      setNotice(await work())
      await read()
    } catch (error) {
      const words = depthProblem(error, QUARTER_REFUSALS)
      setProblem(words)
      if (words.reload) void read()
    } finally {
      setBusy(false)
    }
  }

  return (
    <StampDutyDialog
      model={{ can, price, today, year, years: [thisYear - 1, thisYear], quarters, paying, paidOn, busy, problem, notice }}
      actions={{
        onYear: (next) => {
          setPaying(null)
          setYear(next)
        },
        onRetry: () => void read(),
        onRecount: (quarter) => {
          if (!companyId) return
          void write(async () => {
            const counted = await recountQuarter(api, companyId, quarter.quarterStart, newIdempotencyKey())
            const named = quarterName(counted)
            return { key: 'stamp.recounted', params: { n: named.n, year: named.year, count: counted.invoiceCount } }
          })
        },
        onPay: (quarter) => {
          setProblem(null)
          setPaidOn(today)
          setPaying(quarter)
        },
        onPaidOn: setPaidOn,
        onConfirmPay: () => {
          const id = paying?.id
          const version = paying?.version
          if (!id || !version) return
          void write(async () => {
            const paid = await payQuarter(api, { id, version }, paidOn, newIdempotencyKey())
            setPaying(null)
            const named = quarterName(paid)
            return { key: 'stamp.paidSaved', params: { n: named.n, year: named.year } }
          })
        },
        onClose,
      }}
    />
  )
}
