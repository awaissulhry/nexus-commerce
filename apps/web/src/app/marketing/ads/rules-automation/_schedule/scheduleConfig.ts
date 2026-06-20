/**
 * Shared config for the schedule builders (Budget Schedule · Dayparting Schedule).
 *
 * Both schedule types use the same full-screen builder shell (Schedule Name · Campaign
 * Section · {kind} Schedule · Advanced Settings), the same Hourly Campaign Performance
 * chart, and the same weekly schedule table — differing only in the type-radio copy and the
 * per-row "adjustment type" catalog. Keeping that here means a change propagates to both.
 */

export type ScheduleKind = 'budget' | 'dayparting'

export interface ScheduleConfig {
  /** payload discriminator + branch key */
  kind: ScheduleKind
  /** top-bar title + create-button label (verbatim H10 copy) */
  title: string
  createLabel: string
  /** left scroll-spy nav (also the section headings) */
  nav: { id: string; label: string }[]
  /** Campaign/"Budget" Schedule section heading + blurb */
  sectionTitle: string
  sectionDesc: string
  /** the schedule-type radios (empty ⇒ no radios, e.g. Dayparting) */
  types: { value: string; label: string; desc: string }[]
  /** Dayparting adds a dedicated Timezone section + leads with the heatmap (grid) view */
  hasTimezone?: boolean
  heatmapDefault?: boolean
}

export const SCHEDULE_CONFIG: Record<ScheduleKind, ScheduleConfig> = {
  budget: {
    kind: 'budget',
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
  dayparting: {
    kind: 'dayparting',
    title: 'Create Dayparting Schedule',
    createLabel: 'Create Schedule',
    nav: [
      { id: 'name', label: 'Schedule Name' },
      { id: 'timezone', label: 'Timezone' },
      { id: 'campaigns', label: 'Campaign Section' },
      { id: 'schedule', label: 'Criteria' },
      { id: 'advanced', label: 'Advanced Settings' },
    ],
    sectionTitle: 'Dayparting Schedule Criteria',
    sectionDesc: 'Setup a schedule for campaign status and define the time periods and criteria when this schedule will be active.',
    types: [],
    hasTimezone: true,
    heatmapDefault: true,
  },
}

export const scheduleConfigFor = (slug: string): ScheduleConfig =>
  slug === 'dayparting-schedule' || slug === 'dayparting' ? SCHEDULE_CONFIG.dayparting : SCHEDULE_CONFIG.budget

// ── Timezone catalog (Dayparting). EU-market-first since Xavia is Amazon IT/EU. ──
export const TIMEZONES = [
  { value: 'Europe/Rome', label: 'CET/CEST — Central European (Rome, Milan)' },
  { value: 'Europe/London', label: 'GMT/BST — UK (London)' },
  { value: 'Europe/Madrid', label: 'CET/CEST — Spain (Madrid)' },
  { value: 'Europe/Paris', label: 'CET/CEST — France (Paris)' },
  { value: 'Europe/Berlin', label: 'CET/CEST — Germany (Berlin)' },
  { value: 'America/Los_Angeles', label: 'PST/PDT — Pacific (Los Angeles)' },
  { value: 'America/New_York', label: 'EST/EDT — Eastern (New York)' },
  { value: 'UTC', label: 'UTC — Coordinated Universal Time' },
]

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
// Dayparting turns campaign status on/off per time window — no value input (unit 'none').
export const DAYPARTING_ADJUSTMENTS = [
  { value: 'enable', label: 'Enable Campaign', unit: 'none' as const },
  { value: 'pause', label: 'Pause Campaign', unit: 'none' as const },
]
export const adjustmentsFor = (kind: ScheduleKind, type: string) =>
  kind === 'dayparting' ? DAYPARTING_ADJUSTMENTS : type === 'budget-multiplier' ? MULTIPLIER_ADJUSTMENTS : BUDGET_ADJUSTMENTS
