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
 *     🔴 A write's own move is exactly ONE step (`sent → sent + 1`). An answer further on carries
 *     someone else's write too (an older server answers the read made after its commit): it is never
 *     counted as this page's, so a later save cannot pass over it.
 *  4. **An older read never paints over a newer one.** Every read takes a ticket when it starts; a
 *     write that lands takes a newer one. A read that started before the write answered is dropped
 *     (reference_read_before_the_write_arrived).
 *  5. **A tick still in line stays on screen.** The page shown is the server's last read with the
 *     ticks not yet settled laid over it, so a re-read that lands between two writes cannot flip the
 *     second tick back. Each of those rows is marked pending while it is
 *     (feedback_100_percent_honest_ui).
 *  6. **No verdict is not a refusal.** A dropped connection, a timeout or a 5xx may have landed. The
 *     line stops, the page reads again, says "may or may not have been saved", and the next write goes
 *     on from what that read shows (reference_transport_failure_write_is_unknown_outcome).
 *  7. **eBay's order token is taken at Save.** Every Specifics or value-order edit carries the page's
 *     order token, and the token moves with every row of the family (a tick, a pin). When the save's
 *     version, moved along this page's own writes, is the version the server shows, the save carries
 *     the token read now; otherwise it keeps the one it was made on and a real change answers 409.
 *  8. **Writes still in line keep the tab.** Closing or reloading the tab asks first while a tick or a
 *     save is waiting or in flight.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { writeQueue } from '../writeQueue'
import { MAPPING_CHANGED_ELSEWHERE, unknownOutcome } from './copy'
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

/** The mapped axes in their order — what a mapping save writes, compared on what a read shows. */
const mappedTargets = (mapping: ProjectionPage['mapping']): string =>
  JSON.stringify([...mapping].filter(m => m.target !== null).sort((a, b) => a.order - b.order).map(m => [m.axisKey, m.target]))

/** A source that throws reached no verdict either. */
const noVerdict = (e: unknown): Refusal => ({ ok: false, conflict: false, unknown: true, reason: e instanceof Error ? e.message : String(e) })

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
  /** This page's own applied writes, version → version (always one step). */
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

  /* Rule 8 — writes waiting or in flight are lost with the tab: the browser asks before it closes or reloads. */
  const busy = pending.size > 0 || saving
  useEffect(() => {
    if (!busy || typeof window === 'undefined') return
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [busy])

  /** The version a write is sent at: the one it was made on, moved along this page's own applied writes only. */
  const rebase = useCallback((seen: number): number => {
    let v = seen
    for (let n = 0; moves.current.has(v) && n < 1000; n++) v = moves.current.get(v)!
    return v
  }, [])

  /** A read inside the line (ticketed like every read): what the next write goes on from. `null` when it fails. */
  const readNow = useCallback(async (): Promise<ProjectionPage | null> => {
    const ticket = ++readTicket.current
    try {
      const fresh = await source.read(new AbortController().signal)
      if (live.current) commit(fresh, ticket)
      return fresh
    } catch {
      return null
    }
  }, [source, commit])

  /**
   * A write of this page landed. Only a ONE-step answer is this page's own move; anything further on carries
   * someone else's write as well, and is left for the re-read to show. Then the page shows what the server holds.
   */
  const landed = useCallback((sent: number, version: number, patch: (p: ProjectionPage) => ProjectionPage) => {
    const own = version === sent + 1
    if (own) moves.current.set(sent, version)
    const shown = server.current
    if (shown) {
      const next = patch(shown)
      commit(own && rebase(shown.version) === version ? { ...next, version } : next)
    }
    setNonce(n => n + 1)
  }, [commit, rebase])

  /**
   * Rule 6 — no verdict. The line waits for a fresh read. When that read shows exactly one step and this write's
   * own value, the step was this write's and the next write goes on from it; otherwise it is left as someone else's.
   */
  const noAnswer = useCallback(async (sent: number, reason: string, showsMine: (p: ProjectionPage) => boolean) => {
    const fresh = await readNow()
    if (!live.current) return
    if (fresh && fresh.version === sent + 1 && showsMine(fresh)) moves.current.set(sent, fresh.version)
    if (!fresh) { publish(); setNonce(n => n + 1) } // the read failed too: the page's own read tries again
    setWriteError(unknownOutcome(reason))
  }, [readNow, publish])

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
        result = noVerdict(e)
      }
      if (!live.current) return
      const mine = asked.current.get(id)
      if (mine && --mine.n <= 0) asked.current.delete(id)
      if (result.ok) {
        landed(sent, result.version, p => ({ ...p, children: p.children.map(c => (c.id === id ? { ...c, included } : c)) }))
        return
      }
      if (!result.conflict && result.unknown) {
        await noAnswer(sent, result.reason, p => p.children.find(c => c.id === id)?.included === included)
        return
      }
      /* Refused: the row shows what the server holds again. Leaving the optimistic value would be
         the page telling the operator a write landed that did not. */
      refused(result, false)
    })
  }, [source, inLine, rebase, publish, landed, noAnswer, refused])

  const saveMapping = useCallback((requested: ProjectionDraft, basedOn?: number): Promise<boolean> => {
    const shown = server.current
    if (!shown) return Promise.resolve(false)
    const seen = basedOn ?? shown.version
    setWriteError(null)
    mappingSaves.current += 1
    setSaving(true)
    return inLine(async () => {
      try {
        const sent = rebase(seen)
        let draft = requested
        /* Rule 7 — the order token as the server holds it NOW, when nothing but this page's own writes moved the version. */
        if (draft.presentationOrder) {
          const fresh = await readNow()
          const token = fresh?.order?.token
          if (fresh && fresh.version === sent && token) draft = { ...draft, presentationOrder: { ...draft.presentationOrder, expectedToken: token } }
        }
        let result: ProjectionSaveResult
        try {
          result = await source.saveMapping(sent, draft)
        } catch (e) {
          result = noVerdict(e)
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
        if (!result.conflict && result.unknown) {
          /* The dock stays open with the draft: saving it again is a no-op if this one landed. */
          await noAnswer(sent, result.reason, p => mappedTargets(p.mapping) === mappedTargets(draft.mapping) && p.split.mode === draft.split.mode)
          return false
        }
        refused(result, true)
        return false
      } finally {
        mappingSaves.current -= 1
        if (live.current && mappingSaves.current === 0) setSaving(false)
      }
    })
  }, [source, inLine, rebase, readNow, landed, noAnswer, refused])

  const dismissWriteError = useCallback(() => setWriteError(null), [])

  return useMemo(() => ({
    page, loading, error, backendMissing, writeError, pending, saving, mappingConflicts,
    reload, setIncluded, saveMapping, dismissWriteError,
  }), [page, loading, error, backendMissing, writeError, pending, saving, mappingConflicts, reload, setIncluded, saveMapping, dismissWriteError])
}
