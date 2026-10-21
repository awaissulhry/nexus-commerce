/**
 * Meta step 32 — the dataset, custom conversion and event source group changes as drafts (pure: built from a request and
 * the live facts the tool read; no call). Master rows BM-057, SG-006–SG-014, SG-018, SG-019, SG-021, SG-022, SG-024,
 * SG-041, SG-090–SG-094, SG-098–SG-100, SG-102–SG-104. Meta's facts behind each are in gateway/meta-signals-rules.ts.
 *
 * Nothing here can make the account spend more but one thing: a custom conversion's default value is what value-based
 * bidding counts each conversion as, so raising it while ad sets optimise on that conversion can let a ROAS goal spend
 * more of its budget (SPENDS MONEY, said like a ROAS-floor drop). Disconnecting a dataset, data use "analytics only" and
 * deleting a custom conversion take signal AWAY from ad sets: warned in words (delivery), never more spend.
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { decimalToMicros, minorOf, currencyExponent } from './money.js'
import { money } from './change-settings-common.js'
import type { AdSetUsing, ConversionRow, PixelSettings } from './live-signals.js'
import {
  AUTOMATIC_MATCHING_FIELDS, CONVERSION_UPDATE_KEYS, conversionRuleProblem, MAX_CUSTOM_CONVERSIONS, PARTNER_TASKS, PERSON_TASKS, type MetaSignalsEdge, type MetaSignalsKind,
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
 * RECHECK-C3 SG-041: ads-pixel/domain_control_rule.md — Creating and Deleting empty, Updating "can't perform"; SDK
 * AdsPixelDomainControlRule is a plain read object, AdsPixel has no such edge and its update takes no domain list.
 */
export const TRAFFIC_PERMISSIONS_CANNOT = 'Meta cannot change this by API: traffic permissions (the domains a pixel accepts or blocks) can be read but not written through Meta\'s public API (v26 reference ads-pixel/domain_control_rule: no create, update or delete; the pixel update takes no domain list). A person sets them in Events Manager › the dataset › Settings › Traffic permissions.'
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

/** Meta's default value (a decimal of the currency) → minor units; null when there is none or it is not a number. */
export const conversionValueCents = (value: string | null, currency: string | null): number | null => (value === null ? null : minorOf(decimalToMicros(value), currency))

// ── shared ───────────────────────────────────────────────────────────────────────────────────────────────────────────

type Draft = MetaChangeDraft | { refusal: string }

/**
 * One request of a step 32 change. Its object is named by `objectKind` (what the gateway confirms: signals-rule.ts) and
 * its own `operation`; MetaChangeRequest.kind is set-meta-status's (a campaign, ad set or ad) and is never read for a
 * request that names both (meta-ads-kit.ts objectChangeOf), so it carries the fixed placeholder below.
 */
function request(step: number, label: string, objectKind: MetaSignalsKind, objectId: string, params: Record<string, string>, extra: Partial<MetaChangeRequest> & { operation: string }): MetaChangeRequest {
  return { step, label, kind: STATUS_KIND_UNUSED, objectKind, objectId, params, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, ...extra }
}
const STATUS_KIND_UNUSED = 'campaign' as const
const edgeOf = (edge: MetaSignalsEdge) => ({ edge })

/** The order Meta lists the fields in (ads-pixel.md), so one set has one spelling. */
const inOrder = <T extends string>(values: readonly string[], order: readonly T[]): T[] => order.filter((v) => values.includes(v))
export const jsonList = (values: readonly string[]) => JSON.stringify([...values])
const sortedIds = (ids: readonly string[]) => [...new Set(ids)].sort()
const listWords = (values: readonly string[] | null) => (values === null ? 'unknown' : values.length ? values.join(', ') : 'none')
/**
 * Giving ad sets their dataset back (connecting it to the chosen ad account, or its data use back to ads) lets the ad sets
 * that optimise on it deliver again: SPENDS MONEY, said like a switch-on — "nothing spends yet" when none of them is on.
 */
