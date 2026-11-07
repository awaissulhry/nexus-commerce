'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { readSheet, type RoleSheet, type SheetLaw } from '../api'
import { readProblemOf, riskCan } from '../model'
import { RoleSheetsPrintView } from './view/RoleSheetsPrintView'

/**
 * `/w/<company>/plant/risk/role-sheets?id=<sheet>&id=…` (SCR-209-role-sheet, a new tab): each role sheet read (GET
 * /safety/rolesheets/:id, safety.view), one page each, in the order asked.
 */
export function RoleSheetsPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const can = useMemo(() => riskCan(session.permissions), [session.permissions])
  const ids = useMemo(() => params.getAll('id').filter(Boolean).slice(0, 60), [params])
  const key = ids.join(',')
  const [at] = useState(() => new Date().toISOString())
  const [read, setRead] = useState<{ sheets: RoleSheet[] | null; law: SheetLaw | null; problem: string | null }>({ sheets: null, law: null, problem: null })

  useEffect(() => {
    if (!can.view) return
    let live = true
    setRead({ sheets: null, law: null, problem: null })
    Promise.all(ids.map((id) => readSheet(api, id))).then(
      (answers) => live && setRead({ sheets: answers.map((answer) => answer.roleSheet), law: answers[0]?.law ?? null, problem: null }),
      (error: unknown) => live && setRead({ sheets: null, law: null, problem: readProblemOf(error) }),
    )
    return () => {
      live = false
    }
  }, [api, can.view, key])

  return <RoleSheetsPrintView model={{ person: session.user.displayName, at, company: session.company?.name ?? '', canView: can.view, ...read }} />
}
