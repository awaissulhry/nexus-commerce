'use client'

import Link from 'next/link'
import { Field, KeyValue } from '@nexus/ui/components'
import { Input } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { dayInstant } from '../../_shared/model'
import { DialogFrame } from '../../_shared/parts'
import type { BankLine } from '../api'
import { paymentHref, type Phrase } from '../model'

/** "Take back the acceptance" (a wrong match): the container keeps it. */
export interface ReverseModel {
  readonly line: BankLine
  readonly reason: string
  readonly busy: boolean
  readonly problems: readonly Phrase[] | null
  readonly lockAsked: boolean
  readonly lockReason: string
}

export interface ReverseActions {
  onReason?: (text: string) => void
  onLockReason?: (text: string) => void
  onSubmit?: () => void
  onClose?: () => void
}

/**
 * Take back an acceptance (B-W2b-393 `POST …/matches/:id/reverse`): says what goes back — the write-offs and the placements
 * taken back, the payment it recorded VOIDED, the line to match again with its suggestions — and asks why (audited). A
 * danger primary; a soft-locked month asks its reason too.
 */
export function ReverseDialog({ model, prefix, actions }: { model: ReverseModel; prefix: string; actions?: ReverseActions }) {
  const t = useT('finance-bank')
  const locale = useLocale()
  const match = model.line.accepted
  const held = model.busy ? t('held.busy') : model.reason.trim() === '' ? t('reverse.held') : model.lockAsked && model.lockReason.trim() === '' ? t('held.lockReason') : null
  return (
    <DialogFrame
      title={t('reverse.title')}
      held={held}
      go={() => actions?.onSubmit?.()}
      goLabel={model.busy ? t('common.working') : t('reverse.go')}
      onClose={() => actions?.onClose?.()}
      tone="danger"
      problem={model.problems && model.problems.length > 0 ? { key: `finance-bank:${model.problems[0]!.key}`, params: model.problems[0]!.params } : null}
    >
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: t('panel.booked'), value: formatDate(dayInstant(model.line.bookedOn), { locale }) },
          { label: t('choose.customer'), value: match ? `${match.party.legalName} (${match.party.code})` : '—' },
          {
            label: t('reverse.payment'),
            value: match?.paymentId ? (
              <Link className="fw-bank-link" href={paymentHref(prefix, match.paymentId)}>
                {match.payment?.externalRef ?? t('lines.payment')}
              </Link>
            ) : (
              '—'
            ),
          },
        ]}
      />
      <p className="fw-bank-muted">{t(match && match.items.length > 0 ? 'reverse.bodyRecorded' : 'reverse.body')}</p>
      <Field label={t('reverse.reason')} required>
        <Input value={model.reason} maxLength={500} onChange={(event) => actions?.onReason?.(event.target.value)} autoComplete="off" />
      </Field>
      {model.lockAsked && (
        <Field label={t('period.reason')} hint={t('period.softAsk')}>
          <Input value={model.lockReason} maxLength={500} onChange={(event) => actions?.onLockReason?.(event.target.value)} autoComplete="off" />
        </Field>
      )}
    </DialogFrame>
  )
}