function signalBackSpends(what: string, adSetsUsing: { adSets: AdSetUsing[]; more: boolean } | undefined): string[] {
  const adSets = adSetsUsing?.adSets ?? []
  if (!adSets.length) return []
  const on = adSets.filter((a) => a.effectiveStatus === 'ACTIVE')
  return [`${what} lets ${plural(adSets.length, 'ad set')} that optimise on it deliver on its events again: ${on.length ? `${plural(on.length, 'is', 'are')} on now, so the account can spend more from now` : 'nothing spends yet: none of them is on'} — ${adSetWords(adSets, adSetsUsing!.more)}.`]
}
const adSetWords = (adSets: AdSetUsing[], more: boolean) => `${adSets.slice(0, 10).map((a) => `"${a.name ?? 'no name'}" (${a.id}, ${a.effectiveStatus ?? 'status unknown'})`).join('; ')}${adSets.length > 10 ? `; and ${adSets.length - 10} more` : ''}${more ? ' (Nexus read the first 500 ad sets of the account)' : ''}`

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
    r = request(1, `Create the dataset (pixel) "${req.name}" in ${where}`, 'business', facts.objectId!, { name: req.name },
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
  if (req.firstPartyCookieStatus !== undefined) {
    if (req.firstPartyCookieStatus === (s.firstPartyCookieStatus ?? 'EMPTY')) skipped.push(`First-party cookies are already ${req.firstPartyCookieStatus}.`)
    else {
      put('first_party_cookie_status', s.firstPartyCookieStatus, req.firstPartyCookieStatus, 'first-party cookies')
      undo.firstPartyCookieStatus = s.firstPartyCookieStatus ?? 'EMPTY'
      if (req.firstPartyCookieStatus === 'FIRST_PARTY_COOKIE_DISABLED') warnings.push('Without first-party cookies Meta matches fewer browser events to people (lower match rate); the shop\'s consent banner still decides what the browser sends.')
    }
  }
  let spends: string[] = []
  if (req.dataUse !== undefined) {
    if (req.dataUse === (s.dataUseSetting ?? 'EMPTY')) skipped.push(`Its data use is already ${req.dataUse}.`)
    else {
      put('data_use_setting', s.dataUseSetting, req.dataUse, 'data use')
      undo.dataUse = s.dataUseSetting ?? 'EMPTY'
      if (s.dataUseSetting === 'ANALYTICS_ONLY') spends = signalBackSpends('Its data use back to ads', facts.adSetsUsing)
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
    requests: [request(1, `Change the settings of dataset "${s.name ?? s.id}" (${s.id})`, 'pixel', s.id, params, { operation: 'dataset.settings', expect, readBackFields: PIXEL_READ_BACK, undoable: Object.keys(undo).length > 1, raisesSpend: spends.length > 0 })],
    stands: { pixel: s, adSets: facts.adSetsUsing.adSets.map((a) => [a.id, a.effectiveStatus]) },
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
      requests: [request(1, `Create the event source group "${req.name}"`, 'business', facts.portfolio, { event_sources: jsonList(ids), name: req.name }, { operation: 'eventSourceGroup.create', ...edgeOf('event_source_groups'), expect: { name: req.name }, readBackFields: 'id,name' })],
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

// ── set-meta-dataset-access (SG-014, SG-018, SG-019, SG-021, SG-022, SG-024) ────────────────────────────────────────

export type AccessAction = 'connect-ad-account' | 'disconnect-ad-account' | 'share-with-partner' | 'remove-partner' | 'assign-person' | 'server-event-partners'
export interface AccessRequest {
  pixelId: string
  action: AccessAction
  partnerBusinessId?: string
  partnerTasks?: string[]
  personId?: string
  personTasks?: string[]
  serverEventBusinessIds?: string[]
}
export interface AccessFacts {
  pixelId: string
  pixelName: string | null
  adAccountId: string
  portfolio: string
  /** The pixel's owner portfolio (connect / disconnect undo). */
  ownerBusinessId?: string | null
  /** Is the chosen ad account connected to it (null: Meta does not say)? */
  connected?: boolean | null
  adSetsUsing?: { adSets: AdSetUsing[]; more: boolean }
  /** Its partner portfolios (null: Meta does not show them). */
  partners?: string[] | null
  /** A person's tasks on it now (null: not assigned; undefined: Meta does not show them). */
  personTasks?: string[] | null
  /** The portfolios allowed to send its server events now (null: Meta does not show them). */
  serverEventBusinesses?: string[] | null
}

const NO_PERSON_REMOVAL = 'Meta\'s API has no removal of a person from a dataset (SDK adspixel.py: no delete on assigned_users): a person takes them off in Meta\'s business settings › Data sources › Datasets.'

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
        request(1, `Connect ${who} to ad account ${facts.adAccountId}`, 'pixel', facts.pixelId, { account_id: facts.adAccountId, business: facts.portfolio }, { operation: 'dataset.connectAccount', ...edgeOf('shared_accounts') }),
        { before: { connected: 'no' }, after: { connected: 'yes' }, undo: { tool: 'set-meta-dataset-access', args: { ...pixelArgs, action: 'disconnect-ad-account' } }, noUndo: [] },
        ['Ads of the chosen ad account can then track and optimise on this dataset\'s events.'],
        signalBackSpends('Connecting it', facts.adSetsUsing))
    }
    case 'disconnect-ad-account': {
      if (facts.connected === false) return { refusal: `Nothing to change: ${who} is not connected to the chosen ad account.` }
      const { adSets, more } = facts.adSetsUsing ?? { adSets: [], more: false }
      const back = facts.ownerBusinessId === facts.portfolio
      return base(`Disconnect ${who} from the chosen ad account ${facts.adAccountId}.`, [['ad account ' + facts.adAccountId, 'connected', 'not connected']],
        request(1, `Disconnect ${who} from ad account ${facts.adAccountId}`, 'pixel', facts.pixelId, { account_id: facts.adAccountId, business: facts.portfolio }, { operation: 'dataset.disconnectAccount', ...edgeOf('shared_accounts'), method: 'DELETE' }),
        {
          before: { connected: 'yes' }, after: { connected: 'no' },
          undo: back ? { tool: 'set-meta-dataset-access', args: { ...pixelArgs, action: 'connect-ad-account' } } : null,
          noUndo: back ? [] : ['The dataset is not owned by the chosen ad account\'s business portfolio, so Nexus cannot connect it again: the portfolio that owns it does.'],
        },
        [adSets.length
          ? `${plural(adSets.length, 'ad set')} of the chosen ad account optimise on this dataset and stop getting its events (their delivery breaks until another dataset is chosen): ${adSetWords(adSets, more)}.`
          : `No ad set of the chosen ad account optimises on this dataset now${more ? ' among the first 500 Nexus read' : ''}.`,
        'After this, the dataset is no longer on the chosen ad account: Nexus then reads and changes it only to connect it again.'])
    }
    case 'share-with-partner': {
      const partner = req.partnerBusinessId
      const tasks = req.partnerTasks?.length ? inOrder(req.partnerTasks, PARTNER_TASKS) : null
      if (!partner || !tasks) return { refusal: 'Name the partner business portfolio (partnerBusinessId) and what it may do (partnerTasks: ADVERTISE, ANALYZE, UPLOAD, EDIT).' }
      const already = facts.partners?.includes(partner)
      return base(`Share ${who} with the partner business portfolio ${partner} (${tasks.join(', ')}).`, [[`partner ${partner}`, already ? 'shared (tasks not shown by Meta)' : 'not shared', tasks.join(', ')]],
        request(1, `Share ${who} with partner ${partner}`, 'pixel', facts.pixelId, { business: partner, permitted_tasks: jsonList(tasks) }, { operation: 'dataset.sharePartner', ...edgeOf('agencies') }),
        { before: { partner: already ? 'yes' : 'no' }, after: { partner: 'yes' }, undo: already ? null : { tool: 'set-meta-dataset-access', args: { ...pixelArgs, action: 'remove-partner', partnerBusinessId: partner } }, noUndo: already ? ['It was already shared with that partner: Meta does not show the tasks it had, so they cannot be put back.'] : [] },
        [
          ...(tasks.includes('EDIT') ? ['EDIT lets the partner manage the dataset and change its settings; Meta says EDIT access is limited and may refuse it.'] : []),
          'If the partner has no approved relationship with this business portfolio yet, Meta answers with a pending request: the dataset is shared once the partner accepts it.',
          'From then on Nexus checks the partner\'s ad accounts on this dataset every time it reads or changes it: if Meta does not show them, Nexus stops changing it (and its undo) — a person then removes the partner in Meta\'s business settings.',
          'Removing a partner (the undo) needs a business admin\'s own token per Meta\'s pixel-sharing guide: Meta may refuse it for Nexus\'s system user.',
        ])
    }
    case 'remove-partner': {
      const partner = req.partnerBusinessId
      if (!partner) return { refusal: 'Name the partner business portfolio (partnerBusinessId).' }
      if (facts.partners && !facts.partners.includes(partner)) return { refusal: `Nothing to change: ${who} is not shared with the partner ${partner}.` }
      return base(`Remove the partner business portfolio ${partner} from ${who}.`, [[`partner ${partner}`, 'shared', 'removed']],
        request(1, `Remove partner ${partner} from ${who}`, 'pixel', facts.pixelId, { business: partner }, { operation: 'dataset.removePartner', ...edgeOf('agencies'), method: 'DELETE' }),
        { before: { partner: 'yes' }, after: { partner: 'no' }, undo: null, noUndo: ['Sharing it again is a new share (set-meta-dataset-access share-with-partner) that the partner may have to accept again; Meta does not show the tasks it had.'] },
        ['The partner\'s use of this dataset stops (its ads, uploads and reports with it).', 'Meta\'s pixel-sharing guide asks a business admin\'s own token for this: Meta may refuse it for Nexus\'s system user, and then a person removes the partner in business settings.'])
    }
    case 'assign-person': {
      const person = req.personId
      const tasks = req.personTasks?.length ? inOrder(req.personTasks, PERSON_TASKS) : null
      if (!person || !tasks) return { refusal: 'Name the person or system user (personId) and the tasks (personTasks: ADVERTISE, ANALYZE, UPLOAD, EDIT, AA_ANALYZE).' }
      const now = facts.personTasks
      if (now && jsonList(now) === jsonList(tasks)) return { refusal: `Nothing to change: ${person} already has ${tasks.join(', ')} on ${who}.` }
      const back = now && now.length ? { tool: 'set-meta-dataset-access', args: { ...pixelArgs, action: 'assign-person', personId: person, personTasks: now } } : null
      return base(`Give ${person} ${tasks.join(', ')} on ${who}.`, [[`person ${person}`, now === undefined ? 'unknown' : now === null ? 'not assigned' : now.join(', '), tasks.join(', ')]],
        request(1, `Give ${person} ${tasks.join(', ')} on ${who}`, 'pixel', facts.pixelId, { user: person, tasks: jsonList(tasks) }, { operation: 'dataset.assignPerson', ...edgeOf('assigned_users') }),
        { before: { tasks: now ? jsonList(now) : null }, after: { tasks: jsonList(tasks) }, undo: back, noUndo: back ? [] : [NO_PERSON_REMOVAL] },
        ['Meta documents this in its SDK and its Ads CLI (dataset assign-user), not in the v26 reference: Meta\'s answer decides. Whether Meta replaces a person\'s tasks or adds to them is not documented.'])
    }
    case 'server-event-partners': {
      if (!req.serverEventBusinessIds) return { refusal: 'Name the full list of business portfolios that may send this dataset\'s server events (serverEventBusinessIds; [] for none).' }
      const now = facts.serverEventBusinesses
      if (now === null || now === undefined) return { refusal: `Meta does not show which businesses may send ${who}'s server events now, so Nexus cannot say from → to or put it back; nothing is sent.` }
      const ids = sortedIds(req.serverEventBusinessIds)
      if (jsonList(ids) === jsonList(now)) return { refusal: `Nothing to change: exactly these businesses may already send ${who}'s server events.` }
      return base(`Let ${listWords(ids)} send server events to ${who}.`, [['may send server events', listWords(now), listWords(ids)]],
        request(1, `Set who may send server events to ${who}`, 'pixel', facts.pixelId, { server_events_business_ids: jsonList(ids) }, { operation: 'dataset.serverEventPartners' }),
        { before: { server_events_business_ids: jsonList(now) }, after: { server_events_business_ids: jsonList(ids) }, undo: { tool: 'set-meta-dataset-access', args: { ...pixelArgs, action: 'server-event-partners', serverEventBusinessIds: now } }, noUndo: [] },
        ['Only for a partner that sends this dataset\'s events from its own server (a partner integration); Nexus itself sends with this business\'s own system user and needs no entry here.'])
    }
  }
}

