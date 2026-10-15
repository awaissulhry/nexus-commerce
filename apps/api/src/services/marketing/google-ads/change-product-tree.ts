/**
 * Google Ads Shopping (2026-10-15, G4) — set-google-product-groups on a tree of ANY shape: the whole tree as it should be
 * (`tree`), or edits of the tree as it is (`add` a product group under a split, `subdivide` a unit, `remove` a product
 * group or a split, `removeTree`), with bids / exclude / include in the same request. Built from the request and the ad
 * group's live tree (product-tree.ts plans it), without any call: pure.
 *
 * Google never removes a split in a request that makes or changes product groups (LISTING_GROUP_CANNOT_BE_REMOVED, see
 * product-tree.ts). So:
 *   - a request that removes a split holds removals only (the split's products fall under "everything else" of its
 *     parent);
 *   - a whole `tree` that needs a split removed AND product groups made is refused, or — with `inTwoSteps` — done in two
 *     changes: step 1 removes (and only removes) what must go; step 2 is the same request asked again once step 1 ran,
 *     and makes the rest. Each step is its own preview, checked by Google, approved by a person. Between the two the
 *     preview says where the products of what was removed fall (and marks it SPENDS MONEY when that advertises them);
 *   - everything else (bids, units switched, units made, a unit split further, a split's dimension changed when only
 *     units hang under it) is ONE request, and what stays keeps its id and statistics.
 *
 * Undo: the change keeps the whole tree before and after (snapshots, with ids); undo asks for the old tree with `tree`
 * (and `inTwoSteps`, as putting a unit back where a split now stands needs two steps), or `removeTree` when there was
 * none. The old tree comes back as it was (dimensions, values, bids, exclusions); the product groups made again get new
 * ids, so their own statistics start from zero.
 */
import { changeLines, money, plural, type GoogleChangeDraft } from './change-draft.js'
import type { ProductGroupNode, ShoppingAdGroupLive } from './live-product-groups.js'
import {
  cleanValue, DIMENSIONS, describeTNode, dimensionWords, MAX_TREE_NODES, pathLabel, planTree, reachAt, snapshotOf, specOfSnapshot, splitProblem, stateLabel,
  stepOneRemovals, treeOfLive, treeOfSpec, unitStateOf, valueKey, walk,
  type Dimension, type TNode, type TreePlan, type TreeSnapNode, type TreeSpecNode,
} from './product-tree.js'
import type { GoogleMutateOperation } from './write-client.js'

export interface UnitAsk { bidCents?: number; excluded?: boolean }

export interface TreeChangeRequest {
  /** The whole tree as it should be. */
  tree?: TreeSpecNode[]
  /** `tree` only: when Google needs a split removed first, do it in two changes (this one removes). */
  inTwoSteps?: boolean
  /** New units under existing splits. */
  add?: Array<{ parentId: string; value: string } & UnitAsk>
  /** Units split one level further. */
  subdivide?: Array<{ criterionId: string; split: Dimension; children: Array<{ value: string } & UnitAsk>; everythingElse: UnitAsk }>
  /** Product groups (units or splits, with everything under them) to remove. */
  remove?: string[]
  /** Remove the whole tree (the ad group shows no products). */
  removeTree?: boolean
  bids?: Array<{ criterionId: string; bidCents: number }>
  exclude?: string[]
  include?: Array<{ criterionId: string; bidCents: number }>
}

/** What a structural change keeps: the whole tree before and after, as snapshots with ids. */
export interface TreeChangeRecord { campaignId: string; adGroupId: string; nodes: TreeSnapNode[] }

export interface TreeChangeCtx {
  currency: string
  ag: ShoppingAdGroupLive
  nodes: ProductGroupNode[]
  /** `customers/{c}/adGroupCriteria/{adGroupId}~{id}` */
  crit: (id: string | number) => string
  stands: unknown
}

/**
 * The most operations one change of a tree sends: Google checks it (the preview) and it is then sent (the run), twice its
 * size on the account's change allowance (ops-budget.ts), with room for the other changes of the day.
 */
export const MAX_TREE_OPERATIONS = 500

export const isTreeChange = (r: TreeChangeRequest): boolean =>
  !!(r.tree?.length || r.add?.length || r.subdivide?.length || r.remove?.length || r.removeTree)

