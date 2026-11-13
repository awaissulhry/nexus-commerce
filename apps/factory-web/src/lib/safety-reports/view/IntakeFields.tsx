'use client'

import { Camera } from 'lucide-react'
import { Field, KeyValue } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Checkbox, Input, RadioCard } from '@nexus/ui/primitives'
import { DateField, Textarea, useDsWords } from '../../i18n/ds-parts'
import { formatDate } from '../../i18n/format'
import { useLocale, useT } from '../../i18n/provider'
import { asksDayAndPlace, LIMITS, NS, sendsInjuryWords, type Door, type FieldProblems, type IntakeDraft, type IntakeField, type Worn } from '../intake'
import '../safety-intake.css'

/**
 * The form every safety-report door shares (design links.claim "Safety: what happened, when, how; was it worn as intended;
 * injury yes/no — the injury field appears only after an explicit consent tick", portal pop:safety-report, links.doc
 * sec:report; SAL-414, SAL-415): the garment (serial — typed or read by the camera — batch, size; the public page's QR fixes
 * the batch), what happened and whether it was worn as intended, an accident or a fall, whether anyone was hurt (required
 * from outside) and — only after the consent tick — what the injury was, the day and the place (asked for an accident or
 * anyone hurt: the accident log's columns), and how to reach the reporter (not on the portal: the person is known). Words of
 * the `safety-reports` catalogue; the host loads it. Draws only what its model says.
 */

export interface IntakeFieldsModel {
  readonly draft: IntakeDraft
  /** Field → a key of the catalogue (shown once Next or Send was pressed). */
  readonly problems: FieldProblems
  readonly door: Door
  /** The public page's batch (its QR): shown, never typed. */
  readonly fixedBatch: string | null
  /** The latest day the date field offers (`YYYY-MM-DD`). */
  readonly today: string
  /** The camera button ("Scan the label"); null: no camera on this door. */
  readonly scan: { readonly held: string | null } | null
  /** The company that keeps the words (the consent's sentence names it); null: "the maker". */
  readonly keeper: string | null
}

export interface IntakeFieldsActions {
  onDraft?: (patch: Partial<IntakeDraft>) => void
  onScan?: () => void
}

const WORN: readonly Worn[] = ['yes', 'no', 'unsure']

