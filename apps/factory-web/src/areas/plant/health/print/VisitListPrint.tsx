'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { printVisits, VISIT_PAGE } from '../api'
import { healthCan, readProblemOf } from '../model'
import type { VisitListPrintModel } from '../view-model'
import { VisitListPrintView } from './view/VisitListPrintView'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `/w/<company>/plant/health/print[?visits=<id>,<id>]` (SCR-212-visits, design plant.health/tab:visit-list "Visit list for the
 * doctor (print)": names, roles, visit type, risks; no judgements), a new tab from the band's ⋯ (every open visit of the top
 * bar's site) or from the chosen rows. ONE recorded read (POST /safety/health/visits/print: a PRINT view per company), kept in
 * this tab's state only; the browser prints it or saves it as a PDF.
 */
export function VisitListPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const params = useSearchParams()
  const can = useMemo(() => healthCan(session.permissions), [session.permissions])
  const ids = useMemo(() => (params.get('visits') ?? '').split(',').filter((id) => UUID.test(id)).slice(0, VISIT_PAGE), [params])
  const key = ids.join(',')
  const [at] = useState(() => new Date().toISOString())
  const [list, setList] = useState<VisitListPrintModel['list']>({ rows: null, problem: null, law: null })

  // ONE recorded read per opening: a second run of the effect (React's development double run) reads nothing more.
  const started = useRef<string | null>(null)
  useEffect(() => {
    if (!can.view) return
    const want = `${scope.siteId ?? ''}|${key}`
    if (started.current === want) return
    started.current = want
    setList({ rows: null, problem: null, law: null })
    printVisits(api, scope.siteId, key ? key.split(',') : null).then(
      (answer) => started.current === want && setList({ rows: answer.visits, problem: null, law: answer.law }),
      (error: unknown) => started.current === want && setList({ rows: null, problem: readProblemOf(error), law: null }),
    )
  }, [api, can.view, scope.siteId, key])

  return <VisitListPrintView model={{ person: session.user.displayName, at, company: session.company?.name ?? '', site: scope.site?.name ?? null, allSites: scope.allSites, chosen: ids.length, canView: can.view, list }} />
}
