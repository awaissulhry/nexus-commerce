/**
 * Meta ads step 35 (2026-10-25) — the drafts of the item and feed changes (pure: built from the request and the live state
 * the tool read, without any call):
 *
 *   set-meta-catalog-items  create (CT-030, CT-052), update (CT-031–039, CT-041–044, CT-052), overrides (CT-100–102),
 *                           remove-overrides (CT-103), group-default (CT-054), and the undo of a create (its items deleted:
 *                           step 34's items delete rule). One items_batch / localized_items_batch request each: Meta takes
 *                           the batch as its own job (handles), answers per item (validation_status) and the run reads its
 *                           status (check_batch_request_status).
 *   set-meta-catalog-feed   create (CT-074, CT-077 at create, CT-078, CT-092, CT-094, CT-096, CT-097, CT-099, CT-104), change
 *                           (CT-075, CT-076, CT-077), labels (CT-090, CT-191 — D7), upload (CT-088, CT-089), rules (CT-083,
 *                           CT-084 = delete + create, CT-085), upload-schedule (CT-081), error-report (CT-087), and the undo
 *                           of a create (the feed it made deleted).
 *
 * Meta has no check (validate_only) for any of these: "Meta has no check for this change". Items reach buyers: what an item
 * shows changes in ads and shops at Meta's next ingest. SPENDS MONEY (step 34's rule: spendLine) when a change can widen what
 * catalog ads deliver — an item made in stock, an item back in stock or active again, back in catalog ads (`da`), an expiry
 * moved out — while something delivers on the catalog, or Nexus could not see all that may; that premise is in `stands`
 * (spendPremise), so a change approved while nothing delivered never runs after something started. A price is a MONEY
 * change for buyers (said), not ad spend.
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { NO_META_CHECK, spendLine, spendPremise, useWarnings } from './change-catalog-admin.js'
import type { CatalogUse } from './live-catalog-admin.js'
import type { FeedNow, FeedRuleNow, FeedSchedule, ItemNow } from './live-catalog-items.js'
import type { MetaCatalogKind } from '../../gateway/meta-catalog-rules.js'
import type { MetaCatalogEdge } from '../../gateway/meta.js'
import { csvCell, FEED_FILE, internalLabelsCell, META_D7_COLUMNS, META_RULE_ATTRIBUTES, metaRuleParamsProblem, type MetaOverrideType } from '../../gateway/meta-catalog-items-rules.js'
import { hostOf } from './catalog-rule.js'

type Line = [string, unknown, unknown]
type Fields = Record<string, unknown>

function request(step: number, label: string, objectId: string, objectKind: MetaCatalogKind, params: Record<string, string>, extra: Partial<MetaChangeRequest> & { operation: string; edge?: MetaCatalogEdge; undoable: boolean }): MetaChangeRequest {
  return { step, label, kind: 'ad', objectId, objectKind, params, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, ...extra }
}
const quoted = (name: string | null | undefined) => (name ? `"${name}" ` : '')
const draftOf = (d: Partial<MetaChangeDraft> & Pick<MetaChangeDraft, 'summary' | 'requests' | 'stands' | 'before' | 'after'>): MetaChangeDraft => ({
  changes: {}, totals: {}, warnings: [], spendsMoney: [], skipped: [], ...d,
})
const linesOf = (lines: Line[]) => {
  const { changes, more } = changeLines(lines)
  return { changes, ...(more ? { totals: { linesNotShown: more } } : {}) }
}
/** A batch request's sentence when Meta took it: its job's handle and how many items Meta refused at once (validation). */
export function batchDone(label: string) {
  return (result: { node: Record<string, unknown> | null }) => {
    const handles = Array.isArray(result.node?.handles) ? (result.node!.handles as unknown[]).filter((h) => typeof h === 'string') : []
    const statuses = Array.isArray(result.node?.validation_status) ? result.node!.validation_status as Array<Record<string, unknown>> : []
    const refused = statuses.filter((v) => Array.isArray(v.errors) && v.errors.length).length
    return handles.length
      ? `${label}: Meta took the batch as job ${handles[0]}${refused ? `; it refused ${refused} item(s) at once (batch.refusedByMeta says why)` : ''}. The job's status follows (nexusRead).`
      : `${label}: Meta answered no job: it ingested nothing${refused ? ` (it refused ${refused} item(s): batch.refusedByMeta)` : ''}.`
  }
}
/** One record of an items or localized batch (Meta's `{method, data[, localization]}`), the ONE place a batch verb is set. */
function batchRecord(verb: 'CREATE' | 'UPDATE' | 'DELETE', data: Fields, localization?: { type: MetaOverrideType; value: string }): Record<string, unknown> {
  return { method: verb, data, ...(localization ? { localization } : {}) }
}
/** Two values the same, as Meta's JSON writes them. */
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const shown = (v: unknown) => (v === undefined ? 'not read by Nexus' : v === null ? 'none' : typeof v === 'string' ? v : JSON.stringify(v))

/** The catalog a change names, as the preview words it. */
export interface CatalogNamed { catalogId: string; name: string | null }
const catalogWords = (c: CatalogNamed) => `catalog ${quoted(c.name)}(${c.catalogId})`

export const BUYERS_SEE_IT = 'Items reach buyers: what they show in this catalog\'s ads and shops changes at Meta\'s next ingest of the batch (usually minutes).'
export const BATCH_NOTE = 'Meta takes the batch as a job of its own and answers per item (its validation names each item it refused); the run reads the job\'s status once (check_batch_request_status: Finished means done; refused items were not saved).'
export const BATCH_LIMIT = 'Meta answers a catalog\'s batches at about 200 a hour (80014: wait and ask again).'
export const PRICE_IS_MONEY = 'MONEY: buyers see the new price in ads and shops at once (a price, not ad spend).'
/** Meta's codes a batch or a feed change may meet, in plain words (items_batch / product-feed "Error Codes"). */
const BATCH_EXPLAIN: Readonly<Record<string, string>> = { 80014: 'That is Meta\'s catalog batch limit (about 200 batches an hour for one catalog): Meta took nothing more; ask again later.' }
const FEED_DELETE_EXPLAIN: Readonly<Record<string, string>> = { 3964: 'Meta lets only an admin of the feed delete it: a person with admin rights on the catalog does it (Meta Business settings), or gives the system user that role.' }
export const REVIEW_AGAIN = 'A change of the title, description, images, brand, category or a custom label sends the item through Meta\'s review again: its ads can pause until it is approved (internal labels do not).'

const MONEY_FIELDS = new Set(['price', 'sale_price', 'sale_price_effective_date'])
const REVIEW_FIELDS = new Set(['title', 'description', 'rich_text_description', 'image', 'video', 'brand', 'google_product_category', 'fb_product_category', 'product_type', 'custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3', 'custom_label_4'])
const SELLABLE = new Set(['in stock', 'available for order'])

/** Does this field's change let the item show in more ads (back in stock, active again, back in catalog ads, a later expiry)? */
export function widens(field: string, from: unknown, to: unknown): boolean {
  if (field === 'availability') return SELLABLE.has(String(to)) && !SELLABLE.has(String(from))
  if (field === 'status') return to === 'active' && from !== 'active'
  if (field === 'disabled_capabilities') return Array.isArray(from) && from.includes('da') && Array.isArray(to) && !to.includes('da')
  if (field === 'expiration_date') return typeof to === 'string' && (typeof from !== 'string' || to > from)
  return false
}

/**
 * Review A-F3 — may this value, sent where Nexus did not read the item first (an update-only file), widen what ads show?
 * Each widening field by its own value (in stock, active, a hideFrom list without `da`, an expiry), and labels (they move
 * items into product sets).
 */
export function mayWiden(field: string, to: unknown): boolean {
  if (field === 'disabled_capabilities') return Array.isArray(to) && !to.includes('da')
  if (field === 'internal_label' || /^custom_label_[0-4]$/.test(field) || /^custom_number_[0-4]$/.test(field)) return true
  return widens(field, undefined, to)
}

/** A field's change in words, when it narrows what ads show (out of stock, archived, out of catalog ads, an expiry). */
function narrowsWords(field: string, to: unknown): string | null {
  if (field === 'availability' && !SELLABLE.has(String(to))) return 'out-of-stock and discontinued items do not show in ads (Meta)'
  if (field === 'status' && to === 'archived') return 'an archived item shows in no ad or shop'
  if (field === 'disabled_capabilities' && Array.isArray(to) && to.includes('da')) return 'an item kept off `da` stops showing in catalog ads'
  if (field === 'expiration_date') return 'after its expiration date the item shows nowhere on Facebook'
  return null
}

// ── set-meta-catalog-items: create ──────────────────────────────────────────────────────────────────────────────────

export interface ItemAsk { sku: string; fields: Fields }
export interface ItemsRecord {
  op: 'create' | 'update' | 'remove-made'
  catalogId: string
  /** create: the SKUs it made · update: each item's fields before / after · remove-made: the SKUs it deleted. */
  skus?: string[]
  items?: Array<{ sku: string; fields: Fields }>
  /** before only: the fields Nexus could not read exactly or Meta had none of (undo cannot set them back). */
  noUndo?: string[]
  undoOf?: string
}

