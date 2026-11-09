'use client'

import type { KeyboardEvent } from 'react'
import { Banner, Field, ProgressBar, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { centimetresOf, FITS, kilogramsOf, lengthIn, MEASURE_LIMITS, PHOTO_RETENTION_DAYS_AFTER_SHIPPING, PHOTO_VIEWS, pointsByZone, WEIGHT_UNIT_OF, type MeasureHint, type PhotoView } from '@nexus/factory-domain/sales/measure-link/rules'
import { Textarea } from '../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import type { MeasurePage } from '../api'
import { fieldId, filled, hintsFor, MINUTES, pointsOf, walkOf, type MeasureActions, type MeasureViewModel, type Step } from '../model'
import { BodyFigure } from './BodyFigure'

type Props = { readonly page: MeasurePage; readonly model: MeasureViewModel; readonly actions?: MeasureActions | undefined }

const unitWord = (t: (key: string) => string, units: 'cm' | 'in') => t(`unit.${units}`)

/** A field's problem in our words: `<field>.<code>` (with the point's name for a point). */
function useProblem() {
  const t = useT('link-measure')
  return (code: string | undefined, params: Record<string, string | number> = {}) => (code ? t(`issue.${code}`, { ...params, limit: MEASURE_LIMITS.notes }) : undefined)
}

/** Design sec:intro + sec:privacy — who asks and why, what it takes, and the notice BEFORE any field. */
export function StartStep({ page, model, actions }: Props) {
  const t = useT('link-measure')
  const locale = useLocale()
  const garment = page.garment.name[locale]
  const noticeHref = `/privacy/${encodeURIComponent(page.sender.companyId)}`
  const read = page.noticeRead
  return (
    <div className="fw-ms-stack">
      <section className="fw-ms-section" aria-labelledby="fw-ms-intro">
        <h3 id="fw-ms-intro" className="fw-ms-h3">
          {t('intro.title')}
        </h3>
        <p className="fw-ms-text">{page.order ? t('intro.whoOrder', { sender: page.sender.companyName, garment, order: page.order.number }) : t('intro.who', { sender: page.sender.companyName, garment })}</p>
        <ul className="fw-ms-list">
          <li>{t('intro.time', { minutes: MINUTES })}</li>
          <li>{t('intro.tape')}</li>
          <li>{t('intro.helper')}</li>
          <li>{t(page.photos === 'REQUIRED' ? 'intro.layerRequired' : 'intro.layerOptional')}</li>
        </ul>
        <p className="fw-ms-hint">{t('intro.later', { day: formatDate(page.link.expiresAt, { locale, timeZone: model.timeZone }) })}</p>
      </section>
      <section className="fw-ms-section" aria-labelledby="fw-ms-privacy">
        <h3 id="fw-ms-privacy" className="fw-ms-h3">
          {t('privacy.title')}
        </h3>
        {page.notice ? (
          <>
            <Banner tone="info" title={t('privacy.lead')}>
              <ul className="fw-ms-list">
                <li>{t('privacy.what')}</li>
                <li>{t('privacy.why', { sender: page.sender.companyName })}</li>
                <li>{t('privacy.keep', { days: PHOTO_RETENTION_DAYS_AFTER_SHIPPING })}</li>
                <li>{t('privacy.who', { sender: page.sender.companyName })}</li>
              </ul>
              <p className="fw-ms-text">
                <a className="fw-ms-link" href={noticeHref} target="_blank" rel="noopener noreferrer">
                  {t('privacy.full', { version: page.notice.label })}
                </a>
              </p>
            </Banner>
            <div id={fieldId('notice')} tabIndex={-1} className="fw-ms-tick">
              <Checkbox
                checked={read !== null || model.notice === 'busy'}
                disabled={read !== null || model.notice === 'busy'}
                onChange={() => actions?.onTick?.()}
                label={read ? t('privacy.ticked', { when: formatDateTime(read.at, { locale, timeZone: model.timeZone }) }) : t('privacy.tick')}
              />
              {model.notice === 'busy' ? <Spinner size={14} /> : null}
            </div>
            {model.issues.notice && !read ? <p className="fw-ms-error">{t('privacy.tickFirst')}</p> : null}
            {model.notice === 'failed' ? <p className="fw-ms-error">{t('privacy.tickFailed')}</p> : null}
            {!read ? <p className="fw-ms-hint">{t('privacy.held')}</p> : null}
          </>
        ) : (
          <Banner tone="warning" title={t('privacy.missing', { sender: page.sender.companyName })}>
            {t('privacy.missingBody')}
          </Banner>
        )}
      </section>
    </div>
  )
}

/** Design sec:basics — height, weight, age and the units (cm / in), checked when each field is left. */
export function BasicsStep({ page, model, actions }: Props) {
  const t = useT('link-measure')
  const problem = useProblem()
  const units = model.form.units
  const weightUnit = WEIGHT_UNIT_OF[units]
  const field = (name: 'height' | 'weight' | 'age', suffix: string | null, mode: 'decimal' | 'numeric') => {
    const path = `body/basics/${name}`
    const error = problem(model.issues[path], { field: t(`basics.${name}`) })
    return (
      <Field label={t(`basics.${name}`)} required htmlFor={fieldId(path)} hint={t(`basics.${name}Hint`, { unit: suffix ?? '' })} error={error}>
        <Input
          id={fieldId(path)}
          inputMode={mode}
          autoComplete="off"
          value={model.form.basics[name]}
          aria-invalid={error ? true : undefined}
          onChange={(event) => actions?.onBasic?.(name, event.target.value)}
          onBlur={() => actions?.onLeave?.(path)}
          {...(suffix ? { suffix } : {})}
        />
      </Field>
    )
  }
  return (
    <div className="fw-ms-stack">
      <div className="fw-ms-units">
        <span className="fw-ms-label" id="fw-ms-units">
          {t('basics.units')}
        </span>
        <SegmentedControl ariaLabel={t('basics.units')} options={[{ value: 'cm', label: t('unit.cmKg') }, { value: 'in', label: t('unit.inLb') }]} value={units} onChange={(value) => actions?.onUnits?.(value as 'cm' | 'in')} />
      </div>
      <div className="fw-ms-grid">
        {field('height', unitWord(t, units), 'decimal')}
        {field('weight', t(`unit.${weightUnit}`), 'decimal')}
        {field('age', null, 'numeric')}
      </div>
      <p className="fw-ms-hint">{t('basics.why')}</p>
      {page.points.length === 0 ? <p className="fw-ms-hint">{t('points.none')}</p> : null}
    </div>
  )
}

function hintWords(t: (key: string, params?: Record<string, string | number>) => string, hint: MeasureHint, name: string, units: 'cm' | 'in'): string {
  const value = `${lengthIn(hint.valueCm, units)} ${t(`unit.${units}`)}`
  const bound = `${lengthIn(hint.boundCm, units)} ${t(`unit.${units}`)}`
  return t(`hint.${hint.kind}`, { point: name, value, bound })
}

/** Design sec:points — guided points of measure by body zone: the picture, the value, a guide; hints never block. */
export function PointsStep({ page, model, actions }: Props) {
  const t = useT('link-measure')
  const locale = useLocale()
  const problem = useProblem()
  const units = model.form.units
  const walk = walkOf(page, locale)
  const hints = hintsFor(page, model.form, locale)
  const groups = pointsByZone(pointsOf(page, locale))
  const count = filled(page, model.form)
  const focusPoint = (index: number) => {
    const point = walk[index]
    if (!point) return
    document.getElementById(fieldId(`body/values/${point.code}`))?.focus()
  }
  const onKey = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    focusPoint(event.shiftKey ? index - 1 : index + 1)
  }
  if (walk.length === 0) return <p className="fw-ms-hint">{t('points.none')}</p>
  return (
    <div className="fw-ms-stack">
      <div className="fw-ms-progress">
        <p className="fw-ms-count" aria-live="polite">
          {model.pointAt !== null ? t('points.at', { at: model.pointAt + 1, of: walk.length }) : t('points.filled', { done: count, of: walk.length })}
        </p>
        <ProgressBar ariaLabel={t('points.progress')} value={walk.length === 0 ? 0 : Math.round((count * 100) / walk.length)} tone={count === walk.length ? 'complete' : 'partial'} />
      </div>
      {groups.map((group) => (
        <section key={group.zone} className="fw-ms-zone" aria-labelledby={`fw-ms-zone-${group.zone}`}>
          <h3 id={`fw-ms-zone-${group.zone}`} className="fw-ms-h3">
            {t(`zone.${group.zone}`)}
          </h3>
          {group.points.map((point) => {
            const index = walk.findIndex((entry) => entry.code === point.code)
            const path = `body/values/${point.code}`
            const error = problem(model.issues[path], { field: point.name })
            const hint = hints.find((entry) => entry.code === point.code)
            return (
              <div key={point.code} className="fw-ms-point" data-point={point.code}>
                <BodyFigure code={point.code} />
                <div className="fw-ms-point-field">
                  <Field label={point.name} required={point.required} htmlFor={fieldId(path)} hint={point.howTo ?? undefined} error={error}>
                    <Input
                      id={fieldId(path)}
                      inputMode="decimal"
                      autoComplete="off"
                      enterKeyHint={index === walk.length - 1 ? 'done' : 'next'}
                      value={model.form.values[point.code] ?? ''}
                      suffix={unitWord(t, units)}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={hint ? `${fieldId(path)}-hint` : undefined}
                      onChange={(event) => actions?.onValue?.(point.code, event.target.value)}
                      onFocus={() => actions?.onPointFocus?.(index)}
                      onBlur={() => {
                        actions?.onPointFocus?.(null)
                        actions?.onLeave?.(path)
                      }}
                      onKeyDown={(event) => onKey(event, index)}
                    />
                  </Field>
                  {hint ? (
                    <p id={`${fieldId(path)}-hint`} className="fw-ms-check" role="note">
                      {hintWords(t, hint, point.name, units)}
                    </p>
                  ) : null}
                  <Button size="sm" variant="quiet" onClick={() => actions?.onGuide?.(point.code)}>
                    {t('points.guide', { point: point.name })}
                  </Button>
                </div>
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )
}

/** Design sec:fit — fit (snug / regular), posture and riding notes, asymmetry. */
export function FitStep({ model, actions }: Props) {
  const t = useT('link-measure')
  const problem = useProblem()
  const posture = problem(model.issues['body/fit/posture'])
  const asymmetry = problem(model.issues['body/fit/asymmetry'])
  return (
    <div className="fw-ms-stack">
      <fieldset className="fw-ms-fieldset">
        <legend className="fw-ms-label">{t('fit.legend')}</legend>
        <div className="fw-ms-choices" role="radiogroup" aria-label={t('fit.legend')}>
          {FITS.map((fit) => (
            <RadioCard key={fit} name="fw-ms-fit" value={fit} title={t(`fit.${fit}.title`)} description={t(`fit.${fit}.body`)} selected={model.form.fit.fit === fit} checked={model.form.fit.fit === fit} onChange={() => actions?.onFit?.(fit)} />
          ))}
        </div>
      </fieldset>
      <Field label={t('fit.posture')} hint={t('fit.postureHint')} htmlFor={fieldId('body/fit/posture')} error={posture}>
        <Textarea id={fieldId('body/fit/posture')} rows={3} limit={MEASURE_LIMITS.notes} value={model.form.fit.posture} onChange={(event) => actions?.onNotes?.('posture', event.target.value)} onBlur={() => actions?.onLeave?.('body/fit/posture')} />
      </Field>
      <Field label={t('fit.asymmetry')} hint={t('fit.asymmetryHint')} htmlFor={fieldId('body/fit/asymmetry')} error={asymmetry}>
        <Textarea id={fieldId('body/fit/asymmetry')} rows={3} limit={MEASURE_LIMITS.notes} value={model.form.fit.asymmetry} onChange={(event) => actions?.onNotes?.('asymmetry', event.target.value)} onBlur={() => actions?.onLeave?.('body/fit/asymmetry')} />
      </Field>
    </div>
  )
}

/** Design sec:photos — front, side and back in a base layer (PhotoCapture with a silhouette guide; retake). */
export function PhotosStep({ page, model, actions }: Props) {
  const t = useT('link-measure')
  return (
    <div className="fw-ms-stack">
      <p className="fw-ms-text">{t(page.photos === 'REQUIRED' ? 'photos.leadRequired' : 'photos.leadOptional')}</p>
      <ul className="fw-ms-list">
        <li>{t('photos.howLayer')}</li>
        <li>{t('photos.howStand')}</li>
        <li>{t('photos.howFace')}</li>
      </ul>
      <div className="fw-ms-tiles">
        {PHOTO_VIEWS.map((view) => (
          <PhotoTileView key={view} view={view} page={page} model={model} actions={actions} />
        ))}
      </div>
      <p className="fw-ms-hint">{t('photos.kept', { days: PHOTO_RETENTION_DAYS_AFTER_SHIPPING })}</p>
    </div>
  )
}

function PhotoTileView({ view, page, model, actions }: Props & { view: PhotoView }) {
  const t = useT('link-measure')
  const tile = model.tiles[view]
  const path = `body/photos/${view}`
  const code = model.issues[path]
  const has = model.form.photos[view] !== undefined || tile !== undefined
  return (
    <div id={fieldId(path)} tabIndex={-1} className="fw-ms-tile" data-state={tile?.state ?? (has ? 'ready' : 'empty')}>
      <p className="fw-ms-tile-title">
        {t(`photos.view.${view}`)} {page.photos === 'REQUIRED' ? <span className="fw-ms-needed">{t('photos.needed')}</span> : <span className="fw-ms-optional">{t('photos.optional')}</span>}
      </p>
      <div className="fw-ms-tile-frame">
        {tile?.src ? <img src={tile.src} alt={t('photos.alt', { view: t(`photos.view.${view}`) })} /> : <BodyFigure code={view === 'SIDE' ? 'outside_leg' : 'torso'} />}
        {tile?.state === 'uploading' || tile?.state === 'loading' ? (
          <span className="fw-ms-tile-state" role="status">
            <Spinner size={14} /> {t(tile.state === 'uploading' ? 'photos.sending' : 'photos.loading')}
          </span>
        ) : null}
      </div>
      {tile?.state === 'failed' ? <p className="fw-ms-error">{t(tile.src === null ? 'photos.readFailed' : 'photos.failed')}</p> : null}
      {code ? <p className="fw-ms-error">{t(`issue.${code}`)}</p> : null}
      <div className="fw-ms-actions">
        {tile?.state === 'failed' ? (
          <Button size="sm" onClick={() => actions?.onPhotoRetry?.(view)}>
            {t('retry')}
          </Button>
        ) : null}
        <Button size="sm" variant={has ? 'quiet' : 'primary'} heldReason={tile?.state === 'uploading' ? t('photos.sending') : null} onClick={() => actions?.onPhotoOpen?.(view)}>
          {has ? t('photos.retake') : t('photos.take')}
        </Button>
      </div>
    </div>
  )
}

/** Design sec:review — every value in one table, each part with Change, then the send. */
export function ReviewStep({ page, model, actions }: Props) {
  const t = useT('link-measure')
  const locale = useLocale()
  const form = model.form
  const units = form.units
  const hints = hintsFor(page, form, locale)
  const change = (step: Step) => (
    <Button size="sm" variant="quiet" onClick={() => actions?.onStep?.(step)}>
      {t('review.change')}
    </Button>
  )
  const height = centimetresOf(form.basics.height, units)
  const weight = kilogramsOf(form.basics.weight, units)
  const shown = (value: string, unit: string) => (value.trim() ? `${value.trim().replace(',', '.')} ${unit}` : t('review.empty'))
  const basicsRows = [
    { id: 'height', cells: [t('basics.height'), shown(form.basics.height, t(`unit.${units}`)), units === 'in' && height !== null ? t('review.kept', { value: `${lengthIn(height, 'cm')} cm` }) : '', change('basics')] },
    { id: 'weight', cells: [t('basics.weight'), shown(form.basics.weight, t(`unit.${WEIGHT_UNIT_OF[units]}`)), units === 'in' && weight !== null ? t('review.kept', { value: `${lengthIn(weight, 'cm')} kg` }) : '', change('basics')] },
    { id: 'age', cells: [t('basics.age'), form.basics.age.trim() || t('review.empty'), '', change('basics')] },
  ]
  const pointRows = walkOf(page, locale).map((point) => {
    const hint = hints.find((entry) => entry.code === point.code)
    return { id: point.code, cells: [point.name, shown(form.values[point.code] ?? '', t(`unit.${units}`)), hint ? hintWords(t, hint, point.name, units) : '', change('points')] }
  })
  const fitRows = [
    { id: 'fit', cells: [t('fit.legend'), form.fit.fit ? t(`fit.${form.fit.fit}.title`) : t('review.empty'), '', change('fit')] },
    { id: 'posture', cells: [t('fit.posture'), form.fit.posture.trim() || t('review.empty'), '', change('fit')] },
    { id: 'asymmetry', cells: [t('fit.asymmetry'), form.fit.asymmetry.trim() || t('review.empty'), '', change('fit')] },
  ]
  const photoRows = PHOTO_VIEWS.map((view) => ({ id: view, cells: [t(`photos.view.${view}`), form.photos[view] ? t('review.photoTaken') : t('review.photoNone'), '', change('photos')] }))
  const columns = [t('review.col.what'), t('review.col.value'), t('review.col.check'), t('review.col.change')]
  return (
    <div className="fw-ms-stack">
      <p className="fw-ms-text">{t('review.lead')}</p>
      <SummaryTable label={t('review.basics')} columns={columns} rows={basicsRows} stackOnPhone />
      {pointRows.length > 0 ? <SummaryTable label={t('review.points')} columns={columns} rows={pointRows} stackOnPhone /> : null}
      <SummaryTable label={t('review.fit')} columns={columns} rows={fitRows} stackOnPhone />
      <SummaryTable label={t('review.photos')} columns={columns} rows={photoRows} stackOnPhone />
      {hints.length > 0 ? <Banner tone="info" title={t('review.hints', { count: hints.length })}>{t('review.hintsBody')}</Banner> : null}
      <Field label={t('review.name')} hint={t('review.nameHint')} htmlFor="fw-ms-typed-name">
        <Input id="fw-ms-typed-name" autoComplete="name" maxLength={MEASURE_LIMITS.typedName} value={model.typedName} onChange={(event) => actions?.onTypedName?.(event.target.value)} />
      </Field>
    </div>
  )
}
