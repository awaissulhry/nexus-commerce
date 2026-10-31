'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useLive } from '../_shared/hooks'
import { plantCan } from '../_shared/model'
import { addStarter, createSymptom, editSymptom, readClasses, readSymptoms, type ClassRow, type SymptomEdit, type SymptomRow } from './api'
import { ALL, classFilterOf, draftBody, fieldOfEdit, inOrder, markKey, moveOf, orderWrites, problemOf, readProblemOf, reverseOf, withEdit, wordEdit, type CellField, type Mark, type Notice, type SymptomDraft } from './model'
import { PlantSettingsView, type PlantSettingsModel, type SymptomDialog } from './view/PlantSettingsView'

const SAVED_FADE_MS = 1500

interface Data {
  symptoms: SymptomRow[]
  classes: ClassRow[]
  starterMissing: string[]
  canManage: boolean
}

/**
 * `/w/<company>/plant/settings` (SCR-241): the group's symptoms and classes read once (`GET /plant/symptoms`, `GET
 * /plant/classes`, plant.view), the class filter in the address (`?class=all|every|<class id>`). Each cell saves on its
 * own (`PATCH /plant/symptoms/:id` at the version read; a row's edits wait for each other so the second carries the first's
 * new version), Stop offering / Offer again and the moves write row by row, New symptom (`POST /plant/symptoms`) and the
 * starter set (`POST /plant/starter`), each write with its own Idempotency-Key. Live `plant.lists_changed` of the symptoms
 * from someone else → "Changed by someone else · Reload" (our own writes' messages are counted out).
 */