export function itemsCreateDraft(input: { catalog: CatalogNamed; asked: ItemAsk[]; existing: ReadonlySet<string>; itemSubType?: string | null; use: CatalogUse }): MetaChangeDraft {
  const fresh = input.asked.filter((a) => !input.existing.has(a.sku))
  const skipped = input.asked.filter((a) => input.existing.has(a.sku)).map((a) => `${a.sku}: an item of this catalog already (Nexus read the catalog first): change it with action update.`)
  const catalog = catalogWords(input.catalog)
  const sellable = fresh.filter((a) => SELLABLE.has(String(a.fields.availability)))
  const spendsMoney = sellable.length ? spendLine(input.use, catalog, `${plural(sellable.length, 'new item')} in stock can show in its catalog ads, so they can deliver more`) : []
  const priced = fresh.some((a) => a.fields.price !== undefined)
  return draftOf({
    summary: `Add ${plural(fresh.length, 'item')} to ${catalog}`,
    ...linesOf(fresh.map((a): Line => [`Item ${a.sku}`, null, `${String(a.fields.title ?? '')} — ${String(a.fields.availability ?? '')}`])),
    totals: { items: fresh.length },
    skipped,
    warnings: [
      BUYERS_SEE_IT,
      'Meta reviews every new item before it shows in ads or shops, and fetches its images later (a broken address leaves it without an image).',
      ...(priced ? ['The price of each new item is what buyers see once it is approved.'] : []),
      'Nexus is this catalog\'s writer: never connect a feed to the same items (Meta: never mix feed items with API item writes — a full feed upload would undo them).',
      ...useWarnings(input.use, catalog),
      BATCH_NOTE, BATCH_LIMIT, NO_META_CHECK,
    ],
    spendsMoney,
    requests: fresh.length ? [request(1, `Add ${plural(fresh.length, 'item')} to ${catalog}`, input.catalog.catalogId, 'catalogitems', {
      item_type: 'PRODUCT_ITEM',
      requests: JSON.stringify(fresh.map((a) => batchRecord('CREATE', { id: a.sku, ...a.fields }))),
      allow_upsert: 'false',
      ...(input.itemSubType ? { item_sub_type: input.itemSubType } : {}),
    }, { operation: 'catalog.items.write', edge: 'items_batch', undoable: false, explain: BATCH_EXPLAIN, raisesSpend: spendsMoney.length > 0, doneSentence: batchDone(`Add ${plural(fresh.length, 'item')}`) })] : [],
    stands: { catalogId: input.catalog.catalogId, absent: fresh.map((a) => a.sku).sort(), uses: spendPremise(input.use) },
    before: { op: 'create', catalogId: input.catalog.catalogId, skus: [] } satisfies ItemsRecord,
    after: { op: 'create', catalogId: input.catalog.catalogId, skus: fresh.map((a) => a.sku) } satisfies ItemsRecord,
  })
}

// ── set-meta-catalog-items: update ──────────────────────────────────────────────────────────────────────────────────

export function itemsUpdateDraft(input: { catalog: CatalogNamed; asked: ItemAsk[]; now: ReadonlyMap<string, ItemNow>; use: CatalogUse; why?: 'asked' | 'undo' }): MetaChangeDraft {
  const catalog = catalogWords(input.catalog)
  const skipped: string[] = []
  const lines: Line[] = []
  const changes: Array<{ sku: string; data: Fields; before: Fields }> = []
  const noUndo: string[] = []
  const widened: string[] = []
  const narrowed = new Set<string>()
  let money = false
  let review = false
  for (const a of input.asked) {
    const now = input.now.get(a.sku)
    if (!now) { skipped.push(`${a.sku}: not an item of this catalog now (Nexus read it first; an update never makes an item: action create does).`); continue }
    const data: Fields = {}
    const before: Fields = {}
    for (const [field, to] of Object.entries(a.fields)) {
      const from = now.state[field]
      if (from !== undefined && sameValue(from, to)) { skipped.push(`${a.sku}: ${field} is like that already.`); continue }
      data[field] = to
      before[field] = from
      lines.push([`${a.sku}: ${field}`, shown(from), shown(to)])
      if (from === undefined) noUndo.push(field === 'video' ? `${a.sku}: Nexus cannot read an item's videos, so undo cannot set them back or clear them (Meta clears videos with an empty list; Nexus sends none).` : `${a.sku}: Nexus cannot read ${field} back exactly, so undo cannot set it back.`)
      else if (from === null) noUndo.push(`${a.sku}: it had no ${field}; Meta documents no way to clear one through the API, so undo leaves it.`)
      if (widens(field, from, to)) widened.push(`${a.sku} (${field})`)
      const words = narrowsWords(field, to)
      if (words) narrowed.add(words)
      if (MONEY_FIELDS.has(field)) money = true
      if (REVIEW_FIELDS.has(field)) review = true
    }
    if (Object.keys(data).length) changes.push({ sku: a.sku, data, before })
  }
  const spendsMoney = widened.length ? spendLine(input.use, catalog, `${widened.join(', ')} can show in its catalog ads again, so they can deliver more`) : []
  return draftOf({
    summary: input.why === 'undo' ? `Put ${plural(changes.length, 'item')} of ${catalog} back as they were` : `Change ${plural(changes.length, 'item')} of ${catalog}`,
    ...linesOf(lines),
    totals: { items: changes.length, fields: lines.length },
    skipped,
    warnings: [
      BUYERS_SEE_IT,
      ...(money ? [PRICE_IS_MONEY] : []),
      ...(review ? [REVIEW_AGAIN] : []),
      ...[...narrowed].map((w) => `Fewer ads: ${w}.`),
      ...(widened.length || narrowed.size ? useWarnings(input.use, catalog) : []),
      'Meta updates only the fields sent (allow_upsert is false: an item that is gone is not made again).',
      BATCH_NOTE, BATCH_LIMIT, NO_META_CHECK,
    ],
    spendsMoney,
    requests: changes.length ? [request(1, `${input.why === 'undo' ? 'Put back' : 'Change'} ${plural(changes.length, 'item')} of ${catalog}`, input.catalog.catalogId, 'catalogitems', {
      item_type: 'PRODUCT_ITEM',
      requests: JSON.stringify(changes.map((c) => batchRecord('UPDATE', { id: c.sku, ...c.data }))),
      allow_upsert: 'false',
    }, { operation: 'catalog.items.write', edge: 'items_batch', undoable: true, explain: BATCH_EXPLAIN, raisesSpend: spendsMoney.length > 0, doneSentence: batchDone(`Change ${plural(changes.length, 'item')}`) })] : [],
    stands: { catalogId: input.catalog.catalogId, before: changes.map((c) => ({ sku: c.sku, before: c.before })), uses: spendPremise(input.use) },
    before: { op: 'update', catalogId: input.catalog.catalogId, items: changes.map((c) => ({ sku: c.sku, fields: c.before })), ...(noUndo.length ? { noUndo } : {}) } satisfies ItemsRecord,
    after: { op: 'update', catalogId: input.catalog.catalogId, items: changes.map((c) => ({ sku: c.sku, fields: c.data })) } satisfies ItemsRecord,
  })
}

// ── set-meta-catalog-items: the undo of a create (its items deleted) ────────────────────────────────────────────────

export function itemsRemoveMadeDraft(input: { catalog: CatalogNamed; skus: string[]; found: ReadonlyMap<string, ItemNow>; use: CatalogUse; undoOf: string }): MetaChangeDraft {
  const found = input.skus.filter((sku) => input.found.has(sku))
  const catalog = catalogWords(input.catalog)
  return draftOf({
    summary: `Delete the ${plural(found.length, 'item')} an earlier set-meta-catalog-items create made in ${catalog} (its undo)`,
    ...linesOf(found.map((sku): Line => [`Item ${sku}`, input.found.get(sku)?.name ?? 'exists', 'DELETED'])),
    totals: { items: found.length },
    skipped: input.skus.filter((sku) => !input.found.has(sku)).map((sku) => `${sku}: not an item of this catalog now: nothing to delete.`),
    warnings: ['DELETING IS FINAL: Meta keeps nothing to restore (only these items, the ones that change made).', 'Their ads stop, and product sets that held them get smaller.', ...useWarnings(input.use, catalog), BATCH_NOTE, NO_META_CHECK],
    requests: found.length ? [request(1, `Delete ${plural(found.length, 'item')} from ${catalog}`, input.catalog.catalogId, 'catalog', {
      item_type: 'PRODUCT_ITEM', requests: JSON.stringify(found.map((sku) => batchRecord('DELETE', { id: sku }))), allow_upsert: 'false',
    }, { operation: 'catalog.items.delete', edge: 'items_batch', undoable: false, explain: BATCH_EXPLAIN, doneSentence: batchDone(`Delete ${plural(found.length, 'item')}`) })] : [],
    stands: { catalogId: input.catalog.catalogId, found: found.sort() },
    before: { op: 'remove-made', catalogId: input.catalog.catalogId, skus: found, undoOf: input.undoOf } satisfies ItemsRecord,
    after: { op: 'remove-made', catalogId: input.catalog.catalogId, skus: found, undoOf: input.undoOf } satisfies ItemsRecord,
  })
}

