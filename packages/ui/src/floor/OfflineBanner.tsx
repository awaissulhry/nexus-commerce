'use client'

/**
 * OfflineBanner — online or offline, and how many actions wait on this tablet (gap G2, SCR-022, A2 §3.1 "Offline").
 *
 * Every floor action is saved on the tablet first and sent after. While offline the banner never leaves; the waiting
 * count is drawn as a big number. Refused actions turn it red and offer the sync queue (SCR-023). Once online with
 * nothing waiting it goes away, unless `showWhenSynced`. Rules: `offlineBannerModel.ts`.
 *
 * A polite live region: a screen reader hears the change to offline and back, not every count.
 *
 * Every word comes from the app; `lastSyncLabel` is already formatted in the person's language ("Ultimo invio 10:42").
 */
import { CloudOff, CloudUpload, OctagonAlert, CircleCheck } from 'lucide-react'

import { FloorButton } from './FloorButton'
import { offlineBannerState } from './offlineBannerModel'
import './floor.css'

export interface OfflineBannerProps {
  online: boolean
  /** Actions saved here, not yet accepted by the office. */
  pending: number
  /** Actions the office refused. */
  refused?: number
  /** "Offline — il lavoro resta sul tablet". */
  offlineLabel: string
  /** "Invio in corso" — online, still sending. */
  sendingLabel: string
  /** The words beside the big number, for that count: (3) => "da inviare" (plural forms are the app's). */
  pendingLabel: (count: number) => string
  /** "1 rifiutata". Needed when `refused` can be above 0. */
  refusedLabel?: (count: number) => string
  /** "Tutto inviato" — shown only with `showWhenSynced`. */
  syncedLabel?: string
  /** "Ultimo invio 10:42" — formatted by the app. */
  lastSyncLabel?: string
  /** Opens the sync queue (SCR-023). */
  onOpenQueue?: () => void
  /** The queue button's words ("Apri coda"). */
  queueLabel?: string
  /** Keep a quiet "all sent" line once nothing waits. Default false. */
  showWhenSynced?: boolean
}

const ICON = { offline: CloudOff, refused: OctagonAlert, sending: CloudUpload, synced: CircleCheck } as const

export function OfflineBanner({
  online,
  pending,
  refused,
  offlineLabel,
  sendingLabel,
  pendingLabel,
  refusedLabel,
  syncedLabel,
  lastSyncLabel,
  onOpenQueue,
  queueLabel,
  showWhenSynced,
}: OfflineBannerProps) {
  const s = offlineBannerState({ online, pending, refused, showWhenSynced })
  const Icon = ICON[s.kind]
  const title = s.kind === 'offline' ? offlineLabel : s.kind === 'synced' ? (syncedLabel ?? '') : s.kind === 'refused' && refusedLabel ? refusedLabel(s.refused) : sendingLabel
  return (
    <div className="nds-floor-offline" data-tone={s.tone} data-kind={s.kind} role="status" aria-live="polite" hidden={!s.visible}>
      {s.visible ? (
        <>
          <span className="nds-floor-icon nds-floor-offline-icon" aria-hidden>
            <Icon />
          </span>
          <span className="nds-floor-offline-text">
            <span className="nds-floor-offline-title">{title}</span>
            {lastSyncLabel ? <span className="nds-floor-offline-meta">{lastSyncLabel}</span> : null}
          </span>
          {s.pending > 0 ? (
            <span className="nds-floor-offline-count">
              <span className="nds-floor-offline-number">{s.pending}</span>
              <span className="nds-floor-offline-count-label">{pendingLabel(s.pending)}</span>
            </span>
          ) : null}
          {s.kind === 'offline' && s.refused > 0 && refusedLabel ? <span className="nds-floor-offline-refused">{refusedLabel(s.refused)}</span> : null}
          {onOpenQueue && queueLabel && (s.pending > 0 || s.refused > 0) ? (
            <FloorButton size="sm" variant={s.kind === 'refused' ? 'danger' : 'secondary'} onClick={onOpenQueue} className="nds-floor-offline-action">
              {queueLabel}
            </FloorButton>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
