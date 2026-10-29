'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useLiveChanges } from '../../../record-panels/live'
import { approveQuote, getQuote, listApprovals, rejectQuote, type ApprovalRow, type QuoteDetail } from '../../sales/quotes/api'
import { abilitiesOf, grainsOf, nextAfter } from '../../sales/quotes/model'
import { readProblem, writeProblem } from '../../sales/quotes/problems'
import type { Loaded } from '../../sales/quotes/record/record-model'
import { viewOf, type ApprovalsViewModel, type ApprovalView } from './model'
import { ApprovalsView } from './view/ApprovalsView'

const isApprovalChange = (type: string) => type === 'quote.approval_requested' || type === 'quote.approval_decided' || type === 'quote.reopened' || type === 'quote.cancelled' || type === 'quote.lines_changed' || type === 'quote.updated'

/**
 * `/w/<company>/home/approvals` (SCR-030): the quote approval queue (`GET /sales/quote-approvals?view=`; the API says per
 * row whether this person may decide it and why not), the review of one request (`?open=<id>`: the quote read now, so
 * the review re-checks it), and the decision through the quotes module's approve / reject with the quote's version as
 * read (a request that moved is a 409: read again, never overwritten). After a decision the next request opens. Live:
 * the approval events read the queue again.
 */
export function Approvals() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const view = viewOf(params?.get('view'))
  const openId = params?.get('open') ?? null
  const prefix = pathname.replace(/\/home\/approvals\/?$/, '')
  const grains = useMemo(() => grainsOf(session.permissions), [session.permissions])
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const [rows, setRows] = useState<ApprovalsViewModel['rows']>({ items: null, problem: null })
  const [counts, setCounts] = useState<ApprovalsViewModel['counts']>({ waiting: null, mine: null, decided: null, capped: false })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [review, setReview] = useState<{ id: string; quote: Loaded<QuoteDetail> } | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<ApprovalsViewModel['notice']>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const rowsRef = useRef<ApprovalRow[]>([])

  const address = useCallback((next: { view?: ApprovalView; open?: string | null }) => {
    const search = new URLSearchParams()
    const nextView = next.view ?? viewRef.current
    if (nextView !== 'waiting') search.set('view', nextView)
    const open = next.open === undefined ? openId : next.open
    if (open) search.set('open', open)
    const text = search.toString()
    router.replace(`${pathname}${text ? `?${text}` : ''}`)
  }, [openId, pathname, router])

  const load = useCallback(async () => {
    const wanted = viewRef.current
    try {
      const answer = await listApprovals(api, wanted)
      if (wanted !== viewRef.current) return
      rowsRef.current = answer.approvals
      setRows({ items: answer.approvals, problem: null })
      setCounts(answer.counts)
      setAsOf(answer.at)
    } catch (error) {
      setRows((current) => ({ ...current, problem: readProblem(error) }))
    }
  }, [api])

  useEffect(() => {
    setRows({ items: null, problem: null })
    void load()
  }, [view, load])

  const row = openId ? (rows.items?.find((item) => item.id === openId) ?? null) : null
  const quoteId = row?.quoteId ?? null
  const readReview = useCallback(async () => {
    if (!openId || !quoteId) return
    setReview({ id: openId, quote: { status: 'loading' } })
    try {
      setReview({ id: openId, quote: { status: 'ready', value: await getQuote(api, quoteId) } })
    } catch (error) {
      setReview({ id: openId, quote: isApiError(error) && error.kind === 'not_found' ? { status: 'not_found' } : isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) } })
    }
  }, [api, openId, quoteId])
  useEffect(() => {
    void readReview()
  }, [readReview])

  useLiveChanges({
    onChange: (change) => {
      if (!isApprovalChange(change.type)) return
      void load()
      if (quoteId && change.fields.quoteId === quoteId && !busy) void readReview()
    },
    onReconnect: () => void load(),
  })

  const decide = async (work: (current: { id: string; version: number }) => Promise<QuoteDetail>, done: string): Promise<boolean> => {
    if (!row) return false
    const quote = review?.quote.status === 'ready' ? review.quote.value : null
    setBusy(true)
    setNotice(null)
    try {
      await work({ id: row.quoteId, version: quote?.version ?? row.quoteVersion })
      setNotice({ key: done, tone: 'success', params: { number: row.number } })
      setRejecting(false)
      const next = nextAfter(rowsRef.current, row.id)
      await load()
      const still = next && rowsRef.current.some((item) => item.id === next) ? next : (rowsRef.current[0]?.id ?? null)
      address({ open: still })
      return true
    } catch (error) {
      const problem = writeProblem(error)
      setNotice({ key: problem.key === 'problem.write.forbidden' ? 'notice.forbidden' : problem.key, tone: 'danger' })
      if (problem.reload) {
        void load()
        void readReview()
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  const approveMany = async (ids: readonly string[], note: string): Promise<boolean> => {
    const chosen = rowsRef.current.filter((row) => ids.includes(row.id) && row.mayDecide)
    setBusy(true)
    setNotice(null)
    let done = 0
    for (const row of chosen) {
      try {
        // Each with the quote's version as read: a request that moved meanwhile is refused, never decided blind.
        await approveQuote(api, { id: row.quoteId, version: row.quoteVersion }, note || null)
        done++
      } catch {
        // Counted below; the queue is read again.
      }
    }
    setBusy(false)
    const failed = ids.length - done
    setNotice(failed === 0 ? { key: 'bulk.approved', tone: 'success', params: { count: done } } : { key: 'bulk.approvedPartly', tone: 'warning', params: { done, failed } })
    void load()
    return failed === 0
  }

  const model: ApprovalsViewModel = {
    prefix,
    me: session.user.id,
    grains,
    can,
    view,
    rows,
    counts,
    asOf,
    open: openId ? { id: openId, quote: rows.items && !row ? { status: 'not_found' } : review && review.id === openId ? review.quote : { status: 'loading' } } : null,
    rejecting,
    busy,
    notice,
  }

  return (
    <ApprovalsView
      model={model}
      actions={{
        onView: (next) => address({ view: next, open: null }),
        onOpen: (id) => {
          setRejecting(false)
          address({ open: id })
        },
        onRetry: () => {
          setRows({ items: null, problem: null })
          void load()
        },
        onRetryReview: () => void readReview(),
        onApprove: (note) => decide((current) => approveQuote(api, current, note || null), 'notice.approved'),
        onReject: (reason) => decide((current) => rejectQuote(api, current, reason), 'notice.rejected'),
        onRejecting: setRejecting,
        onDismissNotice: () => setNotice(null),
        onApproveMany: approveMany,
      }}
    />
  )
}
