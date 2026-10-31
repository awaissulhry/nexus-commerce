import type { Issue } from '../core/errors'

/**
 * The reminder ladder and the receivables settings (B-W2a-55; FIN-111; design finance.receivables "Reminders to approve";
 * W2a plan §2 "Owner switch" and GATE-ACCOUNTANT), pure. The settings live in factory-db's ReceivablesSettings (one row per
 * company, id = the company's; a tenant-wide row, id = the tenant's, companyId null): THE COMPANY'S ROW WINS WHOLE, else
 * the tenant row, else there is no ladder and no reminder is prepared. The …_money_w2a_guards trigger holds the same
 * shape for every login; these checks say it in words first.
 *
 *   ladder        at most 10 steps, levels 1, 2, 3 … in order, offsetDays whole from −60 to 365 and strictly increasing
 *                 (a negative offset reminds BEFORE the due date), the action EMAIL | LETTER | CALL, the template a key
 *                 of the wording (./wording.ts) or nothing (the generic text)
 *   the switch    remindersEnabled (OFF by default: the Owner's): while off the ladder still PREPARES reminders a
 *                 person may approve, and nothing is SENT (the database refuses SENT); on only with a ladder and the
 *                 late-payment rule decided (not UNDECIDED: the accountant's question, D.Lgs. 231/2002)
 *   interest      UNDECIDED | NONE | STATUTORY | AGREED (+ the agreed yearly %); the recovery charge of art. 6 and the
 *                 minimum amount reminded, minor units of the price grain
 */

export const REMINDER_ACTIONS = ['EMAIL', 'LETTER', 'CALL'] as const
export type ReminderAction = (typeof REMINDER_ACTIONS)[number]

export const LATE_INTEREST_MODES = ['UNDECIDED', 'NONE', 'STATUTORY', 'AGREED'] as const
export type LateInterestMode = (typeof LATE_INTEREST_MODES)[number]

export const MAX_LADDER_STEPS = 10
export const MIN_OFFSET_DAYS = -60
export const MAX_OFFSET_DAYS = 365
/** A template key: capitals, digits and underscores (`LATE_30`). */
export const TEMPLATE_KEY = /^[A-Z][A-Z0-9_]{0,39}$/

export interface LadderStep {
  readonly level: number
  readonly offsetDays: number
  readonly action: ReminderAction
  readonly template: string | null
}

/** The ladder as stored (Json), read leniently: a malformed step is dropped from what the domain uses (the DB refuses it anyway). */
export function ladderOf(value: unknown): LadderStep[] {
  if (!Array.isArray(value)) return []
  const steps: LadderStep[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const step = raw as { level?: unknown; offsetDays?: unknown; action?: unknown; template?: unknown }
    if (!Number.isSafeInteger(step.level) || !Number.isSafeInteger(step.offsetDays)) continue
    if (typeof step.action !== 'string' || !(REMINDER_ACTIONS as readonly string[]).includes(step.action)) continue
    const template = typeof step.template === 'string' && step.template.trim() !== '' ? step.template.trim() : null
    steps.push({ level: step.level as number, offsetDays: step.offsetDays as number, action: step.action as ReminderAction, template })
  }
  return steps
}

