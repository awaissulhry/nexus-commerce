'use client'

import { useState } from 'react'
import { Banner, Card, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant } from '../../../_shared/model'
import { PAY_DEPTH, PAY_DEPTH_NAMESPACES, type PayProblem, type Phrase } from '../../../payments/riba/depth'
import { MAX_STOP_TEXT, MAX_TRUSTED_LEVEL, STOP_REASONS, type CustomerTrust, type ReminderStop, type StopReason } from '../api'
import { STOP_TONE, stopDraftHeld, stopMoveHeld, trustedSteps, trustHeld, type StopDraft, type StopsCan } from '../model'
import '../../../_shared/finance.css'

export interface ReminderDepthModel {
  today: string
  can: StopsCan
  reminder: { status: string; invoices: ReadonlyArray<{ id: string; number: string | null }>; trusted: { level: number | null; goesByItself: boolean; approvedByLevel: boolean } | null }
  /** The stops on this reminder's invoices (in force); null while read. */
  stops: ReminderStop[] | null
  stopsProblem: string | null
  trust: CustomerTrust | null
  trustProblem: string | null
  busy: boolean
  problem: PayProblem | null
  notice: Phrase | null
  /** Design cases: what is typed. */
  draft?: { stop?: Partial<StopDraft>; level?: string }
}

export interface ReminderDepthActions {
  onRetry?: () => void
  onAddStop?: (draft: StopDraft) => void
  onLift?: (stop: ReminderStop) => void
  onSetLevel?: (level: number | null) => void
  onDismissNotice?: () => void
}

/**
 * Inside a reminder (design finance.receivables sec:reminders "Held (W2b stop rules)" and "Trusted levels can be automatic per
 * customer"; SCR-514): the stops that hold its invoices — payment being processed, dispute open, promise to pay (until its
 * day), credit note pending — each lifted here; "Stop reminders of an invoice" records one (the reminder is then held: it is
 * not approved or sent while the stop is in force); and the customer's trusted level: e-mail reminders up to it go without a
 * person while the company's reminders are switched on (a letter or a call always waits), set by the Owner with a fresh
 * code. Whether this reminder goes by itself, or was approved by its level, is said.
 */
export function ReminderDepthView({ model, actions }: { model: ReminderDepthModel; actions?: ReminderDepthActions }) {
  return (
    <WithMessages namespaces={PAY_DEPTH_NAMESPACES}>
      <Depth model={model} actions={actions} />
    </WithMessages>
  )
}

