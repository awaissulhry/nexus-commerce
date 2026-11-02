'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { TIME_ZONE, todayIn } from '../../_shared/model'
import { readRoster, type Roster } from '../api'
import { rangeOf, readProblem, shiftsAddressOf, shiftsCan } from '../model'
import { RosterPrintView } from './view/RosterPrintView'

/**
 * `/w/<company>/people/shifts/print?from=&to=&line=&team=` (design people.shifts tab:roster-pdf "Week per line for the notice
 * board"): the roster read for the range, a page per line, Print = the browser's (Save as PDF). No overtime, absence or
 * warning: the paper hangs on a board, so a shift and the day off are all it says.
 */
export function RosterPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const params = useSearchParams()
  const can = useMemo(() => shiftsCan(session.permissions), [session.permissions])
  const address = useMemo(() => shiftsAddressOf(params), [params])
  const range = useMemo(() => rangeOf(address, todayIn(TIME_ZONE)), [address])
  const [at] = useState(() => new Date().toISOString())
  const [roster, setRoster] = useState<{ value: Roster | null; problem: string | null }>({ value: null, problem: null })
  useEffect(() => {
    if (!can.view) {
      setRoster({ value: null, problem: 'problem.forbidden' })
      return
    }
    let live = true
    readRoster(api, { siteId: scope.siteId, from: range.from, to: range.to, lineId: address.lineId, teamId: address.teamId })
      .then((value) => live && setRoster({ value, problem: null }))
      .catch((error: unknown) => live && setRoster({ value: null, problem: readProblem(error) }))
    return () => {
      live = false
    }
  }, [api, can.view, scope.siteId, range, address.lineId, address.teamId])
  return <RosterPrintView model={{ person: session.user.displayName, at, company: session.company?.name ?? '', range, roster }} />
}
