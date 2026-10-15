/**
 * Google Ads Shopping (2026-10-15, G4) — a product group tree of ANY shape, without any call: pure. The Shopping
 * dimensions and their values, a tree as a person gives it (flat nodes, parents by index) and as Google holds it (the
 * live listing groups), the snapshot a change keeps for undo, and the plan that turns one tree into another with as few
 * operations as Google allows (the product groups that stay keep their ids and statistics).
 *
 * Checked 2026-10-15 in Google's v25 reference (curl of developers.google.com/google-ads/api/reference/rpc/v25/<Message>):
 *   - ListingGroupInfo: type, case_value (ListingDimensionInfo; "Undefined for the root group"), parent_ad_group_criterion
 *     ("Null for the root group"). ListingGroupTypeEnum: SUBDIVISION | UNIT.
 *   - ListingDimensionInfo is a oneof `dimension`; the Shopping members (docs/shopping-ads/create-listing-groups,
 *     "Available dimensions"): product_brand (ProductBrandInfo.value), product_category (ProductCategoryInfo.category_id
 *     int64 — the google_product_category id — and level), product_channel (ProductChannelInfo.channel),
 *     product_channel_exclusivity (ProductChannelExclusivityInfo.channel_exclusivity), product_condition
 *     (ProductConditionInfo.condition), product_custom_attribute (ProductCustomAttributeInfo.index and value),
 *     product_item_id (ProductItemIdInfo.value), product_type (ProductTypeInfo.level and value). REST JSON is lowerCamelCase.
 *   - Enums: ProductCategoryLevel and ProductTypeLevel LEVEL1–LEVEL5; ProductCustomAttributeIndex INDEX0–INDEX4;
 *     ProductCondition NEW | USED | REFURBISHED; ProductChannel ONLINE | LOCAL; ProductChannelExclusivity SINGLE_CHANNEL |
 *     MULTI_CHANNEL.
 *   - create-listing-groups: every subdivision is completely partitioned — it has an "Other" child, its dimension with no
 *     value (else CriterionError.LISTING_GROUP_SUBDIVISION_REQUIRES_OTHERS_CASE); children of one subdivision share one
 *     dimension; only units take a bid, an excluded unit (negative) none; a new subdivision is made in the request that
 *     makes its children and its Other; new nodes use temporary ids (any negative number), existing ones their real ids.
 *   - CriterionErrorEnum.CriterionError: INVALID_LISTING_DIMENSION (a value may not hold "==" or "&+");
 *     INVALID_LISTING_DIMENSION_TYPE ("BIDDING_CATEGORY_Lx and PRODUCT_TYPE_Lx dimensions must be used in ascending order
 *     of their levels … start from L1 … an 'others' Listing group cannot be subdivided with a dimension of the same type
 *     but of a higher level"); DUPLICATE_LISTING_DIMENSION_TYPE / _VALUE; LISTING_GROUP_CANNOT_BE_REMOVED ("Recursive
 *     removal failed because listing group subdivision is being created or modified in this request");
 *     LISTING_GROUP_TREE_TOO_DEEP / LISTING_GROUP_TOO_LONG (Google's own limits: its check judges them).
 *   - AdGroupCriterion: listing_group and negative are Immutable; cpc_bid_micros is not (a bid change is an update).
 *
 * So a plan never removes a subdivision in a request that makes or changes anything else: a request that must remove one
 * (a split that goes, a split that becomes a unit or changes dimension under a split) is either removals only, or it is
 * done in two steps the person asks for one after the other (step 1 removes, step 2 — the same request again — makes the
 * rest), each checked by Google before it is queued. Removing a UNIT is not a recursive removal: a unit becomes a split
 * (remove the unit, make the split with the same case under the same parent) in one request. One exception, by the
 * error's own words ("subdivision is being created or modified"): the ROOT split replaced by "All products" alone makes
 * no split and changes none (the new root has no parent), so the removal and the root unit go in one request. Google's
 * guides do not say more (its sample removes a tree in one request and builds the new one, a split, in another); its
 * check of the preview (validate_only) judges it before anything is queued.
 */
import type { BuildProductNode } from './change-build.js'
import { money, plural } from './change-draft.js'
import { microsOfCents } from './live.js'
import type { ProductGroupNode } from './live-product-groups.js'
import { productItemKey } from './mappers.js'
import type { GoogleMutateOperation } from './write-client.js'

type Json = Record<string, unknown>

// ── dimensions ──────────────────────────────────────────────────────────────────────────────────────────────────

export const DIMENSIONS = [
  'ITEM_ID', 'BRAND', 'CONDITION', 'CHANNEL', 'CHANNEL_EXCLUSIVITY',
  'PRODUCT_TYPE_1', 'PRODUCT_TYPE_2', 'PRODUCT_TYPE_3', 'PRODUCT_TYPE_4', 'PRODUCT_TYPE_5',
  'CATEGORY_1', 'CATEGORY_2', 'CATEGORY_3', 'CATEGORY_4', 'CATEGORY_5',
  'CUSTOM_LABEL_0', 'CUSTOM_LABEL_1', 'CUSTOM_LABEL_2', 'CUSTOM_LABEL_3', 'CUSTOM_LABEL_4',
] as const
export type Dimension = typeof DIMENSIONS[number]

