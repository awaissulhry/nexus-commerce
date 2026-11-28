'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReadOrderLog } from './api'
import { CHANGE_LOG_START, withPage, type ChangeLogState } from './model'

/**
 * owb-b4 w4.4 — the log's reads through the host's port (`orderLogReader(api, orderLogPath(door, record, id))`): the first page when
 * it mounts (and again when the port changes: another order), "Load more" by the answer's cursor, "Try again" after a failed read.
 * NOT in `view/`: a view fetches nothing. No port: nothing is read (the log says it reads).
 */
export function useChangeLog(read: ReadOrderLog | null | undefined): { readonly state: ChangeLogState; readonly onMore: () => void; readonly onRetry: () => void } {
  const [state, setState] = useState<ChangeLogState>(CHANGE_LOG_START)
  const [turn, setTurn] = useState(0)
  const latest = useRef(state)
  latest.current = state
  const more = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!read) return
    const controller = new AbortController()
    more.current?.abort()
    setState(CHANGE_LOG_START)
    read(null, controller.signal).then(
      (page) => !controller.signal.aborted && setState((current) => withPage(current, page, true)),
      () => !controller.signal.aborted && setState((current) => ({ ...current, status: 'failed' })),
    )
    return () => controller.abort()
  }, [read, turn])

  useEffect(() => () => more.current?.abort(), [])

  const onMore = useCallback(() => {
    const now = latest.current
    if (!read || !now.cursor || now.more === 'reading') return
    const controller = new AbortController()
    more.current = controller
    setState((current) => ({ ...current, more: 'reading' }))
    read(now.cursor, controller.signal).then(
      (page) => !controller.signal.aborted && setState((current) => withPage(current, page, false)),
      () => !controller.signal.aborted && setState((current) => ({ ...current, more: 'failed' })),
    )
  }, [read])

  const onRetry = useCallback(() => {
    if (latest.current.status === 'failed') setTurn((now) => now + 1)
    else onMore()
  }, [onMore])

  return { state, onMore, onRetry }
}
