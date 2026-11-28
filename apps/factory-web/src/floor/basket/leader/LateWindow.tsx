'use client'

import { Check, CircleAlert, Info, Layers, RotateCcw, SlidersHorizontal, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { FloorButton } from '@nexus/ui/floor'
import { Modal } from '../../../lib/i18n/ds-parts'
import { useFloorWords } from '../../../lib/floor-words/FloorWords'
import { useT } from '../../../lib/i18n/provider'
import { LATE_DAYS, LATE_REASONS, type LateReason } from '../api'
import { BASKET_NS } from '../parts'
import '../basket.css'

/**
 * owb-fl6 step 4 (design § 5zf C "Will be late (days + a reason)"; P/fplus.js flate) — the team leader's window on a basket: how many
 * days (1 · 2 · 3 · 5), then why (Material missing · Machine problem · People missing · Work again): the reason's tap sends it. "The
 * customer hears it from sales, not from the floor." A reason waits for the days (said on screen). View only.
 */

export const LATE_ICON: Readonly<Record<LateReason, ReactNode>> = { MATERIAL: <Layers />, MACHINE: <SlidersHorizontal />, PEOPLE: <Users />, REDO: <RotateCcw /> }

export interface LateWindowModel {
  readonly open: boolean
  readonly code: string
  readonly days: (typeof LATE_DAYS)[number] | null
  readonly said: string | null
  readonly busy: boolean
}

export type LateAction = { readonly type: 'close' } | { readonly type: 'days'; readonly days: (typeof LATE_DAYS)[number] } | { readonly type: 'reason'; readonly reason: LateReason }

export function LateWindow({ model, onAction }: { readonly model: LateWindowModel; readonly onAction: (action: LateAction) => void }) {
  const tb = useT(BASKET_NS)
  const fw = useFloorWords(BASKET_NS)
  const waits = model.busy ? tb('homePage.loading') : model.days === null ? tb('late.pickDays') : null
  return (
    <Modal open={model.open} onClose={() => onAction({ type: 'close' })} title={tb('late.title', { code: model.code })} size="sm" sheet className="fw-floor-dialog">
      <div className="fw-floor-dialog-body">
        <p className="fw-floor-dialog-line">{tb('late.howLate')}</p>
        <div className="fw-bk-days" role="group" aria-label={tb('late.howLate')}>
          {LATE_DAYS.map((days) => (
            <FloorButton key={days} size="lg" variant={model.days === days ? 'primary' : 'secondary'} aria-pressed={model.days === days} icon={model.days === days ? <Check /> : undefined} onClick={() => onAction({ type: 'days', days })}>
              {fw('late.days', { count: days })}
            </FloorButton>
          ))}
        </div>
        <p className="fw-floor-dialog-line">{tb('late.why')}</p>
        <div className="fw-bk-why" role="group" aria-label={tb('late.why')}>
          {LATE_REASONS.map((reason) => (
            <FloorButton key={reason} size="lg" variant="danger" icon={LATE_ICON[reason]} heldReason={waits} onClick={() => onAction({ type: 'reason', reason })}>
              {fw(`late.reason.${reason}`)}
            </FloorButton>
          ))}
        </div>
        {waits && !model.busy ? <p className="fw-bk-dock-note">{waits}</p> : null}
        {model.said ? (
          <p role="alert" className="fw-floor-notice" data-tone="danger">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <CircleAlert />
            </span>
            {model.said}
          </p>
        ) : null}
        <p className="fw-bk-muted">
          <Info aria-hidden="true" /> {tb('late.note')}
        </p>
      </div>
    </Modal>
  )
}
