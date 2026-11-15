'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { dispatchAbilitiesOf } from '../../pickup/dispatch'
import { customsPaperPdf, readExport } from '../api'
import { PaperWindowView, type PaperWindowModel } from '../view/PaperWindowView'

/**
 * `/w/<company>/warehouse/shipments/customs-paper?shipment=<id>&document=<id>` (SCR-654, a window page: WINDOW_PAGES; design
 * tab sh-tab-ci): the shipment's export read (which paper, its version) and the paper's bytes (`…/export/documents/:id/pdf`,
 * the price grain) into the viewer: a plain link cannot send the company header.
 */
export function PaperWindow() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/warehouse\/shipments\/customs-paper\/?$/, '')
  const shipmentId = params?.get('shipment') ?? null
  const documentId = params?.get('document') ?? null
  const price = useMemo(() => dispatchAbilitiesOf(session.permissions).price, [session.permissions])
  const [model, setModel] = useState<PaperWindowModel>({ prefix, read: { status: 'loading' }, pdf: null })
  const [turn, setTurn] = useState(0)

  useEffect(() => {
    if (!shipmentId || !documentId) {
      setModel((state) => ({ ...state, read: { status: 'error', problem: 'notFound' } }))
      return
    }
    if (!price) {
      setModel((state) => ({ ...state, read: { status: 'error', problem: 'noPrice' } }))
      return
    }
    const controller = new AbortController()
    setModel({ prefix, read: { status: 'loading' }, pdf: null })
    readExport(api, shipmentId, controller.signal)
      .then((read) => {
        if (controller.signal.aborted) return
        const document = [...read.papers.commercialInvoice, ...read.papers.postalForm.versions].find((entry) => entry.documentId === documentId) ?? null
        if (!document) return setModel((state) => ({ ...state, read: { status: 'error', problem: 'notFound' } }))
        setModel((state) => ({ ...state, read: { status: 'ready', value: { shipmentId: read.shipment.id, shipmentNumber: read.shipment.number, document } }, pdf: { status: 'loading' } }))
        customsPaperPdf(api, shipmentId, documentId, controller.signal).then(
          (bytes) => !controller.signal.aborted && setModel((state) => ({ ...state, pdf: { status: 'ready', value: bytes } })),
          () => !controller.signal.aborted && setModel((state) => ({ ...state, pdf: { status: 'error' } })),
        )
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const problem = isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : isApiError(error) && error.kind === 'not_found' ? 'notFound' : 'failed'
        setModel((state) => ({ ...state, read: { status: 'error', problem } }))
      })
    return () => controller.abort()
  }, [api, shipmentId, documentId, prefix, price, turn])

  return <PaperWindowView model={model} onRetry={() => setTurn((n) => n + 1)} />
}
