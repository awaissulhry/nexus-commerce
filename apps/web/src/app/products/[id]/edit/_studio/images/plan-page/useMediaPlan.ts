'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MediaOp, MediaPlan } from '@nexus/shared/media-plan'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'

import { useSaveReporter } from '../../contracts'
import { apiGet, apiSend } from '../api'
import { applyLocal, computeLayouts, viewAddress, viewKey, withLayer, type LayerView, type MediaRead } from './model'

/**
 * Images rebuild P3b — the Media page's state: one read, small edits to one layer, Undo/Redo, live refresh.
 *
 * Every edit moves the page at once (the shared edit logic applied locally, refusing exactly what the server refuses),
 * then `POST /media/ops` saves it; edits are sent one after another, so they land in the order they were made. The
 * server's answer carries the edit's Undo (ops bound to what the layer holds now). Another person's change arrives as
 * `product-media.changed` and reloads quietly — never while an edit is on its way or a photo is being dragged.
 */

export interface OpsResult { rootId: string; key: string; plan: MediaPlan | null; revision: number; undo: MediaOp[] }
/**
 * A library action in the page's Undo/Redo (W4a/W4b: "same photo", "language versions", "not the same"): `run` does the
 * step on the server and returns the entry that reverses it (or null). Plan edits are ops entries; both share one stack.
 */
export interface ActionEntry { label: string; run(): Promise<ActionEntry | null> }
type HistoryEntry = { view: LayerView; ops: MediaOp[]; label: string } | ActionEntry
const isAction = (entry: HistoryEntry): entry is ActionEntry => 'run' in entry
export type EditOutcome = { ok: true; undo: MediaOp[] } | { ok: false; message: string }

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; read: MediaRead }

