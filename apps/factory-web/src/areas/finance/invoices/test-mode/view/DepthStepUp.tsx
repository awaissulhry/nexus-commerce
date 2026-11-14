'use client'

import { StepUpModal } from '../../../../../lib/i18n/ds-parts'
import { useScopedT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { StepUpState } from '../../../_shared/hooks'
import { DEPTH_NAMESPACES } from '../depth'

/**
 * The fresh authenticator code a write of this step asks first (A1 §3.10; the DS StepUpModal): going live or back to test
 * mode, the accountant's switches, confirming a tax code, issuing the monthly run. Its sentence is a key of this step's
 * catalogue (`finance-invoices-depth:…`) or of `finance`; the title, the button and the refusals are the finance words.
 */
export function DepthStepUp({ stepUp, onSubmit, onCancel }: { stepUp: StepUpState; onSubmit?: (code: string) => void; onCancel?: () => void }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <Inner stepUp={stepUp} onSubmit={onSubmit} onCancel={onCancel} />
    </WithMessages>
  )
}

function Inner({ stepUp, onSubmit, onCancel }: { stepUp: StepUpState; onSubmit?: (code: string) => void; onCancel?: () => void }) {
  const s = useScopedT('finance')
  return (
    <StepUpModal
      open={stepUp.open}
      title={s('stepUp.title')}
      sentence={stepUp.sentence ? s(stepUp.sentence) : ''}
      busy={stepUp.busy}
      error={stepUp.problem ? s(stepUp.problem) : null}
      onSubmit={(code) => onSubmit?.(code)}
      onClose={() => onCancel?.()}
      confirmLabel={s('stepUp.confirm')}
    />
  )
}
