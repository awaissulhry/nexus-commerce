/**
 * Google Ads programme 2, G12 (2026-10-16) — data sources (pure): make a supplemental product data source or a promotion
 * data source (both API input: datasources_v1 dataSources.create), rename one Nexus made (dataSources.patch, updateMask
 * displayName), fetch a FILE data source now (dataSources.fetch: "only works on data sources with a file input set"), and
 * delete one Nexus made when it is empty (dataSources.delete; Google: a supplemental source "cannot be deleted before all
 * links are removed").
 *
 * Not offered, and said so: a PRIMARY data source (a product there needs a price, availability and link that must match
 * the shop — Shopify's Google channel sends them — and an insert into another primary MOVES the product out of its feed),
 * changing or deleting a data source Nexus did not make (the primary feed of Shopify's Google channel above all), and
 * linking a supplemental source into a primary's rules (that changes the primary feed: a person does it in Merchant
 * Center). Local and regional inventory data sources: Nexus has no store whose Merchant Center store code it knows.
 */
import { DATA_SOURCE_MASKS } from '../../gateway/google-merchant-calls.js'
import { NOT_NEXUS_DATA_SOURCE, type MerchantDraftResult } from './change-draft.js'
import type { MerchantDataSource } from './live.js'

export const DATA_SOURCE_ACTIONS = ['create-supplemental', 'create-promotions', 'rename', 'fetch-now', 'delete'] as const
export type DataSourceAction = typeof DATA_SOURCE_ACTIONS[number]

export interface DataSourceRequest {
  action: DataSourceAction
  dataSourceId?: string
  displayName?: string
  feedLabel?: string
  contentLanguage?: string
  targetCountry?: string
  confirmDelete?: boolean
}

export interface DataSourceFacts {
  merchantCenterId: string
  dataSources: MerchantDataSource[]
  nexusMade: Set<string>
  /** delete: what Nexus's records say the data source still holds (product inputs or promotions). */
  held: number
  /** delete of a promotion data source: the promotions Merchant Center shows in it, live. */
  livePromotions: number
}

export const LINK_IN_MERCHANT_CENTER = 'A supplemental data source reaches products only once a primary data source links it in a rule. Nexus never changes '
  + 'the rules of the primary feed that Shopify\'s Google channel owns: a person links it in Merchant Center (Data sources › the primary data '
  + 'source › Rules: add it as a supplemental source; put it before the primary feed when its values should win).'

