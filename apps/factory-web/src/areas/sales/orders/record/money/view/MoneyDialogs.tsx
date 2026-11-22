'use client'

import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { OpenStepDialog, WaiveDialog } from '../../schedule/view/StepVerbs'

/**
 * F-OM-101 (order MONEY tab, 10-design §9) — the payment plan's windows, mounted ONCE by the page (OrderRecordView, the GateDialogs
 * pattern; centred DS modals, never a drawer): Waive… (the owner, a reason, then a fresh code) and Open for payment of a step with no
 * day (the day its request falls due). The deposit's Send the page, Record the payment and the TD02's Send to SDI stay the page's
 * own dialogs (view/Dialogs.tsx). W2 (F-OM-201) adds the hand windows here.
 */
export function MoneyDialogs({ model, actions }: { model: OrderRecordModel; actions?: OrderRecordActions }) {
  const steps = model.scheduleSteps
  if (!steps) return null
  return (
    <>
      {steps.waiving ? <WaiveDialog waiving={steps.waiving} model={steps} actions={actions?.scheduleSteps} /> : null}
      {steps.opening ? <OpenStepDialog step={steps.opening} model={steps} today={model.today} actions={actions?.scheduleSteps} /> : null}
    </>
  )
}
