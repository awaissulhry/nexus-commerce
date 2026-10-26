/**
 * Meta step 32 — the dataset, custom conversion and event source group changes as drafts (pure: built from a request and
 * the live facts the tool read; no call). Master rows BM-057, SG-006–SG-013, SG-018, SG-019, SG-041, SG-090–SG-094,
 * SG-098–SG-100, SG-102–SG-104 (SG-014, SG-021, SG-022, SG-024 — partner, server-event and people access — are step 41's:
 * set-meta-user-access / set-meta-partner-access asset `pixel`, change-access.ts). Meta's facts behind each are in gateway/meta-signals-rules.ts.
 *
 * What can make the account spend more is giving ad sets their dataset BACK: connecting it to the chosen ad account, or
 * its data use back to ads, lets the ad sets that optimise on it (or on a custom conversion of it) deliver again — SPENDS
 * MONEY, said like a switch-on. Disconnecting a dataset, data use "analytics only" and deleting a custom conversion take
 * signal AWAY: warned in words (delivery). A custom conversion's default value is never changed after creation here (its
 * read-back unit is not documented: LIVE-PROBE SG-090).
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import type { MetaSignalsEdge } from '../../gateway/meta.js'
import { currencyExponent } from './money.js'
import { money } from './change-settings-common.js'
import type { AdSetUsing, ConversionRow, PixelSettings } from './live-signals.js'
import {
  AUTOMATIC_MATCHING_FIELDS, conversionRuleProblem, MAX_CUSTOM_CONVERSIONS, type MetaSignalsKind,
} from '../../gateway/meta-signals-rules.js'

// ── what Meta cannot do (the proof is in the code comments; the tools say these sentences) ───────────────────────────

/**
 * RECHECK-C3 SG-098…SG-104 (2026-10-21): v26 ads-pixel/event_rules.md and ads-pixel/extractors.md say "You can't perform
 * this operation" for Creating, Updating and Deleting; Meta's SDK CalibratorExistingRule and SignalsIWLExtractor have only
 * api_get, and AdsPixel has no event_rules or extractors edge; the Ads CLI has no command. Only Meta's own Ads MCP server
 * (ads_pixel_event_create / _update / _delete, ads_pixel_parameter_create / _update / _delete) does it, on Meta's side.
 */
export const EVENT_SETUP_CANNOT = 'Meta cannot change this by API: its public Marketing API reads event rules and parameter extractors (meta-datasets view event-setup) but has no create, change or delete for them (v26 reference ads-pixel/event_rules and ads-pixel/extractors: "You can\'t perform this operation"; Meta\'s SDK has no write either). A person does it in Events Manager › the dataset › Settings › Event setup tool (or Meta\'s own Ads MCP server does it on Meta\'s side).'
/**
 * The sentence set-meta-dataset says (lane C3 decision: no tool or argument that only refuses). Proof: RECHECK-C3 SG-041 —
 * ads-pixel/domain_control_rule.md has Creating and Deleting empty and Updating "can't perform"; SDK
 * AdsPixelDomainControlRule is a plain read object, AdsPixel has no such edge and its update takes no domain list — and
 * SG-098…SG-104 above. Nexus reads event rules and parameter extractors (step 11, meta-datasets view event-setup) but not
 * traffic permissions or domain-control rules yet (only an event Meta rejected by one: view diagnostics check event-log).
 */
export const SETUP_CANNOT = 'Meta cannot change event rules, parameter extractors, domain-control rules or traffic permissions by API (v26 reference ads-pixel/event_rules, extractors, domain_control_rule: "can\'t perform"; Meta\'s SDK has no write either): a person does it in Events Manager › the dataset › Settings (Event setup tool, Traffic permissions). meta-datasets view event-setup reads the event rules and parameter extractors; Nexus does not read traffic permissions yet (view diagnostics check event-log shows an event Meta rejected by them).'
/** Lane C3 decision: who else may use a dataset is not a step 32 change. */
export const ACCESS_ELSEWHERE = 'Partner portfolios, the businesses allowed to send a dataset\'s server events and people\'s tasks on it are set in Meta\'s Business settings › Data sources › Datasets (Nexus\'s partner-access step, 41, is where they will be): not here.'
/** SG-017 — a pixel has no delete (ads-pixel.md "Deleting" is empty; no delete edge). */
export const DATASET_NO_DELETE = 'A dataset (pixel) cannot be deleted through Meta\'s API (its reference has no delete): once made it stays; a person can only stop using it or remove its ad accounts.'

// ── units: a custom conversion's default value ───────────────────────────────────────────────────────────────────────

/**
 * Minor units of the account currency → Meta's `default_conversion_value` (a float in the currency's units, written
 * plainly: 1250 EUR cents → "12.5", 1200 → "12", 0 → "0"; JPY 500 → "500"). The gateway takes exactly this spelling.
 */
