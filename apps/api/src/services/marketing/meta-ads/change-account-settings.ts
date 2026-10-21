/**
 * Meta step 40 (2026-10-21) — the chosen ad account's OWN settings as drafts (pure: the request and the live state of
 * live-account-settings.ts in, the draft — or a refusal in words — out):
 *   accountSettingsDraft   set-meta-account-settings: name (AA-040), business info (AA-041), EU DSA default payer and
 *                          beneficiary (AA-042), the system user's notifications (AA-046), end advertiser / media agency /
 *                          partner (AA-047), the agency declaration (AA-048), account-level tracking specs (AA-054);
 *                          the account's default attribution (AS-108) is deprecated by Meta and answered in words.
 *   spendCapDraft          set-meta-spend-cap: set / raise / lower (AA-043), remove (AA-045), reset the amount spent (AA-044).
 *   insightsFeatureDraft   set-meta-insights-features: switch on a restricted breakdown (IN-051) — for good.
 * Meta's rules each follows are in gateway/meta-account-settings-rules.ts (checked there, with the pages and the SDK).
 *
 * A Nexus safety rule (the leader's, step 5's master row family ACC-021; Meta documents no error code for it): NOTHING is
 * changed on an ad account Meta has disabled (account_status 2), put under risk review (7), is closing (100) or closed
 * (101), or disabled as compromised (disable_reason 15) — every draft starts with metaAccountChangeRefusal, so it holds at
 * the preview, at the approval's re-check and at the run (the kit builds the change again from a fresh read).
 */
import { AD_ACCOUNT_STATUS_WORDS } from '../../cx/connectors/meta/discovery.js'
import { META_DISABLE_REASON_STEP } from '../../platform-health/checks/meta.checks.js'
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { money } from './change-settings-common.js'
import { DISABLE_REASON_WORDS } from './live-account.js'
import type { LiveAccountState, LiveInsightsFeature } from './live-account-settings.js'
import { currencyExponent, metaAccountSpendCapMicros, metaCurrencyCode, metaOffset, metaUnitsToMicros, minorOf, minorToMetaStandard, minorToMetaUnits } from './money.js'
import { typedTextOk } from '../../gateway/meta-settings-rules.js'
import { META_NAME_TEXT, META_STRICT_TEXT } from '../../gateway/meta-write-text.js'
import { ACCOUNT_SETTINGS_READ_BACK, META_AGENCY_FLAG_KEYS, META_AGENCY_TEXT_KEYS, META_BUSINESS_INFO_KEYS, META_TRACKING_ACTIONS, type META_INSIGHTS_FEATURES } from '../../gateway/meta-account-settings-rules.js'

// ── the Nexus safety rule: no change of a disabled ad account ─────────────────────────────────────────────────────────

/** account_status values Nexus changes nothing on: disabled, under risk review, closing, closed (reference/ad-account). */
export const META_NO_CHANGE_STATUSES: ReadonlySet<number> = new Set([2, 7, 100, 101])
/** disable_reason 15: "Compromised ad account" — nothing is changed on it either, whatever its status. */
export const META_COMPROMISED_REASON = 15

/** Why no step-40 change may be made on this account now (before any call), or null. */
export function metaAccountChangeRefusal(state: Pick<LiveAccountState, 'adAccountId' | 'status' | 'disableReason'>): string | null {
  const rule = 'Nexus changes nothing on an ad account Meta has disabled, is reviewing for risk, is closing or has closed, or found compromised (a Nexus safety rule: Meta documents no error for it).'
  if (state.status === null) return `Nothing was asked of Meta: Meta did not say ad account ${state.adAccountId}'s status, so Nexus cannot confirm it is not disabled. ${rule}`
  const reason = state.disableReason
  if (!META_NO_CHANGE_STATUSES.has(state.status) && reason !== META_COMPROMISED_REASON) return null
  const words = AD_ACCOUNT_STATUS_WORDS[state.status] ?? `status ${state.status}`
  const why = reason !== null && reason !== 0 ? ` — reason: ${DISABLE_REASON_WORDS[reason] ?? `reason ${reason}`}` : ''
  const step = reason !== null && reason !== 0 ? ` ${META_DISABLE_REASON_STEP[reason] ?? 'Read Account Quality in Meta Business Suite.'}` : ''
  return `Nothing was asked of Meta: ad account ${state.adAccountId} is ${words.toLowerCase()} (Meta's account_status ${state.status}${why}). ${rule}${step}`
}

// ── views: one way a field is seen, as sent, as read back and as undo reads it later ───────────────────────────────────

/** Keys sorted at every depth, so two spellings of one JSON value view the same. */
function sortedJson(v: unknown): string {
  const sort = (x: unknown): unknown => (Array.isArray(x) ? x.map(sort) : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x)
  return JSON.stringify(sort(v))
}

/** ONE view of an account field: '' and missing → null; booleans and numbers as text; objects as sorted JSON. */
export function accountView(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return sortedJson(value)
}

/** What a settings change records, before and after (AgentChange; undo reads them). */
export interface AccountSettingsRecord {
  kind: 'adaccount'
  id: string
  /** field → its value as viewed (accountView; the tracking list as trackingView). */
  fields: Record<string, string | null>
  /** Fields Meta was not asked back: recorded as sent. */
  unread?: string[]
  /** before only: the arguments of set-meta-account-settings that put back what the change replaced (null: none). */
  undo?: Record<string, unknown> | null
  /** before only: what has no way back, in words. */
  noUndo?: string[]
}

// ── tracking specs (AA-054) ────────────────────────────────────────────────────────────────────────────────────────

export type TrackingAction = 'page_engagement' | 'like' | 'link_click'
/** A tracking spec as a person asks it: a conversion of one of the account's own pixels, or an action on the chosen Page. */
export type TrackingSpecAsk = { kind: 'pixel'; pixelId: string } | { kind: 'page'; action: TrackingAction }
interface NormalSpec { action: string; key: 'fb_pixel' | 'page' | 'object'; id: string }

