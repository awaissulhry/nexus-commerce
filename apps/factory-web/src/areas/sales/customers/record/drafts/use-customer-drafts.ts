'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useOfficeApi } from '../../../../../lib/session/context'
import { useLiveBus } from '../../../../../shell/live/use-live'
import { useCoalesced } from '../../../orders/hooks'
import { useCatalogueOrder } from '../../../inquiries/use-catalogue-order'
import type { CatalogueActions, CatalogueModel } from '../../../inquiries/catalogue-model'
import { listCustomerDrafts, type DraftRow } from './api'
import { draftsTouched, draftTitle, type DraftsRead } from './model'

/**
 * F-CP-107 (customer page plan D10; 10-customer-page §6) — the reads of "Drafts of <customer>": the customer's portal drafts (B-CP-071's
 * walled list, only while the view is shown), live changes coalesced (800 ms) behind "N updates · Show" (rows never jump), and the
 * draft open in its read-only window — the Incoming container itself (useCatalogueOrder) in draft mode: one reader, no copy.
 */

const OFF: DraftsRead = { status: 'off' }
const READING: DraftsRead = { status: 'reading' }

export interface CustomerDrafts {
  readonly read: DraftsRead
  /** Live changes waiting behind "N updates · Show". */
  readonly updates: number
  /** The draft open in the window (its row), else null. */
  readonly open: DraftRow | null
  readonly window: { readonly model: CatalogueModel; readonly actions: CatalogueActions; readonly thread: ReactNode } | null
  readonly onRetry: () => void
  readonly onShowUpdates: () => void
  readonly onOpen: (row: DraftRow) => void
  readonly onGo: (id: string) => void
  readonly onClose: () => void
}

export function useCustomerDrafts(partyId: string, shown: boolean, untitled: string): CustomerDrafts {
  const api = useOfficeApi()
  const [read, setRead] = useState<DraftsRead>(shown ? READING : OFF)
  const [updates, setUpdates] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
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

  const rows = read.status === 'ready' ? read.rows : null
  const open = useMemo(() => (openId && rows ? (rows.find((row) => row.id === openId) ?? null) : null), [openId, rows])
  const catalogue = useCatalogueOrder({ requestId: open?.id ?? null, draft: open ? { title: draftTitle(open, untitled) } : null })
  return {
    read,
    updates,
    open,
    window: open ? catalogue : null,
    onRetry: load,
    onShowUpdates: load,
    onOpen: (row) => setOpenId(row.id),
    onGo: setOpenId,
    onClose: () => setOpenId(null),
  }
}
