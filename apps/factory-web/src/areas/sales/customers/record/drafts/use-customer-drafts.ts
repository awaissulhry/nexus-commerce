'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { companyPrefix } from '../../../../../lib/session/session'
import { useLiveBus } from '../../../../../shell/live/use-live'
import { useCoalesced } from '../../../orders/hooks'
import { listCustomerDrafts, type DraftRow } from './api'
import { draftsTouched, officeDraftHref, type DraftsRead } from './model'

/**
 * F-CP-107 (customer page plan D10; 10-customer-page §6) — the reads of "Drafts of <customer>": the customer's portal drafts (B-CP-071's
 * walled list, only while the view is shown) and live changes coalesced (800 ms) behind "N updates · Show" (rows never jump).
 * od-w2.3 / od-fx5: a row opens the office draft page (`officeDraftHref`), where the office writes and confirms it — the read-only
 * window is gone; the customer's own decisions stay with Incoming's catalogue pane (a draft draws none there).
 */

const OFF: DraftsRead = { status: 'off' }
const READING: DraftsRead = { status: 'reading' }

export interface CustomerDrafts {
  readonly read: DraftsRead
  /** Live changes waiting behind "N updates · Show". */
  readonly updates: number
  readonly onRetry: () => void
  readonly onShowUpdates: () => void
  /** od-w2.3: a row opens the office draft page, EDITABLE (was the read-only window). */
  readonly onOpen: (row: DraftRow) => void
}

export function useCustomerDrafts(partyId: string, shown: boolean): CustomerDrafts {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const [read, setRead] = useState<DraftsRead>(shown ? READING : OFF)
  const [updates, setUpdates] = useState(0)
  const turn = useRef(0)

  const load = useCallback(() => {
    if (!shown) {
      setRead(OFF)
      return
    }
    const mine = ++turn.current
    setRead((now) => (now.status === 'ready' ? now : READING))
    setUpdates(0)
    listCustomerDrafts(api, partyId).then(
      (rows) => mine === turn.current && setRead({ status: 'ready', rows }),
      () => mine === turn.current && setRead({ status: 'failed' }),
    )
  }, [api, partyId, shown])
  useEffect(() => load(), [load])

  // Live: each change counted, coalesced; the rows are read again only on "Show" (or a reconnect: everything again).
  const pending = useRef(0)
  const flush = useCoalesced(() => {
    const count = pending.current
    pending.current = 0
    if (count > 0) setUpdates((now) => now + count)
  }, 800)
  useLiveBus(
    {
      onChange: (change) => {
        if (!draftsTouched(change.type)) return
        pending.current += 1
        flush()
      },
      onReconnect: load,
    },
    shown,
  )

  return {
    read,
    updates,
    onRetry: load,
    onShowUpdates: load,
    onOpen: (row) => router.push(officeDraftHref(companyPrefix(session.company?.code ?? ''), row.id)),
  }
}