/** A spec as Meta reads it back (or as Nexus writes it) in Nexus's one shape, or null when Nexus does not send that shape. */
export function normalSpec(spec: unknown): NormalSpec | null {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null
  const s = spec as Record<string, unknown>
  const actions = Array.isArray(s['action.type']) ? s['action.type'] : typeof s['action.type'] === 'string' ? [s['action.type']] : null
  const action = actions && actions.length === 1 && typeof actions[0] === 'string' ? actions[0] : null
  const key = action && Object.prototype.hasOwnProperty.call(META_TRACKING_ACTIONS, action) ? META_TRACKING_ACTIONS[action] : null
  if (!key || Object.keys(s).length !== 2) return null
  const raw = Array.isArray(s[key]) ? s[key] as unknown[] : [s[key]]
  const id = raw.length === 1 && (typeof raw[0] === 'string' || (typeof raw[0] === 'number' && Number.isSafeInteger(raw[0]))) ? String(raw[0]) : null
  return id && /^[1-9]\d{0,19}$/.test(id) ? { action, key, id } : null
}
const specJson = (s: NormalSpec) => JSON.stringify({ 'action.type': [s.action], [s.key]: [s.id] })
/** The tracking list as one value: every spec in Nexus's shape (another shape as Meta sent it), sorted. */
export function trackingView(list: unknown[]): string {
  return JSON.stringify(list.map((s) => { const n = normalSpec(s); return n ? specJson(n) : sortedJson(s) }).sort())
}
function specOfAsk(ask: TrackingSpecAsk, pageId: string | null): NormalSpec | { refusal: string } {
  if (ask.kind === 'pixel') return { action: 'offsite_conversion', key: 'fb_pixel', id: ask.pixelId }
  if (!pageId) return { refusal: 'A Page tracking spec counts actions on this business\'s chosen Facebook Page, and none is chosen (Settings › Channels › Meta, or set-meta-connection).' }
  return { action: ask.action, key: META_TRACKING_ACTIONS[ask.action], id: pageId }
}
function askOfSpec(s: NormalSpec): TrackingSpecAsk {
  return s.key === 'fb_pixel' ? { kind: 'pixel', pixelId: s.id } : { kind: 'page', action: s.action as TrackingAction }
}

// ── set-meta-account-settings ─────────────────────────────────────────────────────────────────────────────────────

export type MetaParty = 'NONE' | 'UNFOUND' | 'chosen-page'
type BusinessInfoArg = 'name' | 'street' | 'street2' | 'city' | 'state' | 'zip' | 'countryCode'
export const BUSINESS_INFO_ARGS: Readonly<Record<BusinessInfoArg, typeof META_BUSINESS_INFO_KEYS[number]>> = {
  name: 'business_name', street: 'business_street', street2: 'business_street2', city: 'business_city', state: 'business_state', zip: 'business_zip', countryCode: 'business_country_code',
}
type AgencyTextArg = 'clientName' | 'clientStreet' | 'clientStreet2' | 'clientCity' | 'clientProvince' | 'clientPostalCode' | 'clientCountryCode'
type AgencyFlagArg = 'agencyRepresentingClient' | 'clientBasedInFrance' | 'writtenMandateFromAdvertiser' | 'clientPaysInvoices'
export const AGENCY_TEXT_ARGS: Readonly<Record<AgencyTextArg, typeof META_AGENCY_TEXT_KEYS[number]>> = {
  clientName: 'client_name', clientStreet: 'client_street', clientStreet2: 'client_street2', clientCity: 'client_city', clientProvince: 'client_province',
  clientPostalCode: 'client_postal_code', clientCountryCode: 'client_country_code',
}
export const AGENCY_FLAG_ARGS: Readonly<Record<AgencyFlagArg, typeof META_AGENCY_FLAG_KEYS[number]>> = {
  agencyRepresentingClient: 'agency_representing_client', clientBasedInFrance: 'client_based_in_france', writtenMandateFromAdvertiser: 'has_written_mandate_from_advertiser',
  clientPaysInvoices: 'is_client_paying_invoices',
}

export interface AccountSettingsRequest {
  name?: string
  /** Each key to set; null clears it. */
  businessInfo?: Partial<Record<BusinessInfoArg, string | null>>
  dsa?: { payor: string; beneficiary: string } | { clear: true }
  notifications?: boolean
  endAdvertiser?: MetaParty
  mediaAgency?: MetaParty
  partner?: MetaParty
  agencyDeclaration?: { confirmAgency: true } & Partial<Record<AgencyTextArg, string>> & Partial<Record<AgencyFlagArg, boolean>>
  /** The WHOLE list of account-level tracking specs the account should hold ([] = none). */
  trackingSpecs?: TrackingSpecAsk[]
}

export interface AccountSettingsLive {
  state: LiveAccountState
  /** Read only when the request names the agency declaration. */
  agency?: { declaration: Record<string, string> } | { notRead: string }
  /** Read only when the request names tracking specs. */
  tracking?: unknown[]
  /** The account's own pixels (read when a pixel tracking spec is named). */
  pixels?: Set<string> | null
}

/** Answers in words for what set-meta-account-settings does not send (AS-108, currency, time zone, the spending limit). */
export const ACCOUNT_NOT_SENT = [
  'The account\'s default attribution (attribution_spec): Meta deprecated it on the ad account ("due to iOS 14 changes") — set attribution per ad set (set-meta-ad-set attribution).',
  'Currency and time zone: Nexus does not send them (PLAN: Ads Manager, or a new ad account); Meta\'s v26 Updating table of the ad account lists neither.',
  'The spending limit: set-meta-spend-cap. Insights features: set-meta-insights-features.',
]