export function conversionValueText(cents: number, currency: string | null): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error('a default value is a whole, non-negative number of minor units')
  const exponent = currencyExponent(currency)
  if (!exponent) return String(cents)
  const base = 10 ** exponent
  const whole = Math.floor(cents / base)
  const fraction = String(cents % base).padStart(exponent, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

// ── shared ───────────────────────────────────────────────────────────────────────────────────────────────────────────

type Draft = MetaChangeDraft | { refusal: string }

/**
 * One request of a step 32 change. Its object is named by `objectKind` (what the gateway confirms: step 19's `adaccount`,
 * step 28's `page`, else its own kinds — signals-rule.ts) and its own `operation`; it leaves MetaChangeRequest.kind (a
 * status change's) out.
 */
function request(step: number, label: string, objectKind: MetaSignalsKind | 'adaccount' | 'page', objectId: string, params: Record<string, string>, extra: Partial<MetaChangeRequest> & { operation: string }): MetaChangeRequest {
  return { step, label, objectKind, objectId, params, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, ...extra }
}
const edgeOf = (edge: MetaSignalsEdge) => ({ edge })

/** The order Meta lists the fields in (ads-pixel.md), so one set has one spelling. */
const inOrder = <T extends string>(values: readonly string[], order: readonly T[]): T[] => order.filter((v) => values.includes(v))
export const jsonList = (values: readonly string[]) => JSON.stringify([...values])
const sortedIds = (ids: readonly string[]) => [...new Set(ids)].sort()
const listWords = (values: readonly string[] | null) => (values === null ? 'unknown' : values.length ? values.join(', ') : 'none')
/**
 * Giving ad sets their dataset back (connecting it to the chosen ad account, or its data use back to ads) lets the ad sets
 * that optimise on it deliver again: SPENDS MONEY, said like a switch-on. "Nothing spends yet" only when every one of them
 * is off by its own or its campaign's configured status (review A2); a list Nexus could not read whole (the first 500 ad
 * sets, the first 200 custom conversions) is never taken for "none": SPENDS MONEY all the same (review A3).
 */
function signalBackSpends(what: string, adSetsUsing: { adSets: AdSetUsing[]; more: boolean } | undefined): string[] {
  const adSets = adSetsUsing?.adSets ?? []
  const more = adSetsUsing?.more ?? false
  if (!adSets.length) {
    return more ? [`${what} may let ad sets that optimise on it deliver on its events again: Nexus read only the first 500 ad sets (and 200 custom conversions) of the account and found none, but ones beyond them may be on.`] : []
  }
  const on = adSets.filter((a) => a.on)
  const now = on.length ? `${plural(on.length, 'is', 'are')} on now, so the account can spend more from now` : more ? 'none of those Nexus read is on, but Nexus read only the first 500 ad sets: ones beyond them may be' : 'nothing spends yet: none of them is on (by its own or its campaign\'s status)'
  return [`${what} lets ${plural(adSets.length, 'ad set')} that optimise on it (or on a custom conversion of it) deliver on its events again: ${now} — ${adSetWords(adSets, more)}.`]
}
const statusWords = (a: AdSetUsing) => (a.on ? 'on' : `off: ${[a.status && a.status !== 'ACTIVE' ? `ad set ${a.status}` : null, a.campaignStatus && a.campaignStatus !== 'ACTIVE' ? `campaign ${a.campaignStatus}` : null].filter(Boolean).join(', ') || 'paused'}`)
const adSetWords = (adSets: AdSetUsing[], more: boolean) => `${adSets.slice(0, 10).map((a) => `"${a.name ?? 'no name'}" (${a.id}, ${statusWords(a)})`).join('; ')}${adSets.length > 10 ? `; and ${adSets.length - 10} more` : ''}${more ? ' (Nexus read only the first 500 ad sets of the account)' : ''}`

/** One way a signals field is VIEWED (what a change wrote, read back, and what undo reads compare as the same string). */
export function signalView(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (Array.isArray(value)) return JSON.stringify(value.map((v) => (v && typeof v === 'object' ? String((v as { id?: unknown }).id ?? '') : String(v))).sort())
  if (typeof value === 'string' && value.startsWith('[')) { try { return signalView(JSON.parse(value)) } catch { return value } }
  return String(value)
}

/** What a step 32 change records (AgentChange before / after). */
export interface SignalsRecord {
  /** pixel: a dataset's settings · group: an event source group · access: who may use a dataset · conversion · dataset (created). */
  part: 'pixel' | 'group' | 'access' | 'conversion' | 'dataset'
  id: string
  /** field → its value as viewed (signalView). */
  fields: Record<string, string | null>
  /** before only: the arguments of the same tool (or its undo tool) that put back what the change replaced; null: none. */
  undo?: { tool: string; args: Record<string, unknown> } | null
  noUndo?: string[]
  /** A create: Nexus made this object (remove-meta-signal-items deletes only these custom conversions). */
  created?: boolean
  customConversionId?: string
}

// ── create-meta-dataset (SG-006 … SG-009) ────────────────────────────────────────────────────────────────────────────

export type DatasetLevel = 'adAccount' | 'business' | 'page' | 'instagram'
export interface DatasetCreateRequest { level: DatasetLevel; name: string }
export interface DatasetCreateFacts {
  adAccountId: string
  /** adAccount: the pixels already on the chosen ad account. */
  existing?: string[]
  /** business: the chosen portfolio (checked); page / instagram: the chosen Page / Instagram account. */
  objectId?: string
}

export function datasetCreateDraft(req: DatasetCreateRequest, facts: DatasetCreateFacts): Draft {
  const warnings: string[] = [DATASET_NO_DELETE]
  let r: MetaChangeRequest
  let where: string
  if (req.level === 'adAccount') {
    const existing = facts.existing ?? []
    if (existing.length) {
      // Ids only: one of them may also be another Nexus business's (step 11 names such a pixel by its id alone).
      return { refusal: `The chosen ad account already has ${plural(existing.length, 'pixel')} (${existing.slice(0, 5).join(', ')}): Meta makes one pixel per ad account (error 6200 "A pixel already exists for this account"; the shop platform's Meta app may have made it). To make another, ask with level business (in the business portfolio, Meta's SDK route), then connect it with set-meta-dataset-access.` }
    }
    where = `ad account ${facts.adAccountId}`
    r = request(1, `Create the dataset (pixel) "${req.name}" on ${where}`, 'adaccount', `act_${facts.adAccountId}`, { name: req.name },
      { operation: 'dataset.create', ...edgeOf('adspixels'), expect: { name: req.name }, readBackFields: 'id,name' })
  } else if (req.level === 'business') {
    where = `the business portfolio ${facts.objectId}`
    warnings.push('Meta documents this create only in its SDK (business adspixels): Meta\'s answer decides. A business admin must have accepted Meta\'s Business Tools terms first (a person does it in Events Manager); the new dataset is on no ad account until set-meta-dataset-access connects it.')
    r = request(1, `Create the dataset (pixel) "${req.name}" in ${where}`, 'datasetportfolio', facts.objectId!, { name: req.name },
      { operation: 'dataset.createInBusiness', ...edgeOf('adspixels'), expect: { name: req.name }, readBackFields: 'id,name' })
  } else {
    const page = req.level === 'page'
    where = page ? `the Facebook Page ${facts.objectId}` : `the Instagram account ${facts.objectId}`
    warnings.push(`A dataset for the ${page ? 'Page\'s Messenger' : 'Instagram account\'s'} conversations (Conversions API for business messaging): Meta needs the ${page ? 'page_events' : 'instagram_manage_events'} permission on the token (Advanced access after App Review) and refuses without it. If one already exists, Meta answers its id and makes no new one.`)
    r = request(1, `Create the messaging dataset "${req.name}" for ${where}`, req.level, facts.objectId!, { dataset_name: req.name },
      { operation: 'dataset.createForMessaging', ...edgeOf('dataset'), readBackFields: 'id' })
  }
  const { changes } = changeLines([['dataset', 'none', `"${req.name}" in ${where}`]])
  return {
    summary: `Create the dataset "${req.name}" in ${where}.`,
    changes, totals: { datasets: 1 }, warnings, spendsMoney: [], skipped: [], requests: [r],
    stands: { level: req.level, objectId: r.objectId, existing: facts.existing ?? [] },
    before: { part: 'dataset', id: '', fields: {}, created: false, undo: null, noUndo: [DATASET_NO_DELETE] } satisfies SignalsRecord,
    after: { part: 'dataset', id: '', fields: { level: req.level, name: req.name }, created: true } satisfies SignalsRecord,
  }
}

// ── set-meta-dataset: a pixel's settings (SG-010 … SG-013) ───────────────────────────────────────────────────────────

export interface PixelSettingsRequest {
  pixelId: string
  name?: string
  automaticMatching?: { enabled: boolean; fields?: string[] }
  firstPartyCookieStatus?: string
  dataUse?: string
}

export const PIXEL_READ_BACK = 'id,name,enable_automatic_matching,automatic_matching_fields,first_party_cookie_status,data_use_setting'

export function pixelSettingsDraft(req: PixelSettingsRequest, facts: { settings: PixelSettings; adSetsUsing: { adSets: AdSetUsing[]; more: boolean } }): Draft {
  const s = facts.settings
  const params: Record<string, string> = {}
  const lines: Array<[string, unknown, unknown]> = []
  const skipped: string[] = []
  const warnings: string[] = []
  const undo: Record<string, unknown> = { pixelId: s.id }
  const noUndo: string[] = []
  const before: Record<string, string | null> = {}
  const after: Record<string, string | null> = {}
  const put = (field: string, from: unknown, to: string, label: string) => {
    params[field] = to
    before[field] = signalView(from)
    after[field] = signalView(to)
    lines.push([label, from ?? 'not set', to])
  }
  if (req.name !== undefined) {
    if (req.name === s.name) skipped.push(`Its name is already "${req.name}".`)
    else { put('name', s.name, req.name, 'name'); if (s.name) undo.name = s.name; else noUndo.push('Its name had none Nexus could read, so undo cannot put one back.') }
  }
  if (req.automaticMatching) {
    const { enabled, fields } = req.automaticMatching
    if (!enabled && fields?.length) return { refusal: 'Automatic advanced matching fields go with enabled true (switched off, Meta matches none).' }
    if (enabled !== s.enableAutomaticMatching) put('enable_automatic_matching', s.enableAutomaticMatching, String(enabled), 'automatic advanced matching')
    else skipped.push(`Automatic advanced matching is already ${enabled ? 'on' : 'off'}.`)
    if (fields?.length) {
      const wanted = inOrder(fields, AUTOMATIC_MATCHING_FIELDS)
      const now = s.automaticMatchingFields ? inOrder(s.automaticMatchingFields, AUTOMATIC_MATCHING_FIELDS) : null
      if (now && jsonList(now) === jsonList(wanted)) skipped.push(`It already matches ${wanted.join(', ')}.`)
      else put('automatic_matching_fields', now, jsonList(wanted), 'automatic matching fields')
    }
    if ('enable_automatic_matching' in params || 'automatic_matching_fields' in params) {
      if (s.enableAutomaticMatching === null) noUndo.push('Meta did not say whether automatic advanced matching was on, so undo cannot put it back.')
      else undo.automaticMatching = { enabled: s.enableAutomaticMatching, ...(s.enableAutomaticMatching && s.automaticMatchingFields?.length && 'automatic_matching_fields' in params ? { fields: inOrder(s.automaticMatchingFields, AUTOMATIC_MATCHING_FIELDS) } : {}) }
      if (enabled) warnings.push('Automatic advanced matching sends what shoppers type into the shop\'s forms (e-mail, phone, name, …), hashed in their browser, to Meta: a decision under the GDPR and the shop\'s privacy notice. The shop platform\'s Meta app may manage this setting too and set it back.')
    }
  }
  // Review A6 — a value Meta did not answer is unknown, never taken for EMPTY: it is sent, and undo says it cannot put it back.
  if (req.firstPartyCookieStatus !== undefined) {
    if (req.firstPartyCookieStatus === s.firstPartyCookieStatus) skipped.push(`First-party cookies are already ${req.firstPartyCookieStatus}.`)
    else {
      put('first_party_cookie_status', s.firstPartyCookieStatus, req.firstPartyCookieStatus, 'first-party cookies')
      if (s.firstPartyCookieStatus) undo.firstPartyCookieStatus = s.firstPartyCookieStatus
      else noUndo.push('Meta did not say its first-party cookie setting, so undo cannot put it back.')
      if (req.firstPartyCookieStatus === 'FIRST_PARTY_COOKIE_DISABLED') warnings.push('Without first-party cookies Meta matches fewer browser events to people (lower match rate); the shop\'s consent banner still decides what the browser sends.')
    }
  }
  let spends: string[] = []
  if (req.dataUse !== undefined) {
    if (req.dataUse === s.dataUseSetting) skipped.push(`Its data use is already ${req.dataUse}.`)
    else {
      put('data_use_setting', s.dataUseSetting, req.dataUse, 'data use')
      if (s.dataUseSetting) undo.dataUse = s.dataUseSetting
      else noUndo.push('Meta did not say its data use, so undo cannot put it back.')
      // From analytics only — or from a data use Meta did not say (it may have been analytics only) — to anything else.
      if (req.dataUse !== 'ANALYTICS_ONLY' && (s.dataUseSetting === 'ANALYTICS_ONLY' || s.dataUseSetting === null)) spends = signalBackSpends('Its data use back to ads', facts.adSetsUsing)
      if (req.dataUse === 'ANALYTICS_ONLY') {
        const { adSets, more } = facts.adSetsUsing
        warnings.push(`Analytics only: Meta stops using this dataset's events for ads (optimising, audiences, measurement in ads).${adSets.length ? ` ${plural(adSets.length, 'ad set')} optimise on it and lose that signal: ${adSetWords(adSets, more)}.` : ' No ad set of the chosen ad account optimises on it now.'}`)
      }
    }
  }
  if (!Object.keys(params).length) return { refusal: skipped.length ? `Nothing to change: ${skipped.join(' ')}` : 'Nothing to change: name a setting.' }
  const fieldsAsked = Object.keys(params)
  const expect = Object.fromEntries(fieldsAsked.filter((f) => f !== 'automatic_matching_fields').map((f) => [f, params[f]]))
  const { changes } = changeLines(lines)
  const record = (fields: Record<string, string | null>): SignalsRecord => ({ part: 'pixel', id: s.id, fields })
  return {
    summary: `Change ${plural(fieldsAsked.length, 'setting')} of the dataset "${s.name ?? s.id}" (${s.id}).`,
    changes, totals: { settings: fieldsAsked.length }, warnings, spendsMoney: spends, skipped,
    requests: [request(1, `Change the settings of dataset "${s.name ?? s.id}" (${s.id})`, 'dataset', s.id, params, { operation: 'dataset.settings', expect, readBackFields: PIXEL_READ_BACK, undoable: Object.keys(undo).length > 1, raisesSpend: spends.length > 0 })],
    stands: { pixel: s, adSets: facts.adSetsUsing.adSets.map((a) => [a.id, a.on]), more: facts.adSetsUsing.more },
    before: { ...record(before), undo: Object.keys(undo).length > 1 ? { tool: 'set-meta-dataset', args: undo } : null, noUndo },
    after: record(after),
  }
}

// ── set-meta-dataset: an event source group (BM-057) ─────────────────────────────────────────────────────────────────

export interface GroupRequest { action: 'create' | 'update' | 'share'; groupId?: string; name?: string; pixelIds?: string[] }
export interface GroupFacts { portfolio: string; adAccountId: string; group?: { id: string; name: string | null; pixelIds: string[] } }

const GROUP_NO_UNDO = 'Meta\'s API has no delete or unshare for an event source group (SDK eventsourcegroup.py: no delete, no shared_accounts removal): what this does stays until a person changes it in Meta\'s business settings.'

export function groupDraft(req: GroupRequest, facts: GroupFacts): Draft {
  const warnings = ['Meta documents event source groups for travel and claim audiences (event_source_group on an audience); the group update and its sharing are in Meta\'s SDK only: Meta\'s answer decides.']
  if (req.action === 'create') {
    if (!req.name || !req.pixelIds?.length) return { refusal: 'A new event source group needs its name and its datasets (pixelIds).' }
    const ids = sortedIds(req.pixelIds)
    const { changes } = changeLines([['event source group', 'none', `"${req.name}" with ${listWords(ids)}`]])
    return {
      summary: `Create the event source group "${req.name}" in the business portfolio ${facts.portfolio} with ${plural(ids.length, 'dataset')}.`,
      changes, totals: { groups: 1, datasets: ids.length }, warnings: [...warnings, GROUP_NO_UNDO], spendsMoney: [], skipped: [],
      requests: [request(1, `Create the event source group "${req.name}"`, 'datasetportfolio', facts.portfolio, { event_sources: jsonList(ids), name: req.name }, { operation: 'eventSourceGroup.create', ...edgeOf('event_source_groups'), expect: { name: req.name }, readBackFields: 'id,name' })],
      stands: { portfolio: facts.portfolio, pixelIds: ids },
      before: { part: 'group', id: '', fields: {}, created: false, undo: null, noUndo: [GROUP_NO_UNDO] } satisfies SignalsRecord,
      after: { part: 'group', id: '', fields: { name: req.name, event_sources: signalView(ids) }, created: true } satisfies SignalsRecord,
    }
  }
  const group = facts.group
  if (!group) return { refusal: 'Name the event source group (groupId).' }
  if (req.action === 'share') {
    const { changes } = changeLines([['shared with ad account', 'not by Nexus', facts.adAccountId]])
    return {
      summary: `Share the event source group "${group.name ?? group.id}" with the chosen ad account ${facts.adAccountId}.`,
      changes, totals: { groups: 1 }, warnings: [...warnings, GROUP_NO_UNDO], spendsMoney: [], skipped: [],
      requests: [request(1, `Share event source group "${group.name ?? group.id}" with ad account ${facts.adAccountId}`, 'eventsourcegroup', group.id, { accounts: jsonList([facts.adAccountId]) }, { operation: 'eventSourceGroup.share', ...edgeOf('shared_accounts') })],
      stands: { group },
      before: { part: 'group', id: group.id, fields: {}, undo: null, noUndo: [GROUP_NO_UNDO] } satisfies SignalsRecord,
      after: { part: 'group', id: group.id, fields: { shared_with: facts.adAccountId } } satisfies SignalsRecord,
    }
  }
  const params: Record<string, string> = {}
  const lines: Array<[string, unknown, unknown]> = []
  const skipped: string[] = []
  const undoArgs: Record<string, unknown> = { action: 'update', groupId: group.id }
  const noUndo: string[] = []
  if (req.name !== undefined) {
    if (req.name === group.name) skipped.push(`It is already named "${req.name}".`)
    else { params.name = req.name; lines.push(['name', group.name ?? 'not set', req.name]); if (group.name) undoArgs.name = group.name; else noUndo.push('Its old name could not be read.') }
  }
  if (req.pixelIds) {
    const ids = sortedIds(req.pixelIds)
    if (jsonList(ids) === jsonList(sortedIds(group.pixelIds))) skipped.push('It already holds exactly these datasets.')
    else { params.event_sources = jsonList(ids); lines.push(['datasets', listWords(sortedIds(group.pixelIds)), listWords(ids)]); if (group.pixelIds.length) undoArgs.pixelIds = sortedIds(group.pixelIds); else noUndo.push('It held no dataset Nexus could read.') }
  }
  if (!Object.keys(params).length) return { refusal: skipped.length ? `Nothing to change: ${skipped.join(' ')}` : 'Nothing to change: name a new name or datasets.' }
  const { changes } = changeLines(lines)
  const view = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, signalView(v)]))
  const back = Object.keys(undoArgs).length > 2
  return {
    summary: `Change the event source group "${group.name ?? group.id}" (${group.id}).`,
    changes, totals: { groups: 1 }, warnings, spendsMoney: [], skipped,
    requests: [request(1, `Change event source group "${group.name ?? group.id}" (${group.id})`, 'eventsourcegroup', group.id, params, { operation: 'eventSourceGroup.update', ...(params.name ? { expect: { name: params.name } } : {}), readBackFields: 'id,name', undoable: back })],
    stands: { group },
    before: { part: 'group', id: group.id, fields: view({ ...(params.name ? { name: group.name } : {}), ...(params.event_sources ? { event_sources: group.pixelIds } : {}) }), undo: back ? { tool: 'set-meta-dataset', args: { eventSourceGroup: undoArgs } } : null, noUndo },
    after: { part: 'group', id: group.id, fields: view({ ...(params.name ? { name: params.name } : {}), ...(params.event_sources ? { event_sources: params.event_sources } : {}) }) },
  }
}

