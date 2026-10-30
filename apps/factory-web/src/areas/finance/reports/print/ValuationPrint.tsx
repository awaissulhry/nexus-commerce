'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { getValuation, type Valuation } from '../api'
import { addressOf, readProblem, reportsCanOf, romeToday } from '../model'
import { ValuationPrintView } from './view/ValuationPrintView'

/**
 * `/w/<company>/finance/reports/print?asOf=&site=&category=&q=&group=` (SCR-239 tab:print, "a dated document for the
 * accountant"): the stock valuation of the address, read once, drawn for paper. Opened in a new tab from the report's ⋯.
 */
export function ValuationPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const address = useMemo(() => addressOf(params), [params])
  const can = useMemo(() => reportsCanOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const [valuation, setValuation] = useState<{ value: Valuation | null; problem: string | null }>({ value: null, problem: null })
  const [readAt, setReadAt] = useState<string | null>(null)
  useEffect(() => {
    if (!can.view) return
    let live = true
    getValuation(api, { asOf: address.asOf, companyId, siteId: address.site, category: address.category, q: address.q })
      .then((value) => {
        if (!live) return
        setValuation({ value, problem: null })
        setReadAt(new Date().toISOString())
      })
      .catch((error: unknown) => live && setValuation({ value: null, problem: readProblem(error) }))
    return () => {
      live = false
    }
  }, [api, address, can.view, companyId])
  return (
    <ValuationPrintView
      model={{ person: session.user.displayName, company: session.company?.name ?? '', can, address, today: romeToday(), valuation, readAt }}
    />
  )
}
