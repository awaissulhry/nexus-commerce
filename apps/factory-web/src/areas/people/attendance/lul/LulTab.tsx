'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { storeUrl } from '../../../../record-panels/store'
import { openLul, readCloseMonths, type CloseMonth, type LulOpened } from '../api'
import { attendanceCan, isGateClosed, readProblem } from '../model'
import { LulView, type LulModel } from './view/LulView'

/**
 * `/w/<company>/people/attendance/lul?close=<id>` (design tab:lul-pdf): the sealed calendar of a closed month. Opening it is a
 * recorded act (people.attendance.lul, audit people.openLulCalendar), so the page POSTs once with its own key and shows the
 * 60-second link's file in the DS PdfViewer; the CSV is one more opening, asked by a button. Beside it the seal, and what the
 * labour consultant still confirms: this calendar is generic until they do.
 */
export function LulTab() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const closeId = params?.get('close') ?? ''
  const can = useMemo(() => attendanceCan(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const [opened, setOpened] = useState<LulOpened | null>(null)
  const [month, setMonth] = useState<CloseMonth | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [gateShut, setGateShut] = useState(false)
  const key = useRef(newIdempotencyKey())

  const read = useCallback(() => {
    if (!can.lul || !closeId) return
    setProblem(null)
    setOpened(null)
    openLul(api, closeId, 'PDF', key.current)
      .then(setOpened)
      .catch((error: unknown) => {
        if (isGateClosed(error)) setGateShut(true)
        else setProblem(readProblem(error))
      })
    if (companyId) readCloseMonths(api, companyId).then((months) => setMonth(months.find((entry) => entry.closeId === closeId) ?? null)).catch(() => setMonth(null))
  }, [api, can.lul, closeId, companyId])

  useEffect(() => read(), [read])

  const onCsv = useCallback(() => {
    openLul(api, closeId, 'CSV', newIdempotencyKey())
      .then((answer) => {
        const anchor = document.createElement('a')
        anchor.href = storeUrl(answer.download.url)
        anchor.download = answer.fileName
        anchor.click()
      })
      .catch((error: unknown) => setProblem(readProblem(error)))
  }, [api, closeId])

  const model: LulModel = { allowed: can.lul, closeId, can, prefix: companyPrefix(session.company?.code ?? ''), gateShut, opened, src: opened ? storeUrl(opened.download.url) : null, month, problem }
  return <LulView model={model} onRetry={read} onCsv={onCsv} />
}
