'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { Check, Search, X } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { VersionCompare } from '@nexus/ui/patterns/VersionCompare/index'
import { Button, Input, Spinner } from '@nexus/ui/primitives'
import { DetailModal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE, type Locale } from '../../../../lib/i18n/locales'
import type { OperationMinutesView, OrderView, RequestView } from '../api'
import { decideHeld, operationHref, recordHref, styleHref, type ChangeRow, type DecideChoice, type Notice, type Phrase } from '../model'
import { isPageKey, KindTag, NoticeLine, OrderPill, PriorityTag, RequestPill, useWords } from '../parts'
import { OrderImpact, RequestImpact, type DriftPart } from './Impact'
import { Redline, type RedlineModel } from './Redline'

export interface DecideModel {
  /** The change decided (its kind, number, title, style). */
  row: ChangeRow
  /** The list's rows in the order shown (J / K walk them). */
  ids: readonly string[]
  /** The record is being read; `problem` when the read failed. */
  reading: boolean
  problem: string | null
  order: OrderView | null
  request: RequestView | null
  minutes: OperationMinutesView | null
  /** A change order's redline and the open quotes and orders on older revisions. */
  redline: RedlineModel | null
  drift: DriftPart | null
  /** Why each button is held (no right, its rule, offline), from what the record says. */
  holds: Partial<Record<DecideChoice, Phrase | null>>
  reason: string
  busy: boolean
  notice: Notice | null
  offline: boolean
}

export interface DecideActions {
  onReason?: (reason: string) => void
  onDecide?: (choice: DecideChoice) => void
  onGo?: (rowId: string) => void
  onClose?: () => void
  onRetry?: () => void
}

/**
 * Approve change (design products.changes pop:changes.decide, a DetailModal; opened from a row's Approve / Reject, the
 * record's band, and by its address `?decide=<kind>:<id>` for Home › Approvals): the redline summary (VersionCompare per
 * part that differs) and the impact (work in progress, open quotes and orders on older revisions) of a change order; what
 * and why of a change request (accept, reject, or into review: the triage); the old and new standard minutes of an SMV
 * change with the routings it reaches. A approves, R rejects (a rejection says why: the why takes the focus),
 * J / K the next and previous change of the list (the DetailModal's own keys). Each button is held with its reason.
 */
