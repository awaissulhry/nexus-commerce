'use client'

import { Banner } from '@nexus/ui/components'
import { SaveStatus } from '@nexus/ui/components/SaveStatus/index'
import { Button } from '@nexus/ui/primitives'
import { useDsLabels } from '../../../../lib/i18n/ds-labels'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { finishLaterHeld, type LinkDraftBand as Band } from '../model'
import '../drafts.css'

export interface LinkDraftBandProps {
  band: Band
  /** The form holds something worth keeping (Finish later is held, with why, until it does). */
  worthKeeping: boolean
  /** The form is larger than a draft may be. */
  tooBig?: boolean
  timeZone?: string
  onFinishLater?: () => void
  onRetry?: () => void
  /** The restored draft: go on with it. */
  onKeep?: () => void
  /** The restored draft: start the form again. */
  onStartAgain?: () => void
}

/**
 * B-W2b-169 — the link frame's "Finish later" band (design links.frame sec:drafts): where the draft kept with the
 * sender stands (DS SaveStatus: "All changes saved · 10:42"), "finish later from the same link until <the link's
 * expiry>; nothing is kept on this device", Finish later (held with why when there is nothing to keep), the restored
 * draft's banner (Go on · Start again), the "you may close the page" answer, and a link that stopped taking drafts.
 */
export function LinkDraftBand(props: LinkDraftBandProps) {
  return (
    <WithMessages namespaces={['link-frame', 'ds-words']}>
      <DraftBand {...props} />
    </WithMessages>
  )
}

function DraftBand({ band, worthKeeping, tooBig = false, timeZone, onFinishLater, onRetry, onKeep, onStartAgain }: LinkDraftBandProps) {
  const f = useT('link-frame')
  const locale = useLocale()
  const ds = useDsLabels(timeZone)
  const day = (iso: string) => formatDate(iso, { locale, timeZone })
  const time = (iso: string) => formatTime(iso, { locale, timeZone })
  const held = finishLaterHeld(band, worthKeeping, tooBig)
  return (
    <div className="fw-link-draft">
      {band.restoredAt && (
        <Banner
          tone="info"
          title={f('drafts.restored', { day: day(band.restoredAt), time: time(band.restoredAt) })}
          action={
            <span className="fw-link-draft-actions">
              <Button size="sm" onClick={() => onKeep?.()}>
                {f('drafts.keep')}
              </Button>
              <Button size="sm" variant="quiet" onClick={() => onStartAgain?.()}>
                {f('drafts.startAgain')}
              </Button>
            </span>
          }
        >
          {f('drafts.restoredBody')}
        </Banner>
      )}
      <div className="fw-link-draft-band">
        <SaveStatus state={band.status} onRetry={band.dead ? undefined : () => onRetry?.()} formatTime={time} locale={locale} size="sm" labels={ds.saveStatus} />
        <Button size="sm" variant="quiet" heldReason={held ? f(held) : null} onClick={() => onFinishLater?.()}>
          {f('drafts.later')}
        </Button>
      </div>
      {band.until && !band.dead && <p className="fw-link-draft-until">{f('drafts.until', { day: day(band.until) })}</p>}
      {tooBig && <Banner tone="warning" title={f('drafts.held.tooBig')} />}
      {band.later && band.status.kind === 'saved' && band.until && (
        <Banner tone="success" title={f('drafts.laterTitle')}>
          {f('drafts.laterBody', { day: day(band.until) })}
        </Banner>
      )}
      {band.dead && (
        <Banner tone="warning" title={f('drafts.deadTitle')}>
          {f('drafts.deadBody')}
        </Banner>
      )}
    </div>
  )
}
