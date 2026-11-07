'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { fileAddress, keepReceipt, newIdempotencyKey, readReceipt, receiptPdf } from '../api'
import { ppeCan, problemOf, readProblemOf } from '../model'
import { ReceiptTabView, type ReceiptTabModel } from './view/ReceiptTabView'

/**
 * `/w/<company>/plant/ppe/receipt?receipt=<id>[&receipt=<id>…]&at=<n>&language=it|en` (SCR-211-receipt, a new tab from Issues and
 * Print receipts): the receipt shown (GET /safety/ppe/receipts/:id, safety.view), then its PDF preview (GET …/pdf, stored
 * nowhere); Keep the PDF (POST …/pdf, safety.ppe.issue, PIN receipts only); the paper scan or the kept PDF opens through the
 * files routes (files.read, a 60-second address).
 */
export function ReceiptTab() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const pageLocale = useLocale()
  const can = useMemo(() => ppeCan(session.permissions), [session.permissions])
  const ids = useMemo(() => [...new Set(params.getAll('receipt').map((id) => id.trim()).filter(Boolean))].slice(0, 100), [params])
  const at = Math.min(Math.max(Number(params.get('at') ?? '0') || 0, 0), Math.max(ids.length - 1, 0))
  const asked = params.get('language')
  const language: 'it' | 'en' = asked === 'it' || asked === 'en' ? asked : pageLocale === 'en' ? 'en' : 'it'
  const receiptId = ids[at] ?? ''
  const [state, setState] = useState<Pick<ReceiptTabModel, 'record' | 'pdf' | 'pdfProblem' | 'keeping' | 'kept' | 'keepProblem' | 'fileProblem'>>({ record: { value: null, problem: null }, pdf: null, pdfProblem: null, keeping: false, kept: null, keepProblem: null, fileProblem: null })

  const read = useCallback(async () => {
    if (!can.view) return
    setState({ record: { value: null, problem: null }, pdf: null, pdfProblem: null, keeping: false, kept: null, keepProblem: null, fileProblem: null })
    if (!receiptId) {
      setState((current) => ({ ...current, record: { value: null, problem: 'problem.notFound' } }))
      return
    }
    try {
      const value = await readReceipt(api, receiptId)
      setState((current) => ({ ...current, record: { value, problem: null } }))
    } catch (error) {
      setState((current) => ({ ...current, record: { value: null, problem: readProblemOf(error) } }))
      return
    }
    try {
      const pdf = await receiptPdf(api, receiptId, language)
      setState((current) => ({ ...current, pdf }))
    } catch (error) {
      setState((current) => ({ ...current, pdfProblem: readProblemOf(error) }))
    }
  }, [api, can.view, receiptId, language])

  useEffect(() => {
    void read()
  }, [read])

  const address = (change: { at?: number; language?: 'it' | 'en' }) => {
    const next = new URLSearchParams()
    for (const id of ids) next.append('receipt', id)
    const index = change.at ?? at
    if (index > 0) next.set('at', String(index))
    next.set('language', change.language ?? language)
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }

  return (
    <ReceiptTabView
      model={{ canView: can.view, canKeep: can.issue, canReadFiles: can.readFiles, ids, index: at, language, ...state }}
      actions={{
        onLanguage: (next) => address({ language: next }),
        onMove: (index) => address({ at: index }),
        onRetry: () => void read(),
        onKeep: () => {
          if (!can.issue || state.keeping || !receiptId) return
          setState((current) => ({ ...current, keeping: true, keepProblem: null }))
          keepReceipt(api, receiptId, language, newIdempotencyKey()).then(
            (kept) => setState((current) => ({ ...current, keeping: false, kept })),
            (error: unknown) => setState((current) => ({ ...current, keeping: false, keepProblem: problemOf(error) })),
          )
        },
        onOpenFile: (fileId) => {
          setState((current) => ({ ...current, fileProblem: null }))
          fileAddress(api, fileId).then(
            (url) => window.open(url, '_blank', 'noopener'),
            (error: unknown) => setState((current) => ({ ...current, fileProblem: readProblemOf(error) === 'problem.read' ? 'problem.file' : readProblemOf(error) })),
          )
        },
      }}
    />
  )
}
