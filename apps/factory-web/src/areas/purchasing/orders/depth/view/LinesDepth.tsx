'use client'

import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Banner, Card, KeyValue } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { money } from '../../../../_shared/buying/model'
import type { PoLine, PurchaseOrder } from '../../api'
import type { KindLine, Requirement } from '../api'
import {
  approvalPhrase,
  DEPTH,
  heldRequirements,
  kindPhrases,
  kindWarns,
  laterPhrase,
  lineBlocks,
  overrideAskHeld,
  overrideDecideHeld,
  rateEditHeld,
  requestPhrase,
  requirementPhrase,
  withdrawHeld,
  type OrderDepthActions,
  type OrderDepthModel,
} from '../model'
import { useDepthSay } from './words'

/** The laws the gate names (factory-domain purchasing/qualification/gate LAW) and their official texts. */
const LAWS: Readonly<Record<Exclude<Requirement['kind'], 'RULE'>, { law: string; href: string }>> = Object.freeze({
  CR_VI_TEST_REPORT: { law: 'REACH Annex XVII entry 47', href: 'https://eur-lex.europa.eu/eli/reg/2006/1907/oj' },
  PPE_CERTIFICATE: { law: 'Reg. (EU) 2016/425', href: 'https://eur-lex.europa.eu/eli/reg/2016/425/oj' },
})

/** The law of a requirement as the DS chip (plain words in the page's language). */
export function RequirementLaw({ requirement }: { requirement: Requirement }) {
  const t = useT(DEPTH)
  const ds = useDsWords()
  if (requirement.kind === 'RULE') return null
  const law = LAWS[requirement.kind]
  return <LawRef law={law.law} plain={t(`law.${requirement.kind}`)} href={law.href} labels={ds.lawRef} />
}

/**
 * The held compliance marks above the Lines grid (design rec lines "Held compliance mark (W2b)": "Chromium VI test for A12
 * expired 2 Oct — this PO can't be sent" + Override): each requirement that holds the order at Send, in our words, with its
 * law; the override request's state (waiting, approved, refused, taken back) and its verbs — Send without a valid document…
 * (the asker), Decide… (a second person with purchasing.compliance.override; never the asker, the Owner included), Take the
 * request back. Lines the gate could not check (the supplier's kinds are not set) are said too.
 */
