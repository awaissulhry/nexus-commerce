'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useCoalesced } from '../../../_shared/buying/hooks'
import { phrase, type Loaded } from '../../../_shared/buying/model'
import { convertPlanned, decideActionMessages, editPlanned, firmPlanned, getDelays, getItemProfile, getRunLog, listActionMessages, listPlannedOrders, resetPlanned, shiftPlanned, type ActionMessages, type Delays, type ItemProfile, type PlannedList, type PlannedOrder, type ProtectableField, type RunLog } from './api'
import { convertReach, depthCan, type DepthActions, type DepthDialog, type DepthModel, type DepthNotice } from './model'

/** The events that change what the W2b parts show (B-W2b-293, B-W2b-306): read them again, quietly. */
const DEPTH_EVENTS = ['planned_work_orders.planned', 'planned_work_order.converted', 'planned_work_order.firmed', 'planned_work_orders.edited', 'mrp_action_messages.raised', 'mrp_action_messages.decided', 'material_requirement.pegged']

/** A failed read in this part's words (a key of planning-mrp-depth); a failed read is never drawn as empty. */
function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.noRead'
  if (error.kind === 'unavailable') return 'problem.offline'
  if (error.kind === 'not_found') return 'problem.gone'
  if (error.kind === 'signed_out') return 'problem.signedOut'
  return 'problem.read'
}

/** A refused write in this part's words (a key of planning-mrp-depth): a changed row, no right, a refusal, no answer. */
function writeWords(error: unknown): string {
  if (!isApiError(error)) return 'problem.write'
  if (error.kind === 'conflict') return 'problem.changed'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.forbidden'
  if (error.kind === 'invalid') return 'problem.invalid'
  if (error.kind === 'not_found') return 'problem.gone'
  if (error.kind === 'unavailable') return 'problem.unknown'
  return 'problem.write'
}

export interface DepthHost {
  api: ApiClient
  siteId: string | null
  /** The latest run shown: a new one reads the W2b parts again. */
  runId: string | null
  permissions: readonly string[]
  enabled: boolean
  built: ReadonlySet<string>
  /** `?profile=` (the requirement line whose material's projected stock is open). */
  profileLine: string | null
  setProfileLine: (lineId: string | null) => void
  /** The material of a plan line (the profile reads it). */
  materialOf: (lineId: string) => { itemId: string; itemColourId: string | null } | null
  /** The plan changed through a W2b write (a conversion covers demand): read it again. */
  onPlanChanged: () => void
}

/**
 * The W2b parts' container (B-W2b-335): the site's planned orders, the latest plan's action messages and the calculated
 * delays, read beside the plan and again after a run or a W2b event; the conversion and the bulk move each reviewed first
 * (`preview`), the dates edit (each changed field protected), Reset to plan, Firm / Plan again, Done / Ignore, the run log
 * of a run and the projected stock of a material (`?profile=`). Each write carries the version read.
 */
