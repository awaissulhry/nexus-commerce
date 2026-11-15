'use client'

import { Banner } from '@nexus/ui/components'
import { Pill } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Words } from '../../queue/shared/depth'
import { DepthDialog } from '../../queue/shared/DepthDialog'
import { DISPATCH_NAMESPACES, DISPATCH_NS } from '../../pickup/dispatch'
import { handOverOf, type HandOverModel } from '../model'
import '../../shipments.css'
import '../../queue/shared/depth.css'
import '../../pickup/dispatch.css'

const TONE = { done: 'success', refused: 'danger', skipped: 'neutral' } as const

/**
 * SCR-655 (part) — Mark handed over (B-W2b-412; design sh-grid#4 selection row "'Mark handed over' (manual carriers)"): the
 * picked shipments that are packed with their DDT leave with our own van or a carrier booked by hand — each its own hand-over
 * (W1's `…/ship`), the outcome per shipment in words; a shipment the customer's own carrier collects is done inside it (who
 * collected, the plate, the signed DDT).
 */
export function HandOverDialog({ model, onGo, onClose }: { model: HandOverModel; onGo?: () => void; onClose?: () => void }) {
  return (
    <WithMessages namespaces={DISPATCH_NAMESPACES}>
      <Dialog model={model} onGo={onGo} onClose={onClose} />
    </WithMessages>
  )
}

function Dialog({ model, onGo, onClose }: { model: HandOverModel; onGo?: () => void; onClose?: () => void }) {
  const t = useT(DISPATCH_NS)
  const say = (value: Words) => t(value.key, value.params)
  const plan = handOverOf(model.picked)
  const held = !model.can.manage ? t('handOver.held.noRight') : plan.go.length === 0 ? t('handOver.held.none') : model.busy ? t('handOver.held.busy') : null
  const done = model.outcomes ? (
    <ul className="fw-shd-hold-list" role="status">
      {model.outcomes.map((outcome) => (
        <li key={outcome.id} className="fw-shd-part">
          <strong>{outcome.number}</strong>
          <span className="fw-shd-actions">
            <span className="fw-sh-hint">{say(outcome.words)}</span>
            <Pill tone={TONE[outcome.state]}>{t(`handOver.state.${outcome.state}`)}</Pill>
          </span>
        </li>
      ))}
    </ul>
  ) : undefined
  return (
    <DepthDialog title={t('handOver.title', { count: plan.go.length })} held={held} onGo={() => onGo?.()} goLabel={t('handOver.go', { count: plan.go.length })} onClose={() => onClose?.()} problem={null} done={done}>
      <p className="fw-sh-hint">{t('handOver.body')}</p>
      {plan.go.length > 0 && <p>{t('handOver.going', { numbers: plan.go.map((row) => row.number).join(', ') })}</p>}
      {plan.skipped.length > 0 && (
        <Banner tone="info" title={t('handOver.skipped', { count: plan.skipped.length })}>
          <ul className="fw-sh-list">
            {plan.skipped.map((entry) => (
              <li key={entry.row.id}>
                {entry.row.number}: {say(entry.why)}
              </li>
            ))}
          </ul>
        </Banner>
      )}
    </DepthDialog>
  )
}