// ── set-meta-dataset-access (SG-018, SG-019): the CHOSEN ad account only ────────────────────────────────────────────

export type AccessAction = 'connect-ad-account' | 'disconnect-ad-account'
export interface AccessRequest { pixelId: string; action: AccessAction }
export interface AccessFacts {
  pixelId: string
  pixelName: string | null
  adAccountId: string
  portfolio: string
  /** The pixel's owner portfolio (connect / disconnect undo). */
  ownerBusinessId?: string | null
  /** Is the chosen ad account connected to it (null: Meta does not say)? */
  connected?: boolean | null
  /** The ad sets that optimise on it or on a custom conversion of it. */
  adSetsUsing?: { adSets: AdSetUsing[]; more: boolean }
}

export function accessDraft(req: AccessRequest, facts: AccessFacts): Draft {
  const who = `dataset "${facts.pixelName ?? facts.pixelId}" (${facts.pixelId})`
  const base = (summary: string, lines: Array<[string, unknown, unknown]>, r: MetaChangeRequest, rec: { before: Record<string, string | null>; after: Record<string, string | null>; undo: SignalsRecord['undo']; noUndo: string[] }, warnings: string[] = [], spends: string[] = []): MetaChangeDraft => ({
    summary, changes: changeLines(lines).changes, totals: { changes: 1 }, warnings, spendsMoney: spends, skipped: [], requests: [{ ...r, undoable: !!rec.undo, raisesSpend: spends.length > 0 }], stands: facts,
    before: { part: 'access', id: facts.pixelId, fields: rec.before, undo: rec.undo, noUndo: rec.noUndo } satisfies SignalsRecord,
    after: { part: 'access', id: facts.pixelId, fields: rec.after } satisfies SignalsRecord,
  })
  const pixelArgs = { pixelId: facts.pixelId }
  switch (req.action) {
    case 'connect-ad-account': {
      if (facts.connected === true) return { refusal: `Nothing to change: ${who} is already connected to the chosen ad account ${facts.adAccountId}.` }
      if (facts.connected === null || facts.connected === undefined) return { refusal: `Meta does not show whether ${who} is connected to the chosen ad account, so Nexus cannot say from → to; nothing is sent.` }
      return base(`Connect ${who} to the chosen ad account ${facts.adAccountId}.`, [['ad account ' + facts.adAccountId, 'not connected', 'connected']],
        request(1, `Connect ${who} to ad account ${facts.adAccountId}`, 'dataset', facts.pixelId, { account_id: facts.adAccountId, business: facts.portfolio }, { operation: 'dataset.connectAccount', ...edgeOf('shared_accounts') }),
        { before: { connected: 'no' }, after: { connected: 'yes' }, undo: { tool: 'set-meta-dataset-access', args: { ...pixelArgs, action: 'disconnect-ad-account' } }, noUndo: [] },
        ['Ads of the chosen ad account can then track and optimise on this dataset\'s events.'],
        signalBackSpends('Connecting it', facts.adSetsUsing))
    }
    case 'disconnect-ad-account': {
      if (facts.connected === false) return { refusal: `Nothing to change: ${who} is not connected to the chosen ad account.` }
      const { adSets, more } = facts.adSetsUsing ?? { adSets: [], more: false }
      const back = facts.ownerBusinessId === facts.portfolio
      return base(`Disconnect ${who} from the chosen ad account ${facts.adAccountId}.`, [['ad account ' + facts.adAccountId, 'connected', 'not connected']],
        request(1, `Disconnect ${who} from ad account ${facts.adAccountId}`, 'dataset', facts.pixelId, { account_id: facts.adAccountId, business: facts.portfolio }, { operation: 'dataset.disconnectAccount', ...edgeOf('shared_accounts'), method: 'DELETE' }),
        {
          before: { connected: 'yes' }, after: { connected: 'no' },
          undo: back ? { tool: 'set-meta-dataset-access', args: { ...pixelArgs, action: 'connect-ad-account' } } : null,
          noUndo: back ? [] : ['The dataset is not owned by the chosen ad account\'s business portfolio, so Nexus cannot connect it again: the portfolio that owns it does.'],
        },
        [adSets.length
          ? `${plural(adSets.length, 'ad set')} of the chosen ad account optimise on this dataset (or a custom conversion of it) and stop getting its events (their delivery breaks until another dataset is chosen): ${adSetWords(adSets, more)}.`
          : `No ad set of the chosen ad account optimises on this dataset (or a custom conversion of it) now${more ? ' among the first 500 ad sets Nexus read' : ''}.`,
        'After this, the dataset is no longer on the chosen ad account: Nexus then reads and changes it only to connect it again.'])
    }
  }
}

