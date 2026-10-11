/**
 * ruleBuilderSave.ts — what the Amazon Ads rule builder sends when it saves, and what it says when a save is refused.
 *
 * 4h (2026-10-04; review 4.5, 4.9, 4.11) — four ways the builder's save was not honest:
 *  · Create sent AUTO when "Automate" was picked. A new rule can never pass the graduation gate (D-R1: 14 days
 *    watched, 10 runs, 1 match, then a person's click), so the level route answered 409 and the builder quietly set
 *    PROPOSE instead. The edit screen then showed "Automate" again, read from `actions[0].control`, a field the
 *    engine's mode never reads (`resolveAutonomy` in ads-autonomy.ts reads `enabled` + `autonomyLevel`).
 *  · On edit, "All markets" sent nothing, so a rule scoped to one market could never be widened again.
 *  · A refused save showed nothing: the button came back and the page stayed, with no sentence.
 * Here: Create never asks for AUTO; the edit radio shows the level the rule really has; "All markets" is `null`; and
 * every refusal becomes the server's own sentence, shown in a DS Banner.
 */

export type RuleLevel = 'OFF' | 'OBSERVE' | 'PROPOSE' | 'AUTO'
/** The Control radio. `null` = neither is picked (the rule is Off or on Observe and the person has not changed it). */
export type RuleControl = 'manual' | 'automate'

/** How each level is named on this screen: PROPOSE is "Manual" and AUTO is "Automate", as the radio says. */
export const LEVEL_LABEL: Record<RuleLevel, string> = { OFF: 'Off', OBSERVE: 'Observe', PROPOSE: 'Manual', AUTO: 'Automate' }

/** The graduation gate's evidence (`adsRuleGateStatus` in ads-rule-crud.service.ts), in words. */
export const GATE_EVIDENCE = '14 days watched, at least 10 runs and 1 match'
/** D-R1 — why "Automate" is held on a new rule. Shown in the card itself, so the refusal is never silent. */
export const AUTOMATE_HELD_AT_CREATE = `Held: a new rule starts on Manual. It can move to Automate only after it passes the graduation gate (${GATE_EVIDENCE}), and then only when a person switches it.`
/** On an edit of a rule that is not on Automate yet: the save asks, and a refusal names what is missing. */
export const AUTOMATE_NEEDS_GATE = `Allowed only after the rule passes the graduation gate (${GATE_EVIDENCE}). If it has not, saving says what is still missing and keeps the mode it has.`

interface StoredRule {
  enabled?: unknown
  autonomyLevel?: unknown
  dryRun?: unknown
  actions?: unknown
}

const isLevel = (v: unknown): v is RuleLevel => v === 'OFF' || v === 'OBSERVE' || v === 'PROPOSE' || v === 'AUTO'

/**
 * The level a stored rule is at: switched off is Off, otherwise its `autonomyLevel`. Only a row without a known level
 * (written before the column existed) falls back to `dryRun`, as `resolveAutonomy` does.
 */
export function ruleLevel(rule: StoredRule): RuleLevel {
  if (rule.enabled === false) return 'OFF'
  if (isLevel(rule.autonomyLevel)) return rule.autonomyLevel
  return rule.dryRun === false ? 'AUTO' : 'PROPOSE'
}

/** The stored Manual/Automate belt (`actions[0].control`). 'manual' makes the engine propose at any level. */
export function storedBelt(rule: StoredRule): RuleControl | null {
  const a0 = Array.isArray(rule.actions) ? (rule.actions[0] as { control?: unknown } | undefined) : undefined
  return a0?.control === 'manual' || a0?.control === 'automate' ? a0.control : null
}

/**
 * What the Control radio shows for a stored rule: Automate only when the rule really applies its actions (AUTO, and
 * no manual belt), Manual when it proposes, and neither when it is Off or on Observe.
 */
export function controlForRule(rule: StoredRule): RuleControl | null {
  const level = ruleLevel(rule)
  if (level === 'AUTO') return storedBelt(rule) === 'manual' ? 'manual' : 'automate'
  if (level === 'PROPOSE') return 'manual'
  return null
}

/** The sentence beside a radio with nothing picked. */
export function levelNote(level: RuleLevel): string {
  if (level === 'OFF') return 'This rule is Off now: it does not run. Pick Manual or Automate to switch it on when you save; leave both unpicked to keep it off.'
  if (level === 'OBSERVE') return 'This rule is on Observe now: it runs and records what it would do, but proposes nothing. Pick Manual or Automate to change that when you save; leave both unpicked to keep it on Observe.'
  return ''
}

/**
 * The level to set after the rule itself saved, or `null` to leave it alone.
 * A new rule always gets PROPOSE (it is born switched off) and never AUTO (D-R1). An edit sets a level only when the
 * person changed the radio, so a rename never switches on a rule someone switched off.
 */