export function IntakeFields({ model, actions }: { model: IntakeFieldsModel; actions?: IntakeFieldsActions }) {
  const t = useT(NS)
  const ds = useDsWords()
  const { draft, problems, door } = model
  const set = (patch: Partial<IntakeDraft>) => actions?.onDraft?.(patch)
  const problem = (field: IntakeField) => (problems[field] ? t(problems[field]!) : undefined)
  const outside = door !== 'office'
  const asks = asksDayAndPlace(draft)
  const keeper = model.keeper ?? t('intake.theMaker')
  return (
    <div className="fw-sri">
      <fieldset className="fw-sri-group">
        <legend className="fw-sri-legend">{t('intake.garment')}</legend>
        <p className="fw-sri-hint">{outside ? (model.fixedBatch ? t('intake.garmentHintBatch') : t('intake.garmentHintOutside')) : t('intake.garmentHintOffice')}</p>
        <div className="fw-sri-row">
          <Field label={t('intake.serial')} hint={t('intake.serialHint')} error={problem('serial')}>
            <Input value={draft.serial} onChange={(event) => set({ serial: event.target.value })} maxLength={LIMITS.label} autoComplete="off" autoCapitalize="characters" spellCheck={false} className="fw-sri-mono" />
          </Field>
          {model.scan && (
            <Button variant="secondary" className="fw-sri-scan" onClick={() => actions?.onScan?.()} heldReason={model.scan.held ? t(model.scan.held) : null}>
              <Camera size={16} aria-hidden /> {t('intake.scan')}
            </Button>
          )}
        </div>
        <div className="fw-sri-row">
          {model.fixedBatch ? (
            <KeyValue dense labelCase="sentence" items={[{ label: t('intake.batch'), value: <span className="fw-sri-mono">{model.fixedBatch}</span>, hint: t('intake.batchFromQr') }]} />
          ) : (
            <Field label={t('intake.batch')} hint={t('intake.batchHint')} error={problem('batchNumber')}>
              <Input value={draft.batchNumber} onChange={(event) => set({ batchNumber: event.target.value })} maxLength={LIMITS.label} autoComplete="off" autoCapitalize="characters" spellCheck={false} className="fw-sri-mono" />
            </Field>
          )}
          <Field label={t('intake.size')} error={problem('size')}>
            <Input value={draft.size} onChange={(event) => set({ size: event.target.value })} maxLength={LIMITS.size} autoComplete="off" className="fw-sri-size" />
          </Field>
        </div>
      </fieldset>

      <fieldset className="fw-sri-group">
        <legend className="fw-sri-legend">{t('intake.what')}</legend>
        <Field label={t('intake.whatHappened')} hint={t('intake.whatHappenedHint')} error={problem('whatHappened')} required>
          <Textarea value={draft.whatHappened} onChange={(event) => set({ whatHappened: event.target.value })} rows={5} maxLength={LIMITS.whatHappened} />
        </Field>
        <div className="fw-sri-choices" role="radiogroup" aria-label={t('intake.worn')}>
          <span className="fw-sri-label">{t('intake.worn')}</span>
          {WORN.map((value) => (
            <RadioCard key={value} variant="row" name={`fw-sri-worn-${door}`} value={value} checked={draft.worn === value} selected={draft.worn === value} onChange={() => set({ worn: value })} title={t(`intake.wornValue.${value}`)} />
          ))}
        </div>
        <Checkbox checked={draft.accident} onChange={(event) => set({ accident: event.target.checked })} label={t('intake.accident')} />
        <p className="fw-sri-hint">{t('intake.accidentHint')}</p>
      </fieldset>

      <fieldset className="fw-sri-group" aria-describedby={problems.injured ? `fw-sri-injured-${door}` : undefined}>
        <legend className="fw-sri-legend">{t('intake.injured')}</legend>
        <div className="fw-sri-choices" role="radiogroup" aria-label={t('intake.injured')}>
          <RadioCard variant="row" name={`fw-sri-hurt-${door}`} value="yes" checked={draft.injured === true} selected={draft.injured === true} onChange={() => set({ injured: true })} title={t('intake.injuredYes')} />
          <RadioCard variant="row" name={`fw-sri-hurt-${door}`} value="no" checked={draft.injured === false} selected={draft.injured === false} onChange={() => set({ injured: false })} title={t('intake.injuredNo')} />
          {!outside && <RadioCard variant="row" name={`fw-sri-hurt-${door}`} value="" checked={draft.injured === null} selected={draft.injured === null} onChange={() => set({ injured: null })} title={t('intake.injuredUnsaid')} />}
        </div>
        {problems.injured && (
          <p id={`fw-sri-injured-${door}`} className="fw-sri-error">
            {t(problems.injured)}
          </p>
        )}
        {draft.injured === true && (
          <div className="fw-sri-consent">
            <Checkbox checked={draft.consent} onChange={(event) => set({ consent: event.target.checked })} label={door === 'office' ? t('intake.consentOffice', { keeper }) : t('intake.consent', { keeper })} />
            <p className="fw-sri-hint">
              {t('intake.consentWhy')} <LawRef law="GDPR art. 9(2)(a)" plain={t('intake.consentLaw')} labels={ds.lawRef} />
            </p>
            {problems.consent && <p className="fw-sri-error">{t(problems.consent)}</p>}
            {draft.consent && (
              <Field label={t('intake.injuryWords')} hint={t('intake.injuryWordsHint')} error={problem('injuryWords')}>
                <Textarea value={draft.injuryWords} onChange={(event) => set({ injuryWords: event.target.value })} rows={3} maxLength={LIMITS.injuryWords} />
              </Field>
            )}
          </div>
        )}
      </fieldset>

      <fieldset className="fw-sri-group">
        <legend className="fw-sri-legend">{t('intake.whenWhere')}</legend>
        <p className="fw-sri-hint">{asks ? t('intake.whenWhereNeeded') : t('intake.whenWhereHint')}</p>
        <div className="fw-sri-row">
          <Field label={t('intake.occurredOn')} error={problem('occurredOn')} required={asks}>
            <DateField value={draft.occurredOn} onChange={(value) => set({ occurredOn: value })} max={model.today} clearable />
          </Field>
          <Field label={t('intake.place')} hint={t('intake.placeHint')} error={problem('place')} required={asks}>
            <Input value={draft.place} onChange={(event) => set({ place: event.target.value })} maxLength={LIMITS.place} />
          </Field>
        </div>
      </fieldset>

      {door !== 'portal' && (
        <fieldset className="fw-sri-group">
          <legend className="fw-sri-legend">{door === 'office' ? t('intake.reporterOffice') : t('intake.reporter')}</legend>
          <p className="fw-sri-hint">{door === 'office' ? t('intake.reporterOfficeHint') : t('intake.reporterHint')}</p>
          <div className="fw-sri-row">
            <Field label={t('intake.name')} error={problem('name')}>
              <Input value={draft.name} onChange={(event) => set({ name: event.target.value })} maxLength={LIMITS.name} autoComplete={door === 'public' ? 'name' : 'off'} />
            </Field>
            <Field label={t('intake.email')} error={problem('email')}>
              <Input type="email" value={draft.email} onChange={(event) => set({ email: event.target.value })} maxLength={LIMITS.email} autoComplete={door === 'public' ? 'email' : 'off'} />
            </Field>
            <Field label={t('intake.phone')} error={problem('phone')}>
              <Input type="tel" value={draft.phone} onChange={(event) => set({ phone: event.target.value })} maxLength={40} autoComplete={door === 'public' ? 'tel' : 'off'} />
            </Field>
          </div>
        </fieldset>
      )}
    </div>
  )
}

