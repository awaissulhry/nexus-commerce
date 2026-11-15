'use client'

import { useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import type { Minimum } from '../depth/api'
import { updateMinimum } from './api'
import { minimumPatch, patchProblem, type MinimumEditState, type MinimumField, type MinimumPatch } from './model'

export interface MinimumEditInput {
  api: ApiClient
  currency: string
  /** The minimum as the server answers it now (the list keeps it in its place). */
  onSaved: (next: Minimum) => void
  /** Read the minimums again (another write moved one). */
  onReload: () => void
}

/** A refusal in words (`prices-followups`): someone else's change, a twin, the minimum's own rule, or the read. */
function refusalOf(error: unknown): { key: string; reload: boolean } {
  if (isApiError(error)) {
    if (error.code === 'version_conflict') return { key: 'minimums.refused.moved', reload: true }
    if (error.kind === 'conflict') return { key: 'minimums.refused.conflict', reload: true }
    if (error.kind === 'invalid') return { key: 'minimums.refused.invalid', reload: false }
    if (error.kind === 'forbidden') return { key: 'minimums.held.noManage', reload: false }
  }
  return { key: 'minimums.refused.unavailable', reload: false }
}

/**
 * The minimums edited in place (B-W2b-380, XF6:03): one cell → its patch (or why not, in words, before any call) → ONE PATCH
 * with the minimum's version and its own Idempotency-Key, one after the other; the answer takes the row's place; a moved
 * minimum (409) reads the list again and says so. The cell shows saving, then nothing, or "not saved".
 */
export function useMinimumEdit(input: MinimumEditInput): { edit: MinimumEditState; onCell: (row: Minimum, field: MinimumField, text: string) => void; onDismiss: () => void } {
  const latest = useRef(input)
  latest.current = input
  const [cells, setCells] = useState<MinimumEditState['cells']>({})
  const [notice, setNotice] = useState<MinimumEditState['notice']>(null)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const versions = useRef(new Map<string, number>())

  const onCell = (row: Minimum, field: MinimumField, text: string) => {
    const patch = minimumPatch(row, field, text, latest.current.currency)
    const problem = patchProblem(patch)
    if (problem) return setNotice({ tone: 'warning', words: problem })
    if (patch === null) return
    const cell = `${row.id}:${field}`
    const next = queue.current.then(async () => {
      setCells((state) => ({ ...state, [cell]: 'saving' }))
      try {
        // A second cell of the same minimum goes with the version the first one answered.
        const version = Math.max(row.version, versions.current.get(row.id) ?? 0)
        const saved = await updateMinimum(latest.current.api, { id: row.id, version }, patch as MinimumPatch)
        versions.current.set(saved.id, saved.version)
        latest.current.onSaved(saved)
        setCells((state) => Object.fromEntries(Object.entries(state).filter(([id]) => id !== cell)))
        setNotice({ tone: 'success', words: { key: 'minimums.saved' } })
      } catch (error) {
        const refused = refusalOf(error)
        setCells((state) => ({ ...state, [cell]: 'failed' }))
        setNotice({ tone: 'danger', words: { key: refused.key } })
        if (refused.reload) {
          versions.current.delete(row.id)
          latest.current.onReload()
        }
      }
    })
    queue.current = next.catch(() => undefined)
  }

  return { edit: { cells, notice }, onCell, onDismiss: () => setNotice(null) }
}