const lower = (s: string | null, fallback: string) => (s ?? fallback).toLowerCase()
function pausedNote(ag: ShoppingAdGroupLive): string {
  if (ag.campaign.status !== 'ENABLED') return ` (the campaign is ${lower(ag.campaign.status, 'not enabled')}: nothing spends until it is enabled)`
  if (ag.status !== 'ENABLED') return ` (the ad group is ${lower(ag.status, 'not enabled')}: nothing spends until it is enabled)`
  return ''
}
const listed = (items: string[], max = 8) => items.slice(0, max).join(', ') + (items.length > max ? ` … (+${items.length - max})` : '')

function clone(n: TNode): TNode {
  return { ...n, children: n.children.map(clone) }
}

// ── edits of the tree as it is ──────────────────────────────────────────────────────────────────────────────────

function editedTree(live: TNode | null, r: TreeChangeRequest, agName: string): { root: TNode; skipped: string[] } | { refusal: string } {
  if (!live) return { refusal: `"${agName}" has no product groups: build a tree first (tree, or itemIds).` }
  const root = clone(live)
  const index = new Map(walk(root).map((w) => [w.node.id!, w]))
  const named = new Map<string, string>()
  const skipped: string[] = []
  let changed = 0
  const take = (id: string, list: string) => {
    if (named.has(id)) return { refusal: `Product group ${id} is named twice (${named.get(id)} and ${list}).` }
    named.set(id, list)
    const at = index.get(id)
    if (!at) return { refusal: `Product group ${id} is not in ad group "${agName}" (google-ads-live view product-groups lists them with their criterionId).` }
    return at
  }
  const label = (chain: TNode[]) => pathLabel(chain)
  const unitOnly = (at: ReturnType<typeof walk>[number], what: string) =>
    at.node.kind === 'UNIT' ? null : { refusal: `${label(at.chain)} (${at.node.id}) is a split: ${what}` }

  for (const b of r.bids ?? []) {
    const at = take(b.criterionId, 'bids')
    if ('refusal' in at) return at
    const notUnit = unitOnly(at, 'it has no bid (its product groups have).')
    if (notUnit) return notUnit
    if (badBid(b.bidCents)) return { refusal: `The bid of ${label(at.chain)} is not a whole number of cents of at least 1.` }
    if (at.node.excluded) return { refusal: `${label(at.chain)} (${at.node.id}) is excluded: it has no bid. Use include (with a bid) to advertise it.` }
    if (at.node.bidCents === b.bidCents) { skipped.push(`${label(at.chain)} is already at that bid.`); continue }
    at.node.bidCents = b.bidCents
    changed += 1
  }
  for (const id of r.exclude ?? []) {
    const at = take(id, 'exclude')
    if ('refusal' in at) return at
    const notUnit = unitOnly(at, 'exclude the product groups under it, or remove it.')
    if (notUnit) return notUnit
    if (at.node.excluded) { skipped.push(`${label(at.chain)} is already excluded.`); continue }
    Object.assign(at.node, { excluded: true, bidCents: null })
    changed += 1
  }
  for (const inc of r.include ?? []) {
    const at = take(inc.criterionId, 'include')
    if ('refusal' in at) return at
    const notUnit = unitOnly(at, 'advertise the product groups under it.')
    if (notUnit) return notUnit
    if (badBid(inc.bidCents)) return { refusal: `The bid of ${label(at.chain)} is not a whole number of cents of at least 1.` }
    if (!at.node.excluded) { skipped.push(`${label(at.chain)} is already advertised: change its bid with bids.`); continue }
    Object.assign(at.node, { excluded: false, bidCents: inc.bidCents })
    changed += 1
  }
  const removed = new Set<string>()
  for (const id of r.remove ?? []) {
    const at = take(id, 'remove')
    if ('refusal' in at) return at
    if (!at.parent) return { refusal: `${id} is the root ("All products"): to remove the whole tree, use removeTree.` }
    if (at.node.value === null) return { refusal: `${label(at.chain)} (${id}) is "everything else": every split keeps one. Exclude it instead, or remove its parent.` }
    at.parent.children = at.parent.children.filter((c) => c !== at.node)
    removed.add(id)
    changed += 1
  }
  for (const s of r.subdivide ?? []) {
    const at = take(s.criterionId, 'subdivide')
    if ('refusal' in at) return at
    const where = `subdivide ${s.criterionId}`
    const notUnit = unitOnly(at, 'it is split already (add product groups under it with add).')
    if (notUnit) return notUnit
    if (!(DIMENSIONS as readonly string[]).includes(s.split)) return { refusal: `${where}: "${s.split}" is not a dimension Nexus splits by.` }
    const problem = splitProblem(at.chain, s.split)
    if (problem) return { refusal: `${where}: ${label(at.chain)} cannot be split by ${dimensionWords(s.split)}: ${problem}.` }
    if (!s.children?.length) return { refusal: `${where}: name at least one value (children) — a split needs one besides "everything else".` }
    const kids: TNode[] = []
    const keys = new Set<string>()
    for (const [i, c] of s.children.entries()) {
      const clean = cleanValue(s.split, c.value, `${where}, children[${i}]`)
      if ('refusal' in clean) return clean
      const key = valueKey(s.split, clean.value)
      if (keys.has(key)) return { refusal: `${where}: "${clean.value}" is named twice (values are compared without case).` }
      keys.add(key)
      const state = unitStateOf(c, `${where}, children[${i}]`)
      if ('refusal' in state) return state
      kids.push({ dim: s.split, value: clean.value, kind: 'UNIT', split: null, ...state, children: [] })
    }
    const rest = unitStateOf(s.everythingElse ?? {}, `${where}, everythingElse`)
    if ('refusal' in rest) return rest
    kids.push({ dim: s.split, value: null, kind: 'UNIT', split: null, ...rest, children: [] })
    Object.assign(at.node, { kind: 'SUBDIVISION', split: s.split, excluded: false, bidCents: null, children: kids })
    changed += 1
  }
  for (const [i, a] of (r.add ?? []).entries()) {
    const where = `add[${i}]`
    const at = index.get(a.parentId)
    if (!at) return { refusal: `${where}: product group ${a.parentId} is not in ad group "${agName}".` }
    if (removed.has(a.parentId) || named.get(a.parentId) === 'subdivide') return { refusal: `${where}: ${a.parentId} is ${removed.has(a.parentId) ? 'removed' : 'subdivided'} in this request.` }
    if (at.node.kind !== 'SUBDIVISION') return { refusal: `${where}: ${label(at.chain)} (${a.parentId}) is not a split: split it with subdivide.` }
    if (!at.node.split) return { refusal: `${where}: Nexus cannot tell the dimension ${label(at.chain)} is split by: change it in Google Ads.` }
    const clean = cleanValue(at.node.split, a.value, where)
    if ('refusal' in clean) return clean
    const key = valueKey(at.node.split, clean.value)
    if (at.node.children.some((c) => c.value !== null && valueKey(at.node.split, c.value) === key)) return { refusal: `${where}: ${label(at.chain)} already has "${clean.value}".` }
    const state = unitStateOf(a, where)
    if ('refusal' in state) return state
    at.node.children.push({ dim: at.node.split, value: clean.value, kind: 'UNIT', split: null, ...state, children: [] })
    changed += 1
  }
  for (const w of walk(root)) {
    if (w.node.kind === 'SUBDIVISION' && w.node.children.every((c) => c.value === null)) {
      return { refusal: `${label(w.chain)} would keep only "everything else": remove the split itself instead (remove ${w.node.id ?? 'it'}), or keep a product group under it.` }
    }
  }
  if (!changed) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  return { root, skipped }
}

