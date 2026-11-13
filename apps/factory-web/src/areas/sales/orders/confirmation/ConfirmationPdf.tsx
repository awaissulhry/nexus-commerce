'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { downloadLink } from '../../../../record-panels/api'
import { storeUrl } from '../../../../record-panels/store'
import { getConfirmation, makeConfirmation } from '../depth/api'
import { depthCanOf, readProblemOf, writeProblemOf } from '../depth/model'
import type { Phrase } from '../model'
import { ConfirmationPdfView, type ConfirmationPdfModel } from './view/ConfirmationPdfView'

/**
 * `/w/<company>/sales/orders/<id>/confirmation` (SCR-430, tab:orders.confirmation; the list's "Print confirmation" and the
 * Documents tab's "Open in new tab"): reads the order's confirmation with the company header a plain link cannot send, then the
 * newest PDF from the file store; Make confirmation (orders.manage) makes one when none prints the order as it is.
 */
export function ConfirmationPdf({ orderId }: { orderId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const can = useMemo(() => depthCanOf(session.permissions), [session.permissions])
  const [confirmation, setConfirmation] = useState<ConfirmationPdfModel['confirmation']>({ status: 'loading' })
  const [pdf, setPdf] = useState<string | null>(null)
  const [pdfProblem, setPdfProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Phrase | null>(null)
  const keyRef = useRef(newIdempotencyKey())

  const read = useCallback(async () => {
    if (!can.view) return
    setConfirmation({ status: 'loading' })
    try {
      setConfirmation({ status: 'ready', value: await getConfirmation(api, orderId) })
    } catch (error) {
      setConfirmation({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, orderId, can.view])

  useEffect(() => {
    void read()
  }, [read])

  const newest = confirmation.status === 'ready' ? (confirmation.value.versions[0]?.fileId ?? null) : null
  useEffect(() => {
    if (!newest || !can.files) return
    let gone = false
    setPdf(null)
    setPdfProblem(null)
    downloadLink(api, newest)
      .then(({ download }) => !gone && setPdf(storeUrl(download.url)))
      .catch((error: unknown) => !gone && setPdfProblem(readProblemOf(error)))
    return () => {
      gone = true
    }
  }, [api, newest, can.files])

  const make = async () => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      const answer = await makeConfirmation(api, orderId, locale === 'en' ? 'en' : 'it', keyRef.current)
      keyRef.current = newIdempotencyKey()
      setConfirmation({ status: 'ready', value: answer.confirmation })
    } catch (error) {
      setProblem(writeProblemOf(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmationPdfView
      model={{ allowed: can.view, files: can.files, can, number: confirmation.status === 'ready' ? confirmation.value.number : null, confirmation, pdf, pdfProblem, busy, problem }}
      onMake={() => void make()}
      onRetry={() => void read()}
    />
  )
}
