'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { fetchToday, readProblem } from './api'
import type { Loaded, TodayItem } from './model'
import { TodayPrintView } from './view/TodayPrintView'

/** The print page's rows: at most this many (the list as one page of paper). */
const PRINT_LIMIT = 200

/**
 * `/w/<company>/home/today/print` (Print my list): reads Needs me now once (`?kind=` as Today had it, at most 200 rows)
 * and draws it for paper. Opened in a new tab from Today's overflow menu.
 */
export function TodayPrint() {
  return (
    <WithMessages namespaces={['home']}>
      <PrintContainer />
    </WithMessages>
  )
}

function PrintContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const t = useT('home')
  const search = useSearchParams()
  const kind = search.get('kind')
  const tileParam = search.get('tile')
  const tile = tileParam === 'APPROVAL' || tileParam === 'ALERT' ? tileParam : null
  const [list, setList] = useState<Loaded<{ asOf: string; items: readonly TodayItem[]; total: number }>>({ status: 'loading' })
  const [filter, setFilter] = useState<string | null>(null)
  useEffect(() => {
    fetchToday(api, { kind, category: tile, limit: PRINT_LIMIT })
      .then((answer) => {
        setFilter(kind ? (answer.counts.byKind.find((entry) => entry.kind === kind)?.label ?? kind) : null)
        setList({ status: 'ready', data: { asOf: answer.asOf, items: answer.items, total: answer.total } })
      })
      .catch((error: unknown) => setList({ status: 'error', problem: readProblem(error) }))
  }, [api, kind, tile])
  const kindWords = tile ? t(`today.tile.${tile}.label`) : kind && t(`today.kind.${kind}`) !== `today.kind.${kind}` ? t(`today.kind.${kind}`) : filter
  return <TodayPrintView model={{ person: session.user.displayName, filter: kindWords, list }} />
}