export function HeldMarks({ order, model, actions }: { order: PurchaseOrder; model: OrderDepthModel; actions?: OrderDepthActions }) {
  const t = useT(DEPTH)
  const tb = useT('buying')
  const say = useDepthSay()
  const compliance = model.compliance.value
  // The gate holds a draft at Send; once sent, a lapsed document is the receipt's (quality's) concern, not this mark's.
  if (order.status !== 'DRAFT') return null
  if (!compliance) return model.compliance.problem ? <p className="fw-by-hint fw-by-warning">{t('mark.failed', { problem: tb(model.compliance.problem) })}</p> : null
  const held = heldRequirements(compliance)
  const request = compliance.request
  const requestWords = say(requestPhrase(request))
  const askHeld = say(overrideAskHeld(order, compliance, model.can))
  const decideHeld = overrideDecideHeld(compliance, model.can)
  const mayWithdraw = request?.state === 'WAITING' && compliance.may.withdraw
  const showDecide = request?.state === 'WAITING' && !request.askedBy.me && model.can.override
  if (held.length === 0 && !request && compliance.notChecked.length === 0) return null
  return (
    <div className="fw-by-stack">
      {held.length > 0 && (
        <Banner
          tone="danger"
          title={held.length === 1 ? say(requirementPhrase(held[0]!)) : t('mark.many', { count: held.length })}
          action={
            order.status === 'DRAFT' ? (
              <span className="fw-by-actions">
                {showDecide ? (
                  <Button size="sm" variant="primary" heldReason={say(decideHeld) ?? (model.busy ? tb('held.busy') : null)} onClick={() => actions?.onDialog?.({ kind: 'decide', decision: 'APPROVED', words: '' })}>
                    {t('decide.open')}
                  </Button>
                ) : (
                  <Button size="sm" heldReason={askHeld ?? (model.busy ? tb('held.busy') : null)} onClick={() => actions?.onDialog?.({ kind: 'override', reason: '' })}>
                    <ShieldAlert size={14} aria-hidden /> {t('override.open')}
                  </Button>
                )}
                {mayWithdraw && (
                  <Button size="sm" variant="quiet" heldReason={model.busy ? tb('held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'withdrawOverride' })}>
                    {t('override.withdraw')}
                  </Button>
                )}
              </span>
            ) : undefined
          }
        >
          <div className="fw-by-stack">
            {held.length > 1 && (
              <ul className="fw-by-list">
                {held.map((requirement, index) => (
                  <li key={`${requirement.kind}-${index}`}>
                    {say(requirementPhrase(requirement))} <RequirementLaw requirement={requirement} />
                  </li>
                ))}
              </ul>
            )}
            {held.length === 1 && (
              <span>
                <RequirementLaw requirement={held[0]!} />
              </span>
            )}
            {requestWords && <span>{requestWords}</span>}
            {request && (request.state === 'WAITING' || request.state === 'REJECTED') && <span className="fw-by-hint">{t('request.reason', { reason: request.reason })}</span>}
            {request?.state === 'REJECTED' && request.words && <span className="fw-by-hint">{t('request.words', { words: request.words })}</span>}
          </div>
        </Banner>
      )}
      {held.length === 0 && requestWords && <Banner tone={request?.state === 'APPROVED' ? 'success' : 'info'} title={requestWords} />}
      {compliance.notChecked.length > 0 && <p className="fw-by-hint">{t('mark.notChecked', { count: compliance.notChecked.length })}</p>}
    </div>
  )
}

/** A draft line's held mark inside the material cell (the words sit in the banner above). */
export function lineHeld(model: OrderDepthModel, lineId: string, status: PurchaseOrder['status']): boolean {
  return status === 'DRAFT' && !!model.compliance.value?.lines.some((line) => line.lineId === lineId && line.held)
}

/** The kind's words in the Specs cell: rolls (fabric, trim), the certificate (protector), the variant. */
export function KindWords({ line }: { line: KindLine | undefined }) {
  const say = useDepthSay()
  if (!line) return null
  const phrases = kindPhrases(line)
  if (phrases.length === 0) return null
  return <span className={kindWarns(line) ? 'fw-by-cell-sub fw-by-warning' : 'fw-by-cell-sub'}>{phrases.map((words) => say(words)).join(' · ')}</span>
}

/** "For orders (what it blocks if late)": the work and customer orders the line supplies, each a link; late ones say by how much. */
export function BlocksWords({ model, line, prefix }: { model: OrderDepthModel; line: PoLine; prefix: string }) {
  const t = useT(DEPTH)
  if (!model.demand.value) return <span className="fw-by-cell-sub">{model.demand.problem ? t('blocks.failed') : '—'}</span>
  const blocks = lineBlocks(model.demand.value, line.id)
  if (!blocks || (blocks.workOrders.length === 0 && blocks.salesOrders.length === 0)) return <span className="fw-by-cell-sub">{blocks && blocks.other > 0 ? t('blocks.stock') : t('blocks.none')}</span>
  const late = [...blocks.salesOrders, ...blocks.workOrders].filter((entry) => entry.lateBy > 0)
  const shown = [...blocks.salesOrders.map((entry) => ({ ...entry, href: `${prefix}/sales/orders/${entry.id}` })), ...blocks.workOrders.map((entry) => ({ ...entry, href: `${prefix}/production/work-orders/${entry.id}` }))]
  return (
    <span className="fw-by-cell">
      <span className="fw-by-ellipsis">
        {shown.slice(0, 3).map((entry, index) => (
          <span key={entry.id}>
            {index > 0 && ' · '}
            <Link className="fw-by-link" href={entry.href}>
              {entry.number}
            </Link>
          </span>
        ))}
        {shown.length > 3 && ` ${t('blocks.more', { count: shown.length - 3 })}`}
      </span>
      <span className={late.length > 0 ? 'fw-by-cell-sub fw-by-danger fw-by-ellipsis' : 'fw-by-cell-sub fw-by-ellipsis'} title={late.length > 0 ? t('blocks.late', { count: late.length, days: blocks.lateBy }) : undefined}>
        {late.length > 0 ? t('blocks.late', { count: late.length, days: blocks.lateBy }) : t('blocks.inTime', { count: shown.length })}
      </span>
    </span>
  )
}

/** The line's supplier's day against the day asked: "confirmed later than needed by N days" (B-W2b-296's confirmedLaterBy). */
export function LaterWords({ model, lineId }: { model: OrderDepthModel; lineId: string }) {
  const say = useDepthSay()
  const t = useT(DEPTH)
  const line = model.depth.value?.lines.find((entry) => entry.id === lineId)
  if (!line) return null
  const later = Math.max(line.confirmedLaterBy, ...line.deliveries.map((delivery) => delivery.confirmedLaterBy))
  return (
    <>
      {line.deliveries.length > 0 && <span className="fw-by-cell-sub">{t('lines.deliveries', { count: line.deliveries.length })}</span>}
      {later > 0 && <span className="fw-by-cell-sub fw-by-danger">{say(laterPhrase(later))}</span>}
    </>
  )
}

/**
 * Totals (design rec lines `totals`: "Net total per currency; foreign currency with the rate at order (W2b)"): the net in
 * the order's currency; an order in another currency than the company's shows the rate at order ("1 EUR = 1,085 USD") and
 * the net in the company's currency at that rate (frozen with the send), Set the rate on a draft, or that the send asks it.
 * The cost grain only (the card is not drawn without it).
 */
export function TotalsCard({ order, model, actions }: { order: PurchaseOrder; model: OrderDepthModel | null; actions?: OrderDepthActions }) {
  const t = useT(DEPTH)
  const tb = useT('buying')
  const say = useDepthSay()
  const locale = useLocale()
  const currency = model?.depth.value?.currency ?? null
  const rateHeld = currency && model ? say(rateEditHeld(order, { currency }, model.can)) : null
  const rateText = currency?.rateAtOrder ? t('totals.rate', { company: currency.company, rate: new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 8 }).format(Number(currency.rateAtOrder)), order: currency.order }) : null
  return (
    <Card padded>
      <div className="fw-by-stack">
        <div className="fw-by-card-head">
          <h3 className="fw-by-h3">{tb('po.totals.title')}</h3>
          {currency?.takesRate && order.status === 'DRAFT' && model?.can.manage && (
            <Button size="sm" variant="quiet" heldReason={rateHeld ?? (model.busy ? tb('held.busy') : null)} onClick={() => actions?.onDialog?.({ kind: 'rate', rate: currency.rateAtOrder ?? '' })}>
              {t(currency.rateAtOrder ? 'totals.changeRate' : 'totals.setRate')}
            </Button>
          )}
        </div>
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            { label: t('totals.netIn', { currency: order.currency }), value: <span className="fw-by-num">{money(order.netAmount ?? null, order.currency, locale)}</span>, hint: order.lines.length === 0 ? t('totals.noLines') : tb('po.totals.netHint') },
            ...(currency?.takesRate
              ? [
                  { label: t('totals.rateLabel'), value: rateText ?? <span className="fw-by-warning">{t(order.status === 'DRAFT' ? 'totals.noRateDraft' : 'totals.noRate')}</span>, hint: t('totals.rateHint') },
                  ...(currency.companyNetAmount !== undefined ? [{ label: t('totals.netIn', { currency: currency.company }), value: <span className="fw-by-num">{currency.companyNetAmount === null ? '—' : money(currency.companyNetAmount, currency.company, locale)}</span>, hint: t(order.status === 'DRAFT' ? 'totals.companyHintDraft' : 'totals.companyHint') }] : []),
                ]
              : []),
            { label: tb('po.totals.lines'), value: String(order.lines.length) },
          ]}
        />
        {model && !model.depth.value && (model.depth.problem ? <p className="fw-by-hint fw-by-warning">{t('totals.depthFailed')}</p> : <Spinner size={12} />)}
      </div>
    </Card>
  )
}

