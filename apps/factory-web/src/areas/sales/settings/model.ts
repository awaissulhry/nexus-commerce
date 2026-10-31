import { isApiError, issuePath } from '../../../lib/api/errors'
import { problemKey } from '../../quality/_shared/model'
import type { FreightPayer, PolicyAnswer, PolicyBody, QuoteRulesBody, SalesSettings, Series } from './api'

/**
 * The rules of Sales › Settings (SCR-235) without a screen: who may read and change what, the scope (this company or the
 * whole group), the drafts of the quote rules, the quote defaults and the return policy and what each sends (the quote
 * rules and defaults are ONE row: a save sends both cards' values), the rule in plain words, the API's refusals by place.
 * Pure: no React, no API client. Words are message keys of `sales-settings` (`quality:` for the shared ones).
 */

export const SETTINGS_PERMISSIONS = {
  quotesView: 'quotes.view',
  returnsView: 'sales.returns.view',
  manage: 'sales.settings.manage',
  numberingView: 'numbering.view',
  reasonsView: 'reasons.view',
  margin: 'money.margin',
  price: 'money.price',
} as const

export type SettingsAbility = keyof typeof SETTINGS_PERMISSIONS
export type SettingsCan = Readonly<Record<SettingsAbility, boolean>>

export function settingsCan(permissions: readonly string[]): SettingsCan {
  const held = new Set(permissions)
  return Object.fromEntries(Object.entries(SETTINGS_PERMISSIONS).map(([name, permission]) => [name, held.has(permission)])) as unknown as SettingsCan
}

/** Whose settings the page shows: this company's own, or the group-wide ones (every company that has none of its own). */
export type Scope = 'company' | 'group'

export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

// ---- the quote rules and defaults (one row) -----------------------------------------------------------------------------------

export interface QuoteDraft {
  readonly marginFloorPct: string
  readonly discountLimitPct: string
  readonly validityDays: string
  readonly depositPct: string
}

export function quoteDraftOf(settings: SalesSettings, scope: Scope): QuoteDraft {
  const row = scope === 'company' ? settings.company : settings.tenant
  const source = row ?? settings.inForce
  return {
    marginFloorPct: source.marginFloorPct ?? '',
    discountLimitPct: source.discountLimitPct,
    validityDays: String(source.defaultValidityDays),
    depositPct: source.defaultDepositPct ?? '',
  }
}

const PCT = /^\d{1,3}([.,]\d{1,2})?$/
const pctValue = (text: string): number => Number(text.trim().replace(',', '.'))

/** What stops a save, by field (keys). */
export function quoteProblems(draft: QuoteDraft, margin: boolean): { field: keyof QuoteDraft; key: string }[] {
  const out: { field: keyof QuoteDraft; key: string }[] = []
  if (margin && (!PCT.test(draft.marginFloorPct.trim()) || pctValue(draft.marginFloorPct) > 100)) out.push({ field: 'marginFloorPct', key: 'problem.pct' })
  if (!PCT.test(draft.discountLimitPct.trim()) || pctValue(draft.discountLimitPct) > 100) out.push({ field: 'discountLimitPct', key: 'problem.pct' })
  if (!/^\d{1,3}$/.test(draft.validityDays.trim()) || Number(draft.validityDays) < 1 || Number(draft.validityDays) > 365) out.push({ field: 'validityDays', key: 'problem.validity' })
  if (draft.depositPct.trim() !== '' && (!PCT.test(draft.depositPct.trim()) || pctValue(draft.depositPct) <= 0 || pctValue(draft.depositPct) > 100)) out.push({ field: 'depositPct', key: 'problem.deposit' })
  return out
}

/** The body of a save: both cards' values (one row), at its version; the margin floor only with the margin grain. */
export function quoteBody(draft: QuoteDraft, settings: SalesSettings, scope: Scope, companyId: string): QuoteRulesBody {
  const row = scope === 'company' ? settings.company : settings.tenant
  const pct = (text: string) => text.trim().replace(',', '.')
  return {
    ...(scope === 'company' ? { companyId } : {}),
    marginFloorPct: pct(draft.marginFloorPct),
    discountLimitPct: pct(draft.discountLimitPct),
    defaultValidityDays: Number(draft.validityDays.trim()),
    defaultDepositPct: draft.depositPct.trim() === '' ? null : pct(draft.depositPct),
    ...(row ? { version: row.version } : {}),
  }
}

/** The approval rule in plain words, before it is saved (design: "A quote needs approval when margin is under 20 % OR discount is over 15 %"). */
export function ruleSentence(draft: Pick<QuoteDraft, 'marginFloorPct' | 'discountLimitPct'>, margin: boolean): Words {
  const discount = draft.discountLimitPct.trim() || '—'
  if (!margin) return { key: 'rule.sentenceNoMargin', params: { discount } }
  return { key: 'rule.sentence', params: { margin: draft.marginFloorPct.trim() || '—', discount } }
}