/** The values Google knows for the enum dimensions (ProductCondition, ProductChannel, ProductChannelExclusivity). */
export const ENUM_VALUES: Partial<Record<Dimension, readonly string[]>> = {
  CONDITION: ['NEW', 'USED', 'REFURBISHED'],
  CHANNEL: ['ONLINE', 'LOCAL'],
  CHANNEL_EXCLUSIVITY: ['SINGLE_CHANNEL', 'MULTI_CHANNEL'],
}

/** Most product groups one request builds (the tool's limit: every array of a tool is bounded to 250). */
export const MAX_TREE_NODES = 250
/** Merchant Center's limit for an item id (1–50 characters). */
const MAX_ITEM_ID = 50

interface DimParts { key: string; field: string; part?: { name: 'level' | 'index'; value: string } }

function partsOf(dim: Dimension): DimParts {
  const n = dim.slice(dim.lastIndexOf('_') + 1)
  if (dim.startsWith('PRODUCT_TYPE_')) return { key: 'productType', field: 'value', part: { name: 'level', value: `LEVEL${n}` } }
  if (dim.startsWith('CATEGORY_')) return { key: 'productCategory', field: 'categoryId', part: { name: 'level', value: `LEVEL${n}` } }
  if (dim.startsWith('CUSTOM_LABEL_')) return { key: 'productCustomAttribute', field: 'value', part: { name: 'index', value: `INDEX${n}` } }
  switch (dim) {
    case 'ITEM_ID': return { key: 'productItemId', field: 'value' }
    case 'BRAND': return { key: 'productBrand', field: 'value' }
    case 'CONDITION': return { key: 'productCondition', field: 'condition' }
    case 'CHANNEL': return { key: 'productChannel', field: 'channel' }
    default: return { key: 'productChannelExclusivity', field: 'channelExclusivity' }
  }
}

/** Google's ListingDimensionInfo (REST JSON) of a dimension and a value; null value = "everything else" (Other). */
export function caseValueOf(dim: Dimension, value: string | null): Json {
  const p = partsOf(dim)
  return { [p.key]: { ...(p.part ? { [p.part.name]: p.part.value } : {}), ...(value !== null ? { [p.field]: value } : {}) } }
}

/** The dimension string live-product-groups.ts reads (`productType:LEVEL1`) of a dimension. */
export function liveDimensionOf(dim: Dimension): string {
  const p = partsOf(dim)
  return p.part ? `${p.key}:${p.part.value}` : p.key
}

const BY_LIVE = new Map<string, Dimension>(DIMENSIONS.map((d) => [liveDimensionOf(d), d]))
/** A live dimension string as a Dimension; null when it is none of the Shopping dimensions Nexus knows. */
export const dimensionOfLive = (live: string | null | undefined): Dimension | null => (live ? BY_LIVE.get(live) ?? null : null)

const UNSET = new Set(['UNSPECIFIED', 'UNKNOWN'])
/** A ListingDimensionInfo as Google answers it: its dimension and its value (null = Other, or a value Google left out). */
export function dimensionOfCase(cv: unknown): { dim: Dimension | null; raw: string | null; value: string | null } {
  if (!cv || typeof cv !== 'object' || !Object.keys(cv).length) return { dim: null, raw: null, value: null }
  const [key, inner] = Object.entries(cv as Json)[0] as [string, Json | undefined]
  const part = inner && typeof inner === 'object' ? (inner.level ?? inner.index) : undefined
  const raw = part ? `${key}:${String(part)}` : key
  const dim = dimensionOfLive(raw)
  const field = dim ? partsOf(dim).field : 'value'
  const v = inner && typeof inner === 'object' ? inner[field] : undefined
  const value = typeof v === 'string' || typeof v === 'number' ? String(v) : null
  return { dim, raw, value: value && !UNSET.has(value) ? value : null }
}

const family = (d: Dimension): 'PRODUCT_TYPE' | 'CATEGORY' | null => (d.startsWith('PRODUCT_TYPE_') ? 'PRODUCT_TYPE' : d.startsWith('CATEGORY_') ? 'CATEGORY' : null)
const levelOf = (d: Dimension): number => Number(d.slice(-1))

/** A dimension in words: `item ID`, `brand`, `product type (level 2)`, `custom label 0`, … */
export function dimensionWords(dim: Dimension | null, raw: string | null = null): string {
  if (!dim) return raw ?? 'a dimension Nexus cannot tell'
  if (dim.startsWith('PRODUCT_TYPE_')) return `product type (level ${levelOf(dim)})`
  if (dim.startsWith('CATEGORY_')) return `category (level ${levelOf(dim)})`
  if (dim.startsWith('CUSTOM_LABEL_')) return `custom label ${levelOf(dim)}`
  return { ITEM_ID: 'item ID', BRAND: 'brand', CONDITION: 'condition', CHANNEL: 'channel', CHANNEL_EXCLUSIVITY: 'channel exclusivity' }[dim as string] ?? dim
}

