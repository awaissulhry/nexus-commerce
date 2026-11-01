'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { listEmployees, myTeams, type Employee } from '../../_shared/api'
import { employeesAddressOf, employeesQuery, peopleCan, readProblem } from '../../_shared/model'
import { StaffPrintView } from './view/StaffPrintView'

/** The most rows one staff list prints (pages of 500). */
const MAX = 2000

/**
 * `/w/<company>/people/employees/print` (SCR-084 tab:staff-print "Print stylesheet of the current view with its filters
 * written on top"): the list's own address terms (`?tile=`, `?rows=`, `?q=`) and the top bar's site, every page read,
 * drawn for paper with the filters on top. No pay, attendance, health or per-person work column.
 */
export function StaffPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const params = useSearchParams()
  const can = useMemo(() => peopleCan(session.permissions), [session.permissions])
  const address = useMemo(() => employeesAddressOf(params), [params])
  const [at] = useState(() => new Date().toISOString())
  const [rows, setRows] = useState<{ value: Employee[] | null; problem: string | null; cut: boolean }>({ value: null, problem: null, cut: false })
  useEffect(() => {
    if (!can.view) {
      setRows({ value: null, problem: 'problem.forbidden', cut: false })
      return
    }
    let live = true
    const read = async () => {
      const team = address.rows === 'MY_TEAM' && can.team ? ((await myTeams(api)).teams[0]?.id ?? null) : null
      const query = employeesQuery(address, team)
      const found: Employee[] = []
      let cursor: string | null = null
      do {
        const answer = await listEmployees(api, { ...query, siteId: scope.siteId, limit: 500, cursor })
        found.push(...answer.employees)
        cursor = answer.nextCursor
      } while (cursor && found.length < MAX)
      return { value: found.slice(0, MAX), cut: cursor !== null }
    }
    read()
      .then((value) => live && setRows({ ...value, problem: null }))
      .catch((error: unknown) => live && setRows({ value: null, problem: readProblem(error), cut: false }))
    return () => {
      live = false
    }
  }, [api, address, scope.siteId, can.view, can.team])
  return <StaffPrintView model={{ person: session.user.displayName, at, company: session.company?.name ?? '', site: scope.site?.name ?? null, address, rows }} />
}
