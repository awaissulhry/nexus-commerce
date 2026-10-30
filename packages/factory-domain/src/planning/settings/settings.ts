import type { Issue } from '../../core/errors'
import { Dec } from '../../tax/decimal'

/**
 * A site's planning settings (PLN-003; B-W2a-16; PlanningSettings, W2a wave 4), pure: how far the plan looks ahead, its
 * buckets, the planned efficiency of a line or work centre without its own (PLN-014), and the nightly run's time
 * (B-W2a-22 runs it). A site without a row plans by the defaults. The …_stock_plan_w2a_guards trigger holds the same
 * ranges for every login; these say them first, in words, with the field.
 */

export const SETTINGS_LIMITS = Object.freeze({ horizonWeeks: { min: 1, max: 104 }, efficiencyPct: { max: '200' } })

export interface PlanningSettingsValues {
  readonly horizonWeeks: number
  readonly dayBucketWeeks: number
  readonly weekBucketWeeks: number
  /** Percent of the standard minutes, two decimals at most, above 0 and at most 200 (a decimal string). */
  readonly defaultEfficiencyPct: string
  /** HH:MM in the site's time zone; null: the plan runs on demand only. */
  readonly scheduledRunTime: string | null
}

/** A site without settings: 26 weeks, days for 2 weeks, weeks to week 13, months after; 100 %; no nightly run. */
export const DEFAULT_PLANNING_SETTINGS: PlanningSettingsValues = Object.freeze({
  horizonWeeks: 26,
  dayBucketWeeks: 2,
  weekBucketWeeks: 13,
  defaultEfficiencyPct: '100.00',
  scheduledRunTime: null,
})

/** The planned efficiency of a line or work centre with no row and no site settings. */
export const DEFAULT_EFFICIENCY_PCT = '100.00'

const RUN_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/
const PERCENT = /^\d{1,3}(\.\d{1,2})?$/

/** The efficiency text as stored (two decimals), or null when it is not a percent above 0 and at most 200. */
export function efficiencyPctOf(value: string): string | null {
  if (!PERCENT.test(value.trim())) return null
  const pct = new Dec(value.trim())
  if (pct.lte(0) || pct.gt(SETTINGS_LIMITS.efficiencyPct.max)) return null
  return pct.toFixed(2)
}

/** What is wrong with a percent field (empty when nothing is). */
export function efficiencyProblems(value: string, path: string): Issue[] {
  return efficiencyPctOf(value) === null ? [{ path, message: 'Give the planned efficiency as a percent above 0 and at most 200, with at most two decimals (85 or 92.5).' }] : []
}

/** What is wrong with a whole set of settings (`base`: the body's path). */
export function settingsProblems(values: PlanningSettingsValues, base = 'body'): Issue[] {
  const problems: Issue[] = []
  const { horizonWeeks, dayBucketWeeks, weekBucketWeeks } = values
  const { min, max } = SETTINGS_LIMITS.horizonWeeks
  if (!Number.isSafeInteger(horizonWeeks) || horizonWeeks < min || horizonWeeks > max) {
    problems.push({ path: `${base}/horizonWeeks`, message: `The plan looks ${min} to ${max} weeks ahead.` })
  }
  if (!Number.isSafeInteger(dayBucketWeeks) || dayBucketWeeks < 0) problems.push({ path: `${base}/dayBucketWeeks`, message: 'Day buckets cover 0 or more weeks.' })
  else if (Number.isSafeInteger(weekBucketWeeks) && dayBucketWeeks > weekBucketWeeks) {
    problems.push({ path: `${base}/dayBucketWeeks`, message: `Day buckets (${dayBucketWeeks} weeks) end before the week buckets do (week ${weekBucketWeeks}).` })
  }
  if (!Number.isSafeInteger(weekBucketWeeks) || weekBucketWeeks < 0) problems.push({ path: `${base}/weekBucketWeeks`, message: 'Week buckets run to week 0 or later.' })
  else if (Number.isSafeInteger(horizonWeeks) && weekBucketWeeks > horizonWeeks) {
    problems.push({ path: `${base}/weekBucketWeeks`, message: `Week buckets end within the horizon (week ${horizonWeeks}); months cover the rest.` })
  }
  problems.push(...efficiencyProblems(values.defaultEfficiencyPct, `${base}/defaultEfficiencyPct`))
  if (values.scheduledRunTime !== null && !RUN_TIME.test(values.scheduledRunTime)) {
    problems.push({ path: `${base}/scheduledRunTime`, message: 'The nightly run is a time HH:MM (02:00), or none for runs on demand only.' })
  }
  return problems
}

/** The fields that differ between two sets of settings, in a fixed order. */
export function changedSettings(before: PlanningSettingsValues, after: PlanningSettingsValues): (keyof PlanningSettingsValues)[] {
  const keys: (keyof PlanningSettingsValues)[] = ['horizonWeeks', 'dayBucketWeeks', 'weekBucketWeeks', 'defaultEfficiencyPct', 'scheduledRunTime']
  return keys.filter((key) => (key === 'defaultEfficiencyPct' ? !new Dec(before[key]).eq(after[key]) : before[key] !== after[key]))
}