/** How two values of one dimension compare: item ids and texts without case (Merchant Center may read ids differing only by case as one). */
export function valueKey(dim: Dimension | null, value: string): string {
  if (dim === 'ITEM_ID') return productItemKey(value)
  if (dim && ENUM_VALUES[dim]) return value.trim().toUpperCase()
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** A value of a dimension as Google takes it, or why not. */
export function cleanValue(dim: Dimension, raw: unknown, where: string): { value: string } | { refusal: string } {
  const v = String(raw ?? '').trim()
  if (!v) return { refusal: `${where}: the value is empty (a product group with no value is "everything else": use everythingElse).` }
  const allowed = ENUM_VALUES[dim]
  if (allowed) {
    const up = v.toUpperCase()
    return allowed.includes(up) ? { value: up } : { refusal: `${where}: "${v}" is not a ${dimensionWords(dim)} Google knows (${allowed.join(', ')}).` }
  }
  if (family(dim) === 'CATEGORY' && !/^\d{1,20}$/.test(v)) return { refusal: `${where}: a category is Google's product category id (digits, the google_product_category id of Merchant Center), not "${v.slice(0, 60)}".` }
  if (v.includes('==') || v.includes('&+')) return { refusal: `${where}: "${v.slice(0, 60)}" holds "==" or "&+", which Google refuses in a product group.` }
  if (dim === 'ITEM_ID' && v.length > MAX_ITEM_ID) return { refusal: `${where}: the item id "${v.slice(0, 60)}" has ${v.length} characters (a Merchant Center item id has at most ${MAX_ITEM_ID}).` }
  return { value: v }
}

// ── a tree ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TNode {
  /** Google's criterion id: a live node, or a node of a plan that stays; `op:<n>` once planned for creation. */
  id?: string
  /** The dimension of this node's case (its parent's split); null for the root, or a dimension Nexus cannot tell. */
  dim: Dimension | null
  /** The live dimension string when `dim` is null (a dimension Nexus does not know): words only. */
  raw?: string | null
  /** null for the root and for "everything else". */
  value: string | null
  kind: 'SUBDIVISION' | 'UNIT'
  /** A subdivision's dimension (its children's); null for a unit, or when Nexus cannot tell it. */
  split: Dimension | null
  excluded: boolean
  bidCents: number | null
  /** The case value as Google holds it (a live node): a unit made again keeps it exactly. */
  caseValue?: Json | null
  children: TNode[]
}

const isOther = (n: TNode, parent: TNode | null) => parent !== null && n.value === null
const OTHER_KEY = '\u0000other'
const childKey = (parent: TNode, c: TNode) => (c.value === null ? OTHER_KEY : valueKey(parent.split ?? c.dim, c.value))

/** Every node of a tree, parents first, with its parent. */
export function walk(root: TNode | null): Array<{ node: TNode; parent: TNode | null; chain: TNode[] }> {
  const out: Array<{ node: TNode; parent: TNode | null; chain: TNode[] }> = []
  const go = (n: TNode, parent: TNode | null, chain: TNode[]) => {
    const here = [...chain, n]
    out.push({ node: n, parent, chain: here })
    for (const c of n.children) go(c, n, here)
  }
  if (root) go(root, null, [])
  return out
}

/** Google ids compared as numbers. */
function byCriterionId(a: string, b: string): number {
  const x = /^\d+$/.test(a) ? BigInt(a) : null
  const y = /^\d+$/.test(b) ? BigInt(b) : null
  if (x !== null && y !== null) return x < y ? -1 : x > y ? 1 : 0
  return a < b ? -1 : a > b ? 1 : 0
}

/** The tree Google holds, from the live listing groups; or why it does not read as one tree. */
export function treeOfLive(nodes: ProductGroupNode[]): { root: TNode | null } | { refusal: string } {
  if (!nodes.length) return { root: null }
  const byParent = new Map<string | null, ProductGroupNode[]>()
  for (const n of nodes) byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), n])
  const roots = byParent.get(null) ?? []
  if (roots.length !== 1) return { refusal: `the product groups do not read as one tree (${plural(roots.length, 'root')})` }
  let seen = 0
  const build = (n: ProductGroupNode, dim: Dimension | null, depth: number): TNode => {
    seen += 1
    // Children by Google id, whatever order Google answers in: the same tree always gives the same plan.
    const kids = depth < 50 ? [...(byParent.get(n.criterionId) ?? [])].sort((a, b) => byCriterionId(a.criterionId, b.criterionId)) : []
    const kind = n.kind === 'SUBDIVISION' ? 'SUBDIVISION' : 'UNIT'
    // A subdivision's dimension: what its children say (Google may leave the Other's empty case value out).
    const named = kids.find((k) => k.dimension)
    const split = kind === 'SUBDIVISION' ? dimensionOfLive(named?.dimension) : null
    return {
      id: n.criterionId,
      dim,
      raw: n.dimension,
      value: n.value,
      kind,
      split,
      excluded: n.excluded,
      // A split has no bid of its own (Google may still answer one).
      bidCents: n.excluded || kind === 'SUBDIVISION' ? null : n.bidCents,
      caseValue: n.caseValue,
      children: kids.map((k) => build(k, split ?? dimensionOfLive(k.dimension), depth + 1)),
    }
  }
  const root = build(roots[0], null, 0)
  if (seen !== nodes.length) return { refusal: `${plural(nodes.length - seen, 'product group')} hang under no product group of the tree` }
  return { root }
}

