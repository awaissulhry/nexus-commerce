'use client'

/**
 * VP.4 — the projection's state: one read, one include/exclude write, one mapping save.
 *
 * Rules this hook exists to hold, all of them banked failures rather than preferences:
 *
 *  1. **A version is READ BACK, never assumed.** Every write returns the new version and this
 *     stores THAT number, so the next write's `expectedVersion` is the server's own
 *     (reference_product_version_not_row_version, and the CAS half of
 *     reference_claims_must_match_their_measurement). `source.ts` refuses a success that carries no
 *     version for the same reason.
 *  2. **A 409 repaints from the server's page, then refetches** — §4.4, "exactly like the sheet". A
 *     conflict never leaves the optimistic value on screen and never silently retries: the operator
 *     sees the current state and decides again.
 *  3. **ONE write queue (2.4, the Matrix's #592).** Ticks and mapping saves go one at a time, in the
 *     order they were asked. Each is sent at the version it was made on, moved along THIS page's own
 *     applied writes (`moves`): a second quick tick goes out at the version the first one left, so the
 *     page never conflicts with itself. A move by anyone else is still a conflict.
 *  4. **An older read never paints over a newer one.** Every read takes a ticket when it starts; a
 *     write that lands takes a newer one. A read that started before the write answered is dropped
 *     (reference_read_before_the_write_arrived).
 *  5. **A tick still in line stays on screen.** The page shown is the server's last read with the
 *     ticks not yet settled laid over it, so a re-read that lands between two writes cannot flip the
 *     second tick back. Each of those rows is marked pending while it is
 *     (feedback_100_percent_honest_ui).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { writeQueue } from '../writeQueue'
import { MAPPING_CHANGED_ELSEWHERE } from './copy'
import type { ProjectionDraft, ProjectionPage, ProjectionSaveResult, ProjectionSource } from './types'

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
  /**
   * Counts the mapping saves refused because the listing moved somewhere else (a real 409). The dock
   * keeps an unsaved mapping through every refresh and starts again from the server's mapping only
   * when this moves.
   */
  mappingConflicts: number
  reload(): void
  setIncluded(id: string, included: boolean): void
  /** `basedOn`: the version the draft was made on (the dock's). Without it, the version on screen. */
  saveMapping(draft: ProjectionDraft, basedOn?: number): Promise<boolean>
  dismissWriteError(): void
}

type Refusal = Exclude<ProjectionSaveResult, { ok: true }>

/** Moved somewhere else: a 409 with the current page, or a version conflict the server sent without one. `axes_locked` is a rule, not a move. */
const movedElsewhere = (r: Refusal): boolean => (r.conflict ? r.code !== 'axes_locked' : r.code === 'version_conflict')

const sameKeys = (a: ReadonlySet<string>, b: ReadonlyMap<string, unknown>): boolean =>
  a.size === b.size && [...b.keys()].every(k => a.has(k))

