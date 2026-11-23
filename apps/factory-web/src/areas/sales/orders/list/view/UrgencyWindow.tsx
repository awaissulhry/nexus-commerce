'use client'

import { StepUpModal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { UrgencyOutcome } from '../../../../_shared/customer-urgency/view/UrgencyOutcome'
import { UrgencyOverrideDialog } from '../../../../_shared/customer-urgency/view/UrgencyOverrideDialog'
import { NAMESPACE as SHEET } from '../sheet/model'
import type { SheetUrgencyActions, SheetUrgencyModel } from '../sheet/urgency'
import './ship-together.css' // F-CW-304: the "Runs on / Not on" lines over a window look the same over both windows

/**
 * F-CW-302 (customer Work tab plan §4; lead settles S7, S14) — the urgency window on the ONE Orders sheet: the SHARED window and
 * outcome (areas/_shared/customer-urgency — the work order's Customer card mounts the same; nothing is copied here), with this
 * page's own step-up dialog for the fresh code. The window's words are the card's (`production`); the step-up sentence is the one
 * the work order page says (`production-work-orders`: one sentence for one act); the code dialog's own words are the order pages'.
 * Draws its model.
 */

const WINDOW_NAMESPACES = ['production', 'production-work-orders', 'orders', SHEET] as const

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
      {model.dialog && <UrgencyOverrideDialog model={model} actions={actions} above={<UrgencyAbove model={model} />} />}
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

/**
 * F-CW-304 (10-design §6 W4): over the window, for ticked orders — "Runs on 2 · Not on 1: why is beside each" (the approved words of
 * the bulk commands) and each order it does not run on with why. An act on one row, or one every ticked order takes: nothing.
 */
function UrgencyAbove({ model }: { model: SheetUrgencyModel }) {
  const s = useT(SHEET)
  if (!model.dialog || model.left.length === 0) return null
  return (
    <div className="fw-sst">
      <p className="fw-sst-sum" role="status">
        <b>{s('commands.runs', { count: model.dialog.orders.length })}</b> · {s('commands.notOn', { count: model.left.length })}
      </p>
      <ul className="fw-sst-list" aria-label={s('urgency.left.label')}>
        {model.left.map((line) => (
          <li key={line.id}>
            <b>{line.label}</b> · {s(`urgency.left.${line.why}`)}
          </li>
        ))}
      </ul>
    </div>
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