/** One product group of a tree as a person gives it: flat, its parent by index (parents first). */
export interface TreeSpecNode {
  /** The index of its parent in the list; left out for the root ("All products"), which comes first. */
  parent?: number
  /** Its value of the parent's dimension. */
  value?: string
  /** It is "everything else" of its parent's dimension (every product the parent's other children do not name). */
  everythingElse?: boolean
  /** It is split further by this dimension (a subdivision: no bid). */
  split?: Dimension
  /** A unit advertised at this bid (cents a click). */
  bidCents?: number
  /** A unit that is excluded (never advertised here). */
  excluded?: boolean
}

const badBid = (cents: unknown) => typeof cents !== 'number' || !Number.isInteger(cents) || cents < 1

/** A unit's state from a request: a bid, or excluded — one of the two. */
export function unitStateOf(u: { bidCents?: number; excluded?: boolean }, where: string): { excluded: boolean; bidCents: number | null } | { refusal: string } {
  if (u.excluded === true) {
    if (u.bidCents !== undefined) return { refusal: `${where}: an excluded product group takes no bid.` }
    return { excluded: true, bidCents: null }
  }
  if (u.bidCents === undefined) return { refusal: `${where}: give its bidCents (a click), or excluded: true.` }
  if (badBid(u.bidCents)) return { refusal: `${where}: the bid is not a whole number of cents of at least 1.` }
  return { excluded: false, bidCents: u.bidCents }
}

/**
 * Why a node (the last of `chain`, root first) cannot be split by `split` — Google's order of levels and no dimension
 * twice on a path (CriterionError.INVALID_LISTING_DIMENSION_TYPE, DUPLICATE_LISTING_DIMENSION_TYPE) — or null.
 */
export function splitProblem(chain: TNode[], split: Dimension): string | null {
  const cases = chain.slice(1)
  const f = family(split)
  if (!f) {
    return cases.some((c) => c.dim === split) ? `it is already split by ${dimensionWords(split)} above it` : null
  }
  const k = levelOf(split)
  if (cases.some((c) => c.dim && family(c.dim) === f && levelOf(c.dim) >= k)) return `it is already split by ${f === 'CATEGORY' ? 'category' : 'product type'} at level ${k} or deeper above it`
  if (k > 1 && !cases.some((c) => c.dim === `${f}_${k - 1}` && c.value !== null)) {
    return `a split by ${dimensionWords(split)} needs a product group of level ${k - 1} with a value above it (Google takes the levels in order from 1, and never splits "everything else" of a level by the next level)`
  }
  return null
}

/** A tree a person gave, checked against Google's rules for a listing group tree; or the first problem, in words. */
export function treeOfSpec(spec: TreeSpecNode[], where = 'tree'): { root: TNode } | { refusal: string } {
  if (!spec.length) return { refusal: `${where}: give at least the root ("All products").` }
  if (spec.length > MAX_TREE_NODES) return { refusal: `${where}: ${spec.length} product groups, at most ${MAX_TREE_NODES} in one request.` }
  const made: TNode[] = []
  const chains: TNode[][] = []
  for (const [i, s] of spec.entries()) {
    const at = `${where}[${i}]`
    const isRoot = s.parent === undefined || s.parent === null
    if (i === 0 && !isRoot) return { refusal: `${at}: the first product group is the root ("All products"), with no parent.` }
    if (i > 0 && isRoot) return { refusal: `${at}: only the first product group is the root; give its parent (an index before it).` }
    let node: TNode
    if (isRoot) {
      if (s.value !== undefined || s.everythingElse) return { refusal: `${at}: the root is "All products": it has no value.` }
      node = { dim: null, value: null, kind: 'UNIT', split: null, excluded: false, bidCents: null, children: [] }
      chains[i] = [node]
    } else {
      const p = Number(s.parent)
      if (!Number.isInteger(p) || p < 0 || p >= i) return { refusal: `${at}: its parent must be the index of a product group before it.` }
      const parent = made[p]
      if (!parent.split) return { refusal: `${at}: its parent ${where}[${p}] is not split (give the parent a split).` }
      const other = s.everythingElse === true
      if (other === (s.value !== undefined && s.value !== '')) return { refusal: `${at}: give a value, or everythingElse: true — one of the two.` }
      let value: string | null = null
      if (!other) {
        const clean = cleanValue(parent.split, s.value, at)
        if ('refusal' in clean) return clean
        value = clean.value
      }
      node = { dim: parent.split, value, kind: 'UNIT', split: null, excluded: false, bidCents: null, children: [] }
      const key = childKey(parent, node)
      if (parent.children.some((c) => childKey(parent, c) === key)) {
        return { refusal: other ? `${at}: ${where}[${p}] has two "everything else".` : `${at}: ${where}[${p}] names "${value}" twice (values are compared without case).` }
      }
      parent.children.push(node)
      chains[i] = [...chains[p], node]
    }
    if (s.split) {
      if (s.bidCents !== undefined || s.excluded !== undefined) return { refusal: `${at}: a split has no bid and is not excluded itself: its product groups are.` }
      if (!(DIMENSIONS as readonly string[]).includes(s.split)) return { refusal: `${at}: "${s.split}" is not a dimension Nexus splits by (${DIMENSIONS.join(', ')}).` }
      const problem = splitProblem(chains[i], s.split)
      if (problem) return { refusal: `${at}: cannot split by ${dimensionWords(s.split)}: ${problem}.` }
      node.kind = 'SUBDIVISION'
      node.split = s.split
    } else {
      const state = unitStateOf(s, at)
      if ('refusal' in state) return state
      node.excluded = state.excluded
      node.bidCents = state.bidCents
    }
    made[i] = node
  }
  for (const [i, n] of made.entries()) {
    if (n.kind !== 'SUBDIVISION') continue
    const named = n.children.filter((c) => c.value !== null).length
    if (named === 0) return { refusal: `${where}[${i}] is split by ${dimensionWords(n.split)} but names no value: a split needs at least one product group besides "everything else".` }
    if (named === n.children.length) return { refusal: `${where}[${i}] is split by ${dimensionWords(n.split)} without "everything else": Google needs one in every split (add a child with everythingElse: true).` }
  }
  return { root: made[0] }
}

