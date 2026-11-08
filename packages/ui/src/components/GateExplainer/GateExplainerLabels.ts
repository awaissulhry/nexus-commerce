import type { GateCheckState, GateVerdict, GateWords } from './gateExplainerModel'

/**
 * `GateExplainer`'s words (B-W2b-78). English by default; a host passes the words it translates. A word with a number
 * or a name in it is a function: the host writes its own plural forms. A gate with words of its own (a certificate:
 * Covered / Not covered) passes them per check (`stateLabel`) or per gate (`labels.states`, `labels.verdicts`).
 */
export interface GateExplainerLabels extends GateWords {
  /** Each check's state, said in words beside its icon. */
  states: Record<GateCheckState, string>
  /** The gate's answer in one word. */
  verdicts: Record<GateVerdict, string>
  /** "2 of 3 checks met". */
  summary: (passed: number, total: number) => string
  /** "Who can clear it: Compliance lead". */
  who: (who: string) => string
  /** "How: ask the notified body to extend the certificate". */
  how: (how: string) => string
  /** The override block's heading. */
  override: string
  /** "Who may override: Plant manager". */
  overrideWho: (who: string) => string
  /** A frozen answer: "As it stood on 3 Nov 2026, 10:42". */
  asOf: (when: string) => string
  /** The checks' list name for a screen reader. */
  list: string
  /** The default words of a check's fix. */
  fix: string
  /** The list form with nothing blocking. */
  empty: string
  /** The popover trigger's name: "Blocked: Size 58 is outside … — show why". */
  showWhy: (line: string) => string
}

export const GATE_EXPLAINER_LABELS: GateExplainerLabels = {
  states: { pass: 'Met', fail: 'Not met', unknown: 'Not known', notNeeded: 'Not needed' },
  verdicts: { open: 'Clear', held: 'Blocked', unknown: 'Not known yet' },
  summary: (passed, total) => `${passed} of ${total} checks met`,
  who: (who) => `Who can clear it: ${who}`,
  how: (how) => `How: ${how}`,
  override: 'Override',
  overrideWho: (who) => `Who may override: ${who}`,
  asOf: (when) => `As it stood on ${when}`,
  list: 'Checks',
  fix: 'Fix',
  empty: 'Nothing is blocking',
  showWhy: (line) => `${line} — show why`,
  none: 'No checks are listed for this gate',
  held: (count, names) => `${count === 1 ? '1 check not met' : `${count} checks not met`}: ${names.join('; ')}`,
  unknownHeld: (count, names) => `${count === 1 ? '1 check not known yet' : `${count} checks not known yet`}: ${names.join('; ')}`,
  now: (value) => `now: ${value}`,
  allMet: (count) => (count === 1 ? 'The check is met' : `All ${count} checks met`),
  more: (count) => `+${count} more`,
}
