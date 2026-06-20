/**
 * The 7 rule types offered by the "Select a Rule Type" modal (verbatim Helium 10 Ads
 * copy). `slug` is the URL segment for the builder route (/rules-automation/builder/<slug>)
 * and the tab the rule belongs to. Shared by the modal, the builder route, and the
 * Keyword-Harvest session.
 */
export interface RuleType {
  slug: string
  label: string
  desc: string
  /** the sub-tab a rule of this type lists under */
  tab: string
}

export const RULE_TYPES: RuleType[] = [
  { slug: 'keyword-harvesting', label: 'Keyword Harvesting', desc: 'Find converting search terms for creating new targets', tab: 'keyword-harvest' },
  { slug: 'negative-targeting', label: 'Negative Targeting', desc: 'Find poor performing search terms and create new negative targets', tab: 'negative-targeting' },
  { slug: 'budget', label: 'Budget', desc: 'Adjust the daily budget of selected campaigns based on campaign performance', tab: 'budget' },
  { slug: 'bid', label: 'Bid', desc: 'Adjust the bid of keywords in selected campaigns based on keyword performance', tab: 'bid' },
  { slug: 'dayparting-schedule', label: 'Dayparting Schedule', desc: 'Create a dayparting campaign schedule based on hourly performance data', tab: 'dayparting' },
  { slug: 'budget-schedule', label: 'Budget Schedule', desc: 'Create a budget campaign schedule based on hourly performance data', tab: 'budget-schedules' },
  { slug: 'placement', label: 'Placement', desc: 'Adjust the placement value of the SP campaign based on placement data', tab: 'placement' },
]

export const ruleTypeBySlug = (slug: string): RuleType | undefined => RULE_TYPES.find((r) => r.slug === slug)
