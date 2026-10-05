'use client'

/**
 * Approvals grid — every decision the page makes, in ONE place (contracts.ts `ApprovalActions`).
 *
 * The row verbs, the toolbar's bulk buttons, the keyboard shortcuts and the drawer all call these, so a decision
 * behaves the same wherever it starts:
 * - only the row being decided is locked (`busyIds`), never the page;
 * - an error is kept per row until the person closes it (`errors`), never wiped by the next refresh — the old page lost
 *   them within one poll (research/01 D3);
 * - the queue is re-read after every decision.
 *
 * Endpoints (apps/api `routes/agent-fleet.routes.ts`, `agent-fleet-approvals.routes.ts`):
 *   approve / reject / retry  POST /api/agent/fleet/approvals/:id/decide  { decision, reason? }
 *   undo                      POST …/:id/undo      (no body)
 *   hold                      POST …/:id/hold      (no body) — 10 more minutes
 *   commit                    POST …/:id/commit    (no body) — at the stop window's end; the server refuses an early
 *                                                  call and its 30 s sweep runs the row anyway, so a failed commit is
 *                                                  not the person's error and is not shown as one
 *   bulk                      POST …/bulk-preview, then …/bulk-decide { ids, decision, reason? }
 *
 * 🔴 A `content-type: application/json` header goes out ONLY with a body: Fastify answers an empty JSON body with a flat
 * 400 before the handler runs (FST_ERR_CTP_EMPTY_JSON_BODY), which is how Undo once did nothing on the old page.
 * The CSRF and business headers are added by the app's fetch (`lib/auth/install-fetch.ts`), never here.
 */
import { createElement, useCallback, useMemo, useRef, useState } from 'react'
import type { QueueBulkResult, QueueRow } from '@nexus/shared/approval-queue'

import { getBackendUrl } from '@/lib/backend-url'
import { Button } from '@/design-system/primitives'
import { useToast } from '@/design-system/components'
import type { ApprovalActions } from './contracts'
import { approveHeldWhy, approvedText, bulkOutcomeText, productText } from './queueWords'

/** What the server says a bulk decision would do (`previewBulk`). */
export interface BulkPreview {
  count: number
  sentence: string
  /** Null when the decision may go ahead. */
  blockedReason: string | null
}

/** The page's actions: the contract, plus the two the grid itself drives. */
export interface QueueActions extends ApprovalActions {
  /** The stop window reached zero on screen: ask the server to run it now (once per run time). */
  commit(row: QueueRow): void
  bulkPreview(ids: readonly string[], decision: 'approve' | 'reject'): Promise<BulkPreview>
  /** Decide many; resolves with what the server did (a refused bulk is `ok: false` with its reason). */
  bulkDecide(rows: readonly QueueRow[], decision: 'approve' | 'reject', reason?: string): Promise<QueueBulkResult>
}

interface Answer {
  ok?: boolean
  error?: string
  executeAfter?: string
}

const FLEET = '/api/agent/fleet'
/** The stop window the API applies (`UNDO_WINDOW_MS`); the Undo toast stays up as long, and How it works says it. */
export const STOP_WINDOW_MS = 20_000

