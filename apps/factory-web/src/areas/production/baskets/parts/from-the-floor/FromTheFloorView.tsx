'use client'

import { CalendarClock, Check, Clock, Eye, EyeOff, Factory, Route, Share2 } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { FromTheFloor } from '../../api'
import { BASKETS_NAMESPACE } from '../../model'
import { isEmpty, lateOpen, newestFirst } from './model'
import '../../baskets.css'

/**
 * owb-fl9 step 4 — the part "From the floor" (design § 5zf D): the floor's photos with **Share with the customer** / **Keep inside**,
 * "Changed on the floor" (who, what, why), and Will be late with **The date holds** / **Change the promise…**. Empty → one sentence.
 * Office only. The view fetches nothing (FromTheFloorPart.tsx reads and sends).
 */

export interface FromTheFloorModel {
  readonly state: 'loading' | 'ready' | 'failed'
  readonly read: FromTheFloor | null
  readonly canShare: boolean
  readonly canAnswer: boolean
  /** Photos kept inside on this page (Keep inside calls nothing). */
  readonly keptInside: readonly string[]
  readonly busy: string | null
  readonly problem: string | null
}

export interface FromTheFloorActions {
  readonly onShare: (fileId: string) => void
  readonly onKeep: (fileId: string) => void
  readonly onHolds: (lateId: string) => void
  readonly onChange: (lateId: string) => void
}

export function FromTheFloorView({ model, actions }: { model: FromTheFloorModel; actions: FromTheFloorActions }) {
  const t = useT(BASKETS_NAMESPACE)
  const locale = useLocale()
  const when = (at: string) => formatDateTime(at, { locale })
  const read = model.read
  return (
    <section className="fw-ff" aria-labelledby="fw-ff-title">
      <h3 id="fw-ff-title" className="fw-bb-wh">
        <Factory aria-hidden className="fw-bb-icon" /> {t('floor.title')}
      </h3>
      {model.state === 'loading' ? <p className="fw-bb-muted">{t('floor.loading')}</p> : null}
      {model.state === 'failed' ? <p className="fw-bb-muted">{t('floor.failed')}</p> : null}
      {model.problem ? <Banner tone="danger" title={model.problem} /> : null}
      {read && model.state === 'ready' && isEmpty(read) ? <p className="fw-bb-muted">{t('floor.empty')}</p> : null}

      {read && read.late.length > 0 ? (
        <div className="fw-ff-block">
          <h4 className="fw-ff-h">
            <CalendarClock aria-hidden className="fw-bb-icon" /> {t('floor.late')}
          </h4>
          <ul className="fw-ff-list">
            {newestFirst(read.late).map((late) => (
              <li key={late.id} className="fw-ff-row">
                <div className="fw-ff-what">
                  <Pill tone={lateOpen(late) ? 'danger' : 'neutral'} icon={<Clock aria-hidden />}>
                    {t('floor.lateDays', { count: late.days })}
                  </Pill>
                  <span>{t(`lateReason.${late.reason}`)}</span>
                  <bdi className="fw-bb-code">{late.basketCodes.join(', ')}</bdi>
                  <span className="fw-bb-muted">{when(late.at)}</span>
                </div>
                {lateOpen(late) && model.canAnswer ? (
                  <div className="fw-bb-targets">
                    <Button size="sm" heldReason={model.busy === late.id ? t('window.busy') : null} onClick={() => actions.onHolds(late.id)}>
                      <Check aria-hidden /> {t('floor.holds')}
                    </Button>
                    <Button size="sm" variant="primary" heldReason={model.busy === late.id ? t('window.busy') : null} onClick={() => actions.onChange(late.id)}>
                      <CalendarClock aria-hidden /> {t('floor.changePromise')}
                    </Button>
                  </div>
                ) : (
                  <Pill tone={late.state === 'KEPT' ? 'success' : late.state === 'CHANGED' ? 'info' : 'warning'}>{t(`lateState.${late.state}`)}</Pill>
                )}
              </li>
            ))}
          </ul>
          <p className="fw-bb-muted">{t('floor.lateNote')}</p>
        </div>
      ) : null}

      {read && read.photos.length > 0 ? (
        <div className="fw-ff-block">
          <h4 className="fw-ff-h">{t('floor.photos')}</h4>
          <ul className="fw-ff-photos">
            {newestFirst(read.photos).map((photo) => {
              const kept = model.keptInside.includes(photo.fileId)
              return (
                <li key={photo.fileId} className="fw-ff-photo">
                  <span className="fw-ff-img" aria-hidden>
                    {photo.src ? <img src={photo.src} alt="" /> : null}
                  </span>
                  <span className="fw-bb-muted">
                    {photo.basketCode ? <bdi className="fw-bb-code">{photo.basketCode}</bdi> : null} {when(photo.at)}
                  </span>
                  {photo.shared ? (
                    <Pill tone="success" icon={<Eye aria-hidden />}>
                      {t('floor.shared')}
                    </Pill>
                  ) : kept ? (
                    <Pill tone="neutral" icon={<EyeOff aria-hidden />}>
                      {t('floor.kept')}
                    </Pill>
                  ) : model.canShare ? (
                    <span className="fw-bb-targets">
                      <Button size="sm" variant="primary" heldReason={model.busy === photo.fileId ? t('window.busy') : null} onClick={() => actions.onShare(photo.fileId)}>
                        <Share2 aria-hidden /> {t('floor.share')}
                      </Button>
                      <Button size="sm" onClick={() => actions.onKeep(photo.fileId)}>
                        <EyeOff aria-hidden /> {t('floor.keep')}
                      </Button>
                    </span>
                  ) : (
                    <Pill tone="neutral" icon={<EyeOff aria-hidden />}>
                      {t('floor.inside')}
                    </Pill>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}

      {read && read.changes.length > 0 ? (
        <div className="fw-ff-block">
          <h4 className="fw-ff-h">
            <Route aria-hidden className="fw-bb-icon" /> {t('floor.changed')}
          </h4>
          <ul className="fw-ff-list">
            {newestFirst(read.changes).map((change, index) => (
              <li key={`${change.at}-${index}`} className="fw-ff-row">
                <div className="fw-ff-what">
                  <bdi className="fw-bb-code">{change.basketCodes.join(', ')}</bdi>
                  <span>{change.words}</span>
                  {change.reason ? <span className="fw-bb-muted">{t('floor.why', { why: t(`changeReason.${change.reason}`) })}</span> : null}
                </div>
                <span className="fw-bb-muted">{[change.who, when(change.at)].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
