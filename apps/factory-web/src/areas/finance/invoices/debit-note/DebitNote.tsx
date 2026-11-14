'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import type { InvoiceRow } from '../../_shared/api'
import { abilitiesOf, readProblem } from '../../_shared/model'
import { depthProblem, type DepthProblem } from '../test-mode/depth'
import { createDebitNote, getDebitNotes, issuedOf, type DebitNotes } from './api'
import { debitInputsOf, emptyDebitLine, FOLLOWS, type DebitLineDraft, type NewKind } from './model'
import { DebitNoteDialog } from './view/DebitNoteDialog'

/**
 * New ▾ › Debit note / Credit note (B-W2b-417 on B-W2b-401's API): the invoice handed over by the record, else the issued
 * invoices the person sees to pick from (GET /invoicing/invoices per type); a debit note reads whether the invoice takes
 * one and its debit notes, then makes the TD05 draft (one write, an Idempotency-Key) and opens it; a credit note opens the
 * invoice's own credit note dialog (`?tab=lines&do=credit`).
 */
export function DebitNote({ kind, fixed = null, onClose }: { kind: NewKind; fixed?: { id: string; number: string | null; partyName: string } | null; onClose: () => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const prefix = pathname.replace(/\/finance\/invoices(\/.*)?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const [rows, setRows] = useState<{ value: InvoiceRow[] | null; problem: string | null }>({ value: null, problem: null })
  const [invoiceId, setInvoiceId] = useState<string | null>(fixed?.id ?? null)
  const [info, setInfo] = useState<{ value: DebitNotes | null; problem: string | null } | null>(null)
  const [lines, setLines] = useState<DebitLineDraft[]>([emptyDebitLine()])
  const [causale, setCausale] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<DepthProblem | null>(null)

  const readRows = useCallback(async () => {
    if (fixed) return
    setRows({ value: null, problem: null })
    try {
      setRows({ value: await issuedOf(api, FOLLOWS[kind]), problem: null })
    } catch (error) {
      setRows({ value: null, problem: readProblem(error) })
    }
  }, [api, fixed, kind])
  useEffect(() => {
    void readRows()
  }, [readRows])

  useEffect(() => {
    if (kind !== 'debit' || !invoiceId) {
      setInfo(null)
      return
    }
    let live = true
    setInfo({ value: null, problem: null })
    getDebitNotes(api, invoiceId)
      .then((value) => live && setInfo({ value, problem: null }))
      .catch((error: unknown) => live && setInfo({ value: null, problem: readProblem(error) }))
    return () => {
      live = false
    }
  }, [api, invoiceId, kind])

  return (
    <DebitNoteDialog
      model={{ can, kind, fixed, rows, invoiceId, info, lines, causale, busy, problem }}
      actions={{
        onPick: (id) => {
          setProblem(null)
          setInvoiceId(id)
        },
        onLines: setLines,
        onCausale: setCausale,
        onRetry: () => void readRows(),
        onOpenCredit: () => {
          if (invoiceId) router.push(`${prefix}/finance/invoices/${invoiceId}?tab=lines&do=credit`)
        },
        onCreate: () => {
          if (busy || !invoiceId) return
          setBusy(true)
          setProblem(null)
          const key = newIdempotencyKey()
          void (async () => {
            try {
              const draft = await createDebitNote(api, invoiceId, { lines: debitInputsOf(lines), causale: causale.trim() || null }, key)
              onClose()
              router.push(`${prefix}/finance/invoices/${draft.id}?tab=lines`)
            } catch (error) {
              setProblem(depthProblem(error, ['DEBIT_NOTE', 'DATABASE']))
            } finally {
              setBusy(false)
            }
          })()
        },
        onClose,
      }}
    />
  )
}