const PARTY_FIELDS = { endAdvertiser: 'end_advertiser', mediaAgency: 'media_agency', partner: 'partner' } as const
const PARTY_WORDS = { end_advertiser: 'end advertiser', media_agency: 'media agency', partner: 'partner' } as const
const isWord = (v: string | null) => v === null || v === 'NONE' || v === 'UNFOUND'

/** Which live reads a settings request needs beyond the account itself. */
export function accountReadsNeeded(request: AccountSettingsRequest): { agency: boolean; tracking: boolean; pixels: boolean } {
  // Fix round 1 (A-F4) — the account's pixels whenever tracking specs are named: the specs there now are judged too.
  return { agency: !!request.agencyDeclaration, tracking: request.trackingSpecs !== undefined, pixels: request.trackingSpecs !== undefined }
}

export function accountSettingsDraft(request: AccountSettingsRequest, live: AccountSettingsLive): MetaChangeDraft | { refusal: string } {
  const s = live.state
  const refused = metaAccountChangeRefusal(s)
  if (refused) return { refusal: refused }
  const asked = Object.entries(request).filter(([, v]) => v !== undefined)
  if (!asked.length) return { refusal: `Name at least one setting to change. ${ACCOUNT_NOT_SENT.join(' ')}` }
  const act = `act_${s.adAccountId}`
  const who = `ad account ${s.adAccountId}${s.name ? ` ("${s.name}")` : ''}`
  const params: Record<string, string> = {}
  const expect: Record<string, string> = {}
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = ['Meta has no check for an ad account change (its reference documents validate_only on campaign changes and creates only): the preview is built from the live state, read again before it is sent.']
  const skipped: string[] = []
  const noUndo: string[] = []
  const undo: Record<string, unknown> = {}
  const beforeFields: Record<string, string | null> = {}
  const afterFields: Record<string, string | null> = {}
  const unread: string[] = []
  const field = (key: string, from: string | null, to: string | null) => { beforeFields[key] = from; afterFields[key] = to }

  // ── name (AA-040) ──
  if (request.name !== undefined) {
    if (request.name === s.name) skipped.push(`The account is already named "${s.name}".`)
    else {
      params.name = request.name; expect.name = request.name; lines.push(['Name', s.name, request.name]); field('name', s.name, request.name)
      if (typedTextOk(s.name, META_NAME_TEXT, 200)) undo.name = s.name
      else noUndo.push(s.name ? 'The old name has characters (or a length) Nexus does not send, so undo cannot put it back.' : 'The account had no name to put back.')
      // Fix round 1 (B-6) — Meta reads "the name of the first admin visible to the user" when an account has no name of its
      // own (reference/ad-account Reading, name), and its answer does not say which it is: said plainly before approval.
      warnings.push(`If this ad account had no name of its own, Meta shows the first admin's name in its place ("${s.name ?? ''}" may be a PERSON's name): the undo of this rename would then write that person's name as the account's name — check it before asking for the undo.`)
    }
  }

  // ── business info (AA-041) ──
  if (request.businessInfo) {
    if (!s.businessUse) {
      return { refusal: `Meta treats ${who} as used for personal purposes (or does not say it is for business use): its business info would be a person's own address, which Nexus does not change. A person changes it in Ads Manager › Settings.` }
    }
    const asks = Object.entries(request.businessInfo).filter(([, v]) => v !== undefined) as Array<[BusinessInfoArg, string | null]>
    if (!asks.length) return { refusal: 'Name at least one part of the business info (name, street, street2, city, state, zip, countryCode).' }
    const merged: Record<string, string> = {}
    const back: Partial<Record<BusinessInfoArg, string | null>> = {}
    let moved = false
    for (const [arg, key] of Object.entries(BUSINESS_INFO_ARGS) as Array<[BusinessInfoArg, string]>) {
      const now = s.businessInfo[key] ?? null
      const ask = asks.find(([a]) => a === arg)
      const to = ask ? ask[1] : now
      if (to !== null || now !== null) merged[key] = to ?? ''
      if (ask && to !== now) {
        moved = true
        lines.push([`Business ${arg}`, now, to ?? '(cleared)'])
        expect[key] = to ?? ''
        field(key, now, to)
        if (now === null || typedTextOk(now, META_STRICT_TEXT, 200)) back[arg] = now
        else noUndo.push(`The old business ${arg} has characters (or a length) Nexus does not send, so undo cannot put it back.`)
      }
    }
    if (!moved) skipped.push('The business info is already as asked.')
    else {
      params.business_info = JSON.stringify(merged)
      // Fix round 1 (B-4) — every key sent is read back and judged, the unchanged ones too (a replace that dropped one
      // shows): the kit judges each field Meta sends back, and set-meta-account-settings' sender counts a sent key Meta
      // leaves out as not as asked (one sent empty, to clear it, may be left out).
      for (const [key, value] of Object.entries(merged)) expect[key] = value
      if (Object.keys(back).length) undo.businessInfo = back
      warnings.push('Meta documents business_info only as a dictionary of text, without its keys: Nexus sends the seven business_* keys Meta reads back (all of them, the unchanged ones as they are, so a replace keeps them) — if Meta does not take them, its answer says so and nothing is recorded as done (LIVE-PROBES AA-041).')
    }
  }

  // ── EU DSA default payer and beneficiary (AA-042) ──
  if (request.dsa) {
    const clear = 'clear' in request.dsa
    const to = clear ? { payor: '', beneficiary: '' } : request.dsa as { payor: string; beneficiary: string }
    const now = s.dsa
    if ((clear && now.payor === null && now.beneficiary === null) || (!clear && to.payor === now.payor && to.beneficiary === now.beneficiary)) {
      skipped.push(clear ? 'The account has no EU payer and beneficiary to clear.' : 'The account\'s EU payer and beneficiary are already as asked.')
    } else {
      params.default_dsa_payor = to.payor; params.default_dsa_beneficiary = to.beneficiary
      expect.default_dsa_payor = to.payor; expect.default_dsa_beneficiary = to.beneficiary
      lines.push(['EU payer (default)', now.payor, to.payor || '(cleared)'], ['EU beneficiary (default)', now.beneficiary, to.beneficiary || '(cleared)'])
      field('default_dsa_payor', now.payor, to.payor || null); field('default_dsa_beneficiary', now.beneficiary, to.beneficiary || null)
      if (now.payor === null && now.beneficiary === null) undo.dsa = { clear: true }
      else if (typedTextOk(now.payor, META_STRICT_TEXT, 512) && typedTextOk(now.beneficiary, META_STRICT_TEXT, 512)) undo.dsa = { payor: now.payor, beneficiary: now.beneficiary }
      else noUndo.push('The old EU payer or beneficiary has characters (or a length) Nexus does not send, or only one of them was set: undo cannot put them back.')
      warnings.push(clear
        ? 'Clearing the EU payer and beneficiary: every new or copied ad set that reaches people in the EU then needs its own (set-meta-ad-set dsa), or Meta refuses it.'
        : 'The EU payer and beneficiary are shown to people in the EU on every ad of an EU ad set that has none of its own; Meta fills them in on new and copied EU ad sets.')
    }
  }

  // ── notifications (AA-046) ──
  if (request.notifications !== undefined) {
    if (request.notifications === s.notifications) skipped.push(`Notifications for this account are already ${s.notifications ? 'on' : 'off'} for Nexus's system user.`)
    else {
      params.is_notifications_enabled = String(request.notifications); expect.is_notifications_enabled = String(request.notifications)
      lines.push(['Notifications (Nexus\'s system user)', s.notifications === null ? 'not read' : s.notifications ? 'on' : 'off', request.notifications ? 'on' : 'off'])
      field('is_notifications_enabled', s.notifications === null ? null : String(s.notifications), String(request.notifications))
      if (s.notifications !== null) undo.notifications = s.notifications
      else noUndo.push('Meta did not say whether notifications were on, so undo cannot put them back.')
      warnings.push('Notifications are per person: with Nexus\'s system-user token this switches the SYSTEM USER\'s own notifications for the account — not the Owner\'s or any person\'s (each person sets their own in Ads Manager).')
    }
  }

  // ── end advertiser, media agency, partner (AA-047) ──
  for (const [arg, key] of Object.entries(PARTY_FIELDS) as Array<[keyof typeof PARTY_FIELDS, keyof typeof PARTY_WORDS]>) {
    const ask = request[arg]
    if (ask === undefined) continue
    const word = PARTY_WORDS[key]
    const now = s.parties[key]
    const to = ask === 'chosen-page' ? s.pageId : ask
    if (!to) return { refusal: `The ${word} as the chosen Facebook Page: this business has no Page chosen (Settings › Channels › Meta, or set-meta-connection).` }
    if (to === now) { skipped.push(`The account's ${word} is already ${now}.`); continue }
    // Fix round 1 (B-2) — the end advertiser too: "Once you set end_advertiser to a value other than NONE or UNFOUND you
    // cannot change it" (reference/ad-account, Creating /{business_id}/adaccount); media_agency and partner "cannot be
    // modified any more" (Updating). A set value is never sent a change.
    if (!isWord(now)) {
      return { refusal: `The account's ${word} is set (${now}): Meta says that once it is set to anything but NONE or UNFOUND it cannot be changed any more (reference/ad-account: Creating /{business_id}/adaccount for the end advertiser, Updating for the media agency and partner), so Nexus sends no change of it.` }
    }
    params[key] = to; expect[key] = to
    lines.push([`${word[0].toUpperCase()}${word.slice(1)}`, now ?? 'not set', ask === 'chosen-page' ? `the chosen Facebook Page (${to})` : to])
    field(key, now, to)
    if (!isWord(to)) {
      noUndo.push(`The ${word} becomes a real Page (${to}): FOR GOOD — Meta says that once it is set to anything but NONE or UNFOUND it cannot be modified any more.`)
      warnings.push(`The ${word} cannot be changed again after this (Meta: once set to anything but NONE or UNFOUND "it cannot be modified any more"): this is one-way.`)
    } else if (now !== null) undo[arg] = now as MetaParty
    else noUndo.push(`The account had no ${word} to put back.`)
  }
  if (params.end_advertiser) warnings.push('Meta\'s pages disagree on the end advertiser: the ad-account reference says a Page or app id, the business-asset guide says a business id — Meta\'s answer decides (master AA-047).')

  // ── the agency declaration (AA-048) ──
  if (request.agencyDeclaration) {
    const agency = live.agency
    if (!agency) return { refusal: 'Nexus did not read the agency declaration, so it is not changed.' }
    if ('notRead' in agency) return { refusal: `Nexus could not read the account's agency declaration: ${agency.notRead} Meta takes a declaration only from a Business Manager admin as well; nothing was asked of Meta.` }
    const now = agency.declaration
    const merged: Record<string, string> = { ...now }
    for (const [arg, key] of Object.entries(AGENCY_TEXT_ARGS)) { const v = request.agencyDeclaration[arg as AgencyTextArg]; if (v !== undefined) merged[key] = v }
    for (const [arg, key] of Object.entries(AGENCY_FLAG_ARGS)) { const v = request.agencyDeclaration[arg as AgencyFlagArg]; if (v !== undefined) merged[key] = v ? '1' : '0' }
    const from = accountView(Object.keys(now).length ? now : null)
    const to = accountView(merged)
    if (from === to) skipped.push('The agency declaration is already as asked.')
    else {
      params.agency_client_declaration = JSON.stringify(Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]])))
      expect.agency_client_declaration = to!
      for (const key of [...META_AGENCY_TEXT_KEYS, ...META_AGENCY_FLAG_KEYS]) if ((now[key] ?? null) !== (merged[key] ?? null)) lines.push([`Agency declaration: ${key}`, now[key] ?? null, merged[key] ?? null])
      field('agency_client_declaration', from, to)
      const back = Object.keys(now).length ? backOfDeclaration(now) : null
      if (back) undo.agencyDeclaration = back
      else noUndo.push(Object.keys(now).length ? 'The old agency declaration holds text Nexus does not send, so undo cannot put it back.' : 'The account had no agency declaration: Meta documents no way to take one away.')
      warnings.push('The agency declaration is only for an AGENCY that runs ads for a client: a business advertising for itself never sets it. Meta takes it only from a Business Manager admin; Nexus never sends the client\'s e-mail address.')
    }
  }

  // ── account-level tracking specs (AA-054): their own request on act_<id>/tracking ──
  let tracking: MetaChangeRequest | null = null
  if (request.trackingSpecs !== undefined) {
    const current = live.tracking ?? []
    // Fix round 1 (A-F4) — a spec Nexus could not send back as it is: another shape, a Page that is not the chosen one, a
    // pixel that is not one of the account's own (its undo would name another Page or pixel, or none).
    const foreign = current.filter((spec) => {
      const n = normalSpec(spec)
      return !n || (n.key === 'fb_pixel' ? !live.pixels?.has(n.id) : n.id !== s.pageId)
    })
    if (foreign.length) {
      return { refusal: `The account holds ${plural(foreign.length, 'tracking spec')} Nexus does not send (another action or object than conversions of the account's own pixels or actions on the chosen Page). Meta does not document whether a POST of tracking specs adds to the list or replaces it, so Nexus sends none here (it could drop those, and its undo could not put them back): change them in Ads Manager.` }
    }
    // Fix round 1 (B-3) — Meta: tracking_specs is [required], "to add to the account level", and the edge has no update and
    // no delete (reference/ad-account/tracking): an empty list is never sent until LIVE-PROBES AA-054 settles add vs replace.
    if (!request.trackingSpecs.length) {
      return { refusal: 'Nexus does not send an empty list of tracking specs: Meta documents the tracking edge as specs "to add to the account level", with no way to update or delete them, so whether an empty list removes anything is not known (LIVE-PROBES AA-054). Remove account-level tracking specs in Ads Manager.' }
    }
    const wanted: NormalSpec[] = []
    for (const ask of request.trackingSpecs) {
      const spec = specOfAsk(ask, s.pageId)
      if ('refusal' in spec) return spec
      if (spec.key === 'fb_pixel' && !live.pixels?.has(spec.id)) return { refusal: `Pixel ${spec.id} is not one of the chosen ad account's own pixels (meta-datasets lists them).` }
      if (!wanted.some((w) => specJson(w) === specJson(spec))) wanted.push(spec)
    }
    const fromView = trackingView(current)
    const toList = wanted.map((w) => JSON.parse(specJson(w)) as unknown)
    const toView = trackingView(toList)
    if (fromView === toView) skipped.push('The account\'s tracking specs are already as asked.')
    else {
      const body = JSON.stringify([...wanted].sort((a, b) => specJson(a).localeCompare(specJson(b))).map((w) => JSON.parse(specJson(w))))
      lines.push(['Account tracking specs', current.length ? current.map(specWords).join('; ') : 'none', wanted.length ? wanted.map(specWords).join('; ') : 'none'])
      beforeFields.tracking_specs = fromView
      afterFields.tracking_specs = toView
      // Fix round 1 (B-3) — no undo that would send an empty list: the first specs of an account may stay for good.
      if (current.length) undo.trackingSpecs = current.map((spec) => askOfSpec(normalSpec(spec)!))
      else noUndo.push('The account had no account-level tracking specs: Meta documents no way to remove one (no update, no delete; an empty list is not documented), so the specs this change adds may stay FOR GOOD.')
      warnings.push('Meta documents the tracking edge as specs "to add to the account level" and no way to update or delete them: whether a POST adds to the list or replaces it is not documented (LIVE-PROBES AA-054). Nexus sends the WHOLE list asked and reads back what Meta holds: if Meta adds, the specs left out stay, and undo (which sends the old list again) cannot take the new ones away.')
      tracking = {
        step: 0, label: `Set the account-level tracking specs of ${who} (${plural(wanted.length, 'spec')})`, kind: 'campaign', objectKind: 'adaccount', objectId: act,
        params: { tracking_specs: body }, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: true,
        operation: 'account.tracking', edge: 'tracking', expect: { asked_specs: 'present' },
      }
    }
  }

  if (!Object.keys(params).length && !tracking) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const requests: MetaChangeRequest[] = []
  if (Object.keys(params).length) {
    const readBackFields = [...new Set(['id', ...Object.keys(expect).filter((f) => ACCOUNT_SETTINGS_READ_BACK.has(f)), ...(params.business_info ? META_BUSINESS_INFO_KEYS : [])])]
    requests.push({
      step: 1, label: `Change ${Object.keys(params).map(paramWords).filter(Boolean).join(', ')} of ${who}`, kind: 'campaign', objectKind: 'adaccount', objectId: act, params,
      check: 'none', raisesSpend: false, readBackInPost: true, budget: false, undoable: Object.keys(undo).some((k) => k !== 'trackingSpecs'),
      operation: 'account.settings', expect, readBackFields: readBackFields.join(','),
    })
    for (const f of Object.keys(expect)) if (!ACCOUNT_SETTINGS_READ_BACK.has(f) && f !== 'agency_client_declaration') unread.push(f)
  }
  if (tracking) requests.push({ ...tracking, step: requests.length + 1 })
  if (requests.length === 2) warnings.push('Two requests to the same ad account: Meta takes one change of an object every 30 s, so the tracking specs go about 30 s after the settings.')
  const { changes, more } = changeLines(lines)
  const before: AccountSettingsRecord = { kind: 'adaccount', id: s.adAccountId, fields: beforeFields, undo: Object.keys(undo).length ? undo : null, noUndo }
  const after: AccountSettingsRecord = { kind: 'adaccount', id: s.adAccountId, fields: afterFields, ...(unread.length ? { unread } : {}) }
  return {
    summary: `Meta: ${requests.map((r) => r.label.charAt(0).toLowerCase() + r.label.slice(1)).join('; then ')} (account settings spend nothing).`,
    changes,
    totals: { fields: lines.length, requests: requests.length, ...(skipped.length ? { alreadySo: skipped.length } : {}), ...(more ? { moreLines: more } : {}) },
    warnings: [...warnings, ...(noUndo.length ? [`No undo for: ${noUndo.join(' ')}`] : [])],
    spendsMoney: [],
    skipped,
    requests,
    stands: { account: { ...s, spendCap: undefined, amountSpent: undefined }, agency: live.agency ?? null, tracking: live.tracking ? trackingView(live.tracking) : null, pixels: live.pixels ? [...live.pixels].sort() : null },
    before,
    after,
  }
}

