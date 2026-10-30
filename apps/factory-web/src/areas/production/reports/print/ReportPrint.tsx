'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { getDaily, type DailyReport } from '../api'
import { addressOf, readProblem } from '../model'
import { ReportPrintView } from './view/ReportPrintView'

/**
 * `/w/<company>/production/reports/print?site=&date=` (SCR-240 tab:prr-tab-print): the day's report of the address, read
 * once, drawn for paper. Opened in a new tab from Production reports' ⋯ → Print.
 */
export function ReportPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const address = useMemo(() => addressOf(params), [params])
  const [daily, setDaily] = useState<{ value: DailyReport | null; problem: string | null }>({ value: null, problem: null })
  useEffect(() => {
    let live = true
    getDaily(api, { siteId: address.site, date: address.date })
      .then((value) => live && setDaily({ value, problem: null }))
      .catch((error: unknown) => live && setDaily({ value: null, problem: readProblem(error) }))
    return () => {
      live = false
    }
  }, [api, address])
  return <ReportPrintView model={{ person: session.user.displayName, daily }} />
}
