'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { downloadLink } from '../../../../record-panels/api'
import { readFromStore, storeUrl } from '../../../../record-panels/store'
import { getInvoice, getXml, type SupplierInvoice } from '../api'
import { payablesCanOf, readProblem } from '../model'
import type { Loaded } from '../record/record-model'
import { XmlView, type XmlViewModel } from './view/XmlView'

/**
 * `/w/<company>/finance/payables/<id>/xml` (the new tab "Supplier invoice as received"): reads the invoice, then — for an
 * invoice SDI delivered — its XML and what it names (`GET …/:id/xml`); the PDF is read from the store only when asked.
 */
export function XmlPage({ invoiceId }: { invoiceId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const prefix = pathname.replace(/\/finance\/payables\/[^/]+\/xml\/?$/, '')
  const can = useMemo(() => payablesCanOf(session.permissions), [session.permissions])
  const [invoice, setInvoice] = useState<Loaded<SupplierInvoice>>({ status: 'loading' })
  const [xml, setXml] = useState<XmlViewModel['xml']>(null)
  const [pdf, setPdf] = useState<XmlViewModel['pdf']>({ status: 'idle', src: null })

  const load = useCallback(async () => {
    if (!can.view) return
    try {
      const value = await getInvoice(api, invoiceId)
      setInvoice({ status: 'ready', value })
      if (!value.files.xml) {
        setXml(null)
        return
      }
      setXml({ value: null, problem: null })
      try {
        setXml({ value: await getXml(api, invoiceId), problem: null })
      } catch (error) {
        // 409: the XML's file is not (or no longer) in the file store — said as such, not as our failure.
        setXml({ value: null, problem: isApiError(error) && error.kind === 'conflict' ? 'xml.missing' : readProblem(error) })
      }
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setInvoice({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setInvoice({ status: 'forbidden' })
      else setInvoice({ status: 'error', problem: readProblem(error) })
    }
  }, [api, invoiceId, can.view])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <XmlView
      model={{ prefix, can, invoiceId, invoice, xml, pdf }}
      actions={{
        onRetry: () => void load(),
        onShowPdf: () => {
          const fileId = invoice.status === 'ready' ? invoice.value.files.pdf?.id : null
          if (!fileId) return
          setPdf({ status: 'loading', src: null })
          void (async () => {
            try {
              const { download } = await downloadLink(api, fileId)
              setPdf({ status: 'ready', src: await readFromStore(download) })
            } catch {
              setPdf({ status: 'error', src: null })
            }
          })()
        },
        onDownload: (fileId) => {
          void (async () => {
            try {
              const { download } = await downloadLink(api, fileId)
              const anchor = document.createElement('a')
              anchor.href = storeUrl(download.url)
              anchor.rel = 'noopener'
              document.body.appendChild(anchor)
              anchor.click()
              anchor.remove()
            } catch {
              setPdf((current) => (current.status === 'ready' ? current : { status: 'error', src: null }))
            }
          })()
        },
      }}
    />
  )
}
