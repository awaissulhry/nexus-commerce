'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { getDrill, getKpi, type DrillAnswer, type KpiRecord } from './api'
import { drillProblem, drillQuery, isDrillName, recordsHref, spanOf } from './drills'
import { drillNameOf, kpisCanOf, readProblem } from './model'
import { RecordsView, type RecordsModel } from './view/RecordsView'

/**
 * `/w/<company>/home/kpis/<key>/records?from=&to=` (SCR-471): reads the KPI (its drill and its current period), then the
 * drill (GET /insights/kpis/drills/<name>) with the KPI's terms, the period of the address (else the KPI's current period)
 * and the address's company where the drill reads one. Changing the period writes the address. Without home.kpis.view
 * nothing is read.
 */
export function RecordsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const route = useParams<{ key: string }>()
  const key = decodeURIComponent(route.key)
  const prefix = pathname.replace(/\/home\/kpis\/[^/]+\/records\/?$/, '')
  const can = useMemo(() => kpisCanOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const span = useMemo(() => spanOf(params), [params])
  const [kpi, setKpi] = useState<RecordsModel['kpi']>({ value: null, problem: null })
  const [drill, setDrill] = useState<RecordsModel['drill']>({ value: null, problem: null, reading: false })
  const asked = useRef('')

  const loadKpi = useCallback(async () => {
    if (!can.view) return
    try {
      setKpi({ value: await getKpi(api, key, { companyId }), problem: null })
    } catch (error) {
      setKpi({ value: null, problem: { key: readProblem(error) } })
    }
  }, [api, can.view, key, companyId])

  useEffect(() => {
    void loadKpi()
  }, [loadKpi])

  const loadDrill = useCallback(
    async (record: KpiRecord) => {
      const drillOf = record.calculation?.drill ?? null
      const name = drillNameOf(drillOf?.api ?? null)
      if (!isDrillName(name) || !drillOf) return
      const period = span.from && span.to ? span : { from: record.value.period?.from ?? null, to: record.value.period?.to ?? null }
      const query = drillQuery(name, drillOf.terms, period, companyId)
      const ask = JSON.stringify(query)
      asked.current = ask
      setDrill((current) => ({ ...current, reading: true }))
      try {
        const value: DrillAnswer = await getDrill(api, name, query)
        if (asked.current === ask) setDrill({ value, problem: null, reading: false })
      } catch (error) {
        if (asked.current === ask) setDrill((current) => ({ value: current.value, problem: drillProblem(error), reading: false }))
      }
    },
    [api, span, companyId],
  )

  useEffect(() => {
    if (kpi.value) void loadDrill(kpi.value)
  }, [kpi.value, loadDrill])

  return (
    <RecordsView
      model={{ can, prefix, key, kpi, span, drill, built: OFFICE_PAGES }}
      actions={{
        onSpan: (next) => router.replace(recordsHref(prefix, key, next), { scroll: false }),
        onRetry: () => (kpi.value ? void loadDrill(kpi.value) : void loadKpi()),
      }}
    />
  )
}