/** What is wrong with a ladder as typed (empty: nothing), with paths under `body/ladder`. */
export function ladderProblems(steps: readonly { readonly offsetDays: number; readonly action: string; readonly template?: string | null | undefined }[]): Issue[] {
  const problems: Issue[] = []
  if (steps.length > MAX_LADDER_STEPS) problems.push({ path: 'body/ladder', message: `A ladder has at most ${MAX_LADDER_STEPS} steps.` })
  let previous: number | null = null
  steps.forEach((step, index) => {
    const at = `body/ladder/${index}`
    if (!Number.isSafeInteger(step.offsetDays) || step.offsetDays < MIN_OFFSET_DAYS || step.offsetDays > MAX_OFFSET_DAYS) {
      problems.push({ path: `${at}/offsetDays`, message: `A step comes from ${-MIN_OFFSET_DAYS} days before the due date to ${MAX_OFFSET_DAYS} days after it, in whole days.` })
    } else if (previous !== null && step.offsetDays <= previous) {
      problems.push({ path: `${at}/offsetDays`, message: 'Each step comes later than the one before it.' })
    }
    if (Number.isSafeInteger(step.offsetDays)) previous = step.offsetDays
    if (!(REMINDER_ACTIONS as readonly string[]).includes(step.action)) problems.push({ path: `${at}/action`, message: 'A step sends an e-mail, a letter or asks for a call.' })
    if (step.template !== null && step.template !== undefined && !TEMPLATE_KEY.test(step.template)) problems.push({ path: `${at}/template`, message: 'A template key is written in capitals, digits and underscores (LATE_30).' })
  })
  return problems
}

/** The ladder as stored: the levels numbered 1, 2, 3 … in the order given. */
export function numberedLadder(steps: readonly { readonly offsetDays: number; readonly action: ReminderAction; readonly template?: string | null | undefined }[]): LadderStep[] {
  return steps.map((step, index) => ({ level: index + 1, offsetDays: step.offsetDays, action: step.action, template: step.template ?? null }))
}

/** The JSON stored in ReceivablesSettings.ladder (no null template key: absent). */
export const ladderJson = (steps: readonly LadderStep[]): { level: number; offsetDays: number; action: ReminderAction; template?: string }[] =>
  steps.map((step) => ({ level: step.level, offsetDays: step.offsetDays, action: step.action, ...(step.template ? { template: step.template } : {}) }))

/** A step in words: "3 days before the due date", "on the due date", "7 days late". */
export function stepWords(offsetDays: number, language: 'en' | 'it' = 'en'): string {
  if (language === 'it') {
    if (offsetDays === 0) return 'il giorno della scadenza'
    if (offsetDays < 0) return `${-offsetDays} ${offsetDays === -1 ? 'giorno' : 'giorni'} prima della scadenza`
    return `${offsetDays} ${offsetDays === 1 ? 'giorno' : 'giorni'} di ritardo`
  }
  if (offsetDays === 0) return 'on the due date'
  if (offsetDays < 0) return `${-offsetDays} ${offsetDays === -1 ? 'day' : 'days'} before the due date`
  return `${offsetDays} ${offsetDays === 1 ? 'day' : 'days'} late`
}

/** The settings that hold for a company, as the domain reads them. */
export interface EffectiveSettings {
  /** Where they come from: the company's own row, the tenant-wide row, or none (no ladder: no reminder). */
  readonly source: 'COMPANY' | 'TENANT' | 'NONE'
  readonly id: string | null
  readonly version: number | null
  readonly remindersEnabled: boolean
  readonly ladder: readonly LadderStep[]
  readonly lateInterestMode: LateInterestMode
  /** The agreed yearly rate as a decimal string (AGREED only). */
  readonly lateInterestAgreedPct: string | null
  readonly recoveryChargeAmount: number | null
  readonly minimumAmount: number | null
}

export interface SettingsRow {
  readonly id: string
  readonly companyId: string | null
  readonly version: number
  readonly remindersEnabled: boolean
  readonly ladder: unknown
  readonly lateInterestMode: LateInterestMode
  readonly lateInterestAgreedPct: string | null
  readonly recoveryChargeAmount: number | null
  readonly minimumAmount: number | null
}

export const NO_SETTINGS: EffectiveSettings = Object.freeze({
  source: 'NONE',
  id: null,
  version: null,
  remindersEnabled: false,
  ladder: [],
  lateInterestMode: 'UNDECIDED',
  lateInterestAgreedPct: null,
  recoveryChargeAmount: null,
  minimumAmount: null,
})

