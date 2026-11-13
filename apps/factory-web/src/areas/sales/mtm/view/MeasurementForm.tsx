'use client'

import { useId } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Checkbox, InfoTip, Input, Spinner, Tag } from '@nexus/ui/primitives'
import { BODY_ZONES } from '@nexus/factory-domain/sales/measure-link/rules'
import { filledOf, outsideRange, rangeText, ruleWords, type FormPoint, type Phrase } from '../model'
import { MtmMessages, useWords } from '../parts'

/** A rule the measures break while typing (B-W2b-248's check: impossible ratios, ranges), in the rule's own words. */
export interface FormFlag {
  readonly code: string
  readonly severity: 'BLOCK' | 'WARN'
  readonly words: Readonly<Record<string, string>>
  readonly pointCode: string
  readonly otherPointCode: string | null
}

export interface MeasurementFormModel {
  /** The template's ACTIVE points in measuring order. */
  readonly points: readonly FormPoint[]
  /** As typed, per point code and the basics (`height`, `weight`). */
  readonly values: Readonly<Record<string, string>>
  /** The points outside their plausible range the person checked again. */
  readonly confirmed: readonly string[]
  /** What is wrong per point code / basic, in words (said under the field). */
  readonly problems: Readonly<Record<string, Phrase>>
  /** The rules the measures break while typing (only while the template's made-to-measure rules are on). */
  readonly flags: readonly FormFlag[]
  /** The basics asked beside the points (the template does not measure them itself). */
  readonly basics: readonly ('height' | 'weight')[]
  /** The rules are being checked against what was typed. */
  readonly checking?: boolean
  /** The template's rules are off: nothing of them is checked while typing (said once). */
  readonly rulesOff?: boolean
  /** Fields drawn as text (no right, or a revision read). */
  readonly readOnly?: boolean
  /** The template's preview (Products › Sizes & measurements): what a fitter will see; nothing is saved. */
  readonly preview?: boolean
}

export interface MeasurementFormActions {
  onValue?: (code: string, value: string) => void
  onConfirm?: (code: string, checked: boolean) => void
}

/**
 * The office measurement form (design MeasurementForm, G16; mtm.new and the record's New revision; the template's preview): a
 * second view over the same model as the rider's link page (B-W2b-171's links/measure — the office may not import the links
 * view: check-view-boundaries), its rules factory-domain's: the template's points in measuring order grouped by body zone, each
 * with its name, value, unit, plausible range and how to measure it (an info tip); a value outside its range asks again in
 * words ("Chest 140 cm is outside 70–130 cm: check it") until "I checked it" is ticked; the rules the measures break are
 * flagged while typing (impossible ratios, B-W2b-248). Tab moves from point to point. Fetches nothing.
 */
export function MeasurementForm({ model, actions }: { model: MeasurementFormModel; actions?: MeasurementFormActions }) {
  return (
    <MtmMessages>
      <Form model={model} actions={actions} />
    </MtmMessages>
  )
}

