'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { companyPrefix } from '../../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { readProblem } from '../../model'
import { getCutOrder, type CutOrderRecord } from '../api'
import { ordersCanOf, sheetAddressOf } from '../model'
import { LaySheetView } from './view/LaySheetView'

/**
 * `/w/<company>/production/cutting/sheet?id=<cut order>&lay=<lay>` (SCR-238-sheet, a new tab in window mode): the cut order read
 * once (production.cutting.view), drawn for paper — every lay, or the one asked.
 */
export function LaySheet() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const can = useMemo(() => ordersCanOf(session.permissions), [session.permissions])
  const address = sheetAddressOf(params)
  const [at] = useState(() => new Date().toISOString())
  const [record, setRecord] = useState<CutOrderRecord | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (!can.view || !address.id) return
    const controller = new AbortController()
    setRecord(null)
    setProblem(null)
    getCutOrder(api, address.id, controller.signal)
      .then(setRecord)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setProblem(readProblem(error))
      })
    return () => controller.abort()
  }, [api, can.view, address.id])

  return (
    <LaySheetView
      model={{
        prefix: companyPrefix(session.company?.code ?? ''),
        can: can.view,
        person: session.user.displayName,
        at,
        company: session.company?.name ?? null,
        timeZone: 'Europe/Rome',
        record,
        problem,
        layId: address.lay,
        nothing: address.id === null,
      }}
    />
  )
}
