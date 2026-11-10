'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { readProblem } from '../../problems'
import type { StyleNotice } from '../record-model'
import { createPrepack, getStylePrepacks, setPrepackStatus, updatePrepack, type PrepackLineInput, type PrepackView, type StylePrepacksView } from './api'
import { cellLines, draftLines, draftPatch, markKey, type PrepackDraft, type PrepackMark, type PrepacksActions, type PrepacksDialog, type PrepacksModel, type PrepacksNotice, type PrepacksPart } from './prepacks-model'

/** A refused write in the section's own words (a `products-prepacks` key). */
export function prepackProblem(error: unknown): string {
  if (!isApiError(error)) return 'prepacks.problem.write'
  if (error.kind === 'conflict') return /taken/i.test(error.message) ? 'prepacks.problem.codeTaken' : error.code === 'version_conflict' ? 'prepacks.problem.moved' : 'prepacks.problem.state'
  if (error.kind === 'forbidden') return 'prepacks.held.noManage'
  if (error.kind === 'invalid') return 'prepacks.problem.invalid'
  return 'prepacks.problem.write'
}

/**
 * The Prepacks section's container hook (B-W2b-233; SCR-287): reads the style's prepacks (its own and its scale's) when the
 * style changes, and does what the section asks through the studio's ONE write queue (`write`: one write at a time, the
 * band's save words; a 409 reads the style again). A size cell saves by itself (the whole list of lines of that pack at the
 * pack's version) and shows the value typed with its mark until the server answers; a refusal keeps the old value with "!"
 * and our words. Offline a cell's change waits on this page, marked, and goes when the connection is back. After every
 * write the section is read again (a scale's pack is measured against this style's range).
 */
