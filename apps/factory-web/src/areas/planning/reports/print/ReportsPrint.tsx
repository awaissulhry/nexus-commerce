'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { readProblem } from '../../../_shared/stock/model'
import { getAdherence, getCover, getUtilisation, type Adherence, type Cover, type Utilisation } from '../api'
import { rangeShown, reportsAddressOf, reportsCan, romeToday } from '../model'
import { ReportsPrintView } from './view/ReportsPrintView'

interface PrintRead {
  adherence: Adherence | null
  utilisation: Utilisation | null
  cover: Cover | null
  problem: string | null
}

const EMPTY: PrintRead = { adherence: null, utilisation: null, cover: null, problem: null }

/**
 * `/w/<company>/planning/reports/print?from=&to=&ahead=&weeks=` (SCR-409, design tab:print "Print stylesheet with scope and period
 * written at the top", the monthly planning review on paper): the top bar's site (planning is per site: with "All sites" the first
 * one), the period's adherence and utilisation and the material cover, read one after another; the browser prints it or saves it
 * as a PDF.
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
  const site = scope.site ?? scope.sites[0] ?? null
  const siteId = site?.id ?? null

  useEffect(() => {
    if (!can.view || !can.plans || !siteId) return
    let live = true
    setRead(EMPTY)
    void (async () => {
      try {
        const query = { siteId, from: address.from, to: address.to }
        const adherence = await getAdherence(api, query)
        const utilisation = await getUtilisation(api, query, address.ahead)
        const cover = await getCover(api, siteId, address.weeks)
        if (live) setRead({ adherence, utilisation, cover, problem: null })
      } catch (error) {
        if (live) setRead({ ...EMPTY, problem: readProblem(error) })
      }
    })()
    return () => {
      live = false
    }
  }, [api, can.view, can.plans, siteId, address.from, address.to, address.ahead, address.weeks])

  const range = rangeShown(address, read.adherence, read.adherence?.today ?? today)
  return (
    <ReportsPrintView
      model={{
        person: session.user.displayName,
        at,
        company: session.company?.name ?? '',
        site: site?.name ?? null,
        can,
        range,
        ahead: address.ahead,
        back: `${pathname.replace(/\/print\/?$/, '')}${params?.toString() ? `?${params.toString()}` : ''}`,
        ...read,
      }}
    />
  )
}