export function dataSourceDraft(req: DataSourceRequest, facts: DataSourceFacts): MerchantDraftResult {
  const base = `accounts/${facts.merchantCenterId}/dataSources`
  const path = `datasources/v1/${base}`
  if (req.action === 'create-supplemental' || req.action === 'create-promotions') {
    const name = req.displayName?.trim()
    if (!name) return { refusal: 'A new data source needs its name (displayName). Nothing was changed.' }
    const promotions = req.action === 'create-promotions'
    if (promotions && (!req.targetCountry || !req.contentLanguage)) return { refusal: 'A promotion data source needs its country (targetCountry) and language (contentLanguage). Nothing was changed.' }
    if (!promotions && !!req.feedLabel !== !!req.contentLanguage) return { refusal: 'A supplemental data source names both its feed label and its language, or neither (then it takes any). Nothing was changed.' }
    const inner = promotions
      ? { promotionDataSource: { targetCountry: req.targetCountry, contentLanguage: req.contentLanguage } }
      : { supplementalProductDataSource: req.feedLabel ? { feedLabel: req.feedLabel, contentLanguage: req.contentLanguage } : {} }
    const twin = facts.dataSources.find((d) => d.displayName === name)
    const kind = promotions ? 'promotion' : 'supplemental'
    const record = { action: req.action, merchantCenterId: facts.merchantCenterId, type: kind, displayName: name, feedLabel: req.feedLabel ?? null, contentLanguage: req.contentLanguage ?? null, targetCountry: req.targetCountry ?? null }
    return {
      summary: `Make a new ${promotions ? `promotion data source for ${req.targetCountry} (${req.contentLanguage})` : `supplemental product data source${req.feedLabel ? ` for ${req.contentLanguage}, ${req.feedLabel}` : ' (any language and feed label)'}`} named "${name}" (API input).`,
      changes: { 'data source': { from: '(none)', to: `${name} (${kind}, API)` } },
      totals: { dataSources: 1 },
      warnings: [
        promotions
          ? 'Promotions show only when the Merchant Center account takes part in the Promotions program (Merchant Center › Marketing › Promotions); Google reviews each promotion.'
          : LINK_IN_MERCHANT_CENTER,
        ...(twin ? [`Merchant Center already has a data source named "${name}" (${twin.dataSourceId}): the new one gets its own id.`] : []),
      ],
      spendsMoney: [],
      call: { method: 'POST', path, body: { displayName: name, ...inner } },
      stands: { names: facts.dataSources.map((d) => d.displayName).sort() },
      before: { ...record, dataSourceId: null, created: false },
      // `created` and the id are set when it ran (the id is Google's answer).
      after: { ...record, dataSourceId: null, created: false },
    }
  }

  const source = facts.dataSources.find((d) => d.dataSourceId === req.dataSourceId) ?? null
  if (!req.dataSourceId || !source) return { refusal: `Merchant Center has no data source ${req.dataSourceId ?? '(none named)'} (google-merchant-live view data-sources lists them). Nothing was changed.` }
  const where = `data source ${source.dataSourceId}${source.displayName ? ` ("${source.displayName}")` : ''}`
  const name = `${base}/${source.dataSourceId}`
  const record = { action: req.action, merchantCenterId: facts.merchantCenterId, dataSourceId: source.dataSourceId, type: source.type }

  if (req.action === 'fetch-now') {
    if (source.input !== 'FILE' || !source.file || (source.file.type !== 'FETCH' && source.file.type !== 'GOOGLE_SHEETS')) {
      return { refusal: `${where} is not a file data source Google fetches (its input is ${source.input ?? 'unknown'}${source.file?.type ? `, ${source.file.type}` : ''}): only a fetched file or a Google Sheet can be fetched now. Shopify's Google channel sends its products through the API, so its feed is never fetched. Nothing was changed.` }
    }
    return {
      summary: `Ask Google to fetch ${where} now (outside its schedule): its products are read again from the file${source.file.fetchHost ? ` on ${source.file.fetchHost}` : ''}.`,
      changes: { [`${where} fetch`]: { from: source.file.frequency ?? '(schedule)', to: 'now' } },
      totals: { dataSources: 1 },
      warnings: [
        'The file decides what the products become: a fetch cannot be undone.',
        'Google asks not to fetch a data source more than once a day (datasources_v1 dataSources.fetch).',
      ],
      spendsMoney: [`SPENDS MONEY: products the file adds or makes available again can show in Shopping ads after the fetch, and enabled campaigns pay for their clicks.`],
      call: { method: 'POST', path: `${path}/${source.dataSourceId}:fetch`, body: {} },
      stands: { id: source.dataSourceId, input: source.input, file: source.file },
      before: { ...record, fetched: false },
      after: { ...record, fetched: true },
    }
  }

  if (!facts.nexusMade.has(source.dataSourceId)) return { refusal: NOT_NEXUS_DATA_SOURCE(source.dataSourceId) }

  if (req.action === 'rename') {
    const to = req.displayName?.trim()
    if (!to) return { refusal: 'A rename needs the new name (displayName). Nothing was changed.' }
    if (to === source.displayName) return { refusal: `${where} is already named "${to}". Nothing was sent.` }
    return {
      summary: `Rename ${where} to "${to}".`,
      changes: { name: { from: source.displayName ?? '(none)', to } },
      totals: { dataSources: 1 },
      warnings: [],
      spendsMoney: [],
      call: { method: 'PATCH', path: `${path}/${source.dataSourceId}`, query: { updateMask: DATA_SOURCE_MASKS[0] }, body: { name, displayName: to } },
      stands: { id: source.dataSourceId, displayName: source.displayName },
      before: { ...record, displayName: source.displayName },
      after: { ...record, displayName: to },
    }
  }

  // delete — only when empty, and only when nothing links it (Google refuses a linked supplemental source).
  if (req.confirmDelete !== true) return { refusal: `Deleting ${where} needs confirmDelete: true (a deleted data source cannot come back; a new one gets a new id). Nothing was changed.` }
  if (source.type === 'supplemental' && source.linkedFrom.length) {
    return { refusal: `${where} is linked from primary data source ${source.linkedFrom.join(', ')}: Google refuses to delete a supplemental data source before every link is removed, and Nexus never changes the primary feed's rules. A person unlinks it in Merchant Center first. Nothing was changed.` }
  }
  const held = Math.max(facts.held, source.type === 'promotion' ? facts.livePromotions : 0)
  if (held > 0) {
    const what = source.type === 'promotion' ? 'promotion' : 'product input'
    const first = source.type === 'promotion'
      ? 'The Merchant API cannot delete a promotion (promotions_v1 has insert, get and list only), so a promotion data source that holds one stays; a person can delete it in Merchant Center'
      : `Delete ${held === 1 ? 'it' : 'them'} first (set-google-merchant-products action delete), or keep the data source`
    return { refusal: `${where} still holds ${held} ${what}${held === 1 ? '' : 's'}: Nexus deletes a data source it made only when it is empty. ${first}. Nothing was changed.` }
  }
  return {
    summary: `Delete ${where}, which Nexus made and which is empty.`,
    changes: { 'data source': { from: `${source.displayName ?? source.dataSourceId} (${source.type})`, to: '(deleted)' } },
    totals: { dataSources: 1 },
    warnings: ['A deleted data source cannot come back: a new one gets a new id.'],
    spendsMoney: [],
    call: { method: 'DELETE', path: `${path}/${source.dataSourceId}` },
    stands: { id: source.dataSourceId, type: source.type, linkedFrom: source.linkedFrom, held },
    before: { ...record, displayName: source.displayName, deleted: false },
    after: { ...record, displayName: source.displayName, deleted: true },
  }
}
