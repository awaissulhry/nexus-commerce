'use client'

import { useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ExternalLink, Eye, Lock, MessageSquare, Unlock, Zap } from 'lucide-react'
import { KIND_RULES } from '@nexus/factory-domain/approvals-out/kinds'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import { supervisorFactOf } from '../../../../../_shared/production-supervisor/model'
import { SupervisorFact } from '../../../../../_shared/production-supervisor/view/SupervisorFact'
import type { WorkOrder } from '../../../../_shared/api'
import type { Phrase } from '../../../../_shared/model'
import type { WorkOrderRecordActions, WorkOrderRecordModel } from '../../record-model'
import { customerFactOf, previewHeld } from '../../overview/model'
import {
  ageOf,
  answerHref,
  approvalsOf,
  CARD_LIMITS,
  issueThreadOf,
  issuesOfWorkOrder,
  limitsHref,
  limitsLineOf,
  ownRows,
  requestsOf,
  seesOf,
  urgencyActsOf,
  urgencyByOf,
  urgencyDialogHeld,
  urgencyLinesOf,
  urgencyWordsOf,
  waitingRushOf,
  type CardPart,
  type CustomerBlock,
  type CustomerCardModel,
  type UrgencyAct,
  type UrgencyLine,
} from '../model'
import '../customer-card.css'

const day = (value: string, locale: 'it' | 'en') => formatDate(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value, { locale })

/** The limits card's words (the level and the sections) are its own catalogue's: one set of words for the same facts. */
const LIMITS_NS = 'portal-access'

/**
 * F-PR-05b — the Customer card on the work order's Overview (06-tree A.4 O-WO-brand; 17-web-r2 §1.7): one block per customer of the
 * work order (PW-07), each row a fact with its one door — Requests (Answer in Approvals), Asked of the customer, Customer urgency (Set
 * to regular… · Lock · Unlock, a reason the customer reads, a fresh code), Supervisor (Change…), Open problems (Open thread), Limits
 * (Limits card), What <customer> sees (Open as <customer>). The card shows what the other pages own and links to them; it copies none
 * of their buttons but the urgency's, which is ours to set here (plan §3).
 */
export function CustomerCard({ workOrder, model, card, actions }: { workOrder: WorkOrder; model: WorkOrderRecordModel; card: CustomerCardModel; actions?: WorkOrderRecordActions }) {
  return (
    <WithMessages namespaces={[LIMITS_NS]}>
      <div className="fw-pr-stack" id="customer-card">
        {card.blocks.map((block) => (
          <Block key={block.customer.partyId} block={block} many={card.blocks.length > 1} workOrder={workOrder} model={model} card={card} actions={actions} />
        ))}
        {card.dialog && <UrgencyDialog card={card} actions={actions} />}
      </div>
    </WithMessages>
  )
}

