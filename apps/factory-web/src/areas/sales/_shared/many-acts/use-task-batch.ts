'use client'

import { useCallback, useRef, useState } from 'react'
import { useToast } from '@nexus/ui/components'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { useT } from '../../../../lib/i18n/provider'
import type { PanelRead } from '../../../../record-panels/model'
import { createTasks, listAssignees, taskReadProblem, taskWriteProblem } from '../../../../record-panels/tasks/api'
import { batchBody, type Assignable, type BatchAnswer, type BatchAssignee, type BatchRecord, type TaskDraft } from '../../../../record-panels/tasks/model'

/**
 * F-CQ-202 / F-CQ-203 (customer page › Quotes & incoming, 13-backend §11 "Add task to N"; settle C19): "Add task to N…" on quotes or on
 * requests and portal orders — the ONE batch window (record-panels TaskNewDialog) on the shape agreed with the Customers list lane: the
 * host's record nouns (`words`), each name of the receipt a door (`hrefOf`), Assign to starting on the person (`defaultAssignee: 'me'`:
 * a quote has no production supervisor of its own), no "names another customer" check (the tab is one customer's). ONE POST
 * /tasks/batch per click (one Idempotency-Key per window).
 */
export interface TaskBatchModel {
  readonly records: readonly BatchRecord[]
  readonly people: PanelRead<readonly Assignable[]>
}

export function useTaskBatch(api: ApiClient): { model: TaskBatchModel | null; open: (records: readonly BatchRecord[]) => void; onSend: (draft: TaskDraft, assignee: BatchAssignee) => Promise<BatchAnswer | null>; onRetryPeople: () => void; onClose: () => void } {
  const r = useT('records')
  const { toast } = useToast()
  const [state, setState] = useState<(TaskBatchModel & { readonly key: string }) | null>(null)
  const latest = useRef(state)
  latest.current = state

  const readPeople = useCallback(
    (records: readonly BatchRecord[]) => {
      const first = records[0]
      if (!first) return
      setState((now) => (now && now.records === records ? { ...now, people: { status: 'loading' } } : now))
      listAssignees(api, { type: first.type, id: first.id }).then(
        (people) => setState((now) => (now && now.records === records ? { ...now, people: { status: 'ready', data: people } } : now)),
        (error: unknown) => setState((now) => (now && now.records === records ? { ...now, people: { status: 'error', problem: taskReadProblem(error) } } : now)),
      )
    },
    [api],
  )

  const open = useCallback(
    (records: readonly BatchRecord[]) => {
      if (records.length === 0) return
      setState({ records, people: { status: 'loading' }, key: newIdempotencyKey() })
      readPeople(records)
    },
    [readPeople],
  )

  const onSend = useCallback(
    async (draft: TaskDraft, assignee: BatchAssignee): Promise<BatchAnswer | null> => {
      const now = latest.current
      if (!now) return null
      try {
        return await createTasks(api, batchBody(draft, assignee, now.records), now.key)
      } catch (error) {
        toast(r(taskWriteProblem(error).key), 'danger')
        return null
      }
    },
    [api, r, toast],
  )

  return {
    model: state ? { records: state.records, people: state.people } : null,
    open,
    onSend,
    onRetryPeople: () => (latest.current ? readPeople(latest.current.records) : undefined),
    onClose: () => setState(null),
  }
}
