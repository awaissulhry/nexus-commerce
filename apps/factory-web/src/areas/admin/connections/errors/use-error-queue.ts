'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { ApiClient } from '../../../../lib/api/client'
import { useLive } from '../../../_shared/buying/hooks'
import { runBulk } from '../../shared/bulk'
import { problemKey } from '../../shared/model'
import { dismissError, getError, listErrors, retryError, type ErrorItem, type ErrorView } from './api'
import { bulkReach, dismissProblem } from './model'
import type { ErrorQueueActions, ErrorQueueModel } from './view/ErrorQueueSection'

const PAGE = 50
const LIVE_TYPES = new Set(['integration.error_opened', 'integration.error_retried', 'integration.error_dismissed'])

/**
 * The error queue's container part (SCR-087 section `errors`, B-W2b-415): reads `GET /integrations/errors` (integrations.view;
 * absent without it) by view, 50 a page; the open item is the address (`?error=<id>`, J / K over the rows read); Retry one or
 * many (one call each, after a confirm for many), Dismiss one or many with one reason. Live: a new, retried or dismissed item
 * waits behind "N updates · Show" (rows never move under the cursor); read again when the tab comes back.
 */
export function useErrorQueue(api: ApiClient, options: { readonly canView: boolean; readonly prefix: string }): { model: ErrorQueueModel | null; actions: ErrorQueueActions } {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const openId = params?.get('error') ?? null
  const [view, setView] = useState<ErrorView>('open')
  const [list, setList] = useState<ErrorQueueModel['list']>({ items: null, counts: null, problem: null, nextBefore: null, loadingMore: false })
  const [canManage, setCanManage] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [open, setOpen] = useState<ErrorQueueModel['open']>(null)
  const [dismiss, setDismiss] = useState<ErrorQueueModel['dismiss']>(null)
  const [retryMany, setRetryMany] = useState<ErrorQueueModel['retryMany']>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<ErrorQueueModel['notice']>(null)
  const [updates, setUpdates] = useState(0)
  const seq = useRef(0)

  const load = useCallback(async () => {
    if (!options.canView) return
    const mine = ++seq.current
    setUpdates(0)
    try {
      const answer = await listErrors(api, { view, limit: PAGE })
      if (mine !== seq.current) return
      setList({ items: answer.items, counts: answer.counts, problem: null, nextBefore: answer.nextBefore, loadingMore: false })
      setCanManage(answer.canManage)
      setSelected((current) => current.filter((id) => answer.items.some((item) => item.id === id)))
    } catch (error) {
      if (mine === seq.current) setList({ items: null, counts: null, problem: problemKey(error), nextBefore: null, loadingMore: false })
    }
  }, [api, options.canView, view])
  useEffect(() => {
    setList((current) => ({ ...current, items: null, problem: null }))
    void load()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])
  useLive((change) => (LIVE_TYPES.has(change.type) ? setUpdates((count) => count + 1) : undefined), () => void load(), options.canView)

  const go = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params?.toString() ?? '')
      if (id) next.set('error', id)
      else next.delete('error')
      const query = next.toString()
      router.replace(query ? `${pathname}?${query}` : (pathname ?? ''), { scroll: false })
    },
    [params, pathname, router],
  )

  useEffect(() => {
    if (!options.canView || !openId) return setOpen(null)
    let stale = false
    setOpen((current) => ({ id: openId, item: list.items?.find((item) => item.id === openId) ?? (current?.id === openId ? current.item : null), detail: null, problem: null }))
    getError(api, openId).then(
      (answer) => !stale && setOpen({ id: openId, item: answer.item, detail: answer.detail, problem: null }),
      (error: unknown) => !stale && setOpen({ id: openId, item: null, detail: null, problem: problemKey(error) }),
    )
    return () => {
      stale = true
    }
    // The open item is read again when it changes, not when a page of rows comes in.
  }, [api, options.canView, openId])

  const replace = (next: ErrorItem) => {
    setList((current) => ({ ...current, items: current.items?.map((item) => (item.id === next.id ? next : item)) ?? null }))
    setOpen((current) => (current?.id === next.id ? { ...current, item: next } : current))
  }

  const retryOne = async (item: ErrorItem) => {
    if (busyId) return
    setBusyId(item.id)
    setNotice(null)
    try {
      const next = await retryError(api, item)
      replace(next)
      setNotice({ key: 'aih.done.retried', tone: 'success', params: { count: 1 } })
      if (openId === item.id) void getError(api, item.id).then((answer) => setOpen({ id: item.id, item: answer.item, detail: answer.detail, problem: null }), () => undefined)
    } catch (error) {
      setNotice({ key: problemKey(error), tone: 'danger', params: {} })
    } finally {
      setBusyId(null)
    }
  }

  const rowsOf = (ids: readonly string[]) => (list.items ?? []).filter((item) => ids.includes(item.id))

  const retryManyGo = async () => {
    if (!retryMany || retryMany.busy) return
    const { applies } = bulkReach(rowsOf(retryMany.ids), 'retry')
    setRetryMany({ ...retryMany, busy: true })
    const result = await runBulk(applies, (item) => retryError(api, item).then(replace))
    setRetryMany(null)
    setSelected([])
    setNotice(result.refused.length > 0 ? { key: 'aih.done.retriedSome', tone: 'warning', params: { count: result.done.length, refused: result.refused.length } } : { key: 'aih.done.retried', tone: 'success', params: { count: result.done.length } })
    void load()
  }

  const dismissGo = async () => {
    if (!dismiss || dismiss.busy) return
    if (dismissProblem(dismiss.reason)) return setDismiss({ ...dismiss, tried: true })
    const { applies } = bulkReach(rowsOf(dismiss.ids).length > 0 ? rowsOf(dismiss.ids) : open?.item && dismiss.ids.includes(open.item.id) ? [open.item] : [], 'dismiss')
    setDismiss({ ...dismiss, busy: true, problem: null, tried: true })
    const result = await runBulk(applies, (item) => dismissError(api, item, dismiss.reason.trim()).then(replace))
    if (result.done.length === 0 && result.refused.length > 0) return setDismiss({ ...dismiss, busy: false, problem: result.refused[0]!.problem, tried: true })
    setDismiss(null)
    setSelected([])
    setNotice(result.refused.length > 0 ? { key: 'aih.done.dismissedSome', tone: 'warning', params: { count: result.done.length, refused: result.refused.length } } : { key: 'aih.done.dismissed', tone: 'success', params: { count: result.done.length } })
    void load()
  }

  const more = async () => {
    if (!list.nextBefore || list.loadingMore) return
    const mine = seq.current
    setList((current) => ({ ...current, loadingMore: true }))
    try {
      const answer = await listErrors(api, { view, before: list.nextBefore, limit: PAGE })
      if (mine !== seq.current) return
      setList((current) => ({ ...current, items: [...(current.items ?? []), ...answer.items], nextBefore: answer.nextBefore, loadingMore: false }))
    } catch (error) {
      if (mine === seq.current) setList((current) => ({ ...current, loadingMore: false }))
      setNotice({ key: problemKey(error), tone: 'danger', params: {} })
    }
  }

  const model = useMemo<ErrorQueueModel | null>(
    () => (options.canView ? { prefix: options.prefix, view, list, canManage, selected, open, dismiss, retryMany, busyId, notice, updates } : null),
    [options.canView, options.prefix, view, list, canManage, selected, open, dismiss, retryMany, busyId, notice, updates],
  )

  return {
    model,
    actions: {
      onView: (next) => {
        setSelected([])
        setView(next)
      },
      onSelect: setSelected,
      onOpen: go,
      onRetry: (item) => void retryOne(item),
      onRetryMany: (ids) => setRetryMany(ids ? { ids: [...ids], busy: false } : null),
      onRetryManyGo: () => void retryManyGo(),
      onDismiss: (ids) => setDismiss(ids ? { ids: [...ids], reason: '', busy: false, problem: null, tried: false } : null),
      onDismissReason: (reason) => setDismiss((current) => (current ? { ...current, reason } : current)),
      onDismissGo: () => void dismissGo(),
      onMore: () => void more(),
      onRetryRead: () => void load(),
      onShowUpdates: () => void load(),
      onDismissNotice: () => setNotice(null),
    },
  }
}
