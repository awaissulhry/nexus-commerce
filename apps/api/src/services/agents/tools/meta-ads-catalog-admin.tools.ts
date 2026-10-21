/**
 * Meta ads changes, step 34 (lane C4) — catalog admin and product sets, on the business's own Meta catalogs (D7: Shopify
 * keeps writing items; these tools write no item field):
 *   create-meta-catalog         a catalog on the chosen ad account's business portfolio, or a segment of one of its catalogs
 *                               (collaborative ads) — CT-006, CT-009 (at create), CT-011
 *   set-meta-catalog            name, default / fallback image, image crop and padding, categories, pixels connected or
 *                               disconnected — CT-007, CT-008, CT-009, CR-460, CT-121, CT-122 (CT-177: not built, said)
 *   set-meta-catalog-access     people and system users on a catalog; sharing it (or a segment) with a partner — CT-014,
 *                               CT-015, CT-017, CT-134
 *   set-meta-product-set        make or change a product set (filter, name, retailer id, shop collection) — CT-064, CT-065,
 *                               CT-066 (CT-067 item order: not offered, said)
 *   remove-meta-catalog-items   DELETE on explicit ask: a catalog, a product set, items by SKU, one item, a supplementary
 *                               feed — CT-012, CT-045, CT-046, CT-068, CT-079
 * Each a Nexus change like set-meta-status (meta-ads-kit.ts): a preview from the live state, an approvalId, a person approves
 * it, it runs as that person, and undo puts back what it changed — a catalog or set Nexus made is deleted by the same tool
 * from its own record (removeMade / action undo + undoOf: never an id a caller names), and what has no way back on Meta is
 * said. Every catalog is checked by step 12's writableCatalog (marketing/meta-ads/catalog-rule.ts) in the draft, so at the
 * preview AND again when the approved change runs (the builder runs twice), and by the gateway (meta-catalog-owner.ts).
 *
 * Meta's own MCP: ads_catalog_create (CT-006), ads_catalog_update_catalog (CT-007), ads_catalog_create_product_set /
 * ads_catalog_update_product_set (name, filter, retailer id), ads_catalog_product_set_delete, ads_catalog_delete_product,
 * ads_catalog_product_feed_delete, ads_catalog_event_source_connect / disconnect — matched here, each with a preview of what
 * moves (item counts, the ad sets that stop), the D7 writer check and an undo; Meta's MCP has none for categories, people,
 * partners, segments or shop collections.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import type { AgentTool, ToolChange, ToolContext, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import type { MetaChangeDraft, MetaChangeRequest } from '../../marketing/meta-ads/change-draft.js'
import type { MetaChangeAccount } from '../../marketing/meta-ads/change-account.js'
import { metaChosenAccount, MetaLiveRefusal, type MetaChosenAccount } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import { catalogPortfolio } from '../../marketing/meta-ads/catalog-rule.js'
import { assertPriceFilterAllowed, liveProductSets, MAX_SET_CONDITIONS, MAX_SET_FILTER_WRITE_BYTES, productSetFilter, setConditionArg, SET_MATCH } from '../../marketing/meta-ads/live-commerce.js'
import { liveCatalogItems } from '../../marketing/meta-ads/live-catalog.js'
import {
  catalogSettingsOf, liveAccountPixels, liveCatalogAgencies, liveCatalogCategories, liveCatalogPeople, liveCatalogSets, liveCatalogSettings, liveCatalogUsers, liveNexusSystemUser,
  liveEventSources, liveFeed, liveItem, liveItemsBySku, livePortfolioPeople, liveSet, setOf, writableFor,
} from '../../marketing/meta-ads/live-catalog-admin.js'
import {
  canonicalFilter, catalogCategoriesDraft, catalogCreateDraft, catalogDeleteDraft, catalogSettingsDraft, CATALOG_REMOVE_KINDS, eventSourcesDraft, feedDeleteDraft,
  itemDeleteDraft, itemsDeleteDraft, partnerAccessDraft, personAccessDraft, setChangeDraft, setCreateDraft, setDeleteDraft, setFieldsOf, settingsProjection,
  type CatalogAccessRecord, type CatalogMadeRecord, type CatalogSettingsFields, type CatalogSettingsRecord, type CategoryAsk, type ProductSetRecord, type SetAsk,
} from '../../marketing/meta-ads/change-catalog-admin.js'
import { createdIdOf, type MetaChangeResult } from '../../marketing/meta-ads/write-client.js'
import { takenIds } from '../../marketing/meta-ads/taken.js'
import { META_NAME_TEXT, META_STRICT_TEXT } from '../../gateway/meta-write-text.js'
import {
  MAX_CATALOG_CATEGORIES, MAX_EVENT_SOURCES, MAX_ITEM_DELETES, MAX_SET_SHOPS, META_CATALOG_NAME_MAX, META_CATALOG_TASKS, META_CATEGORY_CRITERIA, META_CATEGORY_DESCRIPTION_MAX,
  META_CATEGORY_NAME_MAX, META_CATEGORY_VALUE_MAX, META_COLLAB_TERMS, META_COLLECTION_DESCRIPTION_MAX, META_COLLECTION_HANDLE, META_IMAGE_TRANSFORMATIONS, META_RETAILER_ID_MAX,
  META_SEGMENT_TASKS, META_URL_MAX, META_UTM_MAX, metaCatalogTextOk, metaHttpsUrlOk, metaSetFilterProblem,
} from '../../gateway/meta-catalog-rules.js'

type Done = Array<{ request: MetaChangeRequest; result: MetaChangeResult; notAsAsked?: string }>
type Args = Record<string, unknown>

// ── shared ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** CT-177 — the plain answer (RECHECK-C4: no body for the catalog-level switch on any page or in the SDK). */
export const AI_BACKGROUNDS_NOT_BUILT = 'Meta documents no body for it: no page says what `data` holds; the SDK only types it list<Object>. AI backgrounds are a per-creative opt-in (`degrees_of_freedom_spec.creative_features_spec.image_background_gen.enroll_status=OPT_IN`, step 25), only for catalog ads on Mobile Feed.'
/** Review B2 — `publish_to_shops=[]` is on no page and cannot be read back (LIVE-PROBES CA34-08): never sent. */
export const UNPUBLISH_NOT_DOCUMENTED = 'Meta documents no way to take a set out of every shop; do it in Commerce Manager.'
/** CT-067 — the plain answer (RECHECK-C4: ordering_info is SDK-only; its meaning is documented nowhere). */
export const ITEM_ORDER_NOT_OFFERED = 'Nexus does not set the order of items inside a set: Meta\'s ordering_info is in its SDK only and no page says what its numbers mean (Meta\'s own MCP updates only a set\'s name, filter and retailer id). publish_to_shops ordering_index orders a set among a shop\'s collections, not its items.'

const typedText = (max: number) => z.string().trim().min(1).max(max).regex(META_NAME_TEXT, 'no control or format characters')
const strictText = (max: number) => z.string().trim().min(1).max(max).regex(META_STRICT_TEXT, 'no control or format characters')
const httpsArg = (what: string) => z.string().trim().max(META_URL_MAX).refine((v) => metaHttpsUrlOk(v), 'an https address (no user or password)').describe(what)
const imageSettingsArg = z.object({
  carouselAd: z.enum(META_IMAGE_TRANSFORMATIONS).describe('carousel ads: background_cropping_and_padding | background_padding | none'),
  singleAd: z.enum(META_IMAGE_TRANSFORMATIONS).describe('single-image ads: the same choices'),
}).describe('how Meta crops / pads item images in Advantage+ catalog ads (Meta needs both)')
const filterArgs = {
  conditions: z.array(setConditionArg).max(MAX_SET_CONDITIONS).optional().describe('the filter: conditions on item fields (step 13\'s; a price needs revenue view); none = every item, only with everyItem true'),
  match: z.enum(SET_MATCH).optional().describe('all (default): every condition; any: one of them'),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional().describe('the currency of a price condition (default: the ad account\'s)'),
  everyItem: z.literal(true).optional().describe('true ONLY when the person asked for every item of the catalog (no condition)'),
}
const confirmDeleteArg = z.literal(true).describe('true, set ONLY because the person explicitly asked to DELETE exactly this (not to change or stop it)')