const badBid = (cents: unknown) => typeof cents !== 'number' || !Number.isInteger(cents) || cents < 1

// ── the change ──────────────────────────────────────────────────────────────────────────────────────────────────

export function treeChangeDraft(ctx: TreeChangeCtx, r: TreeChangeRequest): GoogleChangeDraft | { refusal: string } {
  const { ag, currency } = ctx
  const read = treeOfLive(ctx.nodes)
  if ('refusal' in read) return { refusal: `The product groups of "${ag.name}" cannot be changed here: ${read.refusal}. Change them in Google Ads.` }
  const live = read.root
  const edits = !!(r.add?.length || r.subdivide?.length || r.remove?.length)
  let desired: TNode | null
  let skipped: string[] = []
  if (r.tree?.length) {
    if (edits || r.removeTree || r.bids?.length || r.exclude?.length || r.include?.length) return { refusal: 'tree is the whole tree as it should be: give it alone (no add, subdivide, remove, removeTree, bids, exclude or include with it).' }
    const spec = treeOfSpec(r.tree)
    if ('refusal' in spec) return spec
    desired = spec.root
  } else if (r.removeTree) {
    if (edits || r.bids?.length || r.exclude?.length || r.include?.length) return { refusal: 'removeTree removes the whole tree: give it alone.' }
    if (!live) return { refusal: `Nothing to remove: "${ag.name}" has no product groups.` }
    desired = null
  } else {
    if (r.inTwoSteps) return { refusal: 'inTwoSteps goes with tree (the whole tree as it should be).' }
    const edited = editedTree(live, r, ag.name)
    if ('refusal' in edited) return edited
    desired = edited.root
    skipped = edited.skipped
  }
  const plan = planTree(live, desired, ctx.crit)
  const removal = (n: TNode) => ({ adGroupCriterionOperation: { remove: ctx.crit(n.id!) } })
  const liveWalk = walk(live)
  const chainOf = new Map(liveWalk.map((w) => [w.node, w.chain]))
  const label = (n: TNode) => pathLabel(chainOf.get(n) ?? [n])

  if (plan.splitsToRemove.length && (plan.updates.length || plan.creates.length || plan.waiting.length)) {
    const labels = plan.splitsToRemove.map((s) => `${label(s.node)} (${s.node.id})`)
    if (!r.tree?.length) {
      return { refusal: `Removing a split (${listed(labels)}) must be a request of its own: Google refuses to remove a split in a request that makes or changes product groups (LISTING_GROUP_CANNOT_BE_REMOVED). Ask remove: [${plan.splitsToRemove.map((s) => s.node.id).join(', ')}] alone first, then the rest.` }
    }
    if (!r.inTwoSteps) {
      return { refusal: `This tree needs ${listed(labels)} removed first, and Google refuses to remove a split in a request that makes or changes product groups (LISTING_GROUP_CANNOT_BE_REMOVED). Ask again with inTwoSteps: true — step 1 removes what must go (and only that), step 2 is the same request asked again once step 1 ran and makes the rest. Each step is checked by Google and approved on its own.` }
    }
    return stepOne(ctx, live!, desired, plan, removal, label)
  }
  const operations = [...plan.updates, ...plan.removes, ...plan.splitsToRemove.map((s) => removal(s.node)), ...plan.creates]
  if (!operations.length) return { refusal: `Nothing to change: the product groups of "${ag.name}" are already this tree (${describeTNode(live, currency)}).` }
  if (operations.length > MAX_TREE_OPERATIONS) return { refusal: `This change holds ${operations.length} operations, more than the ${MAX_TREE_OPERATIONS} one change of a tree sends (its check and its run come out of the account's daily Google Ads allowance): split it into smaller changes.` }
  return fullChange(ctx, live, desired, plan, operations, skipped, label)
}

