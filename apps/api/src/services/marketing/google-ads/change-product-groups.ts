/**
 * Google Ads changes (2026-10-15) — the product groups (listing groups) of ONE Standard Shopping ad group, built from a
 * request and the ad group's live tree (live-product-groups.ts), without any call: pure.
 *
 *   rebuild   itemIds (+ bidCents / itemBids, excludeItemIds, includeEverythingElse): the tree becomes "All products"
 *             split by item ID — one unit per item id with its bid, and the "everything else" unit, EXCLUDED unless
 *             includeEverythingElse says otherwise (Owner 2026-10-15: a hand-built campaign left "Everything else" on and
 *             would have advertised every product of the feed). A tree already there: "All products" alone is replaced
 *             in the same request (removing a lone unit is not a recursive removal); a one-level split by item ID is
 *             changed in place — its root and the units that stay keep their ids and statistics; a deeper tree, or a
 *             split by another dimension, is refused (remove it first in Google Ads).
 *   units     bids (change the bid of existing units), exclude / include (existing units) — the tree stays as it is.
 *   any tree  (G4, change-product-tree.ts) the whole tree of any shape (`tree`: brand, category and product type levels
 *             1–5, custom labels 0–4, condition, channel, channel exclusivity, item id, nested), or edits of the tree
 *             as it is (add, subdivide, remove, removeTree, with bids / exclude / include) — Google's listing group rules
 *             and the two-step removal are in product-tree.ts.
 *
 * Google's rules for a listing group tree, checked 2026-10-15 (curl):
 *   - developers.google.com/google-ads/api/docs/shopping-ads/create-listing-groups: a node is a SUBDIVISION or a UNIT;
 *     only units take a bid (cpc_bid_micros), an excluded unit (negative: true) takes none; every subdivision must have
 *     an "Other" child — its dimension with no value (`{ productItemId: {} }`) — else LISTING_GROUP_SUBDIVISION_REQUIRES_
 *     OTHERS_CASE; a new tree is sent whole in ONE request, children pointing at their new parent by a temporary id
 *     (any negative number) in `customers/{c}/adGroupCriteria/{adGroupId}~{tempId}`; existing nodes by their real id.
 *   - reference/rpc/v25/CriterionErrorEnum.CriterionError: a create must use a temporary id (LISTING_GROUP_ADD_MAY_ONLY_
 *     USE_TEMP_ID); removing a subdivision removes everything under it ("recursive removal"); a unit cannot have
 *     children; siblings share one dimension; a value may not hold "==" or "&+" (INVALID_LISTING_DIMENSION).
 *   - reference/rpc/v25/AdGroupCriterion: `negative` and `listing_group` are immutable ("To switch a criterion from
 *     positive to negative, remove then re-add it"), so exclude / include = remove the unit and make it again, the same
 *     case value under the same parent, in the same request. `cpc_bid_micros` is mutable (a bid change is an update).
 *   - LISTING_GROUP_CANNOT_BE_REMOVED: "Recursive removal failed because listing group subdivision is being created or
 *     modified in this request" — a subdivision is never removed in a request that makes or changes one (Google's own
 *     "replace the tree" sample removes the root in one call and creates the new tree in a second). So Nexus never
 *     removes a subdivision: a one-level split is changed in place (updates, then removes of units, then creates under
 *     the root's real resource name), and a deeper tree is refused. Google's check (validate_only) of the preview
 *     proves Google takes the request as it is, before anything is queued.
 *   - Item ids: ProductItemIdInfo says only "Value of the id". Merchant Center ids are 1–50 characters, case-sensitive,
 *     but ids differing only by case "may be interpreted as the same product" (support.google.com/merchants/answer/
 *     6324405). So an item id is sent as given (trimmed), and compared and de-duplicated without case (productItemKey).
 *
 * Money: a unit that can now be advertised, a raised bid, and an "everything else" that is not excluded can make the
 * account spend more — each is said in `spendsMoney` (the person's decision), with a note when the campaign or the ad group
 * is not enabled (nothing spends yet). Excluding is a safe step.
 */
import { changeLines, money, plural, type GoogleChangeDraft } from './change-draft.js'
import { microsOfCents } from './live.js'
import type { ProductGroupLiveState, ProductGroupNode, ShoppingAdGroupLive } from './live-product-groups.js'
import { productItemKey } from './mappers.js'
import type { GoogleMutateOperation } from './write-client.js'
import { isTreeChange, treeChangeDraft, treeRecordAfterRun, treeRecordNow, treeUndoArgs, type TreeChangeRecord, type TreeChangeRequest } from './change-product-tree.js'
import { liveNodesOf, treeOfSnapshot, type TreeSnapNode } from './product-tree.js'

/** At most this many item ids in one request (the tool's limit; Google allows far more product groups per ad group). */
export const MAX_ITEM_IDS = 250
/** Merchant Center's limit for an item id. */
export const MAX_ITEM_ID_LENGTH = 50

export interface ProductGroupRequest extends TreeChangeRequest {
  campaignId: string
  adGroupId: string
  /** rebuild: the item ids that get a unit with a bid. */
  itemIds?: string[]
  /** rebuild: the bid of every item unit (unless itemBids gives its own). */
  bidCents?: number
  itemBids?: Array<{ itemId: string; bidCents: number }>
  /** rebuild: item ids that get an EXCLUDED unit. */
  excludeItemIds?: string[]
  /** rebuild: the "everything else" unit is advertised at this bid instead of excluded (SPENDS MONEY). */
  includeEverythingElse?: { bidCents: number }
  /** units: new bids of existing units, by Google's criterion id. */
  bids?: Array<{ criterionId: string; bidCents: number }>
  /** units: existing units to exclude. */
  exclude?: string[]
  /** units: excluded units to advertise again, each with its bid. */
  include?: Array<{ criterionId: string; bidCents: number }>
}

export interface TreeState { bidCents: number | null; excluded: boolean }
export interface TreeItem extends TreeState { itemId: string }

/** An ad group's product groups, as undo reads and puts them back. */
export type ProductGroupTree =
  | { kind: 'none' }
  /** "All products" alone: one unit. */
  | ({ kind: 'all' } & TreeState)
  /** "All products" split by item ID, one level: a unit per item id, and "everything else". */
  | { kind: 'items'; items: TreeItem[]; everythingElse: TreeState }
  /** Any other tree (other dimensions, more levels): counted, not put back. */
  | { kind: 'other'; groups: number; units: number }

