'use client'

import { useCallback, useEffect, useState } from 'react'
import type { RegulationKind } from '@nexus/factory-domain/compliance/register-of-rules/rules'
import { newIdempotencyKey } from '../../../lib/api/client'
import { assessChange, closeChange, createEntry, deleteEntry, editEntry, openImpactTask, readChange, readChanges, readEntries, readEntry, recordChange, type Change, type EntriesAnswer } from './api'
import { EMPTY_ASSESS, EMPTY_CHANGE, EMPTY_ENTRY, entryCellProblem, REGULATION_KINDS, valueOf } from './model'
import { each, useMarks, useRead, writingOf, type TabContext } from './use-settings'
import { IDLE, type ChangeWindowState, type EntryWindowState, type RegsActions, type RegsState } from './view-model'

/**
 * Regulations & standards (rm-regs): the register with its filters from the address, the change watch (open or all), the cells
 * autosaved one by one, New entry, the entry's window (`?open=<id>`: move, record a change, delete) and the change's window
 * (`?change=<id>`: assess, open the impact task, close); Close N over the assessed changes chosen.
 */
export function useRegs(context: TabContext): { state: RegsState; actions: RegsActions } {
  const { api, active, can, address, go, notify, stamp, tick, locale } = context
  const [entries, loadEntries, setEntries] = useRead<EntriesAnswer>()
  const [changes, loadChanges] = useRead<Change[]>()
  const [marks, setMark, saveCell] = useMarks()
  const [selected, setSelected] = useState<string[]>([])
  const [add, setAdd] = useState<RegsState['add']>(null)
  const [entry, setEntry] = useState<EntryWindowState | null>(null)
  const [change, setChange] = useState<ChangeWindowState | null>(null)
  const kind = address.kind && (REGULATION_KINDS as readonly string[]).includes(address.kind) ? (address.kind as RegulationKind) : null
  const { status, q, watch } = address

  const readList = useCallback((quiet = false) => (can.view ? loadEntries(() => readEntries(api, { kind, status, q }), quiet).then((value) => value && stamp()) : Promise.resolve()), [api, can.view, kind, status, q, loadEntries, stamp])
  const readWatch = useCallback((quiet = false) => (can.view ? loadChanges(() => readChanges(api, watch === 'open'), quiet) : Promise.resolve(null)), [api, can.view, watch, loadChanges])
  useEffect(() => {
    if (active) void readList()
  }, [active, readList])
  useEffect(() => {
    if (active) void readWatch()
  }, [active, readWatch])
  useEffect(() => {
    if (active && tick > 0) {
      void readList(true)
      void readWatch(true)
    }
  }, [tick])

  // The entry's window follows `?open=`.
  const openEntry = useCallback(
    (id: string) => {
      readEntry(api, id).then(
        (value) => setEntry((current) => (current && current.id === id ? { ...current, read: { status: 'ready', value } } : current)),
        (error) => setEntry((current) => (current && current.id === id ? { ...current, read: { status: 'error', problem: writingOf(error).problem?.key === 'problem.notFound' ? 'problem.notFound' : 'problem.read' } } : current)),
      )
    },
    [api],
  )
  useEffect(() => {
    if (!active || !address.open) return setEntry(null)
    const id = address.open
    setEntry((current) => (current && current.id === id ? current : { id, read: { status: 'loading' }, mode: 'view', move: { status: 'SUPERSEDED', supersededById: null, reason: '', transitionEndsOn: null }, change: EMPTY_CHANGE, writing: IDLE, saved: null }))
    openEntry(id)
  }, [active, address.open, openEntry])

  // The change's window follows `?change=`.
  const openChange = useCallback(
    (id: string) => {
      readChange(api, id).then(
        (value) => setChange((current) => (current && current.id === id ? { ...current, read: { status: 'ready', value } } : current)),
        () => setChange((current) => (current && current.id === id ? { ...current, read: { status: 'error', problem: 'problem.read' } } : current)),
      )
    },
    [api],
  )
  useEffect(() => {
    if (!active || !address.change) return setChange(null)
    const id = address.change
    setChange((current) => (current && current.id === id ? current : { id, read: { status: 'loading' }, assess: EMPTY_ASSESS, writing: IDLE, saved: null }))
    openChange(id)
  }, [active, address.change, openChange])

  useEffect(() => {
    if (!active || !address.add || !can.rulesManage) return setAdd(null)
    setAdd((current) => current ?? { draft: EMPTY_ENTRY, writing: IDLE })
  }, [active, address.add, can.rulesManage])

  const rereadAll = () => {
    void readList(true)
    void readWatch(true)
  }
  const busyEntry = () => setEntry((current) => (current ? { ...current, writing: { busy: true, problem: null }, saved: null } : current))
  const failEntry = (error: unknown, kind: 'edit' | 'delete' = 'edit') => setEntry((current) => (current ? { ...current, writing: writingOf(error, kind) } : current))
  const record = entry ? valueOf(entry.read) : null
  const busyChange = () => setChange((current) => (current ? { ...current, writing: { busy: true, problem: null }, saved: null } : current))
  const doneChange = (value: Change, key: string) => {
    setChange((current) => (current ? { ...current, read: { status: 'ready', value }, writing: IDLE, saved: { tone: 'success', key } } : current))
    rereadAll()
  }
  const failChange = (error: unknown) => setChange((current) => (current ? { ...current, writing: writingOf(error) } : current))
  const changeValue = change ? valueOf(change.read) : null

  return {
    state: { entries, changes, marks, selected, add, entry, change },
    actions: {
      onCell: (id, field, value) => {
        const row = valueOf(entries)?.entries.find((item) => item.id === id)
        if (!row) return
        const text = value.trim()
        if (text === (row[field] ?? '')) return
        const problem = entryCellProblem(field, text)
        if (problem) return setMark(id, field, { state: 'refused', problem })
        void saveCell(id, field, async () => {
          const answer = await editEntry(api, id, { version: row.version, [field]: field === 'title' ? text : text || null }, newIdempotencyKey())
          setEntries((current) => (current.status === 'ready' ? { status: 'ready', value: { ...current.value, entries: current.value.entries.map((item) => (item.id === id ? answer.entry : item)) } } : current))
          return answer
        })
      },
      onSelected: setSelected,
      onAddDraft: (draft) => setAdd((current) => (current ? { draft, writing: IDLE } : current)),
      onAddSave: () => {
        if (!add) return
        setAdd({ ...add, writing: { busy: true, problem: null } })
        const draft = add.draft
        createEntry(api, { code: draft.code.trim(), edition: draft.edition.trim() || null, title: draft.title.trim(), kind: draft.kind!, ojReference: draft.ojReference.trim() || null, ojDate: draft.ojDate, link: draft.link.trim() || null, status: draft.status }, newIdempotencyKey()).then(
          (created) => {
            notify({ tone: 'success', key: 'notice.entryAdded', params: { label: created.label } })
            setAdd(null)
            void readList(true)
            go({ add: false })
          },
          (error) => setAdd((current) => (current ? { ...current, writing: writingOf(error, 'create') } : current)),
        )
      },
      onEntryMode: (mode) => setEntry((current) => (current ? { ...current, mode, writing: IDLE, saved: null } : current)),
      onMove: (move) => setEntry((current) => (current ? { ...current, move, writing: IDLE } : current)),
      onMoveSave: () => {
        if (!entry || !record) return
        busyEntry()
        const move = entry.move
        editEntry(api, entry.id, { version: record.entry.version, status: move.status, ...(move.status === 'SUPERSEDED' ? { supersededById: move.supersededById } : { supersededById: null }), ...(move.status !== 'IN_FORCE' ? { reason: move.reason.trim(), transitionEndsOn: move.transitionEndsOn } : {}) }, newIdempotencyKey()).then(
          (answer) => {
            setEntry((current) => (current ? { ...current, mode: 'view', writing: IDLE, saved: answer.raised ? { tone: 'success', key: 'saved.moveRaised', params: { count: answer.raised.certificates.length } } : { tone: 'success', key: 'saved.moved' } } : current))
            openEntry(entry.id)
            rereadAll()
          },
          (error) => failEntry(error),
        )
      },
      onChangeDraft: (draft) => setEntry((current) => (current ? { ...current, change: draft, writing: IDLE } : current)),
      onChangeSave: () => {
        if (!entry) return
        busyEntry()
        const draft = entry.change
        recordChange(api, entry.id, { kind: draft.kind, whatChanged: draft.whatChanged.trim(), sourceReference: draft.sourceReference.trim() || null, transitionEndsOn: draft.transitionEndsOn, newStandardId: draft.newStandardId }, newIdempotencyKey()).then(
          () => {
            setEntry((current) => (current ? { ...current, mode: 'view', change: EMPTY_CHANGE, writing: IDLE, saved: { tone: 'success', key: 'saved.changeRecorded' } } : current))
            openEntry(entry.id)
            rereadAll()
          },
          (error) => failEntry(error),
        )
      },
      onDelete: () => {
        if (!entry || !record) return
        busyEntry()
        deleteEntry(api, entry.id, record.entry.version, newIdempotencyKey()).then(() => {
          notify({ tone: 'success', key: 'notice.entryDeleted', params: { label: record.entry.label } })
          go({ open: null })
          void readList(true)
        }, (error) => failEntry(error, 'delete'))
      },
      onAssess: (assess) => setChange((current) => (current ? { ...current, assess, writing: IDLE } : current)),
      onAssessSave: () => {
        if (!change || !changeValue || !change.assess.impact) return
        busyChange()
        assessChange(api, change.id, { version: changeValue.version, impact: change.assess.impact, assessment: change.assess.assessment.trim(), reviewCertificateIds: [...change.assess.reviewCertificateIds] }, newIdempotencyKey()).then((value) => doneChange(value, value.reviews.length > 0 ? 'saved.assessedReviews' : 'saved.assessed'), failChange)
      },
      onTask: () => {
        if (!change || !changeValue) return
        busyChange()
        openImpactTask(api, change.id, { version: changeValue.version, language: locale }, newIdempotencyKey()).then((value) => doneChange(value, 'saved.taskOpened'), failChange)
      },
      onClose: () => {
        if (!change || !changeValue) return
        busyChange()
        closeChange(api, change.id, changeValue.version, newIdempotencyKey()).then((value) => doneChange(value, 'saved.closed'), failChange)
      },
      onCloseMany: (ids) => {
        const rows = (valueOf(changes) ?? []).filter((row) => ids.includes(row.id))
        void each(rows, (row) => closeChange(api, row.id, row.version, newIdempotencyKey())).then((result) => {
          setSelected([])
          notify(result.refused.length > 0 ? { tone: 'warning', key: 'notice.closedPartly', params: { done: result.done, refused: result.refused.length } } : { tone: 'success', key: 'notice.closedMany', params: { count: result.done } })
          rereadAll()
        })
      },
      onRetry: rereadAll,
      onRetryOpen: () => {
        if (entry) {
          setEntry({ ...entry, read: { status: 'loading' } })
          openEntry(entry.id)
        }
        if (change) {
          setChange({ ...change, read: { status: 'loading' } })
          openChange(change.id)
        }
      },
    },
  }
}
