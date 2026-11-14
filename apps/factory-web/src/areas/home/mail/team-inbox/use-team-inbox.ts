'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { ApiClient } from '../../../../lib/api/client'
import { useLiveChanges } from '../../../../record-panels/live'
import { listInboxes, listQueue, workOn, type WorkChange } from './api'
import { isInboxChange, queueAddressOf, readProblem, workProblem, type Notice, type QueueState, type QueueView, type Read, type TeamInbox, type TeamInboxDialog, type TeamInboxModel } from './model'
import type { TeamInboxActions } from './view/TeamInboxQueue'

/**
 * The container of Home › Mail's team inboxes (B-W2b-397 on B-W2b-394's API): the inboxes the person works with their counts
 * (`GET /email/team-inboxes?companyId`), the open inbox's queue by view (`?inbox=<id>&view=OPEN` in the address), the work on
 * its mail — take, assign, give back, close, reopen, snooze, wake, follow up, move — one call per mail with the version read,
 * and the live stream (email.inbound_worked, email.team_inbox_changed, email.inbound_sorted): the counts are read again at
 * once, the rows wait behind "N updates · Show" (rows never move under the cursor). Off (null model) without email.triage.
 */
export function useTeamInbox(
  api: ApiClient,
  options: { readonly companyId: string | null; readonly me: string; readonly prefix: string; readonly enabled: boolean; readonly canInquiry: boolean },
): { model: TeamInboxModel | null; actions: TeamInboxActions } {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const address = queueAddressOf(params)
  const [inboxes, setInboxes] = useState<Read<{ inboxes: readonly TeamInbox[]; mayManage: boolean }>>({ status: 'loading' })
  const [queue, setQueue] = useState<Omit<QueueState, 'inboxId' | 'view'> & { cursor: string | null }>({ rows: null, more: false, problem: null, selected: [], updates: 0, cursor: null })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<TeamInboxDialog | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const wanted = useRef(address)
  wanted.current = address

  const readInboxes = useCallback(async () => {
    if (!options.enabled || !options.companyId) return
    try {
      setInboxes({ status: 'ready', data: await listInboxes(api, options.companyId) })
    } catch (error) {
      setInboxes({ status: 'error', problem: readProblem(error) })
    }
  }, [api, options.enabled, options.companyId])

  const readQueue = useCallback(
    async (more = false, cursor: string | null = null) => {
      const asked = wanted.current
      if (!options.enabled || !asked.inboxId) return
      if (more) setQueue((current) => ({ ...current, loadingMore: true }))
      try {
        const page = await listQueue(api, asked.inboxId, asked.view, more ? cursor : null)
        if (asked.inboxId !== wanted.current.inboxId || asked.view !== wanted.current.view) return
        setQueue((current) => ({
          ...current,
          rows: more && current.rows ? [...current.rows, ...page.mails] : page.mails,
          cursor: page.nextCursor,
          more: page.nextCursor !== null,
          loadingMore: false,
          problem: null,
          updates: more ? current.updates : 0,
          selected: more ? current.selected : current.selected.filter((id) => page.mails.some((mail) => mail.id === id)),
        }))
      } catch (error) {
        setQueue((current) => ({ ...current, loadingMore: false, problem: readProblem(error) }))
      }
    },
    [api, options.enabled],
  )

  useEffect(() => {
    void readInboxes()
  }, [readInboxes])

  useEffect(() => {
    setQueue({ rows: null, more: false, problem: null, selected: [], updates: 0, cursor: null })
    setDialog(null)
    void readQueue()
  }, [address.inboxId, address.view, readQueue])

  useLiveChanges(
    {
      onChange: (change) => {
        if (!isInboxChange(change)) return
        void readInboxes()
        if (wanted.current.inboxId) setQueue((current) => ({ ...current, updates: current.updates + 1 }))
      },
      onReconnect: () => {
        void readInboxes()
        void readQueue()
      },
    },
    options.enabled,
  )

  const go = useCallback(
    (inboxId: string | null, view: QueueView = 'OPEN') => {
      const next = new URLSearchParams(params?.toString() ?? '')
      next.delete('open')
      if (inboxId) {
        next.set('inbox', inboxId)
        next.set('view', view)
      } else {
        next.delete('inbox')
        next.delete('view')
      }
      const qs = next.toString()
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [params, pathname, router],
  )

  /** One change to each mail named, one call each with its version; then the counts and the view are read again. */
  const work = useCallback(
    async (ids: readonly string[], change: WorkChange): Promise<boolean> => {
      const rows = (queue.rows ?? []).filter((row) => ids.includes(row.id))
      if (rows.length === 0) return false
      setBusy(true)
      setNotice(null)
      let done = 0
      let refused: ReturnType<typeof workProblem> | null = null
      for (const row of rows) {
        try {
          await workOn(api, row, change)
          done++
        } catch (error) {
          refused = refused ?? workProblem(error)
        }
      }
      setBusy(false)
      const key = `inbox.done.${change.kind === 'assignee' ? (change.assigneeId === null ? 'giveBack' : change.assigneeId === options.me ? 'take' : 'assign') : change.kind === 'snooze' ? (change.until === null ? 'wake' : 'snooze') : change.kind === 'followUp' ? (change.until === null ? 'clearFollowUp' : 'followUp') : change.kind}`
      if (refused === null) setNotice({ key, tone: 'success', params: { count: done } })
      else if (done > 0) setNotice({ key: 'inbox.notice.partial', tone: 'warning', params: { done, count: rows.length } })
      else setNotice({ key: refused.key, tone: refused.tone })
      setQueue((current) => ({ ...current, selected: current.selected.filter((id) => !ids.includes(id)) }))
      void readInboxes()
      void readQueue()
      setNow(Date.now())
      return refused === null
    },
    [api, options.me, queue.rows, readInboxes, readQueue],
  )

  const model = useMemo<TeamInboxModel | null>(() => {
    if (!options.enabled) return null
    return {
      inboxes,
      queue: address.inboxId ? { inboxId: address.inboxId, view: address.view, rows: queue.rows, more: queue.more, loadingMore: queue.loadingMore, problem: queue.problem, selected: queue.selected, updates: queue.updates } : null,
      me: options.me,
      prefix: options.prefix,
      busy,
      notice,
      dialog,
      now,
      canInquiry: options.canInquiry,
    }
  }, [options.enabled, options.me, options.prefix, options.canInquiry, inboxes, address.inboxId, address.view, queue, busy, notice, dialog, now])

  const actions: TeamInboxActions = {
    onInbox: (inboxId) => go(inboxId),
    onView: (view) => go(address.inboxId, view),
    onMore: () => void readQueue(true, queue.cursor),
    onShowUpdates: () => void readQueue(),
    onSelect: (ids) => setQueue((current) => ({ ...current, selected: ids })),
    onRetry: () => {
      void readInboxes()
      setQueue((current) => ({ ...current, rows: null, problem: null }))
      void readQueue()
    },
    onDialog: (next) => {
      setNow(Date.now())
      setDialog(next)
    },
    onWork: work,
    onDismissNotice: () => setNotice(null),
  }

  return { model, actions }
}