export function usePrepacks({
  api,
  styleId,
  loadKey,
  enabled,
  canManage,
  write,
}: {
  api: ApiClient
  styleId: string
  /** Changes when the style changes (its version): the section reads again. */
  loadKey: string | null
  enabled: boolean
  canManage: boolean
  write: (work: () => Promise<void>, done?: StyleNotice) => Promise<boolean>
}): { model: PrepacksModel; actions: PrepacksActions; reload: () => void } {
  const [part, setPart] = useState<PrepacksPart>({ status: 'idle' })
  const valueRef = useRef<StylePrepacksView | null>(null)
  const [marks, setMarks] = useState<Record<string, PrepackMark>>({})
  const [selected, setSelected] = useState<string[]>([])
  const [dialog, setDialog] = useState<PrepacksDialog | null>(null)
  const [notice, setNotice] = useState<PrepacksNotice | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [offline, setOffline] = useState(false)
  const [busy, setBusy] = useState(false)
  const waiting = useRef(new Map<string, { prepackId: string; size: string; lines: PrepackLineInput[]; value: string | null }>())

  const setValue = useCallback((next: StylePrepacksView) => {
    valueRef.current = next
    setPart({ status: 'ready', value: next })
    setSelected((current) => current.filter((id) => next.prepacks.some((prepack) => prepack.id === id)))
  }, [])

  const load = useCallback(() => {
    setPart((current) => (current.status === 'ready' ? current : { status: 'loading' }))
    getStylePrepacks(api, styleId)
      .then(setValue)
      .catch((error: unknown) => setPart({ status: 'error', problem: readProblem(error) }))
  }, [api, styleId, setValue])

  useEffect(() => {
    if (!enabled) {
      valueRef.current = null
      setPart({ status: 'idle' })
      return
    }
    load()
    // The key holds the style's version.
  }, [loadKey, enabled])

  const reload = useCallback(() => {
    if (enabled && valueRef.current) load()
  }, [enabled, load])

  const setMark = (key: string, mark: PrepackMark | null) =>
    setMarks((current) => {
      const next = { ...current }
      if (mark) next[key] = mark
      else delete next[key]
      return next
    })

  /** One write through the studio's queue, then the section read again; the error is kept for the section's words. */
  const run = async (work: () => Promise<unknown>): Promise<{ ok: boolean; failure: unknown }> => {
    let failure: unknown = null
    setBusy(true)
    const ok = await write(async () => {
      try {
        await work()
        setValue(await getStylePrepacks(api, styleId))
      } catch (error) {
        failure = error
        throw error
      }
    })
    setBusy(false)
    return { ok, failure }
  }

  const prepackOf = (id: string): PrepackView | undefined => valueRef.current?.prepacks.find((prepack) => prepack.id === id)

  const send = async (prepackId: string, size: string, lines: PrepackLineInput[], value: string | null) => {
    const key = markKey(prepackId, size)
    setMark(key, { state: 'saving', value })
    const prepack = prepackOf(prepackId)
    if (!prepack) return setMark(key, null)
    const { ok, failure } = await run(() => updatePrepack(api, prepack, { lines }))
    setMark(key, ok ? null : { state: 'refused', problem: prepackProblem(failure) })
  }

  // Offline: what waits is sent when the browser is back online, in the order typed.
  useEffect(() => {
    const update = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false)
    update()
    const flush = () => {
      update()
      const entries = [...waiting.current.values()]
      waiting.current.clear()
      void entries.reduce<Promise<void>>((chain, entry) => chain.then(() => send(entry.prepackId, entry.size, entry.lines, entry.value)), Promise.resolve())
    }
    window.addEventListener('online', flush)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', flush)
      window.removeEventListener('offline', update)
    }
  })

  const actions: PrepacksActions = {
    onRetry: load,
    onSelect: (ids) => setSelected(ids),
    onDialog: (next) => setDialog(next),
    onShowArchived: (show) => setShowArchived(show),
    onDismissNotice: () => setNotice(null),
    onCell: (prepack, size, value) => {
      const planned = cellLines(prepack, size, value)
      const key = markKey(prepack.id, size)
      if ('problem' in planned) {
        setMark(key, { state: 'refused', value, problem: planned.problem })
        return
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        waiting.current.set(key, { prepackId: prepack.id, size, lines: planned.lines, value })
        setMark(key, { state: 'waiting', value })
        setOffline(true)
        return
      }
      void send(prepack.id, size, planned.lines, value)
    },
    onSave: async (prepackId, draft: PrepackDraft) => {
      const view = valueRef.current
      if (!view) return false
      const existing = prepackId ? prepackOf(prepackId) : undefined
      if (prepackId && existing) {
        const patch = draftPatch(draft, existing, view)
        if (Object.keys(patch).length === 0) {
          setDialog(null)
          return true
        }
        const { ok } = await run(() => updatePrepack(api, existing, patch))
        if (ok) {
          setDialog(null)
          setNotice({ key: 'prepacks.notice.saved', tone: 'success', params: { code: patch.code ?? existing.code } })
        }
        return ok
      }
      const { ok } = await run(() => createPrepack(api, styleId, { scope: draft.scope, code: draft.code.trim(), name: draft.name.trim(), lines: draftLines(draft, view) }))
      if (ok) {
        setDialog(null)
        setNotice({ key: 'prepacks.notice.added', tone: 'success', params: { code: draft.code.trim() } })
      }
      return ok
    },
    onStatus: async (ids, status) => {
      const view = valueRef.current
      if (!view) return false
      const moving = view.prepacks.filter((prepack) => ids.includes(prepack.id) && prepack.status !== status)
      if (moving.length === 0) return true
      const { ok } = await run(() => setPrepackStatus(api, moving, status))
      if (ok) {
        setDialog(null)
        setSelected([])
        setNotice({ key: status === 'ARCHIVED' ? 'prepacks.notice.archived' : 'prepacks.notice.restored', tone: 'success', params: { count: moving.length } })
      }
      return ok
    },
  }

  const model = useMemo<PrepacksModel>(() => ({ part, marks, selected, dialog, offline, notice, busy, showArchived, canManage }), [part, marks, selected, dialog, offline, notice, busy, showArchived, canManage])
  return { model, actions, reload }
}
