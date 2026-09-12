'use client'

/**
 * PES.7 — the images tab's data spine.
 *
 * One fetch (`GET /images-workspace`) feeds every scope. Master operations persist IMMEDIATELY —
 * there is no Save button on this tab, matching the studio's per-cell autosave model (layout §2.7)
 * — so each one reports itself through the frame's `useSaveReporter()`, and the header's autosave
 * state speaks for image work exactly as it speaks for sheet edits. One save indicator, one truth.
 *
 * Local state is patched from the SERVER'S response, never from the optimistic guess: an upload
 * returns the row the DB actually stored (its id, its dimensions, its dedup verdict), and painting
 * the guess would show an id that does not exist and a size nobody measured.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useSaveReporter, useStudioScope } from '../contracts'
import { apiGet, apiSend, routes, type ApiResult } from './api'
import { reportedWrite } from './imageWrites'
import type { ImageWorkspace, MasterAsset, ResolvedAxis } from './types'

/**
 * 🔴 One frozen empty array for every "the server did not send this" fallback.
 *
 * `x ?? []` mints a NEW array each render, so a consumer that correctly lists the field in a
 * dependency array gets a dependency that never matches — a memo that silently never caches
 * (PES ruling #156). The failure lands on careful code and spares careless code, which is why it
 * survives review.
 */
const NONE: never[] = []

export type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: ImageWorkspace }
  | { status: 'error'; message: string }

export interface ImageWorkspaceApi {
  state: LoadState
  /** Convenience projections — empty (never undefined) before the load lands. */
  images: MasterAsset[]
  videos: MasterAsset[]
  /**
   * The axes to OFFER. Prefers the server's resolved catalog over the raw observed names, so the
   * picker cannot show a ghost axis the publisher would ignore (inventory §4 finding B).
   */
  axes: ResolvedAxis[]
  axisWarnings: string[]
  axisSuppressed: string[]
  /** ids whose linked DAM asset has drifted from the product's copy. */
  damDrift: Set<string>

  reload(): Promise<void>
  /** Replace the master rows this tab holds, from a server response. */
  setMaster(next: MasterAsset[]): void
  /**
   * Run one master mutation with save reporting attached, FILED UNDER `subject` (#708). Returns the
   * server's result so the caller can surface the real refusal next to the control that caused it.
   *
   * 🔴 `subject` is required, and that is the fix: it is what a retry repeats. Build it with
   * `writeSubject` (re-exported below) — `asset(id)` for one picture, `upload(name)` for something
   * arriving that has no id yet, `surface(name)` for a write about a set. A subject that varies per
   * attempt puts the header back to counting attempts instead of unsaved work.
   */
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
}

export function useImageWorkspace(productId: string): ImageWorkspaceApi {
  const { scope, market, accountId, listingId } = useStudioScope()
  const params = new URLSearchParams({ scope })
  if (scope !== 'master') params.set('channel', scope)
  if (market) params.set('market', market)
  if (accountId !== undefined) params.set('accountId', accountId)
  if (listingId !== undefined) params.set('listingId', listingId)
  const path = `${routes.workspace(productId)}?${params}`
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const reporter = useSaveReporter()
  /**
   * 🔴 A generation counter, NOT an AbortController on the in-flight request.
   *
   * Measured 2026-09-01: aborting the previous request on every effect run left the tab in
   * "Loading images…" FOREVER. The resource timeline showed exactly one request, aborted after
   * 5ms, and no retry — because the aborted path returned early without setting state, and the
   * re-run that was supposed to follow never issued its own fetch. A permanent spinner with no
   * error, no retry and no explanation is the worst failure this tab can have.
   *
   * So a superseded response is IGNORED rather than its request killed. The request completes
   * (and warms the HTTP cache for the run that replaces it), and only the newest generation is
   * allowed to write state — which means there is no path where every load is cancelled and
   * nothing lands.
   */
  const generation = useRef(0)

  const load = useCallback(async () => {
    const mine = ++generation.current
    setState((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }))
    const res = await apiGet<ImageWorkspace>(path)
    // A newer load has started; its answer is the one that counts.
    if (mine !== generation.current) return
    if (!res.ok) {
      setState({ status: 'error', message: res.message })
      return
    }
    setState({ status: 'ready', data: res.data })
  }, [path])

  useEffect(() => {
    void load()
    return () => { generation.current += 1 }
  }, [load])

  const data = state.status === 'ready' ? state.data : null

  const images = useMemo(
    () => (data?.master ?? []).filter((m) => (m.mediaType ?? 'IMAGE') === 'IMAGE'),
    [data],
  )
  const videos = useMemo(
    () => (data?.master ?? []).filter((m) => m.mediaType === 'VIDEO'),
    [data],
  )

  /**
   * The server's resolved catalog when it sent one; otherwise the observed names projected into
   * the same shape, with their values left empty because we genuinely do not have them. The
   * caller therefore never needs to know which source it got.
   */
  const axes = useMemo<ResolvedAxis[]>(() => {
    if (data?.resolvedAxes?.length) return data.resolvedAxes
    return (data?.availableAxes ?? []).map((name) => ({ name, key: name, values: [] }))
  }, [data])

  const damDrift = useMemo(() => new Set(data?.damDrift ?? []), [data])

  const setMaster = useCallback((next: MasterAsset[]) => {
    setState((s) => (s.status === 'ready' ? { status: 'ready', data: { ...s.data, master: next } } : s))
  }, [])

  const write = useCallback(
    <T,>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> =>
      reportedWrite(reporter, JSON.stringify([productId, scope, market, accountId, listingId, subject]), run),
    [reporter, productId, scope, market, accountId, listingId],
  )

  // Memoised for the same reason as the fields inside it: consumers put this in dependency arrays.
  return useMemo(() => ({
    state,
    images,
    videos,
    axes,
    axisWarnings: data?.resolvedAxisWarnings ?? NONE,
    axisSuppressed: data?.resolvedAxisSuppressed ?? NONE,
    damDrift,
    reload: load,
    setMaster,
    write,
  }), [state, images, videos, axes, data, damDrift, load, setMaster, write])
}

/** Shared by the gallery and the upload paths. Kept here so one rule orders every surface. */
export function sortMaster(rows: MasterAsset[]): MasterAsset[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt))
}

export { apiSend }
export { writeSubject } from './imageWrites'
