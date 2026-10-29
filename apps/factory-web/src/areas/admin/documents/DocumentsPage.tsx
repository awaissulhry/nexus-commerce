'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { listCompanies } from '../shared/api'
import { failed, loaded, loading, problemKey, problemNotice, type Loaded, type Notice } from '../shared/model'
import { isStepUpCancelled, useStepUp } from '../shared/step-up'
import { advanceSeries, closeSeries, createSeries, listSeries, seriesAllocations, setSeriesStart, type Allocation, type Series, type SeriesProof } from './api'
import { draftBody, fiscalRows, hasIssued, legalOf, type CompanyOption, type DocumentsDialog, type DocumentsView as ViewName, type ProofRead, type SeriesDraft } from './model'
import { DocumentsView } from './view/DocumentsView'


/** The address's dialog: `?series=<id>`, `?numbers=<id>`, `?close=<id>`, `?new=series`. */
function dialogOf(params: URLSearchParams | null): DocumentsDialog | null {
  const series = params?.get('series')
  if (series) return { kind: 'series', seriesId: series }
  const numbers = params?.get('numbers')
  if (numbers) return { kind: 'numbers', seriesId: numbers }
  const close = params?.get('close')
  if (close) return { kind: 'close', seriesId: close }
  if (params?.get('new') === 'series' || params?.get('new') === '1') return { kind: 'new' }
  return null
}

/**
 * `/w/<company>/admin/documents` (SCR-014): the companies (`GET /org/companies`), their number series
 * (`GET /numbering/series`), and for each fiscal series that issued a number its gap proof
 * (`GET /numbering/series/:id/allocations`). The list, the company and the open dialog live in the address
 * (`?view=documents`, `?company=<id>`, `?series=<id>`, `?numbers=<id>`, `?new=series`), so Back closes a dialog and a
 * link opens it. Reads again when the tab comes back into view (no live numbering event yet).
 */
