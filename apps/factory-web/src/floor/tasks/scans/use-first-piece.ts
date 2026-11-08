'use client'

import { useCallback, useRef } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { useLiveChanges } from '../../../record-panels/live'
import { fetchFirstPiece } from './api'
import { firstPieceMessageFor, type FirstPieceFlag } from './first-piece'
import type { BundleCard } from './model'

/**
 * B-W2b-105 (design floor.operation live "First-piece approved → the hold lifts with a success flash"; floor.inline live "First
 * piece approved → the operation screens of that run lift their hold"): while a bundle is on screen, a first piece decided,
 * opened or cancelled elsewhere (`in_process_check.first_piece`, every tablet of the site through floor.work) makes the screen
 * read the bundle's flag again (`GET /quality/inprocess/first-piece`, production.scan), and so does a reconnect of the stream (a
 * hint may have been missed). A message is only a hint: the read decides. Offline nothing is read; the hold stays as known.
 */
export function useFirstPieceLive(card: BundleCard | null, api: ApiClient, online: boolean, onRead: (card: BundleCard, flag: FirstPieceFlag | null) => void): void {
  const shown = useRef(card)
  shown.current = card
  const read = useCallback(async () => {
    const now = shown.current
    if (!now || !online) return
    const answer = await fetchFirstPiece(api, now.bundle.id)
    // Another bundle came on screen meanwhile: this answer is not its own.
    if (answer.ok && shown.current?.bundle.id === now.bundle.id) onRead(now, answer.value)
  }, [api, online, onRead])
  useLiveChanges(
    {
      onChange: (change) => {
        const now = shown.current
        if (now && firstPieceMessageFor(change, now)) void read()
      },
      onReconnect: () => void read(),
    },
    card !== null && online,
  )
}