// ── snapshot (what a change keeps, what undo gives back) ────────────────────────────────────────────────────────

export interface TreeSnapNode {
  id: string | null
  parent: number | null
  /** The dimension of its case (its parent's split); null for the root. */
  dim: Dimension | null
  value: string | null
  kind: 'SUBDIVISION' | 'UNIT'
  split: Dimension | null
  excluded: boolean
  bidCents: number | null
}

/** Children in one order whatever order Google answers in: named values first (by value), "everything else" last. */
function ordered(parent: TNode): TNode[] {
  return [...parent.children].sort((a, b) => {
    const x = childKey(parent, a)
    const y = childKey(parent, b)
    return x === y ? 0 : x === OTHER_KEY ? 1 : y === OTHER_KEY ? -1 : x < y ? -1 : 1
  })
}

/** A tree as a flat list, parents first, in one canonical order (the same tree always gives the same list). */
export function snapshotOf(root: TNode | null): TreeSnapNode[] {
  const out: TreeSnapNode[] = []
  const go = (n: TNode, parent: number | null) => {
    const at = out.length
    out.push({ id: n.id ?? null, parent, dim: parent === null ? null : n.dim, value: n.value, kind: n.kind, split: n.kind === 'SUBDIVISION' ? n.split : null, excluded: n.excluded, bidCents: n.excluded || n.kind === 'SUBDIVISION' ? null : n.bidCents })
    if (n.kind === 'SUBDIVISION') for (const c of ordered(n)) go(c, at)
  }
  if (root) go(root, null)
  return out
}

/** The tree of a snapshot (ids kept). */
export function treeOfSnapshot(snap: TreeSnapNode[]): TNode | null {
  const made: TNode[] = []
  for (const [i, s] of snap.entries()) {
    const n: TNode = { ...(s.id ? { id: s.id } : {}), dim: s.dim, value: s.value, kind: s.kind, split: s.split, excluded: s.excluded, bidCents: s.bidCents, children: [] }
    made[i] = n
    if (s.parent !== null && made[s.parent]) made[s.parent].children.push(n)
  }
  return made[0] ?? null
}

/** A snapshot as the `tree` argument that builds it again; or why it cannot be given (a dimension Nexus cannot tell, an advertised unit without a bid). */
export function specOfSnapshot(snap: TreeSnapNode[]): TreeSpecNode[] | { refusal: string } {
  if (snap.length > MAX_TREE_NODES) return { refusal: `the tree had ${snap.length} product groups, more than the ${MAX_TREE_NODES} one request builds` }
  const out: TreeSpecNode[] = []
  for (const [i, s] of snap.entries()) {
    if (i > 0 && (s.dim === null || s.parent === null)) return { refusal: 'the tree had a product group of a dimension Nexus cannot tell' }
    if (s.kind === 'SUBDIVISION' && !s.split) return { refusal: 'the tree had a split by a dimension Nexus cannot tell' }
    if (s.kind === 'UNIT' && !s.excluded && badBid(s.bidCents)) return { refusal: 'a product group of the tree was advertised with no bid of its own (Google set its bids)' }
    out.push({
      ...(i > 0 ? { parent: s.parent! } : {}),
      ...(i > 0 ? (s.value === null ? { everythingElse: true } : { value: s.value }) : {}),
      ...(s.kind === 'SUBDIVISION' ? { split: s.split! } : s.excluded ? { excluded: true } : { bidCents: s.bidCents! }),
    })
  }
  return out
}

