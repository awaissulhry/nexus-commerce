'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { readProblem } from '../../../_shared/stock/model'
import { getBacklog, getHeadline, getIntake, getReturns, type Backlog, type Headline, type Intake, type Returns } from '../api'
import { rangeShown, reportsAddressOf, reportsCan, romeToday } from '../model'
import { ReportsPrintView } from './view/ReportsPrintView'

interface PrintRead {
  headline: Headline | null
  intake: Intake | null
  backlog: Backlog | null
  returns: Returns | null
  problem: string | null
}

const EMPTY: PrintRead = { headline: null, intake: null, backlog: null, returns: null, problem: null }

/**
 * `/w/<company>/sales/reports/print?from=&to=&by=&split=&backlog=` (SCR-427, design tab:print "Print stylesheet of the current
 * view with filters written at the top", the monthly sales review on paper): the top bar's company, the period's five numbers,
 * intake, backlog and returns, read one after another; the browser prints it or saves it as a PDF.
 */
export function ReportsPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const pathname = usePathname()
  const can = useMemo(() => reportsCan(session.permissions), [session.permissions])
  const address = useMemo(() => reportsAddressOf(params), [params])
  const [today] = useState(() => romeToday())
  const [at] = useState(() => new Date().toISOString())
  const [read, setRead] = useState<PrintRead>(EMPTY)

  useEffect(() => {
    if (!can.view) return
    let live = true
    setRead(EMPTY)
    void (async () => {
      try {
        const period = { from: address.from, to: address.to }
        const headline = await getHeadline(api, period)
        const intake = await getIntake(api, period, address.by, address.split)
        const backlog = await getBacklog(api, address.backlog)
        const returns = await getReturns(api, period)
        if (live) setRead({ headline, intake, backlog, returns, problem: null })
      } catch (error) {
        if (live) setRead({ ...EMPTY, problem: readProblem(error) })
      }
    })()
    return () => {
      live = false
    }
  }, [api, can.view, address.from, address.to, address.by, address.split, address.backlog])

  const range = rangeShown(address, read.headline, read.headline?.today ?? today)
  return (
    <ReportsPrintView
      model={{
        person: session.user.displayName,
        at,
        company: session.company?.name ?? '',
        can,
        range,
        back: `${pathname.replace(/\/print\/?$/, '')}${params?.toString() ? `?${params.toString()}` : ''}`,
        ...read,
      }}
    />
  )
}