/** A builder that turns a refusal of the live reads into words. */
const guarded = (build: MetaDraftBuilder): MetaDraftBuilder => async (account) => {
  try {
    return await build(account)
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    if (err instanceof MetaReadError) return { refusal: `Nexus could not read Meta: ${err.message}` }
    throw err
  }
}
const chosenOf = (account: MetaChangeAccount): Promise<MetaChosenAccount> => metaChosenAccount(account.accountId)
/** The arguments an action takes: any other one given is refused in words (never silently dropped). */
function onlyArgs(args: Args, action: string, allowed: readonly string[]): string | null {
  const extra = Object.keys(args).filter((k) => args[k] !== undefined && !['connectionId', 'why', 'action', ...allowed].includes(k))
  return extra.length ? `${action} takes ${allowed.join(', ') || 'nothing more'} — not ${extra.join(', ')}.` : null
}
const idText = (v: unknown): string | null => (typeof v === 'string' && /^\d{1,20}$/.test(v) ? v : null)

/**
 * Review B1 — what uses a whole catalog: its own sets, and the chosen ad account's campaigns, ad sets and ads that name the
 * catalog or one of them (live-catalog-admin.ts liveCatalogUsers; what Nexus could not read is said and counts as spending).
 */
async function catalogUse(chosen: MetaChosenAccount, catalogId: string, forSetDelete = false) {
  const sets = await liveCatalogSets(chosen, catalogId)
  // A catalog's delete deletes every set too: it says the SDK-only places Nexus does not read, as a set's delete does.
  return { sets, use: await liveCatalogUsers(chosen, { catalogId, setIds: sets.sets.map((s) => s.id), setsMore: sets.more, forSetDelete }) }
}
/**
 * What uses one product set (campaigns and ad sets that promote or boost it, ad sets whose product audiences name it, ads
 * whose creative names it); a set's delete also says what Nexus does not read (live-catalog-admin.ts SDK_SET_FIELDS_UNSEEN).
 */
const setUse = (chosen: MetaChosenAccount, productSetId: string, forSetDelete = false) => liveCatalogUsers(chosen, { setIds: [productSetId], forSetDelete })

/** step 13's preview of a filter (CT-063): the items it matches now and, for a set, its count now; null when not counted. */
async function countFor(chosen: MetaChosenAccount, ctx: ToolContext, input: { catalogId: string; productSetId?: string | null; conditions?: unknown; match?: unknown; currency?: unknown }, catalogItems: number | null) {
  try {
    const read = await liveProductSets({
      connectionId: chosen.connectionId, view: 'preview', catalogId: input.catalogId, productSetId: input.productSetId ?? null,
      conditions: input.conditions as never, match: input.match as never, currency: (input.currency as string | undefined) ?? null, can: ctx.can, maxRows: 1,
    }) as { matchingItems?: number | null; current?: { itemsNow?: number | null } | null }
    return { matching: read.matchingItems ?? null, itemsNow: read.current?.itemsNow ?? null, catalogItems }
  } catch (err) {
    if (err instanceof MetaLiveRefusal || (err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled)) return null
    throw err
  }
}

/** The filter a set or segment write sends: step 13's productSetFilter with Meta's 500 KiB cap; '{}' only for everyItem. */
function writeFilter(chosen: MetaChosenAccount, ctx: ToolContext, input: { conditions?: unknown; match?: unknown; currency?: unknown; everyItem?: unknown }): { filter: string; internalLabel: boolean } {
  assertPriceFilterAllowed(input.conditions, ctx.can)
  const { rule } = productSetFilter({ conditions: input.conditions as never, match: input.match as never, currency: (input.currency as string | undefined) ?? null }, chosen.currency, { maxBytes: MAX_SET_FILTER_WRITE_BYTES, everyItem: input.everyItem === true })
  if (rule && input.everyItem === true) throw new MetaLiveRefusal('everyItem means no condition: give the conditions, or every item, not both.')
  const filter = rule ? JSON.stringify(rule) : '{}'
  return { filter, internalLabel: /"internal_label"/.test(filter) }
}

/** The change record of an earlier change of this tool (read in this business: row-level security), for an undo. */
async function recordOf(tool: string, changeId: unknown, account: MetaChangeAccount): Promise<{ before: unknown; after: unknown } | { refusal: string }> {
  const id = typeof changeId === 'string' ? changeId.trim() : ''
  if (!id) return { refusal: `This is only the undo of an earlier ${tool} change (undo-change asks for it with undoOf): this tool takes no id of what to undo.` }
  const row = await prisma.agentChange.findFirst({ where: { id, toolName: tool }, select: { before: true, after: true, undoneAt: true } })
  if (!row) return { refusal: `Change ${id} is not a ${tool} change of this business.` }
  if (row.undoneAt) return { refusal: `Change ${id} was undone already.` }
  const after = (row.after ?? {}) as { adAccountId?: string }
  if (after.adAccountId && after.adAccountId !== account.adAccountId) return { refusal: `Change ${id} was made on another Meta ad account than the one this business uses now: Nexus changes nothing there.` }
  return { before: row.before, after: row.after }
}

const common = {
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
} satisfies Partial<AgentTool>

const head = (record: { accountId?: string } | undefined, why: string) => ({ ...(record?.accountId ? { connectionId: record.accountId } : {}), why })

// ── create-meta-catalog ─────────────────────────────────────────────────────────────────────────────────────────────

const CREATE_UNDO_ONLY = ['removeMade', 'undoOf']

/** The undo of a create: delete the catalog that change made (its record), while it is still one Nexus may delete. */
async function removeMadeCatalog(args: Args, account: MetaChangeAccount): Promise<MetaChangeDraft | { refusal: string }> {
  const extra = onlyArgs(args, 'removeMade (the undo of an earlier create-meta-catalog)', CREATE_UNDO_ONLY)
  if (extra) return { refusal: extra }
  const record = await recordOf('create-meta-catalog', args.undoOf, account)
  if ('refusal' in record) return record
  const made = (record.after as CatalogMadeRecord).made
  if ((record.after as CatalogMadeRecord).op !== 'create' || !made?.id) return { refusal: 'That change recorded no catalog it made, so there is nothing Nexus can delete.' }
  const chosen = await chosenOf(account)
  const first = await writableFor(chosen, made.id, 'settings')
  // A catalog (not a segment) goes only while Nexus may delete its items (D7): empty, no Shopify, no feed, no shop.
  const { catalog } = first.catalog.isSegment === true ? first : await writableFor(chosen, made.id, 'items')
  const { sets, use } = await catalogUse(chosen, catalog.catalogId, true)
  return catalogDeleteDraft({ catalogId: catalog.catalogId, name: catalog.name, isSegment: catalog.isSegment, productCount: catalog.productCount, sets: sets.sets, setsMore: sets.more, use }, false, 'undo')
}

const buildCreateCatalog = (args: Args, ctx: ToolContext): MetaDraftBuilder => guarded(async (account) => {
  if (args.removeMade === true) return removeMadeCatalog(args, account)
  if (args.undoOf !== undefined) return { refusal: 'undoOf goes only with removeMade (the undo of an earlier create-meta-catalog).' }
  const name = typeof args.name === 'string' ? args.name : ''
  if (!name) return { refusal: 'Name the new catalog (name).' }
  const chosen = await chosenOf(account)
  const portfolioId = await catalogPortfolio(chosen)
  const segment = args.segmentOf as { parentCatalogId: string; conditions?: unknown; match?: unknown; currency?: unknown; everyItem?: unknown } | undefined
  if (!segment) return catalogCreateDraft({ name, imageSettings: (args.imageSettings as never) ?? null }, { portfolioId })
  if (args.imageSettings) return { refusal: 'imageSettings is for a new catalog; a segment shows its parent catalog\'s items (change the parent with set-meta-catalog).' }
  const { catalog } = await writableFor(chosen, segment.parentCatalogId, 'settings')
  if (catalog.isSegment !== false) return { refusal: `A segment is made from a catalog, and ${catalog.catalogId} is a segment itself (or Meta does not say whether it is one).` }
  const { filter } = writeFilter(chosen, ctx, segment)
  const count = await countFor(chosen, ctx, { catalogId: catalog.catalogId, conditions: segment.conditions, match: segment.match, currency: segment.currency }, catalog.productCount)
  return catalogCreateDraft({ name, segment: { parentId: catalog.catalogId, parentName: catalog.name, filter, matching: count?.matching ?? null, parentItems: catalog.productCount } }, { portfolioId })
})

