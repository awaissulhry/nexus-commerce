'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { listEmployees, type Employee } from '../../_shared/api'
import { peopleCan, readProblem } from '../../_shared/model'
import { BADGE_SHEET_MAX } from './badge'
import { BadgeSheetView } from './view/BadgeSheetView'

/**
 * `/w/<company>/people/employees/badges?ids=` (SCR-085 tab:badge-pdf): the named people read from the register (every
 * record, pages of 500 until all are found), drawn as badge faces for paper. The browser prints it (or saves a PDF).
 */
export function BadgeSheet() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const can = useMemo(() => peopleCan(session.permissions), [session.permissions])
  const ids = useMemo(() => (params?.get('ids') ?? '').split(',').map((id) => id.trim()).filter(Boolean).slice(0, BADGE_SHEET_MAX), [params])
  const [at] = useState(() => new Date().toISOString())
  const [origin, setOrigin] = useState('')
  useEffect(() => setOrigin(window.location.origin), [])
  const [people, setPeople] = useState<{ value: Employee[] | null; problem: string | null }>({ value: null, problem: null })
  useEffect(() => {
    if (!can.view) {
      setPeople({ value: null, problem: 'problem.forbidden' })
      return
    }
    let live = true
    const read = async (): Promise<Employee[]> => {
      if (ids.length === 0) return []
      const found = new Map<string, Employee>()
      let cursor: string | null = null
      for (let page = 0; page < 10; page += 1) {
        const answer = await listEmployees(api, { rows: 'ALL', limit: 500, cursor })
        for (const row of answer.employees) if (ids.includes(row.id)) found.set(row.id, row)
        cursor = answer.nextCursor
        if (!cursor || found.size === ids.length) break
      }
      return ids.flatMap((id) => found.get(id) ?? [])
    }
    read()
      .then((value) => live && setPeople({ value, problem: null }))
      .catch((error: unknown) => live && setPeople({ value: null, problem: readProblem(error) }))
    return () => {
      live = false
    }
  }, [api, ids, can.view])
  return <BadgeSheetView model={{ person: session.user.displayName, at, asked: ids.length, people, origin, prefix: companyPrefix(session.company?.code ?? ''), companyName: session.company?.name ?? '' }} />
}
