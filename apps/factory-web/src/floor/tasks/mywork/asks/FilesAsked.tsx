'use client'

import { useCallback, useEffect, useState } from 'react'
import { useFloor } from '../../../FloorApp'
import { fetchFloorAsks, sendAskPhoto } from './api'
import { outcomeOf, type AskPhotoOutcome, type FloorAsk } from './model'
import { FilesAskedView, type FilesAskedAction } from './view/FilesAskedView'

/** How often the open asks are read again while My work shows (the office may ask, chase or cancel meanwhile). */
const REREAD_MS = 60_000

/**
 * F-OF-204 (order FILES tab W2; 13-backend B-OF-034) — the container of "Files asked" on My work: reads the tablet's open asks (on view,
 * back online, every minute, after a send), opens the camera for one, sends the photo (online only: up to the work order, then the note
 * with the ask) and says what came of it; an ask closed meanwhile still gets the photo as a note on its work order.
 */
export function FilesAsked() {
  const { api, online } = useFloor()
  const [asks, setAsks] = useState<readonly FloorAsk[] | null>(null)
  const [capture, setCapture] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ readonly askId: string; readonly outcome: AskPhotoOutcome } | null>(null)

  const read = useCallback(async () => {
    if (!online) return
    const answer = await fetchFloorAsks(api)
    if (answer.ok) setAsks(answer.value)
  }, [api, online])
  useEffect(() => {
    void read()
    const timer = setInterval(() => void read(), REREAD_MS)
    return () => clearInterval(timer)
  }, [read])

  const onAction = (action: FilesAskedAction) => {
    if (action.type === 'photo') {
      setOutcome(null)
      return setCapture(online ? action.askId : null)
    }
    if (action.type === 'dismiss') return setOutcome(null)
    const ask = asks?.find((one) => one.askId === action.askId)
    setCapture(null)
    if (!ask || busy || !online) return
    setBusy(true)
    void sendAskPhoto(api, ask, action.photo.marked ?? action.photo.photo, globalThis.crypto.randomUUID())
      .then((sent) => setOutcome({ askId: ask.askId, outcome: outcomeOf(sent.ok ? { ok: true, answered: sent.value.answered } : { ok: false }) }))
      .finally(() => {
        setBusy(false)
        void read()
      })
  }

  return <FilesAskedView model={{ asks, online, capture, busy, outcome }} onAction={onAction} />
}
