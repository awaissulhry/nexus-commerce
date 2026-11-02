'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import type { ApiClient } from '../../../lib/api/client'
import type { Notice } from '../_shared/parts'
import { approveRequest, askRequest, cancelRequest, changeRequestPeople, listRequests, recordAnswer, requestRecord, type OvertimeListed, type OvertimeRecord } from './api'
import { bulkOfRequests, problemOf, readProblem, type DayRange, type ShiftsCan } from './model'
import type { RequestState } from './view-model'

export interface OvertimeArgs {
  readonly api: ApiClient
  readonly enabled: boolean
  readonly can: Pick<ShiftsCan, 'overtime' | 'approve'>
  readonly siteId: string | null
  readonly lineId: string | null
  readonly range: DayRange
  readonly openId: string | null
  readonly onNotice: (notice: Notice | null) => void
  /** A request changed: its cells' "+2 h" follow. */
  readonly onChanged: () => void
}

/**
 * The overtime requests: the list (a week before the range to six weeks after it, the line of the filter), the request in
 * the address (`?open=`), each verb a command with the version read; a verb's answer is the record, drawn at once. Bulk
 * Ask and Approve run one command per request, a refusal says how many stayed.
 */
export function useOvertime({ api, enabled, can, siteId, lineId, range, openId, onNotice, onChanged }: OvertimeArgs) {
  const [items, setItems] = useState<OvertimeListed[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [request, setRequest] = useState<RequestState | null>(null)
  const stamp = useRef(0)

  const readList = useCallback(async () => {
    if (!enabled) return
    const ticket = ++stamp.current
    try {
      const answer = await listRequests(api, { siteId, lineId, from: plusDays(range.from, -7), to: plusDays(range.to, 42) })
      if (ticket !== stamp.current) return
      setItems(answer.requests)
      setProblem(null)
    } catch (error) {
      if (ticket !== stamp.current) return
      setProblem(readProblem(error))
    }
  }, [api, enabled, siteId, lineId, range.from, range.to])

  useEffect(() => {
    setItems(null)
    setSelected([])
    void readList()
  }, [readList])

  const readRecord = useCallback(
    async (id: string) => {
      try {
        const record = await requestRecord(api, id)
        setRequest({ status: 'ready', record, busy: false, problem: null, cancelling: null, picking: null })
      } catch (error) {
        setRequest({ status: 'error', id, problem: problemOf(error).key })
      }
    },
    [api],
  )

  useEffect(() => {
    if (!openId) {
      setRequest(null)
      return
    }
    setRequest({ status: 'loading', id: openId })
    void readRecord(openId)
  }, [openId, readRecord])

  const ready = request?.status === 'ready' ? request : null
  const run = useCallback(
    async (verb: (record: OvertimeRecord) => Promise<OvertimeRecord>) => {
      if (!ready) return
      setRequest({ ...ready, busy: true, problem: null })
      try {
        const record = await verb(ready.record)
        setRequest({ status: 'ready', record, busy: false, problem: null, cancelling: null, picking: null })
        void readList()
        onChanged()
      } catch (error) {
        setRequest({ ...ready, busy: false, problem: problemOf(error).key })
      }
    },
    [ready, readList, onChanged],
  )

  const bulk = useCallback(
    async (kind: 'ask' | 'approve') => {
      const picked = (items ?? []).filter((row) => selected.includes(row.id))
      const targets = bulkOfRequests(picked, can)[kind]
      let done = 0
      let failed = 0
      for (const row of targets) {
        try {
          await (kind === 'ask' ? askRequest(api, row.id, row.version) : approveRequest(api, row.id, row.version))
          done++
        } catch {
          failed++
        }
      }
      onNotice({ tone: failed > 0 ? 'warning' : 'success', words: { key: kind === 'ask' ? 'notice.asked' : 'notice.approved', params: { count: done } }, ...(failed > 0 ? { detail: { key: 'notice.bulkFailed', params: { count: failed } } } : {}) })
      setSelected([])
      void readList()
      onChanged()
    },
    [api, can, items, selected, onNotice, readList, onChanged],
  )

  return {
    items,
    problem,
    selected,
    setSelected,
    request,
    readList,
    readRecord,
    ask: useCallback(() => run((record) => askRequest(api, record.request.id, record.request.version)), [api, run]),
    approve: useCallback(() => run((record) => approveRequest(api, record.request.id, record.request.version)), [api, run]),
    answer: useCallback((agreementId: string, answer: 'AGREED' | 'DECLINED') => run((record) => recordAnswer(api, record.request.id, agreementId, { version: record.people.find((person) => person.agreementId === agreementId)?.version ?? 1, answer })), [api, run]),
    remove: useCallback((employeeId: string) => run((record) => changeRequestPeople(api, record.request.id, { version: record.request.version, remove: [employeeId] })), [api, run]),
    add: useCallback(() => (ready?.picking ? run((record) => changeRequestPeople(api, record.request.id, { version: record.request.version, add: ready.picking!.ids })) : Promise.resolve()), [api, ready, run]),
    cancel: useCallback(() => (ready?.cancelling ? run((record) => cancelRequest(api, record.request.id, { version: record.request.version, reason: ready.cancelling!.reason.trim() })) : Promise.resolve()), [api, ready, run]),
    setPicking: useCallback((ids: string[] | null) => setRequest((before) => (before?.status === 'ready' ? { ...before, picking: ids ? { ids } : null } : before)), []),
    setCancelling: useCallback((reason: string | null) => setRequest((before) => (before?.status === 'ready' ? { ...before, cancelling: reason === null ? null : { reason } } : before)), []),
    bulkAsk: useCallback(() => bulk('ask'), [bulk]),
    bulkApprove: useCallback(() => bulk('approve'), [bulk]),
  }
}
