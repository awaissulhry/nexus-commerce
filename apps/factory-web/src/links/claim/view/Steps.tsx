'use client'

import type { ReactNode } from 'react'
import { Camera, PackageOpen, ScanLine, ShieldAlert } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, CheckboxCard, Input, NumberStepper, RadioCard, Select } from '@nexus/ui/primitives'
import { Textarea } from '../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../lib/i18n/provider'
import type { ClaimPage, ClaimType } from '../api'
import {
  addPhotoHeld,
  CASE_GROUP,
  complaintItems,
  fieldId,
  itemOf,
  LIMITS,
  photoGroups,
  photosNeeded,
  photosOf,
  returnableCount,
  sendHeldKey,
  WHOLE_DELIVERY,
  type ClaimActions,
  type ClaimViewModel,
  type Step,
} from '../model'
import { itemFacts, itemTitle } from './items'
import { useShown } from './shown'

interface StepProps {
  page: ClaimPage
  model: ClaimViewModel
  actions?: ClaimActions
}

const TYPE_ICON: Record<ClaimType, ReactNode> = {
  RETURN: <PackageOpen size={22} aria-hidden />,
  COMPLAINT: <ShieldAlert size={22} aria-hidden />,
}

/** A problem under a group of choices (a fieldset): said, and read with the group. */
function GroupError({ id, text }: { id: string; text: string | undefined }) {
  if (!text) return null
  return (
    <p id={`${id}-error`} className="fw-cl-error" role="alert">
      {text}
    </p>
  )
}

/** Design sec:type — What do you need? Big choice cards, each with only its own questions. */
export function TypeStep({ page, model, actions }: StepProps) {
  const t = useT('link-claim')
  const { error } = useShown(model, page)
  const id = fieldId('type')
  const problem = error('type')
  const nothingBack = returnableCount(page) === 0
  return (
    <>
      <fieldset className="fw-cl-fieldset" id={id} aria-describedby={problem ? `${id}-error` : undefined}>
        <legend className="fw-cl-vh">{t('step.type.title')}</legend>
        <div className="fw-cl-choices">
          {page.types.map((type) => (
            <RadioCard
              key={type}
              name="fw-cl-type"
              value={type}
              checked={model.form.type === type}
              selected={model.form.type === type}
              onChange={() => actions?.onType?.(type)}
              title={
                <span className="fw-cl-choice">
                  <span className="fw-cl-choice-icon">{TYPE_ICON[type]}</span>
                  <span>{t(`type.${type}.title`)}</span>
                </span>
              }
              description={type === 'RETURN' && nothingBack ? t('type.RETURN.none') : t(`type.${type}.body`)}
            />
          ))}
        </div>
        <GroupError id={id} text={problem} />
      </fieldset>
      <p className="fw-cl-hint">{t('type.later', { sender: page.sender.companyName })}</p>
    </>
  )
}

/** The serial: scanned from the label with the camera, or typed (design sec:item "Scan fills the serial"). */
function SerialField({ id, value, error, onChange, onScan }: { id: string; value: string; error?: string; onChange: (value: string) => void; onScan: () => void }) {
  const t = useT('link-claim')
  return (
    <Field label={t('item.serial')} hint={t('item.serialHint')} error={error} htmlFor={id}>
      <div className="fw-cl-serial">
        <Input id={id} value={value} autoComplete="off" spellCheck={false} onChange={(event) => onChange(event.target.value)} />
        <Button onClick={onScan}>
          <ScanLine size={16} aria-hidden /> {t('item.scan')}
        </Button>
      </div>
    </Field>
  )
}

/** Design sec:item — Which item, from the order's items: what comes back (pieces, serial), or the one item of a complaint. */
export function ItemStep({ page, model, actions }: StepProps) {
  return model.form.type === 'COMPLAINT' ? <ComplaintItem page={page} model={model} actions={actions} /> : <ReturnItems page={page} model={model} actions={actions} />
}