// ── set-meta-custom-conversion (SG-090 … SG-094) ─────────────────────────────────────────────────────────────────────

export interface ConversionCreateRequest { name: string; pixelId: string; rule: unknown; eventType: string; defaultValueCents?: number; description?: string; actionSource?: string }
/** defaultValueCents on an update is refused (DEFAULT_VALUE_UPDATE_HELD): it is here so the refusal says why. */
export interface ConversionUpdateRequest { customConversionId: string; name?: string; description?: string; defaultValueCents?: number }

const RULE_FIXED = 'A custom conversion\'s rule can never change after it is made (Meta updates only its name, description and default value): a different rule is a new custom conversion, and ad sets keep the old one until they are moved.'

export function conversionCreateDraft(req: ConversionCreateRequest, facts: { adAccountId: string; currency: string | null; conversions: ConversionRow[]; complete: boolean; pixelName: string | null }): Draft {
  if (!facts.complete) return { refusal: 'Meta lists more custom conversions on the chosen ad account than Nexus reads at once, so Nexus cannot count them against Meta\'s 100: nothing is sent.' }
  const count = facts.conversions.length
  if (count >= MAX_CUSTOM_CONVERSIONS) return { refusal: `The chosen ad account already has ${count} custom conversions; Meta allows at most ${MAX_CUSTOM_CONVERSIONS} per ad account. Delete one first (remove-meta-signal-items for one Nexus made, or Events Manager).` }
  const problem = conversionRuleProblem(req.rule)
  if (problem) return { refusal: `The rule is not one Nexus sends: ${problem}.` }
  const params: Record<string, string> = { name: req.name, event_source_id: req.pixelId, rule: JSON.stringify(req.rule), custom_event_type: req.eventType }
  if (req.defaultValueCents !== undefined) params.default_conversion_value = conversionValueText(req.defaultValueCents, facts.currency)
  if (req.description) params.description = req.description
  if (req.actionSource) params.action_source_type = req.actionSource
  const warnings = [RULE_FIXED, `It is custom conversion ${count + 1} of the ${MAX_CUSTOM_CONVERSIONS} Meta allows on this ad account.`]
  if (facts.conversions.some((c) => c.name === req.name)) warnings.push(`The ad account already has a custom conversion named "${req.name}": both would show with the same name.`)
  const { changes } = changeLines([
    ['custom conversion', 'none', `"${req.name}" (${req.eventType}) on dataset ${facts.pixelName ? `"${facts.pixelName}" ` : ''}${req.pixelId}`],
    ['rule', 'none', params.rule],
    ...(req.defaultValueCents !== undefined ? [['default value', 'none', money(req.defaultValueCents, facts.currency)] as [string, unknown, unknown]] : []),
  ])
  return {
    summary: `Create the custom conversion "${req.name}" (${req.eventType}) on the chosen ad account ${facts.adAccountId}.`,
    changes, totals: { customConversions: 1 }, warnings, spendsMoney: [], skipped: [],
    // undoable false: its undo deletes the NEW custom conversion, not the ad account this request names (no per-object wait).
    requests: [request(1, `Create custom conversion "${req.name}"`, 'adaccount', `act_${facts.adAccountId}`, params, { operation: 'customConversion.create', ...edgeOf('customconversions'), expect: { name: req.name }, readBackFields: 'id,name' })],
    stands: { adAccountId: facts.adAccountId, count, pixelId: req.pixelId },
    before: { part: 'conversion', id: '', fields: {}, created: false, undo: null, noUndo: [] } satisfies SignalsRecord,
    after: { part: 'conversion', id: '', fields: { name: req.name, pixel: req.pixelId, rule: params.rule }, created: true } satisfies SignalsRecord,
  }
}