function createCatalogFinish(draft: MetaChangeDraft, done: Done) {
  const madeAt = new Date().toISOString()
  if ((draft.before as { op?: string }).op === 'remove') {
    const id = done[0].request.objectId
    const removed: CatalogMadeRecord = { op: 'remove', made: { id, name: null, segment: false, parentId: null }, madeAt }
    return { data: { deleted: { catalogId: id } }, before: removed, after: removed, noUndo: 'A deletion on Meta is final: nothing here can be put back.' }
  }
  const planned = draft.after as CatalogMadeRecord
  const id = createdIdOf(done[0].result.node)
  const after: CatalogMadeRecord = { op: 'create', made: { ...planned.made!, id }, madeAt, ...(id ? {} : { noUndo: ['Meta did not answer the new catalog\'s id, so undo cannot tell it apart.'] }) }
  return { data: { catalogId: id, note: 'meta-catalogs view catalog shows it; its items come from a data source a person connects (D7).' }, before: draft.before, after }
}

const createCatalogUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as CatalogMadeRecord & { accountId?: string }
    // Only on the account it was made on; the undo's own preview reads the catalog live (writableCatalog) first.
    return (await recordAccount(after)) ? after : null
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as CatalogMadeRecord & { accountId?: string }
    if (after.op === 'remove') return { refusal: 'This change deleted a catalog an earlier change made: a deletion on Meta is final, there is nothing to put back.' }
    if (!after.made?.id) return { refusal: `This change recorded no catalog it made${after.noUndo?.length ? ` (${after.noUndo.join(' ')})` : ''}.` }
    return { tool: 'create-meta-catalog', args: { ...head(after, 'undo of an earlier create-meta-catalog: delete the catalog it made'), removeMade: true, ...(change.id ? { undoOf: change.id } : {}) } }
  },
}

const createMetaCatalog: AgentTool = {
  ...common,
  name: 'create-meta-catalog',
  title: 'Make a Meta catalog or catalog segment',
  consequencesFor: (args) => (args.removeMade === true ? { reversibility: 'none' } : null),
  input: z.object({
    connectionId: metaConnectionArg,
    name: typedText(META_CATALOG_NAME_MAX).optional().describe('the new catalog\'s (or segment\'s) name'),
    imageSettings: imageSettingsArg.optional(),
    segmentOf: z.object({
      parentCatalogId: metaIdArg('the catalog the segment is made from (meta-catalogs view list)'),
      ...filterArgs,
    }).optional().describe('a catalog SEGMENT (collaborative ads): a filtered part of one of the business\'s catalogs'),
    removeMade: z.literal(true).optional().describe('ONLY the undo of an earlier create-meta-catalog (undo-change asks for it): deletes the catalog that change made, nothing else'),
    undoOf: z.string().trim().min(1).max(64).optional().describe('with removeMade: the id of the change undone (its record names what it made)'),
    why: metaWhyArg,
  }),
  description:
    'Make a Meta product catalog on the business portfolio of the business\'s chosen ad account (vertical commerce; optional '
    + 'image crop / padding for catalog ads), or a catalog SEGMENT of one of its catalogs for collaborative ads (segmentOf: '
    + 'a filter on item fields; Meta needs the business onboarded to Collaborative Ads, else error 2310019). A catalog stays in '
    + 'that portfolio for good; Meta asks a person to accept its catalog terms before the first one. It starts empty: items '
    + 'come from a data source a person connects (Shopify\'s channel); Nexus writes no items (D7). Refused when another '
    + 'business in Nexus uses the same portfolio. Undo deletes the catalog it made while it is still empty of other writers\' '
    + 'items (a segment: always), and lists what goes.'
    + META_CHANGE_RULES,
  undo: createCatalogUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildCreateCatalog(args, ctx)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildCreateCatalog(args, ctx), createCatalogFinish),
}

// ── set-meta-catalog ────────────────────────────────────────────────────────────────────────────────────────────────

const CATALOG_ACTIONS = ['settings', 'categories', 'connect-pixels', 'disconnect-sources'] as const
const SETTINGS_ARGS = ['catalogId', 'name', 'defaultImageUrl', 'fallbackImageUrl', 'imageSettings']

const buildCatalog = (args: Args): MetaDraftBuilder => guarded(async (account) => {
  if (args.aiBackgrounds !== undefined) return { refusal: AI_BACKGROUNDS_NOT_BUILT }
  const action = String(args.action)
  const allowed: Record<string, string[]> = { settings: SETTINGS_ARGS, categories: ['catalogId', 'categories'], 'connect-pixels': ['catalogId', 'pixelIds'], 'disconnect-sources': ['catalogId', 'sourceIds'] }
  const extra = onlyArgs(args, action, allowed[action] ?? [])
  if (extra) return { refusal: extra }
  const catalogId = String(args.catalogId)
  const chosen = await chosenOf(account)
  const { catalog } = await writableFor(chosen, catalogId, 'settings')
  if (action === 'settings') {
    if (args.name === undefined && args.defaultImageUrl === undefined && args.fallbackImageUrl === undefined && args.imageSettings === undefined) return { refusal: 'settings changes name, defaultImageUrl, fallbackImageUrl or imageSettings: name one.' }
    const now = await liveCatalogSettings(chosen, catalog.catalogId)
    const { use } = await catalogUse(chosen, catalog.catalogId)
    return catalogSettingsDraft({ name: args.name as string | undefined, defaultImageUrl: args.defaultImageUrl as string | undefined, fallbackImageUrl: args.fallbackImageUrl as string | undefined, imageSettings: args.imageSettings as never }, { ...now, catalogName: catalog.name }, use)
  }
  if (action === 'categories') {
    const asked = (args.categories ?? []) as CategoryAsk[]
    if (!asked.length) return { refusal: 'categories lists the categories to change.' }
    const byCriteria = new Map<string, Awaited<ReturnType<typeof liveCatalogCategories>>>()
    for (const criteria of new Set(asked.map((c) => c.criteria))) byCriteria.set(criteria, await liveCatalogCategories(chosen, catalog.catalogId, criteria))
    const { use } = await catalogUse(chosen, catalog.catalogId)
    return catalogCategoriesDraft(asked, { catalogId: catalog.catalogId, catalogName: catalog.name, byCriteria, use })
  }
  const connect = action === 'connect-pixels'
  const ids = ((connect ? args.pixelIds : args.sourceIds) ?? []) as string[]
  if (!ids.length) return { refusal: connect ? 'pixelIds lists the pixels to connect.' : 'sourceIds lists the pixels or apps to disconnect.' }
  const sources = await liveEventSources(chosen, catalog.catalogId)
  const pixels = await liveAccountPixels(chosen)
  const { use } = await catalogUse(chosen, catalog.catalogId)
  return eventSourcesDraft(connect ? 'connect' : 'disconnect', [...new Set(ids)], { catalogId: catalog.catalogId, catalogName: catalog.name, sources: sources.sources, sourcesMore: sources.more, pixels: pixels.pixels, use })
})

const SETTINGS_KEYS: ReadonlyArray<keyof CatalogSettingsFields> = ['name', 'defaultImageUrl', 'fallbackImageUrl', 'displaySettings']

