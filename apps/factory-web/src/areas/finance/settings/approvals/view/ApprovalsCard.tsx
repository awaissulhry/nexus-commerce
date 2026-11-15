'use client'

import { BellRing, ShieldCheck } from 'lucide-react'
import { Banner, Card, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { money } from '../../../_shared/model'
import { PAY_DEPTH, PAY_DEPTH_NAMESPACES, type Phrase } from '../../../payments/riba/depth'
import type { CollectionsSettings } from '../../../payments/riba/api'
import type { MoneyControl, MoneyControls, RemittanceSettings } from '../api'
import { switchHeld, yesStateOf, type ApprovalsCan, type SwitchName } from '../model'
import '../../../_shared/finance.css'
import '../approvals.css'

export interface ApprovalsModel {
  can: ApprovalsCan
  /** The money controls (null while read). */
  controls: MoneyControls | null
  /** A failed read (a `finance` key), never drawn as empty. */
  problem: string | null
  /** The supplier remittance mail switch (null while read or without it). */
  remittance: RemittanceSettings | null
  /** The customer's payment-received notice switch, B-W2b-402's collections settings (null while read or without it). */
  collections: CollectionsSettings | null
  busy: SwitchName | null
  /** A refused switch (a key a `finance`-scoped translator reads). */
  switchProblem: Phrase | null
  notice: Phrase | null
}

export interface ApprovalsActions {
  onRetry?: () => void
  onSwitch?: (name: SwitchName, on: boolean) => void
  onDismissNotice?: () => void
}

/**
 * SCR-519 — Finance › Settings › Approvals & notifications (design finance.settings sec:approvals "Money actions that need
 * approval; who hears about what": "Credit notes, write-offs, price overrides, manual payments above an amount · Payment
 * received, SDI rejection, overdue, deposit received, difference"): per risky money action what asks a yes today (the person
 * who made it never approves it; a rule of its approval kind; no kind yet — said as open), whether a fresh code is asked, and
 * the amount above which two people approve (the cost grain; the design's figure, said as not yet decided); then each money
 * notification with who is told; then the two mails that reach someone outside — the supplier's remittance and the
 * customer's payment-received notice — the Owner's switches, OFF until turned on (a fresh code to turn one on). The amounts
 * and audiences have no setting yet: they are read here, never edited. No money in this section but that amount.
 */
export function ApprovalsCard({ model, actions }: { model: ApprovalsModel; actions?: ApprovalsActions }) {
  return (
    <WithMessages namespaces={PAY_DEPTH_NAMESPACES}>
      <Body model={model} actions={actions} />
    </WithMessages>
  )
}

function Body({ model, actions }: { model: ApprovalsModel; actions?: ApprovalsActions }) {
  const p = useT(PAY_DEPTH)
  const t = useT('finance')
  const s = useScopedT('finance')
  const title = (
    <h2 className="fw-fin-h2">
      <ShieldCheck size={16} aria-hidden /> {p('approvals.title')}
    </h2>
  )
  if (!model.can.view) {
    return (
      <Card padded className="fw-fin-card">
        {title}
        <p className="fw-fin-hint">{p('approvals.noRight')}</p>
      </Card>
    )
  }
  if (model.problem) {
    return (
      <Card padded className="fw-fin-card">
        {title}
        <Banner tone="danger" title={p('approvals.failed')}>
          {t(model.problem)}
        </Banner>
        <span className="fw-fin-inline">
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {t('common.retry')}
          </Button>
        </span>
      </Card>
    )
  }
  const controls = model.controls
  if (!controls) {
    return (
      <Card padded className="fw-fin-card" aria-busy="true">
        {title}
        <Skeleton height={16} />
        <Skeleton height={16} />
        <Skeleton height={16} />
      </Card>
    )
  }
  return (
    <Card padded className="fw-fin-card">
      {title}
      <p className="fw-fin-hint">{p('approvals.intro')}</p>
      {model.notice && (
        <Banner
          tone="success"
          title={s(model.notice.key, model.notice.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      <ActionsTable controls={controls} cost={model.can.cost} />
      <p className="fw-fin-hint">{p('approvals.amountsFixed')}</p>
      <h3 className="fw-fin-h3">
        <BellRing size={14} aria-hidden /> {p('approvals.notificationsTitle')}
      </h3>
      <SummaryTable
        label={p('approvals.notificationsTitle')}
        columns={[p('approvals.col.notification'), p('approvals.col.told')]}
        stackOnPhone
        rows={controls.notifications.map((entry) => ({ id: entry.code, cells: [p(`approvals.notification.${entry.code}`), p(`approvals.audience.${entry.audience}`)] }))}
      />
      <h3 className="fw-fin-h3">{p('approvals.mailsTitle')}</h3>
      <p className="fw-fin-hint">{p('approvals.mailsIntro')}</p>
      {model.switchProblem && <Banner tone="danger" title={s(model.switchProblem.key, model.switchProblem.params)} />}
      <SwitchRow name="remittance" on={model.remittance?.on ?? null} source={model.remittance?.source ?? null} mayChange={model.remittance?.mayChange ?? false} busy={model.busy} onSwitch={actions?.onSwitch} />
      <SwitchRow name="notice" on={model.collections?.paymentNoticeToCustomerOn ?? null} source={model.collections?.source ?? null} mayChange={model.collections?.mayChange ?? false} busy={model.busy} onSwitch={actions?.onSwitch} />
    </Card>
  )
}

function ActionsTable({ controls, cost }: { controls: MoneyControls; cost: boolean }) {
  const p = useT(PAY_DEPTH)
  const locale = useLocale()
  const yes = (control: MoneyControl) => {
    const state = yesStateOf(control)
    return state === 'RULES' ? p('approvals.yes.RULES', { count: control.kind!.active }) : p(`approvals.yes.${state}`)
  }
  const dual = (control: MoneyControl) => {
    if (!control.dual) return p('approvals.dual.none')
    const amount = cost && control.dual.amount !== undefined ? money(control.dual.amount, controls.currency, locale) : null
    return amount ? p(control.dual.decided ? 'approvals.dual.above' : 'approvals.dual.aboveUndecided', { amount }) : p('approvals.dual.abovePlain')
  }
  return (
    <SummaryTable
      label={p('approvals.actionsTitle')}
      columns={[p('approvals.col.action'), p('approvals.col.yes'), p('approvals.col.code'), p('approvals.col.dual')]}
      stackOnPhone
      rows={controls.actions.map((control) => ({
        id: control.code,
        cells: [
          <span key="name" className="fw-fin-stack-tight">
            <strong>{p(`approvals.action.${control.code}.name`)}</strong>
            <span className="fw-fin-hint">{p(`approvals.action.${control.code}.rule`)}</span>
          </span>,
          yes(control),
          control.stepUp ? <Pill key="code" tone={control.stepUp.on ? 'success' : 'neutral'}>{p(control.stepUp.on ? 'approvals.code.on' : 'approvals.code.off')}</Pill> : p('approvals.code.none'),
          dual(control),
        ],
      }))}
    />
  )
}

function SwitchRow({ name, on, source, mayChange, busy, onSwitch }: { name: SwitchName; on: boolean | null; source: 'COMPANY' | 'TENANT' | 'NONE' | null; mayChange: boolean; busy: SwitchName | null; onSwitch?: (name: SwitchName, on: boolean) => void }) {
  const p = useT(PAY_DEPTH)
  const s = useScopedT('finance')
  const held = switchHeld({ read: on !== null, mayChange, busy: busy !== null })
  return (
    <div className="fw-fap-switch">
      <span className="fw-fin-stack-tight">
        <span className="fw-fin-inline">
          <strong>{p(`approvals.switch.${name}.title`)}</strong>
          {on !== null && <Pill tone={on ? 'success' : 'neutral'}>{p(on ? 'approvals.switch.on' : 'approvals.switch.off')}</Pill>}
        </span>
        <span className="fw-fin-hint">{p(`approvals.switch.${name}.body`)}</span>
        {source && <span className="fw-fin-hint">{p(`approvals.source.${source}`)}</span>}
      </span>
      <Button size="sm" heldReason={held ? s(held.key, held.params) : null} onClick={() => on !== null && onSwitch?.(name, !on)}>
        {p(on ? 'approvals.switch.turnOff' : 'approvals.switch.turnOn')}
      </Button>
    </div>
  )
}