/** A tree as live-product-groups.ts nodes (ids as planned), so the rest of the product group code reads it like a live one. */
export function liveNodesOf(root: TNode | null): ProductGroupNode[] {
  const out: ProductGroupNode[] = []
  let n = 0
  const go = (node: TNode, parentId: string | null) => {
    const id = node.id ?? `new:${n++}`
    out.push({
      criterionId: id,
      parentId,
      kind: node.kind,
      caseValue: parentId === null ? null : node.caseValue ?? (node.dim ? caseValueOf(node.dim, node.value) : null),
      dimension: node.dim ? liveDimensionOf(node.dim) : node.raw ?? null,
      value: node.value,
      excluded: node.excluded,
      bidCents: node.excluded || node.kind === 'SUBDIVISION' ? null : node.bidCents,
    })
    for (const c of node.children) go(c, id)
  }
  if (root) go(root, null)
  return out
}

/**
 * A tree a person gave as the build takes it (change-build.ts BuildProductNode: parents by index, the case values Google
 * takes), checked against Google's rules first; or the first problem.
 */
export function buildNodesOfSpec(spec: TreeSpecNode[], where = 'productGroups.nodes'): BuildProductNode[] | { refusal: string } {
  const tree = treeOfSpec(spec, where)
  if ('refusal' in tree) return tree
  const out: BuildProductNode[] = []
  const go = (n: TNode, parent: number | null, parentSplit: Dimension | null) => {
    const at = out.length
    out.push({
      parent, kind: n.kind, caseValue: parent === null || !parentSplit ? null : caseValueOf(parentSplit, n.value),
      excluded: n.excluded, bidCents: n.excluded ? null : n.bidCents, rest: parent !== null && n.value === null,
    })
    for (const c of ordered(n)) go(c, at, n.split)
  }
  go(tree.root, null, null)
  return out
}

// ── words ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** One step of a path: `brand "X"`, `condition used`, `everything else (by brand)`. */
function segment(n: TNode): string {
  if (n.value === null) return `everything else (by ${dimensionWords(n.dim, n.raw)})`
  const d = n.dim
  if (!d) return `${n.raw ?? 'product group'} "${n.value}"`
  if (d === 'ITEM_ID') return `item "${n.value}"`
  if (d === 'BRAND') return `brand "${n.value}"`
  if (d === 'CONDITION') return `condition ${n.value.toLowerCase()}`
  if (d === 'CHANNEL') return `channel ${n.value.toLowerCase()}`
  if (d === 'CHANNEL_EXCLUSIVITY') return `channel exclusivity ${n.value.toLowerCase().replace('_', ' ')}`
  if (d.startsWith('CATEGORY_')) return `category ${levelOf(d)} ${n.value}`
  if (d.startsWith('PRODUCT_TYPE_')) return `product type ${levelOf(d)} "${n.value}"`
  return `custom label ${levelOf(d)} "${n.value}"`
}

/** A node as a person reads it: its path from "All products" (`brand "X" › item "abc"`). */
export function pathLabel(chain: TNode[]): string {
  return chain.length <= 1 ? '"All products"' : chain.slice(1).map(segment).join(' › ')
}

export const stateLabel = (n: { excluded: boolean; bidCents: number | null }, currency: string) =>
  n.excluded ? 'excluded' : n.bidCents === null ? 'advertised (no bid of its own)' : `${money(n.bidCents, currency)} a click`

/** A whole tree in a sentence. */
export function describeTNode(root: TNode | null, currency: string): string {
  if (!root) return 'no product groups (the ad group shows no products)'
  if (root.kind === 'UNIT') return `"All products" alone, ${stateLabel(root, currency)}`
  const all = walk(root)
  const units = all.filter((w) => w.node.kind === 'UNIT')
  const excluded = units.filter((w) => w.node.excluded).length
  const levels = Math.max(...all.map((w) => w.chain.length)) - 1
  return `"All products" split by ${dimensionWords(root.split)}: ${plural(levels, 'level')}, ${plural(all.length, 'product group')} (${plural(units.length, 'unit')}${excluded ? `, ${excluded} excluded` : ''})`
}

// ── the plan: one tree into another ─────────────────────────────────────────────────────────────────────────────

export interface TreePlan {
  updates: GoogleMutateOperation[]
  removes: GoogleMutateOperation[]
  creates: GoogleMutateOperation[]
  /** Live subdivisions that must go (a recursive removal each). */
  splitsToRemove: Array<{ node: TNode; parent: TNode | null }>
  /** Desired nodes that can only be made once a split is removed (a split that becomes a unit): a second request. */
  waiting: TNode[]
  /** Live units removed for good: their products fall under "everything else" of the desired parent. */
  dropped: Array<{ node: TNode; parent: TNode }>
  /** Desired nodes made in this request, by their place in `creates`. */
  created: Map<TNode, number>
  /** Desired units that stay and get a new bid. */
  bidChanges: Array<{ node: TNode; from: number | null }>
  /** Live units removed and made again (switched between advertised and excluded, or replaced by a split). */
  remade: Array<{ node: TNode; was: TNode }>
  /** The live root split removed (with everything under it) in the request that makes "All products" alone. */
  rootReplaced: TNode | null
}

