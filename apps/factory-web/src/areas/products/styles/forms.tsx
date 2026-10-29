'use client'

import { Field } from '@nexus/ui/components'
import { FilterChip, RadioCard, Select, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../lib/i18n/provider'
import type { ScaleRow, StyleView } from './api'

/**
 * Form parts the New style dialog and the studio share: the PPE question in plain words (PRD-270) and the size range
 * (scale, sizes as chips, base size; PRD-048). The rules are the API's (factory-domain product/styles/rules): an
 * EN 17092 part sets the class (2 AAA … 6 C), EN 13594 is for gloves (levels 1, 2, 1KP, 2KP), both Category II at least;
 * the choices offered here are only the ones the API accepts, so nothing typed is refused later.
 */

export type PpeCategory = StyleView['ppeCategory']
export type ProductType = StyleView['productType']

export interface PpeValue {
  ppeCategory: PpeCategory
  ppeStandard: string | null
  ppeClass: string | null
}

const GARMENT_STANDARDS: ReadonlyArray<{ standard: string; ppeClass: string }> = [
  { standard: 'EN 17092-2:2020', ppeClass: 'AAA' },
  { standard: 'EN 17092-3:2020', ppeClass: 'AA' },
  { standard: 'EN 17092-4:2020', ppeClass: 'A' },
  { standard: 'EN 17092-5:2020', ppeClass: 'B' },
  { standard: 'EN 17092-6:2020', ppeClass: 'C' },
]
const GLOVE_STANDARD = 'EN 13594:2015'
export const GLOVE_LEVELS = ['1', '2', '1KP', '2KP'] as const

/** The standards a product type may be made to, with the class each sets (null: chosen apart, the glove levels). */
export function standardsFor(productType: ProductType, current: string | null): Array<{ standard: string; ppeClass: string | null }> {
  const options: Array<{ standard: string; ppeClass: string | null }> = productType === 'GLOVES' ? [{ standard: GLOVE_STANDARD, ppeClass: null }] : [...GARMENT_STANDARDS]
  if (current && !options.some((option) => option.standard === current)) options.push({ standard: current, ppeClass: null })
  return options
}

/** A PPE value made consistent with a change (category or type): what the API would refuse is cleared. */
export function settlePpe(value: PpeValue, productType: ProductType): PpeValue {
  if (value.ppeCategory === 'NOT_PPE' || value.ppeCategory === 'CATEGORY_I') return { ppeCategory: value.ppeCategory, ppeStandard: null, ppeClass: null }
  const options = standardsFor(productType, null)
  const known = options.find((option) => option.standard === value.ppeStandard)
  if (value.ppeStandard && !known && /^EN 1(7092|3594)/.test(value.ppeStandard)) return { ...value, ppeStandard: null, ppeClass: null }
  if (known?.ppeClass) return { ...value, ppeClass: known.ppeClass }
  if (value.ppeStandard === GLOVE_STANDARD && value.ppeClass && !(GLOVE_LEVELS as readonly string[]).includes(value.ppeClass)) return { ...value, ppeClass: null }
  return value
}

export function PpeFields({ value, productType, onChange, readOnly }: { value: PpeValue; productType: ProductType; onChange: (next: PpeValue) => void; readOnly?: boolean }) {
  const t = useT('products')
  const categories: PpeCategory[] = ['CATEGORY_II', 'NOT_PPE', 'CATEGORY_I', 'CATEGORY_III']
  const needsStandard = value.ppeCategory === 'CATEGORY_II' || value.ppeCategory === 'CATEGORY_III'
  const options = standardsFor(productType, value.ppeStandard)
  const chosen = options.find((option) => option.standard === value.ppeStandard)
  if (readOnly) {
    return (
      <div className="fw-st-ppe-read">
        <strong>{t(`ppe.category.${value.ppeCategory}`)}</strong>
        <span className="fw-st-hint">{t(`ppe.why.${value.ppeCategory}`)}</span>
        {value.ppeStandard && (
          <span>
            {value.ppeStandard}
            {value.ppeClass ? ` · ${t('ppe.classIs', { class: value.ppeClass })}` : ''}
          </span>
        )}
      </div>
    )
  }
  return (
    <div className="fw-st-ppe">
      <fieldset className="fw-st-choices">
        <legend className="fw-st-legend">{t('ppe.question')}</legend>
        {categories.map((category) => (
          <RadioCard
            key={category}
            variant="row"
            name="fw-st-ppe"
            value={category}
            checked={value.ppeCategory === category}
            selected={value.ppeCategory === category}
            onChange={() => onChange(settlePpe({ ...value, ppeCategory: category }, productType))}
            title={t(`ppe.category.${category}`)}
            description={t(`ppe.why.${category}`)}
          />
        ))}
      </fieldset>
      {needsStandard && (
        <div className="fw-st-form-grid">
          <Field label={t('ppe.standard')} hint={t(productType === 'GLOVES' ? 'ppe.standardHintGloves' : 'ppe.standardHint')}>
            <Select
              value={value.ppeStandard ?? ''}
              onChange={(event) => {
                const standard = event.target.value || null
                const option = options.find((entry) => entry.standard === standard)
                onChange({ ...value, ppeStandard: standard, ppeClass: option?.ppeClass ?? null })
              }}
            >
              <option value="">{t('ppe.noStandard')}</option>
              {options.map((option) => (
                <option key={option.standard} value={option.standard}>
                  {option.ppeClass ? t('ppe.standardOption', { standard: option.standard, class: option.ppeClass }) : option.standard}
                </option>
              ))}
            </Select>
          </Field>
          {value.ppeStandard === GLOVE_STANDARD ? (
            <Field label={t('ppe.level')}>
              <Select value={value.ppeClass ?? ''} onChange={(event) => onChange({ ...value, ppeClass: event.target.value || null })}>
                <option value="">{t('ppe.noLevel')}</option>
                {GLOVE_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {t(`ppe.levelName.${level}`)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label={t('ppe.class')}>
              <p className="fw-st-static">{chosen?.ppeClass ? t('ppe.classByPart', { class: chosen.ppeClass }) : value.ppeClass ?? t('ppe.classAfterStandard')}</p>
            </Field>
          )}
        </div>
      )}
    </div>
  )
}

export interface RangeValue {
  sizeScaleId: string
  sizes: string[]
  baseSize: string | null
}

/** The scale, its sizes as chips (pressed = in the range; kept in the scale's order) and the base size among them. */
export function RangeFields({ value, scales, onChange, scaleLocked, readOnly }: { value: RangeValue; scales: readonly ScaleRow[] | null; onChange: (next: RangeValue) => void; scaleLocked?: string | null; readOnly?: boolean }) {
  const t = useT('products')
  const scale = scales?.find((entry) => entry.id === value.sizeScaleId) ?? null
  const codes = scale?.codes ?? value.sizes
  const toggle = (code: string) => {
    const on = value.sizes.includes(code)
    const sizes = codes.filter((entry) => (entry === code ? !on : value.sizes.includes(entry)))
    onChange({ ...value, sizes, baseSize: value.baseSize && sizes.includes(value.baseSize) ? value.baseSize : null })
  }
  return (
    <div className="fw-st-range">
      <div className="fw-st-form-grid">
        <Field label={t('range.scale')} hint={scaleLocked ? t(scaleLocked) : t('range.scaleHint')}>
          {readOnly || scaleLocked || !scales ? (
            <p className="fw-st-static">{scale ? `${scale.code} · ${scale.name}` : '—'}</p>
          ) : (
            <Select value={value.sizeScaleId} onChange={(event) => onChange({ sizeScaleId: event.target.value, sizes: [], baseSize: null })}>
              {!scale && <option value="">{t('range.chooseScale')}</option>}
              {scales.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.code} · {entry.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('range.base')} hint={t('range.baseHint')}>
          {readOnly ? (
            <p className="fw-st-static">{value.baseSize ?? '—'}</p>
          ) : (
            <Select value={value.baseSize ?? ''} onChange={(event) => onChange({ ...value, baseSize: event.target.value || null })}>
              <option value="">{t('range.noBase')}</option>
              {value.sizes.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <fieldset className="fw-st-chips">
        <legend className="fw-st-legend">{t('range.sizes', { count: value.sizes.length })}</legend>
        {codes.length === 0 && <p className="fw-st-hint">{t('range.noSizes')}</p>}
        {readOnly
          ? value.sizes.map((code) => (
              <Tag key={code} tone={value.baseSize === code ? 'info' : 'neutral'}>
                {code}
                {value.baseSize === code ? ` · ${t('range.baseMark')}` : ''}
              </Tag>
            ))
          : codes.map((code) => (
              <FilterChip key={code} pressed={value.sizes.includes(code)} onClick={() => toggle(code)}>
                {code}
                {value.baseSize === code ? ` · ${t('range.baseMark')}` : ''}
              </FilterChip>
            ))}
      </fieldset>
    </div>
  )
}