export function DocumentsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = { manage: held.has('numbering.manage'), documents: held.has('documents.view') }
  const view: ViewName = params?.get('view') === 'documents' ? 'documents' : 'numbers'
  const companyId = params?.get('company') ?? 'all'
  const dialog = dialogOf(params)
  const [companies, setCompanies] = useState<Loaded<CompanyOption>>(loading())
  const [series, setSeries] = useState<Loaded<Series>>(loading())
  const [proofs, setProofs] = useState<Record<string, ProofRead>>({})
  const [numbers, setNumbers] = useState<{ seriesId: string; read: Loaded<Allocation>; proof: SeriesProof | null } | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const createKey = useRef<string | null>(null)

  /** Moves to another list, company or dialog: the address says which (replace: the dialog is not a page of its own). */
  const go = useCallback(
    (change: { view?: ViewName; company?: string; dialog?: DocumentsDialog | null }) => {
      const next = new URLSearchParams()
      const nextView = change.view ?? view
      const nextCompany = change.company ?? companyId
      if (nextView !== 'numbers') next.set('view', nextView)
      if (nextCompany !== 'all') next.set('company', nextCompany)
      const nextDialog = change.dialog === undefined ? dialog : change.dialog
      if (nextDialog?.kind === 'new') next.set('new', 'series')
      else if (nextDialog) next.set(nextDialog.kind, nextDialog.seriesId)
      const query = next.toString()
      router.replace(query ? `${pathname}?${query}` : (pathname ?? ''), { scroll: false })
    },
    [companyId, dialog, pathname, router, view],
  )

  const readProof = useCallback(
    async (row: Series) => {
      setProofs((current) => ({ ...current, [row.id]: { state: 'checking' } }))
      try {
        const answer = await seriesAllocations(api, row.id, 1)
        setProofs((current) => ({ ...current, [row.id]: { state: 'ok', proof: answer.summary } }))
      } catch (error) {
        setProofs((current) => ({ ...current, [row.id]: { state: 'failed', problem: problemKey(error) } }))
      }
    },
    [api],
  )

  const load = useCallback(async () => {
    const [companyRead, seriesRead] = await Promise.all([
      listCompanies(api).then(
        (items) =>
          loaded(
            items.map((company) => ({
              id: company.id,
              code: company.code,
              legalName: company.legalName,
              status: company.status,
              ...legalOf(company),
            })),
          ),
        (error: unknown) => failed<CompanyOption>(problemKey(error)),
      ),
      listSeries(api).then(
        (items) => loaded(items),
        (error: unknown) => failed<Series>(problemKey(error)),
      ),
    ])
    setCompanies(companyRead)
    setSeries(seriesRead)
    setAsOf(new Date().toISOString())
    for (const row of fiscalRows(seriesRead.items ?? []).filter(hasIssued)) void readProof(row)
  }, [api, readProof])

  useEffect(() => {
    void load()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  // The "numbers issued" dialog reads its series' last 50 numbers when it opens (and when J / K move it).
  const numbersId = dialog?.kind === 'numbers' ? dialog.seriesId : null
  useEffect(() => {
    if (!numbersId) {
      setNumbers(null)
      return
    }
    let live = true
    setNumbers({ seriesId: numbersId, read: loading(), proof: null })
    seriesAllocations(api, numbersId, 50).then(
      (answer) => live && setNumbers({ seriesId: numbersId, read: loaded(answer.allocations), proof: answer.summary }),
      (error: unknown) => live && setNumbers({ seriesId: numbersId, read: failed(problemKey(error)), proof: null }),
    )
    return () => {
      live = false
    }
  }, [api, numbersId])

  const replaceRow = (row: Series) => setSeries((current) => (current.items ? loaded(current.items.map((item) => (item.id === row.id ? row : item))) : current))

  /** One write: busy, the step-up dialog when the API asks for it, a notice, the problem in the dialog's words. */
  const write = useCallback(
    async (sentence: string, work: () => Promise<void>) => {
      setBusy(true)
      setDialogProblem(null)
      try {
        await guard(sentence, work)
      } catch (error) {
        if (isStepUpCancelled(error)) return
        const refusal = problemNotice(error)
        setDialogProblem(refusal.key === 'problem.conflict' ? 'docs.problem.conflict' : refusal.key === 'problem.invalid' ? 'docs.problem.invalid' : refusal.key)
        if (refusal.key === 'problem.conflict') void load()
      } finally {
        setBusy(false)
      }
    },
    [guard, load],
  )

  return (
    <DocumentsView
      model={{ prefix, view, companies, companyId, series, proofs, asOf, can, dialog, numbers, notice, busy, dialogProblem, stepUp }}
      actions={{
        onView: (next) => go({ view: next }),
        onCompany: (next) => go({ company: next }),
        onDialog: (next) => {
          setDialogProblem(null)
          if (next?.kind === 'new') createKey.current = newIdempotencyKey()
          go({ dialog: next })
        },
        onDismissNotice: () => setNotice(null),
        onRetry: () => {
          setSeries(loading())
          void load()
        },
        onRetryProof: (seriesId) => {
          const row = series.items?.find((item) => item.id === seriesId)
          if (row) void readProof(row)
        },
        onCreate: (draft: SeriesDraft) =>
          write('stepUp.sentence.default', async () => {
            const row = await createSeries(api, draftBody(draft), createKey.current ?? newIdempotencyKey())
            setSeries((current) => loaded([...(current.items ?? []), row]))
            setNotice({ key: 'docs.done.created', tone: 'success', params: { number: row.nextNumber ?? '' } })
            go({ dialog: null, company: companyId === 'all' ? 'all' : row.companyId })
          }),
        onSetStart: (row, startValue) =>
          write('stepUp.sentence.default', async () => {
            replaceRow(await setSeriesStart(api, row.id, { startValue, version: row.version }))
            setNotice({ key: 'docs.done.start', tone: 'success', params: { value: startValue } })
          }),
        onAdvance: (row, input) =>
          write('stepUp.sentence.default', async () => {
            const after = await advanceSeries(api, row.id, { ...input, version: row.version })
            replaceRow(after)
            setNotice({ key: 'docs.done.advanced', tone: 'success', params: { number: after.nextNumber ?? '' } })
          }),
        onCloseSeries: (row, reason) =>
          write('stepUp.sentence.default', async () => {
            replaceRow(await closeSeries(api, row.id, { version: row.version, ...(reason ? { reason } : {}) }))
            setNotice({ key: 'docs.done.closed', tone: 'success', params: { code: row.code } })
            go({ dialog: null })
          }),
        onSubmitStepUp: (code) => void submitStepUp(code),
        onCancelStepUp: cancelStepUp,
      }}
    />
  )
}