// ── set-meta-catalog-items: overrides ───────────────────────────────────────────────────────────────────────────────

export interface OverrideAsk { sku: string; type: MetaOverrideType; value: string; fields?: Fields; remove?: true }
export interface OverridesRecord {
  op: 'overrides'
  catalogId: string
  entries: Array<{ sku: string; type: MetaOverrideType; value: string; existed: boolean; fields: Fields | null }>
  noUndo?: string[]
}
const overrideKey = (o: { sku: string; type: string; value: string }) => `${o.sku}|${o.type}|${o.value}`
const overrideWords = (o: { sku: string; type: MetaOverrideType; value: string }) => `${o.sku} ${o.type === 'COUNTRY' ? 'in' : o.type === 'LANGUAGE' ? 'in language' : 'in'} ${o.value}`

/** An override's fields as a preview shows them: its money fields only to a person who may see revenue (review A-F2). */
function overrideShown(fields: Fields, mayMoney: boolean): string {
  return JSON.stringify(mayMoney ? fields : Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, MONEY_FIELDS.has(k) ? 'hidden (revenue view)' : v])))
}

export function overridesDraft(input: { catalog: CatalogNamed; asked: OverrideAsk[]; items: ReadonlySet<string>; now: ReadonlyMap<string, Fields | null>; use: CatalogUse; why?: 'asked' | 'undo'; mayMoney?: boolean }): MetaChangeDraft {
  const catalog = catalogWords(input.catalog)
  const mayMoney = input.mayMoney !== false
  const skipped: string[] = []
  const lines: Line[] = []
  const records: Array<Record<string, unknown>> = []
  const before: OverridesRecord['entries'] = []
  const after: OverridesRecord['entries'] = []
  const noUndo: string[] = []
  const widened: string[] = []
  let money = false
  for (const o of input.asked) {
    if (!input.items.has(o.sku)) { skipped.push(`${o.sku}: not an item of this catalog now (an override needs the item: Meta's localized batch makes none).`); continue }
    const key = overrideKey(o)
    const now = input.now.has(key) ? input.now.get(key)! : null
    if (o.remove) {
      if (!now) { skipped.push(`${overrideWords(o)}: no such override now: nothing to remove.`); continue }
      records.push(batchRecord('DELETE', { id: o.sku }, { type: o.type, value: o.value }))
      lines.push([`${overrideWords(o)}`, overrideShown(now, mayMoney), 'removed (the item\'s own values show)'])
      // A country price taken off: buyers there see the item's own price (a money change). An out-of-stock country value
      // taken off: the item's own availability shows there — it can be back in stock in that country's ads (review A-F3).
      if (Object.keys(now).some((k) => MONEY_FIELDS.has(k))) money = true
      if (o.type === 'COUNTRY' && now.availability !== undefined && !SELLABLE.has(String(now.availability))) widened.push(`${overrideWords(o)} (its out-of-stock override taken off)`)
      before.push({ sku: o.sku, type: o.type, value: o.value, existed: true, fields: now })
      after.push({ sku: o.sku, type: o.type, value: o.value, existed: false, fields: null })
      continue
    }
    const data: Fields = {}
    const old: Fields = {}
    for (const [field, to] of Object.entries(o.fields ?? {})) {
      const from = now?.[field]
      if (from !== undefined && sameValue(from, to)) { skipped.push(`${overrideWords(o)}: ${field} is like that already.`); continue }
      data[field] = to
      old[field] = from ?? null
      const masked = (v: unknown) => (!mayMoney && MONEY_FIELDS.has(field) && v !== null && v !== undefined ? 'hidden (revenue view)' : shown(v))
      lines.push([`${overrideWords(o)}: ${field}`, now ? masked(from ?? null) : 'no override (the item\'s own value)', masked(to)])
      if (now && (from === undefined || from === null)) noUndo.push(`${overrideWords(o)}: the override had no ${field}; Meta documents no way to clear one field of an override, so undo leaves it.`)
      if (MONEY_FIELDS.has(field)) money = true
      if (field === 'availability' && SELLABLE.has(String(to)) && !SELLABLE.has(String(from))) widened.push(overrideWords(o))
    }
    if (!Object.keys(data).length) continue
    records.push(batchRecord('UPDATE', { id: o.sku, ...data }, { type: o.type, value: o.value }))
    before.push({ sku: o.sku, type: o.type, value: o.value, existed: !!now, fields: now ? old : null })
    after.push({ sku: o.sku, type: o.type, value: o.value, existed: true, fields: data })
  }
  const spendsMoney = widened.length ? spendLine(input.use, catalog, `${widened.join(', ')} can show in its catalog ads again, so they can deliver more`) : []
  return draftOf({
    summary: input.why === 'undo' ? `Put ${plural(records.length, 'override')} of ${catalog} back as they were` : `Set ${plural(records.length, 'country or language override', 'country or language overrides')} of ${catalog}`,
    ...linesOf(lines),
    totals: { overrides: records.length },
    skipped,
    warnings: [
      BUYERS_SEE_IT,
      'A country override shows its price, availability and link to buyers in that country; a language override its text to people who use that language (language + country first, then language, then country).',
      ...(money ? [PRICE_IS_MONEY] : []),
      ...(widened.length ? useWarnings(input.use, catalog) : []),
      'Meta\'s localized batch changes overrides only: it never makes an item.',
      BATCH_NOTE, BATCH_LIMIT, NO_META_CHECK,
    ],
    spendsMoney,
    requests: records.length ? [request(1, `${input.why === 'undo' ? 'Put back' : 'Set'} ${plural(records.length, 'override')} of ${catalog}`, input.catalog.catalogId, 'catalogitems', {
      item_type: 'PRODUCT_ITEM', requests: JSON.stringify(records),
    }, { operation: 'catalog.items.localize', edge: 'localized_items_batch', undoable: true, explain: BATCH_EXPLAIN, raisesSpend: spendsMoney.length > 0, doneSentence: batchDone(`Set ${plural(records.length, 'override')}`) })] : [],
    stands: { catalogId: input.catalog.catalogId, before, uses: spendPremise(input.use) },
    before: { op: 'overrides', catalogId: input.catalog.catalogId, entries: before, ...(noUndo.length ? { noUndo } : {}) } satisfies OverridesRecord,
    after: { op: 'overrides', catalogId: input.catalog.catalogId, entries: after } satisfies OverridesRecord,
  })
}

// ── set-meta-catalog-items: an item group's default item ────────────────────────────────────────────────────────────

export function groupDefaultDraft(input: { catalog: CatalogNamed; groupId: string; groupSku: string | null; itemId: string }): MetaChangeDraft {
  const group = `item group ${input.groupSku ? `"${input.groupSku}" ` : ''}(${input.groupId})`
  return draftOf({
    summary: `Make item ${input.itemId} the default of ${group} in ${catalogWords(input.catalog)}`,
    ...linesOf([[`Default item of ${group}`, 'as Meta has it (Nexus cannot read it)', input.itemId]]),
    warnings: [
      'The default item is the variant Meta shows first for the group in ads and shops.',
      'Meta documents this call in its SDK only (the group page is not found): Meta\'s answer decides (LIVE-PROBES CT35-02).',
      'Meta lets Nexus read no group\'s default item, so undo cannot put the earlier one back: set it again with this action if needed.',
      NO_META_CHECK,
    ],
    requests: [request(1, `Make item ${input.itemId} the default of ${group}`, input.groupId, 'productgroup', { default_product_id: input.itemId }, { operation: 'productgroup.default', undoable: false, readBackFields: 'id,retailer_id', expect: {} })],
    stands: { groupId: input.groupId, itemId: input.itemId },
    before: { op: 'group-default', catalogId: input.catalog.catalogId, groupId: input.groupId, itemId: null },
    after: { op: 'group-default', catalogId: input.catalog.catalogId, groupId: input.groupId, itemId: input.itemId },
  })
}

/** remove-meta-catalog-items kind item-group (CT-055): always ONLY_IF_EMPTY unless the person asked for its items too. */
export function groupDeleteDraft(input: { catalog: CatalogNamed; groupId: string; groupSku: string | null; items: number; more: boolean; withItems: boolean; use: CatalogUse }): MetaChangeDraft {
  const group = `item group ${input.groupSku ? `"${input.groupSku}" ` : ''}(${input.groupId})`
  const catalog = catalogWords(input.catalog)
  return draftOf({
    summary: input.withItems ? `Delete ${group} of ${catalog} WITH its ${input.more ? 'more than 500' : input.items} item(s)` : `Delete ${group} of ${catalog} if it is empty`,
    ...linesOf([[`Group ${input.groupId}`, `${input.more ? 'more than 500' : input.items} item(s)`, input.withItems ? 'DELETED with its items' : 'DELETED only if empty']]),
    totals: { items: input.items },
    warnings: [
      'DELETING IS FINAL: Meta keeps nothing to restore.',
      input.withItems
        ? `alsoItems: Nexus sends deletion_method=DELETE_ITEMS, so every item of the group goes too and their ads stop.`
        : `Nexus sends deletion_method=ONLY_IF_EMPTY: Meta deletes the group only when it holds no item${input.items ? ` (it holds ${input.items} now, so Meta refuses unless they go first)` : ''}.`,
      ...(input.withItems ? useWarnings(input.use, catalog) : []),
      'Meta documents this call in its SDK only (the group page is not found): Meta\'s answer decides (LIVE-PROBES CT35-01).',
      NO_META_CHECK,
    ],
    requests: [request(1, `Delete ${group}`, input.groupId, 'productgroup', { deletion_method: input.withItems ? 'DELETE_ITEMS' : 'ONLY_IF_EMPTY' }, { operation: 'productgroup.delete', method: 'DELETE', undoable: false })],
    stands: { groupId: input.groupId, items: input.items, more: input.more, withItems: input.withItems, ...(input.withItems ? { uses: spendPremise(input.use) } : {}) },
    before: { op: 'remove', kind: 'item-group', catalogId: input.catalog.catalogId, ids: [input.groupId] },
    after: { op: 'remove', kind: 'item-group', catalogId: input.catalog.catalogId, ids: [input.groupId] },
  })
}

