'use client'

/**
 * Negative Targeting page, Rules view — a stop-waste rule's few fields (2026-10-11): its name, the test (window, clicks,
 * spend as a multiple of the target cost per order, the fixed bar used without one), what a search-term rule adds
 * (exact or phrase; in its ad group or the whole campaign) and its daily run time. One form for the New rule dialog and
 * the rule's Settings tab. Bounds and words: `newRuleModel.ts` (the API's own bounds). Nothing here saves.
 */
import { Input, InfoTip, NumberStepper, SegmentedControl } from '@/design-system/primitives'
import { Field } from '@/design-system/components'
import { currencySymbol } from '../../bid/_shared/format'
import { BOUNDS, LEVEL_WORD, MATCH_WORD, fieldProblems, type NegateLevel, type NegateMatch, type RuleFields } from './newRuleModel'
import type { WasteKind } from './wasteRulesModel'
import styles from './rules.module.css'

const MATCHES = (['EXACT', 'PHRASE'] as const).map((m) => ({ value: m, label: MATCH_WORD[m] }))
const LEVELS = (['AD_GROUP', 'CAMPAIGN'] as const).map((l) => ({ value: l, label: LEVEL_WORD[l] }))

export function RuleFieldsForm({ kind, value, onChange, currency, idPrefix, showName = true }: {
  kind: WasteKind
  value: RuleFields
  onChange(next: RuleFields): void
  currency: string
  idPrefix: string
  showName?: boolean
}) {
  const problems = fieldProblems(value)
  const set = <K extends keyof RuleFields>(key: K, v: RuleFields[K]) => onChange({ ...value, [key]: v })
  return (
    <div className={styles.fields}>
      {showName && (
        <div className={styles.fieldsWide}>
          <Field label="Name" error={problems.name} htmlFor={`${idPrefix}-name`}>
            <Input id={`${idPrefix}-name`} size="sm" value={value.name} maxLength={120} onChange={(e) => set('name', e.target.value)} />
          </Field>
        </div>
      )}
      <Field label="Window" error={problems.windowDays} info={<InfoTip tip="Days it looks back. Clicks and spend stop 3 days ago; orders run to today." />}>
        <NumberStepper size="sm" value={value.windowDays} min={BOUNDS.windowDays.min} max={BOUNDS.windowDays.max} step={1} suffix="d" onChange={(n) => set('windowDays', n)} aria-label="Window in days" decrementLabel="Fewer days" incrementLabel="More days" />
      </Field>
      <Field label="Clicks ≥" error={problems.minClicks} info={<InfoTip tip="Raised to 3 ÷ the conversion rate when that is higher." />}>
        <NumberStepper size="sm" value={value.minClicks} min={BOUNDS.minClicks.min} max={BOUNDS.minClicks.max} step={1} onChange={(n) => set('minClicks', n)} aria-label="Clicks at least" decrementLabel="Fewer clicks" incrementLabel="More clicks" />
      </Field>
      <Field label="Spend ≥" error={problems.cpaMultiple} info={<InfoTip tip="Times the product's target cost per order." />}>
        <NumberStepper size="sm" value={value.cpaMultiple} min={BOUNDS.cpaMultiple.min} max={BOUNDS.cpaMultiple.max} step={0.5} suffix="× CPA" onChange={(n) => set('cpaMultiple', n)} aria-label="Spend at least, times the target cost per order" decrementLabel="Lower" incrementLabel="Higher" />
      </Field>
      <Field label="Fixed bar" error={problems.spendFloorCents} info={<InfoTip tip="The spend bar for a product with no target cost per order." />}>
        {value.spendFloorCents == null
          ? <Input size="sm" value="—" readOnly aria-label="Fixed bar (needs the ad spend permission)" title="Needs the ad spend permission" />
          : <NumberStepper size="sm" value={value.spendFloorCents / 100} min={0.01} max={BOUNDS.spendFloorCents.max / 100} step={1} suffix={currencySymbol(currency)} onChange={(n) => set('spendFloorCents', Math.round(n * 100))} aria-label="Fixed spend bar" decrementLabel="Lower" incrementLabel="Higher" />}
      </Field>
      {kind === 'NEGATE_TERM' && (
        <>
          <Field label="Negative" info={<InfoTip tip="A phrase blocks every search that contains it, so it always asks you." />}>
            <SegmentedControl size="sm" ariaLabel="Negative match" options={MATCHES} value={value.match} onChange={(v) => set('match', v as NegateMatch)} />
          </Field>
          <Field label="Where" info={<InfoTip tip="In the ad group it served in, or in its whole campaign." />}>
            <SegmentedControl size="sm" ariaLabel="Where the negative goes" options={LEVELS} value={value.level} onChange={(v) => set('level', v as NegateLevel)} />
          </Field>
        </>
      )}
      <Field label="Runs at" error={problems.runAt} info={<InfoTip tip="Once a day, Rome time." />} htmlFor={`${idPrefix}-run`}>
        <Input id={`${idPrefix}-run`} size="sm" type="time" value={value.runAt} onChange={(e) => set('runAt', e.target.value)} />
      </Field>
    </div>
  )
}
