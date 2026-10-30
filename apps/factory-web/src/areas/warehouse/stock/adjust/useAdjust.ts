'use client'

import { useCallback, useRef, useState } from 'react'
import { isApiError } from '../../../../lib/api/errors'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { listLocations, postAdjustment } from '../../../_shared/stock/api'
import { adjustBody, adjustChecks, adjustProblemKey, blankDraft, type AdjustActions, type AdjustDialogModel, type AdjustTarget } from './model'

/**
 * The Adjust stock dialog's container part (Stock and Movements share it): opens on one stock key at one place, reads
 * the site's active places for an increase, posts once with ONE Idempotency-Key per dialog (a retry of the same dialog
 * is the same move), and says a refusal in our words. `onDone` runs after a posted move (the page reads again).
 */
export function useAdjust(api: ApiClient, withCost: boolean, onDone: (words: { key: string; params: Record<string, string> }) => void) {
  const [model, setModel] = useState<AdjustDialogModel | null>(null)
  const key = useRef<string | null>(null)
  const latest = useRef(model)
  latest.current = model

  const open = useCallback(
    (target: AdjustTarget) => {
      key.current = newIdempotencyKey()
      setModel({ target, draft: blankDraft(target), locations: null, withCost, posting: false, problem: null })
      listLocations(api, { siteId: target.siteId })
        .then((answer) => {
          const places = answer.sites.flatMap((site) => site.locations).filter((place) => place.status === 'ACTIVE')
          setModel((current) => (current && current.target.siteId === target.siteId ? { ...current, locations: places.map(({ id, code, name }) => ({ id, code, name })) } : current))
        })
        .catch(() => setModel((current) => (current ? { ...current, locations: [] } : current)))
    },
    [api, withCost],
  )

  const actions: AdjustActions = {
    onChange: (draft) => setModel((current) => (current ? { ...current, draft, problem: null } : current)),
    onClose: () => setModel(null),
    onPost: () => {
      const current = latest.current
      if (!current || current.posting || adjustChecks(current).length > 0 || !key.current) return
      setModel({ ...current, posting: true, problem: null })
      postAdjustment(api, adjustBody(current), key.current)
        .then(() => {
          setModel(null)
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