// ── set-meta-catalog-feed ───────────────────────────────────────────────────────────────────────────────────────────

export type FeedKind = 'products' | 'supplementary' | 'offers' | 'ratings' | 'local-inventory' | 'country' | 'language' | 'language-and-country'
export const FEED_KINDS: readonly FeedKind[] = ['products', 'supplementary', 'offers', 'ratings', 'local-inventory', 'country', 'language', 'language-and-country']
const FEED_TYPE_OF: Partial<Record<FeedKind, string>> = { products: 'PRODUCTS', offers: 'OFFER', ratings: 'PRODUCT_RATINGS_AND_REVIEWS', 'local-inventory': 'LOCAL_INVENTORY' }
const OVERRIDE_OF: Partial<Record<FeedKind, string>> = { country: 'COUNTRY', language: 'LANGUAGE', 'language-and-country': 'LANGUAGE_AND_COUNTRY' }
const FEED_WORDS: Readonly<Record<FeedKind, string>> = {
  products: 'a primary feed of items', supplementary: 'Nexus\'s own supplementary feed (it only adds fields to the items its primary sources bring)', offers: 'an offers feed',
  ratings: 'a ratings & reviews feed', 'local-inventory': 'a local inventory feed', country: 'a country override feed', language: 'a language override feed', 'language-and-country': 'a language + country override feed',
}

/** A schedule as Meta takes it (JSON in Nexus's one spelling: the keys in Meta's order). */
export function scheduleParam(s: FeedSchedule): string {
  const out: Record<string, unknown> = { interval: s.interval, url: s.url }
  for (const k of ['interval_count', 'hour', 'minute', 'day_of_week', 'day_of_month', 'timezone'] as const) if (s[k] !== undefined) out[k] = s[k]
  return JSON.stringify(out)
}
/** A schedule as a person reads it: its rhythm and the host of its address (an address may hold a key). */
export function scheduleWords(s: FeedSchedule | null | undefined): string {
  if (!s) return 'none'
  const when = [s.interval?.toLowerCase(), s.day_of_week ? `on ${s.day_of_week.toLowerCase()}` : '', s.day_of_month ? `on day ${s.day_of_month}` : '', s.hour !== undefined ? `at ${String(s.hour).padStart(2, '0')}:${String(s.minute ?? 0).padStart(2, '0')}${s.timezone ? ` ${s.timezone}` : ' Pacific time (Meta\'s default)'}` : ''].filter(Boolean).join(' ')
  return `${when || 'a schedule'} from ${hostOf(s.url) ?? 'an address'}`
}

export interface FeedRuleAsk { attribute: string; ruleType: string; params: Record<string, unknown> }
export const ruleParam = (r: FeedRuleAsk) => JSON.stringify(r.params)
/** `rules` at a feed's create: Meta's list<JSON-encoded string> — each rule its own JSON string (review B-F2). */
export const createRulesParam = (rules: readonly FeedRuleAsk[]) => JSON.stringify(rules.map((r) => JSON.stringify({ attribute: r.attribute, rule_type: r.ruleType, params: r.params })))
/** Supplementary-feed fields (catalog/reference "This field is supported by supplementary feeds"): custom_label_0–4 only of the D7 columns (review B-F3). */
export const SUPPLEMENTARY_UNLISTED = 'Meta lists custom_label_0–4 as fields a supplementary feed supports; internal_label and custom_number_0–4 are not on its list: Meta\'s answer and the item read afterwards decide (LIVE-PROBES CT35-04). The update-only file to the Shopify feed (via shopify-feed) is the documented way for every D7 column.'

export interface FeedCreateAsk {
  kind: FeedKind
  name: string
  schedule?: FeedSchedule
  updateSchedule?: FeedSchedule
  country?: string
  defaultCurrency?: string
  deletionEnabled?: boolean
  delimiter?: string
  encoding?: string
  quotedFieldsMode?: string
  itemSubType?: string
  migratedFromFeedId?: string
  primaryFeedIds?: string[]
  rules?: FeedRuleAsk[]
}
export interface FeedRecord {
  op: 'create' | 'change' | 'remove-made' | 'labels' | 'upload' | 'rules' | 'upload-schedule' | 'error-report'
  catalogId: string
  feedId?: string | null
  kind?: FeedKind
  fields?: Fields
  items?: Array<{ sku: string; fields: Fields }>
  rules?: Array<{ ruleId: string | null; attribute: string | null; ruleType: string | null; params: Record<string, unknown> | null }>
  uploadId?: string | null
  noUndo?: string[]
  undoOf?: string
}

export function feedCreateDraft(input: { catalog: CatalogNamed; ask: FeedCreateAsk; use: CatalogUse; d7: boolean }): MetaChangeDraft {
  const { ask } = input
  const catalog = catalogWords(input.catalog)
  const supplementary = ask.kind === 'supplementary'
  const params: Record<string, string> = { name: ask.name }
  if (supplementary) {
    params.ingestion_source_type = 'SUPPLEMENTARY_FEED'
    params.primary_feed_ids = JSON.stringify(ask.primaryFeedIds ?? [])
  } else {
    if (FEED_TYPE_OF[ask.kind]) params.feed_type = FEED_TYPE_OF[ask.kind]!
    if (OVERRIDE_OF[ask.kind]) params.override_type = OVERRIDE_OF[ask.kind]!
    params.deletion_enabled = ask.deletionEnabled === true ? 'true' : 'false'
    if (ask.schedule) params.schedule = scheduleParam(ask.schedule)
    if (ask.updateSchedule) params.update_schedule = scheduleParam(ask.updateSchedule)
    if (ask.country) params.country = ask.country
    if (ask.defaultCurrency) params.default_currency = ask.defaultCurrency
    if (ask.delimiter) params.delimiter = ask.delimiter
    if (ask.encoding) params.encoding = ask.encoding
    if (ask.quotedFieldsMode) params.quoted_fields_mode = ask.quotedFieldsMode
    if (ask.itemSubType) params.item_sub_type = ask.itemSubType
    if (ask.migratedFromFeedId) params.migrated_from_feed_id = ask.migratedFromFeedId
  }
  if (ask.rules?.length) params.rules = createRulesParam(ask.rules)
  const brings = !supplementary && !OVERRIDE_OF[ask.kind]
  // Review A-F3 — a fetch of either kind (full or update-only) brings items, and so does a feed that takes over items.
  const spendsMoney = brings && (ask.schedule || ask.updateSchedule || ask.migratedFromFeedId) ? spendLine(input.use, catalog, 'the feed\'s items can show in its catalog ads once Meta fetches them, so they can deliver more') : []
  const lines: Line[] = [
    ['Feed', null, `${ask.name} — ${FEED_WORDS[ask.kind]}`],
    ...(params.schedule ? [['Fetch (full replace)', null, scheduleWords(ask.schedule)] as Line] : []),
    ...(params.update_schedule ? [['Fetch (add and update only)', null, scheduleWords(ask.updateSchedule)] as Line] : []),
    ...(supplementary ? [['Adds fields to the primary sources', null, (ask.primaryFeedIds ?? []).join(', ')] as Line] : []),
    ...(brings ? [['Deletes items missing from a full file (deletion_enabled)', null, params.deletion_enabled] as Line] : []),
    ...(params.migrated_from_feed_id ? [['Takes over items of feed', null, params.migrated_from_feed_id] as Line] : []),
    ...(ask.rules ?? []).map((r): Line => [`Rule on ${r.attribute}`, null, `${r.ruleType} ${JSON.stringify(r.params)}`]),
  ]
  const warnings = [
    ...(supplementary ? [
      'It adds Nexus\'s labels (internal_label, custom_label_0…4, custom_number_0…4) to the items of those sources; it cannot add or remove an item. Nexus writes into it only with labels files (action labels via own-feed); it fetches nothing on a schedule.',
      'A primary source takes at most one supplementary feed (Meta): if Shopify\'s already has one, Meta refuses.',
      'Meta\'s Feed API writes SUPPLEMENTARY_FEED, its SDK supplementary_feed: Meta\'s answer decides the spelling (LIVE-PROBES CT35-04).',
      SUPPLEMENTARY_UNLISTED,
    ] : []),
    ...(brings && params.deletion_enabled === 'true' ? ['deletion_enabled is ON: every full upload deletes the items missing from its file, and Meta NEVER lets it be turned off again (CT-077).'] : []),
    ...(brings && params.deletion_enabled === 'false' ? ['deletion_enabled is sent off (Meta\'s default is on): a full upload then leaves items missing from the file in the catalog. Turning it on later is one-way.'] : []),
    ...(brings ? ['Never point this feed at items Nexus writes through items_batch (Meta: one writer per item).'] : []),
    ...(ask.kind === 'ratings' ? ['Only the business\'s own real reviews may go in it (CSV per Meta\'s review schema). Meta says reviews show together with products on its surfaces (Shops); it states nowhere that stars show in catalog ads, so Nexus promises none (LIVE-PROBES CT35-15).'] : []),
    ...(ask.kind === 'offers' ? ['An offers feed shows discounts on the catalog\'s items on Facebook and Instagram (redeemable in the app only for checkout sellers). Meta may need to enable it for the business: its answer decides.'] : []),
    ...(ask.kind === 'local-inventory' ? ['A local inventory feed is for a business with physical shops whose locations are on the Facebook Page (store codes): without them Meta refuses it.'] : []),
    ...(OVERRIDE_OF[ask.kind] ? ['An override feed carries per-country or per-language values for items the catalog has (its file has an id and an override column): it brings no new item. Meta\'s guide writes override_type in lower case, its reference in upper case: Meta\'s answer decides (LIVE-PROBES CT35-05).'] : []),
    ...(params.schedule ? ['Meta fetches the file at most once an hour (time in Pacific time unless a time zone is given).'] : []),
    ...(input.d7 ? ['Shopify (or another source) writes this catalog\'s items: Nexus only adds its D7 labels here (D7).'] : []),
    ...(spendsMoney.length ? useWarnings(input.use, catalog) : []),
    'Undo deletes the feed it made (Meta: deleting a feed disables every ad of the items it brought).',
    NO_META_CHECK,
  ]
  return draftOf({
    summary: `Make ${FEED_WORDS[ask.kind]} "${ask.name}" in ${catalog}`,
    ...linesOf(lines),
    warnings,
    spendsMoney,
    requests: [request(1, `Make feed "${ask.name}" in ${catalog}`, input.catalog.catalogId, 'catalogfeeds', params, {
      operation: 'catalog.feed.create', edge: 'product_feeds', undoable: false, raisesSpend: spendsMoney.length > 0, expect: { name: ask.name },
      readBackFields: 'id,name,ingestion_source_type,override_type,deletion_enabled,product_count', recordEvenIfNotAsAsked: true,
    })],
    stands: { catalogId: input.catalog.catalogId, kind: ask.kind, primaries: [...(ask.primaryFeedIds ?? [])].sort(), uses: spendPremise(input.use) },
    before: { op: 'create', catalogId: input.catalog.catalogId, feedId: null, kind: ask.kind } satisfies FeedRecord,
    after: { op: 'create', catalogId: input.catalog.catalogId, feedId: null, kind: ask.kind, fields: { name: ask.name } } satisfies FeedRecord,
  })
}

