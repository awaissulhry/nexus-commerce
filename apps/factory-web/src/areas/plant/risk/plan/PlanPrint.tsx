'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { listMeasures, type Measure, type MeasureView } from '../api'
import { MEASURE_VIEWS, readProblemOf, riskCan } from '../model'
import { PlanPrintView } from './view/PlanPrintView'

/**
 * `/w/<company>/plant/risk/plan?assessment=<id>&…&id=<measure>&…&view=` (SCR-209-plan-print, a new tab): the measures of the
 * assessments named (GET /safety/risk/measures?assessmentId, one read each), or the measures chosen on a list (their ids:
 * every measure the person reads, then those), or the top bar's site; the view as asked (open by default). The cost only
 * with the cost grain (the API sends no cost key without it).
 */
export function PlanPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const params = useSearchParams()
  const can = useMemo(() => riskCan(session.permissions), [session.permissions])
  const assessments = useMemo(() => params.getAll('assessment').filter(Boolean).slice(0, 50), [params])
  const ids = useMemo(() => params.getAll('id').filter(Boolean), [params])
  const asked = params.get('view')
  const view: MeasureView = asked && (MEASURE_VIEWS as readonly string[]).includes(asked) ? (asked as MeasureView) : 'open'
  const [at] = useState(() => new Date().toISOString())
  const [read, setRead] = useState<{ measures: Measure[] | null; problem: string | null }>({ measures: null, problem: null })
  const siteId = scope.siteId
  const key = `${assessments.join(',')}|${ids.join(',')}|${view}|${siteId ?? ''}`

  useEffect(() => {
    if (!can.view) return
    let live = true
    setRead({ measures: null, problem: null })
    const reading =
      ids.length > 0
        ? listMeasures(api, { view: 'all' }).then((answer) => answer.measures.filter((measure) => ids.includes(measure.id)))
        : assessments.length > 0
          ? Promise.all(assessments.map((assessmentId) => listMeasures(api, { assessmentId, view }))).then((answers) => answers.flatMap((answer) => answer.measures))
          : listMeasures(api, { siteId, view }).then((answer) => answer.measures)
    reading.then(
      (measures) => live && setRead({ measures, problem: null }),
      (error: unknown) => live && setRead({ measures: null, problem: readProblemOf(error) }),
    )
    return () => {
      live = false
    }
  }, [api, can.view, key])

  const sites = new Set((read.measures ?? []).map((measure) => measure.site.name))
  return (
    <PlanPrintView
      model={{
        person: session.user.displayName,
        at,
        company: session.company?.name ?? '',
        site: sites.size === 1 ? [...sites][0]! : sites.size === 0 ? (scope.site?.name ?? null) : null,
        canView: can.view,
        seesCost: can.cost,
        view: ids.length > 0 ? 'all' : view,
        ...read,
      }}
    />
  )
}
