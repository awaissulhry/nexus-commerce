import { RULE_LIMITS, type RetentionAction } from '@nexus/factory-domain/privacy/retention/retention'
import type { StepUpModel } from '../../shared/model'
import type { Read } from '../model'
import type { Phrase } from '../requests/model'
import type { RetentionList, RetentionType, Rule, RuleActionName, Sweep } from './api'

/**
 * Retention rules, pure (B-W2b-414; design admin.privacy sec:retention "Record type, keep for, then, legal reason (c.c. art.
 * 2220: 10 years), last sweep" and "Shortening needs the Owner (fresh code)"; GATE-PRIVACY): who may do what, each record
 * type, period, state and held step in the page's words, the rule form's checks and when a change asks a fresh code. Nothing
 * deletes by itself: a rule reports until a person switches it on to apply; the append-only ledgers are only listed.
 */

export interface RetentionCan {
  /** privacy.view: the rules, the ledgers kept and the dated purges. */
  view: boolean
  /** privacy.retention.manage: add, change, switch, sweep (shortening and applying ask a fresh code). */
  manage: boolean
}

export const retentionCan = (permissions: readonly string[]): RetentionCan => {
  const held = new Set(permissions)
  return { view: held.has('privacy.view'), manage: held.has('privacy.retention.manage') }
}

/** The record types the sweep knows (B-W2b-405's registry), each worded `dp.ret.type.<Type>.*`; any other: "Other records". */
export const RETENTION_TYPE_NAMES = ['ReportRun', 'CronRun', 'IntegrationErrorItem', 'InboundEmail', 'ExportJob', 'Invoice'] as const
const KNOWN: ReadonlySet<string> = new Set(RETENTION_TYPE_NAMES)
export const typeKey = (recordType: string, part: 'name' | 'countsFrom') => `dp.ret.type.${KNOWN.has(recordType) ? recordType : 'other'}.${part}`
/** What an applying sweep does with the action, in the page's words. */
export const doesKey = (recordType: string, action: RetentionAction) => (KNOWN.has(recordType) ? `dp.ret.type.${recordType}.does.${action}` : 'dp.ret.type.other.does')

/** The purges that run on their own dates (each by its own job), worded `dp.ret.purge.<key>.*`. */
export const PURGE_KEYS = ['measurementPhotos', 'portalCodes', 'linkDrafts', 'largeUploads', 'exportFiles'] as const
export const purgeKnown = (key: string) => (PURGE_KEYS as readonly string[]).includes(key)
/** Records the privacy pack keeps for good, worded `dp.ret.kept.<Type>`. */
export const KEPT_KEYS = ['DataRequest', 'ErasureRecord', 'RetentionRule', 'RetentionSweep'] as const
export const keptKnown = (type: string) => (KEPT_KEYS as readonly string[]).includes(type)

/** "10 years", "2 years and 6 months" as keys with their counts (the page puts them together in its language). */
export function periodParts(months: number): { years: number; months: number } {
  return { years: Math.floor(months / 12), months: months % 12 }
}

export type RuleState = 'off' | 'reporting' | 'applying'
export const ruleState = (rule: Pick<Rule, 'active' | 'applyOn'>): RuleState => (!rule.active ? 'off' : rule.applyOn ? 'applying' : 'reporting')
export const STATE_PILL = { off: 'neutral', reporting: 'info', applying: 'danger' } as const

/** Why a rule's step is held (a key), or null: the right first, then the rule's own state (its code). */
export function ruleHeld(rule: Rule, action: RuleActionName, can: RetentionCan): string | null {
  if (!can.manage) return 'dp.ret.held.manage'
  const state = rule.actions[action]
  return state.allowed ? null : state.held ? `dp.ret.held.${state.held.code}` : 'dp.ret.held.manage'
}

/** The last sweep in words: when, what it counted, what it changed (a report changes nothing). */
export function lastSweepPhrase(sweep: Sweep | null): Phrase {
  if (!sweep) return { key: 'dp.ret.last.none' }
  if (sweep.status === 'RUNNING') return { key: 'dp.ret.last.running' }
  if (sweep.status === 'FAILED') return { key: 'dp.ret.last.failed' }
  if (sweep.mode === 'REPORT') return { key: 'dp.ret.last.report', params: { due: sweep.due } }
  return { key: 'dp.ret.last.apply', params: { applied: sweep.applied, held: sweep.held } }
}