export function DecideDialog({ model, prefix, canWorkOrders, actions }: { model: DecideModel; prefix: string; canWorkOrders: boolean; actions?: DecideActions }) {
  const { t, say } = useWords()
  const reasonRef = useRef<HTMLInputElement>(null)
  const act = useRef(actions)
  act.current = actions
  const row = model.row
  const ready = !model.reading && !model.problem
  const held = (choice: DecideChoice): string | null => (model.busy ? t('common.working') : !ready ? t('decide.heldReading') : say(decideHeld(choice, model.reason, model.holds[choice] ?? null)))

  // A approves, R rejects (or puts the focus on the why when it is still empty) — not while typing in the why.
  const stateRef = useRef({ ready, model })
  stateRef.current = { ready, model }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event, true)) return
      const { ready: isReady, model: now } = stateRef.current
      if (!isReady || now.busy) return
      const key = event.key.toLowerCase()
      if (key === 'a' && !decideHeld('APPROVED', now.reason, now.holds.APPROVED ?? null)) {
        event.preventDefault()
        act.current?.onDecide?.('APPROVED')
      } else if (key === 'r') {
        event.preventDefault()
        if (!now.reason.trim()) reasonRef.current?.focus()
        else if (!decideHeld('REJECTED', now.reason, now.holds.REJECTED ?? null)) act.current?.onDecide?.('REJECTED')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const approveLabel = row.kind === 'request' ? t('decide.accept') : t('decide.approve')
  const footer = (
    <div className="fw-chg-decide-foot">
      <NoticeLine notice={model.notice} />
      <div className="fw-chg-decide-row">
        <Field label={t('decide.reason')} hint={t('decide.reasonHint')}>
          <Input ref={reasonRef} size="sm" maxLength={2000} value={model.reason} onChange={(event) => actions?.onReason?.(event.target.value)} />
        </Field>
        <div className="fw-chg-actions">
          {row.kind === 'request' && (
            <Button size="sm" variant="quiet" heldReason={held('IN_REVIEW')} onClick={() => actions?.onDecide?.('IN_REVIEW')}>
              <Search size={14} aria-hidden /> {t('decide.review')}
            </Button>
          )}
          <Button size="sm" variant="danger" heldReason={held('REJECTED')} onClick={() => actions?.onDecide?.('REJECTED')} aria-keyshortcuts="r">
            <X size={14} aria-hidden /> {t('decide.reject')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held('APPROVED')} onClick={() => actions?.onDecide?.('APPROVED')} aria-keyshortcuts="a">
            <Check size={14} aria-hidden /> {approveLabel}
          </Button>
        </div>
      </div>
      <p className="fw-chg-hint">{t('decide.keys')}</p>
    </div>
  )

  return (
    <DetailModal
      open
      onClose={() => actions?.onClose?.()}
      title={t('decide.title')}
      subtitle={`${say(row.number ? { key: 'row.number', params: { number: row.number } } : { key: 'row.floorNoNumber' })} · ${row.title}`}
      meta={
        <span className="fw-chg-row">
          <KindTag kind={row.kind} />
          {row.kind === 'request' && <RequestPill status={(model.request ?? row.request).status} />}
          {row.kind === 'order' && <OrderPill status={(model.order ?? row.order).status} />}
        </span>
      }
      nav={{ ids: model.ids, current: row.id, onGo: (id) => actions?.onGo?.(id), noun: t('decide.noun') }}
      loading={model.reading}
      error={model.problem ? t(model.problem) : undefined}
      onRetry={() => actions?.onRetry?.()}
      footer={footer}
    >
      {model.offline && <Banner tone="warning" title={t('held.offline')} />}
      {row.kind === 'order' && model.order && <OrderBody order={model.order} model={model} prefix={prefix} canWorkOrders={canWorkOrders} />}
      {row.kind === 'request' && model.request && <RequestBody request={model.request} prefix={prefix} canWorkOrders={canWorkOrders} />}
      {row.kind === 'smv' && <SmvBody row={row} minutes={model.minutes} prefix={prefix} />}
    </DetailModal>
  )
}

function OrderBody({ order, model, prefix, canWorkOrders }: { order: OrderView; model: DecideModel; prefix: string; canWorkOrders: boolean }) {
  const { t, day } = useWords()
  return (
    <div className="fw-chg-stack">
      <KeyValue
        columns={3}
        labelCase="sentence"
        items={[
          { label: t('field.style'), value: `${order.style.code} · ${order.style.name}` },
          { label: t('col.revision'), value: order.toRevision ? t('revision.move', { from: order.fromRevision.revision, to: order.toRevision.revision }) : t('revision.noDraft', { from: order.fromRevision.revision }) },
          { label: t('col.effective'), value: order.effect === 'DATE' ? day(order.effectiveDate) : t(`effect.${order.effect}`) },
          { label: t('col.priority'), value: <PriorityTag priority={order.priority} /> },
          { label: t('col.approvals'), value: t('approvals.count', { approved: order.approvals.approved, required: order.approvals.required }) },
          { label: t('order.requestsCarried'), value: String(order.requestsList.length) },
        ]}
      />
      <p className="fw-chg-text">{order.reason}</p>
      {order.description && <p className="fw-chg-text">{order.description}</p>}
      <h3 className="fw-chg-h3">{t('decide.redline')}</h3>
      {model.redline && <Redline model={model.redline} />}
      <h3 className="fw-chg-h3">{t('tab.impact')}</h3>
      <OrderImpact order={order} lines={null} wipHeld={null} drift={model.drift} prefix={prefix} canWorkOrders={canWorkOrders} />
      <Link className="fw-chg-link" href={recordHref(prefix, 'order', order.id)}>
        {t('decide.openRecord', { number: order.number })}
      </Link>
    </div>
  )
}

