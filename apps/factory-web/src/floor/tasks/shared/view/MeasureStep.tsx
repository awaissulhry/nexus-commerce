'use client'

import { Check, X } from 'lucide-react'
import { FloorButton, QuantityPad } from '@nexus/ui/floor'
import { LimitMeter } from '@nexus/ui/components/LimitMeter/index'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE, type Locale } from '../../../../lib/i18n/locales'
import { verdictOf } from '../plan-checks'
import './tasks.css'

/**
 * One value of an inspection plan (lifted from B-W2b-105's In-line first piece for B-W2b-115's Incoming inspection): the
 * number on the DS QuantityPad (3 decimals for a measurement) or the choice buttons, the DS LimitMeter against nominal ±
 * tolerance, and the verdict BY THE NUMBERS when the plan gives a tolerance (the API checks the same); else Pass / Fail
 * by the inspector, held until something is entered. Every word comes from the screen.
 */

export interface MeasureCheck {
  readonly type: string
  readonly nominal: string | null
  readonly tolerance: string | null
  readonly uom: string | null
  readonly choices: readonly string[]
}

export interface MeasureWords {
  readonly savePass: string
  readonly saveFail: string
  readonly pass: string
  readonly fail: string
  /** Why Pass / Fail wait: nothing entered yet. */
  readonly held: string
  /** Why every button waits while a write is on its way. */
  readonly busy: string
  readonly pad: {
    readonly decrementLabel: string
    readonly incrementLabel: string
    readonly clearLabel: string
    readonly backLabel: string
    readonly emptyLabel: string
    readonly rangeLabel: (min: number | undefined, max: number | undefined) => string
  }
}

export function MeasureStep({
  check,
  title,
  value,
  choice,
  busy,
  locale,
  words,
  onValue,
  onChoice,
  onSave,
  id = 'fw-task-measure',
}: {
  check: MeasureCheck
  /** The check's words in the worker's language. */
  title: string
  value: number | null
  choice: string | null
  busy: boolean
  locale: Locale
  words: MeasureWords
  onValue: (value: number | null) => void
  onChoice: (value: string) => void
  onSave: (outcome: 'PASS' | 'FAIL') => void
  id?: string
}) {
  const ds = useDsWords()
  const text = check.type === 'CHOICE' ? (choice ?? '') : value === null ? '' : String(value)
  const verdict = check.type === 'CHOICE' ? null : verdictOf(check, text)
  const missing = text.trim() === ''
  const nominal = check.nominal !== null ? Number(check.nominal) : null
  return (
    <section className="fw-floor-stack" aria-labelledby={id}>
      <h2 id={id} className="fw-floor-section-title">
        {title}
      </h2>
      {check.type === 'CHOICE' ? (
        <div className="fw-task-choices" role="group" aria-label={title}>
          {check.choices.map((option) => (
            <FloorButton key={option} size="lg" block variant={option === choice ? 'primary' : 'secondary'} aria-pressed={option === choice} onClick={() => onChoice(option)}>
              {option}
            </FloorButton>
          ))}
        </div>
      ) : (
        <QuantityPad label={title} hideLabel unit={check.uom ?? undefined} value={value} onChange={onValue} min={0} max={99_999} decimals={check.type === 'MEASUREMENT' ? 3 : 0} decimalSeparator={locale === 'it' ? ',' : '.'} {...words.pad} />
      )}
      {nominal !== null && check.type === 'MEASUREMENT' ? (
        <LimitMeter label={title} value={value} unit={check.uom ?? undefined} nominal={nominal} tolerance={check.tolerance !== null ? Number(check.tolerance) : 0} locale={INTL_LOCALE[locale]} labels={ds.limitMeter} />
      ) : null}
      {verdict ? (
        <FloorButton size="lg" block variant={verdict === 'PASS' ? 'success' : 'danger'} icon={<Check />} heldReason={busy ? words.busy : null} onClick={() => onSave(verdict)}>
          {verdict === 'PASS' ? words.savePass : words.saveFail}
        </FloorButton>
      ) : (
        <div className="fw-task-verdict">
          <FloorButton size="lg" block variant="danger" icon={<X />} heldReason={busy ? words.busy : missing ? words.held : null} onClick={() => onSave('FAIL')}>
            {words.fail}
          </FloorButton>
          <FloorButton size="lg" block variant="success" icon={<Check />} heldReason={busy ? words.busy : missing ? words.held : null} onClick={() => onSave('PASS')}>
            {words.pass}
          </FloorButton>
        </div>
      )}
    </section>
  )
}