/** The undo of a feed's create: the feed that change made, deleted. */
export function feedRemoveMadeDraft(input: { catalog: CatalogNamed; feed: FeedNow; undoOf: string; money?: boolean }): MetaChangeDraft {
  const name = `feed ${quoted(input.feed.name)}(${input.feed.feedId})`
  return draftOf({
    summary: `Delete ${name} of ${catalogWords(input.catalog)} (the undo of the change that made it)`,
    ...linesOf([[`Feed ${input.feed.feedId}`, `${input.feed.name ?? 'exists'} (${input.feed.productCount ?? '?'} items)`, 'DELETED']]),
    warnings: [
      'DELETING IS FINAL: Meta keeps nothing to restore.',
      input.feed.supplementary ? 'A supplementary feed only adds fields: the labels it added go with it (the items stay).' : `Meta: deleting a feed "effectively disables all ads using products that come from this feed" (${input.feed.productCount ?? 'an unknown number of'} item(s)).`,
      'Meta lets only a feed admin delete it (else 3964).',
      // Re-review NF2 — an offers, local-inventory or country override feed carries what buyers pay.
      ...(input.money ? ['MONEY: the discounts, store prices or country prices this feed carried go with it — buyers see the items\' own prices again (a price, not ad spend).'] : []),
      NO_META_CHECK,
    ],
    requests: [request(1, `Delete ${name}`, input.feed.feedId, 'catalogfeed', {}, { operation: 'catalog.feed.delete.made', method: 'DELETE', undoable: false, parent: { kind: 'catalog', id: input.catalog.catalogId }, explain: FEED_DELETE_EXPLAIN })],
    stands: { feedId: input.feed.feedId, catalogId: input.catalog.catalogId },
    before: { op: 'remove-made', catalogId: input.catalog.catalogId, feedId: input.feed.feedId, undoOf: input.undoOf } satisfies FeedRecord,
    after: { op: 'remove-made', catalogId: input.catalog.catalogId, feedId: input.feed.feedId, undoOf: input.undoOf } satisfies FeedRecord,
  })
}

export interface FeedChangeAsk { name?: string; schedule?: FeedSchedule; updateSchedule?: FeedSchedule; defaultCurrency?: string; delimiter?: string; encoding?: string; quotedFieldsMode?: string; migratedFromFeedId?: string; deletionEnabled?: true }

/** The fields of a feed as a change records and compares them (Meta's write names). */
export function feedFieldsOf(feed: FeedNow): Fields {
  return {
    name: feed.name, schedule: feed.schedule, update_schedule: feed.updateSchedule, default_currency: feed.defaultCurrency, delimiter: feed.delimiter,
    encoding: feed.encoding, quoted_fields_mode: feed.quotedFieldsMode, deletion_enabled: feed.deletionEnabled,
  }
}

export function feedChangeDraft(input: { catalog: CatalogNamed; feed: FeedNow; ask: FeedChangeAsk; use: CatalogUse; why?: 'asked' | 'undo' }): MetaChangeDraft {
  const { feed, ask } = input
  const now = feedFieldsOf(feed)
  const params: Record<string, string> = {}
  const lines: Line[] = []
  const skipped: string[] = []
  const noUndo: string[] = []
  const before: Fields = {}
  const after: Fields = {}
  const set = (key: string, to: unknown, param: string, words: (v: unknown) => string = shown) => {
    if (sameValue(now[key], to)) { skipped.push(`${key} is like that already.`); return }
    params[key] = param
    before[key] = now[key] ?? null
    after[key] = to
    lines.push([key, words(now[key]), words(to)])
    if (now[key] === null || now[key] === undefined) noUndo.push(key === 'schedule' || key === 'update_schedule' ? `The feed had no ${key}; Meta documents no way to remove one, so undo leaves it.` : `The feed had no ${key} Nexus could read; undo leaves it.`)
  }
  if (ask.name !== undefined) set('name', ask.name, ask.name)
  if (ask.schedule) set('schedule', ask.schedule, scheduleParam(ask.schedule), (v) => scheduleWords(v as FeedSchedule | null))
  if (ask.updateSchedule) set('update_schedule', ask.updateSchedule, scheduleParam(ask.updateSchedule), (v) => scheduleWords(v as FeedSchedule | null))
  if (ask.defaultCurrency) set('default_currency', ask.defaultCurrency, ask.defaultCurrency)
  if (ask.delimiter) set('delimiter', ask.delimiter, ask.delimiter)
  if (ask.encoding) set('encoding', ask.encoding, ask.encoding)
  if (ask.quotedFieldsMode) set('quoted_fields_mode', ask.quotedFieldsMode, ask.quotedFieldsMode)
  if (ask.migratedFromFeedId) { params.migrated_from_feed_id = ask.migratedFromFeedId; lines.push(['Takes over items of feed', null, ask.migratedFromFeedId]); noUndo.push('Items taken over from another feed stay with this one: Meta documents no way to move them back.') }
  if (ask.deletionEnabled) {
    if (feed.deletionEnabled === true) skipped.push('deletion_enabled is on already.')
    else { params.deletion_enabled = 'true'; lines.push(['Deletes items missing from a full file (deletion_enabled)', shown(feed.deletionEnabled), 'true']); after.deletion_enabled = true; noUndo.push('deletion_enabled cannot be turned off again (Meta: "Once enabled, we do not allow this field to be disabled").') }
  }
  // A schedule that starts fetching (or fetches from elsewhere) can bring items into delivering catalog ads.
  const fetches = params.schedule !== undefined || params.update_schedule !== undefined || params.migrated_from_feed_id !== undefined
  const spendsMoney = fetches ? spendLine(input.use, catalogWords(input.catalog), 'the items its fetches bring can show in catalog ads, so they can deliver more') : []
  const name = `feed ${quoted(feed.name)}(${feed.feedId})`
  const expect: Record<string, string> = {}
  if (params.name) expect.name = params.name
  return draftOf({
    summary: input.why === 'undo' ? `Put ${name} back as it was` : `Change ${name} of ${catalogWords(input.catalog)}`,
    ...linesOf(lines),
    skipped,
    warnings: [
      ...(params.deletion_enabled ? ['ONE-WAY: deletion_enabled turns on for good — every later full upload deletes the items missing from its file.'] : []),
      ...(params.schedule ? ['A full-replace schedule: each fetch replaces the feed\'s items with the file (with deletion on, missing items are deleted).'] : []),
      ...(params.update_schedule ? ['An update-only schedule: each fetch adds and updates items, never deletes.'] : []),
      'A feed\'s country, type, source type (primary / supplementary) and override type cannot change: make a new feed.',
      ...(spendsMoney.length ? useWarnings(input.use, catalogWords(input.catalog)) : []),
      NO_META_CHECK,
    ],
    spendsMoney,
    requests: Object.keys(params).length ? [request(1, `${input.why === 'undo' ? 'Put back' : 'Change'} ${name}`, feed.feedId, 'catalogfeed', params, {
      operation: 'catalog.feed.update', undoable: true, raisesSpend: spendsMoney.length > 0, parent: { kind: 'catalog', id: input.catalog.catalogId }, expect, readBackFields: 'id,name,deletion_enabled,default_currency',
    })] : [],
    stands: { feedId: feed.feedId, catalogId: input.catalog.catalogId, before, uses: spendPremise(input.use) },
    before: { op: 'change', catalogId: input.catalog.catalogId, feedId: feed.feedId, fields: before, ...(noUndo.length ? { noUndo } : {}) } satisfies FeedRecord,
    after: { op: 'change', catalogId: input.catalog.catalogId, feedId: feed.feedId, fields: after } satisfies FeedRecord,
  })
}

