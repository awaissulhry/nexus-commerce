/**
 * Shared config for the schedule builders (Budget Schedule · Dayparting Schedule).
 *
 * Both schedule types use the same full-screen builder shell (Schedule Name · Campaign
 * Section · {kind} Schedule · Advanced Settings), the same Hourly Campaign Performance
 * chart, and the same weekly schedule table — differing only in the type-radio copy and the
 * per-row "adjustment type" catalog. Keeping that here means a change propagates to both.
 */

export type ScheduleKind = 'budget' // 'dayparting' is added by the sibling session

export interface ScheduleConfig {
  /** top-bar title + create-button label (verbatim H10 copy) */
  title: string
  createLabel: string
  /** left scroll-spy nav (also the section headings) */
  nav: { id: string; label: string }[]
  /** Campaign/"Budget" Schedule section heading + blurb */
  sectionTitle: string
  sectionDesc: string
  /** the two schedule-type radios */
  types: { value: string; label: string; desc: string }[]
}

export const SCHEDULE_CONFIG: Record<ScheduleKind, ScheduleConfig> = {
  budget: {
    title: 'Create Budget Schedule',
    createLabel: 'Create Schedule',
    nav: [
      { id: 'name', label: 'Schedule Name' },
      { id: 'campaigns', label: 'Campaign Section' },
      { id: 'schedule', label: 'Budget Schedule' },
      { id: 'advanced', label: 'Advanced Settings' },
    ],
    sectionTitle: 'Budget Schedule',
    sectionDesc: 'Select the type of budget schedule you want to create and then set up the hourly/daily adjustments.',
    types: [
      { value: 'campaign-budget', label: 'Campaign Budget', desc: "Set up an hourly schedule to adjust your campaign's budget" },
      { value: 'budget-multiplier', label: 'Budget Multiplier', desc: "Set up a daily schedule to adjust your campaign's budget multiplier" },
    ],
  },
}

// slug is reserved so the Dayparting session can branch this to its own config.
export const scheduleConfigFor = (_slug: string): ScheduleConfig => SCHEDULE_CONFIG.budget

// ── chart catalog (order/units mirror the H10 "Hourly Campaign Performance" pickers) ──
export const CHART_METRICS = ['Spend', 'ACoS', 'Sales', 'Orders', 'Clicks', 'Impressions', 'CPC', 'CTR', 'CVR', 'ROAS', 'CPA'].map((m) => ({ value: m, label: m }))
export const GROUP_BY = [
  { value: 'hour', label: 'Hour of Day' },
  { value: 'weekday', label: 'Day of Week' },
]
export const DAYS_OF_WEEK_FILTER = [
  { value: 'all', label: 'All Days' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekends', label: 'Weekends' },
]

// ── weekly schedule table ──
export const WEEKDAYS = [
  { idx: 1, short: 'MON', label: 'Monday' },
  { idx: 2, short: 'TUE', label: 'Tuesday' },
  { idx: 3, short: 'WED', label: 'Wednesday' },
  { idx: 4, short: 'THU', label: 'Thursday' },
  { idx: 5, short: 'FRI', label: 'Friday' },
  { idx: 6, short: 'SAT', label: 'Saturday' },
  { idx: 0, short: 'SUN', label: 'Sunday' },
]
// "Select time" options — hourly grain (Group By = Hour of Day). 12h label like the rule builder.
export const TIME_OPTIONS = Array.from({ length: 24 }, (_, h) => {
  const hh = String(h).padStart(2, '0')
  const ampm = h === 0 ? '12:00 AM' : h < 12 ? `${h}:00 AM` : h === 12 ? '12:00 PM' : `${h - 12}:00 PM`
  return { value: `${hh}:00`, label: `${ampm}` }
})
// adjustment-type catalog. Campaign-Budget (hourly absolute €) vs Budget-Multiplier (×).
export const BUDGET_ADJUSTMENTS = [
  { value: 'set', label: 'Set Budget to (€)', unit: 'eur' as const },
  { value: 'incPct', label: 'Increase Budget by (%)', unit: 'pct' as const },
  { value: 'decPct', label: 'Decrease Budget by (%)', unit: 'pct' as const },
]
export const MULTIPLIER_ADJUSTMENTS = [
  { value: 'mult', label: 'Apply Multiplier (×)', unit: 'mult' as const },
]
export const adjustmentsFor = (type: string) => (type === 'budget-multiplier' ? MULTIPLIER_ADJUSTMENTS : BUDGET_ADJUSTMENTS)