/** Check and send: the report as it will be sent, in words (the injury words are the reporter's own; said as "described"). */
export function IntakeReview({ draft, door, fixedBatch }: { draft: IntakeDraft; door: Door; fixedBatch: string | null }) {
  const t = useT(NS)
  const locale = useLocale()
  const dash = '—'
  const garment = [draft.serial.trim() && t('review.serial', { serial: draft.serial.trim() }), (fixedBatch ?? draft.batchNumber.trim()) && t('review.batch', { batch: fixedBatch ?? draft.batchNumber.trim() }), draft.size.trim() && t('review.size', { size: draft.size.trim() })].filter(Boolean).join(' · ')
  const reach = [draft.name.trim(), draft.email.trim(), draft.phone.trim()].filter(Boolean).join(' · ')
  const items = [
    { label: t('intake.garment'), value: garment || dash },
    { label: t('intake.whatHappened'), value: <span className="fw-sri-words">{draft.whatHappened.trim() || dash}</span> },
    { label: t('intake.worn'), value: draft.worn ? t(`intake.wornValue.${draft.worn}`) : dash },
    { label: t('review.accident'), value: draft.accident ? t('review.yes') : t('review.no') },
    { label: t('intake.injured'), value: draft.injured === null ? t('intake.injuredUnsaid') : draft.injured ? t('intake.injuredYes') : t('intake.injuredNo') },
    ...(draft.injured ? [{ label: t('intake.injuryWords'), value: sendsInjuryWords(draft) ? t('review.injuryDescribed') : t('review.injuryNotDescribed') }] : []),
    { label: t('intake.occurredOn'), value: draft.occurredOn ? formatDate(`${draft.occurredOn}T12:00:00Z`, { locale, timeZone: 'UTC' }) : dash },
    { label: t('intake.place'), value: draft.place.trim() || dash },
    ...(door !== 'portal' ? [{ label: door === 'office' ? t('intake.reporterOffice') : t('intake.reporter'), value: reach || t('review.noReach') }] : []),
  ]
  return <KeyValue items={items} labelCase="sentence" />
}
