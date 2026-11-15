'use client'

import { useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { downloadLink } from '../../../../record-panels/api'
import { storeUrl } from '../../../../record-panels/store'
import { keepPdf, readKeptPdfs, sendPdf, type KeptPdfs, type PdfLanguage } from './api'
import { emptySend, keepHeld, sendBody, sendHeld, sendOpenHeld, type KeptPdfModel, type SendDraft } from './model'

export interface KeptPdfInput {
  api: ApiClient
  listId: string
  /** The version the page prints (null: none yet, or the list has none). */
  versionId: string | null
  /** The list has no version to print. */
  none: boolean
  /** The company of the screen: a list of every company is kept on its letterhead. */
  companyId: string | null
  can: { manage: boolean; price: boolean }
  /** The list's customers (the mail goes to one of them). */
  customers: KeptPdfModel['customers']
  /** The language the person reads in (the first choice of the PDF's). */
  locale: PdfLanguage
}

export interface KeptPdfActions {
  onLanguage?: (language: PdfLanguage) => void
  onKeep?: () => void
  onOpen?: (fileId: string) => void
  onSendOpen?: () => void
  onSendField?: (field: 'partyId' | 'to' | 'cc' | 'subject' | 'message', value: string) => void
  onSend?: () => void
  onSendClose?: () => void
  onDismiss?: () => void
  onRetry?: () => void
}

/** A refusal in words (`prices-followups`). */
function problemOf(error: unknown): string {
  if (isApiError(error)) {
    if (error.kind === 'forbidden') return 'pdf.problem.forbidden'
    if (error.kind === 'conflict') return 'pdf.problem.conflict'
    if (error.kind === 'invalid') return 'pdf.problem.invalid'
    if (error.kind === 'not_found') return 'pdf.problem.notFound'
  }
  return 'pdf.problem.unavailable'
}

/**
 * The print page's kept PDFs (B-W2b-380, XF6:01): reads them for the version printed (the price grain), keeps one (POST …/pdf,
 * the same contents give the newest back), opens one (the file's link, a new tab), mails the newest (POST …/pdf/send) — one
 * write at a time, each with its own Idempotency-Key; refusals in words, the letterhead's included.
 */
export function useKeptPdf(input: KeptPdfInput): { model: KeptPdfModel; actions: KeptPdfActions } {
  const { api, listId, versionId, none, companyId, can, customers, locale } = input
  const [read, setRead] = useState<KeptPdfModel['read']>({ status: 'loading' })
  const [language, setLanguage] = useState<PdfLanguage>(locale)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<KeptPdfModel['notice']>(null)
  const [send, setSend] = useState<SendDraft | null>(null)
  const [tries, setTries] = useState(0)
  const latest = useRef({ read, send, language, busy })
  latest.current = { read, send, language, busy }

  useEffect(() => {
    if (none) return setRead({ status: 'none' })
    if (!versionId || !can.price) return setRead({ status: 'loading' })
    const control = new AbortController()
    setRead({ status: 'loading' })
    readKeptPdfs(api, listId, versionId, control.signal)
      .then((value) => setRead({ status: 'ready', value }))
      .catch((error: unknown) => !control.signal.aborted && setRead({ status: 'error', problem: { key: problemOf(error) } }))
    return () => control.abort()
  }, [api, listId, versionId, none, can.price, tries])

  const ready = (value: KeptPdfs) => setRead({ status: 'ready', value })
  const model: KeptPdfModel = { can, customers, read, language, busy, notice, send }

  const actions: KeptPdfActions = {
    onLanguage: setLanguage,
    onKeep: () => {
      const current = latest.current
      if (!versionId || keepHeld({ can, read: current.read, busy: current.busy })) return
      const needsCompany = current.read.status === 'ready' && current.read.value.needsCompany
      setBusy(true)
      setNotice(null)
      keepPdf(api, listId, versionId, { language: current.language, ...(needsCompany ? { companyId } : {}) })
        .then((answer) => {
          ready(answer.pdf)
          setNotice({ tone: 'success', words: { key: answer.made ? 'pdf.kept' : 'pdf.keptSame', params: { version: answer.version } } })
        })
        .catch((error: unknown) => setNotice({ tone: 'danger', words: { key: problemOf(error) } }))
        .finally(() => setBusy(false))
    },
    onOpen: (fileId) => {
      downloadLink(api, fileId)
        .then(({ download }) => window.open(storeUrl(download.url), '_blank', 'noopener,noreferrer'))
        .catch((error: unknown) => setNotice({ tone: 'danger', words: { key: problemOf(error) } }))
    },
    onSendOpen: () => {
      const current = latest.current
      if (sendOpenHeld({ can, read: current.read, busy: current.busy, customers })) return
      setSend(emptySend(customers[0]?.id ?? ''))
    },
    onSendField: (field, value) => setSend((draft) => (draft ? { ...draft, [field]: value, problem: null } : draft)),
    onSend: () => {
      const current = latest.current
      const draft = current.send
      if (!draft || !versionId || sendHeld(draft)) return
      setSend({ ...draft, sending: true, problem: null })
      sendPdf(api, listId, versionId, sendBody(draft, current.language))
        .then((answer) => {
          ready(answer.pdf)
          const named = customers.find((customer) => customer.id === draft.partyId)
          setSend((now) => (now ? { ...now, sending: false, sent: { to: sendBody(draft, current.language).to?.join(', ') ?? named?.legalName ?? '', at: new Date().toISOString() } } : now))
          setNotice({ tone: 'success', words: { key: 'pdf.sent', params: { version: answer.version } } })
        })
        .catch((error: unknown) => setSend((now) => (now ? { ...now, sending: false, problem: { key: problemOf(error) } } : now)))
    },
    onSendClose: () => setSend(null),
    onDismiss: () => setNotice(null),
    onRetry: () => setTries((value) => value + 1),
  }
  return { model, actions }
}
