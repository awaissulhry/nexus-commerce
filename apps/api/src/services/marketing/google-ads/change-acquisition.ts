/**
 * Google Ads customer acquisition (programme 2, G10, 2026-10-16) — the account's new-customer goal and one campaign's use
 * of it. Pure: request + live state → ONE call.
 *
 * Checked 2026-10-16 (curl): in v25 customer acquisition is NOT a Campaign field and NOT a GoogleAdsService.Mutate
 * operation (reference/rpc/v25/MutateOperation has no goal or campaign goal config operation; Campaign has no
 * customer_acquisition_goal_settings). It is two services (docs/conversions/goals/lifecycle-goals; googleapis v25
 * goal_service.proto, campaign_goal_config_service.proto; the v25 discovery document, which writes the paths with a
 * capital letter):
 *   POST /v25/customers/{id}/Goals:mutate                 MutateGoalsRequest {operations[] GoalOperation (create | update +
 *                                                         update_mask; no remove), partial_failure, validate_only}
 *   POST /v25/customers/{id}/CampaignGoalConfigs:mutate   MutateCampaignGoalConfigsRequest {operations[] CampaignGoalConfig
 *                                                         Operation (create | update + update_mask | remove), validate_only}
 *   Goal                  oneof goal_settings: new_customer_acquisition_goal_settings {value_settings
 *                         CustomerLifecycleOptimizationValueSettings: additional_value (double, the account's currency),
 *                         additional_high_lifetime_value}; goal_type OUTPUT_ONLY (the settings say it); "at most one Goal
 *                         per goal type"; value_multiplier "not supported for NEW_CUSTOMER_ACQUISITION".
 *   CampaignGoalConfig    campaign, goal (Immutable); campaign_new_customer_acquisition_settings {target_option
 *                         CustomerLifecycleOptimizationMode: TARGET_ALL ("targets both new and existing customers, but bids
 *                         higher for new customers") | TARGET_SPECIFIC ("targets new customers only"), value_settings_override};
 *                         customers/{c}/campaignGoalConfigs/{campaign}~{goal}. CampaignGoalConfigError
 *                         CAMPAIGN_OVERRIDE_VALUES_SET_FOR_NEW_CUSTOMER_ACQUISITION_TARGET_SPECIFIC_OPTION: no value override
 *                         with TARGET_SPECIFIC; HIGH_LIFETIME_VALUE_PRESENT_BUT_VALUE_ABSENT, …_LESS_THAN_OR_EQUAL_TO_VALUE.
 * Both requests have validate_only: Google checks the change first, like a mutate. Each change is ONE call to ONE of
 * them (G8b's account calls, gateway/google-account-calls.ts): an account goal and a campaign config are never one
 * atomic request, so a request asks for one or the other.
 *
 * What Google does not document: whether a campaign WITHOUT its own config follows the account goal. Nexus says so where
 * it matters (mode OFF removes the campaign's own config) and never claims more.
 *
 * Money: a higher value for new customers, a campaign moved to "bid higher for new customers", a campaign's value
 * override raised, or a campaign let out of "new customers only", can make the account spend more (SPENDS MONEY).
 */
import { changeLines, money, type GoogleChangeDraft } from './change-draft.js'
import type { AcquisitionConfig, AcquisitionGoal } from './live-pmax.js'
import { ACCOUNT_CALL } from './account-client.js'

export type AcquisitionMode = 'BID_HIGHER' | 'ONLY_NEW' | 'OFF'
const TARGET: Record<Exclude<AcquisitionMode, 'OFF'>, string> = { BID_HIGHER: 'TARGET_ALL', ONLY_NEW: 'TARGET_SPECIFIC' }
const MODE_OF: Record<string, AcquisitionMode> = { TARGET_ALL: 'BID_HIGHER', TARGET_SPECIFIC: 'ONLY_NEW' }
const MODE_WORD: Record<AcquisitionMode, string> = { BID_HIGHER: 'bid higher for new customers', ONLY_NEW: 'new customers only', OFF: 'no setting of its own' }

export interface AcquisitionValues { newCustomerValueCents: number; highValueCents?: number | null }
export interface AcquisitionRequest {
  accountGoal?: AcquisitionValues
  campaignId?: string
  mode?: AcquisitionMode
  valueOverride?: AcquisitionValues | null
}
export interface AcquisitionLive {
  goal: AcquisitionGoal | null
  config: AcquisitionConfig | null
  campaign: { campaignId: string; name: string; status: string | null } | null
}

/** What a change wrote (and what undo puts back), by its kind. */
export type AcquisitionRecord =
  | { kind: 'account'; existed: boolean; valueCents: number | null; highValueCents: number | null }
  | { kind: 'campaign'; campaignId: string; mode: AcquisitionMode; valueCents: number | null; highValueCents: number | null }