const createOp = (resourceName: string, parent: string | null, caseValue: Json | null, n: TNode): GoogleMutateOperation => ({
  adGroupCriterionOperation: {
    create: {
      resourceName,
      status: 'ENABLED',
      listingGroup: { type: n.kind, ...(parent ? { parentAdGroupCriterion: parent } : {}), ...(caseValue ? { caseValue } : {}) },
      ...(n.kind === 'UNIT' ? (n.excluded ? { negative: true } : n.bidCents !== null ? { cpcBidMicros: microsOfCents(n.bidCents) } : {}) : {}),
    },
  },
})

/**
 * The operations that turn the live tree into the desired one, matching product groups by their case (dimension and
 * value, without case): what stays keeps its id; a bid is an update; anything else is removed and made again. Live
 * subdivisions that must go are listed in `splitsToRemove` and get NO operation here — the caller decides (removals only,
 * two steps, or a refusal). The desired nodes get `id`: the live id they keep, or `op:<n>` (the operation that makes them).
 */
export function planTree(live: TNode | null, desired: TNode | null, crit: (id: string | number) => string): TreePlan {
  const plan: TreePlan = { updates: [], removes: [], creates: [], splitsToRemove: [], waiting: [], dropped: [], created: new Map(), bidChanges: [], remade: [], rootReplaced: null }
  let temp = -1
  const removal = (n: TNode) => ({ adGroupCriterionOperation: { remove: crit(n.id!) } })
  const make = (d: TNode, parentRes: string | null, caseValue: Json | null) => {
    const res = crit(temp--)
    plan.created.set(d, plan.creates.length)
    plan.creates.push(createOp(res, parentRes, caseValue, d))
    if (d.kind === 'SUBDIVISION') for (const c of ordered(d)) make(c, res, caseValueOf(d.split!, c.value))
  }
  const caseOfLive = (l: TNode, d: TNode) => l.caseValue ?? (d.dim ? caseValueOf(d.dim, d.value) : null)
  const goAway = (l: TNode, parent: TNode | null, desiredParent: TNode | null) => {
    if (l.kind === 'SUBDIVISION') plan.splitsToRemove.push({ node: l, parent })
    else {
      plan.removes.push(removal(l))
      if (desiredParent) plan.dropped.push({ node: l, parent: desiredParent })
    }
  }
  const match = (l: TNode, d: TNode, parentRes: string | null, liveParent: TNode | null) => {
    // Matched without case: what Google holds keeps its own spelling (and its case value).
    if (liveParent) { d.value = l.value; d.caseValue = l.caseValue }
    if (l.kind === 'UNIT' && d.kind === 'UNIT') {
      if (l.excluded === d.excluded) {
        d.id = l.id
        if (!d.excluded && d.bidCents !== null && l.bidCents !== d.bidCents) {
          plan.updates.push({ adGroupCriterionOperation: { update: { resourceName: crit(l.id!), cpcBidMicros: microsOfCents(d.bidCents) }, updateMask: 'cpc_bid_micros' } })
          plan.bidChanges.push({ node: d, from: l.bidCents })
        }
        return
      }
      plan.removes.push(removal(l))
      plan.remade.push({ node: d, was: l })
      make(d, parentRes, caseOfLive(l, d))
      return
    }
    if (l.kind === 'UNIT') {
      // A unit becomes a split: removing a unit is not recursive, so it goes with the new split in one request.
      plan.removes.push(removal(l))
      plan.remade.push({ node: d, was: l })
      make(d, parentRes, caseOfLive(l, d))
      return
    }
    if (d.kind === 'UNIT') {
      if (!liveParent) {
        // The root split becomes "All products" alone. LISTING_GROUP_CANNOT_BE_REMOVED refuses a recursive removal only
        // "because listing group subdivision is being created or modified in this request": a root UNIT is neither (it
        // has no parent split), so the removal and the new root go in one request, the removal first.
        plan.removes.push(removal(l))
        plan.remade.push({ node: d, was: l })
        plan.rootReplaced = l
        make(d, null, null)
        return
      }
      plan.splitsToRemove.push({ node: l, parent: liveParent })
      plan.waiting.push(d)
      return
    }
    d.id = l.id
    const res = crit(l.id!)
    if (l.split && l.split === d.split) {
      const live = new Map(l.children.map((c) => [childKey(l, c), c]))
      const paired = new Set<TNode>()
      for (const dc of ordered(d)) {
        const lc = live.get(childKey(d, dc))
        if (lc) { paired.add(lc); match(lc, dc, res, l) }
        else make(dc, res, caseValueOf(d.split!, dc.value))
      }
      for (const lc of ordered(l)) if (!paired.has(lc)) goAway(lc, l, d)
      return
    }
    // The split keeps its id and changes dimension: every child goes, the new ones are made under it.
    for (const lc of ordered(l)) goAway(lc, l, null)
    for (const dc of ordered(d)) make(dc, res, caseValueOf(d.split!, dc.value))
  }
  if (live && desired) match(live, desired, null, null)
  else if (desired) make(desired, null, null)
  else if (live) goAway(live, null, null)
  const offset = plan.updates.length + plan.removes.length
  for (const [node, at] of plan.created) node.id = `op:${offset + at}`
  return plan
}

