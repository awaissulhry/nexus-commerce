import type { Severity } from '../insights/attention'
import type { Phrase, WordParams } from '../insights/words'
import type { AlertSeverity } from './kinds'
import { alertPhrase, phraseText } from './rules'

/**
 * An alert as a row of Today (B-W2a-33; design home.alerts conn "Today's Needs me shows my open alerts"): the kind
 * RULE_ALERT of insights/attention, one of the person's OWN rows (assigned to me, or nobody's yet and its rule tells me),
 * read only when a screen asks for it (`GET /home/today?include=ALERTS`). The sentence is the alert's own phrase
 * (alerts/rules ALERT_TEMPLATES, key `alerts.<KIND>…`); why it is mine is one of two phrases below. The web's catalogue
 * (home.json `today.w.<key>`) gains these keys with the Today screens (B-W2a-40).
 */
export const RULE_ALERT_WHY = {
  'why.RULE_ALERT.assigned': 'It is assigned to you.',
  'why.RULE_ALERT.recipient': 'The rule "{rule}" tells you.',
} as const satisfies Record<string, string>

/** An alert's severity as Today ranks it: critical is urgent, a warning needs action, information when you can. */
export const TODAY_SEVERITY: Readonly<Record<AlertSeverity, Severity>> = Object.freeze({ CRITICAL: 'HIGH', WARNING: 'MEDIUM', INFO: 'LOW' })

const phrase = (key: string, params: WordParams, text: string): Phrase => Object.freeze({ key, params: Object.freeze({ ...params }), text })

/** The row's sentence: the alert's phrase, in English beside its key and params. */
export function alertRowPhrase(kind: string, label: string, facts: unknown): Phrase {
  const found = alertPhrase(kind, label, facts)
  return phrase(found?.key ?? 'alerts.UNKNOWN', found?.params ?? { label }, phraseText(found, label, 'en'))
}

/** Why the row is mine: assigned to me, or its rule tells me. */
export function alertWhyPhrase(assignedToMe: boolean, ruleName: string): Phrase {
  return assignedToMe ? phrase('why.RULE_ALERT.assigned', {}, RULE_ALERT_WHY['why.RULE_ALERT.assigned']) : phrase('why.RULE_ALERT.recipient', { rule: ruleName }, RULE_ALERT_WHY['why.RULE_ALERT.recipient'].replace('{rule}', ruleName))
}