function RequestBody({ request, prefix, canWorkOrders }: { request: RequestView; prefix: string; canWorkOrders: boolean }) {
  const { t, say } = useWords()
  return (
    <div className="fw-chg-stack">
      <KeyValue
        columns={3}
        labelCase="sentence"
        items={[
          { label: t('col.raisedBy'), value: say(request.party ? { key: 'raised.party', params: { source: `source.${request.source}`, party: request.party.name } } : { key: `source.${request.source}` }) },
          {
            label: t('field.style'),
            value: (
              <Link className="fw-chg-link" href={styleHref(prefix, request.style.id, request.revision?.id)}>
                {request.style.code} · {request.style.name}
              </Link>
            ),
          },
          { label: t('col.revision'), value: request.revision ? t('revision.label', { revision: request.revision.revision }) : t('revision.asItIs') },
          { label: t('col.priority'), value: <PriorityTag priority={request.priority} /> },
          { label: t('field.photos'), value: String(request.photosList.length) },
        ]}
      />
      <h3 className="fw-chg-h3">{request.title}</h3>
      <p className="fw-chg-text">{request.reason}</p>
      <h3 className="fw-chg-h3">{t('tab.impact')}</h3>
      <RequestImpact request={request} prefix={prefix} canWorkOrders={canWorkOrders} />
      <Link className="fw-chg-link" href={recordHref(prefix, 'request', request.id)}>
        {t('decide.openRecord', { number: request.number ?? t('row.floorNoNumber') })}
      </Link>
    </div>
  )
}

const SMV_FIELDS = ['basic', 'personal', 'fatigue', 'delay', 'smv', 'from'] as const

function SmvBody({ row, minutes, prefix }: { row: Extract<ChangeRow, { kind: 'smv' }>; minutes: OperationMinutesView | null; prefix: string }) {
  const { t, locale } = useWords()
  const ds = useDsWords()
  const { operation, proposal } = row.smv
  const current = minutes?.current
  return (
    <div className="fw-chg-stack">
      <KeyValue
        columns={3}
        labelCase="sentence"
        items={[
          {
            label: t('smv.operation'),
            value: (
              <Link className="fw-chg-link" href={operationHref(prefix, operation.id)}>
                {operation.code} · {operation.name}
              </Link>
            ),
          },
          { label: t('smv.source'), value: t(`smvSource.${proposal.source}`) },
          { label: t('smv.proposedBy'), value: proposal.proposedBy.name },
        ]}
      />
      <p className="fw-chg-text">{proposal.reason}</p>
      <div className="fw-chg-bleed">
        <VersionCompare
          before={{ label: t('smv.now'), note: minutes ? (minutes.inForce.number ? t('smv.version', { number: minutes.inForce.number }) : t('smv.own')) : null }}
          after={{ label: t('smv.version', { number: proposal.number }), note: t('smv.PROPOSED') }}
          lines={[
            {
              id: proposal.id,
              label: `${operation.code} · ${operation.name}`,
              before: { fields: { basic: current?.basicMinutes ?? null, personal: current?.personalPct ?? null, fatigue: current?.fatiguePct ?? null, delay: current?.delayPct ?? null, smv: current?.standardMinutes ?? operation.standardMinutes, from: minutes?.inForce.effectiveFrom ?? null } },
              after: { fields: { basic: proposal.basicMinutes, personal: proposal.personalPct, fatigue: proposal.fatiguePct, delay: proposal.delayPct, smv: proposal.standardMinutes, from: proposal.effectiveFrom } },
            },
          ]}
          fields={SMV_FIELDS.map((id) => ({ id, label: t(`smv.field.${id}`) }))}
          locale={INTL_LOCALE[locale as Locale]}
          labels={ds.versionCompare}
        />
      </div>
      <h3 className="fw-chg-h3">{t('tab.impact')}</h3>
      {!minutes ? (
        <p className="fw-chg-hint" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : (
        <ul className="fw-chg-picks" aria-label={t('tab.impact')}>
          {minutes.impact.routings.length === 0 && <li className="fw-chg-hint">{t('smv.noRoutings')}</li>}
          {minutes.impact.routings.map((use) => (
            <li key={use.stepId} className="fw-chg-pick">
              <span>
                {use.style.code} · {t('revision.label', { revision: use.revision.revision })} · {t('smv.step', { seq: use.seq })}
              </span>
              <span className="fw-chg-hint">{t(`smvRun.${use.runFrom}`)}</span>
            </li>
          ))}
          <li className="fw-chg-hint">{t('smv.pieceRates', { count: minutes.impact.pieceRates.count })}</li>
        </ul>
      )}
    </div>
  )
}
