'use client'

import { CircleAlert, X } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { TaskLine } from '../../../tasks/shared/view/TaskParts'
import { SPOTS } from '../model'
import '../help2.css'

/**
 * owb-fl8 step 1 — "Show the place" (design § 5zf B; P/fplus.js fplusModal 'spot'): the basket's picture with nine places (three by
 * three, 48 px or more each); one tap marks the place of the problem and closes. Offered only where the server keeps the place.
 */
export interface SpotWindowProps {
  readonly open: boolean
  readonly basketCode: string
  readonly picture: string | null
  readonly value: number | null
  readonly busy: boolean
  readonly failed: string | null
  readonly onPick: (spot: number) => void
  readonly onClose: () => void
}

export function SpotWindow({ open, basketCode, picture, value, busy, failed, onPick, onClose }: SpotWindowProps) {
  const t = useT('floor-help2')
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('spot.title', { code: basketCode })}
      size="md"
      sheet
      className="fw-floor-dialog"
      footer={
        <FloorButton size="lg" variant="quiet" icon={<X />} onClick={onClose}>
          {t('window.close')}
        </FloorButton>
      }
    >
      <div className="fw-h2-window">
        <p className="fw-floor-lead">{t('spot.lead')}</p>
        <div className="fw-h2-spots">
          {picture ? <img src={picture} alt="" /> : null}
          <div className="fw-h2-spot-grid" role="group" aria-label={t('spot.lead')}>
            {SPOTS.map((spot) => (
              <button key={spot} type="button" aria-pressed={value === spot} aria-label={t('spot.place', { no: spot + 1 })} aria-disabled={busy || undefined} aria-description={busy ? t('window.sending') : undefined} onClick={busy ? undefined : () => onPick(spot)} />
            ))}
          </div>
        </div>
        {failed ? (
          <TaskLine tone="danger" icon={<CircleAlert />} alert>
            {failed}
          </TaskLine>
        ) : null}
      </div>
    </Modal>
  )
}