/** Where the rules in force come from, in words. */
export const sourceWords = (settings: SalesSettings, scope: Scope): Words =>
  scope === 'group' ? { key: settings.tenant ? 'source.groupOwn' : 'source.groupDefault' } : settings.company ? { key: 'source.companyOwn' } : { key: settings.tenant ? 'source.companyFollows' : 'source.companyDefault' }

// ---- the return policy ---------------------------------------------------------------------------------------------------------

export interface PolicyDraft {
  readonly windowDays: string
  readonly goodsDueDays: string
  readonly freightPaidBy: FreightPayer | ''
  readonly restockingFeePct: string
  readonly conditions: string
}

export function policyDraftOf(policy: PolicyAnswer, scope: Scope): PolicyDraft {
  const row = scope === 'company' ? policy.company : policy.tenant
  const source = row ?? policy.inForce
  return {
    windowDays: source.windowDays === null ? '' : String(source.windowDays),
    goodsDueDays: source.goodsDueDays === null ? '' : String(source.goodsDueDays),
    freightPaidBy: source.freightPaidBy ?? '',
    restockingFeePct: source.restockingFeePct ?? '',
    conditions: source.conditions ?? '',
  }
}

const DAYS = /^\d{1,3}$/

export function policyProblems(draft: PolicyDraft): { field: keyof PolicyDraft; key: string }[] {
  const out: { field: keyof PolicyDraft; key: string }[] = []
  if (draft.windowDays.trim() !== '' && (!DAYS.test(draft.windowDays.trim()) || Number(draft.windowDays) < 1 || Number(draft.windowDays) > 365)) out.push({ field: 'windowDays', key: 'problem.days' })
  if (draft.goodsDueDays.trim() !== '' && (!DAYS.test(draft.goodsDueDays.trim()) || Number(draft.goodsDueDays) < 1 || Number(draft.goodsDueDays) > 365)) out.push({ field: 'goodsDueDays', key: 'problem.days' })
  if (draft.restockingFeePct.trim() !== '' && (!PCT.test(draft.restockingFeePct.trim()) || pctValue(draft.restockingFeePct) > 100)) out.push({ field: 'restockingFeePct', key: 'problem.pct' })
  if (draft.conditions.length > 2000) out.push({ field: 'conditions', key: 'problem.long' })
  return out
}

export function policyBody(draft: PolicyDraft, policy: PolicyAnswer, scope: Scope, companyId: string): PolicyBody {
  const row = scope === 'company' ? policy.company : policy.tenant
  const days = (text: string) => (text.trim() === '' ? null : Number(text.trim()))
  return {
    ...(scope === 'company' ? { companyId } : {}),
    windowDays: days(draft.windowDays),
    goodsDueDays: days(draft.goodsDueDays),
    freightPaidBy: draft.freightPaidBy || null,
    restockingFeePct: draft.restockingFeePct.trim() === '' ? null : draft.restockingFeePct.trim().replace(',', '.'),
    conditions: draft.conditions.trim() === '' ? null : draft.conditions.trim(),
    ...(row ? { version: row.version } : {}),
  }
}

// ---- numbering --------------------------------------------------------------------------------------------------------------------

/** The series the sales documents take, in the design's order (quote, order, RMA, repair). */
export const SALES_SERIES = ['QUOTE', 'SALES_ORDER', 'RETURN', 'REPAIR'] as const

export function salesSeries(series: readonly Series[]): { kind: (typeof SALES_SERIES)[number]; series: Series | null }[] {
  return SALES_SERIES.map((kind) => ({ kind, series: series.filter((entry) => entry.kind === kind && entry.status === 'ACTIVE').sort((a, b) => (b.year ?? 0) - (a.year ?? 0))[0] ?? null }))
}

// ---- refusals --------------------------------------------------------------------------------------------------------------------

export function refusalOf(error: unknown): Words {
  if (!isApiError(error)) return { key: `quality:${problemKey(error)}` }
  if (error.kind === 'conflict') return { key: 'refusal.stale' }
  if (error.kind === 'forbidden') return { key: 'refusal.forbidden' }
  if (error.kind === 'invalid') {
    if (error.issues.some((entry) => /companyId$/.test(issuePath(entry)))) return { key: 'refusal.followsGroup' }
    return { key: 'refusal.invalid' }
  }
  return { key: `quality:${problemKey(error)}` }
}

/** Live events that change what this page shows. */
export const LIVE_TYPES = ['sales_settings.changed', 'return_policy.changed'] as const
