'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useLiveChanges } from '../../../../record-panels/live'
import { createPom, getPom, listPoms, lookAtPomPicture, setPomStatus, updatePom, uploadPomPicture, clearPomPicture, type PomRow, type PomView } from './api'
import { cellProblem, csvOf, depthProblem, markKey, pomBody, pomCellPatch, pomPatchOf, readProblemOf, statusQuery, type CellMark, type DepthCan, type DepthFilters, type Locale, type PomCell, type PomDraft } from './model'
import type { PomsViewModel, PomsActions, PomDialog } from './view/PomsView'

/**
 * Sizes › Points of measure's container hook (B-W2b-240 on B-W2b-224's API): the library as the address filters it
 * (live `point_of_measure.changed` behind "N updates · Show"), a cell typed in the list saved by itself at the point's
 * version (CellSaveMark while it goes, "!" with our words when refused, and waiting on this page while offline), the
 * selection archived or restored in one write, New point / Edit point, the how-to picture (announced, sent, completed;
 * looked at when its card opens). The body points the dialog offers are read once it opens.
 */
export function usePoms({ api, filters, enabled, can, companyId, locale, words }: { api: ApiClient; filters: DepthFilters; enabled: boolean; can: DepthCan; companyId: string | null; locale: Locale; words: { csvHeader: string[]; kind: (kind: string) => string; status: (status: string) => string } }): {
  model: Omit<PomsViewModel, 'prefix' | 'can' | 'filters' | 'companies'>
  actions: Omit<PomsActions, 'onFilters'>
} {
  const [rows, setRows] = useState<PomsViewModel['rows']>({ items: null, more: false, count: null, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<PomsViewModel['notice']>(null)
  const [busy, setBusy] = useState(false)
  const [marks, setMarks] = useState<Record<string, CellMark>>({})
  const [dialog, setDialog] = useState<PomDialog | null>(null)
  const [edit, setEdit] = useState<PomsViewModel['edit']>(null)
  const [bodyPoints, setBodyPoints] = useState<PomsViewModel['bodyPoints']>(null)
  const [looks, setLooks] = useState<PomsViewModel['looks']>({})
  const [offline, setOffline] = useState(false)
  const seq = useRef(0)
  const items = useRef<PomRow[]>([])
  items.current = rows.items ?? []
  const waiting = useRef(new Map<string, { id: string; cell: PomCell; text: string }>())
  const writing = useRef(0)

  const load = useCallback(async () => {
    if (!enabled) return
    const mine = ++seq.current
    setRows((current) => ({ ...current, items: null, problem: null }))
    try {
      const page = await listPoms(api, { q: filters.q, kind: filters.kind ?? undefined, status: statusQuery(filters.status) })
      if (mine !== seq.current) return
      setRows({ items: page.points, more: page.nextCursor !== null, count: page.count, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
      setMarks({})
    } catch (error) {
      if (mine === seq.current) setRows({ items: null, more: false, count: null, problem: readProblemOf(error) })
    }
  }, [api, enabled, filters.q, filters.kind, filters.status])

  useEffect(() => {
    void load()
  }, [load])

  useLiveChanges(
    {
      onChange: (change) => {
        if (change.type === 'point_of_measure.changed' && writing.current === 0) setUpdates((count) => count + 1)
      },
      onReconnect: () => setUpdates((count) => count + 1),
    },
    enabled,
  )

  const replace = (point: PomRow) => setRows((current) => ({ ...current, items: current.items ? current.items.map((row) => (row.id === point.id ? { ...row, ...point } : row)) : current.items }))
  const setMark = (key: string, mark: CellMark | null) =>
    setMarks((current) => {
      const next = { ...current }
      if (mark) next[key] = mark
      else delete next[key]
      return next
    })

  const sendCell = async (id: string, cell: PomCell, text: string) => {
    const key = markKey(id, cell)
    const point = items.current.find((row) => row.id === id)
    if (!point) return setMark(key, null)
    const planned = pomCellPatch(point, cell, text)
    if (planned === null) return setMark(key, null)
    if ('problem' in planned) return setMark(key, { state: 'refused', value: text, problem: planned.problem })
    setMark(key, { state: 'saving', value: text })
    writing.current++
    try {
      replace(await updatePom(api, point, planned.patch))
      setMark(key, null)
    } catch (error) {
      setMark(key, { state: 'refused', problem: cellProblem(error) })
      if (depthProblem(error).reload) void getPom(api, id).then(replace).catch(() => undefined)
    } finally {
      writing.current--
    }
  }

  useEffect(() => {
    const update = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false)
    update()
    const flush = () => {
      update()
      const entries = [...waiting.current.values()]
      waiting.current.clear()
      void entries.reduce<Promise<void>>((chain, entry) => chain.then(() => sendCell(entry.id, entry.cell, entry.text)), Promise.resolve())
    }
    window.addEventListener('online', flush)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', flush)
      window.removeEventListener('offline', update)
    }
  })

  const loadBodyPoints = () => {
    if (bodyPoints !== null) return
    listPoms(api, { kind: 'BODY', status: 'ACTIVE', limit: 200 })
      .then((page) => setBodyPoints(page.points.map((point) => ({ id: point.id, code: point.code, name: point.name }))))
      .catch(() => setBodyPoints([]))
  }

  const openDialog = (next: PomDialog | null) => {
    setDialog(next)
    if (next?.kind === 'new' || next?.kind === 'edit') loadBodyPoints()
    if (next?.kind === 'edit') {
      setEdit({ point: null, problem: null, busy: false, refused: null })
      getPom(api, next.id)
        .then((point) => setEdit({ point, problem: null, busy: false, refused: null }))
        .catch((error: unknown) => setEdit({ point: null, problem: readProblemOf(error), busy: false, refused: null }))
    } else if (next?.kind === 'new') setEdit({ point: null, problem: null, busy: false, refused: null })
    else setEdit(null)
  }

  const actions: Omit<PomsActions, 'onFilters'> = {
    onRetry: () => void load(),
    onShowUpdates: () => void load(),
    onMore: () => {
      if (!cursor) return
      listPoms(api, { q: filters.q, kind: filters.kind ?? undefined, status: statusQuery(filters.status), cursor })
        .then((page) => {
          setRows((current) => ({ items: [...(current.items ?? []), ...page.points], more: page.nextCursor !== null, count: page.count, problem: null }))
          setCursor(page.nextCursor)
        })
        .catch((error: unknown) => setNotice({ key: readProblemOf(error), tone: 'danger' }))
    },
    onCell: (point, cell, text) => {
      const key = markKey(point.id, cell)
      if (!can.manage) return setMark(key, { state: 'refused', value: text, problem: 'held.noManage' })
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        const planned = pomCellPatch(point, cell, text)
        if (planned === null) return
        if ('problem' in planned) return setMark(key, { state: 'refused', value: text, problem: planned.problem })
        waiting.current.set(key, { id: point.id, cell, text })
        setOffline(true)
        return setMark(key, { state: 'waiting', value: text })
      }
      void sendCell(point.id, cell, text)
    },
    onDialog: openDialog,
    onCreate: async (draft: PomDraft) => {
      setEdit((current) => ({ point: null, problem: null, refused: null, ...current, busy: true }))
      writing.current++
      try {
        const point = await createPom(api, pomBody(draft) as Parameters<typeof createPom>[1])
        openDialog(null)
        setNotice({ key: 'poms.notice.created', tone: 'success', params: { code: point.code } })
        void load()
        return true
      } catch (error) {
        setEdit((current) => (current ? { ...current, busy: false, refused: depthProblem(error) } : current))
        return false
      } finally {
        writing.current--
      }
    },
    onSave: async (point: PomView, draft: PomDraft) => {
      const patch = pomPatchOf(draft, point)
      if (Object.keys(patch).length === 0) {
        openDialog(null)
        return true
      }
      setEdit((current) => (current ? { ...current, busy: true, refused: null } : current))
      writing.current++
      try {
        const saved = await updatePom(api, point, patch)
        replace(saved)
        setEdit({ point: saved, problem: null, busy: false, refused: null })
        openDialog(null)
        setNotice({ key: 'poms.notice.saved', tone: 'success', params: { code: saved.code } })
        return true
      } catch (error) {
        const problem = depthProblem(error)
        setEdit((current) => (current ? { ...current, busy: false, refused: problem } : current))
        if (problem.reload) void getPom(api, point.id).then((fresh) => setEdit((current) => (current ? { ...current, point: fresh } : current))).catch(() => undefined)
        return false
      } finally {
        writing.current--
      }
    },
    onStatus: async (ids, to) => {
      const picked = items.current.filter((row) => ids.includes(row.id))
      if (picked.length === 0) return false
      setBusy(true)
      writing.current++
      try {
        const done = await setPomStatus(api, picked, to)
        for (const point of done) replace(point)
        setNotice({ key: to === 'ARCHIVED' ? 'poms.notice.archived' : 'poms.notice.restored', tone: 'success', params: { count: done.length } })
        setDialog(null)
        void load()
        return true
      } catch (error) {
        const problem = depthProblem(error)
        setNotice({ key: problem.key, tone: 'danger' })
        if (problem.reload) void load()
        return false
      } finally {
        setBusy(false)
        writing.current--
      }
    },
    onExport: (ids) => {
      const picked = items.current.filter((row) => ids.includes(row.id))
      const csv = csvOf([words.csvHeader, ...picked.map((row) => [row.code, row.name, words.kind(row.kind), row.bodyZone, row.uom.toLowerCase(), row.defaultTolerance ?? '', row.bodyPoint?.code ?? '', row.howTo ?? '', words.status(row.status)])])
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `points-of-measure-${new Date().toISOString().slice(0, 10)}.csv`
      link.click()
      URL.revokeObjectURL(link.href)
    },
    onLook: (id) => {
      if (looks[id]?.state === 'ready' || looks[id]?.state === 'loading') return
      setLooks((current) => ({ ...current, [id]: { state: 'loading' } }))
      lookAtPomPicture(api, id)
        .then((url) => setLooks((current) => ({ ...current, [id]: { state: 'ready', url } })))
        .catch(() => setLooks((current) => ({ ...current, [id]: { state: 'error' } })))
    },
    onPicture: async (point, file) => {
      setEdit((current) => (current ? { ...current, busy: true, refused: null } : current))
      writing.current++
      try {
        const done = await uploadPomPicture(api, point, file)
        replace(done.point)
        setLooks((current) => {
          const next = { ...current }
          delete next[point.id]
          return next
        })
        setEdit((current) => (current ? { ...current, point: done.point, busy: false } : current))
        setNotice({ key: done.current ? 'poms.notice.picture' : 'poms.notice.pictureScan', tone: done.current ? 'success' : 'info', params: { code: point.code } })
        return true
      } catch (error) {
        setEdit((current) => (current ? { ...current, busy: false, refused: { ...depthProblem(error), key: error instanceof TypeError ? 'poms.picture.problem' : depthProblem(error).key } } : current))
        return false
      } finally {
        writing.current--
      }
    },
    onClearPicture: async (point) => {
      setEdit((current) => (current ? { ...current, busy: true, refused: null } : current))
      writing.current++
      try {
        const saved = await clearPomPicture(api, point)
        replace(saved)
        setEdit((current) => (current ? { ...current, point: saved, busy: false } : current))
        return true
      } catch (error) {
        setEdit((current) => (current ? { ...current, busy: false, refused: depthProblem(error) } : current))
        return false
      } finally {
        writing.current--
      }
    },
    onDismissNotice: () => setNotice(null),
  }

  return {
    model: { rows, asOf, updates, notice, busy, marks, dialog, edit, bodyPoints, looks, offline, companyId, locale },
    actions,
  }
}
