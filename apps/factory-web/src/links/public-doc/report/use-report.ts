'use client'

import { useCallback, useEffect, useState } from 'react'
import type { PublicDocPage } from '@nexus/factory-domain/compliance/public-doc/contracts'
import type { ApiClient } from '../../../lib/api/client'
import { romeToday } from '../../../lib/safety-reports/intake'
import { uploadSafetyPhoto } from '../../../lib/safety-reports/photos'
import { useReportDialog } from '../../../lib/safety-reports/use-dialog'
import { publicPhotoDoor, readPublicStatus, sendPublicReport } from './api'
import type { DoorState, PublicReportActions, PublicReportModel } from './model'

/**
 * The container of links.doc › Report a problem (B-W2b-357), for PublicDoc.tsx: reads whether the public door is open once a
 * page is found (`GET /public/safety-reports/status`), runs the shared dialog (lib/safety-reports/use-dialog: ONE
 * Idempotency-Key per body, a refusal in words) with the page's code and `n`, a 429 `challenge` solved once, and the photos
 * after the send with the signed ticket the send gave, until its time is over. A `held/OFF` at the send (the company's
 * privacy notice is not in force) closes the door on the page too. Nothing is kept in the browser.
 */
export function usePublicReport(api: ApiClient, page: PublicDocPage | null): { model: PublicReportModel; actions: PublicReportActions } {
  const [door, setDoor] = useState<DoorState>('loading')
  const [ticket, setTicket] = useState<string | null>(null)
  const today = romeToday()
  const batch = page?.product.batch?.number ?? null
  const found = page !== null

  const readDoor = useCallback(async () => {
    setDoor('loading')
    try {
      setDoor((await readPublicStatus(api)) ? 'open' : 'closed')
    } catch {
      setDoor('failed')
    }
  }, [api])

  useEffect(() => {
    if (found) void readDoor()
  }, [found, readDoor])

  const dialog = useReportDialog({
    door: 'public',
    today,
    fixedBatch: batch,
    send: async (body, key, onChecking) => {
      if (!page) throw new Error('No page')
      const answer = await sendPublicReport(api, { code: page.code, n: page.n }, body, key, { onChecking })
      setTicket(answer.photos.ticket)
      return { number: answer.sent.number, photos: { until: answer.photos.until, max: answer.photos.max } }
    },
    upload: (photo, keys) => uploadSafetyPhoto(api, publicPhotoDoor(ticket ?? ''), photo, keys),
    onRefused: (refusal) => {
      if (refusal.key === 'refused.off') setDoor('closed')
    },
  })

  return {
    model: {
      door,
      contact: page?.contact.email ? { name: page.sender.companyName ?? null, email: page.contact.email } : null,
      batch,
      keeper: page?.sender.companyName ?? null,
      today,
      camera: true,
      dialog: dialog.model,
    },
    actions: {
      ...dialog.actions,
      onRetryDoor: () => void readDoor(),
      onOpen: () => {
        if (door !== 'open') return
        setTicket(null)
        dialog.open()
      },
    },
  }
}
