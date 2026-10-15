/**
 * Google Ads programme 2, G8b (2026-10-15) — the account's own settings: auto-tagging, the account's tracking template
 * and final URL suffix, its name, call reporting and the video brand safety level. ONE customerOperation update
 * (GoogleAdsService.Mutate, Google checks it with validate_only), only the fields asked for in its update mask.
 *
 * Checked 2026-10-15 in Google's v25 reference (curl of developers.google.com/google-ads/api/reference/rpc/v25/…):
 *   CustomerOperation   update + update_mask only ("Only updates are supported for customer").
 *   Customer            auto_tagging_enabled, tracking_url_template, final_url_suffix ("Only mutable in an update
 *                       operation"); descriptive_name ("Optional, non-unique"; no field behaviour = mutable);
 *                       call_reporting_setting (CallReportingSetting: call_reporting_enabled,
 *                       call_conversion_reporting_enabled, call_conversion_action "Only in effect when
 *                       call_conversion_reporting_enabled is set to true"); video_brand_safety_suitability
 *                       (BrandSafetySuitability EXPANDED_INVENTORY | STANDARD_INVENTORY | LIMITED_INVENTORY).
 *                       Not changeable through the API: currency_code, time_zone (Immutable), conversion_tracking_setting
 *                       (every subfield Output only / read-only), contains_eu_political_advertising (Output only: the
 *                       account-level declaration is made in Google Ads), video_customer (third-party partners: not
 *                       offered by Nexus).
 *   A field in the update mask but not in the body is cleared (v25 facts): that is how a template or suffix is taken away.
 * The tracking template and suffix follow Google's URL rules as G3 checks them (change-urls.ts urlItemProblems).
 *
 * Money: none of these raises a bid or a budget (no SPENDS MONEY). Auto-tagging OFF breaks conversion tracking, a
 * tracking change can break the tracking of every click, EXPANDED inventory shows video ads on more content: warnings.
 */
import { changeLines, type GoogleChangeDraft } from './change-draft.js'
import { urlItemProblems } from './change-urls.js'
import type { LiveAdminSettings } from './live-account-admin.js'

export const BRAND_SAFETY = ['EXPANDED_INVENTORY', 'STANDARD_INVENTORY', 'LIMITED_INVENTORY'] as const
export type BrandSafety = typeof BRAND_SAFETY[number]

export interface AccountSettingsRequest {
  autoTagging?: boolean
  /** '' or null takes it away. */
  trackingTemplate?: string | null
  finalUrlSuffix?: string | null
  name?: string
  callReporting?: boolean
  callConversionReporting?: boolean
  /** A conversion action id, or null: Google's default call conversion action. */
  callConversionActionId?: string | null
  videoBrandSafety?: BrandSafety
}

export const SETTING_KEYS = ['autoTagging', 'trackingTemplate', 'finalUrlSuffix', 'name', 'callReporting', 'callConversionReporting', 'callConversionActionId', 'videoBrandSafety'] as const
export type SettingKey = typeof SETTING_KEYS[number]

/** Only the settings the change wrote: before, what they were; after, what they are (null = none). */
export interface AccountSettingsRecord { settings: Partial<Record<SettingKey, string | boolean | null>> }

const MASK: Record<SettingKey, string> = {
  autoTagging: 'auto_tagging_enabled', trackingTemplate: 'tracking_url_template', finalUrlSuffix: 'final_url_suffix', name: 'descriptive_name',
  callReporting: 'call_reporting_setting.call_reporting_enabled', callConversionReporting: 'call_reporting_setting.call_conversion_reporting_enabled',
  callConversionActionId: 'call_reporting_setting.call_conversion_action', videoBrandSafety: 'video_brand_safety_suitability',
}
const WORD: Record<SettingKey, string> = {
  autoTagging: 'Auto-tagging', trackingTemplate: 'Account tracking template', finalUrlSuffix: 'Account final URL suffix', name: 'Account name',
  callReporting: 'Call reporting', callConversionReporting: 'Call conversion reporting', callConversionActionId: 'Call conversion action',
  videoBrandSafety: 'Video brand safety',
}