const PARAM_WORDS: Record<string, string> = {
  name: 'the name', business_info: 'the business info', default_dsa_payor: 'the EU payer and beneficiary', default_dsa_beneficiary: '', is_notifications_enabled: 'the system user\'s notifications',
  end_advertiser: 'the end advertiser', media_agency: 'the media agency', partner: 'the partner', agency_client_declaration: 'the agency declaration',
}
const paramWords = (key: string) => PARAM_WORDS[key] ?? key
const specWords = (spec: unknown): string => {
  const n = normalSpec(spec)
  if (!n) return sortedJson(spec)
  return n.key === 'fb_pixel' ? `conversions of pixel ${n.id}` : `${n.action.replace('_', ' ')} on Page ${n.id}`
}

/** The old declaration as set-meta-account-settings arguments, or null when it holds something Nexus does not send. */
function backOfDeclaration(now: Record<string, string>): AccountSettingsRequest['agencyDeclaration'] | null {
  const out: Record<string, unknown> = { confirmAgency: true }
  for (const [key, value] of Object.entries(now)) {
    const text = Object.entries(AGENCY_TEXT_ARGS).find(([, k]) => k === key)?.[0]
    const flag = Object.entries(AGENCY_FLAG_ARGS).find(([, k]) => k === key)?.[0]
    if (text) {
      if (key === 'client_country_code' ? !/^[A-Z]{2}$/.test(value) : !typedTextOk(value, META_STRICT_TEXT, 200)) return null
      out[text] = value
    } else if (flag) {
      if (value !== '0' && value !== '1') return null
      out[flag] = value === '1'
    } else return null
  }
  return out as AccountSettingsRequest['agencyDeclaration']
}

