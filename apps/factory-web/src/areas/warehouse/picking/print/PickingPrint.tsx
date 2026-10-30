'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { readProblem } from '../../../_shared/stock/model'
import { pickListSheets, type PickSheet } from '../api'
import { pickingCan, TIME_ZONE } from '../model'
import { PickingPrintView } from './view/PickingPrintView'

/**
 * `/w/<company>/warehouse/picking/print?ids=<work order>,…` (SCR-237 tab:pk-tab-pdf, "Pick list PDF (sorted by bin path)":
 * paper for the picker when the handheld is not used): the pick lists of up to 20 work orders, read once, drawn for paper —
 * one walk through the store for all of them, then each work order's lines. Opened in a new tab from Picking & kits; the
 * browser prints it or saves it as a PDF.
 */
export function PickingPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const ids = useMemo(() => [...new Set((params.get('ids') ?? '').split(',').map((value) => value.trim()).filter((value) => value !== ''))].slice(0, 20), [params])
  const can = useMemo(() => pickingCan(session.permissions), [session.permissions])
  const [sheets, setSheets] = useState<{ value: PickSheet[] | null; problem: string | null }>({ value: null, problem: null })
  const [readAt, setReadAt] = useState<string | null>(null)
  const key = ids.join(',')
  useEffect(() => {
    if (!can.view) return
    if (ids.length === 0) {
      setSheets({ value: [], problem: null })
      return
    }
    let live = true
    pickListSheets(api, ids)
      .then((answer) => {
        if (!live) return
        setSheets({ value: answer.sheets, problem: null })
        setReadAt(answer.asOf)
      })
      .catch((error: unknown) => live && setSheets({ value: null, problem: readProblem(error) }))
    return () => {
      live = false
    }
    // `key` stands for the ids.
  }, [api, can.view, key])
  return <PickingPrintView model={{ company: session.company?.name ?? '', ids, sheets, readAt, timeZone: TIME_ZONE, allowed: can.view }} />
}