/** The company's row wins whole, else the tenant row, else none (the database's own rule at SENT). */
export function effectiveSettings(companyRow: SettingsRow | null, tenantRow: SettingsRow | null): EffectiveSettings {
  const row = companyRow ?? tenantRow
  if (!row) return NO_SETTINGS
  return {
    source: companyRow ? 'COMPANY' : 'TENANT',
    id: row.id,
    version: row.version,
    remindersEnabled: row.remindersEnabled,
    ladder: ladderOf(row.ladder),
    lateInterestMode: row.lateInterestMode,
    lateInterestAgreedPct: row.lateInterestAgreedPct,
    recoveryChargeAmount: row.recoveryChargeAmount,
    minimumAmount: row.minimumAmount,
  }
}

export const SWITCH_BLOCKERS = {
  NO_LADDER: 'There is no reminder ladder yet: add its steps first.',
  INTEREST_UNDECIDED:
    'The late-payment interest rule (D.Lgs. 231/2002) is not decided: it is a question for the accountant. Record their answer (none, the legal rate or an agreed rate) before reminders can reach customers.',
} as const
export type SwitchBlocker = keyof typeof SWITCH_BLOCKERS

/** Why reminders cannot be switched on with these settings (empty: they can; the database checks the same). */
export function switchBlockers(settings: Pick<EffectiveSettings, 'ladder' | 'lateInterestMode'>): SwitchBlocker[] {
  return [...(settings.ladder.length === 0 ? (['NO_LADDER'] as const) : []), ...(settings.lateInterestMode === 'UNDECIDED' ? (['INTEREST_UNDECIDED'] as const) : [])]
}

/** The switch in words, for the screens and the refusals. */
export function switchWords(settings: Pick<EffectiveSettings, 'remindersEnabled' | 'ladder' | 'lateInterestMode'>): string {
  if (settings.remindersEnabled) return 'Reminders are switched on: an approved reminder is sent to the customer.'
  const blockers = switchBlockers(settings)
  return [
    'Reminders are switched off (the Owner turns them on after the go-live): the ladder prepares them and a person may approve them, but none is sent to a customer.',
    ...blockers.map((code) => SWITCH_BLOCKERS[code]),
  ].join(' ')
}

export const INTEREST_WORDS: Readonly<Record<LateInterestMode, string>> = Object.freeze({
  UNDECIDED: 'Not decided yet (a question for the accountant, D.Lgs. 231/2002): no interest is computed, and reminders cannot be switched on.',
  NONE: 'No late-payment interest is charged.',
  STATUTORY:
    'The legal rate of D.Lgs. 231/2002 art. 5: the ECB reference rate of each half-year plus the points the law adds, from the half-year rates finance records with their source. A delay crossing a half-year without its rate has no amount: reminders then say interest is due without one.',
  AGREED: 'The yearly rate agreed with the customers.',
})

export const LATE_INTEREST_RULE_PROBLEM = 'An agreed rate is above 0 and at most 100 percent, and is given exactly when the rule is AGREED.'

/** What is wrong with a late-payment rule as typed (empty: nothing). */
export function interestProblems(mode: LateInterestMode, agreedPct: string | null | undefined): Issue[] {
  if (mode !== 'AGREED') return agreedPct === null || agreedPct === undefined ? [] : [{ path: 'body/lateInterestAgreedPct', message: LATE_INTEREST_RULE_PROBLEM }]
  if (agreedPct === null || agreedPct === undefined || !/^\d{1,3}(\.\d{1,4})?$/.test(agreedPct)) return [{ path: 'body/lateInterestAgreedPct', message: LATE_INTEREST_RULE_PROBLEM }]
  const [whole, fraction = ''] = agreedPct.split('.') as [string, string?]
  const tenThousandths = Number(whole) * 10_000 + Number(fraction.padEnd(4, '0'))
  return tenThousandths > 0 && tenThousandths <= 1_000_000 ? [] : [{ path: 'body/lateInterestAgreedPct', message: LATE_INTEREST_RULE_PROBLEM }]
}