/** A product group switched between advertised and excluded (removed and made again: Google gives it a new id). */
export interface SwitchedUnit { criterionId: string | null; excluded: boolean | null; bidCents: number | null }

/**
 * What a change replaced and wrote. A rebuild keeps the tree; a change of product groups as they are (units) also keeps
 * the bids it changed (a bid does not change an id) and the product groups it switched — before: as they were; after: as
 * made again, in the same order, with the ids Google gave them once the change ran.
 */
export interface ProductGroupChangeRecord {
  campaignId: string
  adGroupId: string
  tree: ProductGroupTree
  bids?: Array<{ criterionId: string; bidCents: number | null }>
  switched?: SwitchedUnit[]
  /** A change of any tree (change-product-tree.ts): the whole tree, as a snapshot with ids. */
  nodes?: TreeSnapNode[]
}

/** The summary of a snapshot, in the shape every record keeps (`tree`). */
const treeOfSnap = (nodes: TreeSnapNode[]): ProductGroupTree => treeOf(liveNodesOf(treeOfSnapshot(nodes)))

const ITEM = 'productItemId'
const REST_LABEL = '"everything else" (every other product of the feed)'

// ── reading a tree ──────────────────────────────────────────────────────────────────────────────────────────────

const stateOf = (n: ProductGroupNode): TreeState => ({ bidCents: n.excluded ? null : n.bidCents, excluded: n.excluded })
const byItem = (a: TreeItem, b: TreeItem) => {
  const x = productItemKey(a.itemId)
  const y = productItemKey(b.itemId)
  return x < y ? -1 : x > y ? 1 : 0
}
/** "Everything else": a node under a subdivision whose dimension has no value. */
const isRest = (n: ProductGroupNode) => n.parentId !== null && n.value === null

export function treeOf(nodes: ProductGroupNode[]): ProductGroupTree {
  if (!nodes.length) return { kind: 'none' }
  const other: ProductGroupTree = { kind: 'other', groups: nodes.length, units: nodes.filter((n) => n.kind === 'UNIT').length }
  const roots = nodes.filter((n) => n.parentId === null)
  if (roots.length !== 1) return other
  const root = roots[0]
  if (root.kind === 'UNIT') return nodes.length === 1 ? { kind: 'all', ...stateOf(root) } : other
  if (root.kind !== 'SUBDIVISION') return other
  const children = nodes.filter((n) => n.parentId === root.criterionId)
  if (children.length !== nodes.length - 1 || children.some((c) => c.kind !== 'UNIT')) return other
  const rest = children.filter(isRest)
  const named = children.filter((c) => !isRest(c))
  if (rest.length !== 1 || named.some((c) => c.dimension !== ITEM)) return other
  // Google may leave an empty case value out of its answer: "everything else" then reads without a dimension, and its
  // item-ID siblings say what it is.
  if (rest[0].dimension !== ITEM && !(rest[0].dimension === null && named.length > 0)) return other
  return { kind: 'items', items: named.map((c) => ({ itemId: c.value!, ...stateOf(c) })).sort(byItem), everythingElse: stateOf(rest[0]) }
}

const unitLabel = (s: TreeState, currency: string) =>
  s.excluded ? 'excluded' : s.bidCents === null ? 'advertised (no bid of its own)' : `${money(s.bidCents, currency)} a click`

export function describeTree(tree: ProductGroupTree, currency: string): string {
  switch (tree.kind) {
    case 'none': return 'no product groups (the ad group shows no products)'
    case 'all': return `"All products" alone, ${unitLabel(tree, currency)}`
    case 'items': {
      const off = tree.items.filter((i) => i.excluded).length
      return `"All products" split by item ID: ${plural(tree.items.length, 'item')}${off ? ` (${off} excluded)` : ''}; everything else ${unitLabel(tree.everythingElse, currency)}`
    }
    case 'other': return `a tree of ${plural(tree.groups, 'product group')} (${plural(tree.units, 'unit')}), not a single split by item ID`
  }
}

interface Reach { serves: boolean | null; bidCents: number | null; label: string }

/** How one item is advertised under a tree: by its own unit, by "everything else", or not at all; null = cannot say. */
function reachOf(tree: ProductGroupTree, key: string, currency: string): Reach {
  switch (tree.kind) {
    case 'none': return { serves: false, bidCents: null, label: 'not advertised (no product groups)' }
    case 'all': return tree.excluded
      ? { serves: false, bidCents: null, label: 'excluded ("All products" is excluded)' }
      : { serves: true, bidCents: tree.bidCents, label: `in "All products", ${unitLabel(tree, currency)}` }
    case 'items': {
      const own = tree.items.find((i) => productItemKey(i.itemId) === key)
      if (own) return { serves: !own.excluded, bidCents: own.bidCents, label: unitLabel(own, currency) }
      return { ...restOf(tree, currency), label: `not named: under everything else (${unitLabel(tree.everythingElse, currency)})` }
    }
    case 'other': return { serves: null, bidCents: null, label: 'in the old tree (not a split by item ID: Nexus does not compare it item by item)' }
  }
}

/** How the products a tree does not name are advertised. */
function restOf(tree: ProductGroupTree, currency: string): Reach {
  switch (tree.kind) {
    case 'none':
    case 'other':
    case 'all': return { ...reachOf(tree, '', currency) }
    case 'items': return { serves: !tree.everythingElse.excluded, bidCents: tree.everythingElse.bidCents, label: unitLabel(tree.everythingElse, currency) }
  }
}

