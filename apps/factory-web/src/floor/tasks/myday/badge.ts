'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { useLiveChanges } from '../../../record-panels/live'
import { readAnswers } from './api'
import { readSeen, unreadAnswers } from './model'

/**
 * The My day tile's badge (design floor.myday "a dispute answered → a badge on the My day tile"): how many answers wait for the
 * person signed in. The read needs no PIN and says nothing but the number; the event names nobody, it only says "read again".
 */
export function useMyDayBadge(api: ApiClient, enabled: boolean, person: string | null): number {
  const [waiting, setWaiting] = useState(0)
  const read = useCallback(async () => {
    const answer = await readAnswers(api)
    if (answer.ok) setWaiting(unreadAnswers(answer.value.ids, readSeen()))
  }, [api])
  useEffect(() => {
    setWaiting(0)
    if (enabled) void read()
  }, [enabled, read, person])
  useLiveChanges({ onChange: (change) => void (change.type === 'labour_dispute.answered' && read()), onReconnect: () => void read() }, enabled)
  return waiting
}
