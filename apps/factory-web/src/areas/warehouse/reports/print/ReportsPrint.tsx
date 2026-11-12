'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { readProblem } from '../../../_shared/stock/model'
import { getAgeing, getLeather, type Ageing, type Leather } from '../api'
import { rangeShown, reportsAddressOf, reportsCan, romeToday } from '../model'
import { ReportsPrintView } from './view/ReportsPrintView'

interface PrintRead {
  ageing: Ageing | null
  leather: Leather | null
  problem: string | null
}

const EMPTY: PrintRead = { ageing: null, leather: null, problem: null }

/**
 * `/w/<company>/warehouse/reports/print?from=&to=` (SCR-353, design tab:wr-tab-print "paper or PDF for a meeting", the monthly
 * stock review): the two reads of Warehouse reports for the period and the top bar's site, read one after another; the browser
 * prints it or saves it as a PDF.
 */
export function ReportsPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const params = useSearchParams()
  const pathname = usePathname()
  const can = useMemo(() => reportsCan(session.permissions), [session.permissions])
  const address = useMemo(() => reportsAddressOf(params), [params])
  const [today] = useState(() => romeToday())
  const [at] = useState(() => new Date().toISOString())
  const [read, setRead] = useState<PrintRead>(EMPTY)
  const siteId = scope.siteId

  useEffect(() => {
    if (!can.view) return
    let live = true
    setRead(EMPTY)
    const query = { siteId, from: address.from, to: address.to }
    void (async () => {
      try {
        const ageing = await getAgeing(api, query)
        const leather = await getLeather(api, query)
        if (live) setRead({ ageing, leather, problem: null })
      } catch (error) {
        if (live) setRead({ ...EMPTY, problem: readProblem(error) })
      }
    })()
    return () => {
      live = false
    }
  }, [api, can.view, siteId, address.from, address.to])

  const range = rangeShown(address, read.ageing, read.ageing?.today ?? today)
  return (
    <ReportsPrintView
      model={{
        person: session.user.displayName,
        at,
        company: session.company?.name ?? '',
        site: scope.site?.name ?? null,
        can,
        range,
        back: `${pathname.replace(/\/print\/?$/, '')}${params?.toString() ? `?${params.toString()}` : ''}`,
        ...read,
      }}
    />
  )
}
