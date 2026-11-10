'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { releaseRevision, type BomView } from '../api'
import { readGate, setScope, type GateView } from './api'
import { pickOf, readFault, scopeToSend, togglePick, WHOLE, writeFault, type ReleaseState, type ScopePick } from './model'

/**
 * The Release modal's container (B-W2b-231's gate; design pop:styles.release): reads the gate of the draft when the modal
 * opens (the studio's `r`, the band's Release, the Versions tab's Release…), and again for each scope picked (a preview,
 * the newest answer wins); "Release revision N" sends the picked scope first when the draft holds another (PUT
 * …/release-scope), then W1's release (POST …/release) — both through the studio's ONE write queue, each at the revision's
 * latest version. "Release more…" (a released revision released for some colourways or sizes) only widens. A refusal is
 * said inside the modal in this app's words, the gate is read again, and the pick stays.
 */

export interface ReleaseModel extends ReleaseState {
  revisionId: string
}

export interface ReleaseActions {
  onPartial?: (open: boolean) => void
  onToggle?: (side: 'colourway' | 'size', id: string) => void
  onSuggested?: () => void
  onRelease?: (changeNote: string) => Promise<boolean>
  onWiden?: () => Promise<boolean>
  onRetry?: () => void
  onClose?: () => void
}

/** The preview waits this long after the last tick before it asks (a run of ticks is one read). */
const PREVIEW_MS = 300