function catalogFinish(draft: MetaChangeDraft, done: Done) {
  const before = draft.before as CatalogSettingsRecord
  const planned = draft.after as CatalogSettingsRecord
  const node = done[0].result.node
  if (planned.op === 'settings' && node && typeof node === 'object' && ('name' in node || 'default_image_url' in node || 'fallback_image_url' in node || 'da_display_settings' in node)) {
    const keys = SETTINGS_KEYS.filter((k) => planned.fields && k in planned.fields)
    const read = settingsProjection(catalogSettingsOf(planned.catalogId, node), keys)
    return { data: { catalogId: planned.catalogId, settings: read }, before, after: { ...planned, fields: read } }
  }
  if (planned.op === 'categories') {
    const answer = node ?? {}
    return { data: { catalogId: planned.catalogId, metaAnswer: { updated: answer.updated ?? null, skipped: answer.skipped ?? null, total: answer.total ?? null } }, before, after: planned }
  }
  return { data: { catalogId: planned.catalogId }, before, after: planned }
}

const catalogUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as CatalogSettingsRecord & { accountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    try {
      const chosen = await chosenOf(account)
      if (after.op === 'settings') {
        const keys = SETTINGS_KEYS.filter((k) => after.fields && k in after.fields)
        return { ...after, fields: settingsProjection(await liveCatalogSettings(chosen, after.catalogId), keys) }
      }
      if (after.op === 'categories') {
        const live = new Map<string, Awaited<ReturnType<typeof liveCatalogCategories>>>()
        for (const criteria of new Set((after.categories ?? []).map((c) => c.criteria))) live.set(criteria, await liveCatalogCategories(chosen, after.catalogId, criteria))
        return { ...after, categories: (after.categories ?? []).map((c) => live.get(c.criteria)?.byValue.get(c.value) ?? { ...c, name: null, description: null, destinationUri: null, imageUrl: null }) }
      }
      const sources = await liveEventSources(chosen, after.catalogId)
      return { ...after, sources: (after.sources ?? []).map((s) => ({ ...s, connected: sources.sources.has(s.id) })) }
    } catch (err) {
      if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as CatalogSettingsRecord
    const after = (change.after ?? {}) as CatalogSettingsRecord & { accountId?: string }
    const h = head(after, 'undo of an earlier Meta catalog change')
    const stays = (before.noUndo ?? []).join(' ')
    if (after.op === 'settings') {
      const old = before.fields ?? {}
      const back: Args = {}
      if ('name' in (after.fields ?? {}) && metaCatalogTextOk(old.name, META_CATALOG_NAME_MAX)) back.name = old.name
      if ('defaultImageUrl' in (after.fields ?? {}) && metaHttpsUrlOk(old.defaultImageUrl)) back.defaultImageUrl = old.defaultImageUrl
      if ('fallbackImageUrl' in (after.fields ?? {}) && metaHttpsUrlOk(old.fallbackImageUrl)) back.fallbackImageUrl = old.fallbackImageUrl
      const d = old.displaySettings
      if ('displaySettings' in (after.fields ?? {}) && d?.carouselAd && d.singleAd && (META_IMAGE_TRANSFORMATIONS as readonly string[]).includes(d.carouselAd) && (META_IMAGE_TRANSFORMATIONS as readonly string[]).includes(d.singleAd)) back.imageSettings = { carouselAd: d.carouselAd, singleAd: d.singleAd }
      if (!Object.keys(back).length) return { refusal: `Nothing Nexus can send back: ${stays || 'the earlier values were empty, and Meta documents no way to clear them.'}` }
      return { tool: 'set-meta-catalog', args: { ...h, action: 'settings', catalogId: after.catalogId, ...back } }
    }
    if (after.op === 'categories') {
      const categories: CategoryAsk[] = []
      for (const [i, old] of (before.categories ?? []).entries()) {
        const now = (after.categories ?? [])[i]
        if (!now || now.value !== old.value) continue
        const c: CategoryAsk = { criteria: old.criteria, value: old.value }
        if (now.name !== old.name && metaCatalogTextOk(old.name, META_CATEGORY_NAME_MAX)) c.name = old.name
        if (now.description !== old.description && metaCatalogTextOk(old.description, META_CATEGORY_DESCRIPTION_MAX)) c.description = old.description
        if (now.destinationUri !== old.destinationUri) c.destinationUrl = old.destinationUri && metaHttpsUrlOk(old.destinationUri) ? old.destinationUri : ''
        if (now.imageUrl !== old.imageUrl && metaHttpsUrlOk(old.imageUrl)) c.imageUrl = old.imageUrl
        if (Object.keys(c).length > 2) categories.push(c)
      }
      if (!categories.length) return { refusal: `Nothing Nexus can send back: ${stays || 'Meta cannot clear a category\'s fields.'}` }
      return { tool: 'set-meta-catalog', args: { ...h, action: 'categories', catalogId: after.catalogId, categories } }
    }
    const ids = (after.sources ?? []).map((s) => s.id)
    if (after.op === 'connect') return ids.length ? { tool: 'set-meta-catalog', args: { ...h, action: 'disconnect-sources', catalogId: after.catalogId, sourceIds: ids } } : { refusal: 'This change connected nothing.' }
    const pixels = (after.sources ?? []).filter((s) => s.pixel).map((s) => s.id)
    if (!pixels.length) return { refusal: 'What this change disconnected was not a pixel of the chosen ad account (an app): connect it again in Commerce Manager.' }
    return { tool: 'set-meta-catalog', args: { ...h, why: pixels.length < ids.length ? 'undo of an earlier Meta catalog change (apps it disconnected are connected again in Commerce Manager)' : h.why, action: 'connect-pixels', catalogId: after.catalogId, pixelIds: pixels } }
  },
}

const setMetaCatalog: AgentTool = {
  ...common,
  name: 'set-meta-catalog',
  title: 'Change a Meta catalog',
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(CATALOG_ACTIONS).describe('settings (name, images, image crop / padding) | categories (category ads\' names, texts, landing pages, images) | connect-pixels | disconnect-sources'),
    catalogId: metaIdArg('the catalog (meta-catalogs view list)'),
    name: typedText(META_CATALOG_NAME_MAX).optional().describe('settings: the catalog\'s new name'),
    defaultImageUrl: httpsArg('settings: the image of items without a usable image (https)').optional(),
    fallbackImageUrl: httpsArg('settings: the image of auto-generated items (https)').optional(),
    imageSettings: imageSettingsArg.optional(),
    categories: z.array(z.object({
      criteria: z.enum(META_CATEGORY_CRITERIA).describe('BRAND | CATEGORY | PRODUCT_TYPE: the item field the categories come from'),
      value: strictText(META_CATEGORY_VALUE_MAX).describe('the category: that field\'s value (meta-ad-details view catalog-categories lists them)'),
      name: typedText(META_CATEGORY_NAME_MAX).optional().describe(`its name in ads (Meta: ≤ ${META_CATEGORY_NAME_MAX} characters)`),
      description: typedText(META_CATEGORY_DESCRIPTION_MAX).optional().describe(`its description (Meta: ≤ ${META_CATEGORY_DESCRIPTION_MAX} characters)`),
      destinationUrl: z.union([z.literal(''), httpsArg('its landing page (https)')]).optional().describe('its landing page (https; needed the first time); "" skips the category in ads (Meta cannot delete one)'),
      imageUrl: httpsArg('its lifestyle image (https); none: Meta makes a collage').optional(),
    })).min(1).max(MAX_CATALOG_CATEGORIES).optional().describe(`categories: at most ${MAX_CATALOG_CATEGORIES}, each its own fields`),
    pixelIds: z.array(metaIdArg('a pixel of the chosen ad account (meta-datasets)')).min(1).max(MAX_EVENT_SOURCES).optional().describe('connect-pixels: the pixels to connect'),
    sourceIds: z.array(metaIdArg('a pixel or app connected to the catalog (meta-catalogs view event-sources)')).min(1).max(MAX_EVENT_SOURCES).optional().describe('disconnect-sources: what to disconnect'),
    aiBackgrounds: z.boolean().optional().describe('not built: Meta documents no body for the catalog-level AI-background switch (the answer says what to use instead)'),
    why: metaWhyArg,
  }),
  description:
    'Change one of the business\'s Meta catalogs (owned by the chosen ad account\'s portfolio, shared with no other Nexus '
    + 'business): its name, default image (items without a usable image) and fallback image, how catalog ads crop or pad item '
    + 'images (changes every catalog ad at once); its categories for category ads (name ≤ 40, description ≤ 20 characters, '
    + 'landing page — needed the first time —, image; Meta cannot delete a category, an empty landing page skips it); the '
    + 'pixels connected (only the chosen ad account\'s; with ad sets delivering on the catalog it is SPENDS MONEY: their '
    + 'retargeting can reach more people), or pixels and apps disconnected (breaks retargeting catalog ads and '
    + 'product audiences that use them: the preview names the campaigns, ad sets and ads). A new default or fallback image '
    + 'or a category\'s first landing page is SPENDS MONEY too while something delivers on the catalog; what Nexus could not '
    + 'see counts as delivering. No item field is changed (D7). Undo puts the earlier '
    + 'values back where Meta takes them (an empty earlier value cannot be set again: said). The catalog-level AI-background '
    + 'switch is not built: Meta documents no body for it (no page says what `data` holds; the SDK only types it '
    + 'list<Object>). AI backgrounds are a per-creative opt-in '
    + '(`degrees_of_freedom_spec.creative_features_spec.image_background_gen.enroll_status=OPT_IN`, step 25), only for '
    + 'catalog ads on Mobile Feed.'
    + META_CHANGE_RULES,
  undo: catalogUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildCatalog(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildCatalog(args), catalogFinish),
}

