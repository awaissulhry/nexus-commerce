'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useLiveChanges } from '../../../../record-panels/live'
import { fetchInbox, keptInbox } from './api'
import { inboxChanged, type KindCounts, type TaskInbox } from './model'

/**
 * The warehouse task inbox as a screen reads it (B-W2b-308; My work at the warehouse, Move & put away's list, the Home tiles'
 * counts): read on view, again when the live channel says a task of the site changed (inventory.warehouse_task_changed reaches
 * the site's tablets, floor.work) or the stream comes back, every 30 s while in view, and when the network returns. The first
 * answer goes on screen; a later one that differs waits behind "List changed · Show". Offline, or the office not answering: the
 * list this tablet read for this person in this visit, with its time.
 */

const REREAD_MS = 30_000
const TASK_CHANGED = 'inventory.warehouse_task_changed'

export interface InboxRead {
  /** The list on screen; null: not read yet (and none kept). */
  readonly shown: TaskInbox | null
  /** A fresher list that differs, waiting behind "Show". */
  readonly fresh: TaskInbox | null
  /** Shown from this tablet: as of when. */
  readonly asOf: string | null
  /** Not read now: no network, or the office did not answer. */
  readonly problem: 'offline' | 'error' | null
  /** Read again; `show`: put the answer on screen at once (this tablet's own step, Try again). */
  readonly read: (show: boolean) => Promise<void>
  /** Put the fresher list on screen. */
  readonly showFresh: () => void
}

export function useTaskInbox(input: { api: ApiClient; online: boolean; workerId: string | null; allowed: boolean; onSignedOut: () => void }): InboxRead {
  const { api, online, workerId, allowed, onSignedOut } = input
  const [shown, setShown] = useState<TaskInbox | null>(null)
  const [fresh, setFresh] = useState<TaskInbox | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [problem, setProblem] = useState<'offline' | 'error' | null>(null)
  const shownRef = useRef<TaskInbox | null>(null)
  shownRef.current = shown
  const signedOut = useRef(onSignedOut)
  signedOut.current = onSignedOut

  const read = useCallback(
    async (show: boolean) => {
      if (!allowed || !workerId) return
      const answer = await fetchInbox(api, workerId)
      if (answer.ok) {
        setProblem(null)
        setAsOf(null)
        if (show || shownRef.current === null) {
          setShown(answer.value)
          setFresh(null)
        } else setFresh(inboxChanged(shownRef.current, answer.value) ? answer.value : null)
        return
      }
      if (answer.problem.kind === 'signedOut') return void signedOut.current()
      const kept = keptInbox(workerId)
      if (shownRef.current === null && kept) {
        setShown(kept.value)
        setAsOf(kept.asOf)
      } else if (shownRef.current) setAsOf((current) => current ?? shownRef.current!.asOf)
      setProblem(answer.problem.kind === 'offline' ? 'offline' : 'error')
    },
    [allowed, api, workerId],
  )

  // Another person on the tablet starts from their own list (never the last person's).
  useEffect(() => {
    setShown(null)
    setFresh(null)
    setAsOf(null)
    setProblem(null)
    shownRef.current = null
    void read(true)
  }, [read, workerId])

  useEffect(() => {
    if (online && asOf) void read(false)
  }, [online, asOf, read])

  useEffect(() => {
    if (!allowed || !online) return
    const again = () => {
      if (document.visibilityState === 'visible') void read(false)
    }
    const timer = window.setInterval(again, REREAD_MS)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', again)
    }
  }, [allowed, online, read])

  useLiveChanges({ onChange: (change) => void (change.type === TASK_CHANGED && read(false)), onReconnect: () => void read(false) }, allowed && online)

  const freshRef = useRef<TaskInbox | null>(null)
  freshRef.current = fresh
  const showFresh = useCallback(() => {
    const next = freshRef.current
    if (!next) return
    setShown(next)
    setFresh(null)
    setAsOf(null)
  }, [])

  return { shown, fresh, asOf, problem, read, showFresh }
}

/**
 * The Home tiles' counts at the warehouse (design floor.home "each tile: … a count of what waits"; floor.move "a new quarantine
 * move task → a count on the Move tile"): what waits per kind for the person signed in, read on view and when a task of the site
 * changes. Null until read (an unknown count shows no number, never 0); another person starts from null.
 */
export function useWarehouseCounts(api: ApiClient, enabled: boolean, workerId: string | null): KindCounts | null {
  const [counts, setCounts] = useState<KindCounts | null>(null)
  const read = useCallback(async () => {
    if (!workerId) return
    const answer = await fetchInbox(api, workerId)
    if (answer.ok) setCounts(answer.value.counts)
  }, [api, workerId])
  useEffect(() => {
    setCounts(workerId ? (keptInbox(workerId)?.value.counts ?? null) : null)
    if (enabled) void read()
  }, [enabled, read, workerId])
  useLiveChanges({ onChange: (change) => void (change.type === TASK_CHANGED && read()), onReconnect: () => void read() }, enabled)
  return counts
}
