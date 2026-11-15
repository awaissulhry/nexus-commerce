'use client'

import type { ReactNode } from 'react'
import { Banner, Card } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { StepUpModal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import type { Words } from '../../shipments/queue/shared/depth'
import { DISPATCH_NS } from '../../shipments/pickup/dispatch'

/**
 * The frame every Carriers & shipping card of B-W2b-412 shares (SCR-656 … SCR-659): a card with its heading, what it is for,
 * the last write in words and a refused write in words; and the fresh-code dialog a write that asks a step-up opens (the
 * DS StepUpModal, its words in this catalogue). Draws what it is given; fetches nothing.
 */

export interface StepUpView {
  readonly open: boolean
  readonly busy: boolean
  /** A message key of what the code allows. */
  readonly sentence: string
  readonly problem: string | null
}

export const STEP_UP_SHUT: StepUpView = Object.freeze({ open: false, busy: false, sentence: '', problem: null })

export function SettingsCard({
  id,
  icon,
  title,
  intro,
  done,
  problem,
  onDismiss,
  stepUp,
  onStepUpSubmit,
  onStepUpCancel,
  wide,
  children,
}: {
  id: string
  icon: ReactNode
  title: string
  intro: string
  done?: Words | null
  problem?: Words | null
  onDismiss?: () => void
  stepUp?: StepUpView
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
  wide?: boolean
  children?: ReactNode
}) {
  const t = useT(DISPATCH_NS)
  const say = (value: Words | null | undefined) => (value ? t(value.key, value.params) : null)
  return (
    <Card padded className={wide ? 'fw-shipset-card fw-shipset-wide' : 'fw-shipset-card'}>
      <section id={id} className="fw-shipset-section" aria-labelledby={`shipset-${id}`}>
        <div className="fw-shipset-section-head">
          <h2 id={`shipset-${id}`} className="fw-shipset-h2">
            {icon} {title}
          </h2>
          <p className="fw-shipset-hint">{intro}</p>
        </div>
        {done && <Banner tone="success" title={say(done)} action={onDismiss ? <Button size="sm" variant="quiet" onClick={onDismiss}>{t('common.dismiss')}</Button> : undefined} />}
        {problem && <Banner tone="danger" title={say(problem)} action={onDismiss ? <Button size="sm" variant="quiet" onClick={onDismiss}>{t('common.dismiss')}</Button> : undefined} />}
        {children}
      </section>
      {stepUp && (
        <StepUpModal
          open={stepUp.open}
          title={t('stepUp.title')}
          sentence={stepUp.sentence ? t(stepUp.sentence) : ''}
          busy={stepUp.busy}
          error={stepUp.problem ? t(stepUp.problem) : null}
          onSubmit={(code) => onStepUpSubmit?.(code)}
          onClose={() => onStepUpCancel?.()}
          confirmLabel={t('stepUp.confirm')}
        />
      )}
    </Card>
  )
}
