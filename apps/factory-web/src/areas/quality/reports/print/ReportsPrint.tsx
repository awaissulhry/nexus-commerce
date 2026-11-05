'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { problemKey } from '../../_shared/model'
import { getCompare, getIncoming, getKpis, getTrend, type Compare, type Incoming, type Kpis, type Trend } from '../api'
import { reportsAddressOf, reportsCan } from '../model'
import { ReportsPrintView } from './view/ReportsPrintView'

interface PrintRead {
  kpis: Kpis | null
  trend: Trend | null
  compare: Compare | null
  incoming: Incoming | null
  problem: string | null
}

/**
 * `/w/<company>/quality/reports/print?from=&to=&compare=0&by=&line=` (SCR-147 tab:qr-pdf): the quality report for paper or a
 * PDF, read once with the page's filters (the top bar's site). Groups only: nothing about a person can reach this page.
 */
export function ReportsPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const params = useSearchParams()
  const can = useMemo(() => reportsCan(session.permissions), [session.permissions])
  const address = useMemo(() => reportsAddressOf(params), [params])
  const siteId = scope.siteId
  const [at] = useState(() => new Date().toISOString())
  const [read, setRead] = useState<PrintRead>({ kpis: null, trend: null, compare: null, incoming: null, problem: null })

  useEffect(() => {
    if (!can.view || !siteId) return
    let live = true
    const base = { siteId, from: address.from, to: address.to }
    Promise.all([getKpis(api, { ...base, compare: address.compare }), getTrend(api, { ...base, lineId: address.lineId }), getCompare(api, { ...base, by: address.by }), getIncoming(api, base)])
      .then(([kpis, trend, compare, incoming]) => live && setRead({ kpis, trend, compare, incoming, problem: null }))
      .catch((error: unknown) => live && setRead({ kpis: null, trend: null, compare: null, incoming: null, problem: problemKey(error) }))
    return () => {
      live = false
    }
  }, [api, can.view, siteId, address])

  const lineName = read.trend && address.lineId ? (read.trend.lines.find((line) => line.id === address.lineId) ?? null) : null
  return (
    <ReportsPrintView
      model={{
        person: session.user.displayName,
        at,
        company: session.company?.name ?? '',
        site: scope.site?.name ?? null,
        noSite: !siteId,
        can: can.view,
        address,
        lineName: lineName ? `${lineName.code} · ${lineName.name}` : null,
        ...read,
      }}
    />
  )
}