/** The rules a bulk "Sweep N now" may take: on and only reporting (an applying rule is swept on its own, never in a batch). */
export const bulkSweepable = (rule: Rule): boolean => rule.active && !rule.applyOn && rule.actions.sweepNow.allowed

// ---- the rule form -----------------------------------------------------------------------------------------------------------

export interface RuleDraft {
  /** null: a new rule. */
  ruleId: string | null
  recordType: string
  /** '' : every company of the group. */
  companyId: string
  keepMonths: string
  thenAction: RetentionAction | ''
  legalReason: string
}

export const newRuleDraft = (companyId: string | null): RuleDraft => ({ ruleId: null, recordType: '', companyId: companyId ?? '', keepMonths: '', thenAction: '', legalReason: '' })
export const draftOfRule = (rule: Rule): RuleDraft => ({ ruleId: rule.id, recordType: rule.recordType, companyId: rule.company?.id ?? '', keepMonths: String(rule.keepMonths), thenAction: rule.thenAction, legalReason: rule.legalReason })

/** The draft's months as a whole number, or null. */
export const monthsOf = (draft: Pick<RuleDraft, 'keepMonths'>): number | null => (/^\d{1,4}$/.test(draft.keepMonths.trim()) ? Number(draft.keepMonths.trim()) : null)

/** Why Save is held (a key), or null (factory-domain's limits; the API checks again). */
export function ruleDraftHeld(draft: RuleDraft, types: readonly RetentionType[], can: RetentionCan): string | null {
  if (!can.manage) return 'dp.ret.held.manage'
  const type = types.find((entry) => entry.recordType === draft.recordType)
  if (!draft.recordType || (!type && draft.ruleId === null)) return 'dp.ret.form.held.type'
  if (type && !type.companyScoped && draft.companyId) return 'dp.ret.form.held.group'
  const months = monthsOf(draft)
  if (months === null || months < RULE_LIMITS.minMonths || months > RULE_LIMITS.maxMonths) return 'dp.ret.form.held.months'
  if (type && type.actions.length === 0) return 'dp.ret.form.held.noAction'
  if (!draft.thenAction || (type && !type.actions.includes(draft.thenAction))) return 'dp.ret.form.held.action'
  const reason = draft.legalReason.trim()
  if (reason.length < 3) return 'dp.ret.form.held.reason'
  if (reason.length > RULE_LIMITS.legalReason) return 'dp.ret.form.held.reasonLong'
  return null
}

/** What a change sends (only what differs), or null when nothing changed. */
export function rulePatch(rule: Rule, draft: RuleDraft): { keepMonths?: number; thenAction?: RetentionAction; legalReason?: string } | null {
  const months = monthsOf(draft)
  const patch: { keepMonths?: number; thenAction?: RetentionAction; legalReason?: string } = {}
  if (months !== null && months !== rule.keepMonths) patch.keepMonths = months
  if (draft.thenAction && draft.thenAction !== rule.thenAction) patch.thenAction = draft.thenAction
  if (draft.legalReason.trim() !== rule.legalReason) patch.legalReason = draft.legalReason.trim()
  return Object.keys(patch).length > 0 ? patch : null
}

/** "Shortening needs the Owner": a shorter period, or another action while the rule applies, asks a fresh code. */
export function changeAsksCode(rule: Rule, draft: RuleDraft): boolean {
  const months = monthsOf(draft)
  return (months !== null && months < rule.keepMonths) || (rule.applyOn && !!draft.thenAction && draft.thenAction !== rule.thenAction)
}

// ---- the section's one view model -------------------------------------------------------------------------------------------

export type RetentionDialog =
  | { kind: 'rule'; draft: RuleDraft; busy: boolean; problem: string | null }
  /** "Switch <type> on to apply?": the confirm before the fresh code. */
  | { kind: 'apply'; ruleId: string; busy: boolean; problem: string | null }
  | { kind: 'sweeps'; ruleId: string; sweeps: Read<Sweep[]> }

export interface RetentionViewModel {
  can: RetentionCan
  companyId: string | null
  /** The page's companies (a rule of one company, or of the whole group). */
  companies: readonly { id: string; name: string }[]
  list: Read<RetentionList>
  selected: readonly string[]
  /** The rule a step runs on now. */
  busyRule: string | null
  updates: number
  timeZone: string
  dialog: RetentionDialog | null
  stepUp: StepUpModel
  notice: (Phrase & { tone: 'success' | 'warning' | 'danger' }) | null
  keysOpen?: boolean
}