// ── set-meta-catalog-access ─────────────────────────────────────────────────────────────────────────────────────────

const ACCESS_ACTIONS = ['assign-person', 'remove-person', 'share', 'unshare'] as const

const buildAccess = (args: Args): MetaDraftBuilder => guarded(async (account) => {
  const action = String(args.action)
  const allowed: Record<string, string[]> = { 'assign-person': ['catalogId', 'userId', 'tasks'], 'remove-person': ['catalogId', 'userId'], share: ['catalogId', 'partnerBusinessId', 'permittedTasks', 'collabTerms', 'utm'], unshare: ['catalogId', 'partnerBusinessId'] }
  const extra = onlyArgs(args, action, allowed[action] ?? [])
  if (extra) return { refusal: extra }
  const chosen = await chosenOf(account)
  const portfolioId = await catalogPortfolio(chosen)
  const { catalog } = await writableFor(chosen, String(args.catalogId), 'settings')
  if (action === 'assign-person' || action === 'remove-person') {
    const userId = idText(args.userId)
    if (!userId) return { refusal: 'Name the person or system user (userId: meta-catalogs view people, meta-account-access).' }
    if (action === 'assign-person' && !(args.tasks as string[] | undefined)?.length) return { refusal: 'tasks lists what the person may do on the catalog (MANAGE, ADVERTISE, MANAGE_AR, AA_ANALYZE).' }
    const people = await liveCatalogPeople(chosen, catalog.catalogId, portfolioId)
    if (people.more) return { refusal: 'The catalog has more people than Nexus reads (500): change its access in Meta Business settings.' }
    let who: { name: string | null; kind: string } | null = null
    if (action === 'assign-person') {
      const portfolio = await livePortfolioPeople(chosen, portfolioId)
      who = portfolio.people.get(userId) ?? null
      if (!who && portfolio.more) return { refusal: 'The business portfolio has more people than Nexus reads (500): give access in Meta Business settings.' }
    }
    return personAccessDraft(action === 'assign-person' ? 'assign' : 'remove', { userId, tasks: args.tasks as string[] | undefined }, {
      catalogId: catalog.catalogId, catalogName: catalog.name, people: people.people, who, nexusSystemUserId: await liveNexusSystemUser(chosen),
    })
  }
  const businessId = idText(args.partnerBusinessId)
  if (!businessId) return { refusal: 'Name the partner\'s business portfolio (partnerBusinessId).' }
  const tasks = (args.permittedTasks ?? []) as string[]
  if (action === 'share') {
    if (!tasks.length) return { refusal: 'permittedTasks lists what the partner may do (Nexus always sends them: MANAGE, ADVERTISE, MANAGE_AR, AA_ANALYZE).' }
    if (catalog.isSegment === true && tasks.some((t) => !(META_SEGMENT_TASKS as readonly string[]).includes(t))) return { refusal: `A catalog segment is shared with ${META_SEGMENT_TASKS.join(' and / or ')} only (Meta's collaborative ads).` }
  }
  const agencies = await liveCatalogAgencies(chosen, catalog.catalogId)
  const utm = args.utm as { campaignSource?: string; campaignMedium?: string; campaignName?: string } | undefined
  const utmParam = utm ? Object.fromEntries(Object.entries({ campaign_source: utm.campaignSource, campaign_medium: utm.campaignMedium, campaign_name: utm.campaignName }).filter(([, v]) => typeof v === 'string')) as Record<string, string> : undefined
  return partnerAccessDraft(action === 'share' ? 'share' : 'unshare', { businessId, permittedTasks: tasks, collabTerms: args.collabTerms as string[] | undefined, utm: utmParam }, {
    catalogId: catalog.catalogId, catalogName: catalog.name, isSegment: catalog.isSegment, portfolioId, agencies: agencies.agencies, agenciesMore: agencies.more,
    partnerTaken: (await takenIds('PORTFOLIO', [businessId])).has(businessId),
  })
})

const accessUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as CatalogAccessRecord & { accountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    try {
      const chosen = await chosenOf(account)
      if (after.op === 'assign' || after.op === 'remove') {
        const portfolioId = await catalogPortfolio(chosen)
        const person = (await liveCatalogPeople(chosen, after.catalogId, portfolioId)).people.get(after.userId ?? '')
        // Review A4 — the tasks too: a later change of the person's tasks makes the undo stale (it would overwrite it).
        return { ...after, assigned: !!person, tasks: person ? person.tasks : null }
      }
      const agencies = await liveCatalogAgencies(chosen, after.catalogId)
      return { ...after, shared: agencies.agencies.has(after.businessId ?? '') }
    } catch (err) {
      if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as CatalogAccessRecord
    const after = (change.after ?? {}) as CatalogAccessRecord & { accountId?: string }
    const h = head(after, 'undo of an earlier Meta catalog access change')
    const base = { ...h, catalogId: after.catalogId }
    if (after.op === 'unshare') return { refusal: 'Nexus cannot read which tasks the partner had: share the catalog again with set-meta-catalog-access (action share) and the tasks wanted.' }
    if (after.op === 'share') {
      if (before.shared) return { refusal: (before.noUndo ?? []).join(' ') || 'It was shared with this partner before; Nexus cannot read which tasks it had.' }
      return { tool: 'set-meta-catalog-access', args: { ...base, action: 'unshare', partnerBusinessId: after.businessId } }
    }
    const tasks = (before.tasks ?? []).filter((t) => (META_CATALOG_TASKS as readonly string[]).includes(t))
    if (after.op === 'assign' && !before.assigned) return { tool: 'set-meta-catalog-access', args: { ...base, action: 'remove-person', userId: after.userId } }
    if (!tasks.length) return { refusal: 'Nexus did not read tasks it can give back to this person: give access again with set-meta-catalog-access (action assign-person).' }
    return { tool: 'set-meta-catalog-access', args: { ...base, action: 'assign-person', userId: after.userId, tasks } }
  },
}

