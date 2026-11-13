'use client'

import Link from 'next/link'
import { CalendarCheck, Send } from 'lucide-react'
import { Banner, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, RadioCard, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale } from '../../../../../../lib/i18n/provider'
import type { QuoteTerms } from '../../lines-depth/api'
import { deliveriesInOrder, sizesText, type Words } from '../../lines-depth/model'
import { useDepthWords } from '../../lines-depth/words'
import { deliveryPatch, deliveryProblems, INCOTERMS, payModeHeld, validityWords, type DeliveryDraft } from '../model'

export interface TermsDepthModel {
  terms: { status: 'loading' } | { status: 'ready'; value: QuoteTerms } | { status: 'error' }
  /** Why the terms cannot change (W1's read-only words), or null on a draft the person edits. */
  readOnly: Words | null
  /** The delivery terms as typed (the saved ones until changed). */
  draft: DeliveryDraft
  saving: 'acceptance' | 'delivery' | null
  problem: Words | null
  /** `/w/<company>/planning/promise?calc=1&quote=<id>`, or null without planning.promise.view. */
  capacityHref: string | null
  /** `…/sales/quotes/<id>?tab=lines&line=` */
  lineBase: string
}

export interface TermsDepthActions {
  onAcceptance?: (mode: 'SIGN' | 'SIGN_AND_PAY') => void
  onDraft?: (draft: DeliveryDraft) => void
  onSaveDelivery?: () => void
  onRetry?: () => void
}

function Reading({ model, onRetry }: { model: TermsDepthModel; onRetry?: () => void }) {
  const { t } = useDepthWords()
  if (model.terms.status === 'loading')
    return (
      <p className="fw-q-hint" role="status">
        <Spinner size={14} /> {t('common.loading')}
      </p>
    )
  return (
    <Banner
      tone="warning"
      title={t('terms.failed')}
      action={
        onRetry ? (
          <Button size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : undefined
      }
    />
  )
}

/**
 * Terms & delivery › Validity and offer, W2b part (design quote.terms.validity; SAL-151, SAL-145): the offer's state (open,
 * ends soon, last day, expired) with the reminder the customer gets three days before, and the acceptance mode — sign, or
 * sign and pay the deposit (held without a deposit). Saved on choosing it (PUT …/terms), Draft only.
 */
export function ValidityPart({ model, actions }: { model: TermsDepthModel; actions?: TermsDepthActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  if (model.terms.status !== 'ready') return <Reading model={model} onRetry={actions?.onRetry} />
  const terms = model.terms.value
  const { validity } = terms
  const mode = terms.acceptanceMode === 'PAY' ? 'SIGN_AND_PAY' : terms.acceptanceMode
  const payHeld = payModeHeld(terms.depositPct)
  return (
    <div className="fw-qd-terms-part">
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: t('terms.validity.label'), value: <Pill tone={validity.state === 'EXPIRED' || validity.state === 'ENDED' ? 'danger' : validity.state === 'LAST_DAY' || validity.state === 'ENDS_SOON' ? 'warning' : 'neutral'}>{say(validityWords(validity))}</Pill> },
          {
            label: t('terms.validity.reminder'),
            value: validity.reminderSentAt ? t('terms.validity.reminderSent', { at: formatDateTime(validity.reminderSentAt, { locale }) }) : validity.reminderOn ? t('terms.validity.reminderOn', { date: formatDate(`${validity.reminderOn}T12:00:00Z`, { locale }) }) : t('terms.validity.noReminder'),
          },
          ...(validity.expiredAt ? [{ label: t('terms.validity.expiredAt'), value: formatDateTime(validity.expiredAt, { locale }) }] : []),
        ]}
      />
      <fieldset className="fw-q-radios">
        <legend className="fw-q-legend">{t('terms.acceptance.label')}</legend>
        {model.readOnly ? (
          <p>{t(`terms.acceptance.${mode}`)}</p>
        ) : (
          (['SIGN', 'SIGN_AND_PAY'] as const).map((value) => {
            const held = value === 'SIGN_AND_PAY' && payHeld && mode !== 'SIGN_AND_PAY' ? say(payHeld) : null
            return (
              <RadioCard
                key={value}
                name="fw-qd-acceptance"
                value={value}
                checked={mode === value}
                selected={mode === value}
                disabled={!!held || model.saving !== null}
                onChange={() => mode !== value && actions?.onAcceptance?.(value)}
                title={t(`terms.acceptance.${value}`)}
                description={held ?? t(`terms.acceptance.${value}Body`)}
              />
            )
          })
        )}
      </fieldset>
      {model.saving === 'acceptance' && (
        <p className="fw-q-hint" role="status">
          <Spinner size={12} /> {t('terms.saving')}
        </p>
      )}
    </div>
  )
}

/**
 * Terms & delivery › Delivery, W2b part (design quote.terms.delivery; SAL-145, SAL-162): "Check capacity" (Planning › Promise
 * dates, the calculator for this quote), the Incoterm and its place, ship complete or as ready (saved together, explicitly),
 * and each line's delivery schedule with "the rest at the promise date" — edited in the line drawer.
 */
