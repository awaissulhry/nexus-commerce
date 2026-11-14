'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useLiveBus } from '../../../shell/live/use-live'
import {
  addValue,
  createField,
  createPicklist,
  editField,
  editPicklist,
  editValue,
  orderFields,
  orderValues,
  readEditor,
  type Editor,
  type EditorField,
  type Field,
  type FieldChange,
  type ListValue,
  type Picklist,
  type ValueChange,
} from './api'
import {
  addressOf,
  draftOfField,
  faultOf,
  fieldChangeOf,
  fieldsQuery,
  grainsOf,
  labelIn,
  markKey,
  moveOf,
  newDraft,
  newFieldBody,
  newListDraft,
  newValueBody,
  newValueDraft,
  readFaultOf,
  shownList,
  valueMoveOf,
  type FieldsAddress,
  type Mark,
} from './model'
import { FieldsView, type FieldCell, type FieldsDialogState, type FieldsViewModel } from './view/FieldsView'

const SAVED_FADE_MS = 1500
const LIVE_PAUSE_MS = 400

/**
 * `/w/<company>/admin/fields` (SCR-164) through the API client: GET /fields/editor for the record type in the address
 * (fields.view), every write of B-W2b-421's routes with its Idempotency-Key and the version read — Add field (POST
 * /fields), a field's dialog and the grid's cells (PATCH /fields/:id: labels, required, portal; archive and restore), the
 * section's order (POST /fields/order), and the lists (POST/PATCH /fields/picklists…, their values and order). A cell saves
 * by itself with its mark; one row's edits wait for each other so the next carries the version the last one left. Live
 * custom_field.changed and picklist.changed (someone else, or this tab's own) read the editor again, quietly.
 */