const setMetaCatalogAccess: AgentTool = {
  ...common,
  name: 'set-meta-catalog-access',
  title: 'Change who has a Meta catalog',
  consequencesFor: (args) => (args.action === 'unshare' ? { reversibility: 'none' } : null),
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(ACCESS_ACTIONS).describe('assign-person | remove-person (people and system users of the business portfolio) | share | unshare (a partner business portfolio)'),
    catalogId: metaIdArg('the catalog or catalog segment (meta-catalogs view list)'),
    userId: metaIdArg('assign-person, remove-person: the person or system user (meta-catalogs view people; meta-account-access)').optional(),
    tasks: z.array(z.enum(META_CATALOG_TASKS)).min(1).max(META_CATALOG_TASKS.length).optional().describe('assign-person: MANAGE | ADVERTISE | MANAGE_AR | AA_ANALYZE'),
    partnerBusinessId: metaIdArg('share, unshare: the partner\'s business portfolio').optional(),
    permittedTasks: z.array(z.enum(META_CATALOG_TASKS)).min(1).max(META_CATALOG_TASKS.length).optional().describe('share (always sent): what the partner may do — a segment: MANAGE and / or ADVERTISE'),
    collabTerms: z.array(z.enum(META_COLLAB_TERMS)).min(1).max(META_COLLAB_TERMS.length).optional().describe('share of a SEGMENT only: collaborative-ads terms enforced on the brand partner'),
    utm: z.object({
      campaignSource: strictText(META_UTM_MAX).optional().describe('utm campaign_source'),
      campaignMedium: strictText(META_UTM_MAX).optional().describe('utm campaign_medium'),
      campaignName: strictText(META_UTM_MAX).optional().describe('utm campaign_name'),
    }).optional().describe('share of a SEGMENT only: the UTM settings Meta adds to the partner\'s ad links'),
    why: metaWhyArg,
  }),
  description:
    'Who has one of the business\'s Meta catalogs: give a person or system user of its business portfolio MANAGE, ADVERTISE, '
    + 'MANAGE_AR or AA_ANALYZE on it, or take one off (never Nexus\'s own system user: every catalog tool would stop); share '
    + 'it (or a catalog segment, for collaborative ads with optional terms and UTM settings) with a partner\'s business '
    + 'portfolio — never one another business in Nexus uses, never its own — or stop sharing. Nexus always sends the '
    + 'partner\'s tasks. Sharing a plain catalog is in Meta\'s SDK only: Meta\'s answer decides. Undo takes back what it gave '
    + '(a person removed gets their earlier tasks back; a stopped share is shared again by a person with the tasks wanted).'
    + META_CHANGE_RULES,
  undo: accessUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildAccess(args)),
  execute: (args, ctx) => {
    // Review A4 — what a person's change left, as Meta reads it right after (Meta answers "all unpacked" tasks): the record
    // undo compares with the live tasks later. A read that fails keeps the tasks as sent (the undo then sees a change).
    let record: CatalogAccessRecord | null = null
    return runMetaChange(args, ctx, buildAccess(args), (draft) => {
      record = { ...(draft.after as CatalogAccessRecord) }
      return { data: { catalogId: record.catalogId }, before: draft.before, after: record }
    }, async (account) => {
      const r = record
      if (!r || (r.op !== 'assign' && r.op !== 'remove')) return 'meta-catalogs view partners shows it now.'
      const chosen = await chosenOf(account)
      const person = (await liveCatalogPeople(chosen, r.catalogId, await catalogPortfolio(chosen))).people.get(r.userId ?? '')
      // Review N3 — a read that disagrees with what was sent (not listed after an assign, still listed after a remove): Meta's
      // list had not caught up; the record keeps what was sent.
      if (r.op === 'assign' ? !person : !!person) return `Meta's list of the catalog's people had not caught up right after the change (it ${r.op === 'assign' ? 'did not list' : 'still listed'} ${r.userId}): Nexus keeps what it sent; meta-catalogs view people shows it later.`
      r.assigned = !!person
      r.tasks = person ? person.tasks : null
      return person ? `Meta now lists ${r.userId} on the catalog with ${person.tasks.join(', ') || 'no task'}.` : `Meta no longer lists ${r.userId} on the catalog.`
    })
  },
}

// ── set-meta-product-set ────────────────────────────────────────────────────────────────────────────────────────────

const SET_ACTIONS = ['create', 'change', 'undo'] as const

const collectionOf = (c: { coverImageUrl?: string; description?: string; externalUrl?: string; externalUrlHandle?: string } | undefined): Record<string, string> | undefined => {
  if (!c) return undefined
  const out = Object.fromEntries(Object.entries({ cover_image_url: c.coverImageUrl, description: c.description, external_url: c.externalUrl, external_url_handle: c.externalUrlHandle }).filter(([, v]) => typeof v === 'string')) as Record<string, string>
  return Object.keys(out).length ? out : undefined
}
const shopsOf = (shops: Array<{ shopId: string; orderingIndex: number }> | undefined) => shops?.map((s) => ({ shop_id: s.shopId, ordering_index: s.orderingIndex }))

/** The undo of a set change: a set it made is deleted; a set it changed gets its recorded name, filter and retailer id back. */
async function undoSet(args: Args, account: MetaChangeAccount, ctx: ToolContext): Promise<MetaChangeDraft | { refusal: string }> {
  void ctx
  const extra = onlyArgs(args, 'undo', ['undoOf'])
  if (extra) return { refusal: extra }
  const record = await recordOf('set-meta-product-set', args.undoOf, account)
  if ('refusal' in record) return record
  const before = record.before as ProductSetRecord
  const after = record.after as ProductSetRecord
  if (!after.productSetId) return { refusal: 'That change recorded no product set, so there is nothing Nexus can undo.' }
  const chosen = await chosenOf(account)
  const set = await liveSet(chosen, after.productSetId, after.catalogId)
  await writableFor(chosen, set.catalogId, 'settings')
  const use = await setUse(chosen, set.productSetId, after.op === 'create')
  if (after.op === 'create') return setDeleteDraft({ set, use }, false, 'undo')
  if (after.op !== 'change' || !before.set) return { refusal: 'That change has no earlier set to put back (a deletion on Meta is final).' }
  const ask: SetAsk = {}
  if (before.set.name !== null && metaCatalogTextOk(before.set.name, META_CATALOG_NAME_MAX)) ask.name = before.set.name
  const oldFilter = before.set.filter === '' ? '{}' : canonicalFilter(before.set.filter)
  const filterProblem = metaSetFilterProblem(oldFilter)
  if (filterProblem) return { refusal: `The set's earlier filter is not one Nexus sends (${filterProblem}): put it back in Commerce Manager.` }
  ask.filter = oldFilter
  if (before.set.retailerId !== null && metaCatalogTextOk(before.set.retailerId, META_RETAILER_ID_MAX, META_STRICT_TEXT)) ask.retailerId = before.set.retailerId
  const m = before.metadata
  if (m) {
    const metadata = collectionOf({ coverImageUrl: m.coverImageUrl ?? undefined, description: m.description ?? undefined, externalUrl: m.externalUrl ?? undefined, externalUrlHandle: m.externalUrlHandle ?? undefined })
    if (metadata) ask.metadata = metadata
  }
  return setChangeDraft(ask, { set, count: null, use, usesInternalLabel: false }, 'undo')
}

const buildSet = (args: Args, ctx: ToolContext): MetaDraftBuilder => guarded(async (account) => {
  if (args.itemOrder !== undefined) return { refusal: ITEM_ORDER_NOT_OFFERED }
  const action = String(args.action)
  if (action === 'undo') return undoSet(args, account, ctx)
  if (args.undoOf !== undefined) return { refusal: 'undoOf goes only with action undo.' }
  const chosen = await chosenOf(account)
  const extras = { retailerId: args.retailerId as string | undefined, metadata: collectionOf(args.collection as never), shops: shopsOf(args.shops as never) }
  const filterAsked = args.conditions !== undefined || args.everyItem !== undefined
  if (action === 'create') {
    const extra = onlyArgs(args, 'create', ['catalogId', 'name', 'conditions', 'match', 'currency', 'everyItem', 'retailerId', 'collection', 'shops'])
    if (extra) return { refusal: extra }
    if (typeof args.name !== 'string') return { refusal: 'Name the new product set (name).' }
    const catalogId = idText(args.catalogId)
    if (!catalogId) return { refusal: 'Name the catalog the set is made in (catalogId).' }
    const { catalog } = await writableFor(chosen, catalogId, 'settings')
    const { filter, internalLabel } = writeFilter(chosen, ctx, args)
    const count = await countFor(chosen, ctx, { catalogId: catalog.catalogId, conditions: args.conditions, match: args.match, currency: args.currency }, catalog.productCount)
    return setCreateDraft({ ...extras, name: args.name, filter }, { catalogId: catalog.catalogId, catalogName: catalog.name, count, usesInternalLabel: internalLabel })
  }
  const extra = onlyArgs(args, 'change', ['productSetId', 'catalogId', 'name', 'conditions', 'match', 'currency', 'everyItem', 'retailerId', 'collection', 'shops', 'unpublishFromShops'])
  if (extra) return { refusal: extra }
  const productSetId = idText(args.productSetId)
  if (!productSetId) return { refusal: 'Name the product set (productSetId: meta-product-sets view list).' }
  // Review B2 — publish_to_shops=[] is not documented and cannot be read back: never sent.
  if (args.unpublishFromShops === true) return { refusal: UNPUBLISH_NOT_DOCUMENTED }
  const set = await liveSet(chosen, productSetId, idText(args.catalogId))
  const { catalog } = await writableFor(chosen, set.catalogId, 'settings')
  const written = filterAsked ? writeFilter(chosen, ctx, args) : null
  const count = written ? await countFor(chosen, ctx, { catalogId: catalog.catalogId, productSetId, conditions: args.conditions, match: args.match, currency: args.currency }, catalog.productCount) : null
  const use = await setUse(chosen, productSetId)
  return setChangeDraft({ ...extras, name: args.name as string | undefined, filter: written?.filter }, { set, count, use, usesInternalLabel: !!written?.internalLabel })
})