function ReturnItems({ page, model, actions }: StepProps) {
  const t = useT('link-claim')
  const locale = useLocale()
  const { error } = useShown(model, page)
  const id = fieldId('items')
  const problem = error('items')
  if (returnableCount(page) === 0) {
    return (
      <Banner
        tone="info"
        title={t('item.nothingBack', { record: t(`record.of.${page.record.type === 'Shipment' ? 'Shipment' : 'SalesOrder'}`) })}
        action={
          page.types.includes('COMPLAINT') ? (
            <Button size="sm" onClick={() => actions?.onType?.('COMPLAINT')}>
              {t('item.toComplaint')}
            </Button>
          ) : undefined
        }
      >
        {t('item.nothingBackBody', { sender: page.sender.companyName })}
      </Banner>
    )
  }
  return (
    <fieldset className="fw-cl-fieldset" id={id} aria-describedby={problem ? `${id}-error` : undefined}>
      <legend className="fw-cl-vh">{t('item.legend.RETURN')}</legend>
      <ul className="fw-cl-items">
        {page.items.map((item) => {
          const pick = model.form.picks.find((entry) => entry.key === item.key)
          const none = item.canReturn < 1
          const at = (field: string) => fieldId(`pick.${item.key}.${field}`)
          return (
            <li key={item.key} className="fw-cl-item">
              <CheckboxCard
                checked={!!pick}
                selected={!!pick}
                aria-disabled={none || undefined}
                className={none ? 'fw-cl-held' : undefined}
                onChange={() => !none && actions?.onTogglePick?.(item.key)}
                title={itemTitle(item, t)}
                description={
                  <span className="fw-cl-lines">
                    <span>{itemFacts(item, t, { locale, timeZone: model.timeZone })}</span>
                    <span>{none ? t('item.noneLeft') : t('item.canReturn', { count: item.canReturn, received: item.received })}</span>
                    {item.windowWarning && !none && <span className="fw-cl-warn">{t('item.late')}</span>}
                  </span>
                }
              />
              {pick && (
                <div className="fw-cl-pick">
                  <Field label={t('item.pieces')} hint={t('item.piecesHint', { max: item.canReturn })} error={error(`pick.${item.key}.quantity`)} htmlFor={at('quantity')}>
                    <NumberStepper
                      id={at('quantity')}
                      value={pick.quantity}
                      min={1}
                      max={item.canReturn}
                      decrementLabel={t('item.less')}
                      incrementLabel={t('item.more')}
                      onChange={(quantity) => actions?.onPick?.(item.key, { quantity })}
                    />
                  </Field>
                  <SerialField id={at('serial')} value={pick.serial} error={error(`pick.${item.key}.serial`)} onChange={(serial) => actions?.onPick?.(item.key, { serial })} onScan={() => actions?.onScan?.(item.key)} />
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <GroupError id={id} text={problem} />
    </fieldset>
  )
}

function ComplaintItem({ page, model, actions }: StepProps) {
  const t = useT('link-claim')
  const locale = useLocale()
  const { error } = useShown(model, page)
  const id = fieldId('complaintItem')
  const problem = error('complaintItem')
  const form = model.form
  return (
    <>
      <fieldset className="fw-cl-fieldset" id={id} aria-describedby={problem ? `${id}-error` : undefined}>
        <legend className="fw-cl-vh">{t('item.legend.COMPLAINT')}</legend>
        <div className="fw-cl-items">
          {complaintItems(page).map((item) => (
            <RadioCard
              key={item.key}
              name="fw-cl-item"
              value={item.key}
              checked={form.itemKey === item.key}
              selected={form.itemKey === item.key}
              onChange={() => actions?.onComplaintItem?.(item.key)}
              title={itemTitle(item, t)}
              description={itemFacts(item, t, { locale, timeZone: model.timeZone })}
            />
          ))}
          <RadioCard
            name="fw-cl-item"
            value={WHOLE_DELIVERY}
            checked={form.itemKey === WHOLE_DELIVERY}
            selected={form.itemKey === WHOLE_DELIVERY}
            onChange={() => actions?.onComplaintItem?.(WHOLE_DELIVERY)}
            title={t('item.whole')}
            description={t('item.wholeBody')}
          />
        </div>
        <GroupError id={id} text={problem} />
      </fieldset>
      <div className="fw-cl-pair">
        <SerialField id={fieldId('serial')} value={form.serial} error={error('serial')} onChange={(value) => actions?.onField?.('serial', value)} onScan={() => actions?.onScan?.('serial')} />
        <Field label={t('item.batch')} hint={t('item.batchHint')} error={error('batchNumber')} htmlFor={fieldId('batchNumber')}>
          <Input id={fieldId('batchNumber')} value={form.batchNumber} autoComplete="off" spellCheck={false} onChange={(event) => actions?.onField?.('batchNumber', event.target.value)} />
        </Field>
      </div>
    </>
  )
}

/** Design sec:details — Tell us more: the questions of the type (a return's reason per item and what you would like; a complaint's words). */
export function DetailsStep({ page, model, actions }: StepProps) {
  const t = useT('link-claim')
  const locale = useLocale()
  const { error } = useShown(model, page)
  const form = model.form
  const reference = (
    <Field label={t('details.yourRef')} hint={t('details.yourRefHint')} error={error('customerRef')} htmlFor={fieldId('customerRef')}>
      <Input id={fieldId('customerRef')} value={form.customerRef} autoComplete="off" onChange={(event) => actions?.onField?.('customerRef', event.target.value)} />
    </Field>
  )
  if (form.type === 'COMPLAINT') {
    return (
      <>
        <Field label={t('details.description')} required hint={t('details.descriptionHint')} error={error('description')} htmlFor={fieldId('description')}>
          <Textarea id={fieldId('description')} rows={6} limit={LIMITS.description} value={form.description} onChange={(event) => actions?.onField?.('description', event.target.value)} />
        </Field>
        {reference}
      </>
    )
  }
  return (
    <>
      {form.picks.map((pick) => {
        const item = itemOf(page, pick.key)
        const reason = page.reasons.find((entry) => entry.code === pick.reasonCode)
        const at = (field: string) => fieldId(`pick.${pick.key}.${field}`)
        return (
          <section key={pick.key} className="fw-cl-group" aria-labelledby={`${at('group')}-title`}>
            <h3 id={`${at('group')}-title`} className="fw-cl-h3">
              {itemTitle(item, t)}
            </h3>
            <p className="fw-cl-sub">{[t('details.pieces', { count: pick.quantity }), item ? itemFacts(item, t, { locale, timeZone: model.timeZone }) : null].filter(Boolean).join(' · ')}</p>
            <Field label={t('details.reason')} required error={error(`pick.${pick.key}.reason`)} htmlFor={at('reason')}>
              <Select id={at('reason')} value={pick.reasonCode ?? ''} onChange={(event) => actions?.onPick?.(pick.key, { reasonCode: event.target.value || null })}>
                <option value="">{t('details.reasonChoose')}</option>
                {page.reasons.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.words[locale]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={t(reason?.needsNote ? 'details.reasonNoteNeeded' : 'details.reasonNote')}
              required={!!reason?.needsNote}
              hint={t('details.reasonNoteHint')}
              error={error(`pick.${pick.key}.reasonNote`)}
              htmlFor={at('reasonNote')}
            >
              <Textarea id={at('reasonNote')} rows={3} limit={LIMITS.reasonNote} value={pick.reasonNote} onChange={(event) => actions?.onPick?.(pick.key, { reasonNote: event.target.value })} />
            </Field>
          </section>
        )
      })}
      <fieldset className="fw-cl-fieldset">
        <legend className="fw-cl-legend">{t('details.outcome')}</legend>
        <p className="fw-cl-hint">{t('details.outcomeHint')}</p>
        <div className="fw-cl-rows">
          {[null, ...page.outcomes.map((outcome) => outcome.code)].map((code) => (
            <RadioCard
              key={code ?? 'NONE'}
              variant="row"
              name="fw-cl-outcome"
              value={code ?? 'NONE'}
              checked={form.outcomeWanted === code}
              selected={form.outcomeWanted === code}
              onChange={() => actions?.onOutcome?.(code)}
              title={t(code ? `outcome.${code}` : 'outcome.none')}
            />
          ))}
        </div>
      </fieldset>
      {reference}
      <Field label={t('details.note')} hint={t('details.noteHint')} error={error('note')} htmlFor={fieldId('note')}>
        <Textarea id={fieldId('note')} rows={3} limit={LIMITS.note} value={form.note} onChange={(event) => actions?.onField?.('note', event.target.value)} />
      </Field>
    </>
  )
}

/** Design sec:photos — damage and fit photos, marked to circle the problem; at least two of a damage. */
export function PhotosStep({ page, model, actions }: StepProps) {
  const t = useT('link-claim')
  const { error } = useShown(model, page)
  const form = model.form
  return (
    <>
      <p className="fw-cl-hint">{t('photos.intro')}</p>
      {photoGroups(form).map((group) => {
        const needed = photosNeeded(form, group)
        const shots = photosOf(model.photos, group)
        const held = addPhotoHeld(model.photos, group)
        const title = group === CASE_GROUP ? t('photos.case') : itemTitle(itemOf(page, group), t)
        const id = fieldId(`photos.${group}`)
        const problem = error(`photos.${group}`)
        return (
          <section key={group} id={id} className="fw-cl-group" aria-labelledby={`${id}-title`} aria-describedby={problem ? `${id}-error` : undefined}>
            <h3 id={`${id}-title`} className="fw-cl-h3">
              {title}
            </h3>
            <p className="fw-cl-sub">{needed > 0 ? t('photos.needed', { needed, count: shots.length }) : t('photos.optional', { count: shots.length })}</p>
            {shots.length > 0 && (
              <ul className="fw-cl-photos">
                {shots.map((shot, index) => (
                  <li key={shot.id} className="fw-cl-photo">
                    {/* A photo taken on this page (a blob address, or a made-up picture in the design cases). */}
                    <img src={shot.src} alt={t('photos.alt', { n: index + 1, title })} />
                    <span className="fw-cl-sub">{shot.marks > 0 ? t('photos.labelMarks', { n: index + 1, count: shot.marks }) : t('photos.label', { n: index + 1 })}</span>
                    <Button size="sm" variant="quiet" aria-label={t('photos.removeOne', { n: index + 1, title })} onClick={() => actions?.onRemovePhoto?.(shot.id)}>
                      {t('photos.remove')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <GroupError id={id} text={problem} />
            <div>
              <Button onClick={() => actions?.onAddPhoto?.(group)} heldReason={held ? t(held, { max: LIMITS.photos }) : null}>
                <Camera size={16} aria-hidden /> {t('photos.add')}
              </Button>
            </div>
          </section>
        )
      })}
      <p className="fw-cl-hint">{t('photos.after')}</p>
    </>
  )
}

/** One part of the check, with Change (back to its step). */
function Summary({ title, step, actions, children }: { title: string; step: Step; actions?: ClaimActions; children: ReactNode }) {
  const t = useT('link-claim')
  return (
    <section className="fw-cl-summary" aria-label={title}>
      <div className="fw-cl-summary-head">
        <h3 className="fw-cl-h3">{title}</h3>
        <Button size="sm" variant="quiet" aria-label={t('review.changeOf', { what: title })} onClick={() => actions?.onStep?.(step)}>
          {t('review.change')}
        </Button>
      </div>
      {children}
    </section>
  )
}

/** Design sec:review — Check and send, on one screen: what you need, the items, what you told us, the photos, your name. */
export function ReviewStep({ page, model, actions }: StepProps) {
  const t = useT('link-claim')
  const locale = useLocale()
  const { error } = useShown(model, page)
  const form = model.form
  const held = sendHeldKey(page)
  const none = t('review.none')
  return (
    <>
      <Summary title={t('review.what')} step="type" actions={actions}>
        <p className="fw-cl-value">{form.type ? t(`type.${form.type}.title`) : none}</p>
      </Summary>
      {form.type === 'RETURN' ? (
        <>
          <Summary title={t('review.items')} step="item" actions={actions}>
            <ul className="fw-cl-review-items">
              {form.picks.map((pick) => {
                const item = itemOf(page, pick.key)
                const reason = page.reasons.find((entry) => entry.code === pick.reasonCode)
                return (
                  <li key={pick.key}>
                    <strong>{itemTitle(item, t)}</strong>
                    <KeyValue
                      labelCase="sentence"
                      items={[
                        { label: t('review.pieces'), value: String(pick.quantity) },
                        { label: t('details.reason'), value: reason ? reason.words[locale] : none },
                        ...(pick.reasonNote.trim() ? [{ label: t('details.reasonNote'), value: <span className="fw-cl-pre">{pick.reasonNote.trim()}</span> }] : []),
                        ...(pick.serial.trim() ? [{ label: t('item.serial'), value: pick.serial.trim() }] : []),
                      ]}
                    />
                  </li>
                )
              })}
            </ul>
          </Summary>
          <Summary title={t('review.details')} step="details" actions={actions}>
            <KeyValue
              labelCase="sentence"
              items={[
                { label: t('details.outcome'), value: t(form.outcomeWanted ? `outcome.${form.outcomeWanted}` : 'outcome.none') },
                { label: t('details.yourRef'), value: form.customerRef.trim() || none },
                { label: t('details.note'), value: form.note.trim() ? <span className="fw-cl-pre">{form.note.trim()}</span> : none },
              ]}
            />
          </Summary>
        </>
      ) : (
        <>
          <Summary title={t('review.item')} step="item" actions={actions}>
            <KeyValue
              labelCase="sentence"
              items={[
                { label: t('review.item'), value: form.itemKey === WHOLE_DELIVERY ? t('item.whole') : itemTitle(itemOf(page, form.itemKey), t) },
                { label: t('item.serial'), value: form.serial.trim() || none },
                { label: t('item.batch'), value: form.batchNumber.trim() || none },
              ]}
            />
          </Summary>
          <Summary title={t('review.details')} step="details" actions={actions}>
            <KeyValue
              labelCase="sentence"
              items={[
                { label: t('details.description'), value: <span className="fw-cl-pre">{form.description.trim() || none}</span> },
                { label: t('details.yourRef'), value: form.customerRef.trim() || none },
              ]}
            />
          </Summary>
        </>
      )}
      <Summary title={t('review.photos')} step="photos" actions={actions}>
        <KeyValue
          labelCase="sentence"
          items={photoGroups(form).map((group) => ({
            label: group === CASE_GROUP ? t('photos.case') : itemTitle(itemOf(page, group), t),
            value: t('review.photoCount', { count: photosOf(model.photos, group).length }),
          }))}
        />
      </Summary>
      <Field label={t('review.name')} hint={t('review.nameHint')} error={error('typedName')} htmlFor={fieldId('typedName')}>
        <Input id={fieldId('typedName')} value={form.typedName} autoComplete="name" onChange={(event) => actions?.onField?.('typedName', event.target.value)} />
      </Field>
      <p className="fw-cl-hint">{held ? t(held, { sender: page.sender.companyName }) : t('review.uses', { count: page.link.usesLeft })}</p>
    </>
  )
}
