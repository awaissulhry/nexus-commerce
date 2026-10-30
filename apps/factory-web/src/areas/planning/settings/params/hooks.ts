'use client'

import { useCallback, useRef, useState } from 'react'
import { ECHO_MS, markKey, type Mark } from './model'

const SAVED_FADE_MS = 1500

/** The cells' save marks (DS CellSaveMark shapes): set one, and let a "saved" fade after a moment. */
export function useMarks() {
  const [marks, setMarks] = useState<Record<string, Mark>>({})
  const setMark = useCallback(
    (rowKey: string, field: string, mark: Mark | null) =>
      setMarks((current) => {
        const next = { ...current }
        if (mark) next[markKey(rowKey, field)] = mark
        else delete next[markKey(rowKey, field)]
        return next
      }),
    [],
  )
  const fade = useCallback((rowKey: string, field: string) => {
    setTimeout(() => setMarks((current) => (current[markKey(rowKey, field)]?.state === 'saved' ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== markKey(rowKey, field))) : current)), SAVED_FADE_MS)
  }, [])
  const failedCount = Object.values(marks).filter((mark) => mark.state === 'refused' || mark.state === 'unknown').length
  return { marks, setMark, fade, failedCount }
}

/** One queue per row: a row's writes wait for each other, so the next carries the version the last one made. */
export function useRowQueue() {
  const queues = useRef(new Map<string, Promise<unknown>>())
  return useCallback(<T,>(rowKey: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.current.get(rowKey) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(work)
    queues.current.set(rowKey, run)
    void run
      .catch(() => undefined)
      .finally(() => {
        if (queues.current.get(rowKey) === run) queues.current.delete(rowKey)
      })
    return run
  }, [])
}

/**
 * The live messages our own writes cause: a write tells it is on its way (`expect(id)`); a live message about that id
 * within a few seconds is ours (`isOurs(id)` true once), anything else is "changed by someone else".
 */
export function useEchoes() {
  const waiting = useRef(new Map<string, number[]>())
  const expect = useCallback((id: string) => {
    const list = waiting.current.get(id) ?? []
    waiting.current.set(id, [...list, Date.now() + ECHO_MS])
  }, [])
  const isOurs = useCallback((id: string | null | undefined): boolean => {
    if (!id) return false
    const now = Date.now()
    const list = (waiting.current.get(id) ?? []).filter((until) => until > now)
    if (list.length === 0) {
      waiting.current.delete(id)
      return false
    }
    waiting.current.set(id, list.slice(1))
    return true
  }, [])
  /** A write of ours to a site-wide row (settings): any message of that site for a moment. */
  return { expect, isOurs }
}
