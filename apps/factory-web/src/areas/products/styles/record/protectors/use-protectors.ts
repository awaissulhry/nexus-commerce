'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { readProblem } from '../../problems'
import type { StyleNotice } from '../record-model'
import { addPlacement, getProtectors, orderPlacements, removePlacements, updatePlacement, type PlacementPatch, type PlacementView, type ProtectorPlacementView } from './api'
import {
  cellPatch,
  draftPatch,
  markKey,
  movedOrder,
  type PlacementCell,
  type PlacementDraft,
  type PlacementMark,
  type ProtectorsActions,
  type ProtectorsDialog,
  type ProtectorsModel,
  type ProtectorsPart,
} from './protectors-model'

/** A refused write in the section's own words (a `products-prepacks` key). */
export function placementProblem(error: unknown): string {
  if (!isApiError(error)) return 'protectors.problem.write'
  const paths = error.issues.map((issue) => String((issue as { path?: unknown }).path ?? ''))
  if (error.kind === 'invalid') return paths.some((path) => path.endsWith('sizes')) ? 'protectors.problem.overlap' : paths.some((path) => path.includes('protectorItemId')) ? 'protectors.problem.protector' : 'protectors.problem.invalid'
  if (error.kind === 'conflict') return error.code === 'version_conflict' ? 'protectors.problem.moved' : paths.some((path) => path.startsWith('refusal/')) ? 'protectors.held.rule' : 'protectors.problem.state'
  if (error.kind === 'forbidden') return 'protectors.held.noManage'
  return 'protectors.problem.write'
}

/**
 * The Protector placement section's container hook (B-W2b-233; SCR-287): reads the revision in view's placement when it
 * changes (a role without the BOM reads nothing), and does what the section asks through the studio's ONE write queue
 * (`write`). A cell saves by itself at the placement's version: it shows the value typed with its mark until the server
 * answers, then the answer; a refusal keeps the cell's old value with "!" and our words. Offline a cell's change waits on
 * this page, marked, and is sent when the connection is back; nothing else is queued.
 */