export function DeliveryPart({ model, actions }: { model: TermsDepthModel; actions?: TermsDepthActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const day = (value: string) => formatDate(`${value}T12:00:00Z`, { locale })
  const capacity = model.capacityHref ? (
    <Button size="sm" asChild>
      <Link href={model.capacityHref}>
        <CalendarCheck size={14} aria-hidden /> {t('terms.capacity')}
      </Link>
    </Button>
  ) : (
    <Button size="sm" heldReason={t('terms.capacityHeld')} onClick={() => undefined}>
      <CalendarCheck size={14} aria-hidden /> {t('terms.capacity')}
    </Button>
  )
  if (model.terms.status !== 'ready')
    return (
      <div className="fw-qd-terms-part">
        <div className="fw-qd-actions">{capacity}</div>
        <Reading model={model} onRetry={actions?.onRetry} />
      </div>
    )
  const terms = model.terms.value
  const before: DeliveryDraft = { incoterm: terms.incoterm ?? '', place: terms.incotermPlace ?? '', shipComplete: terms.shipComplete }
  const draft = model.draft
  const patch = deliveryPatch(before, draft)
  const changed = Object.keys(patch).length > 0
  const problems = deliveryProblems(draft)
  const set = (next: Partial<DeliveryDraft>) => actions?.onDraft?.({ ...draft, ...next })
  const saveHeld = model.readOnly ? say(model.readOnly) : !changed ? t('terms.held.noChange') : problems.length > 0 ? say(problems[0]!) : model.saving ? t('terms.saving') : null
  const scheduled = terms.lines.filter((line) => line.deliveries.length > 0)
  return (
    <div className="fw-qd-terms-part">
      <div className="fw-qd-actions">
        {capacity}
        <span className="fw-q-hint">{t('terms.capacityHint')}</span>
      </div>
      {model.readOnly ? (
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            { label: t('terms.incoterm'), value: terms.incoterm ? `${t(`incoterm.${terms.incoterm}`)}${terms.incotermPlace ? ` · ${terms.incotermPlace}` : ''}` : t('terms.noIncoterm') },
            { label: t('terms.ship'), value: t(terms.shipComplete ? 'terms.shipComplete' : 'terms.shipAsReady') },
          ]}
        />
      ) : (
        <div className="fw-q-fields">
          <Field label={t('terms.incoterm')} hint={terms.customerIncoterm && terms.customerIncoterm !== draft.incoterm ? t('terms.customerIncoterm', { code: terms.customerIncoterm }) : t('terms.incotermHint')}>
            <Select value={draft.incoterm} onChange={(event) => set({ incoterm: event.target.value, ...(event.target.value === '' ? { place: '' } : {}) })}>
              <option value="">{t('terms.noIncoterm')}</option>
              {INCOTERMS.map((code) => (
                <option key={code} value={code}>
                  {t(`incoterm.${code}`)}
                  {terms.incoterms.find((entry) => entry.code === code)?.seaOnly ? ` · ${t('terms.seaOnly')}` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('terms.place')} hint={t('terms.placeHint')}>
            <Input value={draft.place} maxLength={120} disabled={draft.incoterm === ''} onChange={(event) => set({ place: event.target.value })} />
          </Field>
          <Field label={t('terms.ship')} hint={t(draft.shipComplete ? 'terms.shipCompleteBody' : 'terms.shipAsReadyBody')}>
            <SegmentedControl
              size="sm"
              ariaLabel={t('terms.ship')}
              value={draft.shipComplete ? 'complete' : 'ready'}
              onChange={(value) => set({ shipComplete: value === 'complete' })}
              options={[
                { value: 'complete', label: t('terms.shipComplete') },
                { value: 'ready', label: t('terms.shipAsReady') },
              ]}
            />
          </Field>
          {terms.customerIncoterm && terms.customerIncoterm !== draft.incoterm && (
            <div>
              <Button size="sm" variant="quiet" onClick={() => set({ incoterm: terms.customerIncoterm ?? '' })}>
                {t('terms.useCustomer', { code: terms.customerIncoterm })}
              </Button>
            </div>
          )}
        </div>
      )}
      {model.problem && <Banner tone="danger" title={say(model.problem)} />}
      {!model.readOnly && (
        <div className="fw-qd-actions">
          <span className="fw-qd-grow" />
          {changed && (
            <Button size="sm" variant="quiet" onClick={() => actions?.onDraft?.(before)}>
              {t('terms.discard')}
            </Button>
          )}
          <Button size="sm" variant="primary" heldReason={saveHeld} onClick={() => actions?.onSaveDelivery?.()}>
            <Send size={14} aria-hidden /> {t('terms.saveDelivery')}
          </Button>
        </div>
      )}
      <h3 className="fw-q-h3">{t('terms.schedule')}</h3>
      {terms.lines.length === 0 ? (
        <p className="fw-q-hint">{t('terms.scheduleNoLines')}</p>
      ) : (
        <>
          <p className="fw-q-hint">{scheduled.length === 0 ? (terms.promiseDate ? t('terms.scheduleAllPromise', { date: day(terms.promiseDate) }) : t('terms.scheduleAllNoDate')) : t('terms.scheduleSome', { count: scheduled.length })}</p>
          <SummaryTable
            label={t('terms.schedule')}
            density="compact"
            stackOnPhone
            columns={[t('terms.col.line'), t('terms.col.deliveries'), t('terms.col.rest'), t('terms.col.edit')]}
            rows={terms.lines.map((line) => ({
              id: line.lineId,
              cells: [
                <span key="l">
                  <strong>{line.seq}</strong> · {line.label}
                </span>,
                line.deliveries.length === 0 ? <span key="d" className="fw-q-hint">{t('table.atPromise')}</span> : deliveriesInOrder(line).map((delivery) => `${day(delivery.deliveryDate)} · ${line.kind === 'SIZE_GRID' ? sizesText(delivery.sizes ?? {}) : delivery.quantity}`).join(' — '),
                line.deliveries.length === 0 ? '—' : Object.keys(line.atPromiseDate).length === 0 ? t('terms.restNone') : sizesText(line.atPromiseDate),
                <Link key="e" className="fw-q-hint" href={`${model.lineBase}${encodeURIComponent(line.lineId)}`}>
                  {t('terms.openLine')}
                </Link>,
              ],
            }))}
          />
        </>
      )}
    </div>
  )
}
