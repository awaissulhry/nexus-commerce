'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { getOverview, type Overview } from '../api'
import { efficiencyAddressOf, efficiencyCan, efficiencyProblem, type EfficiencyProblem } from '../model'
import { EfficiencyPrintView } from './view/EfficiencyPrintView'

/**
 * `/w/<company>/people/efficiency/print?from=&to=&line=&compare=1` (SCR-161 tab:print): the line report for paper, read once.
 * Line level only (design "Line and team level only"): nothing about one person can reach this page, and the one-person
 * dialog has no way here.
 */
export function EfficiencyPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const params = useSearchParams()
  const can = useMemo(() => efficiencyCan(session.permissions), [session.permissions])
  const address = useMemo(() => efficiencyAddressOf(params), [params])
  const siteId = scope.siteId
  const [at] = useState(() => new Date().toISOString())
  const [read, setRead] = useState<{ value: Overview | null; problem: EfficiencyProblem | null }>({ value: null, problem: null })
  useEffect(() => {
    if (!can.view || !siteId) return
    let live = true
    getOverview(api, { siteId, from: address.from, to: address.to, lineId: address.lineId, compare: address.compare })
      .then((value) => live && setRead({ value, problem: null }))
      .catch((error: unknown) => live && setRead({ value: null, problem: efficiencyProblem(error) }))
    return () => {
      live = false
    }
  }, [api, can.view, siteId, address])
  return <EfficiencyPrintView model={{ person: session.user.displayName, at, company: session.company?.name ?? '', site: scope.site?.name ?? null, noSite: !siteId, can: can.view, read }} />
}
