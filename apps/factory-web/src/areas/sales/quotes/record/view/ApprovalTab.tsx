'use client'

import { CheckCircle2, CircleDashed, XCircle } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { QuoteDetail } from '../../api'
import { APPROVAL_TONE, decideHeld, percent, pendingRequest } from '../../model'
import type { QuoteRecordActions, QuoteRecordViewModel } from '../record-model'

/**
 * Approval (design `quote.approval.rules`, `quote.approval.requests`): which rules this version breaks, checked live —
 * the margin against the floor with its numbers only for the margin grain, the discount against the limit — who decides,
 * and every request with who asked, who decided and why. The requester asks or withdraws; an approver approves or
 * rejects here or from Home › Approvals; the person who asked never decides (held, with the reason, before the click).
 */
export function ApprovalTab({ quote, model, actions }: { quote: QuoteDetail; model: QuoteRecordViewModel; actions?: QuoteRecordActions }) {
  const t = useT('sales')
  const locale = useLocale()
  const rules = quote.approval.rules
  const request = pendingRequest(quote)
  const held = decideHeld(quote, model.me, model.can, model.grains)
  const rounds = model.approvals.items
  const who = (person: { name: string | null; you: boolean } | null) => (person ? (person.you ? t('common.you') : (person.name ?? t('common.colleague'))) : '—')

  return (
    <div className="fw-q-stack">
      <Card padded>
        <h2 className="fw-q-h2">{t('approval.rules.title')}</h2>
        {rules.every((rule) => !rule.broken) ? (
          <p className="fw-q-hint">{t('approval.rules.none')}</p>
        ) : null}
        <ul className="fw-q-rules">
          {rules.map((rule) => (
            <li key={rule.reason} className="fw-q-rule">
              {!rule.known ? <CircleDashed size={16} aria-hidden className="fw-q-ico" /> : rule.broken ? <XCircle size={16} aria-hidden className="fw-q-ico is-warning" /> : <CheckCircle2 size={16} aria-hidden className="fw-q-ico is-passes" />}
              <span>
                <strong>{t(`ruleName.${rule.reason}`)}</strong> — {t(!rule.known ? 'approval.rules.unknown' : rule.broken ? 'approval.rules.broken' : 'approval.rules.passes')}
                {rule.reason === 'MARGIN_FLOOR' && model.grains.margin && quote.current.marginPct !== undefined && (
                  <span className="fw-q-hint"> {t('approval.rules.marginNumbers', { pct: percent(quote.current.marginPct, locale), floor: percent(quote.current.marginFloorPct ?? quote.approval.marginFloorPct, locale) })}</span>
                )}
                {rule.reason === 'DISCOUNT_LIMIT' && <span className="fw-q-hint"> {t('approval.rules.discountLimit', { limit: percent(quote.approval.discountLimitPct, locale) })}</span>}
                {rule.lines.length > 0 && <span className="fw-q-hint"> {t('approval.rules.lines', { lines: rule.lines.join(', ') })}</span>}
              </span>
            </li>
          ))}
        </ul>
        <p className="fw-q-hint">{t('approval.who')}</p>
        <div className="fw-q-actions">
          {quote.current.status === 'DRAFT' && quote.approval.needed && (
            <Button size="sm" variant="primary" heldReason={!model.can.manage ? t('held.noManage') : !quote.canAskApproval ? t('held.cannotAsk') : null} onClick={() => actions?.onDialog?.('ask')}>
              {t('action.ask')}
            </Button>
          )}
          {request && (
            <>
              {(request.createdById === model.me || model.can.manage) && (
                <Button size="sm" heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => actions?.onDialog?.('withdraw')}>
                  {t('action.withdraw')}
                </Button>
              )}
              {model.can.approve && (
                <>
                  <Button size="sm" variant="danger-outline" heldReason={held ? t(held) : null} onClick={() => actions?.onDialog?.('reject')}>
                    {t('action.reject')}
                  </Button>
                  <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onDialog?.('approve')}>
                    {t('action.approve')}
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      </Card>

      <Card padded>
        <h2 className="fw-q-h2">{t('approval.requests.title')}</h2>
        {model.approvals.problem ? (
          <Banner tone="danger" title={t(model.approvals.problem)} />
        ) : rounds === null ? (
          <p className="fw-q-hint" role="status">
            <Spinner size={14} /> {t('approval.requests.loading')}
          </p>
        ) : rounds.length === 0 ? (
          <EmptyState title={t('approval.requests.none')} />
        ) : (
          <ol className="fw-q-rounds">
            {rounds.map((round) => (
              <li key={round.id} className="fw-q-round">
                <div className="fw-q-round-head">
                  <Pill tone={APPROVAL_TONE[round.status]}>{t(`approvalStatus.${round.status}`)}</Pill>
                  <Tag>{t('record.versionChip', { revision: round.revision })}</Tag>
                  <span className="fw-q-tags">
                    {round.reasons.map((reason) => (
                      <Tag key={reason} tone="warning">
                        {t(`reason.${reason}`)}
                      </Tag>
                    ))}
                  </span>
                </div>
                <p className="fw-q-round-line">{t('approval.requests.asked', { who: who(round.askedBy), at: formatDateTime(round.askedAt, { locale }) })}</p>
                {round.requestNote && <p className="fw-q-quote">“{round.requestNote}”</p>}
                {round.decidedAt && (
                  <p className="fw-q-round-line">
                    {t(round.status === 'WITHDRAWN' ? 'approval.requests.withdrawn' : 'approval.requests.decided', { who: who(round.decidedBy), at: formatDateTime(round.decidedAt, { locale }), status: t(`approvalStatus.${round.status}`) })}
                  </p>
                )}
                {round.decisionNote && <p className="fw-q-quote">“{round.decisionNote}”</p>}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  )
}