// ── labels (D7), and files of items Nexus makes ─────────────────────────────────────────────────────────────────────

const D7 = new Set<string>(META_D7_COLUMNS)

/** A CSV of these rows (every cell quoted; internal_label as ['a','b'], numbers as digits, lists and objects as JSON). */
export function itemsCsv(columns: readonly string[], rows: ReadonlyArray<{ sku: string; fields: Fields }>): string {
  const cell = (column: string, v: unknown): string => {
    if (v === undefined || v === null) return csvCell('')
    if (column === 'internal_label' && Array.isArray(v)) return csvCell(internalLabelsCell(v as string[]))
    if (typeof v === 'string') return csvCell(v)
    if (typeof v === 'number' || typeof v === 'boolean') return csvCell(String(v))
    return csvCell(JSON.stringify(v))
  }
  return [columns.map(csvCell).join(','), ...rows.map((r) => columns.map((c) => (c === 'id' ? csvCell(r.sku) : cell(c, r.fields[c]))).join(','))].join('\n')
}

export interface LabelsAsk { sku: string; fields: Fields }

export function d7LabelsDraft(input: { catalog: CatalogNamed; feed: FeedNow; via: 'shopify-feed' | 'own-feed'; asked: LabelsAsk[]; now: ReadonlyMap<string, ItemNow>; use: CatalogUse; why?: 'asked' | 'undo' }): MetaChangeDraft {
  const catalog = catalogWords(input.catalog)
  const skipped: string[] = []
  const lines: Line[] = []
  const rows: Array<{ sku: string; fields: Fields; before: Fields }> = []
  const noUndo: string[] = []
  let custom = false
  for (const a of input.asked) {
    const now = input.now.get(a.sku)
    if (!now) { skipped.push(`${a.sku}: not an item of this catalog now (an update-only file adds no item Nexus means to add: the labels go only on items the catalog has).`); continue }
    const fields: Fields = {}
    const before: Fields = {}
    for (const [column, to] of Object.entries(a.fields)) {
      if (!D7.has(column)) continue
      const from = now.state[column]
      if (from !== undefined && sameValue(from, to)) { skipped.push(`${a.sku}: ${column} is like that already.`); continue }
      fields[column] = to
      before[column] = from ?? null
      lines.push([`${a.sku}: ${column}`, shown(from), shown(to)])
      if (from === undefined) noUndo.push(`${a.sku}: Nexus cannot read ${column} back exactly, so undo cannot set it back.`)
      if (/^custom_label_/.test(column)) custom = true
    }
    if (Object.keys(fields).length) rows.push({ sku: a.sku, fields, before })
  }
  const columns = ['id', ...META_D7_COLUMNS.filter((c) => rows.some((r) => c in r.fields))]
  // Every row carries every column of the file: a column a row does not change carries its current value (an empty one
  // only where it is empty now), so the file never empties a value by accident.
  const fileRows = rows.map((r) => ({ sku: r.sku, fields: Object.fromEntries(columns.slice(1).map((c) => [c, c in r.fields ? r.fields[c] : input.now.get(r.sku)?.state[c] ?? null])) }))
  const unread = fileRows.filter((r) => columns.slice(1).some((c) => !(c in (rows.find((x) => x.sku === r.sku)!.fields)) && input.now.get(r.sku)?.state[c] === undefined))
  if (unread.length) return draftOf({ summary: 'Nothing to change', skipped: [...skipped, `Nexus cannot read ${unread.map((r) => r.sku).join(', ')}'s other D7 columns exactly, and a file row carries every column: name the same columns for each item.`], requests: [], stands: null, before: null, after: null })
  const empties = fileRows.some((r) => Object.values(r.fields).some((v) => v === null || (Array.isArray(v) && !v.length)))
  const text = itemsCsv(columns, fileRows)
  // A label can move an item into a set that delivers: widening when something delivers on the catalog (or is unseen).
  const spendsMoney = rows.length ? spendLine(input.use, catalog, 'labels can put items into product sets that catalog ads use, so they can deliver more') : []
  const feedName = `${input.via === 'shopify-feed' ? 'the Shopify feed' : 'Nexus\'s own supplementary feed'} ${quoted(input.feed.name)}(${input.feed.feedId})`
  return draftOf({
    summary: input.why === 'undo' ? `Put the labels of ${plural(rows.length, 'item')} back in ${catalog}` : `Add labels to ${plural(rows.length, 'item')} of ${catalog}`,
    ...linesOf(lines),
    totals: { items: rows.length, columns: columns.length - 1 },
    skipped,
    warnings: [
      `D7: Shopify keeps writing every other field. Nexus sends an UPDATE-ONLY file (id + ${columns.slice(1).join(', ')}) to ${feedName}: it adds and changes these columns, never an item or another field.`,
      ...(input.via === 'shopify-feed' ? ['Meta: "if Shopify happens to update any of the fields you\'ve included in your update-feed, then the information will be overridden" — Shopify does not send these columns, so they stay.'] : []),
      ...(custom ? ['A custom label sends the item through Meta\'s review again (its ads can pause until approved); internal labels do not.'] : []),
      ...(empties ? ['An empty cell is sent where a column is empty now or asked empty: Meta\'s docs do not say whether an empty cell clears the value (LIVE-PROBES CT35-03), so the run says it was sent, not that it was cleared.'] : []),
      ...(input.via === 'own-feed' && columns.some((c) => c === 'internal_label' || /^custom_number_/.test(c)) ? [SUPPLEMENTARY_UNLISTED] : []),
      'Labels decide which product sets an item is in: a set built on them can grow or shrink, and so can what its ads show.',
      ...useWarnings(input.use, catalog),
      'Meta ingests the file as an upload of the feed (meta-catalog-feeds view uploads shows its result).',
      NO_META_CHECK,
    ],
    spendsMoney,
    requests: rows.length ? [request(1, `Upload labels of ${plural(rows.length, 'item')} to ${feedName}`, input.feed.feedId, 'catalogfeed', {
      [FEED_FILE.key]: text, [FEED_FILE.nameKey]: 'nexus-labels.csv', update_only: 'true',
    }, {
      operation: 'catalog.feed.upload.file', edge: 'uploads', undoable: true, parent: { kind: 'catalog', id: input.catalog.catalogId }, raisesSpend: spendsMoney.length > 0, readBackFields: 'id,start_time,end_time,num_detected_items,num_persisted_items,num_invalid_items,num_deleted_items,error_count,warning_count',
      // Review A-N5 — an empty cell's effect is not documented (CT35-03): "sent", never "done", until the probe says.
      ...(empties ? { doneSentence: (result: { node: Record<string, unknown> | null }) => `Upload labels of ${plural(rows.length, 'item')}: Meta took the file${typeof result.node?.id === 'string' ? ` as upload ${result.node.id}` : ''}. Its empty cells were sent; whether they cleared those values is not verified (LIVE-PROBES CT35-03): meta-catalog-items shows the items once Meta ingested it.` } : {}),
    })] : [],
    stands: { catalogId: input.catalog.catalogId, feedId: input.feed.feedId, before: rows.map((r) => ({ sku: r.sku, before: r.before })).sort((a, b) => a.sku.localeCompare(b.sku)), uses: spendPremise(input.use) },
    before: { op: 'labels', catalogId: input.catalog.catalogId, feedId: input.feed.feedId, items: rows.map((r) => ({ sku: r.sku, fields: r.before })), ...(noUndo.length ? { noUndo } : {}) } satisfies FeedRecord,
    after: { op: 'labels', catalogId: input.catalog.catalogId, feedId: input.feed.feedId, items: rows.map((r) => ({ sku: r.sku, fields: r.fields })) } satisfies FeedRecord,
  })
}

