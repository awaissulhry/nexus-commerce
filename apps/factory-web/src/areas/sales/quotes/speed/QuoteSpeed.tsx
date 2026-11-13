'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { readProblem } from '../../../_shared/stock/model'
import { getQuoteSpeed } from '../../reports/api'
import { speedCan } from './model'
import { QuoteSpeedStrip, type SpeedRead } from './view/QuoteSpeedStrip'

/**
 * Quote speed on the Quotes page (SCR-428; GET /sales/reports/quote-speed with quotes.view): this month so far for the top bar's
 * company, read when the page opens and when the company changes; nothing for a person without quotes.view.
 */
export function QuoteSpeed() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const pathname = usePathname()
  const prefix = pathname.replace(/\/sales\/quotes\/?$/, '')
  const can = useMemo(() => speedCan(session.permissions), [session.permissions])
  const companyId = scope.company?.id ?? null
  const [read, setRead] = useState<SpeedRead>({ status: 'loading' })

  const load = useCallback(async () => {
    if (!can.quotes) return
    setRead({ status: 'loading' })
    try {
      setRead({ status: 'ready', value: await getQuoteSpeed(api, { from: null, to: null }) })
    } catch (error) {
      setRead({ status: 'error', problem: readProblem(error) })
    }
  }, [api, can.quotes, companyId])
  useEffect(() => {
    void load()
  }, [load])

  return <QuoteSpeedStrip model={{ prefix, can, read }} onRetry={() => void load()} />
}
