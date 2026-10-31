import { KINDS, RULE_KINDS } from '@nexus/factory-domain/alerts/kinds'
import { TIMER_KINDS } from '@nexus/factory-domain/timers/rules'
import type { PanelRead } from '../../../record-panels/model'
import type { AlertRule, RulesList } from '../../_shared/rules/api'
import type { RuleDialogState } from '../../_shared/rules/view/RuleDialog'

/**
 * Admin › Platform › Approvals, automation & AI (SCR-167, the W2a part; design admin.automation, PLT-100): the ONE view
 * model the page draws and its pure rules. "One page for every rule engine": the five lists in a segmented control in the
 * address (`?view=`, keys 1–5) — W2a builds Reminders & timers (the DATE exception rules of B-W2a-33 and their timers);
 * Approval rules are W2b, Automation, Run log and AI are W3 (drawn held, with when). The reminders the modules keep
 * themselves (the payment reminder ladder) are named with where they are kept: no rule of this page sets them.
 */

export const NAMESPACE = 'admin-automation'

export const VIEWS = ['approvals', 'timers', 'automation', 'runs', 'ai'] as const
export type AutomationView = (typeof VIEWS)[number]

/** The lists this wave builds; the others are held with the wave that brings them. */
export const BUILT: ReadonlySet<AutomationView> = new Set(['timers'])
export const LATER: Readonly<Record<Exclude<AutomationView, 'timers'>, 'W2b' | 'W3'>> = Object.freeze({ approvals: 'W2b', automation: 'W3', runs: 'W3', ai: 'W3' })

export const viewOf = (value: string | null | undefined): AutomationView => (BUILT.has(value as AutomationView) ? (value as AutomationView) : 'timers')

export interface AutomationControls {
  readonly view: AutomationView
  /** The rule dialog (`?rule=<id>`, `?rule=new`). */
  readonly rule: string | null
}

export function controlsOf(params: { get(name: string): string | null } | null | undefined): AutomationControls {
  return { view: viewOf(params?.get('view')), rule: params?.get('rule') || null }
}

export function automationAddress(controls: AutomationControls): string {
  const query = new URLSearchParams()
  if (controls.view !== 'timers') query.set('view', controls.view)
  if (controls.rule) query.set('rule', controls.rule)
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** Keys 1–5 switch the list: the view of a digit, when it is built. */
export function viewOfKey(key: string): AutomationView | null {
  const index = Number(key) - 1
  if (!Number.isInteger(index) || index < 0 || index >= VIEWS.length) return null
  const view = VIEWS[index]!
  return BUILT.has(view) ? view : null
}

/** A date rule (fires relative to a record's date through its timers): the rows of Reminders & timers. */
export const isDateRule = (rule: Pick<AlertRule, 'trigger'>): boolean => rule.trigger === 'DATE'

/** The timer kinds the modules keep themselves (no exception rule sets them): their words and where they are kept. */
export const MODULE_TIMERS: readonly string[] = Object.freeze(Object.keys(TIMER_KINDS).filter((kind) => !RULE_KINDS.some((rule) => KINDS[rule].timer === kind)))

/** The words of a module's timer kind (a key of `admin-automation`); one this page does not know yet: the generic words. */
export const moduleTimerKey = (kind: string, known: readonly string[]): string => (known.includes(kind) ? `module.${kind}` : 'module.other')
export const KNOWN_MODULE_TIMERS: readonly string[] = Object.freeze(['PAYMENT_REMINDER'])

export type LiveState = 'connecting' | 'live' | 'offline'

export interface AutomationNotice {
  readonly key: string
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly params?: Readonly<Record<string, string | number>>
}

export interface AutomationViewModel {
  /** alerts.view (the rules are read): else the page says so and reads nothing. */
  readonly access: 'open' | 'refused'
  readonly now: number
  readonly prefix: string
  /** alerts.rules.manage: New rule, the switches, the dialog's changes, the timers. */
  readonly manage: boolean
  readonly live: LiveState
  readonly view: AutomationView
  /** The date rules (GET /alerts/rules?trigger=DATE). */
  readonly rules: PanelRead<RulesList>
  readonly savingRules: readonly string[]
  readonly ruleDialog: RuleDialogState | null
  readonly busy: boolean
  readonly notice: AutomationNotice | null
  /** The module timer kinds (MODULE_TIMERS). */
  readonly moduleTimers: readonly string[]
  /** The keys panel is open. */
  readonly help: boolean
}

/** Why New rule is held (a `why.` key of `admin-automation`), or null. */
export function newHeld(state: { readonly manage: boolean; readonly live: LiveState; readonly rules: PanelRead<RulesList> }): string | null {
  if (!state.manage) return 'why.noManage'
  if (state.live === 'offline') return 'why.offline'
  if (state.rules.status !== 'ready') return 'why.reading'
  if (!state.rules.data.canAdd) return 'why.noManage'
  return null
}
