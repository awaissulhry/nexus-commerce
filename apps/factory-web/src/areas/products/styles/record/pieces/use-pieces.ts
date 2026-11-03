'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { readProblem, writeProblem } from '../../problems'
import type { StyleNotice } from '../record-model'
import { addPiece, changePieces, getPieces, removePiece, removePieces, reorderPieces, updatePiece, type Piece, type PiecePatch, type PiecesView, type RevisionRef } from './api'
import { cellPatch, markKey, movedOrder, type PieceCell, type PieceMark, type PiecesActions, type PiecesDialog, type PiecesModel, type PiecesPart } from './pieces-model'

/**
 * The Pattern pieces section's container hook (B-W2b-95; SCR-271): reads the revision in view's pieces when it changes (a
 * role without the BOM reads nothing), and does what the section asks through the studio's ONE write queue (`write`: one
 * write at a time, the band's save words, a 409 reads the style again). A cell saves by itself (autosave per cell): it
 * shows the value typed with its mark until the server answers, then the answer; a refusal keeps the cell's old value
 * with "!" and our words. Offline (the browser says so) a cell's change waits on this page, marked, and is sent when the
 * connection is back; nothing else is queued. Every write moves the revision's version, which the BOM and routing share
 * (`versionOf` / `onVersion`).
 */