/**
 * An item's fields as a feed FILE carries them (review B-F4: catalog/reference): image[0] as image_link, the others as
 * additional_image_link (comma-separated). A file has no place for an image's tags, and a comma would split an address.
 */
export function fileFieldsOf(fields: Fields): Fields | { refusal: string } {
  if (!('image' in fields)) return fields
  const { image, ...rest } = fields
  const list = (Array.isArray(image) ? image : []) as Array<{ url?: unknown; tag?: unknown }>
  if (!list.length || list.some((m) => typeof m.url !== 'string')) return { refusal: 'images lists at least one address.' }
  if (list.some((m) => m.tag !== undefined)) return { refusal: 'A feed file carries image addresses only (image_link, additional_image_link): image tags go with set-meta-catalog-items update.' }
  const urls = list.map((m) => m.url as string)
  if (urls.some((u) => u.includes(','))) return { refusal: 'An image address with a comma cannot go in a feed file (Meta splits additional_image_link at commas): use set-meta-catalog-items update for it.' }
  return { ...rest, image_link: urls[0], ...(urls.length > 1 ? { additional_image_link: urls.slice(1).join(',') } : {}) }
}

/** A file of items Nexus makes for a feed it made (CT-089), update-only or a full replace. */
export function fileUploadDraft(input: { catalog: CatalogNamed; feed: FeedNow; rows: ItemAsk[]; updateOnly: boolean; use: CatalogUse }): MetaChangeDraft | { refusal: string } {
  const catalog = catalogWords(input.catalog)
  const rows: ItemAsk[] = []
  for (const r of input.rows) {
    const fields = fileFieldsOf(r.fields)
    if ('refusal' in fields) return { refusal: `${r.sku}: ${fields.refusal}` }
    rows.push({ sku: r.sku, fields })
  }
  // An update-only file sends no empty cell (Meta's docs do not say what one does): every row names the same fields.
  const shape = (r: ItemAsk) => Object.keys(r.fields).sort().join(',')
  if (input.updateOnly && new Set(rows.map(shape)).size > 1) return { refusal: 'An update-only file names the same fields for every item (an empty cell\'s meaning is not documented): split the upload by the fields each item changes (one image and several images are different fields: image_link, additional_image_link).' }
  const columns = ['id', ...[...new Set(rows.flatMap((r) => Object.keys(r.fields)))].sort()]
  const text = itemsCsv(columns, rows)
  const name = `feed ${quoted(input.feed.name)}(${input.feed.feedId})`
  // Review A-F3 — Nexus does not read the items before a file: each value that can widen what ads show counts (in stock,
  // active, a hideFrom list without `da`, an expiry, labels); a full replace always does.
  const widening = [...new Set(rows.flatMap((r) => Object.entries(r.fields).filter(([k, v]) => mayWiden(k, v)).map(([k]) => k)))]
  const spendsMoney = widening.length || !input.updateOnly ? spendLine(input.use, catalog, `the file's items can show in its catalog ads${widening.length ? ` (${widening.join(', ')})` : ''}, so they can deliver more`) : []
  return draftOf({
    summary: `${input.updateOnly ? 'Add or update' : 'REPLACE'} ${plural(rows.length, 'item')} of ${name} in ${catalog}`,
    ...linesOf(rows.map((r): Line => [`Item ${r.sku}`, input.updateOnly ? 'as it is' : 'replaced', Object.keys(r.fields).join(', ')])),
    totals: { items: rows.length, columns: columns.length - 1 },
    warnings: [
      BUYERS_SEE_IT,
      input.updateOnly
        ? 'update_only: Meta adds new items and updates existing ones with these columns; it deletes nothing.'
        : `FULL REPLACE: the feed's items become exactly this file's ${rows.length}${input.feed.deletionEnabled === true ? ' — deletion_enabled is ON, so every item of the feed missing from the file is DELETED' : ' (deletion_enabled is off: items missing from the file stay)'}.`,
      ...(rows.some((r) => 'price' in r.fields || 'sale_price' in r.fields) ? [PRICE_IS_MONEY] : []),
      REVIEW_AGAIN,
      ...useWarnings(input.use, catalog),
      'Meta ingests the file as an upload of the feed (meta-catalog-feeds view uploads shows its result).',
      NO_META_CHECK,
    ],
    spendsMoney,
    requests: [request(1, `Upload ${plural(rows.length, 'item')} to ${name}`, input.feed.feedId, 'catalogfeed', {
      [FEED_FILE.key]: text, [FEED_FILE.nameKey]: 'nexus-items.csv', update_only: input.updateOnly ? 'true' : 'false',
    }, { operation: 'catalog.feed.upload.file', edge: 'uploads', undoable: false, parent: { kind: 'catalog', id: input.catalog.catalogId }, raisesSpend: spendsMoney.length > 0, readBackFields: 'id,start_time,end_time,num_detected_items,num_persisted_items,num_invalid_items,num_deleted_items,error_count,warning_count' })],
    stands: { catalogId: input.catalog.catalogId, feedId: input.feed.feedId, deletionEnabled: input.feed.deletionEnabled, uses: spendPremise(input.use) },
    before: { op: 'upload', catalogId: input.catalog.catalogId, feedId: input.feed.feedId, noUndo: ['An upload has no undo: Meta keeps no earlier file (upload the earlier values again).'] } satisfies FeedRecord,
    after: { op: 'upload', catalogId: input.catalog.catalogId, feedId: input.feed.feedId, uploadId: null } satisfies FeedRecord,
  })
}

/** A one-time fetch of a public address (CT-088). */
export function urlUploadDraft(input: { catalog: CatalogNamed; feed: FeedNow; url: string; updateOnly: boolean; use: CatalogUse }): MetaChangeDraft {
  const catalog = catalogWords(input.catalog)
  const name = `feed ${quoted(input.feed.name)}(${input.feed.feedId})`
  const spendsMoney = spendLine(input.use, catalog, 'the file\'s items can show in its catalog ads, so they can deliver more')
  return draftOf({
    summary: `Fetch a file for ${name} of ${catalog} now (${input.updateOnly ? 'add and update only' : 'FULL REPLACE'})`,
    ...linesOf([['Fetched from', null, hostOf(input.url) ?? 'a public address'], ['Mode', null, input.updateOnly ? 'update only (deletes nothing)' : 'full replace']]),
    warnings: [
      BUYERS_SEE_IT,
      'The file at that address decides which items and fields change: Nexus does not see it before Meta fetches it.',
      ...(!input.updateOnly ? [`FULL REPLACE: the feed's items become the file's${input.feed.deletionEnabled === true ? ' — deletion_enabled is ON, so items missing from the file are DELETED' : ''}.`] : []),
      ...useWarnings(input.use, catalog),
      'The uploads reference page says this cannot be done; Meta\'s Feed API guide documents it: Meta\'s answer decides.',
      NO_META_CHECK,
    ],
    spendsMoney,
    requests: [request(1, `Fetch a file for ${name}`, input.feed.feedId, 'catalogfeed', { url: input.url, update_only: input.updateOnly ? 'true' : 'false' }, {
      operation: 'catalog.feed.upload.url', edge: 'uploads', undoable: false, parent: { kind: 'catalog', id: input.catalog.catalogId }, raisesSpend: spendsMoney.length > 0, readBackFields: 'id,start_time,end_time,num_detected_items,num_persisted_items,num_invalid_items,num_deleted_items,error_count,warning_count',
    })],
    stands: { catalogId: input.catalog.catalogId, feedId: input.feed.feedId, deletionEnabled: input.feed.deletionEnabled, uses: spendPremise(input.use) },
    before: { op: 'upload', catalogId: input.catalog.catalogId, feedId: input.feed.feedId, noUndo: ['An upload has no undo: Meta keeps no earlier file.'] } satisfies FeedRecord,
    after: { op: 'upload', catalogId: input.catalog.catalogId, feedId: input.feed.feedId, uploadId: null } satisfies FeedRecord,
  })
}

// ── rules, upload schedules, error reports ──────────────────────────────────────────────────────────────────────────

export interface RuleChangeAsk { add?: FeedRuleAsk[]; remove?: string[]; change?: Array<{ ruleId: string; params: Record<string, unknown> }> }

/**
 * Review A-F6 — a rule Nexus would delete must be one it can make again (its undo re-adds it; a change re-adds it at once):
 * a type and an attribute Nexus knows, and params Nexus sends. Else why not.
 */
export function ruleNotRemakeable(rule: FeedRuleNow): string | null {
  if (!rule.attribute || !rule.ruleType || !rule.params) return `Rule ${rule.ruleId}: Nexus cannot read its attribute, type and params whole`
  if (!META_RULE_ATTRIBUTES.includes(rule.attribute)) return `Rule ${rule.ruleId} is on ${rule.attribute}, a field Nexus does not write`
  const problem = metaRuleParamsProblem(rule.ruleType, rule.params)
  return problem ? `Rule ${rule.ruleId} (a ${rule.ruleType} on ${rule.attribute}) has params Nexus does not send (${problem})` : null
}

