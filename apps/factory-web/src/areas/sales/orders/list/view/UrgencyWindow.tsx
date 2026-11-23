'use client'

import { StepUpModal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { UrgencyOutcome } from '../../../../_shared/customer-urgency/view/UrgencyOutcome'
import { UrgencyOverrideDialog } from '../../../../_shared/customer-urgency/view/UrgencyOverrideDialog'
import type { SheetUrgencyActions, SheetUrgencyModel } from '../sheet/urgency'

/**
 * F-CW-302 (customer Work tab plan §4; lead settles S7, S14) — the urgency window on the ONE Orders sheet: the SHARED window and
 * outcome (areas/_shared/customer-urgency — the work order's Customer card mounts the same; nothing is copied here), with this
 * page's own step-up dialog for the fresh code. The window's words are the card's (`production`); the step-up sentence is the one
 * the work order page says (`production-work-orders`: one sentence for one act); the code dialog's own words are the order pages'.
 * Draws its model.
 */

const WINDOW_NAMESPACES = ['production', 'production-work-orders', 'orders'] as const

export function UrgencyWindow({ model, actions }: { model: SheetUrgencyModel; actions?: SheetUrgencyActions }) {
  return (
    <WithMessages namespaces={WINDOW_NAMESPACES}>
      <Window model={model} actions={actions} />
    </WithMessages>
  )
}

function Window({ model, actions }: { model: SheetUrgencyModel; actions?: SheetUrgencyActions }) {
  const o = useT('orders')
  const w = useT('production-work-orders')
  return (
    <>
      {model.dialog && <UrgencyOverrideDialog model={model} actions={actions} />}
      <StepUpModal
        open={model.stepUp.open}
        title={o('stepUp.title')}
        sentence={model.stepUp.sentence ? w(model.stepUp.sentence) : ''}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? o(model.stepUp.problem) : null}
        onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
        onClose={() => actions?.onStepUpCancel?.()}
        confirmLabel={o('stepUp.confirm')}
      />
    </>
  )
}

/** The ONE notice after a set-back, lock or unlock: the orders done by number, each one not done with why, the rest counted. */
export function UrgencyNotice({ model, actions }: { model: SheetUrgencyModel; actions?: SheetUrgencyActions }) {
  if (!model.outcome) return null
  return (
    <WithMessages namespaces={['production']}>
      <UrgencyOutcome outcome={model.outcome} onDismiss={actions?.onDismissOutcome} />
    </WithMessages>
  )
}
