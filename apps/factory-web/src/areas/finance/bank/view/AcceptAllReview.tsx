'use client'

import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ReviewChangesModal } from '../../../../lib/i18n/ds-parts'
import { dayInstant, money } from '../../_shared/model'
import type { BankLine, BankMatch } from '../api'
import { recordsPayment, type Phrase } from '../model'

/** "Accept all High" (design sec:match, ReviewChangesModal): the container keeps it. */
export interface ReviewModel {
  readonly entries: ReadonlyArray<{ readonly line: BankLine; readonly match: BankMatch }>
  /** More sure matches wait than one acceptance takes (50): said in the summary. */
  readonly more: boolean
  readonly phase: 'ready' | 'saving' | 'done'
  /** After Save: accepted all (the API accepts all or none), or the refusal in words. */
  readonly problems: readonly Phrase[] | null
}

/**
 * Accept all High (design sec:match "Accept all High (ReviewChangesModal)"): one row per line — the line (day, payer,
 * amount with the price grain) → the customer and the invoices it pays, the reasons in words — and ONE Save that counts
 * them ("Accept 4 matches"); the API accepts all of them or none (each records its payment and places it). Done says how
 * many; a refusal says why and nothing was accepted.
 */
export function AcceptAllReview({ model, price, actions }: { model: ReviewModel; price: boolean; actions?: { onSave: () => void; onClose: () => void } }) {
  const t = useT('finance-bank')
  const locale = useLocale()
  const changes = model.entries.map(({ line, match }) => ({
    id: match.id,
    where: `${formatDate(dayInstant(line.bookedOn), { locale })} · ${line.counterpartyName ?? line.referenceText ?? '—'}${price && line.amount !== undefined ? ` · ${money(line.amount, line.currency, locale)}` : ''}`,
    what: t('review.what'),
    now: t('review.now'),
    next: `${match.party.legalName} · ${match.items.map((item) => item.number ?? '—').join(', ') || (match.supplierInvoice?.number ?? match.payment?.externalRef ?? '—')}`,
    note: `${t(`confidence.${match.confidence}`)}: ${match.reasons.map((reason) => t(`reason.${reason.code}`)).join(' · ')}${recordsPayment(line, match) ? ` · ${t('review.records')}` : ''}`,
  }))
  const results =
    model.phase === 'done'
      ? Object.fromEntries(model.entries.map(({ match }) => [match.id, { ok: model.problems === null, words: model.problems === null ? t('review.accepted') : model.problems.map((entry) => t(entry.key, entry.params)).join(' ') }]))
      : {}
  return (
    <ReviewChangesModal
      open
      onClose={() => actions?.onClose()}
      changes={changes}
      state={model.phase === 'done' ? { phase: 'done', results } : model.phase === 'saving' ? { phase: 'saving' } : { phase: 'ready' }}
      title={t('review.title', { count: changes.length })}
      summary={t(model.more ? 'review.summaryMore' : 'review.summary', { count: changes.length })}
      saveLabel={t('review.save', { count: changes.length })}
      doneVerb={t('review.doneVerb')}
      onSave={() => actions?.onSave()}
      size="xl"
    />
  )
}
