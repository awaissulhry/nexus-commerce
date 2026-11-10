'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useLiveChanges } from '../../../../record-panels/live'
import { readProblem, writeProblem, type Notice } from '../../library/model'
import { approveSmv, listWaiting, type WaitingEntry } from './api'

export interface WaitingModel {
  /** The tile's number (null: not counted yet or the count failed — the tile says '—'). */
  count: number | null
  /** The rows, read while the tile's view is open (null while reading). */
  entries: WaitingEntry[] | null
  problem: string | null
  busy: boolean
  notice: Notice | null
}

export interface WaitingActions {
  onRetry?: () => void
  /** Approve the chosen changes one by one, each at the version read; true when all were approved. */
  onApprove?: (proposalIds: readonly string[]) => Promise<boolean>
  onDismissNotice?: () => void
  /** Enter on a row: the operation's Minutes. */
  onOpen?: (href: string) => void
}

/**
 * The tile "SMV changes waiting for approval" and its rows (B-W2b-235 on B-W2b-215's GET /product/minutes/waiting): the
 * count always (one read when the list mounts and on live `smv_version.changed`), the rows while the tile's view is
 * open, and Approve N — one approval per change, each at its version, never one's own (the rows say which may be picked).
 */
export function useWaiting({ api, companyId, open, enabled, onApproved }: { api: ApiClient; companyId: string | null; open: boolean; enabled: boolean; onApproved?: () => void }): { model: WaitingModel; actions: WaitingActions } {
  const [count, setCount] = useState<number | null>(null)
  const [entries, setEntries] = useState<WaitingEntry[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const seq = useRef(0)
  const approved = useRef(onApproved)
  approved.current = onApproved

  const load = useCallback(() => {
    if (!enabled) return
    const mine = ++seq.current
    if (open) {
      setEntries(null)
      setProblem(null)
    }
    listWaiting(api, companyId, open ? 200 : 1)
      .then((answer) => {
        if (mine !== seq.current) return
        setCount(answer.count)
        if (open) setEntries(answer.versions)
      })
      .catch((error: unknown) => {
        if (mine !== seq.current) return
        setCount(null)
        if (open) setProblem(readProblem(error))
      })
  }, [api, companyId, open, enabled])

  useEffect(() => {
    load()
  }, [load])

  useLiveChanges({
    onChange: (change) => {
      if (!busy && change.type === 'smv_version.changed') load()
    },
  })

  const actions: WaitingActions = {
    onRetry: load,
    onApprove: async (proposalIds) => {
      const picked = (entries ?? []).filter((entry) => proposalIds.includes(entry.proposal.id))
      setBusy(true)
      let done = 0
      try {
        for (const entry of picked) {
          await approveSmv(api, entry.operation.id, entry.proposal)
          done++
        }
        setNotice({ key: 'waiting.notice.approved', tone: 'success', params: { count: done } })
        return true
      } catch (error) {
        setNotice({ key: done > 0 ? 'waiting.notice.partly' : writeProblem(error).key, tone: 'danger', params: { count: done, total: picked.length } })
        return false
      } finally {
        setBusy(false)
        load()
        approved.current?.()
      }
    },
    onDismissNotice: () => setNotice(null),
  }

  const model = useMemo<WaitingModel>(() => ({ count, entries, problem, busy, notice }), [count, entries, problem, busy, notice])
  return { model, actions }
}
