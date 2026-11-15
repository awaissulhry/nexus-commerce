'use client'

import { useEffect, useRef, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowUp, Check, Scissors, Undo2 } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, Pill, Radio, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { dayInstant, money } from '../../_shared/model'
import { WRITE_OFF_REASONS, type BankLine, type BankMatch, type WriteOffReason } from '../api'
import { acceptHeld, chooseHeld, CONFIDENCE_TONE, invoiceHref, LEAVE_HELD, maskIban, paymentHref, recordsPayment, reverseHeld, supplierInvoiceHref, type Phrase } from '../model'
import type { BankModel } from './BankView'

export interface WriteOffDraft {
  on: boolean
  reason: WriteOffReason
  note: string
}

/** The match panel's own state (the container keeps it; the view draws it). */
export interface MatchState {
  /** The suggestion chosen (by default the surest that can be accepted). */
  readonly picked: string | null
  readonly busy: boolean
  readonly problems: readonly Phrase[] | null
  readonly writeOff: WriteOffDraft
  /** The month is soft-locked: accepting again asks why it goes in (accounting's override). */
  readonly lockAsked: boolean
  readonly lockReason: string
  /** The last acceptance, said once (the payment it recorded opens in a new tab). */
  readonly accepted: { readonly lineId: string; readonly paymentId: string | null; readonly recorded: boolean } | null
}

export const MATCH_IDLE: MatchState = { picked: null, busy: false, problems: null, writeOff: { on: false, reason: 'ROUNDING', note: '' }, lockAsked: false, lockReason: '', accepted: null }

export interface MatchActions {
  onPick?: (matchId: string) => void
  onWriteOff?: (next: WriteOffDraft) => void
  onLockReason?: (text: string) => void
  onAccept?: () => void
  onChoose?: () => void
  onReverse?: () => void
  onStep?: (by: 1 | -1) => void
}

/**
 * The design's "NEW MatchPanel" (sec:match "Bank lines on the left, suggested invoices on the right, with how sure and
 * why"; a one-area part composed from DS Card, KeyValue, Radio, Pill, Tag, Button): the open line — booked and value day,
 * amount (price grain), reference text, the bank's reference, the payer and its account (masked) — and its suggestions, each
 * with the customer, the invoices or deposit requests it pays (and what is open on each), High · Medium · Low and the reasons
 * in words, and what accepting would leave (a small difference that may be written off within the tolerance). Accept the
 * chosen one (Enter), Choose another / Split (s), Leave unmatched (held: no column says a line is set aside yet); a matched
 * line shows its acceptance, its payment (a real link: ⌘-click opens the Payment record in a new tab) and Take back. J / K
 * step through the list's lines while the panel has the focus.
 */
