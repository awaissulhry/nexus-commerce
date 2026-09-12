'use client'

/**
 * VP.4 — the projection's state: one read, one include/exclude write, one mapping save.
 *
 * Three rules this hook exists to hold, all of them banked failures rather than preferences:
 *
 *  1. **A version is READ BACK, never assumed.** Every write returns the new version and this
 *     stores THAT number, so the next write's `expectedVersion` is the server's own
 *     (reference_product_version_not_row_version, and the CAS half of
 *     reference_claims_must_match_their_measurement). `source.ts` refuses a success that carries no
 *     version for the same reason.
 *  2. **A 409 repaints from the server's page, then refetches** — §4.4, "exactly like the sheet". A
 *     conflict never leaves the optimistic value on screen and never silently retries: the operator
 *     sees the current state and decides again.
 *  3. **An in-flight write must not be undone by a read that started before it.** A refresh that
 *     resolves after a later write applies nothing (reference_read_before_the_write_arrived, and
 *     the in-flight-autosave-undoes-a-revert case banked beside it). The sequence counter below is
 *     that guard; it is the reason `refresh` takes the sequence it was issued at.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ProjectionDraft, ProjectionPage, ProjectionSource } from './types'

export interface ProjectionState {
  page: ProjectionPage | null
  loading: boolean
  error: string | null
  /** The read failed because VP.2's route is not deployed yet — say so, never draw plausible rows. */
  backendMissing: boolean
  /** A refusal or conflict from the last write, for the surface to state. Cleared on the next one. */
  writeError: string | null
  /** Children whose include/exclude is in flight — their checkbox is busy, not wrong. */
  pending: ReadonlySet<string>
  saving: boolean
  reload(): void
  setIncluded(id: string, included: boolean): void
  saveMapping(draft: ProjectionDraft): Promise<boolean>
  dismissWriteError(): void
}

export function useProjection(source: ProjectionSource): ProjectionState {
  const [page, setPage] = useState<ProjectionPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [backendMissing, setBackendMissing] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [saving, setSaving] = useState(false)
  const [nonce, setNonce] = useState(0)

  /**
   * Monotonic. Bumped by EVERY write and every read, and checked before anything is applied —
   * "did something else happen since I started?" is one comparison, and the alternative (comparing
   * versions) cannot tell a stale read from a read that simply found no change.
   */
  const seq = useRef(0)
  /** The version the next write guards with. Kept in a ref so a write does not close over a stale one. */
  const version = useRef<number | null>(null)
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])

  const apply = useCallback((mine: number, next: ProjectionPage) => {
    if (!live.current || mine !== seq.current) return false
    version.current = next.version
    setPage(next)
    return true
  }, [])

  useEffect(() => {
    const mine = ++seq.current
    const abort = new AbortController()
    setLoading(true)
    setError(null)
    setBackendMissing(false)
    source.read(abort.signal)
      .then(next => { if (apply(mine, next)) setLoading(false) })
      .catch((e: unknown) => {
        if (!live.current || mine !== seq.current) return
        if ((e as { name?: string }).name === 'AbortError') return
        setBackendMissing(!!(e as { backendMissing?: boolean }).backendMissing)
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => { abort.abort() }
  }, [source, nonce, apply])

  const reload = useCallback(() => { seq.current++; setNonce(n => n + 1) }, [])

  /** A conflict's page IS the current state — apply it, then re-read so nothing else is stale. */
  const onConflict = useCallback((current: ProjectionPage, reason: string) => {
    const mine = ++seq.current
    apply(mine, current)
    setWriteError(reason)
    setNonce(n => n + 1)
  }, [apply])

  const setIncluded = useCallback((id: string, included: boolean) => {
    const current = version.current
    if (current === null) return
    setWriteError(null)
    setPending(prev => new Set(prev).add(id))
    /* Optimistic, and the row is marked PENDING while it is — an unmarked optimistic value is a
       page asserting a server fact it does not have yet (feedback_100_percent_honest_ui). */
    setPage(prev => prev ? { ...prev, children: prev.children.map(c => c.id === id ? { ...c, included } : c) } : prev)
    const mine = ++seq.current
    void source.setIncluded(current, [{ id, included }]).then(result => {
      if (!live.current) return
      setPending(prev => { const next = new Set(prev); next.delete(id); return next })
      if (result.ok) {
        if (mine !== seq.current) return
        version.current = result.version
        setPage(prev => prev ? { ...prev, version: result.version } : prev)
        setNonce(n => n + 1)
        return
      }
      if (result.conflict) { onConflict(result.current, result.reason); return }
      /* Refused: put the row back the way the server has it and say why. Leaving the optimistic
         value would be the page telling the operator a write landed that did not. */
      if (mine === seq.current) {
        setPage(prev => prev ? { ...prev, children: prev.children.map(c => c.id === id ? { ...c, included: !included } : c) } : prev)
      }
      setWriteError(result.reason)
    })
  }, [source, onConflict])

  const saveMapping = useCallback(async (draft: ProjectionDraft): Promise<boolean> => {
    const current = version.current
    if (current === null) return false
    setWriteError(null)
    setSaving(true)
    const mine = ++seq.current
    try {
      const result = await source.saveMapping(current, draft)
      if (!live.current) return false
      if (result.ok) {
        if (mine === seq.current) {
          version.current = result.version
          setPage(prev => prev ? {
            ...prev, version: result.version, mapping: draft.mapping,
            split: { ...prev.split, mode: draft.split.mode, axisKey: draft.split.axisKey },
          } : prev)
        }
        /* Re-read rather than trust the echo: the save's own answer is what it WROTE, not what the
           coordinate now holds — the split, the lock and the per-value counts all move with it. */
        setNonce(n => n + 1)
        return true
      }
      if (result.conflict) { onConflict(result.current, result.reason); return false }
      setWriteError(result.reason)
      return false
    } finally {
      if (live.current) setSaving(false)
    }
  }, [source, onConflict])

  const dismissWriteError = useCallback(() => setWriteError(null), [])

  return useMemo(() => ({
    page, loading, error, backendMissing, writeError, pending, saving,
    reload, setIncluded, saveMapping, dismissWriteError,
  }), [page, loading, error, backendMissing, writeError, pending, saving, reload, setIncluded, saveMapping, dismissWriteError])
}