// ── set-meta-spend-cap (AA-043–045) ─────────────────────────────────────────────────────────────────────────────────

export type SpendCapAction = 'set' | 'raise' | 'lower' | 'remove' | 'reset'
export interface SpendCapRequest { action: SpendCapAction; capCents?: number }

/** What a spending-limit change records: the cap as Meta READS it (offset units; 'none' = no cap). */
export interface SpendCapRecord {
  kind: 'spendcap'
  id: string
  action: SpendCapAction
  fields: { spend_cap: string }
  undo?: Record<string, unknown> | null
  noUndo?: string[]
}

/** Meta's spend_cap as read → its view ('none' when there is no cap: 0 or missing). */
export const spendCapView = (value: unknown, currency: string | null): string => (metaAccountSpendCapMicros(value, currency) === null ? 'none' : String(value).trim())
/** A spending limit as Meta READS it that Nexus can read: a whole number of Meta's units, no sign, no leading zero ('0' = none). */
const SPEND_CAP_READ = /^(0|[1-9]\d{0,15})$/

/** Meta's limit of spending-limit changes (rate-limiting.md: spend_cap, spend_cap_action 10 a day, 17/1885172). */
export const SPEND_CAP_CHANGES_PER_DAY = 10
export const SPEND_CAP_DAILY_LIMIT_CODE = '17/1885172'
export const SPEND_CAP_DAILY_LIMIT_WORDS = `Meta allows ${SPEND_CAP_CHANGES_PER_DAY} changes of an ad account's spending limit a day (Meta's error 17, subcode 1885172) and this account has had them today: Meta changed nothing, and Nexus does not try again — ask again tomorrow.`