export function FieldsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const search = useSearchParams()
  const address = addressOf(search)
  const addressRef = useRef(address)
  addressRef.current = address
  const allowed = session.permissions.includes('fields.view')
  const grains = useMemo(() => [...grainsOf(session.permissions)], [session.permissions])
  const companies = useMemo(() => session.companies.map((company) => ({ id: company.id, name: company.name })), [session.companies])

  const [editor, setEditor] = useState<Editor | null>(null)
  const [load, setLoad] = useState<FieldsViewModel['load']>({ status: 'loading' })
  const [readAt, setReadAt] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [marks, setMarks] = useState<Record<string, Mark>>({})
  const [notice, setNotice] = useState<FieldsViewModel['notice']>(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<FieldsDialogState | null>(null)
  const editorRef = useRef<Editor | null>(null)
  editorRef.current = editor
  const dialogRef = useRef<FieldsDialogState | null>(null)
  dialogRef.current = dialog
  const queues = useRef(new Map<string, Promise<unknown>>())
  const reading = useRef(0)

  const go = useCallback((next: Partial<FieldsAddress>) => router.replace(`${pathname}${fieldsQuery({ ...addressRef.current, ...next })}`, { scroll: false }), [router, pathname])

  const read = useCallback(
    async (quiet = false) => {
      if (!allowed) return
      const ticket = ++reading.current
      if (!quiet) setLoad({ status: 'loading' })
      try {
        const answer = await readEditor(api, addressRef.current.type)
        if (ticket !== reading.current) return
        setEditor(answer)
        setLoad({ status: 'ready' })
        setReadAt(new Date().toISOString())
        setNow(Date.now())
      } catch (error) {
        if (ticket !== reading.current) return
        if (!quiet || !editorRef.current) setLoad({ status: 'error', fault: readFaultOf(error) })
      }
    },
    [api, allowed],
  )

  useEffect(() => {
    void read()
  }, [read, address.type])

  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readSoon = () => {
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(() => {
      pending.current = null
      void read(true)
    }, LIVE_PAUSE_MS)
  }
  const live = useLiveBus(
    {
      onChange: (change) => {
        if (change.type === 'custom_field.changed' || change.type === 'picklist.changed') readSoon()
      },
      onReconnect: readSoon,
    },
    allowed,
  )

  // The address's field (`?field=<id>|new`) opens its dialog once the editor is read.
  useEffect(() => {
    if (!editor || load.status !== 'ready') return
    const wanted = address.field
    const open = dialogRef.current
    if (!wanted) return
    if (open?.kind === 'field' && (open.fieldId ?? 'new') === wanted) return
    if (wanted === 'new') {
      if (editor.canManage) setDialog({ kind: 'field', mode: 'new', fieldId: null, draft: newDraft(editor.fields.find((field) => field.status === 'ACTIVE')?.section ?? 'custom'), fault: null })
      return
    }
    const field = editor.fields.find((entry) => entry.id === wanted)
    if (field) setDialog({ kind: 'field', mode: 'edit', fieldId: field.id, draft: draftOfField(field), fault: null })
    else setNotice({ key: 'fault.fieldElsewhere', tone: 'info' })
  }, [editor, load.status, address.field])

  // ── local edits of what was read ──────────────────────────────────────────────────────────────────────────────────
  const putField = (field: Field) =>
    setEditor((current) => (current ? { ...current, fields: current.fields.map((entry) => (entry.id === field.id ? { ...entry, ...field } : entry)) } : current))
  const putList = (list: Picklist) =>
    setEditor((current) =>
      current
        ? {
            ...current,
            picklists: current.picklists.some((entry) => entry.id === list.id) ? current.picklists.map((entry) => (entry.id === list.id ? list : entry)) : [...current.picklists, list],
            fields: current.fields.map((field) => (field.picklist?.id === list.id ? { ...field, picklist: { id: list.id, code: list.code, labelIt: list.labelIt, labelEn: list.labelEn, values: list.values } } : field)),
          }
        : current,
    )
  const fieldNow = (id: string): EditorField | undefined => editorRef.current?.fields.find((field) => field.id === id)
  const listNow = (id: string): Picklist | undefined => editorRef.current?.picklists.find((list) => list.id === id)

  const setMark = (id: string, cell: string, mark: Mark | null) =>
    setMarks((current) => {
      const next = { ...current }
      if (mark) next[markKey(id, cell)] = mark
      else delete next[markKey(id, cell)]
      return next
    })
  const fade = (id: string, cell: string) =>
    setTimeout(() => setMarks((current) => (current[markKey(id, cell)]?.state === 'saved' ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== markKey(id, cell))) : current)), SAVED_FADE_MS)

  /** One row's writes in order: each waits for the last, so it carries the version the last one left. */
  const queued = <T,>(id: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.current.get(id) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(work)
    queues.current.set(id, run.catch(() => undefined))
    return run
  }

  // ── fields ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const onCell = (field: EditorField, cell: FieldCell, value: string | boolean) => {
    if (typeof value === 'string' && value.trim() === '') {
      setMark(field.id, cell, { state: 'refused', fault: cell === 'labelIt' ? 'wait.labelIt' : 'wait.labelEn' })
      return
    }
    const before = fieldNow(field.id) ?? field
    if (typeof value === 'string' && value.trim() === before[cell as 'labelIt' | 'labelEn']) return
    putField({ ...before, [cell]: typeof value === 'string' ? value.trim() : value })
    setMark(field.id, cell, { state: 'saving' })
    void queued(field.id, async () => {
      const current = fieldNow(field.id) ?? before
      try {
        const saved = await editField(api, field.id, { version: current.version, [cell]: typeof value === 'string' ? value.trim() : value } as FieldChange, newIdempotencyKey())
        putField(saved)
        setMark(field.id, cell, { state: 'saved' })
        fade(field.id, cell)
      } catch (error) {
        const fault = faultOf(error)
        if (!fault.unknown) putField({ ...current, [cell]: before[cell] })
        setMark(field.id, cell, fault.unknown ? { state: 'unknown', fault: fault.key } : { state: 'refused', fault: fault.key })
      }
    })
  }

  const closeDialog = () => {
    setDialog(null)
    if (addressRef.current.field) go({ field: null })
  }

  const saveField = async () => {
    const open = dialogRef.current
    const current = editorRef.current
    if (open?.kind !== 'field' || !current) return
    setBusy(true)
    try {
      if (open.mode === 'new') {
        const field = await createField(api, newFieldBody(current.recordType, open.draft), newIdempotencyKey())
        closeDialog()
        // The row and the preview first, then the notice that names it.
        await read(true)
        setNotice({ key: 'done.added', tone: 'success', params: { field: labelIn(field, locale) } })
      } else {
        const field = fieldNow(open.fieldId ?? '')
        const change = field ? fieldChangeOf(field, open.draft) : null
        if (!field || !change) return closeDialog()
        const saved = await editField(api, field.id, change, newIdempotencyKey())
        putField(saved)
        setNotice({ key: 'done.saved', tone: 'success', params: { field: labelIn(saved, locale) } })
        closeDialog()
      }
    } catch (error) {
      setDialog((now) => (now?.kind === 'field' ? { ...now, fault: faultOf(error).key } : now))
    } finally {
      setBusy(false)
    }
  }

  const fieldState = async (status: 'ACTIVE' | 'ARCHIVED') => {
    const open = dialogRef.current
    const field = open?.kind === 'field' && open.fieldId ? fieldNow(open.fieldId) : undefined
    if (!field) return
    setBusy(true)
    try {
      const saved = await editField(api, field.id, { version: field.version, status }, newIdempotencyKey())
      putField(saved)
      setNotice({ key: status === 'ARCHIVED' ? 'done.archived' : 'done.restored', tone: 'success', params: { field: labelIn(saved, locale) } })
      closeDialog()
    } catch (error) {
      setDialog((now) => (now?.kind === 'field' ? { ...now, fault: faultOf(error).key } : now))
    } finally {
      setBusy(false)
    }
  }

  const stateMany = async (ids: readonly string[], status: 'ACTIVE' | 'ARCHIVED') => {
    const targets = ids.map(fieldNow).filter((field): field is EditorField => !!field && field.status !== status)
    if (targets.length === 0) return
    setBusy(true)
    let done = 0
    let fault: string | null = null
    for (const field of targets) {
      try {
        putField(await editField(api, field.id, { version: field.version, status }, newIdempotencyKey()))
        done += 1
      } catch (error) {
        fault = fault ?? faultOf(error).key
      }
    }
    setBusy(false)
    setNotice(
      fault
        ? { key: 'done.partly', tone: 'warning', params: { done, total: targets.length } }
        : { key: status === 'ARCHIVED' ? 'done.archivedMany' : 'done.restoredMany', tone: 'success', params: { count: done } },
    )
  }

  const moveFields = async (ids: readonly string[], delta: -1 | 1) => {
    const current = editorRef.current
    if (!current) return
    const move = moveOf(current.fields, ids, delta)
    if (!move) return
    setBusy(true)
    try {
      const fields = await orderFields(api, { recordType: current.recordType, section: move.section, fields: move.fields }, newIdempotencyKey())
      for (const field of fields) putField(field)
    } catch (error) {
      setNotice({ key: faultOf(error).key, tone: 'danger' })
      void read(true)
    } finally {
      setBusy(false)
    }
  }

  // ── lists ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const shown = (): Picklist | null => (editorRef.current ? shownList(editorRef.current.picklists, addressRef.current.list) : null)

  const listWrite = async (work: () => Promise<Picklist>, done: string | null, params: Record<string, string | number> = {}) => {
    setBusy(true)
    try {
      const list = await work()
      putList(list)
      if (done) setNotice({ key: done, tone: 'success', params: { list: labelIn(list, locale), ...params } })
      return list
    } catch (error) {
      const fault = faultOf(error).key
      setDialog((now) => (now && 'fault' in now ? { ...now, fault } : now))
      if (!dialogRef.current || !('fault' in dialogRef.current)) setNotice({ key: fault, tone: 'danger' })
      return null
    } finally {
      setBusy(false)
    }
  }

  const valueCell = (list: Picklist, value: ListValue, cell: 'labelIt' | 'labelEn' | 'description' | 'active' | 'look', change: Omit<ValueChange, 'version'>) => {
    setMark(value.id, cell, { state: 'saving' })
    void queued(value.id, async () => {
      const currentList = listNow(list.id) ?? list
      const current = currentList.values.find((entry) => entry.id === value.id) ?? value
      try {
        putList(await editValue(api, list.id, value.id, { version: current.version, ...change }, newIdempotencyKey()))
        setMark(value.id, cell, { state: 'saved' })
        fade(value.id, cell)
      } catch (error) {
        const fault = faultOf(error)
        setMark(value.id, cell, fault.unknown ? { state: 'unknown', fault: fault.key } : { state: 'refused', fault: fault.key })
      }
    })
  }

  const valuesActive = async (ids: readonly string[], active: boolean) => {
    const list = shown()
    if (!list) return
    const targets = list.values.filter((value) => ids.includes(value.id) && value.active !== active)
    setBusy(true)
    let done = 0
    let fault: string | null = null
    for (const value of targets) {
      const current = (listNow(list.id) ?? list).values.find((entry) => entry.id === value.id) ?? value
      try {
        putList(await editValue(api, list.id, value.id, { version: current.version, active }, newIdempotencyKey()))
        done += 1
      } catch (error) {
        fault = fault ?? faultOf(error).key
      }
    }
    setBusy(false)
    setNotice(fault ? { key: 'done.partly', tone: 'warning', params: { done, total: targets.length } } : { key: active ? 'done.valuesOn' : 'done.valuesOff', tone: 'success', params: { count: done } })
  }

  const model: FieldsViewModel = {
    access: allowed ? 'open' : 'refused',
    load,
    editor,
    recordType: address.type ?? editor?.recordType ?? null,
    tab: address.tab,
    archived: address.archived,
    listId: address.list,
    readAt,
    now,
    live,
    grains,
    companies,
    marks,
    notice,
    busy,
    dialog,
  }

  return (
    <FieldsView
      model={model}
      actions={{
        onType: (type) => {
          setNotice(null)
          go({ type, field: null })
        },
        onTab: (tab) => go({ tab, field: null }),
        onArchived: (archived) => go({ archived }),
        onRetry: () => void read(),
        onDialog: (next) => {
          if (next === null) return closeDialog()
          if (next.kind === 'field' && dialogRef.current?.kind !== 'field') {
            setNotice(null)
            go({ field: next.fieldId ?? 'new' })
          }
          setDialog(next)
        },
        onCell,
        onStateMany: (ids, status) => void stateMany(ids, status),
        onMoveFields: (ids, delta) => void moveFields(ids, delta),
        onDismissNotice: () => setNotice(null),
        field: {
          onSave: () => void saveField(),
          onState: (status) => void fieldState(status),
          onPicklists: () => {
            setDialog(null)
            go({ tab: 'picklists', field: null })
          },
        },
        lists: {
          onList: (id) => go({ list: id }),
          onNewList: () => setDialog({ kind: 'list', draft: newListDraft(), fault: null }),
          onListDraft: (draft) => setDialog((now) => (now?.kind === 'list' ? { ...now, draft } : now)),
          onCreateList: () => {
            const open = dialogRef.current
            if (open?.kind !== 'list') return
            void listWrite(() => createPicklist(api, { companyId: open.draft.companyId, code: open.draft.code, labelIt: open.draft.labelIt.trim(), labelEn: open.draft.labelEn.trim() }, newIdempotencyKey()), 'done.listAdded').then((list) => {
              if (!list) return
              setDialog(null)
              go({ tab: 'picklists', list: list.id })
            })
          },
          onRenameList: () => {
            const list = shown()
            if (list) setDialog({ kind: 'rename', listId: list.id, labelIt: list.labelIt, labelEn: list.labelEn, fault: null })
          },
          onRenameDraft: (labels) => setDialog((now) => (now?.kind === 'rename' ? { ...now, ...labels } : now)),
          onSaveRename: () => {
            const open = dialogRef.current
            const list = open?.kind === 'rename' ? listNow(open.listId) : undefined
            if (open?.kind !== 'rename' || !list) return
            void listWrite(() => editPicklist(api, list.id, { version: list.version, labelIt: open.labelIt.trim(), labelEn: open.labelEn.trim() }, newIdempotencyKey()), 'done.listRenamed').then((saved) => saved && setDialog(null))
          },
          onListState: (status) => {
            const list = shown()
            if (list) void listWrite(() => editPicklist(api, list.id, { version: list.version, status }, newIdempotencyKey()), status === 'ARCHIVED' ? 'done.listArchived' : 'done.listRestored')
          },
          onNewValue: () => {
            const list = shown()
            if (list && list.status === 'ACTIVE') setDialog({ kind: 'value', listId: list.id, draft: newValueDraft(), fault: null })
          },
          onValueDraft: (draft) => setDialog((now) => (now?.kind === 'value' ? { ...now, draft } : now)),
          onCreateValue: () => {
            const open = dialogRef.current
            if (open?.kind !== 'value') return
            void listWrite(() => addValue(api, open.listId, newValueBody(open.draft), newIdempotencyKey()), 'done.valueAdded', { value: open.draft.code }).then((list) => list && setDialog(null))
          },
          onLook: (value) => {
            const list = shown()
            if (list) setDialog({ kind: 'look', listId: list.id, valueId: value.id })
          },
          onLookChange: (value, change) => {
            const list = shown()
            if (list) valueCell(list, value, 'look', change)
          },
          onValueCell: (value, cell, text) => {
            const list = shown()
            if (!list) return
            const words = text.trim()
            if (cell !== 'description' && words === '') return setMark(value.id, cell, { state: 'refused', fault: cell === 'labelIt' ? 'wait.labelIt' : 'wait.labelEn' })
            if (words === (cell === 'description' ? (value.description ?? '') : value[cell])) return
            valueCell(list, value, cell, cell === 'description' ? { description: words === '' ? null : words } : { [cell]: words })
          },
          onValueActive: (value, active) => {
            const list = shown()
            if (list) valueCell(list, value, 'active', { active })
          },
          onValuesActive: (ids, active) => void valuesActive(ids, active),
          onMoveValues: (ids, delta) => {
            const list = shown()
            const order = list ? valueMoveOf(list.values, ids, delta) : null
            if (list && order) void listWrite(() => orderValues(api, list.id, order, newIdempotencyKey()), null)
          },
        },
      }}
    />
  )
}
