'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { readProblem } from '../../_shared/model'
import { getMatrix } from '../api'
import { printIdsOf, rowsShown, skillsAddressOf, skillsCan } from '../model'
import { MatrixPrintView, type MatrixPrintModel } from './view/MatrixPrintView'

/**
 * `/w/<company>/people/skills/print` (SCR-160 tab:matrix-print): the matrix's view on one A3 sheet for the line's notice
 * board, its filters written on top; `?ids=` = the rows chosen. Skills and machine authorisations only: never health data
 * and no figure about a person's work.
 */
export function MatrixPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const params = useSearchParams()
  const can = useMemo(() => skillsCan(session.permissions), [session.permissions])
  const address = useMemo(() => skillsAddressOf(params), [params])
  const ids = useMemo(() => printIdsOf(params), [params])
  const [at] = useState(() => new Date().toISOString())
  const [matrix, setMatrix] = useState<MatrixPrintModel['matrix']>({ value: null, problem: null })
  useEffect(() => {
    if (!can.view) return setMatrix({ value: null, problem: 'problem.forbidden' })
    let live = true
    getMatrix(api, { siteId: scope.siteId, tile: address.tile, sort: address.sort, q: address.q })
      .then((value) => {
        const rows = rowsShown(value.rows, address).filter((row) => ids.length === 0 || ids.includes(row.employeeId))
        if (live) setMatrix({ value: { ...value, rows }, problem: null })
      })
      .catch((error: unknown) => live && setMatrix({ value: null, problem: readProblem(error) }))
    return () => {
      live = false
    }
  }, [api, can.view, scope.siteId, address, ids])
  return <MatrixPrintView model={{ person: session.user.displayName, at, company: session.company?.name ?? '', site: scope.site?.name ?? null, address, picked: ids.length, matrix }} />
}