export function MatchPanel({ model, focusNonce, actions, onRetry }: { model: BankModel; focusNonce: number; actions?: MatchActions; onRetry?: () => void }) {
  const t = useT('finance-bank')
  const locale = useLocale()
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focusNonce > 0) panel.current?.focus()
  }, [focusNonce])
  const line = model.current.value
  const rows = model.lines.rows ?? []
  const at = line ? rows.findIndex((row) => row.id === line.id) : -1
  const state = model.match
  const can = model.can
  const phrase = (entry: Phrase) => t(entry.key, entry.params)
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const amount = (minor: number | undefined, currency: string) => (can.price ? money(minor === undefined ? null : minor, currency, locale) : '—')

  const picked = line ? (line.suggestions.find((match) => match.id === state.picked) ?? line.suggestions.find((match) => !match.stale) ?? null) : null
  // The missing right first (it holds every line), then what holds this line.
  const held = !can.match ? { key: 'held.match' } : line && picked ? acceptHeld(line, picked, can) : line && line.state === 'MATCHED' ? { key: 'held.matched' } : { key: 'held.noPick' }
  const acceptHeldWords = state.busy ? t('held.busy') : held ? phrase(held) : state.writeOff.on && state.writeOff.reason === 'OTHER' && state.writeOff.note.trim() === '' ? t('held.writeOffNote') : state.lockAsked && state.lockReason.trim() === '' ? t('held.lockReason') : null
  const chooseWords = line ? chooseHeld(line, can) : { key: 'held.noLine' }
  const reverseWords = line ? reverseHeld(line, can) : { key: 'held.noLine' }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return
    if (event.key === 'j' || event.key === 'k') {
      event.preventDefault()
      event.stopPropagation()
      actions?.onStep?.(event.key === 'j' ? 1 : -1)
    } else if (event.key === 'Enter' && target === panel.current) {
      event.preventDefault()
      event.stopPropagation()
      if (!acceptHeldWords) actions?.onAccept?.()
    } else if (event.key === 's') {
      event.preventDefault()
      event.stopPropagation()
      if (!chooseWords) actions?.onChoose?.()
    } else if (/^[1-3]$/.test(event.key) && line && line.state === 'TO_MATCH') {
      const match = line.suggestions[Number(event.key) - 1]
      if (match) {
        event.preventDefault()
        event.stopPropagation()
        actions?.onPick?.(match.id)
      }
    }
  }

  return (
    <div
      ref={panel}
      className="fw-bank-panel"
      tabIndex={0}
      role="region"
      aria-label={t('panel.label')}
      aria-keyshortcuts="j k Enter s 1 2 3"
      onKeyDown={onKeyDown}
    >
      <Card padded className="fw-bank-card">
        <div className="fw-bank-panel-head">
          <h3 className="fw-bank-h3">{line ? t('panel.title', { date: day(line.bookedOn) }) : t('panel.empty')}</h3>
          <span className="fw-bank-inline">
            {at >= 0 && <span className="fw-bank-muted">{t('panel.position', { at: at + 1, count: rows.length })}</span>}
            <Button size="sm" variant="quiet" aria-label={t('panel.previous')} aria-keyshortcuts="k" heldReason={at <= 0 && line ? t('held.first') : rows.length === 0 ? t('held.noRows') : null} onClick={() => actions?.onStep?.(-1)}>
              <ArrowUp size={14} aria-hidden />
            </Button>
            <Button size="sm" variant="quiet" aria-label={t('panel.next')} aria-keyshortcuts="j" heldReason={at >= 0 && at === rows.length - 1 ? t('held.last') : rows.length === 0 ? t('held.noRows') : null} onClick={() => actions?.onStep?.(1)}>
              <ArrowDown size={14} aria-hidden />
            </Button>
          </span>
        </div>
        {model.current.problem ? (
          <EmptyState
            title={t('panel.failed')}
            description={t(model.current.problem)}
            action={
              <Button size="sm" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : !line ? (
          model.address.line ? (
            <p className="fw-bank-muted" role="status">
              <Spinner size={12} /> {t('panel.reading')}
            </p>
          ) : (
            <p className="fw-bank-muted">{rows.length === 0 ? t('panel.nothing') : t('panel.pick')}</p>
          )
        ) : (
          <>
            <KeyValue
              dense
              labelCase="sentence"
              columns={2}
              items={[
                { label: t('panel.booked'), value: line.valueOn && line.valueOn !== line.bookedOn ? t('panel.bookedValue', { booked: day(line.bookedOn), value: day(line.valueOn) }) : day(line.bookedOn) },
                { label: t('panel.amount'), value: <span className={`fw-bank-num${line.direction === 'OUT' ? ' is-out' : ''}`}>{`${amount(line.amount, line.currency)} · ${t(`lines.direction.${line.direction}`)}`}</span> },
                { label: t('panel.reference'), value: line.referenceText ? <span className="fw-bank-code">{line.referenceText}</span> : '—' },
                { label: t('panel.bankReference'), value: line.bankReference ? <span className="fw-bank-code">{line.bankReference}</span> : '—' },
                { label: t('panel.payer'), value: [line.counterpartyName, maskIban(line.counterpartyIban)].filter(Boolean).join(' · ') || '—' },
                { label: t('panel.age'), value: t('lines.days', { count: line.ageDays }) },
              ]}
            />
            {state.accepted && state.accepted.lineId === line.id && (
              <Banner tone="success" title={t(state.accepted.recorded ? 'panel.acceptedRecorded' : 'panel.accepted')}>
                {state.accepted.paymentId && (
                  <Link className="fw-bank-link" href={paymentHref(model.prefix, state.accepted.paymentId)}>
                    {t('panel.openPayment')}
                  </Link>
                )}
              </Banner>
            )}
            {line.accepted ? (
              <Accepted line={line} match={line.accepted} model={model} reverseHeld={reverseWords ? phrase(reverseWords) : null} onReverse={() => actions?.onReverse?.()} />
            ) : line.suggestions.length === 0 ? (
              <EmptyState title={t('panel.noSuggestion.title')} description={t(line.direction === 'IN' ? 'panel.noSuggestion.bodyIn' : 'panel.noSuggestion.bodyOut')} />
            ) : (
              <fieldset className="fw-bank-suggestions">
                <legend className="fw-bank-h3">{t('panel.suggestions', { count: line.suggestions.length })}</legend>
                {line.suggestions.map((match) => (
                  <Suggestion key={match.id} line={line} match={match} on={picked?.id === match.id} model={model} onPick={() => actions?.onPick?.(match.id)} />
                ))}
              </fieldset>
            )}
            {line.reversed.length > 0 && (
              <p className="fw-bank-muted">{t('panel.reversedBefore', { count: line.reversed.length, party: line.reversed[0]!.party.code, reason: line.reversed[0]!.reverseReason ?? '—' })}</p>
            )}
            {!line.accepted && picked?.difference && can.price && (
              <div className="fw-bank-stack">
                <p className="fw-bank-muted">
                  {t(`difference.${picked.difference.kind}`, { amount: amount(picked.difference.amount, line.currency) })}
                  {picked.difference.refusal ? ` ${t(`writeOff.refusal.${picked.difference.refusal.code}`)}` : ''}
                </p>
                {picked.difference.writable &&
                  (can.writeOff ? (
                    <div className="fw-bank-stack">
                      <Checkbox
                        checked={state.writeOff.on}
                        onChange={(event) => actions?.onWriteOff?.({ ...state.writeOff, on: event.target.checked })}
                        label={t('writeOff.tick', { amount: amount(picked.difference.amount, line.currency) })}
                      />
                      {state.writeOff.on && (
                        <span className="fw-bank-inline">
                          <Select size="sm" aria-label={t('writeOff.reason')} value={state.writeOff.reason} onChange={(event) => actions?.onWriteOff?.({ ...state.writeOff, reason: event.target.value as WriteOffReason })}>
                            {WRITE_OFF_REASONS.map((reason) => (
                              <option key={reason} value={reason}>
                                {t(`writeOff.reasons.${reason}`)}
                              </option>
                            ))}
                          </Select>
                          {state.writeOff.reason === 'OTHER' && (
                            <Input size="sm" aria-label={t('writeOff.note')} placeholder={t('writeOff.note')} value={state.writeOff.note} maxLength={500} onChange={(event) => actions?.onWriteOff?.({ ...state.writeOff, note: event.target.value })} />
                          )}
                        </span>
                      )}
                    </div>
                  ) : (
                    <p className="fw-bank-muted">{t('held.writeOff')}</p>
                  ))}
              </div>
            )}
            {state.lockAsked && !line.accepted && (
              <div className="fw-bank-stack">
                <p className="fw-bank-muted">{t('period.softAsk')}</p>
                <Input size="sm" aria-label={t('period.reason')} placeholder={t('period.reason')} value={state.lockReason} maxLength={500} onChange={(event) => actions?.onLockReason?.(event.target.value)} />
              </div>
            )}
            {state.problems && state.problems.length > 0 && <Banner tone="danger" title={state.problems.map(phrase).join(' ')} />}
            {!line.accepted && (
              <div className="fw-bank-actions">
                <Button size="sm" variant="primary" heldReason={acceptHeldWords} aria-keyshortcuts="Enter" onClick={() => actions?.onAccept?.()}>
                  <Check size={14} aria-hidden /> {state.busy ? t('common.working') : picked && recordsPayment(line, picked) ? t('panel.acceptRecord') : t('panel.accept')}
                </Button>
                <Button size="sm" heldReason={chooseWords ? phrase(chooseWords) : null} aria-keyshortcuts="s" onClick={() => actions?.onChoose?.()}>
                  <Scissors size={14} aria-hidden /> {t('panel.choose')}
                </Button>
                <Button size="sm" variant="quiet" heldReason={phrase(LEAVE_HELD)}>
                  {t('panel.leave')}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  )
}

function ItemsList({ match, model, currency }: { match: BankMatch; model: BankModel; currency: string }) {
  const t = useT('finance-bank')
  const locale = useLocale()
  if (match.supplierInvoiceId) {
    return (
      <ul className="fw-bank-items">
        <li>
          <Link className="fw-bank-link" href={supplierInvoiceHref(model.prefix, match.supplierInvoiceId)}>
            {t('panel.supplierInvoice', { number: match.supplierInvoice?.number ?? '—' })}
          </Link>
        </li>
      </ul>
    )
  }
  if (match.paymentId && match.items.length === 0) {
    return (
      <ul className="fw-bank-items">
        <li>
          <Link className="fw-bank-link" href={paymentHref(model.prefix, match.paymentId)}>
            {t('panel.typedPayment', { reference: match.payment?.externalRef ?? '—' })}
          </Link>
        </li>
      </ul>
    )
  }
  return (
    <ul className="fw-bank-items">
      {match.items.map((item) => (
        <li key={item.id}>
          {item.kind === 'INVOICE' ? (
            <Link className="fw-bank-link" href={invoiceHref(model.prefix, item.id)}>
              {t('panel.invoice', { number: item.number ?? '—' })}
            </Link>
          ) : (
            <span>{t('panel.deposit', { number: item.number ?? '—' })}</span>
          )}
          <span className="fw-bank-muted"> · {t('panel.open', { amount: model.can.price ? money(item.openAmount === undefined ? null : item.openAmount, currency, locale) : '—' })}</span>
        </li>
      ))}
    </ul>
  )
}

function Suggestion({ line, match, on, model, onPick }: { line: BankLine; match: BankMatch; on: boolean; model: BankModel; onPick: () => void }) {
  const t = useT('finance-bank')
  return (
    <div className={`fw-bank-suggestion${on ? ' is-on' : ''}${match.stale ? ' is-stale' : ''}`}>
      <Radio
        name={`fw-bank-pick-${line.id}`}
        checked={on}
        onChange={onPick}
        label={
          <span className="fw-bank-inline">
            <b>{match.party.legalName}</b>
            <span className="fw-bank-muted fw-bank-code">{match.party.code}</span>
          </span>
        }
      />
      <span className="fw-bank-inline">
        <span className="fw-bank-muted">{t('panel.howSure')}</span>
        <Pill tone={CONFIDENCE_TONE[match.confidence]}>{t(`confidence.${match.confidence}`)}</Pill>
      </span>
      <span className="fw-bank-chips" aria-label={t('panel.reasons')}>
        {match.reasons.map((reason) => (
          <Tag key={reason.code} tone="neutral">
            {t(`reason.${reason.code}`)}
          </Tag>
        ))}
      </span>
      <ItemsList match={match} model={model} currency={line.currency} />
      {match.stale && <p className="fw-bank-muted">{t('panel.stale')}</p>}
    </div>
  )
}

function Accepted({ line, match, model, reverseHeld, onReverse }: { line: BankLine; match: BankMatch; model: BankModel; reverseHeld: string | null; onReverse: () => void }) {
  const t = useT('finance-bank')
  const locale = useLocale()
  return (
    <div className="fw-bank-stack">
      <span className="fw-bank-inline">
        <Pill tone="success">{t('lines.matched')}</Pill>
        <b>{match.party.legalName}</b>
        <span className="fw-bank-muted fw-bank-code">{match.party.code}</span>
        <Pill tone={CONFIDENCE_TONE[match.confidence]}>{t(`confidence.${match.confidence}`)}</Pill>
      </span>
      <span className="fw-bank-chips" aria-label={t('panel.reasons')}>
        {match.reasons.map((reason) => (
          <Tag key={reason.code} tone="neutral">
            {t(`reason.${reason.code}`)}
          </Tag>
        ))}
      </span>
      <ItemsList match={match} model={model} currency={line.currency} />
      {match.acceptedAt && <p className="fw-bank-muted">{t(match.chosenByPerson ? 'panel.chosenAt' : 'panel.acceptedAt', { date: formatDateTime(match.acceptedAt, { locale }) })}</p>}
      <span className="fw-bank-actions">
        {match.paymentId && (
          <Link className="fw-bank-link" href={paymentHref(model.prefix, match.paymentId)}>
            {t('panel.openPayment')}
          </Link>
        )}
        <Button size="sm" variant="danger-outline" heldReason={reverseHeld} onClick={onReverse}>
          <Undo2 size={14} aria-hidden /> {t('panel.reverse')}
        </Button>
      </span>
    </div>
  )
}