function Form({ model, actions }: { model: MeasurementFormModel; actions?: MeasurementFormActions }) {
  const { t, say, locale } = useWords()
  const formId = useId()
  const flagged = new Set(model.flags.flatMap((flag) => [flag.pointCode, ...(flag.otherPointCode ? [flag.otherPointCode] : [])]))
  const zones = BODY_ZONES.map((zone) => ({ zone, points: model.points.filter((point) => point.zone === zone) })).filter((group) => group.points.length > 0)
  const filled = filledOf({ values: model.values }, model.points)

  const field = (point: FormPoint) => {
    const id = `${formId}-${point.code}`
    const typed = model.values[point.code] ?? ''
    const outside = outsideRange(point, typed)
    const range = rangeText(point)
    const problem = say(model.problems[point.code])
    const label = (
      <span className="fw-mtm-row">
        <span>{point.name}</span>
        {flagged.has(point.code) && <Tag tone="warning">{t('form.flagged')}</Tag>}
      </span>
    )
    if (model.readOnly)
      return (
        <div key={point.code} className="fw-mtm-measure">
          <dt>{point.name}</dt>
          <dd>{typed ? `${typed} ${point.unit}` : '—'}</dd>
        </div>
      )
    return (
      <div key={point.code} className="fw-mtm-tight">
        <Field label={label} required={point.required} hint={range ? t('form.range', { range }) : t('form.noRange')} error={problem ?? undefined} info={point.howTo ? <InfoTip tip={point.howTo} /> : undefined} htmlFor={id}>
          <span className="fw-mtm-value">
            <Input id={id} size="sm" inputMode="decimal" autoComplete="off" value={typed} onChange={(event) => actions?.onValue?.(point.code, event.target.value)} aria-label={t('form.valueOf', { point: point.name, unit: point.unit })} />
            <span className="fw-mtm-unit">{point.unit}</span>
          </span>
        </Field>
        {outside && <Checkbox checked={model.confirmed.includes(point.code)} onChange={(event) => actions?.onConfirm?.(point.code, event.target.checked)} label={t('form.checked', { value: `${typed} ${point.unit}` })} />}
      </div>
    )
  }

  return (
    <div className="fw-mtm-form">
      <p className="fw-mtm-hint" role="status">
        {t('form.filled', { filled, total: model.points.length })}
        {model.checking && (
          <>
            {' · '}
            <Spinner size={12} /> {t('form.checking')}
          </>
        )}
        {model.preview && ` · ${t('form.previewNote')}`}
      </p>
      {model.rulesOff && !model.readOnly && <p className="fw-mtm-hint">{t('form.rulesOff')}</p>}
      {model.flags.length > 0 && (
        <Banner tone={model.flags.some((flag) => flag.severity === 'BLOCK') ? 'danger' : 'warning'} title={t('form.flags', { count: model.flags.length })}>
          <ul className="fw-mtm-lines">
            {model.flags.map((flag) => (
              <li key={flag.code}>
                {ruleWords(flag.words, locale, flag.code)} {flag.severity === 'BLOCK' ? `(${t('form.flagBlocks')})` : ''}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {model.points.length === 0 && <p className="fw-mtm-hint">{t('form.noPoints')}</p>}
      {zones.map((group) =>
        model.readOnly ? (
          <section key={group.zone} className="fw-mtm-tight" aria-label={t(`zone.${group.zone}`)}>
            <h3 className="fw-mtm-h3">{t(`zone.${group.zone}`)}</h3>
            <dl className="fw-mtm-measures">{group.points.map(field)}</dl>
          </section>
        ) : (
          <fieldset key={group.zone} className="fw-mtm-zone">
            <legend>{t(`zone.${group.zone}`)}</legend>
            <div className="fw-mtm-points">{group.points.map(field)}</div>
          </fieldset>
        ),
      )}
      {model.basics.length > 0 && !model.readOnly && (
        <fieldset className="fw-mtm-zone">
          <legend>{t('form.basics')}</legend>
          <div className="fw-mtm-points">
            {model.basics.map((code) => {
              const id = `${formId}-${code}`
              const unit = code === 'height' ? 'cm' : 'kg'
              return (
                <Field key={code} label={t(`form.basic.${code}`)} hint={t('form.basicHint')} error={say(model.problems[code]) ?? undefined} htmlFor={id}>
                  <span className="fw-mtm-value">
                    <Input id={id} size="sm" inputMode="decimal" autoComplete="off" value={model.values[code] ?? ''} onChange={(event) => actions?.onValue?.(code, event.target.value)} aria-label={t('form.valueOf', { point: t(`form.basic.${code}`), unit })} />
                    <span className="fw-mtm-unit">{unit}</span>
                  </span>
                </Field>
              )
            })}
          </div>
        </fieldset>
      )}
    </div>
  )
}
