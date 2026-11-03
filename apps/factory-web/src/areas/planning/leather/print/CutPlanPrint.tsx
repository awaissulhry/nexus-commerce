'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { listPlanningSites } from '../../board/api'
import { getNeed } from '../api'
import { controlsOf, readProblemOf } from '../model'
import { CutPlanPrintView, type CutPlanPrintModel } from './view/CutPlanPrintView'

/**
 * `/w/<company>/planning/leather/print?site=&tile=&feas=&q=` (SCR-252-print; design planning.leather tab:cut-plan "Printed for
 * the cutting room with the filters at the top"): the need list read once with the page's own filters, drawn for paper. A
 * new tab from the page's ⋯ Print cut plan (a plain link cannot send the company header, so the page reads it).
 */
export function CutPlanPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const query = params?.toString() ?? ''
  const controls = useMemo(() => controlsOf(new URLSearchParams(query)), [query])
  const [model, setModel] = useState<CutPlanPrintModel>({ need: null, problem: null, controls, printedAt: new Date().toISOString() })
  useEffect(() => {
    let live = true
    const siteOf = async () => controls.site ?? (await listPlanningSites(api, session.company?.id ?? null))[0]?.id ?? null
    siteOf()
      .then(async (siteId) => {
        if (!siteId) throw new Error('no site')
        const need = await getNeed(api, siteId)
        if (live) setModel({ need, problem: null, controls, printedAt: new Date().toISOString() })
      })
      .catch((error: unknown) => live && setModel({ need: null, problem: error instanceof Error && error.message === 'no site' ? 'error.noSite' : readProblemOf(error), controls, printedAt: new Date().toISOString() }))
    return () => {
      live = false
    }
  }, [api, controls, session.company?.id])
  return <CutPlanPrintView model={model} />
}