export const AUTO_TAGGING_OFF = 'Auto-tagging OFF: Google stops adding the click id (gclid) to ad clicks, so Google Ads conversion tracking, '
  + 'imported Google Analytics conversions and a shop\'s Google tag can no longer tie a sale to its click. Conversions drop, and Smart '
  + 'Bidding and Performance Max work on less data. Turn it off only if another tracking replaces it.'
export const TRACKING_CHANGED = 'The account\'s tracking template is used for the clicks of every ad unless a campaign, ad group, keyword or ad '
  + 'sets its own. A wrong template sends clicks to a broken page or loses their tracking; Google re-checks ads, and a change takes '
  + '24 to 48 hours to show in serving.'
export const SUFFIX_CHANGED = 'The account\'s final URL suffix is added to the landing page of every ad unless a lower level sets its own: a wrong '
  + 'one can break landing pages or the shop\'s tracking.'

const value = (s: string | null | undefined): string | null => (s ?? '').trim() || null
const shown = (v: string | boolean | null | undefined): unknown => (v === true ? 'on' : v === false ? 'off' : v ?? '(none)')

/** The live value of one setting, in the record's words. */
function liveValue(key: SettingKey, live: LiveAdminSettings): string | boolean | null {
  switch (key) {
    case 'autoTagging': return live.autoTagging
    case 'trackingTemplate': return live.trackingTemplate
    case 'finalUrlSuffix': return live.finalUrlSuffix
    case 'name': return live.name
    case 'callReporting': return live.callReporting
    case 'callConversionReporting': return live.callConversionReporting
    case 'callConversionActionId': return live.callConversionActionId
    case 'videoBrandSafety': return live.videoBrandSafety
  }
}

/** The request's value of one setting (null = take it away), or undefined when not asked. */
function asked(key: SettingKey, request: AccountSettingsRequest): string | boolean | null | undefined {
  const v = request[key]
  if (v === undefined) return undefined
  if (typeof v === 'boolean') return v
  return key === 'name' ? (v ?? '').trim() : value(v)
}