/**
 * Review B1 — the unit of a custom conversion's default value is not documented both ways (the update takes a float of the
 * currency, the field reads back as Meta's int): Nexus does not change it after creation, so neither a raise nor an undo
 * can land a value 100 times off, until LIVE-PROBE SG-090 shows what 0.01 reads back as.
 */
export const DEFAULT_VALUE_UPDATE_HELD = 'Nexus does not change a custom conversion\'s default value after creation yet: Meta takes it as a decimal of the currency but reads it back as a whole number, and its documentation does not say which unit it keeps (LIVE-PROBE SG-090). A person changes it in Events Manager; Nexus sets it only when it creates a custom conversion.'

export function conversionUpdateDraft(req: ConversionUpdateRequest, facts: { row: ConversionRow }): Draft {
  const c = facts.row
  if (req.defaultValueCents !== undefined) return { refusal: DEFAULT_VALUE_UPDATE_HELD }
  if (c.isUnavailable) return { refusal: `Meta has flagged the custom conversion "${c.name ?? c.id}" (it may suggest information Meta's terms do not allow): Meta refuses any change of it (error 2460004). A person appeals it in Events Manager, or a new custom conversion replaces it.` }
  const params: Record<string, string> = {}
  const lines: Array<[string, unknown, unknown]> = []
  const skipped: string[] = []
  const undo: Record<string, unknown> = { action: 'update', customConversionId: c.id }
  const noUndo: string[] = []
  if (req.name !== undefined) {
    if (req.name === c.name) skipped.push(`It is already named "${req.name}".`)
    else { params.name = req.name; lines.push(['name', c.name ?? 'not set', req.name]); if (c.name) undo.name = c.name; else noUndo.push('Its old name could not be read.') }
  }
  if (req.description !== undefined) {
    if (req.description === c.description) skipped.push('Its description is already that.')
    else { params.description = req.description; lines.push(['description', c.description ?? 'none', req.description]); if (c.description) undo.description = c.description; else noUndo.push('It had no description, and Meta takes no empty one back.') }
  }
  if (!Object.keys(params).length) return { refusal: skipped.length ? `Nothing to change: ${skipped.join(' ')}` : `Nothing to change: Nexus changes only a custom conversion's name and description (${RULE_FIXED})` }
  const fields = Object.keys(params)
  const { changes } = changeLines(lines)
  const view = (o: Record<string, unknown>) => Object.fromEntries(fields.map((f) => [f, signalView(o[f])]))
  const back = Object.keys(undo).length > 2
  return {
    summary: `Change ${plural(fields.length, 'setting')} of the custom conversion "${c.name ?? c.id}" (${c.id}).`,
    changes, totals: { settings: fields.length }, warnings: [RULE_FIXED], spendsMoney: [], skipped,
    requests: [request(1, `Change custom conversion "${c.name ?? c.id}" (${c.id})`, 'datasetconversion', c.id, params, {
      operation: 'customConversion.update', undoable: back, expect: { ...params }, readBackFields: 'id,name,description',
    })],
    stands: { conversion: c },
    before: { part: 'conversion', id: c.id, customConversionId: c.id, fields: view({ name: c.name, description: c.description }), undo: back ? { tool: 'set-meta-custom-conversion', args: undo } : null, noUndo },
    after: { part: 'conversion', id: c.id, customConversionId: c.id, fields: view(params) },
  }
}