/**
 * The record's line for the send's approval (B-W2b-305, SCM-078): waiting for a yes from whom and by when (nothing was sent;
 * everything is held — Take the request back to change it; Open in Approvals), approved (being sent), sent with its yes,
 * refused with the approver's words, taken back, or out of date.
 */
export function ApprovalBanner({ order, model, actions, prefix }: { order: PurchaseOrder; model: OrderDepthModel; actions?: OrderDepthActions; prefix: string }) {
  const t = useT(DEPTH)
  const tb = useT('buying')
  const say = useDepthSay()
  const locale = useLocale()
  const approval = model.approval.value
  const line = approvalPhrase(approval)
  if (!approval || !line) return null
  if (approval.state === 'WITHDRAWN' || approval.state === 'STALE') return order.status === 'DRAFT' ? <p className="fw-by-hint">{say(line.words)}</p> : null
  if (approval.state === 'SENT_WITH_YES') return <p className="fw-by-hint">{say(line.words)}</p>
  const task = approval.task
  const held = say(withdrawHeld(approval, model.can))
  return (
    <Banner
      tone={line.tone}
      title={say(line.words) ?? ''}
      action={
        <span className="fw-by-actions">
          {task && (
            <Button size="sm" asChild>
              <Link href={`${prefix}/home/approvals?open=${encodeURIComponent(task.id)}`}>{t('approval.open')}</Link>
            </Button>
          )}
          {approval.state === 'WAITING' && (
            <Button size="sm" variant="quiet" heldReason={held ?? (model.busy ? tb('held.busy') : null)} onClick={() => actions?.onDialog?.({ kind: 'withdrawApproval', note: '' })}>
              {t('approval.withdraw')}
            </Button>
          )}
        </span>
      }
    >
      {approval.state === 'WAITING' && t('approval.waitingHint')}
      {approval.state === 'REJECTED' && task?.rejectReason && t('approval.rejectReason', { reason: task.rejectReason })}
      {approval.state === 'REJECTED' && task?.comment && ` ${t('approval.comment', { comment: task.comment })}`}
      {task?.decidedAt && approval.state !== 'WAITING' && <span className="fw-by-hint"> · {formatDateTime(task.decidedAt, { locale })}</span>}
    </Banner>
  )
}

/** The send dialog's line when a switched-on rule will ask a yes before it goes (GET …/approval `wouldAsk`). */
export function SendApprovalNote({ model }: { model: OrderDepthModel | null }) {
  const t = useT(DEPTH)
  const ask = model?.approval.value?.wouldAsk
  if (!ask) return null
  return (
    <Banner tone="info" title={t(ask.namesYou ? 'approval.wouldAskYou' : 'approval.wouldAsk', { approver: ask.approver?.name ?? '' })}>
      {ask.rule ? t('approval.rule', { rule: ask.rule.name }) : null}
    </Banner>
  )
}
