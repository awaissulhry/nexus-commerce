'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReasonList } from '@nexus/factory-domain/reasons/lists'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useLive } from '../buying/hooks'
import { addStandard, createReason, editReason, readLists, reorder, setActive, type Reason, type ReasonEdit, type ReasonListView } from './api'
import { draftBody, echoKey, fieldOfEdit, firstList, markKey, moveOf, problemOf, readProblemOf, REASON_NAMESPACES, withEdit, wordEdit, type CellField, type Mark, type Notice, type ReasonDraft } from './model'
import { ReasonListsView, type ReasonDialog, type ReasonListsModel } from './view/ReasonListsView'

export interface ReasonListsEditorProps {
  /** The lists this host shows, in its switch's order (factory-domain reasons/lists REASON_LIST_GROUPS: the design's sets). */
  lists: readonly ReasonList[]
  /** The list shown first (a host's `?list=`), else the first. */
  initialList?: string | null
  /** The person switched list (a host may keep it in its address). */
  onListChange?: (list: ReasonList) => void
}

const SAVED_FADE_MS = 1500

/**
 * The shared reason list editor's container (B-W2a-18; SCR-242). A host mounts it with its lists:
 *
 *   <ReasonListsEditor lists={REASON_LIST_GROUPS.floorRules} />          Production › Floor rules & codes (B-W2a-46)
 *   <ReasonListsEditor lists={['RETURN', 'CANCEL']} />                    Sales settings › Return policy and reasons
 *
 * It reads the lists (`GET /reasons/lists`, reasons.view), saves each cell on its own (PATCH at the version read; a row's
 * edits wait for each other so the second carries the first's new version), sets many inactive or active again, moves
 * them, adds the standard reasons a list lacks and new reasons, each write with its own Idempotency-Key. Live
 * `reason.changed` of one of its lists from someone else → "Changed by someone else · Reload".
 */
export function ReasonListsEditor(props: ReasonListsEditorProps) {
  return (
    <WithMessages namespaces={REASON_NAMESPACES}>
      <Container {...props} />
    </WithMessages>
  )
}

interface Data {
  views: ReadonlyMap<ReasonList, ReasonListView>
  languages: readonly string[]
  canManage: boolean
}