/** Review B2 — a claim only for a custom conversion no portfolio holds yet; one the chosen portfolio holds needs nothing. */
export function conversionClaimDraft(facts: { row: ConversionRow; portfolio: string }): Draft {
  const c = facts.row
  if (c.businessId === facts.portfolio) return { refusal: `Nothing to change: the custom conversion "${c.name ?? c.id}" is already the chosen ad account's business portfolio's.` }
  if (c.businessId) return { refusal: `The custom conversion "${c.name ?? c.id}" is already held by another business portfolio, so Nexus does not claim it.` }
  const noWay = 'Meta has no way back for a claim by API (no unclaim edge): the business portfolio keeps it.'
  return {
    summary: `Claim the custom conversion "${c.name ?? c.id}" (${c.id}) into the business portfolio ${facts.portfolio}.`,
    changes: changeLines([['owner of custom conversion ' + c.id, 'the ad account', `business portfolio ${facts.portfolio}`]]).changes,
    totals: { customConversions: 1 }, warnings: [noWay], spendsMoney: [], skipped: [],
    requests: [request(1, `Claim custom conversion "${c.name ?? c.id}" into portfolio ${facts.portfolio}`, 'datasetportfolio', facts.portfolio, { custom_conversion_id: c.id }, { operation: 'customConversion.claim', ...edgeOf('claim_custom_conversions') })],
    stands: { conversion: c.id, business: c.businessId, portfolio: facts.portfolio },
    before: { part: 'conversion', id: c.id, customConversionId: c.id, fields: { claimed: 'no' }, undo: null, noUndo: [noWay] } satisfies SignalsRecord,
    after: { part: 'conversion', id: c.id, customConversionId: c.id, fields: { claimed: 'yes' } } satisfies SignalsRecord,
  }
}