export function useDepth(host: DepthHost): { model: DepthModel; actions: DepthActions; onLive: (type: string, siteId: unknown) => void } {
  const { api, siteId, runId, enabled } = host
  const can = useMemo(() => depthCan(host.permissions), [host.permissions])
  const [planned, setPlanned] = useState<Loaded<PlannedList> | null>(null)
  const [messages, setMessages] = useState<Loaded<ActionMessages> | null>(null)
  const [allMessages, setAllMessages] = useState(false)
  const [delays, setDelays] = useState<Delays | null>(null)
  const [dialog, setDialog] = useState<DepthDialog | null>(null)
  const [notice, setNotice] = useState<DepthNotice | null>(null)
  const [busy, setBusy] = useState<string[]>([])
  const [log, setLog] = useState<{ runId: string; log: Loaded<RunLog> } | null>(null)
  const [profile, setProfile] = useState<{ lineId: string; profile: Loaded<ItemProfile> } | null>(null)
  const readId = useRef(0)
  const shiftRead = useRef(0)
  const plannedRef = useRef<PlannedOrder[]>([])
  const latest = useRef(host)
  latest.current = host

  const read = useCallback(async () => {
    if (!enabled || !siteId) return
    const id = ++readId.current
    const [plannedAnswer, messagesAnswer, delaysAnswer] = await Promise.allSettled([listPlannedOrders(api, siteId), listActionMessages(api, siteId, allMessages), getDelays(api, siteId)])
    if (id !== readId.current) return
    if (plannedAnswer.status === 'fulfilled') {
      plannedRef.current = plannedAnswer.value.plannedOrders
      setPlanned({ status: 'ready', value: plannedAnswer.value })
    } else setPlanned({ status: 'error', problem: readProblem(plannedAnswer.reason) })
    setMessages(messagesAnswer.status === 'fulfilled' ? { status: 'ready', value: messagesAnswer.value } : { status: 'error', problem: readProblem(messagesAnswer.reason) })
    setDelays(delaysAnswer.status === 'fulfilled' ? delaysAnswer.value : null)
  }, [api, siteId, enabled, allMessages])

  useEffect(() => {
    if (!enabled || !siteId) return
    setPlanned((current) => current ?? { status: 'loading' })
    setMessages((current) => current ?? { status: 'loading' })
    void read()
  }, [read, enabled, siteId, runId])

  const reread = useCoalesced(() => void read(), 800)
  const onLive = useCallback(
    (type: string, changeSite: unknown) => {
      if (!DEPTH_EVENTS.includes(type)) return
      if (changeSite !== undefined && changeSite !== siteId) return
      reread()
    },
    [reread, siteId],
  )

  // "Projected stock — <material>": `?profile=` reads the line's material at the site.
  const loadProfile = useCallback(
    (lineId: string) => {
      const material = latest.current.materialOf(lineId)
      if (!siteId || !material) {
        setProfile({ lineId, profile: { status: 'not_found' } })
        return () => undefined
      }
      let gone = false
      setProfile({ lineId, profile: { status: 'loading' } })
      getItemProfile(api, { siteId, itemId: material.itemId, itemColourId: material.itemColourId })
        .then((value) => !gone && setProfile({ lineId, profile: { status: 'ready', value } }))
        .catch((error: unknown) => !gone && setProfile({ lineId, profile: isApiError(error) && error.kind === 'not_found' ? { status: 'not_found' } : { status: 'error', problem: readProblem(error) } }))
      return () => {
        gone = true
      }
    },
    [api, siteId],
  )
  useEffect(() => {
    if (!host.profileLine) {
      setProfile(null)
      return
    }
    return loadProfile(host.profileLine)
  }, [host.profileLine, loadProfile])

  const rowsOf = (ids: readonly string[]) => plannedRef.current.filter((row) => ids.includes(row.id))
  const refs = (rows: readonly PlannedOrder[]) => rows.map((row) => ({ id: row.id, version: row.version }))
  const afterWrite = (planChanged = false) => {
    void read()
    if (planChanged) latest.current.onPlanChanged()
  }
  const one = async (rowId: string, run: () => Promise<DepthNotice>) => {
    setBusy((current) => [...current, rowId])
    setNotice(null)
    try {
      setNotice(await run())
    } catch (error) {
      setNotice({ tone: 'danger', words: phrase(writeWords(error)) })
    } finally {
      setBusy((current) => current.filter((id) => id !== rowId))
      afterWrite()
    }
  }

  const previewShift = useCallback(
    async (rows: PlannedOrder[], days: number) => {
      if (!siteId) return
      const id = ++shiftRead.current
      setDialog({ kind: 'shift', shift: { rows, days, phase: 'reading', preview: null, done: null, problem: null } })
      try {
        const preview = await shiftPlanned(api, siteId, refs(rows), days, true)
        if (id === shiftRead.current) setDialog({ kind: 'shift', shift: { rows, days, phase: 'ready', preview, done: null, problem: null } })
      } catch (error) {
        if (id === shiftRead.current) setDialog({ kind: 'shift', shift: { rows, days, phase: 'failed', preview: null, done: null, problem: isApiError(error) && error.kind === 'invalid' ? 'shift.refused' : readProblem(error) } })
      }
    },
    [api, siteId],
  )

  const actions: DepthActions = {
    onRetry: () => {
      setPlanned({ status: 'loading' })
      setMessages({ status: 'loading' })
      void read()
    },
    onConvert: (kind, rowIds) => {
      const reach = convertReach(rowsOf(rowIds))
      const rows = kind === 'MAKE' ? reach.make : reach.subcontract
      if (rows.length === 0) return
      setDialog({ kind: 'convert', convert: { kind, rows, phase: 'reading', preview: null, done: null, problem: null } })
      convertPlanned(api, refs(rows), true)
        .then((preview) => setDialog((current) => (current?.kind === 'convert' ? { kind: 'convert', convert: { ...current.convert, phase: 'ready', preview } } : current)))
        .catch((error: unknown) => setDialog((current) => (current?.kind === 'convert' ? { kind: 'convert', convert: { ...current.convert, phase: 'failed', problem: readProblem(error) } } : current)))
    },
    onConvertSave: () => {
      if (dialog?.kind !== 'convert' || dialog.convert.phase !== 'ready') return
      const convert = dialog.convert
      const ready = new Set((convert.preview?.results ?? []).filter((result) => result.ok).map((result) => result.id))
      const rows = convert.rows.filter((row) => ready.has(row.id))
      if (rows.length === 0) return
      setDialog({ kind: 'convert', convert: { ...convert, phase: 'saving' } })
      convertPlanned(api, refs(rows), false, newIdempotencyKey())
        .then((done) => {
          setDialog((current) => (current?.kind === 'convert' ? { kind: 'convert', convert: { ...current.convert, phase: 'done', done } } : current))
          afterWrite(true)
        })
        .catch((error: unknown) => {
          setDialog((current) => (current?.kind === 'convert' ? { kind: 'convert', convert: { ...current.convert, phase: 'ready', problem: writeWords(error) } } : current))
          afterWrite()
        })
    },
    onShift: (rowIds) => {
      const rows = rowsOf(rowIds).filter((row) => row.status === 'PLANNED')
      if (rows.length > 0) void previewShift(rows, 1)
    },
    onShiftDays: (days) => {
      if (dialog?.kind !== 'shift' || !Number.isSafeInteger(days) || days === 0 || Math.abs(days) > 366) {
        if (dialog?.kind === 'shift') setDialog({ kind: 'shift', shift: { ...dialog.shift, days, phase: 'failed', preview: null, problem: 'shift.days' } })
        return
      }
      void previewShift(dialog.shift.rows, days)
    },
    onShiftSave: () => {
      if (dialog?.kind !== 'shift' || dialog.shift.phase !== 'ready' || !siteId) return
      const shift = dialog.shift
      setDialog({ kind: 'shift', shift: { ...shift, phase: 'saving' } })
      shiftPlanned(api, siteId, refs(shift.rows), shift.days, false, newIdempotencyKey())
        .then((done) => {
          setDialog((current) => (current?.kind === 'shift' ? { kind: 'shift', shift: { ...current.shift, phase: 'done', done } } : current))
          afterWrite()
        })
        .catch((error: unknown) => {
          setDialog((current) => (current?.kind === 'shift' ? { kind: 'shift', shift: { ...current.shift, phase: 'ready', problem: writeWords(error) } } : current))
          afterWrite()
        })
    },
    onFirm: (rowId, firm) => {
      const row = rowsOf([rowId])[0]
      if (!row) return
      void one(rowId, async () => {
        await firmPlanned(api, row.id, row.version, firm)
        return { tone: 'success', words: phrase(firm ? 'notice.firmed' : 'notice.unfirmed', { label: `${row.style.code} ${row.colourway.code}` }) }
      })
    },
    onDates: (rowId) => {
      const row = rowsOf([rowId])[0]
      if (row) setDialog({ kind: 'dates', dates: { rowId, startDate: row.startDate, dueDate: row.dueDate, busy: false, problem: null } })
    },
    onDatesChange: (field, value) => setDialog((current) => (current?.kind === 'dates' ? { kind: 'dates', dates: { ...current.dates, [field]: value, problem: null } } : current)),
    onDatesSave: () => {
      if (dialog?.kind !== 'dates' || dialog.dates.busy) return
      const dates = dialog.dates
      const row = rowsOf([dates.rowId])[0]
      if (!row) return
      const edit = { ...(dates.startDate !== row.startDate ? { startDate: dates.startDate } : {}), ...(dates.dueDate !== row.dueDate ? { dueDate: dates.dueDate } : {}) }
      if (Object.keys(edit).length === 0) return
      setDialog({ kind: 'dates', dates: { ...dates, busy: true, problem: null } })
      editPlanned(api, row.id, row.version, edit)
        .then(() => {
          setDialog(null)
          setNotice({ tone: 'success', words: phrase('notice.datesSaved', { label: `${row.style.code} ${row.colourway.code}` }) })
          afterWrite()
        })
        .catch((error: unknown) => {
          setDialog((current) => (current?.kind === 'dates' ? { kind: 'dates', dates: { ...current.dates, busy: false, problem: writeWords(error) } } : current))
          afterWrite()
        })
    },
    onReset: (rowId, field: ProtectableField) => {
      const row = rowsOf([rowId])[0]
      if (!row) return
      void one(rowId, async () => {
        const answer = await resetPlanned(api, row.id, row.version, [field])
        if (dialog?.kind === 'dates' && dialog.dates.rowId === rowId) setDialog(null)
        return { tone: 'success', words: phrase(answer.restored ? 'notice.reset' : 'notice.resetNextRun', { field: `field.${field}` }) }
      })
    },
    onDecide: (ids, status) => setDialog({ kind: 'decide', decide: { ids, status, note: '', busy: false, problem: null } }),
    onDecideNote: (note) => setDialog((current) => (current?.kind === 'decide' ? { kind: 'decide', decide: { ...current.decide, note } } : current)),
    onDecideSave: () => {
      if (dialog?.kind !== 'decide' || dialog.decide.busy || messages?.status !== 'ready') return
      const decide = dialog.decide
      const picked = messages.value.messages.filter((message) => decide.ids.includes(message.id) && message.status === 'OPEN')
      if (picked.length === 0) return
      setDialog({ kind: 'decide', decide: { ...decide, busy: true, problem: null } })
      decideActionMessages(
        api,
        picked.map((message) => ({ id: message.id, version: message.version })),
        decide.status,
        decide.note,
      )
        .then((answer) => {
          setDialog(null)
          setNotice({ tone: 'success', words: phrase(decide.status === 'DONE' ? 'notice.done' : 'notice.ignored', { count: answer.decided }) })
          afterWrite()
        })
        .catch((error: unknown) => {
          setDialog((current) => (current?.kind === 'decide' ? { kind: 'decide', decide: { ...current.decide, busy: false, problem: writeWords(error) } } : current))
          afterWrite()
        })
    },
    onAllMessages: (all) => setAllMessages(all),
    onCloseDialog: () => setDialog((current) => (current?.kind === 'convert' && current.convert.phase === 'saving') || (current?.kind === 'shift' && current.shift.phase === 'saving') ? current : null),
    onDismissNotice: () => setNotice(null),
    onLog: (logRun) => {
      if (!logRun) {
        setLog(null)
        return
      }
      setLog({ runId: logRun, log: { status: 'loading' } })
      getRunLog(api, logRun)
        .then((value) => setLog((current) => (current?.runId === logRun ? { runId: logRun, log: { status: 'ready', value } } : current)))
        .catch((error: unknown) => setLog((current) => (current?.runId === logRun ? { runId: logRun, log: isApiError(error) && error.kind === 'not_found' ? { status: 'not_found' } : { status: 'error', problem: readProblem(error) } } : current)))
    },
    onProfile: (lineId) => latest.current.setProfileLine(lineId),
    onRetryProfile: () => {
      if (host.profileLine) loadProfile(host.profileLine)
    },
  }

  const model: DepthModel = { can, planned, messages, allMessages, delays, dialog, notice, busy, log, profile, built: host.built }
  return { model, actions, onLive }
}