export function PlantSettingsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const canView = useMemo(() => plantCan(session.permissions).view, [session.permissions])

  const [load, setLoad] = useState<PlantSettingsModel['load']>({ status: 'loading' })
  const [data, setData] = useState<Data | null>(null)
  const [marks, setMarks] = useState<Record<string, Mark>>({})
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<SymptomDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const dataRef = useRef<Data | null>(null)
  dataRef.current = data
  const dialogRef = useRef<SymptomDialog | null>(null)
  dialogRef.current = dialog
  // The live messages our own writes will cause (`SYMPTOM`, `STARTER`): those are not "changed by someone else".
  const echoes = useRef(new Map<string, number>())
  const queues = useRef(new Map<string, Promise<unknown>>())
  const classFilter = classFilterOf(params.get('class'), data?.classes ?? [])

  const read = useCallback(async () => {
    if (!canView) return
    try {
      const [symptoms, classes] = await Promise.all([readSymptoms(api), readClasses(api)])
      setData({ symptoms: inOrder(symptoms.symptoms), classes: classes.classes, starterMissing: classes.starterMissing, canManage: symptoms.canManage && classes.canManage })
      setLoad({ status: 'ready' })
      setChangedElsewhere(false)
    } catch (error) {
      setLoad({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, canView])

  useEffect(() => {
    void read()
  }, [read])

  useLive(
    (change) => {
      if (change.type !== 'plant.lists_changed') return
      const list = String(change.fields.list ?? '')
      const waiting = echoes.current.get(list) ?? 0
      if (waiting > 0) {
        echoes.current.set(list, waiting - 1)
        return
      }
      setChangedElsewhere(true)
    },
    () => void read(),
    canView,
  )

  /** A write of ours is on its way: its live message is ours. Returns the undo for a write that failed (no message). */
  const mine = (list: 'SYMPTOM' | 'STARTER', count = 1) => {
    echoes.current.set(list, (echoes.current.get(list) ?? 0) + count)
    return () => echoes.current.set(list, Math.max(0, (echoes.current.get(list) ?? count) - count))
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

  const putRow = (row: SymptomRow) => setData((current) => (current ? { ...current, symptoms: inOrder(current.symptoms.map((entry) => (entry.id === row.id ? row : entry))) } : current))
  const rowNow = (row: SymptomRow): SymptomRow => dataRef.current?.symptoms.find((entry) => entry.id === row.id) ?? row

  /** A cell's save: shown at once, then the answer (the row's next edit waits for this one's version). */
  const save = (row: SymptomRow, edit: Omit<SymptomEdit, 'version'>) => {
    const field = fieldOfEdit(edit)
    const before = rowNow(row)
    putRow(withEdit(before, edit))
    setMark(row.id, field, { state: 'saving' })
    const previous = queues.current.get(row.id) ?? Promise.resolve()
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const current = rowNow(row)
        const failed = mine('SYMPTOM')
        try {
          const saved = await editSymptom(api, row.id, { ...edit, version: current.version }, newIdempotencyKey())
          putRow(saved)
          setMark(row.id, field, { state: 'saved' })
          fade(row.id, field)
        } catch (error) {
          const problem = problemOf(error)
          if (!problem.unknown) failed()
          // The value as it was: never a value the server did not take (a lost answer says so: unknown).
          if (!problem.unknown) putRow(withEdit(current, reverseOf(before, edit)))
          setMark(row.id, field, { state: problem.unknown ? 'unknown' : 'refused', problem: problem.key })
        }
      })
    queues.current.set(row.id, run)
    void run.finally(() => {
      if (queues.current.get(row.id) === run) queues.current.delete(row.id)
    })
  }

  /** Several rows written one by one (the bulk switches, the moves): how many took it, and the first refusal. */
  const writeMany = async (writes: readonly { id: string; version: number; edit: Omit<SymptomEdit, 'version'> }[]) => {
    let done = 0
    let refused: string | null = null
    for (const write of writes) {
      const failed = mine('SYMPTOM')
      try {
        putRow(await editSymptom(api, write.id, { ...write.edit, version: write.version }, newIdempotencyKey()))
        done += 1
      } catch (error) {
        const problem = problemOf(error)
        if (!problem.unknown) failed()
        refused = problem.key
        break
      }
    }
    return { done, refused }
  }

  const model: PlantSettingsModel = {
    canView,
    load: canView ? load : { status: 'ready' },
    symptoms: data?.symptoms ?? null,
    classes: data?.classes ?? [],
    starterMissing: data?.starterMissing ?? [],
    canManage: data?.canManage ?? false,
    classFilter,
    marks,
    notice,
    changedElsewhere,
    busy,
    dialog,
  }

  const actions = {
    onRetry: () => {
      setLoad({ status: 'loading' })
      void read()
    },
    onReload: () => void read(),
    onClass: (filter: string) => router.replace(`${pathname}${filter === ALL ? '' : `?class=${encodeURIComponent(filter)}`}`, { scroll: false }),
    onCell: (row: SymptomRow, field: 'labelIt' | 'labelEn', value: unknown) => {
      const outcome = wordEdit(rowNow(row), field, value)
      if (!outcome) return
      if ('problem' in outcome) return setMark(row.id, field, { state: 'refused', problem: outcome.problem })
      const { version: _version, ...edit } = outcome.edit
      save(row, edit)
    },
    onIcon: (row: SymptomRow, icon: string | null) => {
      if (rowNow(row).icon !== icon) save(row, { icon })
    },
    onSwitch: (row: SymptomRow, field: 'unsafe' | 'needsDetail' | 'active', next: boolean) => save(row, { [field]: next }),
    onActiveMany: (ids: readonly string[], active: boolean) => {
      const chosen = (dataRef.current?.symptoms ?? []).filter((row) => ids.includes(row.id) && row.active !== active)
      if (chosen.length === 0) return
      setBusy(true)
      void writeMany(chosen.map((row) => ({ id: row.id, version: row.version, edit: { active } })))
        .then(({ done, refused }) => {
          const codes = chosen.slice(0, done).map((row) => row.code).join(', ')
          if (!refused) return setNotice({ tone: 'success', key: active ? 'done.on' : 'done.off', params: { count: done, codes } })
          // Stopped at the first refusal: what was done stays, the rest is read again (never shown as done).
          setNotice({ tone: 'danger', key: 'done.partly', params: { count: done, of: chosen.length } })
          void read()
        })
        .finally(() => setBusy(false))
    },
    onMove: (ids: readonly string[], delta: -1 | 1) => {
      const rows = dataRef.current?.symptoms
      if (!rows) return
      const order = moveOf(rows, ids, delta)
      if (!order) return
      const writes = orderWrites(rows, order)
      setBusy(true)
      void writeMany(writes.map((write) => ({ id: write.id, version: write.version, edit: { sortOrder: write.sortOrder } })))
        .then(({ refused }) => {
          if (refused) {
            setNotice({ tone: 'danger', key: refused })
            void read()
          }
        })
        .finally(() => setBusy(false))
    },
    onStarter: () => {
      setBusy(true)
      const failed = mine('STARTER')
      addStarter(api, newIdempotencyKey())
        .then(async (added) => {
          await read()
          setNotice({ tone: 'success', key: 'done.starter', params: { symptoms: added.symptoms.length, classes: added.classes.length } })
        })
        .catch((error: unknown) => {
          if (!problemOf(error).unknown) failed()
          setNotice({ tone: 'danger', key: problemOf(error).key })
        })
        .finally(() => setBusy(false))
    },
    onDialog: (next: SymptomDialog | null) => setDialog(next),
    onDraft: (draft: SymptomDraft) => setDialog((current) => (current?.kind === 'new' ? { ...current, draft, problem: null } : current)),
    onCreate: () => {
      const open = dialogRef.current
      if (open?.kind !== 'new') return
      setBusy(true)
      const failed = mine('SYMPTOM')
      createSymptom(api, draftBody(open.draft), newIdempotencyKey())
        .then((symptom) => {
          setData((now) => (now ? { ...now, symptoms: inOrder([...now.symptoms, symptom]), starterMissing: now.starterMissing.filter((code) => code !== symptom.code) } : now))
          setDialog(null)
          setNotice({ tone: 'success', key: 'done.created', params: { code: symptom.code } })
        })
        .catch((error: unknown) => {
          const problem = problemOf(error, 'create')
          if (!problem.unknown) failed()
          setDialog((still) => (still?.kind === 'new' ? { ...still, problem: problem.key } : still))
        })
        .finally(() => setBusy(false))
    },
    onDismissNotice: () => setNotice(null),
  }

  return <PlantSettingsView model={model} actions={actions} />
}