// ── set-meta-custom-conversion (SG-090 … SG-094) ─────────────────────────────────────────────────────────────────────

export interface ConversionCreateRequest { name: string; pixelId: string; rule: unknown; eventType: string; defaultValueCents?: number; description?: string; actionSource?: string }
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

export function conversionUpdateDraft(req: ConversionUpdateRequest, facts: { row: ConversionRow; currency: string | null; adSetsUsing: { adSets: AdSetUsing[]; more: boolean } }): Draft {
  const c = facts.row
  if (c.isUnavailable) return { refusal: `Meta has flagged the custom conversion "${c.name ?? c.id}" (it may suggest information Meta's terms do not allow): Meta refuses any change of it (error 2460004). A person appeals it in Events Manager, or a new custom conversion replaces it.` }
  const params: Record<string, string> = {}
  const lines: Array<[string, unknown, unknown]> = []
  const skipped: string[] = []
  const undo: Record<string, unknown> = { action: 'update', customConversionId: c.id }
  const noUndo: string[] = []
  const spends: string[] = []
  if (req.name !== undefined) {
    if (req.name === c.name) skipped.push(`It is already named "${req.name}".`)
    else { params.name = req.name; lines.push(['name', c.name ?? 'not set', req.name]); if (c.name) undo.name = c.name; else noUndo.push('Its old name could not be read.') }
  }
  if (req.description !== undefined) {
    if (req.description === c.description) skipped.push('Its description is already that.')
    else { params.description = req.description; lines.push(['description', c.description ?? 'none', req.description]); if (c.description) undo.description = c.description; else noUndo.push('It had no description, and Meta takes no empty one back.') }
  }
  if (req.defaultValueCents !== undefined) {
    const old = conversionValueCents(c.defaultValue, facts.currency) ?? 0
    if (req.defaultValueCents === old) skipped.push(`Its default value is already ${money(old, facts.currency)}.`)
    else {
      params.default_conversion_value = conversionValueText(req.defaultValueCents, facts.currency)
      lines.push(['default value', money(old, facts.currency), money(req.defaultValueCents, facts.currency)])
      undo.defaultValueCents = old
      const { adSets, more } = facts.adSetsUsing
      if (req.defaultValueCents > old && adSets.length) {
        const on = adSets.filter((a) => a.effectiveStatus === 'ACTIVE')
        spends.push(`a higher default value makes each conversion of "${c.name ?? c.id}" count for more in value-based bidding, so ${plural(adSets.length, 'ad set')} that optimise on it (a ROAS goal above all) may spend more of their budgets: ${on.length ? `${plural(on.length, 'is', 'are')} on now` : 'nothing spends yet: none of them is on'} — ${adSetWords(adSets, more)}.`)
      }
    }
  }
  if (!Object.keys(params).length) return { refusal: skipped.length ? `Nothing to change: ${skipped.join(' ')}` : `Nothing to change: Meta changes only a custom conversion's ${CONVERSION_UPDATE_KEYS.join(', ')} (${RULE_FIXED})` }
  const fields = Object.keys(params)
  const { changes } = changeLines(lines)
  const view = (o: Record<string, unknown>) => Object.fromEntries(fields.map((f) => [f, signalView(o[f])]))
  const back = Object.keys(undo).length > 2
  return {
    summary: `Change ${plural(fields.length, 'setting')} of the custom conversion "${c.name ?? c.id}" (${c.id}).`,
    changes, totals: { settings: fields.length }, warnings: [RULE_FIXED], spendsMoney: spends, skipped,
    requests: [request(1, `Change custom conversion "${c.name ?? c.id}" (${c.id})`, 'customconversion', c.id, params, {
      operation: 'customConversion.update', raisesSpend: spends.length > 0, undoable: back,
      expect: Object.fromEntries(fields.filter((f) => f !== 'default_conversion_value').map((f) => [f, params[f]])), readBackFields: 'id,name,description,default_conversion_value',
    })],
    stands: { conversion: c, adSets: facts.adSetsUsing.adSets.map((a) => [a.id, a.effectiveStatus]) },
    before: { part: 'conversion', id: c.id, customConversionId: c.id, fields: view({ name: c.name, description: c.description, default_conversion_value: c.defaultValue }), undo: back ? { tool: 'set-meta-custom-conversion', args: undo } : null, noUndo },
    after: { part: 'conversion', id: c.id, customConversionId: c.id, fields: view(params) },
  }
}

export function conversionClaimDraft(facts: { row: ConversionRow; portfolio: string }): Draft {
  const c = facts.row
  const noWay = 'Meta has no way back for a claim by API (no unclaim edge): the business portfolio keeps it.'
  return {
    summary: `Claim the custom conversion "${c.name ?? c.id}" (${c.id}) into the business portfolio ${facts.portfolio}.`,
    changes: changeLines([['owner of custom conversion ' + c.id, 'the ad account', `business portfolio ${facts.portfolio}`]]).changes,
    totals: { customConversions: 1 }, warnings: [noWay], spendsMoney: [], skipped: [],
    requests: [request(1, `Claim custom conversion "${c.name ?? c.id}" into portfolio ${facts.portfolio}`, 'business', facts.portfolio, { custom_conversion_id: c.id }, { operation: 'customConversion.claim', ...edgeOf('claim_custom_conversions') })],
    stands: { conversion: c.id, portfolio: facts.portfolio },
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
    requests.push(request(requests.length + 1, `Delete custom conversion "${row.name ?? row.id}" (${row.id})`, 'customconversion', row.id, {}, { operation: 'customConversion.delete', method: 'DELETE' }))
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