function setFinish(draft: MetaChangeDraft, done: Done) {
  const planned = draft.after as ProductSetRecord | { op: 'remove'; kind: string; catalogId: string; ids: string[] }
  const node = done[0].result.node
  const madeAt = new Date().toISOString()
  if (planned.op === 'remove') {
    const record: ProductSetRecord = { op: 'remove', catalogId: planned.catalogId, productSetId: done[0].request.objectId, set: null, madeAt }
    return { data: { deleted: { productSetId: done[0].request.objectId } }, before: record, after: record, noUndo: 'A deletion on Meta is final: nothing here can be put back.' }
  }
  const p = planned as ProductSetRecord
  const id = p.op === 'create' ? createdIdOf(node) : p.productSetId
  const read = node && id && typeof node.name === 'string' ? setOf(id, p.catalogId, node) : null
  const after: ProductSetRecord = { ...p, productSetId: id, set: read ? setFieldsOf(read) : p.set, ...(p.op === 'create' ? { madeAt } : {}), ...(p.op === 'create' && !id ? { noUndo: ['Meta did not answer the new set\'s id, so undo cannot tell it apart.'] } : {}) }
  return { data: { productSetId: id, itemsNow: read?.productCount ?? null }, before: draft.before, after }
}

const setUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as ProductSetRecord & { accountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    if (after.op !== 'change' || !after.productSetId) return after
    try {
      const set = await liveSet(await chosenOf(account), after.productSetId, after.catalogId)
      return { ...after, set: setFieldsOf(set) }
    } catch (err) {
      if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as ProductSetRecord & { accountId?: string }
    if (after.op === 'remove') return { refusal: 'This change deleted a product set: a deletion on Meta is final, there is nothing to put back.' }
    if (!after.productSetId) return { refusal: `This change recorded no product set${after.noUndo?.length ? ` (${after.noUndo.join(' ')})` : ''}.` }
    return { tool: 'set-meta-product-set', args: { ...head(after, after.op === 'create' ? 'undo of an earlier set-meta-product-set: delete the set it made' : 'undo of an earlier set-meta-product-set: put the set back'), action: 'undo', ...(change.id ? { undoOf: change.id } : {}) } }
  },
}

const setMetaProductSet: AgentTool = {
  ...common,
  name: 'set-meta-product-set',
  title: 'Make or change a Meta product set',
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(SET_ACTIONS).describe('create a set in a catalog | change a set | undo (ONLY the undo of an earlier change of this tool: undo-change asks for it)'),
    catalogId: metaIdArg('create: the catalog (meta-catalogs view list); change: optional check of the set\'s catalog').optional(),
    productSetId: metaIdArg('change: the set (meta-product-sets view list)').optional(),
    name: typedText(META_CATALOG_NAME_MAX).optional().describe('create (required), change: the set\'s name'),
    ...filterArgs,
    retailerId: strictText(META_RETAILER_ID_MAX).optional().describe('the set\'s own retailer id (your id for it)'),
    collection: z.object({
      coverImageUrl: httpsArg('the collection\'s cover image (https)').optional(),
      description: strictText(META_COLLECTION_DESCRIPTION_MAX).optional().describe('the collection\'s description'),
      externalUrl: httpsArg('the collection\'s page on your website (https)').optional(),
      externalUrlHandle: z.string().trim().regex(META_COLLECTION_HANDLE).optional().describe('the collection\'s handle (letters, digits, _ or -)'),
    }).optional().describe('a shop collection\'s text and images (Meta reviews them before a shop shows them)'),
    shops: z.array(z.object({ shopId: metaIdArg('a shop of the chosen Page (meta-commerce view shops)'), orderingIndex: z.number().int().min(0).max(1_000_000).describe('its place among the shop\'s collections') }))
      .min(1).max(MAX_SET_SHOPS).optional().describe('publish the set to these shops as a collection'),
    unpublishFromShops: z.literal(true).optional().describe('not offered: Meta documents no way to take a set out of every shop (the answer says to do it in Commerce Manager)'),
    itemOrder: z.unknown().optional().describe('not offered: Meta documents no meaning for the order of items in a set (the answer says so)'),
    undoOf: z.string().trim().min(1).max(64).optional().describe('undo: the id of the change undone (its record says what to put back)'),
    why: metaWhyArg,
  }),
  description:
    'Make a product set in one of the business\'s Meta catalogs, or change a set: its filter (conditions on item fields as '
    + 'meta-product-sets uses them — a price is minor units, sent as Meta\'s price × 100, only for a person who may see revenue '
    + '— or every item, only when asked), name, retailer id, shop collection text and images, and the shops it is published '
    + 'to. The preview shows the items in the set before → after (Meta has no check for a set change), says when it matches '
    + 'every item, and warns that an EMPTY set stops its ads and that a filter change changes live catalog ads at once (it '
    + 'names the campaigns, ad sets and ads that show it); a filter that grows a set something delivers on now — or when Nexus '
    + 'could not see everything that may — is SPENDS MONEY (an empty set that fills starts its ads again). Meta refuses a '
    + 'filter equal to another set\'s (10803). Taking a set out of every shop is not offered (Meta documents no way: do it '
    + 'in Commerce Manager); nor is the order of items inside a set (Meta documents no meaning for ordering_info). Undo '
    + 'deletes a set it made, or puts the earlier name, filter '
    + 'and retailer id back.'
    + META_CHANGE_RULES,
  undo: setUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildSet(args, ctx)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildSet(args, ctx), setFinish),
}

// ── remove-meta-catalog-items ──────────────────────────────────────────────────────────────────────────────────────

