'use client'

import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, RadioCard } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import type { ClaimPage } from '../../../api'
import { fieldId, itemOf, photosOf, type ClaimActions, type ClaimViewModel } from '../../../model'
import { itemFacts, itemTitle } from '../../../view/items'
import { useShown } from '../../../view/shown'
import { GroupError, SerialField, Summary } from '../../../view/Steps'
import { REMAKE_FIT_MAX, remakeItems } from '../model'

/**
 * SCR-197 › Remake (B-W2b-346; design links.claim "Remake: what is wrong with the fit + front and back photos"): the
 * remake's own step bodies inside the claim page's frame — Which item (ONE item of what may come back, its serial scanned
 * or typed), Tell us more (what is wrong with the fit, your reference) and its part of Check and send. The photos step is
 * the page's own (two needed: the front and the back, labelled so). Words: `returns-remake` (claim.*), the page's own
 * `link-claim` for what both share.
 */

interface StepProps {
  page: ClaimPage
  model: ClaimViewModel
  actions?: ClaimActions
}

/** Which item: one RadioCard per item that may come back (one piece), then its serial. */
export function RemakeItemStep({ page, model, actions }: StepProps) {
  const t = useT('link-claim')
  const tr = useT('returns-remake')
  const locale = useLocale()
  const { error } = useShown(model, page)
  const id = fieldId('items')
  const problem = error('items')
  const items = remakeItems(page)
  const pick = model.form.picks[0]
  if (items.length === 0) {
    return (
      <Banner
        tone="info"
        title={tr('claim.item.none')}
        action={
          page.types.includes('COMPLAINT') ? (
            <Button size="sm" onClick={() => actions?.onType?.('COMPLAINT')}>
              {tr('claim.item.toComplaint')}
            </Button>
          ) : undefined
        }
      >
        {tr('claim.item.noneBody', { sender: page.sender.companyName })}
      </Banner>
    )
  }
  return (
    <>
      <fieldset className="fw-cl-fieldset" id={id} aria-describedby={problem ? `${id}-error` : undefined}>
        <legend className="fw-cl-vh">{tr('claim.item.legend')}</legend>
        <div className="fw-cl-items">
          {items.map((item) => (
            <RadioCard
              key={item.key}
              name="fw-cl-remake-item"
              value={item.key}
              checked={pick?.key === item.key}
              selected={pick?.key === item.key}
              onChange={() => actions?.onTogglePick?.(item.key)}
              title={itemTitle(item, t)}
              description={itemFacts(item, t, { locale, timeZone: model.timeZone })}
            />
          ))}
        </div>
        <GroupError id={id} text={problem} />
      </fieldset>
      <p className="fw-cl-hint">{tr('claim.item.hint')}</p>
      {pick && (
        <SerialField
          id={fieldId(`pick.${pick.key}.serial`)}
          value={pick.serial}
          error={error(`pick.${pick.key}.serial`)}
          onChange={(serial) => actions?.onPick?.(pick.key, { serial })}
          onScan={() => actions?.onScan?.(pick.key)}
        />
      )}
    </>
  )
}

/** Tell us more: what is wrong with the fit (needed), your reference. */
export function RemakeDetailsStep({ page, model, actions }: StepProps) {
  const t = useT('link-claim')
  const tr = useT('returns-remake')
  const locale = useLocale()
  const { error } = useShown(model, page)
  const form = model.form
  const item = itemOf(page, form.picks[0]?.key ?? null)
  return (
    <>
      {item && (
        <section className="fw-cl-group" aria-labelledby="fw-cl-remake-item-title">
          <h3 id="fw-cl-remake-item-title" className="fw-cl-h3">
            {itemTitle(item, t)}
          </h3>
          <p className="fw-cl-sub">{itemFacts(item, t, { locale, timeZone: model.timeZone })}</p>
        </section>
      )}
      <Field label={tr('claim.details.fit')} required hint={tr('claim.details.fitHint')} error={error('fit')} htmlFor={fieldId('fit')}>
        <Textarea id={fieldId('fit')} rows={6} limit={REMAKE_FIT_MAX} value={form.fit} onChange={(event) => actions?.onField?.('fit', event.target.value)} />
      </Field>
      <Field label={t('details.yourRef')} hint={t('details.yourRefHint')} error={error('customerRef')} htmlFor={fieldId('customerRef')}>
        <Input id={fieldId('customerRef')} value={form.customerRef} autoComplete="off" onChange={(event) => actions?.onField?.('customerRef', event.target.value)} />
      </Field>
    </>
  )
}

/** Check and send: the remake's item and what it says. */
export function RemakeReview({ page, model, actions }: StepProps) {
  const t = useScopedT('link-claim')
  const form = model.form
  const none = t('review.none')
  const pick = form.picks[0]
  const item = itemOf(page, pick?.key ?? null)
  return (
    <>
      <Summary title={t('review.item')} step="item" actions={actions}>
        <KeyValue
          labelCase="sentence"
          items={[
            { label: t('review.item'), value: itemTitle(item, t) },
            { label: t('item.serial'), value: pick?.serial.trim() || none },
          ]}
        />
      </Summary>
      <Summary title={t('review.details')} step="details" actions={actions}>
        <KeyValue
          labelCase="sentence"
          items={[
            { label: t('returns-remake:claim.details.fit'), value: <span className="fw-cl-pre">{form.fit.trim() || none}</span> },
            { label: t('details.yourRef'), value: form.customerRef.trim() || none },
          ]}
        />
      </Summary>
      <Summary title={t('review.photos')} step="photos" actions={actions}>
        <KeyValue labelCase="sentence" items={[{ label: itemTitle(item, t), value: t('review.photoCount', { count: pick ? photosOf(model.photos, pick.key).length : 0 }) }]} />
      </Summary>
    </>
  )
}

/** The photos step's lead for a remake (front and back), above the page's own photo groups. */
export function RemakePhotosIntro() {
  const tr = useT('returns-remake')
  return <p className="fw-cl-hint">{tr('claim.photos.intro')}</p>
}