// ── remove-meta-signal-items (SG-093, SG-100, SG-104) ────────────────────────────────────────────────────────────────

export type SignalItemKind = 'customConversion' | 'eventRule' | 'parameterExtractor'
export interface RemoveFacts { conversions: Array<{ row: ConversionRow; adSetsUsing: { adSets: AdSetUsing[]; more: boolean } }> }

export function removeDraft(items: Array<{ kind: SignalItemKind; id: string }>, facts: RemoveFacts): Draft {
  const skipped = items.filter((i) => i.kind !== 'customConversion').map((i) => `${i.kind === 'eventRule' ? 'Event rule' : 'Parameter extractor'} ${i.id}: ${EVENT_SETUP_CANNOT}`)
  const warnings: string[] = ['Deleting is for good: Meta has no undo, a custom conversion made again gets a new id and no history, and ad sets that optimise on the old one keep pointing at it.']
  const requests: MetaChangeRequest[] = []
  const lines: Array<[string, unknown, unknown]> = []
  for (const { row, adSetsUsing } of facts.conversions) {
    requests.push(request(requests.length + 1, `Delete custom conversion "${row.name ?? row.id}" (${row.id})`, 'datasetconversion', row.id, {}, { operation: 'customConversion.delete', method: 'DELETE' }))
    lines.push([`custom conversion "${row.name ?? row.id}" (${row.id})`, 'exists', 'deleted'])
    if (adSetsUsing.adSets.length) warnings.push(`"${row.name ?? row.id}": ${plural(adSetsUsing.adSets.length, 'ad set')} optimise on it and lose their conversion event (their delivery breaks until another one is chosen): ${adSetWords(adSetsUsing.adSets, adSetsUsing.more)}.`)
  }
  if (!requests.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const { changes, more } = changeLines(lines)
  return {
    summary: `Delete ${plural(requests.length, 'custom conversion')} Nexus made, for good.`,
    changes, totals: { customConversions: requests.length, ...(more ? { moreLines: more } : {}) }, warnings, spendsMoney: [], skipped, requests,
    stands: { conversions: facts.conversions.map((c) => ({ row: c.row, adSets: c.adSetsUsing.adSets.map((a) => a.id) })) },
    before: { items: facts.conversions.map((c) => ({ id: c.row.id, name: c.row.name, pixelId: c.row.pixelId, eventType: c.row.customEventType, rule: c.row.rule })) },
    after: { items: facts.conversions.map((c) => ({ id: c.row.id, deleted: true })) },
  }
}
