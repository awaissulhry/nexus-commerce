'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { failedRead, reading, ready } from '../_shared/model'
import { pickRecords, type PickOption } from './api'
import type { ChipKind } from './constants'
import { problemOf } from './model'
import type { ChipSearch } from './view/parts'

/**
 * The chip editor's search (ONE hook for "Applies to" and a rule's chips): the kind picked and the words typed; a record's
 * own list is read 250 ms after the last key (a category needs no read). The answer of an older search is dropped.
 */
export function useChipSearch(api: ApiClient) {
  const [search, setSearch] = useState<ChipSearch | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const controller = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      controller.current?.abort()
    },
    [],
  )
  const onSearch = useCallback(
    (kind: ChipKind, q: string) => {
      if (timer.current) clearTimeout(timer.current)
      controller.current?.abort()
      if (kind === 'CATEGORY') {
        setSearch({ kind, q: '', read: null })
        return
      }
      setSearch({ kind, q, read: reading() })
      timer.current = setTimeout(() => {
        const own = new AbortController()
        controller.current = own
        pickRecords(api, kind, q, own.signal)
          .then((options: PickOption[]) => !own.signal.aborted && setSearch({ kind, q, read: ready(options) }))
          .catch((error: unknown) => !own.signal.aborted && setSearch({ kind, q, read: failedRead(problemOf(error)) }))
      }, 250)
    },
    [api],
  )
  const clear = useCallback(() => setSearch(null), [])
  return { search, onSearch, clear }
}