/** Where the products of a removed product group fall: the "everything else" of its parent, and what that does to money. */
function fallOf(removed: TNode, other: TNode | undefined, ctx: TreeChangeCtx, label: string, otherLabel: string, until: string): { spends: string | null; note: string } {
  const { currency } = ctx
  const note = pausedNote(ctx.ag)
  const lead = until ? `${until}the products of ${label}` : `The products of ${label}`
  if (!other) return { spends: null, note: `${lead} fall under "everything else" of its parent.` }
  const units = walk(removed).map((w) => w.node).filter((n) => n.kind === 'UNIT')
  if (other.kind === 'UNIT') {
    if (other.excluded) return { spends: null, note: `${lead} fall under ${otherLabel}, which is excluded: they are not advertised.` }
    const more = units.some((u) => u.excluded || (u.bidCents !== null && other.bidCents !== null && u.bidCents < other.bidCents))
    return {
      spends: more ? `${lead} fall under ${otherLabel} and are advertised at ${money(other.bidCents, currency)} a click (some of them were excluded, or bid lower)${note}.` : null,
      note: `${lead} fall under ${otherLabel} (${stateLabel(other, currency)}).`,
    }
  }
  const open = walk(other).some((w) => w.node.kind === 'UNIT' && !w.node.excluded)
  return {
    spends: open ? `${lead} fall under the split of ${otherLabel}, where they can be advertised at bids Nexus cannot tell product by product${note}.` : null,
    note: `${lead} fall under the split of ${otherLabel}.`,
  }
}

