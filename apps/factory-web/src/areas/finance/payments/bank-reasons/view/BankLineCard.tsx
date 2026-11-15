'use client'

import { Card, KeyValue } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant } from '../../../_shared/model'
import { PAY_DEPTH, PAY_DEPTH_NAMESPACES } from '../../riba/depth'
import { maskIban } from '../../riba/model'
import type { MatchConfidence, PaymentBankLine } from '../api'

export interface BankLineModel {
  /** The answer (null while read). */
  value: PaymentBankLine | null
  problem: string | null
  /** The people the payment names (who accepted the match). */
  people: ReadonlyArray<{ id: string; name: string | null }>
}

export interface BankLineActions {
  onRetry?: () => void
}

const TONE: Record<MatchConfidence, 'success' | 'warning' | 'neutral'> = { HIGH: 'success', MEDIUM: 'warning', LOW: 'neutral' }

/**
 * The payment's bank line (design finance.payments rec:Payment tab Bank line: "bank, date, amount, reference text, payer
 * IBAN; confidence and reasons (W2b)"; SCR-513): the statement line it came from — the bank and account, the day it was
 * booked and its value day, the reference text, who paid and from which account (masked) — and how sure the match was
 * (High · Medium · Low) with why (amount equal or within the write-off tolerance, the number in the reference, the IBAN
 * known, the name matching, chosen by a person), when and by whom it was accepted. A payment typed by hand says so. No
 * money in this section.
 */
export function BankLineCard({ model, actions }: { model: BankLineModel; actions?: BankLineActions }) {
  return (
    <WithMessages namespaces={PAY_DEPTH_NAMESPACES}>
      <Body model={model} actions={actions} />
    </WithMessages>
  )
}

function Body({ model, actions }: { model: BankLineModel; actions?: BankLineActions }) {
  const p = useT(PAY_DEPTH)
  const t = useT('finance')
  const locale = useLocale()
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const title = <h2 className="fw-fin-h2">{p('bankLine.title')}</h2>
  if (model.problem) {
    return (
      <Card padded className="fw-fin-card">
        {title}
        <p className="fw-fin-hint">{p('bankLine.failed', { reason: t(model.problem) })}</p>
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      </Card>
    )
  }
  const value = model.value
  if (!value) {
    return (
      <Card padded className="fw-fin-card" aria-busy="true">
        {title}
        <p className="fw-fin-hint" role="status">
          <Spinner size={12} /> {p('bankLine.reading')}
        </p>
      </Card>
    )
  }
  if (value.recordedByHand || !value.line) {
    return (
      <Card padded className="fw-fin-card">
        {title}
        <p className="fw-fin-hint">{value.recordedByHand ? p('bankLine.byHand') : p('bankLine.noRight')}</p>
      </Card>
    )
  }
  const line = value.line
  const match = line.match
  const acceptedBy = match.acceptedById ? (model.people.find((person) => person.id === match.acceptedById)?.name ?? p('riba.someone')) : null
  return (
    <Card padded className="fw-fin-card">
      {title}
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          { label: p('bankLine.bank'), value: [line.bank, line.accountIban ? maskIban(line.accountIban) : null].filter(Boolean).join(' · ') || '—' },
          { label: p('bankLine.booked'), value: line.valueOn && line.valueOn !== line.bookedOn ? p('bankLine.bookedValue', { booked: day(line.bookedOn), value: day(line.valueOn) }) : day(line.bookedOn) },
          { label: p('bankLine.reference'), value: line.referenceText ? <span className="fw-fin-code">{line.referenceText}</span> : '—' },
          { label: p('bankLine.payer'), value: [line.counterpartyName, line.counterpartyIban ? maskIban(line.counterpartyIban) : null].filter(Boolean).join(' · ') || '—' },
        ]}
      />
      <div className="fw-fin-stack-tight">
        <span className="fw-fin-inline">
          <span>{p('bankLine.confidence')}</span>
          <Pill tone={TONE[match.confidence]}>{p(`bankLine.level.${match.confidence}`)}</Pill>
        </span>
        <span className="fw-fin-chips" aria-label={p('bankLine.reasons')}>
          {match.reasons.map((reason) => (
            <Tag key={reason.code} tone="neutral">
              {p(`bankLine.reason.${reason.code}`)}
            </Tag>
          ))}
        </span>
        <p className="fw-fin-hint">
          {match.reversedAt
            ? p('bankLine.reversed', { date: formatDateTime(match.reversedAt, { locale }) })
            : match.acceptedAt
              ? p(match.chosenByPerson ? 'bankLine.chosen' : 'bankLine.accepted', { date: formatDateTime(match.acceptedAt, { locale }), name: acceptedBy ?? p('riba.someone') })
              : p('bankLine.notAccepted')}
        </p>
      </div>
      <Button size="sm" heldReason={p('bankLine.statementLater')}>
        {p('bankLine.openStatement')}
      </Button>
    </Card>
  )
}