export function spendCapDraft(request: SpendCapRequest, state: LiveAccountState, nexusCurrency: string | null): MetaChangeDraft | { refusal: string } {
  const refused = metaAccountChangeRefusal(state)
  if (refused) return { refusal: refused }
  const cur = metaCurrencyCode(state.currency)
  if (!cur) return { refusal: 'Meta did not say the ad account\'s currency, so Nexus cannot write its spending limit (the amount would be guessed).' }
  if (nexusCurrency && metaCurrencyCode(nexusCurrency) !== cur) return { refusal: `Nexus has the account in ${nexusCurrency}, Meta now says ${cur}: Nexus changes no amount until its daily read has the account again.` }
  const act = `act_${state.adAccountId}`
  const who = `ad account ${state.adAccountId}${state.name ? ` ("${state.name}")` : ''}`
  // Fix round 1 (A-F1) — the spend gate fails CLOSED: a limit Meta did not send, or sent in a form that is not a whole
  // number of its units ("500.00", "-1", "5e4", 20 digits, a number past 2^53), is never read as "no limit" (a "set" would
  // then be a raise without SPENDS MONEY, and its undo a removal).
  // Last pass — fail closed: if Meta left spend_cap OUT for an account with no limit (instead of "0"), every change refuses
  // here (LIVE-PROBES AA-043's read-only step checks that Meta sends "0").
  if (state.spendCap === null) return { refusal: `Meta did not send the spending limit (spend_cap) of ${who}, so Nexus cannot tell whether this change raises it and changes nothing rather than guess there is none: nothing was asked of Meta. meta-billing view spend shows what Meta sends.` }
  if (!SPEND_CAP_READ.test(state.spendCap) || !Number.isSafeInteger(Number(state.spendCap))) {
    return { refusal: `Nexus cannot read ${who}'s spending limit now (Meta sent "${state.spendCap.slice(0, 40)}", not a whole number of its units), so it cannot tell whether this change raises it: nothing was asked of Meta. Change it in Ads Manager, or ask again later.` }
  }
  const oldMicros = metaAccountSpendCapMicros(state.spendCap, cur)
  const oldCents = minorOf(oldMicros, cur)
  // Fix round 1 (A-F3) — a limit Nexus cannot hold exactly in its minor units (PKR: Nexus counts 0 decimals, Meta reads
  // hundredths; 12345 = 123.45 PKR) would be shown rounded and put back rounded by undo: refused.
  if (oldCents !== null && minorToMetaUnits(oldCents, cur) !== Number(state.spendCap)) {
    return { refusal: `${who}'s spending limit is ${state.spendCap} in Meta's ${metaOffset(cur) === 1 ? 'whole units' : 'hundredths'} of ${cur}, which Nexus (counting ${cur} in ${currencyExponent(cur)} decimal${currencyExponent(cur) === 1 ? '' : 's'}) cannot show or put back exactly: nothing was asked of Meta. Change it in Ads Manager.` }
  }
  const spentCents = minorOf(metaUnitsToMicros(state.amountSpent, cur), cur)
  const exponent = currencyExponent(cur)
  const offsetWords = metaOffset(cur) === 1 ? 'whole units' : 'hundredths'
  const fromWords = oldCents === null ? 'no spending limit' : `${money(oldCents, cur)} (Meta reads ${state.spendCap} in ${offsetWords} of ${cur})`
  const spent = spentCents === null ? 'not read' : money(spentCents, cur)
  const warnings: string[] = [
    'Meta has no check for an ad account change (validate_only is documented on campaign changes and creates only): the preview is built from the live state, read again before it is sent.',
    `Meta allows ${SPEND_CAP_CHANGES_PER_DAY} spending-limit changes a day on an ad account (an undo counts too); past them Meta refuses and Nexus does not try again.`,
    `The account has spent ${spent} against its limit so far (amount_spent). Meta: the limit is "the total amount that this account can spend, after which all campaigns will be paused, based on amount_spent", and "setting a new spend cap only applies to spend AFTER the time at which you set it".`,
  ]
  const spendsMoney: string[] = []
  const noUndo: string[] = []
  let params: Record<string, string>
  let expect: Record<string, string> | undefined
  let line: [string, unknown, unknown]
  let undo: Record<string, unknown> | null = oldCents === null ? { action: 'remove' } : { action: 'set', capCents: oldCents }
  let toView: string
  if (request.action === 'set' || request.action === 'raise' || request.action === 'lower') {
    const cap = request.capCents
    if (cap === undefined) return { refusal: `action ${request.action} names the new limit (capCents, in minor units of ${cur}).` }
    if (cap <= 0) return { refusal: 'A spending limit of 0 means "no limit" to Meta: to remove the limit use action remove (it SPENDS MONEY: the account then spends without a limit).' }
    const standard = minorToMetaStandard(cap, cur)
    const units = minorToMetaUnits(cap, cur)
    if (standard === null || units === null) return { refusal: `${cap} minor units of ${cur} (Nexus counts ${cur} in ${exponent} decimal${exponent === 1 ? '' : 's'}) is not an amount Meta can take as a spending limit: Meta counts ${cur} in ${offsetWords}, so it must be a whole number of them.` }
    if (oldCents === cap) return { refusal: `Nothing to change: ${who}'s spending limit is already ${money(cap, cur)}.` }
    if (request.action === 'raise' && (oldCents === null || cap < oldCents)) return { refusal: oldCents === null ? `${who} has no spending limit to raise: action set gives it one.` : `${money(cap, cur)} is not higher than the limit now (${money(oldCents, cur)}): use action lower or set.` }
    if (request.action === 'lower' && (oldCents === null || cap > oldCents)) return { refusal: oldCents === null ? `${who} has no spending limit to lower: action set gives it one (a new limit can only stop spending earlier).` : `${money(cap, cur)} is not lower than the limit now (${money(oldCents, cur)}): use action raise or set.` }
    params = { spend_cap: standard }
    expect = { spend_cap: String(units), currency: cur }
    toView = String(units)
    line = ['Spending limit', fromWords, `"${standard}" ${cur} — Nexus counted ${cap} minor units in ${exponent} decimal${exponent === 1 ? '' : 's'} (${money(cap, cur)}); Meta takes the limit in the currency's standard units`]
    if (oldCents !== null && cap > oldCents) spendsMoney.push(`The spending limit goes up from ${money(oldCents, cur)} to ${money(cap, cur)}: the account can spend ${money(cap - oldCents, cur)} more before Meta pauses its campaigns.`)
    if (spentCents !== null && cap <= spentCents) warnings.push(`The new limit (${money(cap, cur)}) is not above what the account has spent against it (${spent}): Meta pauses every campaign of the account when amount_spent reaches the limit — so its ads may stop at once — or refuses it; Meta's answer decides (action reset puts the amount spent back to 0).`)
  } else if (request.action === 'remove') {
    if (oldCents === null) return { refusal: `Nothing to change: ${who} has no spending limit.` }
    params = { spend_cap_action: 'delete' }
    expect = { spend_cap: '0', currency: cur }
    toView = 'none'
    line = ['Spending limit', fromWords, 'none (spend_cap_action=delete)']
    spendsMoney.push(`Removing the spending limit (${money(oldCents, cur)} now) lets the account spend without any limit until one is set again.`)
  } else {
    params = { spend_cap_action: 'reset' }
    toView = spendCapView(state.spendCap, cur)
    line = ['Amount spent against the limit', spent, `${money(0, cur)} (spend_cap_action=reset)`]
    if (spentCents === 0) return { refusal: `Nothing to change: ${who} has spent nothing against its limit (amount_spent is 0).` }
    if (oldCents !== null) spendsMoney.push(`Resetting the amount spent (${spent}) to 0 lets the account spend its whole limit (${money(oldCents, cur)}) again before Meta pauses its campaigns.`)
    else warnings.push(`${who} has no spending limit: a reset only puts the amount spent back to 0 (it lets nothing spend more now).`)
    undo = null
    noUndo.push('A reset of the amount spent has NO undo: Meta has no way to put the old amount spent back.')
  }
  const label = request.action === 'reset'
    ? `Reset the amount spent of ${who} to 0`
    : request.action === 'remove' ? `Remove the spending limit of ${who}` : `Set the spending limit of ${who} to ${money(request.capCents!, cur)}`
  const req: MetaChangeRequest = {
    step: 1, label, kind: 'campaign', objectKind: 'adaccount', objectId: act, params,
    check: 'none', raisesSpend: spendsMoney.length > 0, readBackInPost: true, budget: false, undoable: undo !== null,
    // Fix round 1 (A-F6) — the currency read back with the limit and judged: a limit is never recorded in another currency.
    operation: 'account.spendCap', readBackFields: 'id,spend_cap,amount_spent,currency', expect: expect ?? { currency: cur },
    // A reset judges no field (the amount spent moves as the account delivers): its sentence says what Meta reads now.
    ...(request.action === 'reset' ? { doneSentence: (result: { node: Record<string, unknown> | null }) => `${label}: Meta made it; the amount spent now reads ${amountWords(result.node?.amount_spent, cur)}.` } : {}),
  }
  const before: SpendCapRecord = { kind: 'spendcap', id: state.adAccountId, action: request.action, fields: { spend_cap: spendCapView(state.spendCap, cur) }, undo, noUndo }
  const after: SpendCapRecord = { kind: 'spendcap', id: state.adAccountId, action: request.action, fields: { spend_cap: toView } }
  return {
    summary: `Meta: ${label.charAt(0).toLowerCase()}${label.slice(1)}${spendsMoney.length ? ' — SPENDS MONEY' : ''}.`,
    changes: changeLines([line]).changes,
    totals: { requests: 1 },
    warnings: [...warnings, ...(noUndo.length ? [`No undo: ${noUndo.join(' ')}`] : [])],
    spendsMoney,
    skipped: [],
    requests: [req],
    // amount_spent moves while the account delivers: it is shown, never stood on (the change would never run otherwise).
    stands: { adAccountId: state.adAccountId, status: state.status, disableReason: state.disableReason, currency: cur, spendCap: state.spendCap },
    before,
    after,
  }
}

