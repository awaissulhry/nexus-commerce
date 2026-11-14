'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem } from '../../_shared/model'
import { depthProblem, type DepthProblem } from '../../invoices/test-mode/depth'
import { TestModeBanner } from '../../invoices/test-mode/TestModeBanner'
import { cancelSelfInvoice, createSelfInvoice, listSelfInvoices, selfInvoiceCandidates, selfInvoicesTouched, type SelfInvoiceCandidate, type SelfInvoices as SelfInvoiceList } from './api'
import { SELF_REFUSALS, selfInvoiceAbilitiesOf, statusOfRows, type SelfRows } from './model'
import { SelfInvoicesSection, type SelfDialog, type SelfInvoicesModel } from './view/SelfInvoicesSection'

/**
 * Finance › Payables › Self-invoices' container (B-W2b-417 on B-W2b-401's API): the address's company; reads the list of
 * the rows chosen (GET /invoicing/self-invoices) and, for the create dialog, the supplier invoices from abroad; writes one
 * at a time with an Idempotency-Key (and the version on a cancel): Create (its draft opens), Make drafts N (one command
 * each, said per row), Cancel with the reason. Live: a self-invoice, a supplier invoice or the accountant's switch reads it again.
 */
export function SelfInvoices() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const prefix = pathname.replace(/\/finance\/payables(\/.*)?$/, '')
  const can = useMemo(() => selfInvoiceAbilitiesOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const [rows, setRows] = useState<SelfRows>('open')
  const [list, setList] = useState<{ value: SelfInvoiceList | null; problem: string | null }>({ value: null, problem: null })
  const [dialog, setDialog] = useState<SelfDialog | null>(null)
  const [candidates, setCandidates] = useState<{ value: SelfInvoiceCandidate[] | null; problem: string | null }>({ value: null, problem: null })
  const [draft, setDraft] = useState<SelfInvoicesModel['draft']>({ supplierInvoiceId: '', kind: null, rate: '22' })
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<DepthProblem | null>(null)
  const [notice, setNotice] = useState<SelfInvoicesModel['notice']>(null)

  const read = useCallback(async () => {
    if (!can.view || !companyId) return
    try {
      setList({ value: await listSelfInvoices(api, companyId, statusOfRows(rows)), problem: null })
    } catch (error) {
      setList({ value: null, problem: readProblem(error) })
    }
  }, [api, can.view, companyId, rows])
  useEffect(() => {
    setList({ value: null, problem: null })
    void read()
  }, [read])

  const readCandidates = useCallback(async () => {
    if (!companyId) return
    setCandidates({ value: null, problem: null })
    try {
      setCandidates({ value: await selfInvoiceCandidates(api, companyId), problem: null })
    } catch (error) {
      setCandidates({ value: null, problem: readProblem(error) })
    }
  }, [api, companyId])

  const reread = useCoalesced(() => void read(), 900)
  useLive(
    (change) => {
      if (selfInvoicesTouched(change)) reread()
    },
    () => reread(),
    can.view,
  )

  const openDialog = (next: SelfDialog | null) => {
    setProblem(null)
    setDialog(next)
    if (next?.kind === 'create') {
      setDraft({ supplierInvoiceId: '', kind: null, rate: '22' })
      void readCandidates()
    }
    if (next?.kind === 'cancel') setReason('')
  }

  return (
    <SelfInvoicesSection
      banner={<TestModeBanner companyId={companyId} />}
      model={{ prefix, can, rows, list, dialog, candidates, draft, reason, busy, problem, notice }}
      actions={{
        onRows: setRows,
        onRetry: () => void read(),
        onDialog: openDialog,
        onDraft: (patch) => setDraft((current) => ({ ...current, ...patch })),
        onReason: setReason,
        onRetryCandidates: () => void readCandidates(),
        onDismissNotice: () => setNotice(null),
        onOpen: (row) => router.push(row.invoice && can.cost ? `${prefix}/finance/invoices/${encodeURIComponent(row.invoice.id)}` : `${prefix}/finance/payables/${encodeURIComponent(row.supplierInvoice.id)}`),
        onCreate: () => {
          if (busy || !draft.kind || !draft.supplierInvoiceId) return
          const kind = draft.kind
          setBusy(true)
          setProblem(null)
          void (async () => {
            try {
              const made = await createSelfInvoice(api, { supplierInvoiceId: draft.supplierInvoiceId, kind, vatRatePct: draft.rate }, newIdempotencyKey())
              setDialog(null)
              if (made.invoice) router.push(`${prefix}/finance/invoices/${encodeURIComponent(made.invoice.id)}?tab=lines`)
              else void read()
            } catch (error) {
              setProblem(depthProblem(error, SELF_REFUSALS))
            } finally {
              setBusy(false)
            }
          })()
        },
        onMakeDrafts: (picked) => {
          if (busy || picked.length === 0) return
          setBusy(true)
          setNotice(null)
          void (async () => {
            let made = 0
            let refused = 0
            for (const row of picked) {
              try {
                await createSelfInvoice(api, { supplierInvoiceId: row.supplierInvoice.id, kind: row.kind }, newIdempotencyKey())
                made += 1
              } catch {
                refused += 1
              }
            }
            setNotice(refused === 0 ? { tone: 'success', words: { key: 'self.drafted', params: { count: made } } } : { tone: 'warning', words: { key: 'self.draftedSome', params: { made, refused } } })
            setBusy(false)
            void read()
          })()
        },
        onCancel: () => {
          const row = dialog?.kind === 'cancel' ? dialog.row : null
          if (busy || !row) return
          setBusy(true)
          setProblem(null)
          void (async () => {
            try {
              await cancelSelfInvoice(api, row, reason.trim(), newIdempotencyKey())
              setDialog(null)
              setNotice({ tone: 'success', words: { key: 'self.cancelled', params: { number: row.supplierInvoice.number } } })
              void read()
            } catch (error) {
              const words = depthProblem(error, SELF_REFUSALS)
              setProblem(words)
              if (words.reload) void read()
            } finally {
              setBusy(false)
            }
          })()
        },
      }}
    />
  )
}