export function usePieces({
  api,
  styleId,
  revisionId,
  loadKey,
  enabled,
  write,
  versionOf,
  onVersion,
}: {
  api: ApiClient
  styleId: string
  revisionId: string | null
  /** Changes when the revision in view or any revision's state changes (the studio's own key). */
  loadKey: string | null
  enabled: boolean
  write: (work: () => Promise<void>, done?: StyleNotice) => Promise<boolean>
  versionOf: (revisionId: string) => RevisionRef | null
  onVersion: (revision: RevisionRef) => void
}): { model: PiecesModel; actions: PiecesActions; reload: () => void } {
  const [part, setPart] = useState<PiecesPart>({ status: 'idle' })
  const valueRef = useRef<PiecesView | null>(null)
  const [marks, setMarks] = useState<Record<string, PieceMark>>({})
  const [selected, setSelected] = useState<string[]>([])
  const [dialog, setDialog] = useState<PiecesDialog | null>(null)
  const [offline, setOffline] = useState(false)
  const [busy, setBusy] = useState(false)
  const waiting = useRef(new Map<string, { pieceId: string; cell: PieceCell; patch: PiecePatch; value: unknown; cleared: boolean }>())

  const setValue = useCallback(
    (next: PiecesView) => {
      valueRef.current = next
      onVersion({ id: next.revision.id, version: next.revision.version })
      setPart({ status: 'ready', value: next })
      setSelected((current) => current.filter((id) => next.pieces.some((piece) => piece.id === id)))
    },
    [onVersion],
  )

  const load = useCallback(
    (id: string) => {
      setPart((current) => (current.status === 'ready' && current.value.revision.id === id ? current : { status: 'loading' }))
      getPieces(api, styleId, id)
        .then(setValue)
        .catch((error: unknown) => setPart({ status: 'error', problem: readProblem(error) }))
    },
    [api, styleId, setValue],
  )

  useEffect(() => {
    if (!enabled || !revisionId) {
      valueRef.current = null
      setPart({ status: 'idle' })
      return
    }
    setMarks({})
    setSelected([])
    load(revisionId)
    // The key holds the revision in view and every revision's state.
  }, [loadKey, enabled])

  const reload = useCallback(() => {
    if (enabled && revisionId && valueRef.current) load(revisionId)
  }, [enabled, revisionId, load])

  const setMark = (key: string, mark: PieceMark | null) =>
    setMarks((current) => {
      const next = { ...current }
      if (mark) next[key] = mark
      else delete next[key]
      return next
    })

  /** One write through the studio's queue; the error is kept for the cell's words. */
  const run = async (work: (target: RevisionRef) => Promise<PiecesView>, done?: StyleNotice): Promise<{ ok: boolean; failure: unknown }> => {
    let failure: unknown = null
    setBusy(true)
    const ok = await write(async () => {
      const target = revisionId ? versionOf(revisionId) : null
      if (!target) return
      try {
        setValue(await work(target))
      } catch (error) {
        failure = error
        throw error
      }
    }, done)
    setBusy(false)
    return { ok, failure }
  }

  const send = async (pieceId: string, cell: PieceCell, patch: PiecePatch, value: unknown, cleared: boolean) => {
    const key = markKey(pieceId, cell)
    setMark(key, { state: 'saving', value })
    const name = valueRef.current?.pieces.find((piece) => piece.id === pieceId)?.name ?? ''
    const { ok, failure } = await run((target) => updatePiece(api, styleId, target, pieceId, patch), cleared ? { key: 'pieces.notice.gradeCleared', tone: 'info', params: { piece: name } } : undefined)
    setMark(key, ok ? null : { state: 'refused', problem: writeProblem(failure).key })
  }

  // Offline: what waits is sent when the browser is back online, in the order typed.
  useEffect(() => {
    const update = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false)
    update()
    const flush = () => {
      update()
      const entries = [...waiting.current.values()]
      waiting.current.clear()
      void entries.reduce<Promise<void>>((chain, entry) => chain.then(() => send(entry.pieceId, entry.cell, entry.patch, entry.value, entry.cleared)), Promise.resolve())
    }
    window.addEventListener('online', flush)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', flush)
      window.removeEventListener('offline', update)
    }
  })

  const actions: PiecesActions = {
    onRetry: () => revisionId && load(revisionId),
    onSelect: (ids) => setSelected(ids),
    onDialog: (next) => setDialog(next),
    onCell: (piece: Piece, cell: PieceCell, value: unknown) => {
      const view = valueRef.current
      if (!view) return
      const planned = cellPatch(piece, cell, value, view)
      const key = markKey(piece.id, cell)
      if ('problem' in planned) {
        setMark(key, { state: 'refused', value, problem: planned.problem })
        return
      }
      const same = Object.entries(planned.patch).every(([field, next]) => JSON.stringify(piece[field as PieceCell]) === JSON.stringify(next))
      if (same) {
        setMark(key, null)
        return
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        waiting.current.set(key, { pieceId: piece.id, cell, patch: planned.patch, value, cleared: planned.cleared })
        setMark(key, { state: 'waiting', value })
        setOffline(true)
        return
      }
      void send(piece.id, cell, planned.patch, value, planned.cleared)
    },
    onSave: async (pieceId, patch) => {
      if (pieceId !== null && Object.keys(patch).length === 0) {
        setDialog(null)
        return true
      }
      const { ok } = await run(
        (target) => (pieceId === null ? addPiece(api, styleId, target, patch as PiecePatch & { name: string }) : updatePiece(api, styleId, target, pieceId, patch)),
        { key: pieceId === null ? 'pieces.notice.added' : 'pieces.notice.saved', tone: 'success', params: { piece: patch.name ?? valueRef.current?.pieces.find((piece) => piece.id === pieceId)?.name ?? '' } },
      )
      if (ok) setDialog(null)
      return ok
    },
    onRemove: async (ids) => {
      const { ok } = await run((target) => (ids.length === 1 ? removePiece(api, styleId, target, ids[0]!) : removePieces(api, styleId, target, ids)), { key: 'pieces.notice.removed', tone: 'success', params: { count: ids.length } })
      if (ok) {
        setDialog(null)
        setSelected([])
      }
      return ok
    },
    onBulkGrade: async (ids, minGradeId) => {
      const { ok } = await run((target) => changePieces(api, styleId, target, ids, { minGradeId }), { key: 'pieces.notice.gradeSet', tone: 'success', params: { count: ids.length } })
      if (ok) {
        setDialog(null)
        setSelected([])
      }
      return ok
    },
    onMove: (pieceId, delta) => {
      const order = valueRef.current ? movedOrder(valueRef.current.pieces, pieceId, delta) : null
      if (order) void run((target) => reorderPieces(api, styleId, target, order))
    },
  }

  const model = useMemo<PiecesModel>(() => ({ part, marks, selected, dialog, offline, notice: null, busy }), [part, marks, selected, dialog, offline, busy])
  return { model, actions, reload }
}
