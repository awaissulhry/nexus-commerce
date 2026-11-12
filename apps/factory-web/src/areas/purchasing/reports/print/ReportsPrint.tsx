'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { readProblem } from '../../../_shared/stock/model'
import { getLate, getSpend, type LateRow, type Spend } from '../api'
import { rangeShown, reportsAddressOf, reportsCan, romeToday } from '../model'
import { ReportsPrintView } from './view/ReportsPrintView'

interface PrintRead {
  spend: Spend | null
  late: LateRow[] | null
  lateMore: boolean
  problem: string | null
}

const EMPTY: PrintRead = { spend: null, late: null, lateMore: false, problem: null }

/**
 * `/w/<company>/purchasing/reports/print?from=&to=&by=` (SCR-372, design tab:print, the monthly buying review on paper): the
 * spend of the period and the top bar's site by the grouping asked, and the first 200 late lines, read one after another; the
 * browser prints it or saves it as a PDF.
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
  const companyId = scope.company?.id ?? null

  useEffect(() => {
    if (!can.view) return
    let live = true
    setRead(EMPTY)
    void (async () => {
      try {
        const spend = await getSpend(api, { siteId, from: address.from, to: address.to }, address.by)
        const late = can.orders ? await getLate(api, { companyId, siteId, reason: null, limit: 200 }) : null
        if (live) setRead({ spend, late: late ? late.rows : null, lateMore: !!late?.nextCursor, problem: null })
      } catch (error) {
        if (live) setRead({ ...EMPTY, problem: readProblem(error) })
      }
    })()
    return () => {
      live = false
    }
  }, [api, can.view, can.orders, companyId, siteId, address.from, address.to, address.by])

  const range = rangeShown(address, read.spend, read.spend?.today ?? today)
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
