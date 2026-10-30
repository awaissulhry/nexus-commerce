'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { bulkNotice, type BulkNotice } from '../../kit/bulk-model'
import { runBulk } from '../../shared/bulk'
import { problemKey } from '../../shared/model'
import type { Ledger } from '../model'
import { listBlocked, listDelivery, unblockAddress, type BlockedAddress, type DeliveryCounts, type DeliveryMail } from './api'
import { queryOf, UNBLOCK_NOTICE, unblockReach, type BlockedView, type DeliveryActions, type DeliveryFilter, type DeliveryModel } from './model'

export type { DeliveryActions } from './model'

/**
 * The container of the delivery log section (SCR-087, B-W2a-41): reads `GET /email/delivery` (with the filter) and
 * `GET /email/blocked` (blocked now, or the unblocked ones), pages each with its cursor, and unblocks the chosen
 * addresses one call each with the version read (ONE notice says what was done). `enabled` is the person's
 * email.delivery.view: without it nothing is read and the section is absent.
 */


const empty = <T,>(): Ledger<T> => ({ items: null, problem: null, more: null })

export function useDelivery(api: ApiClient, enabled: boolean): { model: DeliveryModel | null; actions: DeliveryActions } {
  const [filter, setFilter] = useState<DeliveryFilter>(null)
  const [mails, setMails] = useState<Ledger<DeliveryMail>>(empty)
  const [counts, setCounts] = useState<DeliveryCounts | null>(null)
  const [blockedCount, setBlockedCount] = useState<number | null>(null)
  const [blockedView, setBlockedView] = useState<BlockedView>('BLOCKED')
  const [blocked, setBlocked] = useState<Ledger<BlockedAddress>>(empty)
  const [canUnblock, setCanUnblock] = useState(false)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [confirm, setConfirm] = useState<readonly string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<BulkNotice | null>(null)
  // A slower answer of an older filter never replaces a newer one.
  const mailsRead = useRef(0)
  const blockedRead = useRef(0)

  const readMails = useCallback(
    async (next: DeliveryFilter) => {
      if (!enabled) return
      const ticket = ++mailsRead.current
      setMails(empty())
      try {
        const page = await listDelivery(api, queryOf(next))
        if (ticket !== mailsRead.current) return
        setMails({ items: page.mails, problem: null, more: page.nextBefore })
        setCounts(page.counts)
        setBlockedCount(page.blocked)
      } catch (error) {
        if (ticket === mailsRead.current) setMails({ items: null, problem: problemKey(error), more: null })
      }
    },
    [api, enabled],
  )

  const readBlocked = useCallback(
    async (view: BlockedView) => {
      if (!enabled) return
      const ticket = ++blockedRead.current
      setBlocked(empty())
      try {
        const page = await listBlocked(api, { state: view })
        if (ticket !== blockedRead.current) return
        setBlocked({ items: page.addresses, problem: null, more: page.nextBefore })
        setCanUnblock(page.canUnblock)
      } catch (error) {
        if (ticket === blockedRead.current) setBlocked({ items: null, problem: problemKey(error), more: null })
      }
    },
    [api, enabled],
  )

  useEffect(() => {
    void readMails(filter)
  }, [readMails, filter])
  useEffect(() => {
    void readBlocked(blockedView)
  }, [readBlocked, blockedView])

  const more = useCallback(async () => {
    const anchor = mails.more
    if (!anchor || !mails.items) return
    setMails((current) => ({ ...current, loadingMore: true }))
    try {
      const page = await listDelivery(api, { ...queryOf(filter), before: anchor })
      setMails((current) => ({ items: [...(current.items ?? []), ...page.mails], problem: null, more: page.nextBefore }))
    } catch (error) {
      setMails((current) => ({ ...current, loadingMore: false, problem: problemKey(error) }))
    }
  }, [api, filter, mails.items, mails.more])

  const blockedMore = useCallback(async () => {
    const anchor = blocked.more
    if (!anchor || !blocked.items) return
    setBlocked((current) => ({ ...current, loadingMore: true }))
    try {
      const page = await listBlocked(api, { state: blockedView, before: anchor })
      setBlocked((current) => ({ items: [...(current.items ?? []), ...page.addresses], problem: null, more: page.nextBefore }))
    } catch (error) {
      setBlocked((current) => ({ ...current, loadingMore: false, problem: problemKey(error) }))
    }
  }, [api, blocked.items, blocked.more, blockedView])

  const actions = useMemo<DeliveryActions>(
    () => ({
      onFilter: setFilter,
      onMore: () => void more(),
      onRetry: () => void readMails(filter),
      onBlockedView: (view) => {
        setSelected([])
        setBlockedView(view)
      },
      onBlockedMore: () => void blockedMore(),
      onBlockedRetry: () => void readBlocked(blockedView),
      onSelect: setSelected,
      onConfirm: (ids) => {
        setDialogProblem(null)
        setConfirm(ids)
      },
      onUnblock: async (rows, reason) => {
        setBusy(true)
        setDialogProblem(null)
        try {
          const chosen = unblockReach(rows).applies
          const result = await runBulk(chosen, async (row) => {
            const next = await unblockAddress(api, row.id, { version: row.version, reason })
            setBlocked((current) => ({ ...current, items: (current.items ?? []).filter((item) => item.id !== next.id) }))
          })
          const done = new Set(result.done.map((row) => row.id))
          setSelected((current) => current.filter((id) => !done.has(id)))
          setBlockedCount((current) => (current === null ? current : Math.max(0, current - done.size)))
          setNotice(bulkNotice(result, UNBLOCK_NOTICE, (row) => row.id))
          setConfirm(null)
          if (result.refused.some((entry) => entry.problem === 'problem.conflict')) void readBlocked(blockedView)
        } catch (error) {
          setDialogProblem(problemKey(error))
        } finally {
          setBusy(false)
        }
      },
      onDismissNotice: () => setNotice(null),
    }),
    [api, more, readMails, filter, blockedMore, readBlocked, blockedView],
  )

  if (!enabled) return { model: null, actions }
  return { model: { mails, counts, blockedCount, filter, blocked, blockedView, canUnblock, selected, confirm, busy, dialogProblem, notice }, actions }
}