async function post<T extends Answer>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${getBackendUrl()}${FLEET}/${path}`, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const answer = (await response.json().catch(() => null)) as T | null
  if (!response.ok || answer?.ok === false) throw new Error(answer?.error ?? `the server answered ${response.status}`)
  return (answer ?? {}) as T
}

const reasonOf = (e: unknown) => (e instanceof TypeError ? `Nexus could not be reached (${e.message})` : e instanceof Error ? e.message : String(e))

/** "Set master price XR-GLOVE-M" — how a row is named in an error, a toast or an aria label. */
export function rowName(row: Pick<QueueRow, 'title' | 'target'>): string {
  const product = productText(row.target)
  return product ? `${row.title} ${product}` : row.title
}

export function useApprovalActions(opts: { refresh(): void; openAutomate(row: QueueRow): void }): QueueActions {
  const { toast } = useToast()
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map())
  // Read synchronously by a second click in the same tick, before React re-renders.
  const busyRef = useRef(new Set<string>())
  const committed = useRef(new Set<string>())
  const optsRef = useRef(opts)
  optsRef.current = opts

  const setBusy = useCallback((id: string, on: boolean) => {
    if (on) busyRef.current.add(id)
    else busyRef.current.delete(id)
    setBusyIds(new Set(busyRef.current))
  }, [])

  const setError = useCallback((id: string, message: string | null) => {
    setErrors((prev) => {
      if (message === null && !prev.has(id)) return prev
      const next = new Map(prev)
      if (message === null) next.delete(id)
      else next.set(id, message)
      return next
    })
  }, [])

  /** One decision on one row: lock that row, clear its old error, keep a new one, re-read the queue. */
  const decideOne = useCallback(
    async <T,>(row: QueueRow, failure: string, call: () => Promise<T>): Promise<T | null> => {
      if (busyRef.current.has(row.id)) return null
      setBusy(row.id, true)
      setError(row.id, null)
      try {
        return await call()
      } catch (e) {
        setError(row.id, `${failure}: ${reasonOf(e)}`)
        return null
      } finally {
        setBusy(row.id, false)
        optsRef.current.refresh()
      }
    },
    [setBusy, setError],
  )

  const undo = useCallback(
    async (row: QueueRow) => {
      const done = await decideOne(row, 'Could not undo', () => post(`approvals/${encodeURIComponent(row.id)}/undo`))
      if (done) toast('Undone — nothing ran. It is waiting for you again.', 'neutral')
    },
    [decideOne, toast],
  )

  const approveWith = useCallback(
    async (row: QueueRow, again: boolean) => {
      const held = approveHeldWhy(row)
      if (held) {
        setError(row.id, `Cannot approve: ${held}`)
        return
      }
      const answer = await decideOne(row, again ? 'Could not retry' : 'Could not approve', () =>
        post<Answer>(`approvals/${encodeURIComponent(row.id)}/decide`, { decision: 'approve' }),
      )
      if (!answer) return
      const text = approvedText(answer.executeAfter, Date.now(), again)
      if (!answer.executeAfter) {
        toast(text, 'success')
        return
      }
      // Undo inside the toast, for the stop window. The row keeps its own Undo too: a toast dies on reload.
      toast(
        createElement(
          'span',
          { className: 'aqg-toast' },
          text,
          ' ',
          createElement(Button, { size: 'xs', variant: 'secondary', onClick: () => void undo(row) }, 'Undo'),
        ),
        'success',
        { duration: STOP_WINDOW_MS },
      )
    },
    [decideOne, setError, toast, undo],
  )

  const approve = useCallback((row: QueueRow) => approveWith(row, false), [approveWith])
  const retry = useCallback((row: QueueRow) => approveWith(row, true), [approveWith])

  const reject = useCallback(
    async (row: QueueRow, reason?: string) => {
      const words = reason?.trim()
      const done = await decideOne(row, 'Could not reject', () =>
        post(`approvals/${encodeURIComponent(row.id)}/decide`, words ? { decision: 'reject', reason: words } : { decision: 'reject' }),
      )
      if (done) toast(words ? 'Rejected. Your reason goes back to the asker.' : 'Rejected.', 'neutral')
    },
    [decideOne, toast],
  )

  const hold = useCallback(
    async (row: QueueRow) => {
      const done = await decideOne(row, 'Could not hold', () => post(`approvals/${encodeURIComponent(row.id)}/hold`))
      if (done) toast('On hold for 10 minutes. Nothing runs before then.', 'neutral')
    },
    [decideOne, toast],
  )

  const commit = useCallback((row: QueueRow) => {
    const key = `${row.id}@${row.executeAfter ?? ''}`
    if (committed.current.has(key)) return
    committed.current.add(key)
    void post(`approvals/${encodeURIComponent(row.id)}/commit`)
      .catch(() => {
        /* Refused early, or the sweep took it first: the row's state on the next read is the truth. */
      })
      .finally(() => optsRef.current.refresh())
  }, [])

  const bulkPreview = useCallback(async (ids: readonly string[], decision: 'approve' | 'reject'): Promise<BulkPreview> => {
    const answer = await post<Answer & Partial<BulkPreview>>('approvals/bulk-preview', { ids, decision })
    return { count: answer.count ?? 0, sentence: answer.sentence ?? '', blockedReason: answer.blockedReason ?? null }
  }, [])

  const bulkDecide = useCallback(
    async (rows: readonly QueueRow[], decision: 'approve' | 'reject', reason?: string): Promise<QueueBulkResult> => {
      const ids = rows.map((r) => r.id)
      for (const id of ids) busyRef.current.add(id)
      setBusyIds(new Set(busyRef.current))
      try {
        const words = reason?.trim()
        const response = await fetch(`${getBackendUrl()}${FLEET}/approvals/bulk-decide`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(words ? { ids, decision, reason: words } : { ids, decision }),
        })
        const answer = (await response.json().catch(() => null)) as (QueueBulkResult & { failed?: string[] }) | null
        const result: QueueBulkResult = answer && typeof answer.done === 'number'
          ? { ok: answer.ok, done: answer.done, of: answer.of, skipped: answer.skipped ?? [], ...(answer.error ? { error: answer.error } : {}) }
          : { ok: false, done: 0, of: ids.length, skipped: [], error: answer?.error ?? `the server answered ${response.status}` }
        const byId = new Map(rows.map((r) => [r.id, r]))
        const nameOf = (id: string) => {
          const r = byId.get(id)
          return r ? rowName(r) : id
        }
        toast(bulkOutcomeText(decision, result, nameOf), result.done === result.of ? 'success' : result.done > 0 ? 'warning' : 'danger', {
          duration: result.done === result.of ? 6000 : 15_000,
        })
        return result
      } catch (e) {
        const result: QueueBulkResult = { ok: false, done: 0, of: ids.length, skipped: [], error: reasonOf(e) }
        toast(`Nothing was ${decision === 'approve' ? 'approved' : 'rejected'}: ${result.error}`, 'danger', { duration: 15_000 })
        return result
      } finally {
        for (const id of ids) busyRef.current.delete(id)
        setBusyIds(new Set(busyRef.current))
        optsRef.current.refresh()
      }
    },
    [toast],
  )

  const openAutomate = useCallback((row: QueueRow) => optsRef.current.openAutomate(row), [])
  const refresh = useCallback(() => optsRef.current.refresh(), [])
  const dismissError = useCallback((id: string) => setError(id, null), [setError])

  return useMemo(
    () => ({
      approve,
      reject,
      undo,
      hold,
      retry,
      openAutomate,
      refresh,
      busyIds,
      errors,
      dismissError,
      commit,
      bulkPreview,
      bulkDecide,
    }),
    [approve, reject, undo, hold, retry, openAutomate, refresh, busyIds, errors, dismissError, commit, bulkPreview, bulkDecide],
  )
}