function Container({ lists, initialList, onListChange }: ReasonListsEditorProps) {
  const api = useOfficeApi()
  const listsKey = lists.join(',')
  const [list, setList] = useState<ReasonList>(() => firstList(lists, initialList))
  const [load, setLoad] = useState<ReasonListsModel['load']>({ status: 'loading' })
  const [data, setData] = useState<Data | null>(null)
  const [marks, setMarks] = useState<Record<string, Mark>>({})
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<ReasonDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const dataRef = useRef<Data | null>(null)
  dataRef.current = data
  const dialogRef = useRef<ReasonDialog | null>(null)
  dialogRef.current = dialog
  // The live messages our own writes will cause (each write's list and codes): those are not "changed by someone else".
  const echoes = useRef(new Map<string, number>())
  const queues = useRef(new Map<string, Promise<unknown>>())

  const read = useCallback(async () => {
    try {
      const answer = await readLists(api, listsKey.split(',') as ReasonList[])
      setData({ views: new Map(answer.lists.map((view) => [view.list, view])), languages: answer.languages, canManage: answer.canManage })
      setLoad({ status: 'ready' })
      setChangedElsewhere(false)
    } catch (error) {
      setLoad({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, listsKey])

  useEffect(() => {
    void read()
  }, [read])

  useLive(
    (change) => {
      if (change.type !== 'reason.changed' || !(lists as readonly string[]).includes(String(change.fields.list))) return
      const key = echoKey(String(change.fields.list), Array.isArray(change.fields.codes) ? change.fields.codes.map(String) : [])
      const waiting = echoes.current.get(key) ?? 0
      if (waiting > 0) {
        echoes.current.set(key, waiting - 1)
        return
      }
      setChangedElsewhere(true)
    },
    () => void read(),
  )

  /** A write of ours is on its way: its live message is ours. Returns the undo for a write that failed (no message). */
  const mine = (listName: ReasonList, codes: readonly string[]) => {
    const key = echoKey(listName, codes)
    echoes.current.set(key, (echoes.current.get(key) ?? 0) + 1)
    return () => echoes.current.set(key, Math.max(0, (echoes.current.get(key) ?? 1) - 1))
  }
  const setMark = (id: string, field: CellField, mark: Mark | null) =>
    setMarks((current) => {
      const next = { ...current }
      if (mark) next[markKey(id, field)] = mark
      else delete next[markKey(id, field)]
      return next
    })
  const fade = (id: string, field: CellField) =>
    setTimeout(() => setMarks((current) => (current[markKey(id, field)]?.state === 'saved' ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== markKey(id, field))) : current)), SAVED_FADE_MS)

  /** One list's view replaced (an answer that carries the whole list). */
  const putView = (view: ReasonListView) =>
    setData((current) => (current ? { ...current, views: new Map(current.views).set(view.list, view) } : current))
  /** One reason replaced in its list (an optimistic change or the answer). */
  const putRow = (row: Reason) =>
    setData((current) => {
      const view = current?.views.get(row.list)
      if (!current || !view) return current
      const reasons = view.reasons.map((entry) => (entry.id === row.id ? row : entry))
      const next: ReasonListView = { ...view, reasons, active: reasons.filter((entry) => entry.active).length, inactive: reasons.filter((entry) => !entry.active).length }
      return { ...current, views: new Map(current.views).set(row.list, next) }
    })
  const rowNow = (row: Reason): Reason => dataRef.current?.views.get(row.list)?.reasons.find((entry) => entry.id === row.id) ?? row

  /** A cell's save: shown at once, then the answer (the row's next edit waits for this one's version). */
  const save = (row: Reason, edit: Omit<ReasonEdit, 'version'>) => {
    const field = fieldOfEdit({ version: 0, ...edit })
    const before = rowNow(row)
    putRow(withEdit(before, { version: before.version, ...edit }))
    setMark(row.id, field, { state: 'saving' })
    const previous = queues.current.get(row.id) ?? Promise.resolve()
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const current = rowNow(row)
        const failed = mine(row.list, [row.code])
        try {
          const saved = await editReason(api, row.list, row.id, { ...edit, version: current.version }, newIdempotencyKey())
          putRow(saved)
          setMark(row.id, field, { state: 'saved' })
          fade(row.id, field)
        } catch (error) {
          const problem = problemOf(error)
          if (!problem.unknown) failed()
          // The value as it was: never a value the server did not take (a lost answer says so: unknown).
          if (!problem.unknown) putRow({ ...withEdit(current, { version: current.version, ...reverseOf(before, edit) }) })
          setMark(row.id, field, { state: problem.unknown ? 'unknown' : 'refused', problem: problem.key })
        }
      })
    queues.current.set(row.id, run)
    void run.finally(() => {
      if (queues.current.get(row.id) === run) queues.current.delete(row.id)
    })
  }

  const view = data?.views.get(list) ?? null

  const model: ReasonListsModel = {
    lists,
    list,
    load,
    view,
    languages: data?.languages ?? [],
    canManage: data?.canManage ?? false,
    marks,
    notice,
    changedElsewhere,
    busy,
    dialog,
  }

  const actions = useMemo(
    () => ({
      onList: (next: ReasonList) => {
        setList(next)
        setDialog(null)
        setNotice(null)
        onListChange?.(next)
      },
      onRetry: () => {
        setLoad({ status: 'loading' })
        void read()
      },
      onReload: () => void read(),
      onCell: (row: Reason, field: CellField, value: unknown) => {
        const outcome = wordEdit(rowNow(row), field, value)
        if (!outcome) return
        if ('problem' in outcome) {
          setMark(row.id, field, { state: 'refused', problem: outcome.problem })
          return
        }
        const { version: _version, ...edit } = outcome.edit
        save(row, edit)
      },
      onLook: (row: Reason, change: { icon?: string | null; colour?: string | null }) => save(row, change),
      onSwitch: (row: Reason, field: 'active' | 'needsDetail', next: boolean) => save(row, { [field]: next }),
      onActiveMany: async (ids: readonly string[], active: boolean) => {
        const current = dataRef.current?.views.get(list)
        if (!current) return false
        const chosen = current.reasons.filter((row) => ids.includes(row.id) && row.active !== active)
        if (chosen.length === 0) return false
        setBusy(true)
        const failed = mine(list, chosen.map((row) => row.code))
        try {
          const answer = await setActive(api, list, active, chosen.map((row) => ({ id: row.id, version: row.version })), newIdempotencyKey())
          putView(answer.list)
          setNotice({ tone: 'success', key: active ? 'done.on' : 'done.off', params: { count: answer.changed.length, codes: answer.changed.join(', ') } })
          return true
        } catch (error) {
          if (!problemOf(error).unknown) failed()
          setNotice({ tone: 'danger', key: problemOf(error).key })
          return false
        } finally {
          setBusy(false)
        }
      },
      onMove: (ids: readonly string[], delta: -1 | 1) => {
        const current = dataRef.current?.views.get(list)
        if (!current) return
        const order = moveOf(current.reasons, ids, delta)
        if (!order) return
        const byId = new Map(current.reasons.map((row) => [row.id, row]))
        setBusy(true)
        const failed = mine(list, current.reasons.map((row) => row.code))
        reorder(api, list, order.map((id) => ({ id, version: byId.get(id)!.version })), newIdempotencyKey())
          .then((answer) => putView(answer))
          .catch((error: unknown) => {
            if (!problemOf(error).unknown) failed()
            setNotice({ tone: 'danger', key: problemOf(error).key })
          })
          .finally(() => setBusy(false))
      },
      onStandard: () => {
        setBusy(true)
        const failed = mine(list, dataRef.current?.views.get(list)?.standardMissing ?? [])
        addStandard(api, list, newIdempotencyKey())
          .then((answer) => {
            putView(answer.list)
            setNotice({ tone: 'success', key: 'done.standard', params: { count: answer.added.length, codes: answer.added.join(', ') } })
          })
          .catch((error: unknown) => {
            if (!problemOf(error).unknown) failed()
            setNotice({ tone: 'danger', key: problemOf(error).key })
          })
          .finally(() => setBusy(false))
      },
      onDialog: (next: ReasonDialog | null) => setDialog(next),
      onDraft: (draft: ReasonDraft) => setDialog((current) => (current?.kind === 'new' ? { ...current, draft, problem: null } : current)),
      onCreate: () => {
        const open = dialogRef.current
        const current = dataRef.current?.views.get(list)
        if (open?.kind !== 'new' || !current) return
        setBusy(true)
        const body = draftBody(open.draft, current)
        const failed = mine(list, [body.code])
        createReason(api, list, body, newIdempotencyKey())
          .then((reason) => {
            setData((now) => {
              const shown = now?.views.get(list)
              if (!now || !shown) return now
              const reasons = [...shown.reasons, reason]
              return { ...now, views: new Map(now.views).set(list, { ...shown, reasons, active: shown.active + 1, standardMissing: shown.standardMissing.filter((code) => code !== reason.code) }) }
            })
            setDialog(null)
            setNotice({ tone: 'success', key: 'done.created', params: { code: reason.code } })
          })
          .catch((error: unknown) => {
            if (!problemOf(error).unknown) failed()
            setDialog((still) => (still?.kind === 'new' ? { ...still, problem: problemOf(error).key } : still))
          })
          .finally(() => setBusy(false))
      },
      onDismissNotice: () => setNotice(null),
    }),
    // The helpers above read the latest rows and dialog through refs; the setters are stable.
    [api, list, read, onListChange],
  )

  return <ReasonListsView model={model} actions={actions} />
}

/** The fields of an edit set back to the row's values before it (a refused save puts back what was there). */
function reverseOf(before: Reason, edit: Omit<ReasonEdit, 'version'>): Omit<ReasonEdit, 'version'> {
  const back: Omit<ReasonEdit, 'version'> = {}
  if (edit.labelIt !== undefined) back.labelIt = before.labelIt
  if (edit.labelEn !== undefined) back.labelEn = before.labelEn
  if (edit.labelI18n !== undefined) back.labelI18n = Object.fromEntries(Object.keys(edit.labelI18n).map((language) => [language, before.labelI18n[language] ?? null]))
  if (edit.icon !== undefined) back.icon = before.icon
  if (edit.colour !== undefined) back.colour = before.colour
  if (edit.needsDetail !== undefined) back.needsDetail = before.needsDetail
  if (edit.active !== undefined) back.active = before.active
  return back
}