/**
 * What step 1 of a two-step change removes: each live split that must go — or, when that would leave a split without
 * what every split needs, the nearest split above it that can go alone: a split cannot lose its "everything else", and
 * a split left with only "everything else" is no tree Nexus (or its undo) can build again. The root means the whole tree.
 * The tree that stays after step 1 is always a tree Google and Nexus take as it is.
 */
export function stepOneRemovals(plan: TreePlan, live: TNode): TNode[] {
  const parentOf = new Map<TNode, TNode | null>(walk(live).map((w) => [w.node, w.parent]))
  const climb = (node: TNode) => {
    let n = node
    let p = parentOf.get(n) ?? null
    while (p && isOther(n, p)) { n = p; p = parentOf.get(n) ?? null }
    return n
  }
  const picked = new Set<TNode>(plan.splitsToRemove.map((s) => climb(s.node)))
  const under = (n: TNode) => { let p = parentOf.get(n) ?? null; while (p) { if (picked.has(p)) return true; p = parentOf.get(p) ?? null } return false }
  for (let moved = true; moved;) {
    moved = false
    for (const n of [...picked]) {
      if (!picked.has(n) || under(n)) { picked.delete(n); continue }
      const p = parentOf.get(n) ?? null
      // Every named product group of its parent goes: the parent goes instead (it would keep only "everything else").
      if (p && p.children.filter((c) => c.value !== null).every((c) => picked.has(c))) {
        for (const c of p.children) picked.delete(c)
        picked.add(climb(p))
        moved = true
      }
    }
  }
  return walk(live).map((w) => w.node).filter((n) => picked.has(n) && !under(n))
}

/** A tree without the given subtrees (ids kept); null when the root is one of them. */
export function withoutSubtrees(root: TNode | null, gone: TNode[]): TNode | null {
  if (!root || gone.includes(root)) return null
  const strip = (n: TNode): TNode => ({ ...n, children: n.children.filter((c) => !gone.includes(c)).map(strip) })
  return strip(root)
}

// ── reading the old tree ────────────────────────────────────────────────────────────────────────────────────────

export interface Reach { serves: boolean | null; bidCents: number | null; label: string }

/** The state every unit under a node shares, or null when they differ. */
function uniform(n: TNode): { excluded: boolean; bidCents: number | null } | null {
  const units = walk(n).map((w) => w.node).filter((x) => x.kind === 'UNIT')
  if (!units.length) return null
  const first = units[0]
  return units.every((u) => u.excluded === first.excluded && (u.excluded || u.bidCents === first.bidCents)) ? { excluded: first.excluded, bidCents: first.excluded ? null : first.bidCents } : null
}

const reachOfState = (s: { excluded: boolean; bidCents: number | null }, where: string, currency: string): Reach =>
  ({ serves: !s.excluded, bidCents: s.excluded ? null : s.bidCents, label: `${where}: ${stateLabel(s, currency)}` })

/** How the products of a path (its cases, root first) were advertised in a tree: by the unit they fell in, or null when Nexus cannot tell. */
export function reachAt(root: TNode | null, path: TNode[], currency: string): Reach {
  if (!root) return { serves: false, bidCents: null, label: 'not advertised (no product groups)' }
  let node = root
  let chain = [root]
  for (const step of path) {
    if (node.kind === 'UNIT') break
    if (!node.split || node.split !== step.dim) {
      const u = uniform(node)
      return u ? reachOfState(u, `in ${pathLabel(chain)}`, currency) : { serves: null, bidCents: null, label: `in ${pathLabel(chain)}, split by ${dimensionWords(node.split)} (Nexus cannot match it product by product)` }
    }
    const key = step.value === null ? OTHER_KEY : valueKey(step.dim, step.value)
    const next = node.children.find((c) => childKey(node, c) === key) ?? node.children.find((c) => c.value === null)
    if (!next) return { serves: null, bidCents: null, label: `in ${pathLabel(chain)} (Nexus cannot tell)` }
    node = next
    chain = [...chain, next]
  }
  if (node.kind === 'UNIT') return reachOfState(node, `in ${pathLabel(chain)}`, currency)
  const u = uniform(node)
  return u ? reachOfState(u, `in ${pathLabel(chain)}`, currency) : { serves: null, bidCents: null, label: `in ${pathLabel(chain)} (split further: Nexus cannot match it product by product)` }
}
