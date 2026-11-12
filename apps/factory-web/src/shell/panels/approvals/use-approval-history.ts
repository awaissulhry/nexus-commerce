'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { fetchHistory, type HistoryLine } from './api'
import { historyProblem, mayReadHistory, type ApprovalHistoryActions, type ApprovalHistoryModel, type HistoryRead } from './model'

/**
 * The container of a record's approval history (B-W2b-307; PLT-104): reads `GET /approvals/history/:type/:id` when the
 * record's type has a history, the person holds approvals.view and a view permission of the record's type, pages on with Show more, and reads again on `refresh`
 * (the record panels' live changes and the review's decisions call it). A 404 (a type with no history) is an empty one.
 */
export function useApprovalHistory(input: { readonly api: ApiClient; readonly record: { readonly type: string; readonly id: string } | null; readonly allowed: boolean; readonly held: ReadonlySet<string> }) {
  const { api, record, allowed, held } = input
  const wanted = allowed && record !== null && mayReadHistory(record.type, held)
  const key = record ? `${record.type}:${record.id}` : ''
  const [read, setRead] = useState<HistoryRead>({ status: 'loading' })
  const cursor = useRef<string | null>(null)
  const lines = useRef<HistoryLine[]>([])

  const load = useCallback(
    async (more: boolean) => {
      if (!wanted || !record) return
      if (more) setRead((current) => (current.status === 'ready' ? { ...current, loadingMore: true } : current))
      else setRead({ status: 'loading' })
      try {
        const answer = await fetchHistory(api, record, more ? cursor.current : null)
        cursor.current = answer.nextCursor
        lines.current = more ? [...lines.current, ...answer.lines] : answer.lines
        setRead({ status: 'ready', lines: lines.current, more: answer.nextCursor !== null })
      } catch (error) {
        if (isApiError(error) && error.kind === 'not_found') {
          lines.current = []
          setRead({ status: 'ready', lines: [], more: false })
        } else setRead({ status: 'error', problem: historyProblem(isApiError(error) ? error.status : null) })
      }
    },
    // The record is named by its key: a new object for the same record reads nothing again.
    [api, wanted, key],
  )

  useEffect(() => {
    void load(false)
  }, [load])

  const model: ApprovalHistoryModel | null = wanted ? { read, allowed } : null
  const actions: ApprovalHistoryActions = { onRetry: () => void load(false), onMore: () => void load(true) }
  return { model, actions, refresh: () => void load(false) }
}