/** Meta's amount_spent as read back, in words ("0.00 EUR"), or "(not sent back)". */
function amountWords(value: unknown, currency: string): string {
  const cents = minorOf(metaUnitsToMicros(value, currency), currency)
  return cents === null ? '(not sent back)' : money(cents, currency)
}

// ── set-meta-insights-features (IN-051) ───────────────────────────────────────────────────────────────────────────

export type MetaInsightsFeature = typeof META_INSIGHTS_FEATURES[number]
const FEATURE_UNLOCKS: Readonly<Record<MetaInsightsFeature, string>> = {
  comscore: 'the comscore_market breakdown', impression_device: 'the impression_device breakdown',
  time_of_day_viewer_tz: 'hourly numbers in the viewer\'s time zone (hourly_stats_aggregated_by_audience_time_zone)', frequency_value: 'the frequency_value breakdown',
}

export function insightsFeatureDraft(feature: MetaInsightsFeature, state: LiveAccountState, live: LiveInsightsFeature): MetaChangeDraft | { refusal: string } {
  const refused = metaAccountChangeRefusal(state)
  if (refused) return { refusal: refused }
  const who = `ad account ${state.adAccountId}${state.name ? ` ("${state.name}")` : ''}`
  if (live.enabled === true) return { refusal: `Nothing to change: ${feature} is already switched on for ${who}${live.dataFrom ? ` (data from ${live.dataFrom})` : ''}.` }
  if (live.offered === false) return { refusal: `Meta does not list ${feature} among the insights features ${who} can switch on (insights/feature-settings/list-features), so Nexus does not ask for it.` }
  const label = `Switch on the insights feature ${feature} for ${who} — FOR GOOD`
  const req: MetaChangeRequest = {
    step: 1, label, kind: 'campaign', objectKind: 'adaccount', objectId: `act_${state.adAccountId}`, params: { feature_name: feature },
    check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, operation: 'account.insightsFeature', edge: 'insights/feature-settings',
  }
  return {
    summary: `Meta: ${label.charAt(0).toLowerCase()}${label.slice(1)} (it unlocks ${FEATURE_UNLOCKS[feature]}; it spends nothing).`,
    changes: changeLines([[`Insights feature ${feature}`, live.enabled === false ? 'off' : 'not read (Meta did not list the switched-on features)', 'on — for good']]).changes,
    totals: { requests: 1 },
    warnings: [
      `This CANNOT BE UNDONE: Meta has no API to switch an insights feature off again ("there is no API to disable features", insights/breakdowns), and Ads Manager documents no switch either. ${feature} unlocks ${FEATURE_UNLOCKS[feature]}.`,
      'Meta: the data comes about 24 hours after it is switched on, going forward only (dataFrom in meta-ad-account view insights-features).',
      'Meta\'s page does not name the permission it needs (Meta\'s 2026 notes say account administrators): if Meta refuses, its answer says why.',
      'Meta has no check for this change (validate_only is documented on campaign changes and creates only).',
    ],
    spendsMoney: [],
    skipped: [],
    requests: [req],
    stands: { adAccountId: state.adAccountId, status: state.status, disableReason: state.disableReason, feature, enabled: live.enabled, offered: live.offered },
    before: { kind: 'insightsfeature', id: state.adAccountId, feature, enabled: live.enabled },
    after: { kind: 'insightsfeature', id: state.adAccountId, feature, enabled: true },
  }
}
