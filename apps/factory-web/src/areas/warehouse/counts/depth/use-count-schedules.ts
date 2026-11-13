'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import type { CountsCan, Phrase } from '../model'
import { readProblem } from '../model'
import { blockedPlaces, changeSchedule, createSchedule, dueCounts, listSchedules, startSchedule, type BlockedPlace, type DueCounts, type Schedule } from './api'
import { blankSchedule, draftOfSchedule, scheduleBodyOf, scheduleChangeOf, scheduleProblem, scheduleSaveHeld, startProblem, type ScheduleDraft } from './model'

/**
 * B-W2b-320 — the Counts page's W2b parts (container hook; SCR-132): the Due counts section and the "Due this week" tile
 * (`GET /inventory/count-schedules/due` for the site of the address), the places running counts block (`GET
 * /inventory/locations/blocked`, inventory.locations.view), Start count of one schedule (opens the count) or of the
 * selected ones (one call each, in the order shown), and the Count schedule dialog: the site's schedules, New, Edit,
 * Retire and Reactivate (one write each at the version read, its own Idempotency-Key). Re-read on the counts' live events.
 */

export interface SchedulesDialog {
  filter: 'true' | 'all'
  list: { items: Schedule[] | null; problem: string | null }
  form: ScheduleDraft | null
  busy: boolean
  problem: Phrase | null
}

export interface CountSchedulesModel {
  due: { value: DueCounts | null; problem: string | null }
  /** Places a running count blocks now (null: not read or no inventory.locations.view). */
  blocked: BlockedPlace[] | null
  starting: readonly string[]
  dialog: SchedulesDialog | null
  notice: { tone: 'success' | 'info' | 'warning' | 'danger'; words: Phrase } | null
  today: string
  /** Design cases: rows of Due counts ticked. */
  selected?: readonly string[]
}

export interface CountSchedulesActions {
  onRetryDue?: () => void
  onStart?: (ids: readonly string[]) => void
  onSchedules?: (open: boolean) => void
  onSchedulesFilter?: (filter: 'true' | 'all') => void
  onNewSchedule?: () => void
  onEditSchedule?: (schedule: Schedule) => void
  onScheduleDraft?: (patch: Partial<ScheduleDraft>) => void
  onSaveSchedule?: () => void
  onCancelSchedule?: () => void
  onRetire?: (schedule: Schedule, active: boolean) => void
  onDismissDueNotice?: () => void
}

export function useCountSchedules(api: ApiClient, options: { siteId: string | null; can: CountsCan; locations: boolean; today: string; onStarted: (countId: string) => void; onChanged: () => void }) {
  const { siteId, can } = options
  const [due, setDue] = useState<CountSchedulesModel['due']>({ value: null, problem: null })
  const [blocked, setBlocked] = useState<BlockedPlace[] | null>(null)
  const [starting, setStarting] = useState<string[]>([])
  const [dialog, setDialog] = useState<SchedulesDialog | null>(null)
  const [notice, setNotice] = useState<CountSchedulesModel['notice']>(null)

  const loadDue = useCallback(async () => {
    if (!can.view) return
    try {
      setDue({ value: await dueCounts(api, siteId), problem: null })
    } catch (error) {
      setDue({ value: null, problem: readProblem(error) })
    }
    if (options.locations) {
      blockedPlaces(api, siteId)
        .then(setBlocked)
        .catch(() => setBlocked(null))
    }
  }, [api, siteId, can.view, options.locations])
  useEffect(() => {
    setDue({ value: null, problem: null })
    void loadDue()
  }, [loadDue])

  const loadList = useCallback(
    async (filter: 'true' | 'all') => {
      setDialog((current) => (current ? { ...current, filter, list: { items: current.filter === filter ? current.list.items : null, problem: null } } : current))
      try {
        const items = await listSchedules(api, siteId, filter)
        setDialog((current) => (current && current.filter === filter ? { ...current, list: { items, problem: null } } : current))
      } catch (error) {
        setDialog((current) => (current && current.filter === filter ? { ...current, list: { items: null, problem: readProblem(error) } } : current))
      }
    },
    [api, siteId],
  )

  const start = useCallback(
    async (ids: readonly string[]) => {
      const rows = (due.value?.rows ?? []).filter((row) => ids.includes(row.id))
      if (rows.length === 0 || starting.length > 0) return
      setStarting(rows.map((row) => row.id))
      setNotice(null)
      const made: string[] = []
      let refused: Phrase | null = null
      for (const row of rows) {
        try {
          made.push((await startSchedule(api, row.id, true)).countId)
        } catch (error) {
          refused ??= startProblem(error, row.name)
        }
      }
      setStarting([])
      if (rows.length === 1 && made.length === 1) {
        options.onStarted(made[0]!)
        return
      }
      setNotice(refused ? { tone: made.length > 0 ? 'warning' : 'danger', words: made.length > 0 ? { key: 'cd.start.some', params: { started: made.length, count: rows.length } } : refused } : { tone: 'success', words: { key: 'cd.start.done', params: { count: made.length } } })
      void loadDue()
      options.onChanged()
    },
    [api, due.value, starting.length, loadDue, options],
  )

  const save = useCallback(async () => {
    const form = dialog?.form
    if (!dialog || !form || scheduleSaveHeld(form, can, dialog.busy)) return
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      if (form.id) await changeSchedule(api, form.id, scheduleChangeOf(form))
      else await createSchedule(api, scheduleBodyOf(form))
      setDialog((current) => (current ? { ...current, busy: false, form: null } : current))
      void loadList(dialog.filter)
      void loadDue()
    } catch (error) {
      setDialog((current) => (current ? { ...current, busy: false, problem: scheduleProblem(error) } : current))
    }
  }, [api, dialog, can, loadList, loadDue])

  const retire = useCallback(
    async (schedule: Schedule, active: boolean) => {
      if (!dialog || dialog.busy) return
      setDialog({ ...dialog, busy: true, problem: null })
      try {
        await changeSchedule(api, schedule.id, { version: schedule.version, active })
        setDialog((current) => (current ? { ...current, busy: false } : current))
        void loadList(dialog.filter)
        void loadDue()
      } catch (error) {
        setDialog((current) => (current ? { ...current, busy: false, problem: scheduleProblem(error) } : current))
      }
    },
    [api, dialog, loadList, loadDue],
  )

  const model: CountSchedulesModel = { due, blocked, starting, dialog, notice, today: due.value?.today ?? options.today }
  const actions: CountSchedulesActions = {
    onRetryDue: () => void loadDue(),
    onStart: (ids) => void start(ids),
    onSchedules: (open) => {
      if (!open) {
        setDialog(null)
        return
      }
      setDialog({ filter: 'true', list: { items: null, problem: null }, form: null, busy: false, problem: null })
      void loadList('true')
    },
    onSchedulesFilter: (filter) => void loadList(filter),
    onNewSchedule: () => setDialog((current) => (current ? { ...current, form: blankSchedule(siteId, model.today), problem: null } : current)),
    onEditSchedule: (schedule) => setDialog((current) => (current ? { ...current, form: draftOfSchedule(schedule), problem: null } : current)),
    onScheduleDraft: (patch) => setDialog((current) => (current?.form ? { ...current, form: { ...current.form, ...patch }, problem: null } : current)),
    onSaveSchedule: () => void save(),
    onCancelSchedule: () => setDialog((current) => (current ? { ...current, form: null, problem: null } : current)),
    onRetire: (schedule, active) => void retire(schedule, active),
    onDismissDueNotice: () => setNotice(null),
  }
  return { model, actions, reread: loadDue }
}