function sameTree(a: ProductGroupTree, b: ProductGroupTree): boolean {
  const norm = (t: ProductGroupTree) => (t.kind === 'items' ? { ...t, items: t.items.map((i) => ({ ...i, itemId: productItemKey(i.itemId) })) } : t)
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

/** A tree read now, with its item ids spelled as `like` spells them (Google may answer an id in another case). */
function spelledAs(tree: ProductGroupTree, like: ProductGroupTree | undefined): ProductGroupTree {
  if (tree.kind !== 'items' || like?.kind !== 'items') return tree
  const spelling = new Map(like.items.map((i) => [productItemKey(i.itemId), i.itemId]))
  return { ...tree, items: tree.items.map((i) => ({ ...i, itemId: spelling.get(productItemKey(i.itemId)) ?? i.itemId })).sort(byItem) }
}

/** The record of an ad group's product groups as they are now, in the shape of a change's `after` (undo compares them). */
export function productGroupRecordNow(after: ProductGroupChangeRecord, nodes: ProductGroupNode[]): ProductGroupChangeRecord {
  if (after.nodes) {
    const now = treeRecordNow(after.nodes, nodes)
    return { campaignId: after.campaignId, adGroupId: after.adGroupId, tree: spelledAs(treeOfSnap(now), after.tree), nodes: now }
  }
  const byId = new Map(nodes.map((n) => [n.criterionId, n]))
  return {
    campaignId: after.campaignId,
    adGroupId: after.adGroupId,
    tree: spelledAs(treeOf(nodes), after.tree),
    ...(after.bids ? { bids: after.bids.map((b) => { const n = byId.get(b.criterionId); return { criterionId: b.criterionId, bidCents: n && !n.excluded ? n.bidCents : null } }) } : {}),
    ...(after.switched ? {
      switched: after.switched.map((u) => {
        const n = u.criterionId ? byId.get(u.criterionId) : undefined
        return { criterionId: u.criterionId, excluded: n ? n.excluded : null, bidCents: n ? stateOf(n).bidCents : null }
      }),
    } : {}),
  }
}

/** The record of a run: each product group it made again, with the id Google gave it (the result of the operation that made it). */
export function productGroupRecordAfterRun(after: ProductGroupChangeRecord, responses: Array<Record<string, { resourceName?: string } | undefined>>): ProductGroupChangeRecord {
  if (after.nodes) return { ...after, nodes: treeRecordAfterRun(after.nodes, responses) }
  if (!after.switched) return after
  return {
    ...after,
    switched: after.switched.map((u) => {
      const at = /^op:(\d+)$/.exec(u.criterionId ?? '')
      if (!at) return u
      const name = responses[Number(at[1])]?.adGroupCriterionResult?.resourceName
      return { ...u, criterionId: name ? name.slice(name.lastIndexOf('~') + 1) : null }
    }),
  }
}

// ── words ───────────────────────────────────────────────────────────────────────────────────────────────────────

const lower = (s: string | null, fallback: string) => (s ?? fallback).toLowerCase()

/** Said after every SPENDS MONEY sentence when nothing can spend yet. */
function pausedNote(ag: ShoppingAdGroupLive): string {
  if (ag.campaign.status !== 'ENABLED') return ` (the campaign is ${lower(ag.campaign.status, 'not enabled')}: nothing spends until it is enabled)`
  if (ag.status !== 'ENABLED') return ` (the ad group is ${lower(ag.status, 'not enabled')}: nothing spends until it is enabled)`
  return ''
}

const listed = (ids: string[], max = 8) => ids.slice(0, max).map((id) => `"${id}"`).join(', ') + (ids.length > max ? ` … (+${ids.length - max})` : '')
const bidRange = (cents: number[], currency: string) => {
  const lo = Math.min(...cents)
  const hi = Math.max(...cents)
  return lo === hi ? money(lo, currency) : `${money(lo, currency)}–${money(hi, currency)}`
}

/** What a split is by, in words: `brand`, `product type (level1)`, … */
function dimensionWords(dimension: string | null): string {
  const [dim, part] = (dimension ?? '').split(':')
  const level = part ? ` (${part.toLowerCase()})` : ''
  switch (dim) {
    case 'productItemId': return 'item ID'
    case 'productBrand': return 'brand'
    case 'productType': return `product type${level}`
    case 'productCustomAttribute': return `custom label${part ? ` ${part.replace(/^INDEX/, '')}` : ''}`
    case 'productCondition': return 'condition'
    case 'productCategory': return `category${level}`
    case 'productChannel': return 'channel'
    case 'productChannelExclusivity': return 'channel exclusivity'
    default: return dimension ? dimension : 'a dimension Nexus cannot tell'
  }
}

/** A product group as a person reads it: `item "abc"`, `brand "X"`, `"everything else" under brand "X"`. */
export function productGroupLabel(node: ProductGroupNode, nodes: ProductGroupNode[]): string {
  if (node.parentId === null) return '"All products"'
  if (isRest(node)) {
    const parent = nodes.find((n) => n.criterionId === node.parentId)
    return !parent || parent.parentId === null ? REST_LABEL : `"everything else" under ${productGroupLabel(parent, nodes)}`
  }
  const [dim, part] = (node.dimension ?? '').split(':')
  const v = node.value ?? ''
  switch (dim) {
    case 'productItemId': return `item "${v}"`
    case 'productBrand': return `brand "${v}"`
    case 'productType': return `product type ${part ? `(${part.toLowerCase()}) ` : ''}"${v}"`
    case 'productCustomAttribute': return `custom label ${part ? `${part.replace(/^INDEX/, '')} ` : ''}"${v}"`
    case 'productCondition': return `condition ${v.toLowerCase()}`
    case 'productCategory': return `category ${v}${part ? ` (${part.toLowerCase()})` : ''}`
    case 'productChannel': return `channel ${v.toLowerCase()}`
    case 'productChannelExclusivity': return `channel exclusivity ${v.toLowerCase()}`
    default: return `${node.dimension ?? 'product group'} "${v}"`
  }
}

// ── the change ──────────────────────────────────────────────────────────────────────────────────────────────────

interface Ctx {
  customer: string
  currency: string
  ag: ShoppingAdGroupLive
  nodes: ProductGroupNode[]
  /** `customers/{c}/adGroupCriteria/{adGroupId}~{id}` */
  crit: (id: string | number) => string
}

type Json = Record<string, unknown>

const unitCreate = (resourceName: string, parent: string | null, caseValue: Json | null, state: TreeState): GoogleMutateOperation => ({
  adGroupCriterionOperation: {
    create: {
      resourceName,
      status: 'ENABLED',
      listingGroup: { type: 'UNIT', ...(parent ? { parentAdGroupCriterion: parent } : {}), ...(caseValue ? { caseValue } : {}) },
      ...(state.excluded ? { negative: true } : { cpcBidMicros: microsOfCents(state.bidCents!) }),
    },
  },
})

const bidUpdate = (resourceName: string, cents: number): GoogleMutateOperation =>
  ({ adGroupCriterionOperation: { update: { resourceName, cpcBidMicros: microsOfCents(cents) }, updateMask: 'cpc_bid_micros' } })
const removal = (resourceName: string): GoogleMutateOperation => ({ adGroupCriterionOperation: { remove: resourceName } })

const badBid = (cents: unknown) => typeof cents !== 'number' || !Number.isInteger(cents) || cents < 1

export function productGroupChangeDraft(
  customer: string,
  currency: string,
  request: ProductGroupRequest,
  live: ProductGroupLiveState,
): GoogleChangeDraft | { refusal: string } {
  const ag = live.adGroup
  if (!ag) return { refusal: `Ad group ${request.adGroupId} is not in this account (or it is removed). google-ads-live view campaign lists a campaign's ad groups.` }
  if (ag.campaign.campaignId !== request.campaignId) {
    return { refusal: `Ad group "${ag.name}" (${ag.adGroupId}) belongs to campaign "${ag.campaign.name}" (${ag.campaign.campaignId}), not to campaign ${request.campaignId}.` }
  }
  if (ag.campaign.status === 'REMOVED') return { refusal: `Campaign "${ag.campaign.name}" is removed.` }
  if (ag.campaign.type !== 'SHOPPING') {
    return { refusal: `Campaign "${ag.campaign.name}" is a ${ag.campaign.type ?? 'non-Shopping'} campaign: product groups belong to Standard Shopping campaigns (a Performance Max campaign's products are set in its asset groups, not here).` }
  }
  if (ag.type && ag.type !== 'SHOPPING_PRODUCT_ADS') return { refusal: `Ad group "${ag.name}" is a ${ag.type} ad group: only a Standard Shopping ad group's product groups are changed here.` }
  const rebuild = !!(request.itemIds?.length || request.excludeItemIds?.length || request.itemBids?.length || request.includeEverythingElse || request.bidCents !== undefined)
  const units = !!(request.bids?.length || request.exclude?.length || request.include?.length)
  const anyTree = isTreeChange(request)
  if (rebuild && units) return { refusal: 'Either rebuild the tree (itemIds, bidCents, itemBids, excludeItemIds, includeEverythingElse) or change its product groups as they are (bids, exclude, include), not both in one request.' }
  if (rebuild && anyTree) return { refusal: 'Either rebuild the tree split by item ID (itemIds, bidCents, itemBids, excludeItemIds, includeEverythingElse), or give the whole tree (tree), or edit the tree as it is (add, subdivide, remove, removeTree) — one way in one request.' }
  if (!rebuild && !units && !anyTree) return { refusal: 'Say what to change: itemIds (a new tree split by item ID), tree (the whole tree, any shape), add / subdivide / remove / removeTree (the tree as it is), or bids, exclude or include (its product groups).' }
  const base = `${customer}/adGroupCriteria/${ag.adGroupId}~`
  const ctx: Ctx = { customer, currency, ag, nodes: live.nodes, crit: (id) => `${base}${id}` }
  const draft = anyTree ? anyTreeDraft(ctx, request) : rebuild ? rebuildDraft(ctx, request) : unitsDraft(ctx, request)
  if ('refusal' in draft) return draft
  if (ag.campaign.bidding && ag.campaign.bidding !== 'MANUAL_CPC' && draft.operations.some((op) => JSON.stringify(op).includes('"cpcBidMicros"'))) {
    draft.warnings.push(`The campaign bids with ${ag.campaign.bidding}, not Manual CPC: Google may not use the bids set here.`)
  }
  return draft
}

/** A change of any tree (change-product-tree.ts), its records in the shape every product group change keeps. */
function anyTreeDraft(ctx: Ctx, request: ProductGroupRequest): GoogleChangeDraft | { refusal: string } {
  const draft = treeChangeDraft({ currency: ctx.currency, ag: ctx.ag, nodes: ctx.nodes, crit: ctx.crit, stands: standsOf(ctx) }, request)
  if ('refusal' in draft) return draft
  const record = (r: TreeChangeRecord): ProductGroupChangeRecord => ({ campaignId: r.campaignId, adGroupId: r.adGroupId, tree: treeOfSnap(r.nodes), nodes: r.nodes })
  return { ...draft, before: record(draft.before as TreeChangeRecord), after: record(draft.after as TreeChangeRecord) }
}

/** The facts a change stands on: the campaign, the ad group and every node of its tree (checked again before it runs). */
function standsOf(ctx: Ctx) {
  return {
    campaign: { campaignId: ctx.ag.campaign.campaignId, status: ctx.ag.campaign.status, type: ctx.ag.campaign.type, bidding: ctx.ag.campaign.bidding },
    adGroup: { adGroupId: ctx.ag.adGroupId, status: ctx.ag.status, type: ctx.ag.type },
    nodes: ctx.nodes.map((n) => ({ id: n.criterionId, parent: n.parentId, kind: n.kind, dimension: n.dimension, value: n.value, excluded: n.excluded, bidCents: n.bidCents }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }
}

/** Warns when, after the change, an "everything else" unit is not excluded. */
function openRestWarnings(after: ProductGroupNode[], ag: ShoppingAdGroupLive): string[] {
  return after.filter((n) => n.kind === 'UNIT' && isRest(n) && !n.excluded).map((n) => {
    const parent = after.find((p) => p.criterionId === n.parentId)
    return !parent || parent.parentId === null
      ? `"Everything else" in "${ag.name}" is NOT excluded: every product of the feed that the tree does not name can be advertised.`
      : `"Everything else" under ${productGroupLabel(parent, after)} in "${ag.name}" is NOT excluded: every product there that the tree does not name can be advertised.`
  })
}

// ── rebuild: "All products" split by item ID ───────────────────────────────────────────────────────────────────

function rebuildDraft(ctx: Ctx, request: ProductGroupRequest): GoogleChangeDraft | { refusal: string } {
  const { ag, currency } = ctx
  const skipped: string[] = []
  const clean = (raw: unknown, where: string): string | { refusal: string } => {
    const id = String(raw ?? '').trim()
    if (!id) return { refusal: `${where}: an item id is empty.` }
    if (id.length > MAX_ITEM_ID_LENGTH) return { refusal: `${where}: the item id "${id.slice(0, 60)}" has ${id.length} characters (a Merchant Center item id has at most ${MAX_ITEM_ID_LENGTH}).` }
    if (id.includes('==') || id.includes('&+')) return { refusal: `${where}: the item id "${id}" holds "==" or "&+", which Google refuses in a product group.` }
    return id
  }
  const included = new Map<string, string>()
  for (const raw of request.itemIds ?? []) {
    const id = clean(raw, 'itemIds')
    if (typeof id !== 'string') return id
    const key = productItemKey(id)
    if (included.has(key)) { skipped.push(`"${id}" is named twice in itemIds (item ids are compared without case): it gets one product group.`); continue }
    included.set(key, id)
  }
  const excludedIds = new Map<string, string>()
  for (const raw of request.excludeItemIds ?? []) {
    const id = clean(raw, 'excludeItemIds')
    if (typeof id !== 'string') return id
    const key = productItemKey(id)
    if (included.has(key)) return { refusal: `"${id}" is both in itemIds (advertised) and in excludeItemIds (excluded).` }
    if (excludedIds.has(key)) { skipped.push(`"${id}" is named twice in excludeItemIds: it gets one product group.`); continue }
    excludedIds.set(key, id)
  }
  const count = included.size + excludedIds.size
  if (count === 0) return { refusal: 'Name at least one item id (itemIds, or excludeItemIds): the tree is "All products" split by item ID.' }
  if (count > MAX_ITEM_IDS) return { refusal: `${count} item ids: at most ${MAX_ITEM_IDS} in one request.` }
  const own = new Map<string, number>()
  for (const b of request.itemBids ?? []) {
    const id = clean(b.itemId, 'itemBids')
    if (typeof id !== 'string') return id
    const key = productItemKey(id)
    if (!included.has(key)) return { refusal: `itemBids names "${id}", which is not in itemIds.` }
    if (own.has(key)) return { refusal: `"${id}" has two bids in itemBids.` }
    if (badBid(b.bidCents)) return { refusal: `The bid of "${id}" is not a whole number of cents of at least 1.` }
    own.set(key, b.bidCents)
  }
  if (request.bidCents !== undefined && badBid(request.bidCents)) return { refusal: 'bidCents is not a whole number of cents of at least 1.' }
  if (request.includeEverythingElse && badBid(request.includeEverythingElse.bidCents)) return { refusal: 'The bid of everything else is not a whole number of cents of at least 1.' }
  const bidOf = (key: string): number | undefined => own.get(key) ?? request.bidCents
  const missing = [...included].filter(([key]) => bidOf(key) === undefined).map(([, id]) => id)
  if (missing.length) return { refusal: `Give bidCents (the bid of every item) or a bid for each item in itemBids: ${listed(missing)} ${missing.length === 1 ? 'has' : 'have'} none.` }

  const rest: TreeState = request.includeEverythingElse ? { bidCents: request.includeEverythingElse.bidCents, excluded: false } : { bidCents: null, excluded: true }
  const wanted: TreeItem[] = [
    ...[...included].map(([key, itemId]) => ({ itemId, bidCents: bidOf(key)!, excluded: false })),
    ...[...excludedIds.values()].map((itemId) => ({ itemId, bidCents: null, excluded: true })),
  ]
  const desired: ProductGroupTree = { kind: 'items', items: [...wanted].sort(byItem), everythingElse: rest }
  const before = treeOf(ctx.nodes)
  if (sameTree(before, desired)) return { refusal: `Nothing to change: the product groups of "${ag.name}" are already exactly this tree (${describeTree(desired, currency)}).` }
  const roots = ctx.nodes.filter((n) => n.parentId === null)
  const root = roots[0] ?? null
  if (ctx.nodes.length && (roots.length !== 1 || (root!.kind === 'UNIT' && ctx.nodes.length !== 1))) {
    return { refusal: `The product groups of "${ag.name}" do not read as one tree (${plural(roots.length, 'root')}, ${plural(ctx.nodes.length, 'product group')}): change them in Google Ads.` }
  }

  // Google never removes a subdivision in a request that makes or changes one (LISTING_GROUP_CANNOT_BE_REMOVED). So:
  //   no tree, or "All products" alone (a lone unit: its removal is not recursive) — the new tree is made whole, its root
  //   and children by temporary ids, in this one request;
  //   a one-level split by item ID — changed in place under its root's real id: updates, removes, creates.
  const updates: GoogleMutateOperation[] = []
  const removes: GoogleMutateOperation[] = []
  const creates: GoogleMutateOperation[] = []
  const dropped: TreeItem[] = []
  let temp = -1
  let kept = 0
  let remade = 0
  if (!root || root.kind === 'UNIT') {
    if (root) removes.push(removal(ctx.crit(root.criterionId)))
    const newRoot = ctx.crit(temp--)
    creates.push({ adGroupCriterionOperation: { create: { resourceName: newRoot, status: 'ENABLED', listingGroup: { type: 'SUBDIVISION' } } } })
    creates.push(unitCreate(ctx.crit(temp--), newRoot, { productItemId: {} }, rest))
    for (const item of wanted) creates.push(unitCreate(ctx.crit(temp--), newRoot, { productItemId: { value: item.itemId } }, item))
  } else {
    const children = ctx.nodes.filter((n) => n.parentId === root.criterionId)
    if (root.kind !== 'SUBDIVISION' || children.length !== ctx.nodes.length - 1 || children.some((c) => c.kind !== 'UNIT')) {
      return { refusal: `The product groups of "${ag.name}" have more than one level (${plural(ctx.nodes.length, 'product group')}). Google cannot remove a split in the request that makes the new one, so Nexus does not rebuild this tree: remove it first in Google Ads, then build it here with itemIds.` }
    }
    const restNodes = children.filter(isRest)
    const named = children.filter((c) => !isRest(c))
    const foreign = named.find((c) => c.dimension !== ITEM)
    const splitBy = foreign?.dimension ?? named[0]?.dimension ?? restNodes[0]?.dimension ?? null
    if (foreign || splitBy !== ITEM) {
      return { refusal: `The tree of "${ag.name}" splits by ${dimensionWords(splitBy)}, not by item ID: remove it first in Google Ads, or change its product groups as they are (bids, exclude, include).` }
    }
    if (restNodes.length !== 1) return { refusal: `The product groups of "${ag.name}" do not read as one split (${plural(restNodes.length, '"everything else" group')}): change them in Google Ads.` }
    const rootRes = ctx.crit(root.criterionId)
    // A unit that stays keeps its id (a new bid is an update); one whose excluded state flips is removed and made again.
    const place = (node: ProductGroupNode | undefined, state: TreeState, caseValue: Json) => {
      if (!node) { creates.push(unitCreate(ctx.crit(temp--), rootRes, caseValue, state)); return }
      if (node.excluded === state.excluded) {
        kept += 1
        if (!state.excluded && node.bidCents !== state.bidCents) updates.push(bidUpdate(ctx.crit(node.criterionId), state.bidCents!))
        return
      }
      removes.push(removal(ctx.crit(node.criterionId)))
      creates.push(unitCreate(ctx.crit(temp--), rootRes, node.caseValue ?? caseValue, state))
      remade += 1
    }
    const byKey = new Map(named.map((n) => [productItemKey(n.value!), n]))
    place(restNodes[0], rest, { productItemId: {} })
    for (const item of wanted) place(byKey.get(productItemKey(item.itemId)), item, { productItemId: { value: item.itemId } })
    const asked = new Set(wanted.map((i) => productItemKey(i.itemId)))
    for (const node of named.filter((n) => !asked.has(productItemKey(n.value!)))) {
      removes.push(removal(ctx.crit(node.criterionId)))
      dropped.push({ itemId: node.value!, ...stateOf(node) })
    }
  }
  const operations = [...updates, ...removes, ...creates]

  // what a person reads: the tree, "everything else", then each item whose place changes
  const lines: Array<[string, unknown, unknown]> = [
    [`product groups of "${ag.name}"`, describeTree(before, currency), describeTree(desired, currency)],
    [REST_LABEL, restOf(before, currency).label, unitLabel(rest, currency)],
  ]
  let unchanged = 0
  for (const item of desired.items) {
    const was = reachOf(before, productItemKey(item.itemId), currency).label
    const now = unitLabel(item, currency)
    if (was === now) unchanged += 1
    else lines.push([`item "${item.itemId}"`, was, now])
  }
  for (const item of dropped) lines.push([`item "${item.itemId}"`, unitLabel(item, currency), `not named: under everything else (${unitLabel(rest, currency)})`])

  // money
  const note = pausedNote(ag)
  const spends: string[] = []
  const newly: TreeItem[] = []
  const unknown: TreeItem[] = []
  const raised: string[] = []
  for (const item of desired.items.filter((i) => !i.excluded)) {
    const was = reachOf(before, productItemKey(item.itemId), currency)
    if (was.serves === false) newly.push(item)
    else if (was.serves === null) unknown.push(item)
    else if (was.bidCents !== null && item.bidCents! > was.bidCents) raised.push(`"${item.itemId}" ${money(was.bidCents, currency)} → ${money(item.bidCents, currency)}`)
  }
  if (newly.length) {
    spends.push(`Advertises ${plural(newly.length, 'item')} in "${ag.name}" that ${newly.length === 1 ? 'was' : 'were'} not advertised there before, at ${bidRange(newly.map((i) => i.bidCents!), currency)} a click: ${listed(newly.map((i) => i.itemId))}${note}.`)
  }
  if (raised.length) spends.push(`Raises the bid of ${plural(raised.length, 'item')} in "${ag.name}": ${raised.slice(0, 8).join(', ')}${raised.length > 8 ? ` … (+${raised.length - 8})` : ''}${note}.`)
  if (unknown.length) {
    spends.push(`Advertises ${plural(unknown.length, 'item')} in "${ag.name}" at ${bidRange(unknown.map((i) => i.bidCents!), currency)} a click: ${listed(unknown.map((i) => i.itemId))} (the old tree is not a split by item ID, so Nexus cannot say which of them were advertised before)${note}.`)
  }
  const restBefore = restOf(before, currency)
  if (!rest.excluded && !(restBefore.serves === true && restBefore.bidCents !== null && restBefore.bidCents >= rest.bidCents!)) {
    spends.push(`Advertises every other product of the feed in "${ag.name}" at ${money(rest.bidCents, currency)} a click: every product of the campaign's Merchant Center feed that this tree does not name can be advertised${note}.`)
  }
  // An item that leaves the tree falls under "everything else": advertised there when it was excluded, or at a higher bid.
  const falls = rest.excluded ? [] : dropped.filter((d) => d.excluded || (d.bidCents !== null && d.bidCents < rest.bidCents!))
  if (falls.length) {
    spends.push(`${plural(falls.length, 'item')} ${falls.length === 1 ? 'leaves' : 'leave'} the tree of "${ag.name}" and ${falls.length === 1 ? 'is' : 'are'} advertised under "everything else" at ${money(rest.bidCents, currency)} a click: `
      + `${falls.slice(0, 20).map((d) => `"${d.itemId}" ${d.excluded ? 'excluded' : money(d.bidCents, currency)} → ${money(rest.bidCents, currency)}`).join(', ')}${falls.length > 20 ? ` … (+${falls.length - 20})` : ''}${note}.`)
  }

  const warnings: string[] = []
  if (!rest.excluded) warnings.push(`"Everything else" in "${ag.name}" is NOT excluded: every product of the feed that the tree does not name can be advertised.`)
  else if (restBefore.serves !== false) warnings.push(`After this change only the items named here can be advertised in "${ag.name}": everything else is excluded.`)
  if (!wanted.some((i) => !i.excluded) && rest.excluded) warnings.push(`Nothing can be advertised in "${ag.name}" after this change: every product group of the tree is excluded.`)
  if (root?.kind === 'UNIT') warnings.push(`Replaces "All products" of "${ag.name}" with the new tree in the same request: the new product groups get new ids, so their own statistics in Google Ads start from zero.`)
  if (remade) {
    warnings.push(`${plural(remade, 'product group')} ${remade === 1 ? 'switches' : 'switch'} between advertised and excluded: Google cannot switch one, so ${remade === 1 ? 'it is' : 'each is'} removed and made again in the same request (a new id; its own statistics in Google Ads start from zero). The product groups that stay keep their ids and statistics.`)
  }

  const { changes, more } = changeLines(lines)
  const off = wanted.filter((i) => i.excluded).length
  return {
    summary: `Google Ads product groups of "${ag.name}": ${!root ? 'make' : root.kind === 'UNIT' ? 'replace "All products" with' : 'change the tree to'} "All products" split by item ID — ${plural(included.size, 'item')} with a bid${off ? `, ${off} excluded` : ''}, everything else ${rest.excluded ? 'excluded' : `advertised at ${money(rest.bidCents, currency)} a click`}.`,
    changes,
    totals: {
      operations: operations.length,
      units: wanted.length + 1,
      excluded: off + (rest.excluded ? 1 : 0),
      itemsWithBid: included.size,
      ...(unchanged ? { itemsUnchanged: unchanged } : {}),
      ...(root?.kind === 'SUBDIVISION' ? { keepTheirIds: kept + 1 } : {}),
      ...(more ? { linesNotShown: more } : {}),
    },
    warnings,
    spendsMoney: spends,
    skipped,
    operations,
    stands: standsOf(ctx),
    before: { campaignId: ag.campaign.campaignId, adGroupId: ag.adGroupId, tree: before } satisfies ProductGroupChangeRecord,
    after: { campaignId: ag.campaign.campaignId, adGroupId: ag.adGroupId, tree: desired } satisfies ProductGroupChangeRecord,
  }
}

// ── units: bids, exclude, include on the tree as it is ─────────────────────────────────────────────────────────

/** The case value a unit is made again with: as Google holds it; for an "everything else" Google sent without one, its siblings' dimension. */
function caseOf(node: ProductGroupNode, nodes: ProductGroupNode[]): Json | null {
  if (node.caseValue) return node.caseValue
  const sibling = nodes.find((n) => n.parentId === node.parentId && n.criterionId !== node.criterionId && n.caseValue)
  if (!sibling?.caseValue) return null
  const [key, inner] = Object.entries(sibling.caseValue)[0] as [string, Json | undefined]
  return { [key]: inner?.level ? { level: inner.level } : inner?.index ? { index: inner.index } : {} }
}

function unitsDraft(ctx: Ctx, request: ProductGroupRequest): GoogleChangeDraft | { refusal: string } {
  const { ag, currency, nodes } = ctx
  const byId = new Map(nodes.map((n) => [n.criterionId, n]))
  const named = new Map<string, string>()
  const label = (n: ProductGroupNode) => productGroupLabel(n, nodes)
  const note = pausedNote(ag)
  const updates: GoogleMutateOperation[] = []
  const removes: GoogleMutateOperation[] = []
  const creates: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const skipped: string[] = []
  const after = nodes.map((n) => ({ ...n }))
  const afterOf = (id: string) => after.find((n) => n.criterionId === id)!
  const bidsBefore: Array<{ criterionId: string; bidCents: number | null }> = []
  const bidsAfter: Array<{ criterionId: string; bidCents: number | null }> = []
  let temp = -1
  let excludedNow = 0
  let includedNow = 0
  const switchedBefore: SwitchedUnit[] = []
  const switchedAfter: Array<SwitchedUnit & { create: number }> = []

  const unit = (id: string, list: string): ProductGroupNode | { refusal: string } => {
    if (named.has(id)) return { refusal: `Product group ${id} is named twice (${named.get(id)} and ${list}).` }
    named.set(id, list)
    const node = byId.get(id)
    if (!node) return { refusal: `Product group ${id} is not in ad group "${ag.name}" (google-ads-live view product-groups lists them with their criterionId).` }
    if (node.kind !== 'UNIT') return { refusal: `${label(node)} (${id}) is a subdivision: it has no bid and cannot be excluded itself. Change the product groups under it, or rebuild the tree with itemIds.` }
    return node
  }
  // "All products" alone is a root unit: no parent, no case value (removing a lone unit is not a recursive removal).
  const remake = (node: ProductGroupNode, state: TreeState): { refusal: string } | null => {
    const caseValue = node.parentId === null ? null : caseOf(node, nodes)
    if (node.parentId !== null && !caseValue) return { refusal: `Nexus cannot tell which products ${label(node)} (${node.criterionId}) holds, so it cannot make it again: change it in Google Ads.` }
    removes.push(removal(ctx.crit(node.criterionId)))
    switchedBefore.push({ criterionId: node.criterionId, ...stateOf(node) })
    switchedAfter.push({ criterionId: null, ...state, create: creates.length })
    creates.push(unitCreate(ctx.crit(temp--), node.parentId === null ? null : ctx.crit(node.parentId), caseValue, state))
    Object.assign(afterOf(node.criterionId), { excluded: state.excluded, bidCents: state.bidCents })
    if (state.excluded) excludedNow += 1
    else includedNow += 1
    return null
  }

  for (const b of request.bids ?? []) {
    const node = unit(b.criterionId, 'bids')
    if ('refusal' in node) return node
    if (badBid(b.bidCents)) return { refusal: `The bid of ${label(node)} is not a whole number of cents of at least 1.` }
    if (node.excluded) return { refusal: `${label(node)} (${node.criterionId}) is excluded: it has no bid. Use include (with a bid) to advertise it.` }
    if (node.bidCents === b.bidCents) { skipped.push(`${label(node)} is already ${money(b.bidCents, currency)} a click.`); continue }
    updates.push(bidUpdate(ctx.crit(node.criterionId), b.bidCents))
    afterOf(node.criterionId).bidCents = b.bidCents
    lines.push([label(node), unitLabel(stateOf(node), currency), `${money(b.bidCents, currency)} a click`])
    bidsBefore.push({ criterionId: node.criterionId, bidCents: node.bidCents })
    bidsAfter.push({ criterionId: node.criterionId, bidCents: b.bidCents })
    if (node.bidCents === null || b.bidCents > node.bidCents) spends.push(`Raises the bid of ${label(node)} in "${ag.name}" from ${money(node.bidCents, currency)} to ${money(b.bidCents, currency)} a click${note}.`)
  }
  for (const id of request.exclude ?? []) {
    const node = unit(id, 'exclude')
    if ('refusal' in node) return node
    if (node.excluded) { skipped.push(`${label(node)} is already excluded.`); continue }
    const refused = remake(node, { bidCents: null, excluded: true })
    if (refused) return refused
    lines.push([label(node), unitLabel(stateOf(node), currency), 'excluded'])
  }
  for (const inc of request.include ?? []) {
    const node = unit(inc.criterionId, 'include')
    if ('refusal' in node) return node
    if (badBid(inc.bidCents)) return { refusal: `The bid of ${label(node)} is not a whole number of cents of at least 1.` }
    if (!node.excluded) { skipped.push(`${label(node)} is already advertised (${unitLabel(stateOf(node), currency)}): change its bid with bids.`); continue }
    const refused = remake(node, { bidCents: inc.bidCents, excluded: false })
    if (refused) return refused
    lines.push([label(node), 'excluded', `${money(inc.bidCents, currency)} a click`])
    spends.push(node.parentId === null
      ? `Advertises every product of the feed in "${ag.name}" ("All products") at ${money(inc.bidCents, currency)} a click${note}.`
      : isRest(node)
      ? `Advertises every other product of the feed${label(node) === REST_LABEL ? '' : ` under ${label(byId.get(node.parentId!)!)}`} in "${ag.name}" at ${money(inc.bidCents, currency)} a click: every product of the campaign's Merchant Center feed that the tree does not name${label(node) === REST_LABEL ? '' : ' there'} can be advertised${note}.`
      : `Advertises ${label(node)} in "${ag.name}" again, at ${money(inc.bidCents, currency)} a click${note}.`)
  }

  const operations = [...updates, ...removes, ...creates]
  if (operations.length === 0) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const warnings = openRestWarnings(after, ag)
  const made = excludedNow + includedNow
  if (made) warnings.push(`Google cannot switch a product group between advertised and excluded, so ${made === 1 ? 'it is' : `these ${made} are`} removed and made again in the same request: ${made === 1 ? 'it gets a new id and its' : 'they get new ids and their'} own statistics in Google Ads start from zero.`)
  const unitsAfter = after.filter((n) => n.kind === 'UNIT')
  if (unitsAfter.length && unitsAfter.every((n) => n.excluded)) warnings.push(`Nothing can be advertised in "${ag.name}" after this change: every product group of the tree is excluded.`)
  const { changes, more } = changeLines(lines)
  // Each product group made again: the id Google gives it is the result of the operation that makes it.
  const switched: SwitchedUnit[] = switchedAfter.map(({ create, ...u }) => ({ ...u, criterionId: `op:${updates.length + removes.length + create}` }))
  const parts: string[] = []
  if (bidsAfter.length) parts.push(`change ${plural(bidsAfter.length, 'bid')}`)
  if (excludedNow) parts.push(`exclude ${plural(excludedNow, 'product group')}`)
  if (includedNow) parts.push(`advertise ${plural(includedNow, 'excluded product group')} again`)
  const record = (tree: ProductGroupTree, bids: typeof bidsBefore, units: SwitchedUnit[]): ProductGroupChangeRecord =>
    ({ campaignId: ag.campaign.campaignId, adGroupId: ag.adGroupId, tree, bids, switched: units })
  return {
    summary: `Google Ads product groups of "${ag.name}": ${parts.join(', ')}.`,
    changes,
    totals: {
      operations: operations.length,
      units: unitsAfter.length,
      excluded: unitsAfter.filter((n) => n.excluded).length,
      bidChanges: bidsAfter.length,
      newlyExcluded: excludedNow,
      newlyIncluded: includedNow,
      ...(more ? { linesNotShown: more } : {}),
    },
    warnings,
    spendsMoney: spends,
    skipped,
    operations,
    stands: standsOf(ctx),
    before: record(treeOf(nodes), bidsBefore, switchedBefore),
    after: record(treeOf(after), bidsAfter, switched),
  }
}

// ── undo ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The request that puts a change's product groups back. A change of product groups as they are (units): the old bids
 * back by the same ids (a bid does not change an id), and each product group it switched switched back by the id Google
 * gave it (exclude what it advertised, advertise again at its old bid what it excluded). A rebuild: the tree it replaced
 * built again — only when that tree was a single split by item ID with a bid on every advertised unit. Pure.
 */
export function productGroupUndoArgs(change: { before: unknown; after: unknown }): { args: Record<string, unknown> } | { refusal: string } {
  const before = change.before as ProductGroupChangeRecord | null
  const after = change.after as ProductGroupChangeRecord | null
  if (!before?.campaignId || !before.adGroupId || !before.tree) return { refusal: 'This change does not record the product groups it replaced.' }
  const base = { campaignId: before.campaignId, adGroupId: before.adGroupId }
  if (before.nodes) {
    const undo = treeUndoArgs(before.nodes)
    return 'refusal' in undo ? undo : { args: { ...base, ...undo.args } }
  }
  if (before.bids || before.switched) {
    const bids = before.bids ?? []
    if (bids.some((b) => badBid(b.bidCents))) return { refusal: 'A product group of this change had no bid of its own before it: put it back by hand in Google Ads.' }
    const was = before.switched ?? []
    const now = after?.switched ?? []
    if (now.length !== was.length || now.some((u) => !u.criterionId || !/^\d+$/.test(u.criterionId))) {
      return { refusal: 'This change does not record the ids Google gave the product groups it made again: put them back by hand in Google Ads.' }
    }
    const exclude = now.filter((u) => u.excluded === false).map((u) => u.criterionId!)
    const include = now.flatMap((u, i) => (u.excluded === true ? [{ criterionId: u.criterionId!, bidCents: was[i].bidCents }] : []))
    if (include.some((u) => badBid(u.bidCents))) return { refusal: 'A product group this change excluded had no bid of its own before it: put it back by hand in Google Ads.' }
    if (!bids.length && !exclude.length && !include.length) return { refusal: 'This change records nothing it can put back.' }
    return {
      args: {
        ...base,
        ...(bids.length ? { bids: bids.map((b) => ({ criterionId: b.criterionId, bidCents: b.bidCents })) } : {}),
        ...(exclude.length ? { exclude } : {}),
        ...(include.length ? { include } : {}),
      },
    }
  }
  const tree = before.tree
  // A rebuild that made the first tree of the ad group: undo removes it (removals only).
  if (tree.kind === 'none') return { args: { ...base, removeTree: true } }
  // "All products" alone again: a unit where a split now stands — two steps (remove the split, then make the unit).
  if (tree.kind === 'all') {
    if (!tree.excluded && badBid(tree.bidCents)) return { refusal: '"All products" had no bid of its own before this change (Google set its bids): put it back by hand in Google Ads.' }
    return { args: { ...base, tree: [tree.excluded ? { excluded: true } : { bidCents: tree.bidCents }], inTwoSteps: true } }
  }
  if (tree.kind !== 'items') return { refusal: 'The product groups before this change were not a single split by item ID: put them back by hand in Google Ads.' }
  if (!tree.items.length || tree.items.length > MAX_ITEM_IDS) return { refusal: `The tree before this change had ${plural(tree.items.length, 'item')}: put it back by hand in Google Ads.` }
  const on = tree.items.filter((i) => !i.excluded)
  const off = tree.items.filter((i) => i.excluded)
  if (on.some((i) => badBid(i.bidCents)) || (!tree.everythingElse.excluded && badBid(tree.everythingElse.bidCents))) {
    return { refusal: 'A product group of the tree before this change had no bid of its own (Google set its bids): put the tree back by hand in Google Ads.' }
  }
  return {
    args: {
      ...base,
      ...(on.length ? { itemIds: on.map((i) => i.itemId), itemBids: on.map((i) => ({ itemId: i.itemId, bidCents: i.bidCents })) } : {}),
      ...(off.length ? { excludeItemIds: off.map((i) => i.itemId) } : {}),
      ...(tree.everythingElse.excluded ? {} : { includeEverythingElse: { bidCents: tree.everythingElse.bidCents } }),
    },
  }
}