export function useProjection(source: ProjectionSource): ProjectionState {
  const [page, setPage] = useState<ProjectionPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [backendMissing, setBackendMissing] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [saving, setSaving] = useState(false)
  const [mappingConflicts, setMappingConflicts] = useState(0)
  const [nonce, setNonce] = useState(0)

  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])

  /** The server's page as last read or written — never the ticks still in line (they are laid over it). */
  const server = useRef<ProjectionPage | null>(null)
  /** Each child's tick still in line: the value last asked, and how many of its writes have not settled. */
  const asked = useRef(new Map<string, { included: boolean; n: number }>())
  const readTicket = useRef(0)
  const shownTicket = useRef(0)
  const inLine = useMemo(() => writeQueue(), [])
  /** This page's own applied writes, version → version. */
  const moves = useRef(new Map<number, number>())
  const mappingSaves = useRef(0)

  const publish = useCallback(() => {
    const base = server.current
    const overlay = asked.current
    setPage(base && overlay.size
      ? { ...base, children: base.children.map(c => { const a = overlay.get(c.id); return a && a.included !== c.included ? { ...c, included: a.included } : c }) }
      : base)
    setPending(prev => (sameKeys(prev, overlay) ? prev : new Set(overlay.keys())))
  }, [])

  /** Shows `next` unless a newer read or write is already on screen. A write that lands takes a fresh ticket. */
  const commit = useCallback((next: ProjectionPage, ticket: number = ++readTicket.current): boolean => {
    if (!live.current || ticket < shownTicket.current) return false
    shownTicket.current = ticket
    server.current = next
    publish()
    return true
  }, [publish])

  useEffect(() => {
    const ticket = ++readTicket.current
    const abort = new AbortController()
    setLoading(true)
    setError(null)
    setBackendMissing(false)
    source.read(abort.signal)
      .then(next => {
        if (!live.current || abort.signal.aborted) return
        commit(next, ticket)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (!live.current || abort.signal.aborted || ticket < shownTicket.current) return
        if ((e as { name?: string }).name === 'AbortError') return
        setBackendMissing(!!(e as { backendMissing?: boolean }).backendMissing)
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => { abort.abort() }
  }, [source, nonce, commit])

  const reload = useCallback(() => { setNonce(n => n + 1) }, [])

  /** The version a write is sent at: the one it was made on, moved along this page's own applied writes only. */
  const rebase = useCallback((seen: number): number => {
    let v = seen
    for (let n = 0; moves.current.has(v) && n < 1000; n++) v = moves.current.get(v)!
    return v
  }, [])

  /** A write of this page landed: record its move, and show what the server now holds, then re-read. */
  const landed = useCallback((sent: number, version: number, patch: (p: ProjectionPage) => ProjectionPage) => {
    if (sent !== version) moves.current.set(sent, version)
    const shown = server.current
    if (shown) {
      const next = patch(shown)
      commit(rebase(shown.version) === version ? { ...next, version } : next)
    }
    setNonce(n => n + 1)
  }, [commit, rebase])

  /** A refusal. A conflict repaints from the server's page and re-reads; anything else puts the row back and says why. */
  const refused = useCallback((result: Refusal, mapping: boolean) => {
    const elsewhere = movedElsewhere(result)
    if (result.conflict) commit(result.current)
    else publish()
    setWriteError(mapping && elsewhere ? MAPPING_CHANGED_ELSEWHERE : result.reason)
    if (mapping && elsewhere) setMappingConflicts(n => n + 1)
    if (result.conflict || elsewhere) setNonce(n => n + 1)
  }, [commit, publish])

  const setIncluded = useCallback((id: string, included: boolean) => {
    const shown = server.current
    if (!shown) return
    const seen = shown.version
    setWriteError(null)
    /* Optimistic, and the row is marked PENDING while it is — an unmarked optimistic value is a
       page asserting a server fact it does not have yet (feedback_100_percent_honest_ui). */
    asked.current.set(id, { included, n: (asked.current.get(id)?.n ?? 0) + 1 })
    publish()
    void inLine(async () => {
      const sent = rebase(seen)
      let result: ProjectionSaveResult
      try {
        result = await source.setIncluded(sent, [{ id, included }])
      } catch (e) {
        result = { ok: false, conflict: false, reason: e instanceof Error ? e.message : String(e) }
      }
      if (!live.current) return
      const mine = asked.current.get(id)
      if (mine && --mine.n <= 0) asked.current.delete(id)
      if (result.ok) {
        landed(sent, result.version, p => ({ ...p, children: p.children.map(c => (c.id === id ? { ...c, included } : c)) }))
        return
      }
      /* Refused: the row shows what the server holds again. Leaving the optimistic value would be
         the page telling the operator a write landed that did not. */
      refused(result, false)
    })
  }, [source, inLine, rebase, publish, landed, refused])

  const saveMapping = useCallback((draft: ProjectionDraft, basedOn?: number): Promise<boolean> => {
    const shown = server.current
    if (!shown) return Promise.resolve(false)
    const seen = basedOn ?? shown.version
    setWriteError(null)
    mappingSaves.current += 1
    setSaving(true)
    return inLine(async () => {
      try {
        const sent = rebase(seen)
        let result: ProjectionSaveResult
        try {
          result = await source.saveMapping(sent, draft)
        } catch (e) {
          result = { ok: false, conflict: false, reason: e instanceof Error ? e.message : String(e) }
        }
        if (!live.current) return false
        if (result.ok) {
          /* The re-read `landed` starts is what counts: the save's own answer is what it WROTE, not
             what the coordinate now holds — the split, the lock and the per-value counts all move with it. */
          landed(sent, result.version, p => ({
            ...p, mapping: draft.mapping, split: { ...p.split, mode: draft.split.mode, axisKey: draft.split.axisKey },
          }))
          return true
        }
        refused(result, true)
        return false
      } finally {
        mappingSaves.current -= 1
        if (live.current && mappingSaves.current === 0) setSaving(false)
      }
    })
  }, [source, inLine, rebase, landed, refused])

  const dismissWriteError = useCallback(() => setWriteError(null), [])

  return useMemo(() => ({
    page, loading, error, backendMissing, writeError, pending, saving, mappingConflicts,
    reload, setIncluded, saveMapping, dismissWriteError,
  }), [page, loading, error, backendMissing, writeError, pending, saving, mappingConflicts, reload, setIncluded, saveMapping, dismissWriteError])
}
