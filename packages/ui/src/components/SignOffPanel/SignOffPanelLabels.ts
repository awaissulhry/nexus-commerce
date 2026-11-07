import type { DutyState, SignMethod, SignOffWords, SignStepState } from './signOffPanelModel'

/**
 * `SignOffPanel`'s words (B-W2b-78). English by default; a host passes the words it translates. A word with a name or a
 * number in it is a function. Times come written from the app.
 */
export interface SignOffPanelLabels extends SignOffWords {
  /** The default title. */
  title: string
  /** Each step's state beside its icon. */
  states: Record<SignStepState, string>
  /** How a step was signed. */
  methods: Record<SignMethod, string>
  /** Each rule's state beside its icon. */
  ruleStates: Record<DutyState, string>
  /** "Signed by Marta Demo (Inspector)". */
  signedBy: (who: string, role?: string) => string
  /** "Rejected by Paolo Prova". */
  rejectedBy: (who: string) => string
  /** "Who may sign: Quality lead or plant manager". */
  whoMay: (who: string) => string
  /** The fingerprint's name. */
  fingerprint: string
  /** "1 of 2 signed". */
  summary: (signed: number, total: number) => string
  /** Every step signed. */
  complete: string
  /** The sign-off ended with a rejection. */
  rejectedSummary: string
  /** The steps' list name for a screen reader. */
  steps: string
  /** "Step 2". */
  step: (n: number) => string
}

export const SIGN_OFF_PANEL_LABELS: SignOffPanelLabels = {
  title: 'Sign-off',
  states: { signed: 'Signed', waiting: 'Waiting', held: 'Held', rejected: 'Rejected', notNeeded: 'Not needed' },
  methods: { pin: 'PIN', code: 'Code', typed: 'Typed name' },
  ruleStates: { met: 'Met', broken: 'Not met', unknown: 'Not known' },
  signedBy: (who, role) => (role ? `Signed by ${who} (${role})` : `Signed by ${who}`),
  rejectedBy: (who) => `Rejected by ${who}`,
  whoMay: (who) => `Who may sign: ${who}`,
  fingerprint: 'Fingerprint',
  summary: (signed, total) => `${signed} of ${total} signed`,
  complete: 'Every step signed',
  rejectedSummary: 'Rejected',
  steps: 'Sign-off steps',
  step: (n) => `Step ${n}`,
  afterStep: (step, label) => `Waits for step ${step}: ${label}`,
  rules: {
    maker: {
      met: 'Did not make these units (from scans)',
      broken: 'Made some of these units (from scans): another person must sign',
      unknown: 'Who made these units is not known yet',
    },
    fourEyes: {
      met: 'A second person signs (four-eyes)',
      broken: 'You signed an earlier step: a second person must sign this one (four-eyes)',
      unknown: 'The four-eyes check cannot be made yet',
    },
    authorNotApprover: {
      met: 'The author does not approve their own work',
      broken: 'You wrote it: another person must approve it',
      unknown: 'The author is not known yet',
    },
    other: { met: 'Rule met', broken: 'Rule not met', unknown: 'Rule not checked yet' },
  },
}