export function useMediaPlan(productId: string) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [writeError, setWriteError] = useState<{ message: string; retry?: () => void } | null>(null)
  const [history, setHistory] = useState<{ undo: HistoryEntry[]; redo: HistoryEntry[] }>({ undo: [], redo: [] })
  const [notice, setNotice] = useState<string | null>(null)
  const reporter = useSaveReporter()
  const writer = useMemo(() => `media-page:${Math.random().toString(36).slice(2)}`, [])
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const pending = useRef(new Map<string, number>())
  const own = useRef(new Map<string, number>())
  const stale = useRef(false)
  const held = useRef(false)
  const readRef = useRef<MediaRead | null>(null)
  if (state.status === 'ready') readRef.current = state.read

  /** Reads the family again; answers the new read (null when it failed) so a caller can act on it at once. */
  const load = useCallback(async (quiet = false): Promise<MediaRead | null> => {
    if (!quiet) setState({ status: 'loading' })
    const res = await apiGet<MediaRead>(`/api/products/${encodeURIComponent(productId)}/media`)
    if (!res.ok) {
      if (quiet) { setNotice(`Photos could not be refreshed: ${res.message}`); return null }
      setState({ status: 'error', message: res.message })
      return null
    }
    stale.current = false
    readRef.current = res.data
    setState({ status: 'ready', read: res.data })
    return res.data
  }, [productId])

  useEffect(() => { void load() }, [load])

  const busy = () => held.current || [...pending.current.values()].some(n => n > 0)
  const refreshTimer = useRef<number | null>(null)
  const refreshSoon = useCallback(() => {
    if (busy()) { stale.current = true; return }
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
    refreshTimer.current = window.setTimeout(() => { refreshTimer.current = null; if (busy()) stale.current = true; else void load(true) }, 400)
  }, [load])
  useEffect(() => () => { if (refreshTimer.current) window.clearTimeout(refreshTimer.current) }, [])

  // Another screen, tab or person changed this family's photos. Our own saves echo back from the server: skipped.
  useInvalidationChannel(['product-media.changed'], event => {
    const read = readRef.current
    if (!read || (event.id && event.id !== read.rootId && event.id !== read.productId)) return
    if (event.meta?.writer === writer) return
    const layer = typeof event.meta?.layer === 'string' ? event.meta.layer : null
    if (layer && (own.current.get(layer) ?? 0) > Date.now() - 5000) return
    refreshSoon()
  })

  /** Hold live refresh while a drag is in progress; a refresh that arrived meanwhile runs on release. */
  const hold = useCallback((on: boolean) => {
    held.current = on
    if (!on && stale.current) refreshSoon()
  }, [refreshSoon])

  const send = useCallback((view: LayerView, ops: MediaOp[], label: string, kind: 'edit' | 'undo' | 'redo'): Promise<EditOutcome> => {
    const read = readRef.current
    if (!read) return Promise.resolve({ ok: false, message: 'The photos are still loading.' })
    let optimistic: MediaRead
    try { optimistic = applyLocal(read, view, ops) } catch (error) {
      // Refused before anything left the browser (the same rule the server applies): say why, change nothing.
      const message = (error as Error).message
      setWriteError({ message })
      return Promise.resolve({ ok: false, message })
    }
    readRef.current = optimistic
    const key = viewKey(view)
    const address = viewAddress(read, view)
    setWriteError(null)
    setState({ status: 'ready', read: optimistic })
    pending.current.set(key, (pending.current.get(key) ?? 0) + 1)
    const writeId = crypto.randomUUID(), subject = `media-plan:${key}`
    reporter.pending(writeId, subject)
    const run = queue.current.then(async (): Promise<EditOutcome> => {
      const res = await apiSend<OpsResult>(`/api/products/${encodeURIComponent(productId)}/media/ops`, 'POST', { address, ops })
      pending.current.set(key, (pending.current.get(key) ?? 1) - 1)
      if (!res.ok) {
        reporter.resolved(writeId, false, res.message, subject)
        setWriteError({ message: res.message, retry: () => { void send(view, ops, label, kind) } })
        // What the server holds is the truth: reload it rather than keep an edit that did not save.
        await load(true)
        return { ok: false, message: res.message }
      }
      reporter.resolved(writeId, true, undefined, subject)
      own.current.set(res.data.key, Date.now())
      // Later edits of this layer are already on screen; only the last answer may replace it.
      setState(current => current.status !== 'ready' ? current
        : { status: 'ready', read: (pending.current.get(key) ?? 0) > 0 ? current.read : withLayer(current.read, view, res.data.plan, res.data.revision) })
      const entry: HistoryEntry = { view, ops: res.data.undo, label }
      setHistory(h => kind === 'undo' ? { undo: h.undo, redo: [entry, ...h.redo].slice(0, 50) }
        : kind === 'redo' ? { undo: [entry, ...h.undo].slice(0, 50), redo: h.redo }
        : { undo: [entry, ...h.undo].slice(0, 50), redo: [] })
      emitInvalidation({ type: 'product-media.changed', id: res.data.rootId, meta: { writer, layer: res.data.key } })
      if (stale.current && !busy()) refreshSoon()
      return { ok: true, undo: res.data.undo }
    })
    queue.current = run.catch(() => undefined)
    return run
  }, [load, productId, refreshSoon, reporter, writer])

  const edit = useCallback((view: LayerView, ops: MediaOp[], label: string) => send(view, ops, label, 'edit'), [send])
  /** A library action done on the server: its way back goes on top of Undo (and Redo is cleared, as for an edit). */
  const record = useCallback((entry: ActionEntry) => setHistory(h => ({ undo: [entry, ...h.undo].slice(0, 50), redo: [] })), [])
  /** Run one action entry from Undo (or Redo), wherever it is in the stack; its reverse goes on the other stack. */
  const runAction = useCallback(async (entry: ActionEntry, from: 'undo' | 'redo') => {
    setHistory(h => from === 'undo' ? { ...h, undo: h.undo.filter(e => e !== entry) } : { ...h, redo: h.redo.filter(e => e !== entry) })
    try {
      const reverse = await entry.run()
      if (reverse) setHistory(h => from === 'undo' ? { ...h, redo: [reverse, ...h.redo].slice(0, 50) } : { ...h, undo: [reverse, ...h.undo].slice(0, 50) })
    } catch (error) {
      setWriteError({ message: error instanceof Error ? error.message : String(error) })
    }
    await load(true)
  }, [load])
  const undo = useCallback(() => {
    const [entry, ...rest] = history.undo
    if (!entry) return
    if (isAction(entry)) { void runAction(entry, 'undo'); return }
    setHistory(h => ({ ...h, undo: rest }))
    void send(entry.view, entry.ops, entry.label, 'undo')
  }, [history.undo, runAction, send])
  const redo = useCallback(() => {
    const [entry, ...rest] = history.redo
    if (!entry) return
    if (isAction(entry)) { void runAction(entry, 'redo'); return }
    setHistory(h => ({ ...h, redo: rest }))
    void send(entry.view, entry.ops, entry.label, 'redo')
  }, [history.redo, runAction, send])
  const undoAction = useCallback((entry: ActionEntry) => runAction(entry, 'undo'), [runAction])

  const layouts = useMemo(() => state.status === 'ready' ? computeLayouts(state.read) : {}, [state])

  return {
    state, layouts, reload: load, edit, undo, redo, hold, record, undoAction,
    canUndo: history.undo.length > 0, canRedo: history.redo.length > 0,
    undoLabel: history.undo[0]?.label ?? null, redoLabel: history.redo[0]?.label ?? null,
    writeError, clearWriteError: () => setWriteError(null), notice, clearNotice: () => setNotice(null),
  }
}
export type MediaPlanState = ReturnType<typeof useMediaPlan>