export function levelToSend(s: { isEdit: boolean; initial: RuleControl | null; chosen: RuleControl | null }): 'PROPOSE' | 'AUTO' | null {
  if (!s.isEdit) return 'PROPOSE'
  if (s.chosen == null || s.chosen === s.initial) return null
  return s.chosen === 'automate' ? 'AUTO' : 'PROPOSE'
}

/** The belt to store with the rule's actions: the radio when the person changed it, else what is stored. */
export function beltToSave(s: { isEdit: boolean; initial: RuleControl | null; chosen: RuleControl | null; stored: RuleControl | null }): RuleControl {
  if (!s.isEdit) return 'manual'
  if (s.chosen != null && s.chosen !== s.initial) return s.chosen
  return s.stored ?? s.chosen ?? 'manual'
}

/** 'all' is this form's word for "every market"; the server's is `null` (`undefined` would leave the old market). */
export function scopeForSave(scopeMarket: string): string | null {
  return scopeMarket && scopeMarket !== 'all' ? scopeMarket : null
}

/** A save failed when the answer is not 2xx, or a 2xx carries an `error`. */
export function saveFailed(ok: boolean, body: unknown): boolean {
  return !ok || (body != null && typeof body === 'object' && (body as { error?: unknown }).error != null)
}

/** A string a person can read, not a code such as `not_found` or `gate_not_open`. */
const sentenceOf = (v: unknown): string | null => (typeof v === 'string' && /\s/.test(v.trim()) ? v.trim() : null)

/**
 * The server's own words for a refused save. A 409 from the level route and the untranslatable refusal carry
 * `message`; 4b's and 4c's 400s carry `{ error, problems }` with `error` = the problems joined, so more than one
 * problem is shown as a list instead of one run-on line. Only an answer without a sentence gets one written here.
 */
export function refusalFrom(status: number, body: unknown): { sentence: string; problems: string[] } {
  const b = (body != null && typeof body === 'object' ? body : {}) as { error?: unknown; message?: unknown; problems?: unknown }
  const problems = Array.isArray(b.problems) ? b.problems.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim()) : []
  const error = sentenceOf(b.error)
  if (problems.length > 1) {
    return { sentence: error && error !== problems.join(' ') ? error : `The server named ${problems.length} things to fix:`, problems }
  }
  if (problems.length === 1) return { sentence: error ?? problems[0], problems: [] }
  const said = sentenceOf(b.message) ?? error
  if (said) return { sentence: said, problems: [] }
  const code = typeof b.error === 'string' && b.error.trim() ? b.error.trim() : null
  if (status === 404) return { sentence: 'This rule no longer exists. It may have been deleted.', problems: [] }
  if (status >= 500) return { sentence: `The server failed while saving (HTTP ${status}${code ? `, ${code}` : ''}). Try again; if it keeps failing, the rule list shows what is stored.`, problems: [] }
  return { sentence: `The server refused the save${status >= 400 ? ` (HTTP ${status})` : ''}${code ? `: ${code}` : ''}.`, problems: [] }
}

/** What the builder shows after a save that did not fully land. */
export interface SaveNotice {
  tone: 'danger' | 'warning'
  title: string
  sentence: string
  problems: string[]
}

/** The rule itself was not saved (`existing` = the save went to a rule that already exists). */
export function saveRefusedNotice(existing: boolean, status: number, body: unknown): SaveNotice {
  return { tone: 'danger', title: existing ? 'Your changes were not saved' : 'The rule was not created', ...refusalFrom(status, body) }
}

/** The rule saved, but its level did not change: a new rule stays Off; an edited one keeps the level it had. */
export function levelRefusedNotice(s: { isEdit: boolean; stays: RuleLevel | null; status: number; body: unknown }): SaveNotice {
  return {
    tone: 'warning',
    title: !s.isEdit ? 'The rule is saved, but it is still off' : s.stays ? `Your changes are saved, but the mode is still ${LEVEL_LABEL[s.stays]}` : 'Your changes are saved, but the mode did not change',
    ...refusalFrom(s.status, s.body),
  }
}

/** No answer came back, so this page cannot say what was stored. */
export function noAnswerNotice(stage: 'save' | 'level', s: { isEdit: boolean; existing: boolean }): SaveNotice {
  if (stage === 'level') {
    return {
      tone: 'warning',
      title: s.isEdit ? 'Your changes are saved, but the mode may not have changed' : 'The rule is saved, but it may still be off',
      sentence: 'No answer came back when the mode was set. The rule list shows the mode the rule has.',
      problems: [],
    }
  }
  return {
    tone: 'danger',
    title: 'No answer from the server',
    sentence: s.existing
      ? 'This page cannot tell whether your changes were saved. Reopen the rule to check before saving again.'
      : 'This page cannot tell whether the rule was created. Check the rule list before creating it again.',
    problems: [],
  }
}
