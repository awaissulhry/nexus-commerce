'use client'

/**
 * Approvals grid — one request's detail for the drawer (build agent D2, 2026-10-05).
 *
 *   useApprovalDetail   GET /api/agent/fleet/approvals/queue/:id → QueueDetail (apps/api routes/approval-queue.routes.ts)
 *   usePlanDetail       GET /api/agent/fleet/approvals/:id/plan  → the plan's steps (the old PlanCard's response shape)
 *
 * Re-read whenever `refreshKey` changes (the page re-read the queue). The last good detail stays on screen while a
 * re-read is in flight, and when a re-read fails (the drawer says so); a 404 is plainly "This request no longer exists."
 * Never polls on its own: the page owns the clock (PLAN §6).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { QueueDetail } from '@nexus/shared/approval-queue'
import { getBackendUrl } from '@/lib/backend-url'
import type { PlanDetail } from '../planWords'

export type ApprovalDetailState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  /** `stale` = the newest re-read failed: the detail shown is the last good one, and the drawer says so. */
  | { kind: 'ready'; detail: QueueDetail; stale?: string }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }

export const NOT_FOUND_WORDS = 'This request no longer exists.'
const UNREACHABLE = 'Nexus could not be reached. Try again in a moment.'

class DetailReadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function readJson<T>(path: string, signal: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${getBackendUrl()}${path}`, { cache: 'no-store', signal })
  } catch (error) {
    if (signal.aborted) throw error
    throw new DetailReadError(UNREACHABLE, 0)
  }
  const body = (await response.json().catch(() => null)) as (T & { error?: unknown }) | null
  if (!response.ok) {
    const said = body && typeof body.error === 'string' ? body.error : null
    throw new DetailReadError(said ?? `The request could not be read (${response.status}).`, response.status)
  }
  return body as T
}

const enc = encodeURIComponent

export function useApprovalDetail(id: string | null, refreshKey: number) {
  const [state, setState] = useState<ApprovalDetailState>({ kind: 'idle' })
  const [nonce, setNonce] = useState(0)
  /** The detail last shown for this id: a re-read keeps it on screen instead of blanking the drawer. */
  const shown = useRef<{ id: string; detail: QueueDetail } | null>(null)

  useEffect(() => {
    if (!id) {
      shown.current = null
      setState({ kind: 'idle' })
      return
    }
    const controller = new AbortController()
    if (shown.current?.id !== id) {
      shown.current = null
      setState({ kind: 'loading' })
    }
    readJson<QueueDetail>(`/api/agent/fleet/approvals/queue/${enc(id)}`, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return
        shown.current = { id, detail }
        setState({ kind: 'ready', detail })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof DetailReadError && error.status === 404) {
          shown.current = null
          setState({ kind: 'not-found' })
          return
        }
        const message = error instanceof Error ? error.message : UNREACHABLE
        if (shown.current?.id === id) setState({ kind: 'ready', detail: shown.current.detail, stale: message })
        else setState({ kind: 'error', message })
      })
    return () => controller.abort()
  }, [id, refreshKey, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  const detail = state.kind === 'ready' ? state.detail : null
  return { state, detail, reload }
}

export type PlanDetailState = { kind: 'idle' | 'loading' } | { kind: 'ready'; plan: PlanDetail; stale?: string } | { kind: 'error'; message: string }

/**
 * A change plan's steps. Re-read when `signature` changes (the plan's step counts or state moved), so a running plan
 * shows each step's fate without reading 200 steps on every queue poll.
 */
export function usePlanDetail(id: string | null, signature: string) {
  const [state, setState] = useState<PlanDetailState>({ kind: 'idle' })
  const [nonce, setNonce] = useState(0)
  const shown = useRef<{ id: string; plan: PlanDetail } | null>(null)

  useEffect(() => {
    if (!id) {
      shown.current = null
      setState({ kind: 'idle' })
      return
    }
    const controller = new AbortController()
    if (shown.current?.id !== id) {
      shown.current = null
      setState({ kind: 'loading' })
    }
    readJson<PlanDetail>(`/api/agent/fleet/approvals/${enc(id)}/plan`, controller.signal)
      .then((plan) => {
        if (controller.signal.aborted) return
        shown.current = { id, plan }
        setState({ kind: 'ready', plan })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const message = error instanceof Error ? error.message : UNREACHABLE
        if (shown.current?.id === id) setState({ kind: 'ready', plan: shown.current.plan, stale: message })
        else setState({ kind: 'error', message })
      })
    return () => controller.abort()
  }, [id, signature, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { state, reload }
}