export function useProtectors({
  api,
  styleId,
  revisionId,
  loadKey,
  enabled,
  write,
}: {
  api: ApiClient
  styleId: string
  revisionId: string | null
  /** Changes when the revision in view or any revision's state changes (the studio's own key). */
  loadKey: string | null
  enabled: boolean
  write: (work: () => Promise<void>, done?: StyleNotice) => Promise<boolean>
}): { model: ProtectorsModel; actions: ProtectorsActions; reload: () => void } {
  const [part, setPart] = useState<ProtectorsPart>({ status: 'idle' })
  const valueRef = useRef<ProtectorPlacementView | null>(null)
  const [marks, setMarks] = useState<Record<string, PlacementMark>>({})
  const [selected, setSelected] = useState<string[]>([])
  const [dialog, setDialog] = useState<ProtectorsDialog | null>(null)
  const [notice, setNotice] = useState<ProtectorsModel['notice']>(null)
  const [offline, setOffline] = useState(false)
  const [busy, setBusy] = useState(false)
  const waiting = useRef(new Map<string, { placementId: string; cell: PlacementCell; patch: PlacementPatch; value: unknown }>())

  const setValue = useCallback((next: ProtectorPlacementView) => {
    valueRef.current = next
    setPart({ status: 'ready', value: next })
    setSelected((current) => current.filter((id) => next.placements.some((placement) => placement.id === id)))
  }, [])

  const load = useCallback(
    (id: string) => {
      setPart((current) => (current.status === 'ready' && current.value.revision.id === id ? current : { status: 'loading' }))
      getProtectors(api, styleId, id)
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

  const setMark = (key: string, mark: PlacementMark | null) =>
    setMarks((current) => {
      const next = { ...current }
      if (mark) next[key] = mark
      else delete next[key]
      return next
    })

  const run = async (work: (revision: string) => Promise<ProtectorPlacementView>): Promise<{ ok: boolean; failure: unknown }> => {
    let failure: unknown = null
    setBusy(true)
    const ok = await write(async () => {
      if (!revisionId) return
      try {
        setValue(await work(revisionId))
      } catch (error) {
        failure = error
        throw error
      }
    })
    setBusy(false)
    return { ok, failure }
  }

  const placementOf = (id: string): PlacementView | undefined => valueRef.current?.placements.find((placement) => placement.id === id)

  const send = async (placementId: string, cell: PlacementCell, patch: PlacementPatch, value: unknown) => {
    const key = markKey(placementId, cell)
    setMark(key, { state: 'saving', value })
    const placement = placementOf(placementId)
    if (!placement) return setMark(key, null)
    const { ok, failure } = await run((revision) => updatePlacement(api, styleId, revision, placement, patch))
    setMark(key, ok ? null : { state: 'refused', problem: placementProblem(failure) })
  }

  useEffect(() => {
    const update = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false)
    update()
    const flush = () => {
      update()
      const entries = [...waiting.current.values()]
      waiting.current.clear()
      void entries.reduce<Promise<void>>((chain, entry) => chain.then(() => send(entry.placementId, entry.cell, entry.patch, entry.value)), Promise.resolve())
    }
    window.addEventListener('online', flush)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', flush)
      window.removeEventListener('offline', update)
    }
  })

  const actions: ProtectorsActions = {
    onRetry: () => revisionId && load(revisionId),
    onSelect: (ids) => setSelected(ids),
    onDialog: (next) => setDialog(next),
    onDismissNotice: () => setNotice(null),
    onCell: (placement, cell, value) => {
      const view = valueRef.current
      if (!view) return
      const planned = cellPatch(placement, cell, value, view)
      const key = markKey(placement.id, cell)
      if ('problem' in planned) {
        setMark(key, { state: 'refused', value, problem: planned.problem })
        return
      }
      const current = cell === 'protectorItemId' ? placement.protector.id : placement[cell]
      if (JSON.stringify(current) === JSON.stringify(Object.values(planned.patch)[0])) {
        setMark(key, null)
        return
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        waiting.current.set(key, { placementId: placement.id, cell, patch: planned.patch, value })
        setMark(key, { state: 'waiting', value })
        setOffline(true)
        return
      }
      void send(placement.id, cell, planned.patch, value)
    },
    onSave: async (placementId, draft: PlacementDraft) => {
      const existing = placementId ? placementOf(placementId) : undefined
      const only = draft.sizes.length > 0
      const patch = draftPatch(draft, existing ?? null, only)
      if (existing && Object.keys(patch).length === 0) {
        setDialog(null)
        return true
      }
      const { ok } = await run((revision) => (existing ? updatePlacement(api, styleId, revision, existing, patch) : addPlacement(api, styleId, revision, patch)))
      if (ok) {
        setDialog(null)
        setNotice({ key: existing ? 'protectors.notice.saved' : 'protectors.notice.added', tone: 'success' })
      }
      return ok
    },
    onRemove: async (ids) => {
      const placements = ids.flatMap((id) => {
        const placement = placementOf(id)
        return placement ? [placement] : []
      })
      const { ok } = await run((revision) => removePlacements(api, styleId, revision, placements))
      if (ok) {
        setDialog(null)
        setSelected([])
        setNotice({ key: 'protectors.notice.removed', tone: 'success', params: { count: placements.length } })
      }
      return ok
    },
    onMove: (placementId, delta) => {
      const order = valueRef.current ? movedOrder(valueRef.current.placements, placementId, delta) : null
      if (order) void run((revision) => orderPlacements(api, styleId, revision, order))
    },
  }

  const model = useMemo<ProtectorsModel>(() => ({ part, marks, selected, dialog, offline, notice, busy }), [part, marks, selected, dialog, offline, notice, busy])
  return { model, actions, reload }
}
