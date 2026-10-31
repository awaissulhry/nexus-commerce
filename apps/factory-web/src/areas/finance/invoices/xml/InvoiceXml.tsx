'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi } from '../../../../lib/session/context'
import { downloadLink } from '../../../../record-panels/api'
import { WithMessages } from '../../../../record-panels/i18n'
import { readFromStore, storeUrl } from '../../../../record-panels/store'
import { getInvoice } from '../../_shared/api'
import { readProblem } from '../../_shared/model'
import { xmlViewOf } from './model'
import { InvoiceXmlView, type InvoiceXmlModel } from './view/InvoiceXmlView'

/**
 * `/w/<company>/finance/invoices/<id>/xml` (SCR-081-xml, a new tab): reads the invoice (invoices.view), then its legal XML
 * once from the file store (the files routes: a presigned read) and hands the text to the view, which shows it readable or
 * as the source (`?view=source`). Download saves the same file.
 */
export function InvoiceXml({ invoiceId }: { invoiceId: string }) {
  return (
    <WithMessages namespaces={['finance', 'finance-daily']}>
      <XmlContainer invoiceId={invoiceId} />
    </WithMessages>
  )
}

function XmlContainer({ invoiceId }: { invoiceId: string }) {
  const api = useOfficeApi()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/finance\/invoices\/[^/]+\/xml\/?$/, '')
  const [invoice, setInvoice] = useState<InvoiceXmlModel['invoice']>({ status: 'loading' })
  const [xml, setXml] = useState<InvoiceXmlModel['xml']>({ status: 'idle', text: null })
  const [fileId, setFileId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setInvoice({ status: 'loading' })
    setXml({ status: 'idle', text: null })
    try {
      const value = await getInvoice(api, invoiceId)
      setInvoice({ status: 'ready', value: { number: value.number, docType: value.docType, partyName: value.party.legalName, status: value.status, filesPending: value.filesPending, xmlFileId: value.xmlFileId } })
      setFileId(value.xmlFileId)
      if (!value.xmlFileId || value.status === 'DRAFT') return
      setXml({ status: 'loading', text: null })
      try {
        const { download } = await downloadLink(api, value.xmlFileId)
        const bytes = await readFromStore(download)
        setXml({ status: 'ready', text: new TextDecoder('utf-8').decode(bytes) })
      } catch {
        setXml({ status: 'error', text: null })
      }
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setInvoice({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setInvoice({ status: 'forbidden' })
      else setInvoice({ status: 'error', problem: readProblem(error) })
    }
  }, [api, invoiceId])

  useEffect(() => {
    void load()
  }, [load])

  const model: InvoiceXmlModel = { prefix, invoiceId, invoice, xml, view: xmlViewOf(params) }
  return (
    <InvoiceXmlView
      model={model}
      actions={{
        onRetry: () => void load(),
        onView: (view) => router.replace(view === 'source' ? `${pathname}?view=source` : pathname),
        onDownload: () => {
          if (!fileId) return
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
              setXml((current) => ({ ...current, status: current.text ? current.status : 'error' }))
            }
          })()
        },
      }}
    />
  )
}