export function useReleaseGate({
  api,
  styleId,
  open,
  write,
  versionOf,
  onReleased,
  onWidened,
  onClose,
}: {
  api: ApiClient
  styleId: string
  /** The modal is open for this revision (a draft: release; a released one: widen); null: closed. */
  open: { revisionId: string; mode: 'release' | 'widen' } | null
  /** The studio's one write queue (true when the server took it). */
  write: (work: () => Promise<void>) => Promise<boolean>
  versionOf: (revisionId: string) => { id: string; version: number } | null
  onReleased: (bom: BomView) => Promise<void> | void
  onWidened: () => void
  onClose: () => void
}): { model: ReleaseModel | undefined; actions: ReleaseActions } {
  const [state, setState] = useState<ReleaseState | null>(null)
  const seq = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stateRef = useRef<ReleaseState | null>(null)
  stateRef.current = state
  const key = open ? `${open.mode}:${open.revisionId}` : null

  const read = useCallback(
    (pick: ScopePick | null, first: boolean) => {
      if (!open) return
      const mine = ++seq.current
      readGate(api, styleId, open.revisionId, pick)
        .then((gate) => {
          if (mine !== seq.current) return
          setState((current) => {
            const planned = pickOf(gate, first ? 'planned' : 'asked')
            const base = current ?? { mode: open.mode, gate: { status: 'loading' }, pick: WHOLE, none: { colourways: false, sizes: false }, partial: false, previewing: false, busy: false, problem: null }
            return first
              ? { ...base, gate: { status: 'ready', value: gate }, pick: planned, partial: planned.colourwayIds.length > 0 || planned.sizes.length > 0 || open.mode === 'widen', previewing: false }
              : { ...base, gate: { status: 'ready', value: gate }, previewing: false }
          })
        })
        .catch((error: unknown) => {
          if (mine !== seq.current) return
          setState((current) => (current ? { ...current, gate: { status: 'error', problem: readFault(error).key }, previewing: false } : current))
        })
    },
    [api, styleId, key],
  )

  // Open: read the gate as the revision holds it; closed: forget it.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    if (!open) {
      seq.current++
      setState(null)
      return
    }
    setState({ mode: open.mode, gate: { status: 'loading' }, pick: WHOLE, none: { colourways: false, sizes: false }, partial: false, previewing: false, busy: false, problem: null })
    read(null, true)
  }, [key])

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  /** A new pick: shown at once, its gate read after a short pause (a run of ticks is one read). */
  const preview = (next: ScopePick, none: ReleaseState['none']) => {
    setState((current) => (current ? { ...current, pick: next, none, previewing: !(none.colourways || none.sizes), problem: null } : current))
    if (timer.current) clearTimeout(timer.current)
    if (none.colourways || none.sizes) return
    timer.current = setTimeout(() => read(next, false), PREVIEW_MS)
  }

  const gateOf = (): GateView | null => (stateRef.current?.gate.status === 'ready' ? stateRef.current.gate.value : null)

  const actions: ReleaseActions = {
    onPartial: (on) => {
      const current = stateRef.current
      const gate = gateOf()
      if (!current || !gate) return
      setState({ ...current, partial: on })
      // Closing "only some" releases every colourway and size again (a released revision keeps what it has).
      if (!on && current.mode === 'release') preview(WHOLE, { colourways: false, sizes: false })
    },
    onToggle: (side, id) => {
      const current = stateRef.current
      const gate = gateOf()
      if (!current || !gate) return
      const every = side === 'colourway' ? gate.scope.colourways.filter((entry) => entry.status === 'ACTIVE' || entry.planned).map((entry) => entry.id) : gate.scope.sizes.map((entry) => entry.code)
      const field = side === 'colourway' ? 'colourways' : 'sizes'
      // Unticking the last one leaves none (an empty list would mean every one): said, never sent.
      const list = side === 'colourway' ? current.pick.colourwayIds : current.pick.sizes
      const on = current.none[field] ? [] : list.length === 0 ? every : list
      if (on.length === 1 && on[0] === id) {
        preview(current.pick, { ...current.none, [field]: true })
        return
      }
      if (current.none[field]) {
        preview({ ...current.pick, [side === 'colourway' ? 'colourwayIds' : 'sizes']: every.length === 1 ? [] : [id] }, { ...current.none, [field]: false })
        return
      }
      preview(togglePick(current.pick, side, id, every), current.none)
    },
    onSuggested: () => {
      const gate = gateOf()
      if (!gate?.scope.suggested) return
      const suggested = gate.scope.suggested
      preview(
        {
          colourwayIds: suggested.whole ? [] : [...suggested.colourwayIds],
          sizes: suggested.whole ? [] : [...suggested.sizes],
        },
        { colourways: false, sizes: false },
      )
    },
    onRetry: () => {
      const current = stateRef.current
      if (!current) return
      setState({ ...current, gate: { status: 'loading' }, problem: null })
      read(current.gate.status === 'ready' ? current.pick : null, current.gate.status !== 'ready')
    },
    onClose,
    onRelease: async (changeNote) => {
      const current = stateRef.current
      const gate = gateOf()
      if (!open || !current || !gate) return false
      setState({ ...current, busy: true, problem: null })
      const done = await write(async () => {
        try {
          const latest = versionOf(open.revisionId)
          let version = Math.max(gate.revision.version, latest?.version ?? 0)
          const send = scopeToSend(current, gate)
          if (send) version = (await setScope(api, styleId, { id: open.revisionId, version }, send)).revision.version
          await onReleased(await releaseRevision(api, styleId, { id: open.revisionId, version }, changeNote || undefined))
        } catch (error) {
          setState((now) => (now ? { ...now, problem: writeFault(error) } : now))
          throw error
        }
      })
      setState((now) => (now ? { ...now, busy: false } : now))
      if (done) onClose()
      else read(current.pick, false)
      return done
    },
    onWiden: async () => {
      const current = stateRef.current
      const gate = gateOf()
      if (!open || !current || !gate) return false
      setState({ ...current, busy: true, problem: null })
      const done = await write(async () => {
        try {
          await setScope(api, styleId, { id: open.revisionId, version: gate.revision.version }, current.pick)
          onWidened()
        } catch (error) {
          setState((now) => (now ? { ...now, problem: writeFault(error) } : now))
          throw error
        }
      })
      setState((now) => (now ? { ...now, busy: false } : now))
      if (done) onClose()
      else read(current.pick, false)
      return done
    },
  }

  // Until the gate of this opening is asked, the modal shows it being read (never the studio's older check).
  const opening: ReleaseState | null = open ? { mode: open.mode, gate: { status: 'loading' }, pick: WHOLE, none: { colourways: false, sizes: false }, partial: false, previewing: false, busy: false, problem: null } : null
  const shown = open ? (state && state.mode === open.mode ? state : opening) : null
  return { model: shown && open ? { ...shown, revisionId: open.revisionId } : undefined, actions }
}
