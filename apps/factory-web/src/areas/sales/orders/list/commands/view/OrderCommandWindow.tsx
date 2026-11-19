'use client'

import Link from 'next/link'
import { Banner, KeyValue } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Modal, StepUpModal } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { Order } from '../../../api'
import { orderHref, NAMESPACE as SHEET } from '../../sheet/model'
// ---- the order page's OWN dialogs (lane agreement (a): a type-only export; mounted here, never copied) ----
import { CloseDialog, Frame, ReadyDialog, type CommandDialogActions, type CommandDialogModel } from '../../../record/view/Dialogs'
import { CancelDialog } from '../../../record/view/DailyDialogs'
import { RefuseYesDialog, YesDoorView } from '../../../depth/view/DepthBand' // F-OP-101's pair: Confirm / Refuse…
import { orderYesDoor, windowGoOf, windowHeldOf, windowTitleOf, wordsText, type OrderCommandActions, type OrderCommandModel, type Words } from '../model'
import '../commands.css'

/**
 * F-CP-108 (customer page plan C2b, D8, K2; 10-customer-page §3.1; picture 20): the row ⋯ "Next steps" window of the Orders sheet. While
 * the order is read: a DS Modal (md) saying so; a failed read: its words and Try again (404 is neutral: "It is not there any more").
 * Read: A14's rules on the order as READ — held: the order page's dialog frame with the held words (the row may be older than the
 * order); else the order page's OWN dialog: Mark ready (a reason), Close order (settled: a confirm; not settled: what is missing in
 * words — never an amount — and a reason), Cancel order (the impact check, the reason, the number typed), or the yes (F-OP-101: who
 * asked, Confirm — a fresh code when its rule asks one — and Refuse… with its reason; held for the asker, who decides for anyone else).
 * A refusal is said inside the dialog in the order page's words; what was typed stays. Draws its model; the door hook writes.
 */
export function OrderCommandWindow(props: { model: OrderCommandModel; actions?: OrderCommandActions }) {
  return (
    <WithMessages namespaces={['orders', SHEET]}>
      <Window {...props} />
    </WithMessages>
  )
}

function Window({ model, actions }: { model: OrderCommandModel; actions?: OrderCommandActions }) {
  const t = useT('orders')
  return (
    <>
      <Body model={model} actions={actions} />
      {/* The yes's fresh authenticator code (its rule asks one): the order page's words. */}
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

/** The window's content (also drawn on its own by the tests and the design cases). */
export function Body({ model, actions }: { model: OrderCommandModel; actions?: OrderCommandActions }) {
  const t = useT('orders')
  const s = useT(SHEET)
  const locale = useLocale()
  const say = (words: Words) => wordsText(words, t, s, locale)
  const close = () => actions?.onClose?.()
  const number = model.order?.number ?? model.target.number
  const order = model.order
  if (!order) {
    return (
      <Modal
        open
        size="md"
        onClose={close}
        title={say(windowTitleOf(model.command, number))}
        footer={
          <>
            <span className="grow" />
            <Button size="sm" onClick={close}>
              {t('common.cancel')}
            </Button>
          </>
        }
      >
        {model.problem ? (
          <Banner
            tone="danger"
            title={s('commands.readFailed', { number, problem: t(model.problem) })}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : (
          <p className="fw-cmd-hint" role="status">
            <Spinner size={14} /> {s('commands.reading', { number })}
          </p>
        )}
      </Modal>
    )
  }
  // A14's rule on the order as read: the row may be older than the order (someone moved it meanwhile).
  const held = windowHeldOf(model.command, order, model.can)
  if (held) {
    const words = say(held)
    return (
      <Frame title={say(windowTitleOf(model.command, order.number))} held={words} go={() => undefined} goLabel={say(windowGoOf(model.command))} onClose={close} problem={<Banner tone="warning" title={words} />}>
        {null}
      </Frame>
    )
  }
  // The order page's dialogs read only these parts of its model and actions (Dialogs.tsx F-CP-108: type only).
  const dialogModel: CommandDialogModel = { busy: model.busy, can: model.can, dialogProblem: model.dialogProblem, cancelCheck: model.cancelCheck, prefix: model.prefix }
  const dialogActions: CommandDialogActions = {
    onDialog: close,
    onReady: actions?.onReady,
    onClose: actions?.onCloseOrder,
    onCancelOrder: actions?.onCancel,
    onRetryPart: (part) => (part === 'cancelCheck' ? actions?.onRetryCheck?.() : undefined),
  }
  if (model.command === 'ready') return <ReadyDialog order={order} model={dialogModel} actions={dialogActions} />
  if (model.command === 'close') return <CloseDialog order={order} model={dialogModel} actions={dialogActions} />
  if (model.command === 'cancel') return <CancelDialog order={order} model={dialogModel} actions={dialogActions} />
  return <YesWindow order={order} model={model} actions={actions} />
}

/**
 * Confirm or refuse… — the order's own yes (F-OP-101): what is asked and who asked, then the order page's door (YesDoorView): Confirm the
 * order and Refuse… for an approver who did not ask; Confirm held for the asker ("another person decides"); who decides for anyone else.
 * Nobody asked yet: said so, with the order (asking for a yes is the order page's). Refuse… opens the order page's own no dialog.
 */
function YesWindow({ order, model, actions }: { order: Order; model: OrderCommandModel; actions?: OrderCommandActions }) {
  const t = useT('orders')
  const s = useT(SHEET)
  const locale = useLocale()
  const close = () => actions?.onClose?.()
  if (model.refuse) {
    return <RefuseYesDialog order={order} model={{ dialog: { kind: 'refuseYes', taskId: model.refuse.taskId }, refuseReasons: model.refuseReasons, busy: model.busy, dialogProblem: model.dialogProblem }} actions={{ onDialog: () => actions?.onRefuseBack?.(), ...(actions?.yes ? { yes: actions.yes } : {}) }} />
  }
  const door = orderYesDoor(order, model.busy)
  const task = door?.task ?? null
  return (
    <Modal
      open
      size="md"
      onClose={close}
      title={s('commands.yesTitle', { number: order.number })}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={close}>
            {t('common.cancel')}
          </Button>
          {door && <YesDoorView door={door} onYes={actions?.yes} />}
        </>
      }
    >
      <div className="fw-cmd">
        {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem.key, model.dialogProblem.params)} />}
        {task ? (
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('approval.kind'), value: locale === 'en' ? task.kindLabel.en : task.kindLabel.it },
              { label: t('approval.askedBy'), value: t('approval.askedByOn', { who: task.requester.name, date: formatDate(task.requestedAt, { locale }) }) },
            ]}
          />
        ) : (
          <p className="fw-cmd-hint">
            {s('commands.noYes')}{' '}
            <Link className="fw-sheet-door" href={orderHref(model.prefix, order)}>
              {s('commands.openOrder', { number: order.number })}
            </Link>
          </p>
        )}
      </div>
    </Modal>
  )
}
