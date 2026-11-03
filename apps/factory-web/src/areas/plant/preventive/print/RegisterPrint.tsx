'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { DEFAULT_TIME_ZONE } from '../../../../lib/i18n/format'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { readResults, type CheckResult } from '../api'
import { preventiveCan, printAddressOf, printWindow, readProblemOf, todayIn } from '../model'
import { RegisterPrintView } from './view/RegisterPrintView'

/** A print reads at most this many pages of the register (500 each): past it the paper says it stops short. */
export const PRINT_PAGES = 20

/**
 * `/w/<company>/plant/preventive/register?from=&to=[&ids=]` (SCR-266-register-print, a new tab): the check register for an
 * inspector, read page by page with the top bar's site (GET /plant/checks/results with the period; plant.view). Default
 * period: the last three years; Print N names the chosen results and their days.
 */
export function RegisterPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const can = useMemo(() => preventiveCan(session.permissions), [session.permissions])
  const address = useMemo(() => printAddressOf(params), [params])
  const [at] = useState(() => new Date().toISOString())
  const [localToday] = useState(() => todayIn(DEFAULT_TIME_ZONE))
  const span = printWindow(localToday, address)
  const [results, setResults] = useState<{ value: CheckResult[] | null; problem: string | null; truncated: boolean }>({ value: null, problem: null, truncated: false })
  const siteId = scope.siteId
  const { from, to } = span
  const ids = address.ids?.join(',') ?? ''

  useEffect(() => {
    if (!can.view) return
    let live = true
    setResults({ value: null, problem: null, truncated: false })
    ;(async () => {
      const rows: CheckResult[] = []
      let cursor: string | null = null
      let pages = 0
      do {
        const answer = await readResults(api, { siteId, from, to, cursor, limit: 500 })
        rows.push(...answer.results)
        cursor = answer.nextCursor
        pages += 1
      } while (cursor && pages < PRINT_PAGES)
      const wanted = ids ? new Set(ids.split(',')) : null
      return { value: wanted ? rows.filter((row) => wanted.has(row.id)) : rows, truncated: cursor !== null }
    })().then(
      (read) => live && setResults({ value: read.value, problem: null, truncated: read.truncated }),
      (error: unknown) => live && setResults({ value: null, problem: readProblemOf(error), truncated: false }),
    )
    return () => {
      live = false
    }
  }, [api, can.view, from, to, siteId, ids])

  return (
    <RegisterPrintView
      model={{ person: session.user.displayName, at, company: session.company?.name ?? '', site: scope.site?.name ?? null, allSites: scope.allSites, window: span, chosen: address.ids?.length ?? null, canView: can.view, results }}
      onPeriod={(period) => router.replace(`${pathname}?from=${period.from}&to=${period.to}`, { scroll: false })}
    />
  )
}