export function rulesDraft(input: { catalog: CatalogNamed; feed: FeedNow; rulesNow: FeedRuleNow[]; ask: RuleChangeAsk; use: CatalogUse; why?: 'asked' | 'undo' }): MetaChangeDraft | { refusal: string } {
  const byId = new Map(input.rulesNow.map((r) => [r.ruleId, r]))
  const deletes: FeedRuleNow[] = []
  const creates: FeedRuleAsk[] = []
  const lines: Line[] = []
  const skipped: string[] = []
  for (const id of input.ask.remove ?? []) {
    const rule = byId.get(id)
    if (!rule) { skipped.push(`${id}: not a rule of this feed now: nothing to remove.`); continue }
    const lost = ruleNotRemakeable(rule)
    if (lost) return { refusal: `${lost}: once removed, Nexus could not put it back (its undo would drop it), so it removes nothing. Change it in Commerce Manager.` }
    deletes.push(rule)
    lines.push([`Rule ${id} on ${rule.attribute}`, `${rule.ruleType} ${JSON.stringify(rule.params)}`, 'removed'])
  }
  for (const c of input.ask.change ?? []) {
    const rule = byId.get(c.ruleId)
    if (!rule || !rule.attribute || !rule.ruleType) return { refusal: `${c.ruleId} is not a rule of this feed Nexus can read whole (its attribute and type), so it cannot be changed: remove it and add a new one.` }
    if (sameValue(rule.params, c.params)) { skipped.push(`Rule ${c.ruleId} has these params already.`); continue }
    const lost = ruleNotRemakeable(rule)
    if (lost) return { refusal: `${lost}: a change removes it first, and Nexus could not put it back if the new one failed (nor by undo), so it changes nothing. Change it in Commerce Manager.` }
    // CT-084 — Meta's update of a rule is SDK only (its own MCP has none): a change is the delete, then the same rule again.
    deletes.push(rule)
    creates.push({ attribute: rule.attribute, ruleType: rule.ruleType, params: c.params })
    lines.push([`Rule ${c.ruleId} on ${rule.attribute}`, `${rule.ruleType} ${JSON.stringify(rule.params)}`, `${rule.ruleType} ${JSON.stringify(c.params)} (removed, then made again)`])
  }
  const remaining = input.rulesNow.filter((r) => !deletes.includes(r))
  for (const a of input.ask.add ?? []) {
    if (remaining.some((r) => r.attribute === a.attribute && r.ruleType === a.ruleType) || creates.some((r) => r.attribute === a.attribute && r.ruleType === a.ruleType)) {
      return { refusal: `The feed has a ${a.ruleType} on ${a.attribute} already (Meta: one rule per type and attribute): change it (change) or remove it first.` }
    }
    creates.push(a)
    lines.push([`New rule on ${a.attribute}`, null, `${a.ruleType} ${JSON.stringify(a.params)}`])
  }
  const name = `feed ${quoted(input.feed.name)}(${input.feed.feedId})`
  const catalog = catalogWords(input.catalog)
  // Review A-F3 — a rule changes the value of a field for EVERY item of the feed at its next upload (a label can move items
  // into a product set, an availability mapping can bring them back in stock): always counted when something delivers.
  const spendsMoney = deletes.length || creates.length ? spendLine(input.use, catalog, 'its rules change a field of every item of the feed at the next upload (labels move items into product sets, availability can bring items back), so they can deliver more') : []
  const requests: MetaChangeRequest[] = []
  const parent = { kind: 'catalog' as const, id: input.catalog.catalogId }
  for (const r of deletes) requests.push(request(requests.length + 1, `Remove rule ${r.ruleId} (${r.ruleType} on ${r.attribute}) of ${name}`, r.ruleId, 'feedrule', {}, { operation: 'catalog.feed.rule.delete', method: 'DELETE', undoable: true, parent, raisesSpend: spendsMoney.length > 0 }))
  const deleteSteps = requests.map((r) => r.step)
  for (const a of creates) {
    // A changed rule's new version stands on its delete (Meta: one rule per type and attribute).
    const replaced = deletes.find((d) => d.attribute === a.attribute && d.ruleType === a.ruleType)
    requests.push(request(requests.length + 1, `Add a ${a.ruleType} on ${a.attribute} to ${name}`, input.feed.feedId, 'catalogfeed', { attribute: a.attribute, rule_type: a.ruleType, params: ruleParam(a) }, {
      operation: 'catalog.feed.rule.create', edge: 'rules', undoable: true, parent, raisesSpend: spendsMoney.length > 0, readBackFields: 'id,attribute,rule_type', ...(replaced ? { needs: [deleteSteps[deletes.indexOf(replaced)]] } : {}),
    }))
  }
  return draftOf({
    summary: input.why === 'undo' ? `Put the rules of ${name} back` : `Change the rules of ${name} in ${catalog}`,
    ...linesOf(lines),
    skipped,
    spendsMoney,
    warnings: [
      'Rules apply at the feed\'s next upload: they change what the file\'s values become, for every item of the feed.',
      ...useWarnings(input.use, catalog),
      ...(creates.some((c) => c.ruleType === 'regex_replace_rule') ? ['Meta documents only the pattern of a regex_replace_rule, not what replaces a match: Meta\'s answer and the next upload show it (LIVE-PROBES CT35-06).'] : []),
      ...(deletes.length ? ['Removing a rule is in Meta\'s SDK only (its Ads MCP documents the same "delete a transformation rule"): Meta\'s answer decides (LIVE-PROBES CT35-12). A changed rule is removed, then made again (Meta documents no update): if the second step fails, the rule is gone until it is added again.'] : []),
      NO_META_CHECK,
    ],
    requests,
    stands: { feedId: input.feed.feedId, rules: input.rulesNow.map((r) => `${r.ruleId}:${r.ruleType}:${r.attribute}:${JSON.stringify(r.params)}`).sort(), uses: spendPremise(input.use) },
    before: { op: 'rules', catalogId: input.catalog.catalogId, feedId: input.feed.feedId, rules: deletes.map((r) => ({ ruleId: r.ruleId, attribute: r.attribute, ruleType: r.ruleType, params: r.params })) } satisfies FeedRecord,
    after: { op: 'rules', catalogId: input.catalog.catalogId, feedId: input.feed.feedId, rules: creates.map((r) => ({ ruleId: null, attribute: r.attribute, ruleType: r.ruleType, params: r.params })) } satisfies FeedRecord,
  })
}

export function uploadScheduleDraft(input: { catalog: CatalogNamed; feed: FeedNow; schedule: FeedSchedule; use: CatalogUse }): MetaChangeDraft {
  const name = `feed ${quoted(input.feed.name)}(${input.feed.feedId})`
  const catalog = catalogWords(input.catalog)
  const spendsMoney = spendLine(input.use, catalog, 'the items its fetches bring can show in catalog ads, so they can deliver more')
  return draftOf({
    summary: `Add an update-only upload schedule to ${name} of ${catalog}`,
    ...linesOf([['Extra fetch (add and update only)', null, scheduleWords(input.schedule)]]),
    warnings: [
      'An extra schedule only adds and updates items (meant for price and availability), never deletes.',
      'NO UNDO: Meta documents no way to change or remove an upload schedule through the API (Commerce Manager removes it).',
      ...useWarnings(input.use, catalog),
      NO_META_CHECK,
    ],
    spendsMoney,
    requests: [request(1, `Add an upload schedule to ${name}`, input.feed.feedId, 'catalogfeed', { upload_schedule: scheduleParam(input.schedule) }, { operation: 'catalog.feed.uploadSchedule', edge: 'upload_schedules', undoable: false, raisesSpend: spendsMoney.length > 0, parent: { kind: 'catalog', id: input.catalog.catalogId }, skipReadBack: true })],
    stands: { feedId: input.feed.feedId, uses: spendPremise(input.use) },
    before: { op: 'upload-schedule', catalogId: input.catalog.catalogId, feedId: input.feed.feedId, noUndo: ['Meta documents no way to remove an upload schedule through the API.'] } satisfies FeedRecord,
    after: { op: 'upload-schedule', catalogId: input.catalog.catalogId, feedId: input.feed.feedId } satisfies FeedRecord,
  })
}

export function errorReportDraft(input: { catalog: CatalogNamed; feedId: string; uploadId: string }): MetaChangeDraft {
  return draftOf({
    summary: `Ask Meta for the full error report of upload ${input.uploadId} (feed ${input.feedId})`,
    ...linesOf([[`Upload ${input.uploadId}`, 'a sample of its errors', 'full error report file asked']]),
    warnings: [
      'It changes nothing in the catalog: Meta makes a file of every error and warning of the upload; meta-catalog-feeds view upload shows it (report_status WRITE_FINISHED, the file\'s host).',
      NO_META_CHECK,
    ],
    requests: [request(1, `Ask the error report of upload ${input.uploadId}`, input.uploadId, 'feedupload', {}, { operation: 'catalog.feed.errorReport', edge: 'error_report', undoable: false, parent: { kind: 'catalog', id: input.catalog.catalogId }, answerOnly: true })],
    stands: { uploadId: input.uploadId },
    before: { op: 'error-report', catalogId: input.catalog.catalogId, feedId: input.feedId, uploadId: input.uploadId } satisfies FeedRecord,
    after: { op: 'error-report', catalogId: input.catalog.catalogId, feedId: input.feedId, uploadId: input.uploadId } satisfies FeedRecord,
  })
}
