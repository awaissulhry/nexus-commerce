'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useT } from '../../../../lib/i18n/provider'
import { NS, romeToday } from '../../../../lib/safety-reports/intake'
import { uploadSafetyPhoto } from '../../../../lib/safety-reports/photos'
import { useReportDialog } from '../../../../lib/safety-reports/use-dialog'
import { ReportDialog } from '../../../../lib/safety-reports/view/ReportDialog'
import { WithMessages } from '../../../../record-panels/i18n'
import { portalPhotoDoor, readPortalSafetyStatus, sendPortalSafetyReport } from './api'
import { safetyHeldOf, type SafetyDoor } from './model'

/**
 * Report a safety incident on the customer's Returns & claims (B-W2b-357), for ReturnsPage.tsx: reads the portal's door once
 * (`GET /portal/safety-reports/status`), says why its openers wait (`heldText`), runs the shared dialog — the report for the
 * person's own customer (`POST /portal/safety-reports`, one Idempotency-Key per body) and the photos after the send when the
 * role uploads (its own report, in its window) — and draws it (`dialog`). A `held/OFF` at the send closes the openers too.
 */
export function usePortalSafety(input: { api: ApiClient; offline: boolean; preview: boolean; keeper: string | null }): {
  heldText: string | null
  label: string
  open: () => void
  dirty: boolean
  dialog: ReactNode
} {
  const t = useT(NS)
  const [door, setDoor] = useState<SafetyDoor>({ state: 'loading' })
  const reportId = useRef<string | null>(null)
  const today = romeToday()

  const read = useCallback(async () => {
    try {
      setDoor({ state: 'read', status: await readPortalSafetyStatus(input.api) })
    } catch {
      setDoor({ state: 'failed' })
    }
  }, [input.api])
  useEffect(() => {
    void read()
  }, [read])

  const dialog = useReportDialog({
    door: 'portal',
    today,
    fixedBatch: null,
    offline: input.offline,
    send: async (body, key) => {
      const answer = await sendPortalSafetyReport(input.api, body, key)
      reportId.current = answer.report.id
      return { number: answer.sent.number, photos: answer.photos.mayUpload ? { until: answer.photos.until, max: answer.photos.max } : null }
    },
    upload: (photo, keys) => uploadSafetyPhoto(input.api, portalPhotoDoor(reportId.current ?? ''), photo, keys),
    onRefused: (refusal) => {
      if (refusal.key === 'refused.offPortal') void read()
    },
  })

  const held = safetyHeldOf(door, { offline: input.offline, preview: input.preview })
  return {
    heldText: held ? t(held) : null,
    label: t('portal.open'),
    open: () => {
      if (held) return
      reportId.current = null
      dialog.open()
    },
    dirty: dialog.dirty,
    dialog: dialog.model ? (
      <WithMessages namespaces={[NS, 'ds-words']}>
        <ReportDialog model={{ dialog: dialog.model, door: 'portal', fixedBatch: null, today, keeper: input.keeper, camera: true, contact: null, offline: input.offline }} actions={dialog.actions} />
      </WithMessages>
    ) : null,
  }
}