const VALUE = 'value_settings'
/** A value of the account's currency as Google's double (cents → units). */
const units = (cents: number) => Math.round(cents) / 100
function valueSettings(v: AcquisitionValues): Record<string, number> {
  return { additionalValue: units(v.newCustomerValueCents), ...(v.highValueCents !== undefined && v.highValueCents !== null ? { additionalHighLifetimeValue: units(v.highValueCents) } : {}) }
}
function valueProblem(v: AcquisitionValues | null | undefined, where: string): string | null {
  if (!v) return null
  if (!Number.isInteger(v.newCustomerValueCents) || v.newCustomerValueCents < 0) return `${where}: the value is whole cents of 0 or more`
  if (v.highValueCents !== undefined && v.highValueCents !== null && (!Number.isInteger(v.highValueCents) || v.highValueCents <= v.newCustomerValueCents)) {
    return `${where}: the value for high-value new customers must be higher than the value for new customers (Google's rule)`
  }
  return null
}
const valueText = (valueCents: number | null, high: number | null, currency: string) =>
  (valueCents === null ? '(none)' : `${money(valueCents, currency)} more per new customer${high !== null ? `, ${money(high, currency)} for a high-value one` : ''}`)

export function acquisitionDraft(customer: string, currency: string, request: AcquisitionRequest, live: AcquisitionLive): GoogleChangeDraft | { refusal: string } {
  const asksAccount = !!request.accountGoal
  const asksCampaign = request.campaignId !== undefined || request.mode !== undefined || request.valueOverride !== undefined
  if (asksAccount === asksCampaign) return { refusal: 'Give accountGoal (the account\'s value of a new customer), or campaignId with mode (one campaign\'s setting) — one of them: Google keeps them in two services, so they are two requests.' }

  if (asksAccount) {
    const v = request.accountGoal!
    const p = valueProblem(v, 'accountGoal')
    if (p) return { refusal: p }
    const g = live.goal
    const high = v.highValueCents ?? null
    if (g && g.valueCents === v.newCustomerValueCents && g.highValueCents === high) return { refusal: `Nothing to change: the account already values a new customer at ${valueText(g.valueCents, g.highValueCents, currency)}.` }
    const settings = { newCustomerAcquisitionGoalSettings: { valueSettings: valueSettings(v) } }
    const path = `new_customer_acquisition_goal_settings.${VALUE}`
    const op = g
      ? { update: { resourceName: g.resourceName, ...settings }, updateMask: [`${path}.additional_value`, ...(high !== null || g.highValueCents !== null ? [`${path}.additional_high_lifetime_value`] : [])].join(',') }
      : { create: settings }
    const raise = !g || (g.valueCents ?? 0) < v.newCustomerValueCents || (high ?? 0) > (g.highValueCents ?? 0)
    const { changes } = changeLines([['new-customer value (the account)', g ? valueText(g.valueCents, g.highValueCents, currency) : '(no goal)', valueText(v.newCustomerValueCents, high, currency)]])
    return {
      summary: `Google Ads: ${g ? 'change' : 'make'} the account's new-customer acquisition goal — ${valueText(v.newCustomerValueCents, high, currency)}.`,
      changes,
      totals: { operations: 1 },
      warnings: ['The value counts in campaigns that bid higher for new customers (set-google-customer-acquisition mode BID_HIGHER): their bids follow it.'],
      spendsMoney: raise ? [`Raises the value of a new customer${g ? ` (${valueText(g.valueCents, g.highValueCents, currency)} now)` : ''}: campaigns that bid higher for new customers bid more for them.`] : [],
      skipped: [],
      operations: [{ [ACCOUNT_CALL]: { path: 'Goals:mutate', body: { operations: [op] } } }],
      stands: { goal: g ? { id: g.goalId, value: g.valueCents, high: g.highValueCents } : null },
      before: { kind: 'account', existed: !!g, valueCents: g?.valueCents ?? null, highValueCents: g?.highValueCents ?? null } satisfies AcquisitionRecord,
      after: { kind: 'account', existed: true, valueCents: v.newCustomerValueCents, highValueCents: high } satisfies AcquisitionRecord,
    }
  }

  const c = live.campaign
  if (!request.campaignId || !request.mode) return { refusal: 'Give campaignId and mode (BID_HIGHER, ONLY_NEW or OFF).' }
  if (!c) return { refusal: `Campaign ${request.campaignId} is not in this account (or it is removed).` }
  const g = live.goal
  if (!g && request.mode !== 'OFF') return { refusal: 'The account has no new-customer acquisition goal yet: ask for accountGoal first (its value of a new customer), then the campaign.' }
  if (request.mode === 'ONLY_NEW' && request.valueOverride) return { refusal: 'With ONLY_NEW the campaign bids only for new customers: Google takes no value override with it (CAMPAIGN_OVERRIDE_VALUES_SET_FOR_NEW_CUSTOMER_ACQUISITION_TARGET_SPECIFIC_OPTION).' }
  if (request.mode === 'OFF' && request.valueOverride) return { refusal: 'OFF takes no value override.' }
  const p = valueProblem(request.valueOverride, 'valueOverride')
  if (p) return { refusal: p }
  const now = live.config
  const nowMode: AcquisitionMode = now ? MODE_OF[now.mode ?? 'TARGET_ALL'] ?? 'BID_HIGHER' : 'OFF'
  const keepOverride = request.valueOverride === undefined && request.mode === 'BID_HIGHER' && nowMode === 'BID_HIGHER'
  const wantValue = request.mode === 'BID_HIGHER' ? (request.valueOverride ? request.valueOverride.newCustomerValueCents : keepOverride ? now?.valueCents ?? null : null) : null
  const wantHigh = request.mode === 'BID_HIGHER' ? (request.valueOverride ? request.valueOverride.highValueCents ?? null : keepOverride ? now?.highValueCents ?? null : null) : null
  if (request.mode === nowMode && wantValue === (now?.valueCents ?? null) && wantHigh === (now?.highValueCents ?? null)) {
    return { refusal: `Nothing to change: "${c.name}" already has ${MODE_WORD[nowMode]}${wantValue !== null ? ` (${valueText(wantValue, wantHigh, currency)})` : ''}.` }
  }
  const settings = request.mode === 'OFF' ? null : {
    campaignNewCustomerAcquisitionSettings: {
      targetOption: TARGET[request.mode],
      ...(wantValue !== null ? { valueSettingsOverride: valueSettings({ newCustomerValueCents: wantValue, highValueCents: wantHigh }) } : {}),
    },
  }
  const base = 'campaign_new_customer_acquisition_settings'
  let op: Record<string, unknown>
  if (request.mode === 'OFF') op = { remove: now!.resourceName }
  else if (now) {
    op = {
      update: { resourceName: now.resourceName, ...settings },
      // A path with no value in the body is cleared: the override goes when it is not asked for (or kept).
      updateMask: [`${base}.target_option`, `${base}.value_settings_override.additional_value`, `${base}.value_settings_override.additional_high_lifetime_value`].join(','),
    }
  } else op = { create: { campaign: `${customer}/campaigns/${c.campaignId}`, goal: g!.resourceName, ...settings } }
  if (request.mode === 'OFF' && !now) return { refusal: `Nothing to change: "${c.name}" has no new-customer setting of its own.` }

  const enabled = c.status === 'ENABLED'
  const note = enabled ? '' : ' (the campaign is paused: nothing spends until it is enabled)'
  const spends: string[] = []
  const warnings: string[] = []
  if (request.mode === 'BID_HIGHER' && nowMode !== 'BID_HIGHER') spends.push(`"${c.name}" bids higher for new customers${nowMode === 'ONLY_NEW' ? ' and shows ads to existing customers again' : ''}${note}.`)
  else if (request.mode === 'BID_HIGHER' && (wantValue ?? 0) > (now?.valueCents ?? 0)) spends.push(`Raises "${c.name}"'s value of a new customer to ${money(wantValue, currency)}${note}.`)
  if (request.mode === 'ONLY_NEW') warnings.push(`"${c.name}" bids only for new customers: it may serve less and report fewer conversions.`)
  if (request.mode === 'OFF') {
    if (nowMode === 'ONLY_NEW') spends.push(`"${c.name}" is no longer kept to new customers only${note}.`)
    warnings.push('OFF removes the campaign\'s own new-customer setting. Google\'s guide does not say whether a campaign without one follows the account goal: google-ads-query (FROM campaign_goal_config) shows it after.')
  }
  const { changes } = changeLines([[`"${c.name}" customer acquisition`, `${MODE_WORD[nowMode]}${now?.valueCents !== null && now?.valueCents !== undefined ? ` (${valueText(now.valueCents, now.highValueCents, currency)})` : ''}`, `${MODE_WORD[request.mode]}${wantValue !== null ? ` (${valueText(wantValue, wantHigh, currency)})` : ''}`]])
  return {
    summary: `Google Ads campaign "${c.name}": customer acquisition — ${MODE_WORD[request.mode]}.`,
    changes,
    totals: { operations: 1 },
    warnings,
    spendsMoney: spends,
    skipped: [],
    operations: [{ [ACCOUNT_CALL]: { path: 'CampaignGoalConfigs:mutate', body: { operations: [op] } } }],
    stands: { campaign: { id: c.campaignId, status: c.status }, goal: g ? g.goalId : null, config: now ? { mode: now.mode, value: now.valueCents, high: now.highValueCents } : null },
    before: { kind: 'campaign', campaignId: c.campaignId, mode: nowMode, valueCents: now?.valueCents ?? null, highValueCents: now?.highValueCents ?? null } satisfies AcquisitionRecord,
    after: { kind: 'campaign', campaignId: c.campaignId, mode: request.mode, valueCents: wantValue, highValueCents: wantHigh } satisfies AcquisitionRecord,
  }
}
