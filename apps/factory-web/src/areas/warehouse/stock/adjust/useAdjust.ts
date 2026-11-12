'use client'

import { useCallback, useRef, useState } from 'react'
import { isApiError } from '../../../../lib/api/errors'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { listLocations } from '../../../_shared/stock/api'
import { adjustmentApprovers, postAdjustmentOrWait, postingCheck, warehouseRules, type WaitingAdjustment } from '../depth/api'
import { approvalNoticeOf } from '../depth/model'
import { readProblem } from '../../../_shared/stock/model'
import { adjustBody, adjustChecks, adjustProblemKey, blankDraft, type AdjustActions, type AdjustDialogModel, type AdjustTarget } from './model'

/** B-W2b-327: what the dialog reads beside the places (the warehouse rules of the company, who says yes) and where a waiting adjustment goes. */
export interface AdjustDepth {
  /** The company whose warehouse rules hold (the session's); undefined: the rules are not read. */
  companyId?: string | null
  /** approvals.view: the approval rules' approvers are named. */
  approvers?: boolean
  /** Today at the site (YYYY-MM-DD), the latest posting day. */
  today?: string
  /** An adjustment worth more than the value waits for a yes (202): nothing was posted. */
  onWaiting?: (waiting: WaitingAdjustment) => void
}

/**
 * The Adjust stock dialog's container part (Stock and Movements share it): opens on one stock key at one place, reads
 * the site's active places for an increase, posts once with ONE Idempotency-Key per dialog (a retry of the same dialog
 * is the same move), and says a refusal in our words. `onDone` runs after a posted move (the page reads again).
 * B-W2b-327: also reads the warehouse rules (the value above which an adjustment waits for a yes, who approves: the
 * dialog's banner), checks a posting day as the post will (`GET /inventory/posting/check`), and a 202 answer (waiting
 * for a yes, nothing posted) goes to `depth.onWaiting`.
 */
export function useAdjust(api: ApiClient, withCost: boolean, onDone: (words: { key: string; params: Record<string, string> }) => void, depth: AdjustDepth = {}) {
  const [model, setModel] = useState<AdjustDialogModel | null>(null)
  const key = useRef<string | null>(null)
  const latest = useRef(model)
  latest.current = model
  const checkId = useRef(0)
  const own = useRef(depth)
  own.current = depth

  const open = useCallback(
    (target: AdjustTarget) => {
      key.current = newIdempotencyKey()
      setModel({ target, draft: blankDraft(target), locations: null, withCost, posting: false, problem: null, approval: null, postingCheck: null, ...(own.current.today ? { today: own.current.today } : {}) })
      listLocations(api, { siteId: target.siteId })
        .then((answer) => {
          const places = answer.sites.flatMap((site) => site.locations).filter((place) => place.status === 'ACTIVE')
          setModel((current) => (current && current.target.siteId === target.siteId ? { ...current, locations: places.map(({ id, code, name }) => ({ id, code, name })) } : current))
        })
        .catch(() => setModel((current) => (current ? { ...current, locations: [] } : current)))
      if (own.current.companyId !== undefined) {
        const rules = warehouseRules(api, own.current.companyId ?? null)
        const approvers = own.current.approvers ? adjustmentApprovers(api).catch(() => null) : Promise.resolve(null)
        Promise.all([rules, approvers])
          .then(([read, names]) => setModel((current) => (current && current.target === target ? { ...current, approval: approvalNoticeOf(read, names) } : current)))
          .catch(() => setModel((current) => (current && current.target === target ? { ...current, approval: null } : current)))
      }
    },
    [api, withCost],
  )

  const check = useCallback(
    (siteId: string, day: string) => {
      const id = ++checkId.current
      setModel((current) => (current ? { ...current, postingCheck: { status: 'loading' } } : current))
      postingCheck(api, siteId, day)
        .then((value) => id === checkId.current && setModel((current) => (current ? { ...current, postingCheck: { status: 'ready', value } } : current)))
        .catch((error: unknown) => id === checkId.current && setModel((current) => (current ? { ...current, postingCheck: { status: 'error', problem: readProblem(error) } } : current)))
    },
    [api],
  )

  const actions: AdjustActions = {
    onChange: (draft) => {
      const before = latest.current
      setModel((current) => (current ? { ...current, draft, problem: null, ...(draft.postingDay ? {} : { postingCheck: null }) } : current))
      if (before && draft.postingDay && draft.postingDay !== before.draft.postingDay) check(before.target.siteId, draft.postingDay)
    },
    onClose: () => setModel(null),
    onPost: () => {
      const current = latest.current
      if (!current || current.posting || adjustChecks(current).length > 0 || !key.current) return
      setModel({ ...current, posting: true, problem: null })
      postAdjustmentOrWait(api, adjustBody(current), key.current)
        .then((answer) => {
          setModel(null)
          if (!answer.posted) {
            own.current.onWaiting?.(answer.waiting)
            return
          }
          onDone({ key: current.draft.direction === 'IN' ? 'adj.done.up' : 'adj.done.down', params: { code: current.target.item.code, place: current.target.location.code } })
        })
        .catch((error: unknown) => {
          const problem = isApiError(error) ? adjustProblemKey(error.kind, error.code, error.issues.length > 0) : 'adj.problem.write'
          setModel((now) => (now ? { ...now, posting: false, problem: { key: problem } } : now))
        })
    },
  }
  return { model, open, actions }
}
