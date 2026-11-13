'use client'

import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { makeRemakeOrder, readRemake, type RemakeView } from './api'
import { remakePartOf, remakeProblem, type Phrase } from './model'
import { RemakeOutcome } from './view/RemakeOutcome'

/**
 * The container part of the remake outcome (B-W2b-368, XF1:03) beside the RMA record: GET /sales/returns/:id/remake-order while a
 * line is decided or drafted Remake, read again whenever the RMA's version moves; "Make the remake order" (ONE POST with the
 * version read, one Idempotency-Key per attempt), then the RMA read again (the part then names the remake order; a refusal is
 * said under the button). `lineOf(lineId, disposition)` draws a line's part (null: nothing to say).
 */
export function useRemakeOutcome(input: {
  readonly api: ApiClient
  readonly returnId: string
  readonly version: number | null
  readonly remakeLines: number
  readonly permissions: readonly string[]
  readonly offline: boolean
  readonly prefix: string
  readonly reload: () => void
}): { lineOf: (lineId: string, disposition: string) => ReactNode } {
  const { api, returnId, version, remakeLines, permissions, offline, prefix } = input
  const [view, setView] = useState<RemakeView | null>(null)
  const [problem, setProblem] = useState<Phrase | null>(null)
  const [busy, setBusy] = useState(false)
  const [writeProblem, setWriteProblem] = useState<Phrase | null>(null)
  const [attempt, setAttempt] = useState(0)
  const key = useRef<string | null>(null)
  const callbacks = useRef(input)
  callbacks.current = input
  useEffect(() => {
    if (remakeLines === 0 || version === null) return
    const abort = new AbortController()
    setProblem(null)
    readRemake(api, returnId, abort.signal)
      .then(setView)
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setProblem(remakeProblem(isApiError(error) ? error.kind : null))
      })
    return () => abort.abort()
  }, [api, returnId, version, remakeLines, attempt])
  const make = useCallback(async () => {
    if (!view || busy) return
    setBusy(true)
    setWriteProblem(null)
    key.current ??= newIdempotencyKey()
    try {
      const made = await makeRemakeOrder(api, returnId, view.version, key.current)
      key.current = null
      setView(made.remake)
      callbacks.current.reload()
    } catch (error) {
      const kind = isApiError(error) ? error.kind : null
      if (kind !== 'unavailable') key.current = null
      setWriteProblem(remakeProblem(kind))
      setAttempt((count) => count + 1)
    } finally {
      setBusy(false)
    }
  }, [api, busy, returnId, view])
  const lineOf = useCallback(
    (lineId: string, disposition: string): ReactNode => {
      const part = remakePartOf(view, problem, lineId, { permissions, offline, busy, disposition, prefix, writeProblem })
      return part ? createElement(RemakeOutcome, { part, onMake: () => void make(), onRetry: () => setAttempt((count) => count + 1) }) : null
    },
    [busy, make, offline, permissions, prefix, problem, view, writeProblem],
  )
  return { lineOf }
}