function Depth({ model, actions }: { model: ReminderDepthModel; actions?: ReminderDepthActions }) {
  const p = useT(PAY_DEPTH)
  const t = useT('finance')
  const s = useScopedT('finance')
  const locale = useLocale()
  const say = (phrase: Phrase | null) => (phrase ? s(phrase.key, phrase.params) : null)
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const first = model.reminder.invoices[0]?.id ?? ''
  const [draft, setDraft] = useState<StopDraft>({ invoiceId: model.draft?.stop?.invoiceId ?? first, reason: model.draft?.stop?.reason ?? 'PAYMENT_PROCESSING', until: model.draft?.stop?.until ?? '', note: model.draft?.stop?.note ?? '' })
  const [level, setLevel] = useState<string>(model.draft?.level ?? (model.trust?.level != null ? String(model.trust.level) : ''))
  const trusted = model.reminder.trusted
  const open = model.reminder.status === 'PREPARED'
  const stopHeld = say(stopDraftHeld(draft, model.today, model.can, model.busy))
  const levelValue = level === '' ? null : Number(level)
  const levelHeld = say(trustHeld(model.trust, model.can, model.busy)) ?? (model.trust && levelValue === model.trust.level ? p('trust.held.same') : null)
  return (
    <div className="fw-fin-cards fw-fin-cards--two">
      <Card padded className="fw-fin-card">
        <h3 className="fw-fin-h3">{p('stops.inReminder.title')}</h3>
        {model.problem && <Banner tone="danger" title={say(model.problem) ?? ''} />}
        {model.notice && (
          <Banner
            tone="success"
            title={say(model.notice) ?? ''}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {t('common.dismiss')}
              </Button>
            }
          />
        )}
        {model.stopsProblem ? (
          <p className="fw-fin-hint">{p('stops.failed', { reason: t(model.stopsProblem) })}</p>
        ) : !model.stops ? (
          <p className="fw-fin-hint" role="status">
            <Spinner size={12} /> {p('stops.reading')}
          </p>
        ) : model.stops.length === 0 ? (
          <p className="fw-fin-hint">{p('stops.inReminder.none')}</p>
        ) : (
          <SummaryTable
            label={p('stops.inReminder.title')}
            columns={[p('stops.col.invoice'), p('stops.col.reason'), p('stops.col.until'), p('stops.col.action')]}
            align={['left', 'left', 'left', 'right']}
            stackOnPhone
            rows={model.stops.map((stop) => ({
              id: stop.id,
              cells: [
                stop.invoice.number ?? '—',
                <span key="r" className="fw-fin-cell">
                  <Pill tone={STOP_TONE[stop.state]}>{p(`stops.reason.${stop.reason}`)}</Pill>
                  {stop.note && <span className="fw-fin-cell-sub">{stop.note}</span>}
                </span>,
                stop.until ? day(stop.until) : p('stops.untilLifted'),
                <Button key="l" size="sm" variant="link" heldReason={say(stopMoveHeld(stop, 'lift', model.can, model.busy))} onClick={() => actions?.onLift?.(stop)}>
                  {p('stops.lift')}
                </Button>,
              ],
            }))}
          />
        )}
        <fieldset className="fw-fin-choices">
          <legend className="fw-fin-legend">{p('stops.add.title')}</legend>
          <div className="fw-fin-two">
            <Field label={p('stops.col.invoice')}>
              <Select value={draft.invoiceId} onChange={(event) => setDraft({ ...draft, invoiceId: event.target.value })}>
                {model.reminder.invoices.map((invoice) => (
                  <option key={invoice.id} value={invoice.id}>
                    {invoice.number ?? '—'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={p('stops.col.reason')}>
              <Select value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value as StopReason })}>
                {STOP_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {p(`stops.reason.${reason}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={draft.reason === 'PROMISE_TO_PAY' ? p('stops.add.promiseDay') : p('stops.add.until')} hint={draft.reason === 'PROMISE_TO_PAY' ? p('stops.add.promiseHint') : p('stops.add.untilHint')}>
              <DateField value={draft.until} onChange={(value) => setDraft({ ...draft, until: value })} min={model.today} locale={INTL_LOCALE[locale]} ariaLabel={p('stops.add.until')} />
            </Field>
          </div>
          <Field label={p('stops.add.note')}>
            <Textarea value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} maxLength={MAX_STOP_TEXT.note} rows={2} />
          </Field>
          <span className="fw-fin-inline">
            <Button size="sm" heldReason={stopHeld} onClick={() => actions?.onAddStop?.(draft)}>
              {p('stops.add.go')}
            </Button>
          </span>
          <p className="fw-fin-hint">{p('stops.add.after')}</p>
        </fieldset>
      </Card>
      <Card padded className="fw-fin-card">
        <h3 className="fw-fin-h3">{p('trust.title')}</h3>
        {trusted && (
          <p className="fw-fin-hint">
            {trusted.approvedByLevel ? p('trust.approvedByLevel') : trusted.goesByItself ? p('trust.goesByItself', { level: trusted.level ?? 0 }) : open ? (trusted.level === null ? p('trust.waitsNoLevel') : p('trust.waitsForPerson', { level: trusted.level })) : p('trust.byPerson')}
          </p>
        )}
        {model.trustProblem ? (
          <p className="fw-fin-hint">{p('trust.failed', { reason: t(model.trustProblem) })}</p>
        ) : !model.trust ? (
          <p className="fw-fin-hint" role="status">
            <Spinner size={12} /> {p('trust.reading')}
          </p>
        ) : (
          <>
            <p className="fw-fin-hint">{model.trust.level === null ? p('trust.none', { customer: model.trust.customer.name }) : p('trust.level', { customer: model.trust.customer.name, level: model.trust.level })}</p>
            {trustedSteps(model.trust, model.trust.level).map((company) => (
              <p key={company.companyCode} className="fw-fin-hint">
                {company.steps.length === 0 ? p('trust.company.noSteps', { company: company.companyCode }) : company.on ? p('trust.company.on', { company: company.companyCode, steps: company.steps.join(', ') }) : p('trust.company.off', { company: company.companyCode, steps: company.steps.join(', ') })}
              </p>
            ))}
            <div className="fw-fin-two">
              <Field label={p('trust.pick')} hint={p('trust.pickHint')}>
                <Select value={level} onChange={(event) => setLevel(event.target.value)}>
                  <option value="">{p('trust.noLevel')}</option>
                  {Array.from({ length: MAX_TRUSTED_LEVEL }, (_, index) => index + 1).map((value) => (
                    <option key={value} value={String(value)}>
                      {p('trust.upTo', { level: value })}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <span className="fw-fin-inline">
              <Button size="sm" heldReason={levelHeld} onClick={() => actions?.onSetLevel?.(levelValue)}>
                {levelValue === null ? p('trust.clear') : p('trust.save')}
              </Button>
            </span>
            <p className="fw-fin-hint">{p('trust.always')}</p>
          </>
        )}
      </Card>
    </div>
  )
}
