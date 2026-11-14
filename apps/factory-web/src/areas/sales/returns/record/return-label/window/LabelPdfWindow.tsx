'use client'

import { useEffect, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../../../lib/api/errors'
import { useOfficeApi } from '../../../../../../lib/session/context'
import { readReturnLabels, returnLabelPdf } from '../api'
import { LabelPdfWindowView, type LabelPdfWindowModel } from '../view/LabelPdfWindowView'

/**
 * `/w/<company>/sales/returns/label?return=<id>&label=<id>` (SCR-112-label-pdf, a window page: WINDOW_PAGES; design
 * sales.returns tab:returns.label "Return label PDF — printed or sent to the customer"): the return label's PDF in the
 * viewer, to print or download. A plain link cannot send the company header, so the page reads the bytes into the viewer.
 */
export function LabelPdfWindow() {
  const api = useOfficeApi()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/sales\/returns\/label\/?$/, '')
  const returnId = params?.get('return') ?? null
  const labelId = params?.get('label') ?? null
  const [model, setModel] = useState<LabelPdfWindowModel>({ prefix, read: { status: 'loading' }, pdf: null })
  const [turn, setTurn] = useState(0)

  useEffect(() => {
    if (!returnId || !labelId) {
      setModel((state) => ({ ...state, read: { status: 'error', problem: 'notFound' } }))
      return
    }
    const controller = new AbortController()
    setModel({ prefix, read: { status: 'loading' }, pdf: null })
    readReturnLabels(api, returnId, controller.signal)
      .then((read) => {
        if (controller.signal.aborted) return
        const label = read.labels.find((row) => row.id === labelId) ?? null
        if (!label) {
          setModel((state) => ({ ...state, read: { status: 'error', problem: 'notFound' } }))
          return
        }
        setModel((state) => ({ ...state, read: { status: 'ready', value: { returnId: read.return.id, number: read.return.number, label } }, pdf: label.file ? { status: 'loading' } : null }))
        if (!label.file) return
        returnLabelPdf(api, returnId, labelId, controller.signal).then(
          (bytes) => !controller.signal.aborted && setModel((state) => ({ ...state, pdf: { status: 'ready', value: bytes } })),
          () => !controller.signal.aborted && setModel((state) => ({ ...state, pdf: { status: 'error', problem: 'pdf' } })),
        )
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const problem = isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : isApiError(error) && error.kind === 'not_found' ? 'notFound' : 'failed'
        setModel((state) => ({ ...state, read: { status: 'error', problem } }))
      })
    return () => controller.abort()
  }, [api, returnId, labelId, prefix, turn])

  return <LabelPdfWindowView model={model} actions={{ onRetry: () => setTurn((n) => n + 1) }} />
}
