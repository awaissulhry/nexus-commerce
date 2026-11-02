'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ticketLabel } from '@nexus/factory-domain/production/bundles/ticket'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { readProblem } from '../../_shared/model'
import { getBundle, ticketPdf } from '../api'
import { bundlesCanOf, ticketOf } from '../model'
import { TicketPdfView, type TicketPdfModel } from './view/TicketPdfView'

/**
 * `/w/<company>/production/bundles/<id>/ticket` (SCR-259 tab:bd-tab-ticket): the record's ticket as the same label the
 * printer prints (factory-domain `ticketLabel`) through `POST /print/labels/pdf` (print.labels; stored nowhere).
 */
export function BundleTicketPdf({ bundleId }: { bundleId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const can = useMemo(() => bundlesCanOf(session.permissions), [session.permissions])
  const maker = session.company?.name ?? null
  const [model, setModel] = useState<TicketPdfModel>({ allowed: can.printLabels, code: null, pdf: null, problem: null })

  const read = useCallback(async () => {
    if (!can.printLabels) return
    setModel((current) => ({ ...current, pdf: null, problem: null }))
    try {
      const record = await getBundle(api, bundleId)
      setModel((current) => ({ ...current, code: record.bundle.code }))
      const pdf = await ticketPdf(api, ticketLabel(ticketOf(record, locale, maker)))
      setModel((current) => ({ ...current, pdf }))
    } catch (error) {
      setModel((current) => ({ ...current, problem: `production:${readProblem(error)}` }))
    }
  }, [api, bundleId, can.printLabels, locale, maker])

  useEffect(() => {
    void read()
  }, [read])

  return <TicketPdfView model={model} onRetry={() => void read()} />
}
