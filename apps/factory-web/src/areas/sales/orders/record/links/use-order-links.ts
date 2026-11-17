'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { acceptRepromise, declineRepromise } from '../../../../planning/promise/api'
import { getOrderLinks } from './api'
import { linksProblem, readyLinks, type LinksActions, type LinksModel } from './model'

/**
 * B-TH-256 — the container part of what points at the order: GET /sales/orders/:id/links (orders.view) when the order is read and
 * again whenever it is read again (its version moves: a live change, an accepted re-promise moves the line's date), and the
 * re-promise's two writes on planning's routes: Accept (with "Tell the customer" only when ticked) and Decline (with the reason the
 * planner reads). Each write has its own idempotency key; a refusal is said in words (409: decided meanwhile or the dates moved —
 * read again). After a write the links and the order are read again (`onOrderChanged`).
 */
export function useOrderLinks(api: ApiClient, order: { readonly id: string; readonly version: number } | null, onOrderChanged: () => void): { model: LinksModel | null; actions: LinksActions } {
  const [model, setModel] = useState<LinksModel | null>(null)
  const [attempt, setAttempt] = useState(0)
  const orderId = order?.id ?? null
  const version = order?.version ?? 0
  const changed = useRef(onOrderChanged)
  changed.current = onOrderChanged

  useEffect(() => {
    if (!orderId) {
      setModel(null)
      return
    }
    const abort = new AbortController()
    // A read again keeps what is on screen (and a tick or a typed reason) until the answer comes.
    setModel((current) => (current?.state === 'ready' ? current : { state: 'loading' }))
    getOrderLinks(api, orderId, abort.signal)
      .then((links) =>
        setModel((current) => {
          if (current?.state !== 'ready') return readyLinks(links)
          const open = new Set(links.rePromises.map((proposal) => proposal.id))
          // A decline whose proposal was decided meanwhile closes, and says so (its words were in the dialog).
          const gone = current.decline !== null && !open.has(current.decline.proposalId)
          return {
            ...current,
            links,
            tell: Object.fromEntries(Object.entries(current.tell).filter(([id]) => open.has(id))),
            decline: gone ? null : current.decline,
            said: gone ? { key: 'links.problem.conflict', tone: 'danger' } : current.said,
          }
        }),
      )
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        setModel((current) => (current?.state === 'ready' ? current : { state: 'error', problem: linksProblem(isApiError(error) ? error.kind : null) }))
      })
    return () => abort.abort()
  }, [api, orderId, version, attempt])

  const ready = model?.state === 'ready' ? model : null
  const readyRef = useRef(ready)
  readyRef.current = ready

  const finish = useCallback((said: { key: string; tone: 'success' | 'danger' }, keepDecline: boolean) => {
    setModel((current) => (current?.state === 'ready' ? { ...current, busy: null, said, decline: keepDecline ? current.decline : null } : current))
    setAttempt((count) => count + 1)
    changed.current()
  }, [])

  const actions = useMemo<LinksActions>(
    () => ({
      onRetry: () => setAttempt((count) => count + 1),
      onTell: (proposalId, tell) => setModel((current) => (current?.state === 'ready' ? { ...current, tell: { ...current.tell, [proposalId]: tell } } : current)),
      onAccept: (proposalId) => {
        const current = readyRef.current
        if (!current || current.busy) return
        const proposal = current.links.rePromises.find((entry) => entry.id === proposalId)
        if (!proposal) return
        const tell = proposal.may.tell && current.tell[proposalId] === true
        setModel({ ...current, busy: proposalId, said: null })
        acceptRepromise(api, proposalId, { tell }, newIdempotencyKey())
          .then((answer) => finish({ key: answer.told ? 'links.done.acceptedTold' : 'links.done.accepted', tone: 'success' }, false))
          .catch((error: unknown) => finish({ key: linksProblem(isApiError(error) ? error.kind : null), tone: 'danger' }, false))
      },
      onDeclineStart: (proposalId) => setModel((current) => (current?.state === 'ready' ? { ...current, decline: { proposalId, reason: '', problem: null }, said: null } : current)),
      onDeclineReason: (text) => setModel((current) => (current?.state === 'ready' && current.decline ? { ...current, decline: { ...current.decline, reason: text } } : current)),
      onDeclineCancel: () => setModel((current) => (current?.state === 'ready' ? { ...current, decline: null } : current)),
      onDecline: () => {
        const current = readyRef.current
        const decline = current?.decline
        if (!current || !decline || current.busy || decline.reason.trim() === '') return
        setModel({ ...current, busy: decline.proposalId, decline: { ...decline, problem: null } })
        declineRepromise(api, decline.proposalId, decline.reason, newIdempotencyKey())
          .then(() => finish({ key: 'links.done.declined', tone: 'success' }, false))
          .catch((error: unknown) => {
            const kind = isApiError(error) ? error.kind : null
            const problem = linksProblem(kind)
            // The dialog says it; the typed reason stays. Decided meanwhile or the dates moved: the links and the order are read again.
            setModel((latest) => (latest?.state === 'ready' ? { ...latest, busy: null, decline: latest.decline ? { ...latest.decline, problem } : null } : latest))
            if (kind === 'conflict') {
              setAttempt((count) => count + 1)
              changed.current()
            }
          })
      },
      onDismiss: () => setModel((current) => (current?.state === 'ready' ? { ...current, said: null } : current)),
    }),
    [api, finish],
  )

  return { model, actions }
}
