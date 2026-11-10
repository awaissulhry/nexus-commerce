'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { declarationsCan, problemOf } from '../model'
import { pdfProblem, readPdf, readRecord } from '../record/DeclarationRecord'
import { failedRead, loadingRead, readyRead, type Read } from '../view-model'
import type { RecordDoc } from '../model'
import { PdfWindowView } from './view/WindowsView'

/**
 * `/w/<company>/compliance/declarations/pdf?id=<document>&show=<document of the family>` (SCR-052-pdf, a window page; design
 * tab:dc-pdf): the declaration or leaflet as it prints — a generated draft painted by the API with its DRAFT banner on every page
 * (never kept), a signed one its uploaded file — one language of the family at a time. A plain link cannot send the company
 * header, so the page reads the bytes into the viewer.
 */
export function PdfWindow() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/compliance\/declarations\/pdf\/?$/, '')
  const can = useMemo(() => declarationsCan(session.permissions), [session.permissions])
  const id = params?.get('id') ?? null
  const show = params?.get('show') ?? id
  const [read, setRead] = useState<Read<RecordDoc>>(loadingRead)
  const [pdf, setPdf] = useState<Read<Uint8Array | string> | null>(null)
  const [turn, setTurn] = useState(0)

  useEffect(() => {
    if (!id || !can.view) {
      setRead(failedRead(can.view ? 'problem.notFound' : 'problem.forbidden'))
      return
    }
    const controller = new AbortController()
    setRead(loadingRead)
    readRecord(api, id, controller.signal).then(
      (record) => !controller.signal.aborted && setRead(readyRead(record)),
      (error: unknown) => !controller.signal.aborted && setRead(failedRead(problemOf(error).key)),
    )
    return () => controller.abort()
  }, [api, id, can.view, turn])

  const record = read.status === 'ready' ? read.value : null
  useEffect(() => {
    if (!record || !show) return
    const controller = new AbortController()
    setPdf(loadingRead)
    readPdf(api, record, show, controller.signal).then(
      (value) => !controller.signal.aborted && setPdf(readyRead(value)),
      (error: unknown) => !controller.signal.aborted && setPdf(failedRead(pdfProblem(error))),
    )
    return () => controller.abort()
  }, [api, record, show, turn])

  return (
    <PdfWindowView
      model={{ prefix, read, shownId: show, pdf }}
      actions={{
        onShow: (next) => router.replace(`${pathname}?id=${encodeURIComponent(id ?? '')}&show=${encodeURIComponent(next)}`, { scroll: false }),
        onRetry: () => setTurn((n) => n + 1),
      }}
    />
  )
}