export function accountSettingsDraft(customer: string, request: AccountSettingsRequest, live: LiveAdminSettings | null): GoogleChangeDraft | { refusal: string } {
  if (!live) return { refusal: 'Google Ads did not answer this account\'s settings. Nothing was changed.' }
  const wanted = SETTING_KEYS.filter((k) => request[k] !== undefined)
  if (!wanted.length) return { refusal: 'Name at least one setting to change (autoTagging, trackingTemplate, finalUrlSuffix, name, callReporting, callConversionReporting, callConversionActionId, videoBrandSafety).' }
  const problems = urlItemProblems({ level: 'campaign', id: 'account', trackingTemplate: request.trackingTemplate, finalUrlSuffix: request.finalUrlSuffix }, 'The account')
  if (request.name !== undefined && !request.name.trim()) problems.push('The account name cannot be empty')
  if (request.name !== undefined && request.name.trim().length > 255) problems.push('The account name has more than 255 characters')
  if (request.callConversionActionId && !/^\d{1,20}$/.test(request.callConversionActionId)) problems.push('The call conversion action is not a Google id (digits only)')
  if (problems.length) return { refusal: `${problems.join('; ')}. Nothing was changed.` }

  const before: AccountSettingsRecord = { settings: {} }
  const after: AccountSettingsRecord = { settings: {} }
  const lines: Array<[string, unknown, unknown]> = []
  const skipped: string[] = []
  const warnings: string[] = []
  const update: Record<string, unknown> = { resourceName: customer }
  const call: Record<string, unknown> = {}
  const mask: string[] = []
  for (const key of wanted) {
    const to = asked(key, request)!
    const from = liveValue(key, live)
    if ((to ?? null) === (from ?? null)) {
      skipped.push(`${WORD[key]} is already ${String(shown(from))}.`)
      continue
    }
    before.settings[key] = from ?? null
    after.settings[key] = to ?? null
    lines.push([WORD[key], shown(from), shown(to)])
    mask.push(MASK[key])
    switch (key) {
      case 'autoTagging': update.autoTaggingEnabled = to; break
      case 'trackingTemplate': if (to !== null) update.trackingUrlTemplate = to; break
      case 'finalUrlSuffix': if (to !== null) update.finalUrlSuffix = to; break
      case 'name': update.descriptiveName = to; break
      case 'callReporting': call.callReportingEnabled = to; break
      case 'callConversionReporting': call.callConversionReportingEnabled = to; break
      case 'callConversionActionId': if (to !== null) call.callConversionAction = `${customer}/conversionActions/${to}`; break
      case 'videoBrandSafety': update.videoBrandSafetySuitability = to; break
    }
  }
  if (!mask.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  if (Object.keys(call).length || mask.some((m) => m.startsWith('call_reporting_setting.'))) update.callReportingSetting = call

  if (after.settings.autoTagging === false) warnings.push(AUTO_TAGGING_OFF)
  if ('trackingTemplate' in after.settings) warnings.push(TRACKING_CHANGED)
  if ('finalUrlSuffix' in after.settings) warnings.push(SUFFIX_CHANGED)
  if (after.settings.callReporting === false) warnings.push('Call reporting OFF: Google stops tracking calls from ads (call details and call conversions stop).')
  const conversionReporting = after.settings.callConversionReporting ?? live.callConversionReporting
  if (after.settings.callConversionActionId && !conversionReporting) warnings.push('The call conversion action counts only while call conversion reporting is on (Google\'s rule); it is off.')
  if (after.settings.videoBrandSafety === 'EXPANDED_INVENTORY') warnings.push('Expanded inventory: video ads can show on more content, including content with strong language or violence (Google\'s description).')
  if (live.manager) warnings.push('This is a manager account: its own settings change, not those of the accounts it manages.')

  const { changes, more } = changeLines(lines)
  return {
    summary: `Change ${lines.length === 1 ? 'one setting' : `${lines.length} settings`} of the Google Ads account: ${lines.map(([w, , to]) => `${w.toLowerCase()} → ${String(to)}`).join('; ')}.`,
    changes,
    totals: { settings: lines.length, ...(more ? { notShown: more } : {}) },
    warnings,
    spendsMoney: [],
    skipped,
    operations: [{ customerOperation: { update, updateMask: mask.join(',') } }],
    stands: { customer, settings: before.settings },
    before,
    after,
  }
}

/** The undo's request: the settings as they were (a value that was none is taken away). */
export function settingsUndoArgs(before: AccountSettingsRecord): Record<string, unknown> | null {
  const keys = Object.keys(before.settings ?? {}) as SettingKey[]
  if (!keys.length) return null
  const args: Record<string, unknown> = {}
  for (const key of keys) {
    const v = before.settings[key]
    if (key === 'name' && !v) return null
    if (key === 'videoBrandSafety' && !(BRAND_SAFETY as readonly unknown[]).includes(v)) return null
    args[key] = key === 'trackingTemplate' || key === 'finalUrlSuffix' ? (v ?? '') : v ?? null
  }
  return args
}

/** What is set now, in the record's shape (undo's "current"). */
export function settingsNow(after: AccountSettingsRecord, live: LiveAdminSettings | null): AccountSettingsRecord | null {
  if (!live) return null
  const settings: AccountSettingsRecord['settings'] = {}
  for (const key of Object.keys(after.settings ?? {}) as SettingKey[]) settings[key] = liveValue(key, live) ?? null
  return { settings }
}
