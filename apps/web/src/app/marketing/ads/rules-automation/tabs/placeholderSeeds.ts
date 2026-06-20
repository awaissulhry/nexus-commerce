/**
 * Per-tab rule rows for the Rules & Automation sub-tabs. `negative-targeting` carries the
 * rules shown in the reference recording; the rest are representative placeholders (we have
 * no recording for those tabs yet) so the page renders the real grid shell for every tab.
 */
import type { RuleRow } from './RuleListTab'

const r = (id: string, name: string, automation: boolean, criteria: string, freqDay = 'Daily', freqTime = '06:00 AM'): RuleRow =>
  ({ id, name, automation, criteria, freqDay, freqTime })

export const TAB_RULES: Record<string, { noun: string; rows: RuleRow[] }> = {
  'negative-targeting': {
    noun: 'Negative Targeting Rule',
    rows: [
      r('n1', 'Guided campaign Negative', false, 'Sales=0, Clicks≥20'),
      r('n2', 'test - Auto - Negative', true, 'Sales=0, Clicks≥15'),
      r('n3', 'test123 Negative', false, 'Sales=0, Clicks≥20'),
    ],
  },
  bid: {
    noun: 'Bid Rule',
    rows: [
      r('b1', 'High ACoS — lower bid', true, 'ACoS≥40%, Clicks≥10'),
      r('b2', 'Low ACoS — raise bid', false, 'ACoS≤15%, Orders≥3'),
      r('b3', 'Zero-sales — suppress bid', true, 'Sales=0, Clicks≥15'),
    ],
  },
  'keyword-harvest': {
    noun: 'Keyword Harvesting Rule',
    rows: [
      r('k1', 'Converting → Exact', true, 'Orders≥2, ACoS≤25%'),
      r('k2', 'Converting → Phrase', false, 'Orders≥3'),
    ],
  },
  budget: {
    noun: 'Budget Rule',
    rows: [
      r('bu1', 'Scale winners +20%', true, 'ACoS≤20%, Budget util≥90%'),
      r('bu2', 'Cap overspend', false, 'Spend≥€50, Sales=0'),
    ],
  },
  dayparting: {
    noun: 'Dayparting Schedule',
    rows: [
      r('d1', 'Evening boost (18–23)', true, 'Hours 18–23'),
      r('d2', 'Overnight pause (0–6)', false, 'Hours 0–6'),
    ],
  },
  'budget-schedules': {
    noun: 'Budget Schedule',
    rows: [
      r('bs1', 'Black Friday ramp', false, 'Nov 24–27', 'Daily', '00:00 AM'),
    ],
  },
  placement: {
    noun: 'Placement Rule',
    rows: [
      r('p1', 'Top-of-search boost on ROAS', true, 'ROAS≥4, TOS share≤20%'),
    ],
  },
  // share-of-voice + keyword-tracker are tracking views, not rule lists → rendered by TrackerTab.
}
