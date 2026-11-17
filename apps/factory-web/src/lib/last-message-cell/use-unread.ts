'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { unreadAsk, unreadMapOf, type UnreadAsk, type UnreadMap } from './model'

/** The read itself (the page's own API client: the office's or the portal's; POST /threads/unread). */
export type ReadUnread = (records: readonly UnreadAsk[], signal: AbortSignal) => Promise<ReadonlyArray<{ readonly recordId: string; readonly newCount: number; readonly lastAt: string | null }>>

/**
 * B-TH-230: the new-message counts of the rows a list shows — ONE read per page (the rows' ids as their key), again when `refresh`
 * changes (a live message on one of them), debounced so a burst of live changes is one read. A failed read leaves the cells empty
 * (a count is a convenience: the thread itself still says what is new). Null `read`: the reader may not read threads (no column).
 */
export function useUnread(read: ReadUnread | null, rows: ReadonlyArray<{ readonly recordType: string; readonly id: string }>, refresh = 0): UnreadMap {
  const [map, setMap] = useState<UnreadMap>({})
  const asked = useMemo(() => unreadAsk(rows), [rows])
  const key = asked.map((one) => `${one.recordType}:${one.recordId}`).join(',')
  const readRef = useRef(read)
  readRef.current = read
  useEffect(() => {
    const reader = readRef.current
    if (!reader || asked.length === 0) {
      setMap({})
      return
    }
    const abort = new AbortController()
    const timer = setTimeout(() => {
      reader(asked, abort.signal)
        .then((counts) => !abort.signal.aborted && setMap(unreadMapOf(counts)))
        .catch(() => undefined)
    }, 250)
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
    // The rows' ids (the key) and the refresh token decide; the array itself is new on every render.
  }, [key, refresh, read === null])
  return map
}