const liveWalkSize = (root: TNode | null) => walk(root).length

function record(ctx: TreeChangeCtx, root: TNode | null): TreeChangeRecord {
  return { campaignId: ctx.ag.campaign.campaignId, adGroupId: ctx.ag.adGroupId, nodes: snapshotOf(root) }
}

/** Step 1 of 2: only the removals Google needs before the new tree can be made. */
function stepOne(
  ctx: TreeChangeCtx, live: TNode, desired: TNode | null, plan: TreePlan,
  removal: (n: TNode) => GoogleMutateOperation, label: (n: TNode) => string,
): GoogleChangeDraft {
  const { ag, currency } = ctx
  const gone = stepOneRemovals(plan, live)
  const parentOf = new Map(walk(live).map((w) => [w.node, w.parent]))
  const after = gone.includes(live) ? null : clone(live)
  if (after) {
    const ids = new Set(gone.map((g) => g.id))
    for (const w of walk(after)) w.node.children = w.node.children.filter((c) => !ids.has(c.id))
  }
  const lines: Array<[string, unknown, unknown]> = [[`product groups of "${ag.name}"`, describeTNode(live, currency), `after step 1: ${describeTNode(after, currency)}; after step 2: ${describeTNode(desired, currency)}`]]
  const spends: string[] = []
  const warnings: string[] = []
  let count = 0
  for (const g of gone) {
    const size = walk(g).length
    count += size
    lines.push([label(g), g.kind === 'SUBDIVISION' ? `split by ${dimensionWords(g.split)}: ${plural(size, 'product group')}` : stateLabel(g, currency), 'removed (step 1 of 2)'])
    const parent = parentOf.get(g) ?? null
    if (!parent) { warnings.push(`Until step 2 runs, "${ag.name}" has no product groups: it shows no products.`); continue }
    const other = parent.children.find((c) => c.value === null)
    const fall = fallOf(g, other, ctx, label(g), other ? label(other) : '', 'Until step 2 runs, ')
    if (fall.spends) spends.push(fall.spends)
    else warnings.push(fall.note)
  }
  const operations = gone.map(removal)
  warnings.push('Step 2 is the same request asked again once this step ran: it makes the rest of the tree (its own preview, checked by Google and approved on its own).')
  const { changes, more } = changeLines(lines)
  return {
    summary: `Google Ads product groups of "${ag.name}", step 1 of 2: remove ${listed(gone.map(label), 4)} — Google refuses to remove a split in the request that makes the new product groups. Once it ran, ask set-google-product-groups again with the same arguments for step 2.`,
    changes,
    totals: { operations: operations.length, step: 1, steps: 2, removedProductGroups: count, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped: [],
    operations,
    stands: ctx.stands,
    before: record(ctx, live),
    after: record(ctx, after),
  }
}

/** One request: the whole plan (or removals only). */
function fullChange(
  ctx: TreeChangeCtx, live: TNode | null, desired: TNode | null, plan: TreePlan, operations: GoogleMutateOperation[], skipped: string[],
  label: (n: TNode) => string,
): GoogleChangeDraft {
  const { ag, currency } = ctx
  const note = pausedNote(ag)
  const lines: Array<[string, unknown, unknown]> = [[`product groups of "${ag.name}"`, describeTNode(live, currency), describeTNode(desired, currency)]]
  const spends: string[] = []
  const warnings: string[] = []
  const newly: string[] = []
  const unknown: string[] = []
  const raised: string[] = []
  const remadeFrom = new Map(plan.remade.map((m) => [m.node, m.was]))
  for (const w of walk(desired)) {
    const d = w.node
    const at = pathLabel(w.chain)
    const made = plan.created.has(d)
    const bid = plan.bidChanges.find((b) => b.node === d)
    if (!made && !bid) continue
    if (made && d.kind === 'SUBDIVISION') {
      const was = remadeFrom.get(d)
      lines.push([at, was ? stateLabel(was, currency) : reachAt(live, w.chain.slice(1), currency).label, `split by ${dimensionWords(d.split)}: ${plural(d.children.length, 'product group')}`])
      continue
    }
    if (bid) {
      lines.push([at, bid.from === null ? 'advertised (no bid of its own)' : `${money(bid.from, currency)} a click`, stateLabel(d, currency)])
      if (bid.from === null || d.bidCents! > bid.from) raised.push(`${at} ${money(bid.from, currency)} → ${money(d.bidCents, currency)}`)
      continue
    }
    // A product group made in this request: how its products were advertised before.
    const was = remadeFrom.get(d)
    const prev = was && was.kind === 'UNIT' ? { serves: !was.excluded, bidCents: was.excluded ? null : was.bidCents, label: stateLabel(was, currency) } : reachAt(live, w.chain.slice(1), currency)
    lines.push([at, prev.label, stateLabel(d, currency)])
    if (d.excluded) continue
    if (prev.serves === false) newly.push(`${at} at ${money(d.bidCents, currency)}`)
    else if (prev.serves === null || prev.bidCents === null) unknown.push(`${at} at ${money(d.bidCents, currency)}`)
    else if (d.bidCents !== null && d.bidCents > prev.bidCents) raised.push(`${at} ${money(prev.bidCents, currency)} → ${money(d.bidCents, currency)}`)
  }
  if (newly.length) spends.push(`Advertises ${plural(newly.length, 'product group')} in "${ag.name}" that ${newly.length === 1 ? 'was' : 'were'} not advertised there before: ${listed(newly)}${note}.`)
  if (raised.length) spends.push(`Raises the bid of ${plural(raised.length, 'product group')} in "${ag.name}": ${listed(raised)}${note}.`)
  if (unknown.length) spends.push(`Advertises ${plural(unknown.length, 'product group')} in "${ag.name}" whose products Nexus cannot match to the old tree (they may not have been advertised, or at a lower bid): ${listed(unknown)}${note}.`)

  // Product groups that leave the tree: their products fall under "everything else" of their parent.
  const desiredWalk = walk(desired)
  const desiredChain = new Map(desiredWalk.map((w) => [w.node, w.chain]))
  for (const { node, parent } of plan.dropped) {
    const other = parent.children.find((c) => c.value === null)
    const fall = fallOf(node, other, ctx, label(node), other ? pathLabel(desiredChain.get(other) ?? [other]) : '', '')
    lines.push([label(node), stateLabel(node, currency), 'removed'])
    if (fall.spends) spends.push(fall.spends)
    else warnings.push(fall.note)
  }
  for (const { node, parent } of plan.splitsToRemove) {
    const size = walk(node).length
    lines.push([label(node), `split by ${dimensionWords(node.split)}: ${plural(size, 'product group')}`, parent ? 'removed, with everything under it' : 'removed: no product groups'])
    if (!parent) { warnings.push(`"${ag.name}" has no product groups after this change: it shows no products until a tree is built again (set-google-product-groups tree or itemIds).`); continue }
    const other = parent.children.find((c) => c.value === null)
    const fall = fallOf(node, other, ctx, label(node), other ? label(other) : '', '')
    if (fall.spends) spends.push(fall.spends)
    else warnings.push(fall.note)
  }
  if (!desired && plan.removes.length) warnings.push(`"${ag.name}" has no product groups after this change: it shows no products until a tree is built again (set-google-product-groups tree or itemIds).`)

  for (const w of desiredWalk) {
    if (w.node.kind !== 'UNIT' || w.node.value !== null || w.node.excluded || !w.parent) continue
    warnings.unshift(w.parent === desired
      ? `"Everything else" in "${ag.name}" is NOT excluded: every product of the feed that the tree does not name can be advertised.`
      : `"Everything else" under ${pathLabel(desiredChain.get(w.parent) ?? [w.parent])} in "${ag.name}" is NOT excluded: every product there that the tree does not name can be advertised.`)
  }
  if (plan.remade.length) {
    warnings.push(`${plural(plan.remade.length, 'product group')} ${plan.remade.length === 1 ? 'is' : 'are'} removed and made again (Google cannot switch a product group between advertised and excluded, nor turn one into a split): ${plan.remade.length === 1 ? 'it gets a new id and its' : 'they get new ids and their'} own statistics in Google Ads start from zero. The product groups that stay keep their ids and statistics.`)
  }
  const units = desiredWalk.filter((w) => w.node.kind === 'UNIT')
  if (units.length && units.every((w) => w.node.excluded)) warnings.push(`Nothing can be advertised in "${ag.name}" after this change: every product group of the tree is excluded.`)

  const { changes, more } = changeLines(lines)
  const parts: string[] = []
  if (plan.created.size) parts.push(`make ${plural(plan.created.size, 'product group')}`)
  const gone = plan.removes.length - plan.remade.length + plan.splitsToRemove.length
  if (gone > 0) parts.push(`remove ${plural(gone, 'product group')}${plan.splitsToRemove.length ? ' (with what is under the splits)' : ''}`)
  if (plan.bidChanges.length) parts.push(`change ${plural(plan.bidChanges.length, 'bid')}`)
  return {
    summary: desired
      ? `Google Ads product groups of "${ag.name}": ${parts.join(', ')} — ${describeTNode(desired, currency)}.`
      : `Google Ads product groups of "${ag.name}": remove the whole tree (${plural(liveWalkSize(live), 'product group')}) — the ad group shows no products until a tree is built again.`,
    changes,
    totals: {
      operations: operations.length,
      productGroups: desiredWalk.length,
      units: units.length,
      excluded: units.filter((w) => w.node.excluded).length,
      made: plan.created.size,
      removed: Math.max(0, gone),
      bidChanges: plan.bidChanges.length,
      keepTheirIds: desiredWalk.filter((w) => !plan.created.has(w.node)).length,
      ...(more ? { linesNotShown: more } : {}),
    },
    warnings,
    spendsMoney: spends,
    skipped,
    operations,
    stands: ctx.stands,
    before: record(ctx, live),
    after: record(ctx, desired),
  }
}

// ── after the run, now, undo ────────────────────────────────────────────────────────────────────────────────────

/** The record of a run: each product group it made, with the id Google gave it (the result of the operation that made it). */
export function treeRecordAfterRun(nodes: TreeSnapNode[], responses: Array<Record<string, { resourceName?: string } | undefined>>): TreeSnapNode[] {
  return nodes.map((n) => {
    const at = /^op:(\d+)$/.exec(n.id ?? '')
    if (!at) return n
    const name = responses[Number(at[1])]?.adGroupCriterionResult?.resourceName
    return { ...n, id: name ? name.slice(name.lastIndexOf('~') + 1) : null }
  })
}

/** The tree Google holds now, in the record's shape (values spelled as the record spells them when only the case differs). */
export function treeRecordNow(after: TreeSnapNode[], nodes: ProductGroupNode[]): TreeSnapNode[] {
  const read = treeOfLive(nodes)
  const now = snapshotOf('refusal' in read ? null : read.root)
  const spelling = new Map(after.filter((n) => n.id).map((n) => [n.id!, n]))
  return now.map((n) => {
    const was = n.id ? spelling.get(n.id) : undefined
    return was && was.value !== null && n.value !== null && valueKey(n.dim, n.value) === valueKey(was.dim, was.value) ? { ...n, value: was.value } : n
  })
}

/** The request that puts the old tree back, or why it cannot. */
export function treeUndoArgs(before: TreeSnapNode[]): { args: Record<string, unknown> } | { refusal: string } {
  if (!before.length) return { args: { removeTree: true } }
  if (before.length > MAX_TREE_NODES) return { refusal: `The tree before this change had ${before.length} product groups, more than one request builds: put it back by hand in Google Ads.` }
  const spec = specOfSnapshot(before)
  if ('refusal' in spec) return { refusal: `The tree before this change cannot be built again here (${spec.refusal}): put it back by hand in Google Ads.` }
  // inTwoSteps: putting a unit back where a split now stands needs two steps; when one is enough it is not used.
  return { args: { tree: spec, inTwoSteps: true } }
}
