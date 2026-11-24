'use client'

import { Banner } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Modal, StepUpModal } from '../../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { NAMESPACE as SHEET } from '../../../list/sheet/model'
// ---- the order page's OWN windows (K2.1: a type-only export; mounted here, never copied) ----
import { Frame, LinkDialog, PaymentDialog } from '../../view/Dialogs'
import { MoneyDialogs } from '../view/MoneyDialogs'
import { useSay } from '../view/say'
import { doorLabelOf, type OrderMoneyDoorActions, type OrderMoneyDoorModel } from './model'
import '../../../orders.css' // the order page's windows' own classes (fw-so-*); MoneyDialogs brings money.css itself

/**
 * F-CM-k2 (customer MONEY tab, 13-backend §4.1; 15-steps K2.4; the frame of ord/list/commands/view/OrderCommandWindow.tsx) — the money
 * door's window, centred, one at a time. While the order and its plan are read: a DS Modal saying so (the act's own words as its
 * title); a failed read: its words and Try again (an order out of reach: 404, said neutrally). Read: the plan's rule on the order AS
 * READ — held: the order page's dialog frame with the held words (the row may be older than the order); else the order page's OWN
 * window on the request: Record a payment… (PaymentDialog), Send the page… (LinkDialog), the plan's hand windows and Waive…
 * (MoneyDialogs). The order page's words throughout (`orders`); a refusal is said inside the window, what was typed stays; a fresh
 * authenticator code where the order page asks one. Draws its model; the door hook reads and writes. Defines no window of its own.
 */
export function OrderMoneyWindow(props: { model: OrderMoneyDoorModel; actions?: OrderMoneyDoorActions }) {
  return (
    <WithMessages namespaces={['orders', SHEET]}>
      <Window {...props} />
    </WithMessages>
  )
}

function Window({ model, actions }: { model: OrderMoneyDoorModel; actions?: OrderMoneyDoorActions }) {
  const t = useT('orders')
  return (
    <>
      <OrderMoneyBody model={model} actions={actions} />
      {/* The fresh authenticator code (Record a payment with its deposit invoice, Waive…, Accept short over the tolerance): the order page's words. */}
      <StepUpModal
        open={model.stepUp.open}
        title={t('stepUp.title')}
        sentence={model.stepUp.sentence ? t(model.stepUp.sentence) : ''}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? t(model.stepUp.problem) : null}
        onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
        onClose={() => actions?.onStepUpCancel?.()}
        confirmLabel={t('stepUp.confirm')}
      />
    </>
  )
}

/** The window's content (also drawn on its own by the design cases). */
export function OrderMoneyBody({ model, actions }: { model: OrderMoneyDoorModel; actions?: OrderMoneyDoorActions }) {
  const t = useT('orders')
  const s = useT(SHEET)
  const say = useSay(model.order?.currency ?? 'EUR')
  const close = () => actions?.onClose?.()
  const number = model.order?.number ?? model.target.number
  const title = say(doorLabelOf(model.ask.act))
  const order = model.order
  if (!order || !model.ruling) {
    // The order's read failed, or its plan's (the plan is the rule: without it nothing is decided).
    const problem = model.problem ?? (model.schedule?.problem && !model.schedule.value ? model.schedule.problem : null)
    return (
      <Modal
        open
        size="md"
        onClose={close}
        title={title}
        footer={
          <>
            <span className="grow" />
            <Button size="sm" onClick={close}>
              {t('common.cancel')}
            </Button>
          </>
        }
      >
        {problem ? (
          <Banner
            tone="danger"
            title={s('commands.readFailed', { number, problem: t(problem) })}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : (
          <p className="fw-so-hint" role="status">
            <Spinner size={14} /> {s('commands.reading', { number })}
          </p>
        )}
      </Modal>
    )
  }
  // The plan's rule on the order as read: the row may be older than the order (paid, moved or waived meanwhile).
  if (model.ruling.held) {
    const words = say(model.ruling.held)
    return (
      <Frame title={title} held={words} go={() => undefined} goLabel={title} onClose={close} problem={<Banner tone="warning" title={words} />}>
        {null}
      </Frame>
    )
  }
  const dialog = model.dialogs.dialog
  return (
    <>
      {dialog?.kind === 'depositPayment' ? <PaymentDialog order={order} requestId={dialog.requestId} model={model.dialogs} actions={actions?.dialogs} /> : null}
      {dialog?.kind === 'depositLink' ? <LinkDialog order={order} requestId={dialog.requestId} model={model.dialogs} actions={actions?.dialogs} /> : null}
      {/* The plan's hand windows (by the dialog) and Waive… (by the schedule's own state), mounted as the order page mounts them. */}
      <MoneyDialogs order={order} model={model.dialogs} actions={actions?.dialogs} />
    </>
  )
}
