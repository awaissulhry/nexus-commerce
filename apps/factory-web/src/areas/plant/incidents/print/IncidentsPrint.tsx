'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { readIncidents, type IncidentRow } from '../api'
import { addressOf, incidentsCan, listQueryOf, readProblemOf } from '../model'
import { IncidentsPrintView } from './view/IncidentsPrintView'

/** The print takes at most this many pages of 50 (200 incidents); more is said on the paper. */
const PAGES = 4

/**
 * `/w/<company>/plant/incidents/print?rows=&status=&from=&to=&q=` (SCR-210-print, a new tab from the band's ⋯): the list as
 * the screen shows it, read with the top bar's site (GET /safety/incidents, safety.incidents.view), anonymised — the people are
 * never read here.
 */
export function IncidentsPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const params = useSearchParams()
  const can = useMemo(() => incidentsCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const [at] = useState(() => new Date().toISOString())
  const [list, setList] = useState<{ rows: readonly IncidentRow[] | null; problem: string | null; more: boolean }>({ rows: null, problem: null, more: false })
  const query = useMemo(() => listQueryOf(address, scope.siteId), [address, scope.siteId])

  useEffect(() => {
    if (!can.view) return
    let live = true
    setList({ rows: null, problem: null, more: false })
    ;(async () => {
      const rows: IncidentRow[] = []
      let cursor: string | null = null
      for (let page = 0; page < PAGES; page++) {
        const answer = await readIncidents(api, query, cursor)
        rows.push(...answer.incidents)
        cursor = answer.nextCursor
        if (!cursor) break
      }
      return { rows, more: cursor !== null }
    })().then(
      (value) => live && setList({ rows: value.rows, problem: null, more: value.more }),
      (error: unknown) => live && setList({ rows: null, problem: readProblemOf(error), more: false }),
    )
    return () => {
      live = false
    }
  }, [api, can.view, query])

  return <IncidentsPrintView model={{ person: session.user.displayName, at, company: session.company?.name ?? '', site: scope.site?.name ?? null, allSites: scope.allSites, address, canView: can.view, list }} />
}