function Block({ block, many, workOrder, model, card, actions }: { block: CustomerBlock; many: boolean; workOrder: WorkOrder; model: WorkOrderRecordModel; card: CustomerCardModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const tl = useT(LIMITS_NS)
  const fact = customerFactOf(workOrder)
  // The customer as the band names it: its name with parties.view, else its code (06-tree A.0); a block of an older work order of
  // several customers is named as its orders name it.
  const name = fact.kind === 'customer' && !many ? (model.partiesView ? fact.name : fact.code) : block.customer.name
  const requests = block.requests.value ? requestsOf(ownRows(block.requests.value, block.customer)) : null
  const rush = block.requests.value ? waitingRushOf(ownRows(block.requests.value, block.customer)) : new Set<string>()
  const lines = urgencyLinesOf(block.urgency.value, block.customer, rush)
  const issues = issuesOfWorkOrder(block.issues.value, workOrder.id, block.customer)
  const supervisor = supervisorFactOf(workOrder)
  const items = [
    { label: t('customerCard.row.requests'), value: <RequestsRow block={block} part={block.requests} requests={requests} prefix={model.prefix} now={card.now} onRetry={actions?.customerCard?.onRetry} /> },
    { label: t('customerCard.row.approvals'), value: <ApprovalsRow part={block.approvals} onRetry={actions?.customerCard?.onRetry} /> },
    { label: t('customerCard.row.urgency'), value: <UrgencyRow block={block} lines={lines} card={card} actions={actions} /> },
    ...(supervisor.kind !== 'none' && model.supervisor ? [{ label: t('customerCard.row.supervisor'), value: <SupervisorFact fact={supervisor} can={model.supervisor.can} {...(actions?.supervisor?.onOpen ? { onChange: actions.supervisor.onOpen } : {})} /> }] : []),
    { label: t('customerCard.row.problems'), value: <ProblemsRow part={block.issues} issues={issues} model={model} actions={actions} /> },
    { label: t('customerCard.row.limits'), value: <LimitsRow block={block} prefix={model.prefix} partiesView={!!model.partiesView} onRetry={actions?.customerCard?.onRetry} /> },
    { label: tl('limits.sees.title', { name }), value: <SeesRow block={block} name={name} model={model} workOrder={workOrder} many={many} actions={actions} /> },
  ]
  return (
    <Card padded className="fw-pr-card fw-pcc" aria-label={t('customerCard.aria', { name })}>
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{name}</h2>
        <span className="fw-pr-hint">{t('customerCard.title')}</span>
      </div>
      {many && <p className="fw-pr-hint">{t('customerCard.mixedBlock', { count: block.customer.orders.length })}</p>}
      {card.outcome && card.blocks[0]?.customer.partyId === block.customer.partyId && <OutcomeBanner card={card} actions={actions} />}
      <KeyValue items={items} />
    </Card>
  )
}

/** A part while it is read or when its read failed (never drawn as empty). */
function PartLine<T>({ part, label, onRetry }: { part: CardPart<T>; label: string; onRetry?: (() => void) | undefined }) {
  const t = useT('production')
  if (part.problem)
    return (
      <span className="fw-pr-inline">
        <span className="fw-pr-hint">{t('customerCard.failed', { part: label, why: t(part.problem) })}</span>
        {onRetry && (
          <Button size="sm" variant="quiet" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        )}
      </span>
    )
  return (
    <span role="status" aria-label={t('common.loading')}>
      <Skeleton width={220} height={18} />
    </span>
  )
}

const say = (t: ReturnType<typeof useT>, words: Phrase | null): string | null => (words ? t(words.key, words.params) : null)

// ---- Requests --------------------------------------------------------------------------------------------------------------------

function RequestsRow({ block, part, requests, prefix, now, onRetry }: { block: CustomerBlock; part: CardPart<unknown>; requests: ReturnType<typeof requestsOf> | null; prefix: string; now: number; onRetry?: (() => void) | undefined }) {
  const t = useT('production')
  const locale = useLocale()
  if (!requests) return <PartLine part={part} label={t('customerCard.row.requests')} onRetry={onRetry} />
  if (requests.waiting.length === 0 && requests.answered.length === 0) return <span className="fw-pr-hint">{t('customerCard.requests.none', { name: block.customer.name })}</span>
  const order = (row: { orderNumber: string; customerRef: string | null }) => (block.customer.orders.length > 1 ? ` · ${row.customerRef ? t('customerCard.po', { po: row.customerRef, number: row.orderNumber }) : row.orderNumber}` : '')
  return (
    <ul className="fw-pr-list fw-pcc-rows">
      {requests.waiting.map((row) => (
        <li key={row.id} className="fw-pr-inline">
          <Tag tone={row.waitingOn === 'US' ? 'warning' : 'info'}>{row.kindWords[locale]}</Tag>
          <span>
            {row.standing[locale]}
            {order(row)}
            {row.waitingOn === 'US' ? ` · ${t('customerCard.requests.waitingOnUs', { age: say(t, ageOf(row.askedAt, now)) ?? '' })}` : ` · ${t('customerCard.requests.waitingOnThem')}`}
            {row.batch && row.batch.count > 1 ? ` · ${t('customerCard.requests.batch', { count: row.batch.count })}` : ''}
          </span>
          {row.waitingOn === 'US' && (
            <Button size="sm" variant="quiet" asChild>
              <Link href={answerHref(prefix, row.id)}>
                <ExternalLink size={13} aria-hidden /> {t('customerCard.requests.answer')}
              </Link>
            </Button>
          )}
        </li>
      ))}
      {requests.answered.map((row) => (
        <li key={row.id} className="fw-pr-hint">
          {t('customerCard.requests.answered', { kind: row.kindWords[locale], state: row.standing[locale], date: day(row.answeredAt ?? row.askedAt, locale) })}
          {row.answer ? ` · ${t('customerCard.requests.ourAnswer', { answer: row.answer })}` : ''}
        </li>
      ))}
    </ul>
  )
}

// ---- Approvals asked of the customer ---------------------------------------------------------------------------------------------

function ApprovalsRow({ part, onRetry }: { part: CardPart<Parameters<typeof approvalsOf>[0]> | null; onRetry?: (() => void) | undefined }) {
  const t = useT('production')
  const locale = useLocale()
  if (part === null) return <span className="fw-pr-hint">{t('customerCard.approvals.noRight')}</span>
  if (!part.value) return <PartLine part={part} label={t('customerCard.row.approvals')} onRetry={onRetry} />
  const { open, decided } = approvalsOf(part.value)
  if (open.length === 0 && decided.length === 0) return <span className="fw-pr-hint">{t('customerCard.approvals.none')}</span>
  return (
    <ul className="fw-pr-list fw-pcc-rows">
      {open.map((row) => (
        <li key={row.id} className="fw-pr-inline">
          <Tag tone="warning">{KIND_RULES[row.kind].name[locale]}</Tag>
          <span>{t('customerCard.approvals.open', { record: row.record.words[locale], date: day(row.dueAt, locale) })}</span>
        </li>
      ))}
      {decided.map((row) => (
        <li key={row.id} className="fw-pr-hint">
          {t('customerCard.approvals.decided', { kind: KIND_RULES[row.kind].name[locale], state: t(`customerCard.approvals.status.${row.status}`), date: day(row.answer?.at ?? row.createdAt, locale) })}
          {row.answer?.via === 'OFFICE' ? ` · ${t('customerCard.approvals.byUs')}` : ''}
        </li>
      ))}
    </ul>
  )
}

// ---- Customer urgency ------------------------------------------------------------------------------------------------------------

function UrgencyRow({ block, lines, card, actions }: { block: CustomerBlock; lines: readonly UrgencyLine[]; card: CustomerCardModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const locale = useLocale()
  const read = block.urgency.value
  if (!read) return <PartLine part={block.urgency} label={t('customerCard.row.urgency')} onRetry={actions?.customerCard?.onRetry} />
  return (
    <div className="fw-pr-stack fw-pcc-tight">
      {!read.urgency.on && <span className="fw-pr-hint">{read.urgency.dormant ? read.urgency.dormant[locale] : t('customerCard.urgency.off')}</span>}
      {lines.length === 0 ? (
        <span className="fw-pr-hint">{t('customerCard.urgency.notListed')}</span>
      ) : (
        <ul className="fw-pr-list fw-pcc-rows">
          {lines.map((line) => {
            const words = urgencyWordsOf(line, locale)
            const by = urgencyByOf(line)
            return (
              <li key={line.order.id} className="fw-pr-stack fw-pcc-tight">
                <span className="fw-pr-inline">
                  {block.customer.orders.length > 1 && <b>{line.order.customerRef ? t('customerCard.po', { po: line.order.customerRef, number: line.order.number }) : line.order.number}</b>}
                  <Tag tone={line.state === 'URGENT' || line.state === 'ASKED' ? 'danger' : line.state === 'SET_BACK' ? 'warning' : 'neutral'}>
                    {line.state === 'URGENT' || line.state === 'ASKED' ? <Zap size={11} aria-hidden /> : null} {t(words.key, words.params)}
                  </Tag>
                  {line.order.locked && (
                    <Tag tone="warning" title={t('customerCard.urgency.lockedHint')}>
                      <Lock size={11} aria-hidden /> {t('customerCard.urgency.locked')}
                    </Tag>
                  )}
                  {urgencyActsOf(line, card.busy).map(({ act, held }) => (
                    <Button key={act} size="sm" variant="quiet" heldReason={say(t, held)} aria-haspopup="dialog" onClick={() => actions?.customerCard?.onDialog?.({ act, partyId: block.customer.partyId, orders: block.customer.orders.filter((order) => order.id === line.order.id) })}>
                      {act === 'unlock' ? <Unlock size={13} aria-hidden /> : act === 'lock' ? <Lock size={13} aria-hidden /> : null} {t(`customerCard.urgency.act.${act}`)}
                    </Button>
                  ))}
                </span>
                {by.set && (
                  <span className="fw-pr-hint">
                    {by.set.byUs ? t('customerCard.urgency.setByUs', { name: by.set.name ?? t('customerCard.someone'), date: day(by.set.at, locale) }) : t('customerCard.urgency.setByThem', { name: by.set.name ?? t('customerCard.someone'), date: day(by.set.at, locale) })}
                    {by.lock ? ` · ${t('customerCard.urgency.lockedBy', { name: by.lock.name ?? t('customerCard.someone'), date: by.lock.at ? day(by.lock.at, locale) : '—' })}` : ''}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <span className="fw-pr-hint">{t('customerCard.urgency.hint')}</span>
    </div>
  )
}

function OutcomeBanner({ card, actions }: { card: CustomerCardModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const locale = useLocale()
  const outcome = card.outcome
  if (!outcome) return null
  const tone = outcome.notDone.length === 0 ? 'success' : outcome.done.length === 0 ? 'warning' : 'info'
  return (
    <Banner
      tone={tone}
      title={outcome.done.length > 0 ? t(`customerCard.urgency.outcome.${outcome.act}`, { numbers: outcome.done.join(', ') }) : t('customerCard.urgency.outcome.none')}
      action={
        <Button size="sm" variant="quiet" onClick={() => actions?.customerCard?.onDismissOutcome?.()}>
          {t('common.dismiss')}
        </Button>
      }
    >
      {outcome.notDone.length > 0 && (
        <ul className="fw-pr-list">
          {outcome.notDone.map((row) => (
            <li key={row.number}>{t('customerCard.urgency.outcome.notDone', { number: row.number, why: row.words ? row.words[locale] : t('customerCard.urgency.outcome.unchanged') })}</li>
          ))}
        </ul>
      )}
      {outcome.notShown > 0 && <p className="fw-pr-hint">{t('customerCard.urgency.outcome.notShown', { count: outcome.notShown })}</p>}
    </Banner>
  )
}

/** Set to regular… · Lock · Unlock: the order named, a reason the customer reads (not for Unlock), a fresh code; no second person. */
function UrgencyDialog({ card, actions }: { card: CustomerCardModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const dialog = card.dialog!
  const [reason, setReason] = useState(card.draft?.reason ?? '')
  const [lock, setLock] = useState(dialog.act === 'lock' || !!card.draft?.lock)
  const held = urgencyDialogHeld(dialog.act, reason, card.busy)
  const act: UrgencyAct = dialog.act === 'regular' && lock ? 'lock' : dialog.act
  const go = held ? null : () => actions?.customerCard?.onUrgency?.({ act: dialog.act, partyId: dialog.partyId, orders: dialog.orders, reason, lock })
  const numbers = dialog.orders.map((order) => (order.customerRef ? t('customerCard.po', { po: order.customerRef, number: order.number }) : order.number)).join(', ')
  return (
    <Modal
      open
      onClose={() => actions?.customerCard?.onDialog?.(null)}
      title={t(`customerCard.dialog.title.${dialog.act}`, { numbers })}
      size="md"
      footer={
        <span className="fw-pr-actions">
          <Button size="sm" variant="quiet" onClick={() => actions?.customerCard?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={say(t, held)} onClick={() => go?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {card.busy ? <Spinner size={12} /> : act === 'unlock' ? <Unlock size={13} aria-hidden /> : act === 'lock' ? <Lock size={13} aria-hidden /> : null} {t(`customerCard.dialog.go.${act}`)}
          </Button>
        </span>
      }
    >
      <form
        className="fw-pr-dialog"
        onSubmit={(event) => (event.preventDefault(), go?.())}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && go) {
            event.preventDefault()
            go()
          }
        }}
      >
        {card.problem && <Banner tone="danger" title={t(card.problem.key, card.problem.params)} />}
        <p>{t(`customerCard.dialog.body.${act}`)}</p>
        {dialog.act !== 'unlock' && (
          <>
            <Field label={t('customerCard.dialog.reason')} hint={t('customerCard.dialog.reasonHint', { count: CARD_LIMITS.reason })}>
              <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={CARD_LIMITS.reason} autoFocus />
            </Field>
            {dialog.act === 'regular' && <Checkbox checked={lock} onChange={(event) => setLock(event.target.checked)} label={t('customerCard.dialog.alsoLock')} />}
          </>
        )}
        <p className="fw-pr-hint">{t('customerCard.dialog.stepUp')}</p>
      </form>
    </Modal>
  )
}

// ---- Open problems ---------------------------------------------------------------------------------------------------------------

function ProblemsRow({ part, issues, model, actions }: { part: CardPart<unknown>; issues: ReturnType<typeof issuesOfWorkOrder>; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const locale = useLocale()
  const frame = useRecordFrame()
  if (!part.value) return <PartLine part={part} label={t('customerCard.row.problems')} onRetry={actions?.customerCard?.onRetry} />
  if (issues.length === 0) return <span className="fw-pr-hint">{t('customerCard.problems.none')}</span>
  return (
    <ul className="fw-pr-list fw-pcc-rows">
      {issues.map((issue) => {
        const pick = issueThreadOf(issue, model.threadChoices ?? [])
        const threadHeld = pick === null ? t('customerCard.problems.threadHeld') : null
        return (
          <li key={issue.id} className="fw-pr-stack fw-pcc-tight">
            <span className="fw-pr-inline">
              <Tag tone={issue.source === 'BRAND' ? 'warning' : 'info'}>{issue.sourceWords[locale]}</Tag>
              <span>
                {t('customerCard.problems.waitingSince', { date: day(issue.raisedAt, locale) })}
                {issue.salesOrder ? ` · ${issue.salesOrder.number}` : issue.record.type === 'WorkOrder' ? ` · ${issue.record.label}` : ''}
              </span>
              {issue.note === 'NO_REPLY_YET' && (
                <Tag tone="danger">
                  <AlertTriangle size={11} aria-hidden /> {issue.noteWords ? issue.noteWords[locale] : t('customerCard.problems.noReply')}
                </Tag>
              )}
              <Button
                size="sm"
                variant="quiet"
                heldReason={threadHeld}
                onClick={() => {
                  if (pick === null) return
                  actions?.orderFiles?.onThread?.(pick)
                  frame?.showThread?.()
                }}
              >
                <MessageSquare size={13} aria-hidden /> {t('customerCard.problems.openThread')}
              </Button>
            </span>
            {issue.excerpt && <span className="fw-pr-hint fw-pcc-excerpt">“{issue.excerpt}”</span>}
            {issue.escalation && <span className="fw-pr-hint">{issue.escalation.words[locale]}</span>}
            {issue.batch && issue.batch.issues > 1 && <span className="fw-pr-hint">{t('customerCard.problems.batch', { count: issue.batch.issues })}</span>}
          </li>
        )
      })}
    </ul>
  )
}

// ---- Limits and what the customer sees -------------------------------------------------------------------------------------------

function LimitsRow({ block, prefix, partiesView, onRetry }: { block: CustomerBlock; prefix: string; partiesView: boolean; onRetry?: (() => void) | undefined }) {
  const t = useT('production')
  const tl = useT(LIMITS_NS)
  const locale = useLocale()
  if (block.limits === null) return <span className="fw-pr-hint">{t('customerCard.limits.noRight')}</span>
  if (!block.limits.value) return <PartLine part={block.limits} label={t('customerCard.row.limits')} onRetry={onRetry} />
  const line = limitsLineOf(block.limits.value)
  return (
    <span className="fw-pr-inline">
      <span>
        {tl(`limits.level.${line.level}`)} · {line.urgencyOn ? t('customerCard.limits.urgencyOn', { max: line.max, now: line.now }) : t('customerCard.limits.urgencyOff')}
        {!line.urgencyOn && line.dormant ? ` · ${line.dormant[locale]}` : ''}
      </span>
      {partiesView ? (
        <Button size="sm" variant="quiet" asChild>
          <Link href={limitsHref(prefix, block.customer.partyId)}>{t('customerCard.limits.open')}</Link>
        </Button>
      ) : (
        <span className="fw-pr-hint">{t('customerCard.limits.openNoRight')}</span>
      )}
    </span>
  )
}

function SeesRow({ block, name, model, workOrder, many, actions }: { block: CustomerBlock; name: string; model: WorkOrderRecordModel; workOrder: WorkOrder; many: boolean; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const tl = useT(LIMITS_NS)
  const fact = customerFactOf(workOrder)
  // PW-08: the preview opens only the work order's ONE customer's portal (an older work order of several: held in words).
  const wait = model.preview ? previewHeld(many ? { kind: 'mixed' } : fact, model.preview.can, model.preview.busy) : { key: 'band.previewNoRight' }
  const sections = block.limits?.value ? seesOf(block.limits.value) : null
  return (
    <div className="fw-pr-stack fw-pcc-tight">
      {sections ? (
        <>
          <span className="fw-pr-hint">{tl('limits.sees.always')}</span>
          <span className="fw-pr-inline">
            {sections.map((entry) => (
              <Tag key={entry.section} tone={entry.shared ? 'success' : 'neutral'}>
                {tl(entry.shared ? 'limits.sees.shown' : 'limits.sees.hidden', { what: tl(`limits.section.${entry.section}`) })}
              </Tag>
            ))}
          </span>
        </>
      ) : (
        <span className="fw-pr-hint">{t('customerCard.sees.withoutLimits')}</span>
      )}
      <span className="fw-pr-inline">
        <Button size="sm" heldReason={say(t, wait)} onClick={() => actions?.onPreview?.()}>
          <Eye size={13} aria-hidden /> {t('customerCard.sees.open', { name })}
        </Button>
        <span className="fw-pr-hint">{t('band.previewHint')}</span>
      </span>
    </div>
  )
}