const buildRemove = (args: Args): MetaDraftBuilder => guarded(async (account) => {
  const kind = String(args.kind)
  const allowed: Record<string, string[]> = { catalog: ['catalogId', 'alsoLive'], 'product-set': ['productSetId', 'catalogId', 'alsoLive'], items: ['catalogId', 'retailerIds'], item: ['itemId', 'catalogId'], feed: ['catalogId', 'feedId'] }
  const extra = onlyArgs({ ...args, kind: undefined, confirmDelete: undefined }, kind, allowed[kind] ?? [])
  if (extra) return { refusal: extra }
  const alsoLive = args.alsoLive === true
  const chosen = await chosenOf(account)
  const catalogId = idText(args.catalogId)
  switch (kind) {
    case 'catalog': {
      if (!catalogId) return { refusal: 'Name the catalog (catalogId).' }
      const first = await writableFor(chosen, catalogId, 'settings')
      // A catalog's delete takes its items: only where Nexus may write items (D7) — a segment holds none of its own.
      const { catalog } = first.catalog.isSegment === true ? first : await writableFor(chosen, catalogId, 'items')
      const { sets, use } = await catalogUse(chosen, catalog.catalogId, true)
      return catalogDeleteDraft({ catalogId: catalog.catalogId, name: catalog.name, isSegment: catalog.isSegment, productCount: catalog.productCount, sets: sets.sets, setsMore: sets.more, use }, alsoLive, 'asked')
    }
    case 'product-set': {
      const productSetId = idText(args.productSetId)
      if (!productSetId) return { refusal: 'Name the product set (productSetId).' }
      const set = await liveSet(chosen, productSetId, catalogId)
      await writableFor(chosen, set.catalogId, 'settings')
      return setDeleteDraft({ set, use: await setUse(chosen, set.productSetId, true) }, alsoLive, 'asked')
    }
    case 'items': {
      const skus = [...new Set((args.retailerIds ?? []) as string[])]
      if (!catalogId || !skus.length) return { refusal: 'Name the catalog (catalogId) and the items by their retailer ids (retailerIds: the SKUs).' }
      const { catalog } = await writableFor(chosen, catalogId, 'items')
      const found = await liveItemsBySku(chosen, catalog.catalogId, skus)
      const { use } = await catalogUse(chosen, catalog.catalogId)
      return itemsDeleteDraft({ catalogId: catalog.catalogId, catalogName: catalog.name, asked: skus, found, use })
    }
    case 'item': {
      const itemId = idText(args.itemId)
      if (!itemId) return { refusal: 'Name the item (itemId: Meta\'s item id; by SKU use kind items).' }
      const item = await liveItem(chosen, itemId, catalogId)
      const { catalog } = await writableFor(chosen, item.catalogId, 'items')
      const { use } = await catalogUse(chosen, catalog.catalogId)
      return itemDeleteDraft({ ...item, use })
    }
    case 'feed': {
      const feedId = idText(args.feedId)
      if (!catalogId || !feedId) return { refusal: 'Name the catalog (catalogId) and the feed (feedId: meta-catalog-feeds view list).' }
      const { writer } = await writableFor(chosen, catalogId, 'settings')
      const evidence = writer.evidence.find((e) => e.from === 'feed' && e.id === feedId)
      if (evidence?.kind === 'shopify') return { refusal: 'Shopify owns this feed: remove it in Shopify.' }
      if (evidence?.kind === 'partner') return { refusal: `A shop platform or feed tool owns this feed (${evidence.detail}): remove it there.` }
      const feed = await liveFeed(chosen, catalogId, feedId)
      if (feed.supplementary !== true) return { refusal: 'This is a primary feed (or Meta does not say): deleting it disables every ad of the items it brings (Meta), and Nexus deletes no items it does not write (D7). Delete it in Commerce Manager if that is meant.' }
      return feedDeleteDraft({ catalogId, feedId, name: feed.name })
    }
  }
  return { refusal: `kind is ${CATALOG_REMOVE_KINDS.join(', ')}.` }
})

function removeFinish(draft: MetaChangeDraft, done: Done) {
  const before = draft.before as { kind: string; skus?: string[] }
  const node = done[0].result.node ?? {}
  const data: Record<string, unknown> = { deleted: (draft.after as { kind: string; ids: string[] }).ids, kind: before.kind }
  if (before.kind === 'items') {
    const statuses = Array.isArray(node.validation_status) ? node.validation_status as Array<Record<string, unknown>> : []
    const refused = statuses.filter((s) => Array.isArray(s.errors) && s.errors.length).map((s) => ({ sku: s.retailer_id ?? null, errors: (s.errors as Array<{ message?: unknown }>).map((e) => String(e.message ?? '')).slice(0, 5) }))
    const handles = Array.isArray(node.handles) ? node.handles.filter((h): h is string => typeof h === 'string') : []
    data.skus = before.skus
    data.batch = { handle: handles[0] ?? null, refusedByMeta: refused, sentence: handles.length ? 'Meta took the deletes as a batch; the run read what it did (nexusRead).' : 'Meta answered no batch handle: it ingested nothing (its validation says why).' }
  }
  return { data, before: draft.before, after: draft.after, noUndo: 'A deletion on Meta is final: there is no undo, also for what Meta did delete.' }
}

/** After an items delete: Meta's batch status, read once (step 12's batch-status view). */
async function removeAfter(account: MetaChangeAccount, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>): Promise<string> {
  const first = done[0]
  if (first?.request.operation !== 'catalog.items.delete') return 'meta-catalogs, meta-product-sets and meta-catalog-items show it now.'
  const handles = Array.isArray(first.result.node?.handles) ? (first.result.node!.handles as unknown[]).filter((h): h is string => typeof h === 'string') : []
  if (!handles.length) return 'Meta answered no batch handle, so nothing was ingested.'
  const read = await liveCatalogItems({ connectionId: account.accountId, view: 'batch-status', catalogId: first.request.objectId, handle: handles[0] }) as { items?: Array<{ status: string | null; errorsTotal: number | null; invalidRequestIds?: unknown }> }
  const status = read.items?.[0]
  return status ? `Meta's batch ${handles[0]}: ${status.status ?? 'status not said'}${status.errorsTotal ? `, ${status.errorsTotal} request(s) refused` : ''} (meta-catalog-items view batch-status with this handle shows it later; Finished means done).` : `meta-catalog-items view batch-status with handle ${handles[0]} shows what Meta did.`
}

const removeMetaCatalogItems: AgentTool = {
  ...common,
  name: 'remove-meta-catalog-items',
  title: 'Delete Meta catalog parts (for good)',
  // No undo: Meta keeps nothing to restore — a deleted catalog, set, item or feed never comes back as it was.
  reversibility: 'none',
  input: z.object({
    connectionId: metaConnectionArg,
    kind: z.enum(CATALOG_REMOVE_KINDS).describe('catalog | product-set | items (by retailer id) | item (by Meta\'s item id) | feed (a supplementary feed)'),
    catalogId: metaIdArg('catalog, items, feed: the catalog; product-set, item: optional check').optional(),
    productSetId: metaIdArg('product-set: the set').optional(),
    itemId: metaIdArg('item: Meta\'s item id (meta-catalog-items)').optional(),
    retailerIds: z.array(strictText(META_RETAILER_ID_MAX)).min(1).max(MAX_ITEM_DELETES).optional().describe(`items: the items' retailer ids (SKUs), at most ${MAX_ITEM_DELETES}; only those the catalog holds now are deleted`),
    feedId: metaIdArg('feed: the supplementary feed (meta-catalog-feeds)').optional(),
    alsoLive: z.literal(true).optional().describe('catalog, product-set: true ONLY when the person asked to delete it EVEN while ads use it (Meta refuses otherwise); the preview names what stops'),
    confirmDelete: confirmDeleteArg,
    why: metaWhyArg,
  }),
  description:
    'DELETE for good — only when the person explicitly asked to DELETE (confirmDelete true): a catalog of the business, a '
    + 'product set, items by their retailer ids (SKUs; one batch of DELETEs, only of items the catalog holds now), one item '
    + 'by its Meta id, or a supplementary feed. D7: items (and a catalog with its items) only where Nexus may write items — '
    + 'on a catalog Shopify feeds the answer is "Shopify owns these items: remove them in Shopify"; a Shopify, partner or '
    + 'primary feed is never deleted here. Deleting is FINAL, no undo: ads on a deleted catalog, set or item stop; the '
    + 'preview lists every product set and every campaign, ad set and ad of the chosen ad account that uses it (and what Nexus '
    + 'could not see). While ads use a catalog\'s sets '
    + 'or a set, Meta refuses the delete unless the person asked for that too (alsoLive: the preview names what stops). To '
    + 'stop ads for a while, pause them (set-meta-status) instead. Meta has no check for a delete.'
    + META_CHANGE_RULES,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildRemove(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildRemove(args), removeFinish, removeAfter),
}

export const META_ADS_CATALOG_ADMIN_TOOLS: AgentTool[] = [createMetaCatalog, setMetaCatalog, setMetaCatalogAccess, setMetaProductSet, removeMetaCatalogItems]
