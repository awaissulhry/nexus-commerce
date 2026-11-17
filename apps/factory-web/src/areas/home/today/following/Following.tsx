'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useLiveBus } from '../../../../shell/live/use-live'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { fetchFollowing, followingProblem, markSeen, unfollow } from './api'
import { rowOf, unreadRowsOf, withUnread, type FollowingModel, type FollowingRow } from './model'
// B-TH-239: "3 new messages" — the reader's own new messages per followed record (ONE POST /threads/unread for the lines).
import { readUnreadWith } from '../../../../lib/last-message-cell/api'
import { unreadAsk, unreadMapOf } from '../../../../lib/last-message-cell/model'
import { FollowingView } from './view/FollowingView'

/**
 * Today › Changed since you looked, the container (B-W2b-388): reads my FOLLOWING news (GET /home/following) when Today opens and
 * on `notification.created`, marks a line seen (its news done) and unfollows its record or view. Today mounts it in its section
 * list. A seen line leaves at once (it comes back with the next news of its record).
 */
export function Following() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const prefix = companyPrefix(session.company?.code ?? '')
  const [rows, setRows] = useState<FollowingModel['rows']>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<FollowingModel['notice']>(null)
  const [now, setNow] = useState(() => Date.now())

  // B-TH-239: only a reader of threads is asked (threads.read); a failed count leaves the lines as they are (never a made-up number).
  const readsThreads = session.permissions.includes('threads.read')
  const load = useCallback(async () => {
    try {
      const answer = await fetchFollowing(api)
      const items = answer.items.map((item) => rowOf(item, prefix, OFFICE_PAGES))
      const asked = unreadAsk(unreadRowsOf(items))
      const counts = readsThreads && asked.length > 0 ? await readUnreadWith(api)(asked, new AbortController().signal).catch(() => null) : null
      setRows({ status: 'ready', data: { items: counts ? withUnread(items, unreadMapOf(counts), prefix, OFFICE_PAGES) : items, complete: answer.complete, asOf: answer.asOf } })
      setNow(Date.now())
    } catch (error) {
      setRows({ status: 'error', problem: followingProblem(error) })
    }
  }, [api, prefix, readsThreads])
  useEffect(() => {
    void load()
  }, [load])
  // B-TH-239: a new message (thread.*) moves the counts too — a burst of changes is one read (half a second).
  const again = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadSoon = useCallback(() => {
    if (again.current) clearTimeout(again.current)
    again.current = setTimeout(() => {
      again.current = null
      void load()
    }, 500)
  }, [load])
  useEffect(() => () => (again.current ? clearTimeout(again.current) : undefined), [])
  const live = useLiveBus({ onChange: (change) => (change.type === 'notification.created' || (readsThreads && change.type.startsWith('thread.'))) && loadSoon(), onReconnect: () => void load() })

  const act = (row: FollowingRow, run: () => Promise<void>, done: string) => {
    setBusy(true)
    run()
      .then(() => {
        setRows((current) => (current.status === 'ready' ? { status: 'ready', data: { ...current.data, items: current.data.items.filter((entry) => entry.key !== row.key) } } : current))
        setNotice({ key: done, tone: 'success', params: { record: row.record.label } })
        window.dispatchEvent(new Event('factory:notifications-changed'))
      })
      .catch((error: unknown) => {
        setNotice({ key: followingProblem(error), tone: 'danger' })
        void load()
      })
      .finally(() => setBusy(false))
  }

  const model = useMemo<FollowingModel>(() => ({ rows, now, held: live === 'offline' ? 'held.offline' : busy ? 'held.busy' : null, notice }), [rows, now, live, busy, notice])
  return (
    <FollowingView
      model={model}
      actions={{
        onSeen: (row) => act(row, () => markSeen(api, row), 'following.notice.seen'),
        // Unfollowed, its news is seen too (else the line would come back on the next read).
        onUnfollow: (row) => act(row, () => unfollow(api, row).then(() => markSeen(api, row)), row.view ? 'following.notice.unpinned' : 'following.notice.unfollowed'),
        onRetry: () => void load(),
      }}
    />
  )
}
