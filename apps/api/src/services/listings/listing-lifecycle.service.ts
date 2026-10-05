/**
 * MCP full control, phase 3 (T1) — Claude's end-listing / relist-listing / delete-listing are End listing, Relist and
 * Delete listing of THE listing-action engine (listing-action.service.ts): the same plan, adapters, gates, audit records
 * and deletion records as the product page's Publish (Status Ended; Status Active on an Ended row; Action Delete).
 *
 *   End      eBay: the whole item ends (every variation); the item number is kept for a Relist. Shopify: the product is
 *            archived in every market of the store. Amazon and Etsy have no End.
 *   Relist   an Ended eBay or Shopify listing. eBay: RelistFixedPriceItem gives a NEW item number (written on this
 *            business's rows of this destination only), then the current stock is sent. Shopify: active again in every
 *            market of the store.
 *   Delete   Amazon: this market only (FBA too; the engine's row warning names Amazon's unit count and Pan-European FBA).
 *            eBay Trading: end, then Nexus forgets the item number. eBay Inventory: withdraw, then delete this market's
 *            offers. Shopify: the product and all its variants, in every market of the store. Etsy: not available.
 *            Cannot be undone. The row then reads Not listed: the delete's own audit record (`readListingDeletions`)
 *            keeps every Publish — publish-listing included — leaving it out until a person sets its Status to Active.
 *
 * Plan (read-only, `planListingLifecycle`): every listing must be this business's, on the channel, on ONE coordinate
 * (channel, market, account, alias) and of ONE product family, and `confirmSku` must be that family's SKU — the typed
 * confirmation the product page asks for (`confirmMatches`, the screen's own rule). The engine's plan decides each row;
 * an item- or product-level change reaches the whole family, and the plan lists every row it reaches.
 * Run (`runListingLifecycle`): the engine's preview and run as the approver, with the typed token the engine requires
 * for End and Delete; the engine sends only the rows that are still the same as in its preview.
 */
import { channelLabel } from '@nexus/shared/channel-label'
import {
  ALREADY_DELETED, deletedPublishSkip, SELLING_STATE_LABEL,
  type ActionReach, type ListingActionDestination, type ListingModel, type SellingState,
} from '@nexus/shared/listing-actions'
import { confirmMatches } from '@nexus/shared/publish-plan'
import { isStillDraftListing } from '@nexus/shared/push-lock'
import prisma from '../../db.js'
import {
  destinationLabel, listingActionGate, NOT_ENDED_USE_RESUME, planListingAction, previewListingAction, readListingActionState, runListingAction,
} from './listing-action.service.js'
import { readListingDeletions } from './listing-deletions.js'

export type LifecycleAction = 'end' | 'relist' | 'delete'

export const LIFECYCLE_VERB: Readonly<Record<LifecycleAction, { ing: string; ed: string }>> = {
  end: { ing: 'ending', ed: 'ended' }, relist: { ing: 'relisting', ed: 'relisted' }, delete: { ing: 'deleting', ed: 'deleted' },
}

/** The typed token the engine's run requires (End and Delete are typed on the screen); a Relist needs none. */
const RUN_TOKEN: Readonly<Record<LifecycleAction, 'END' | 'DELETE' | null>> = { end: 'END', relist: null, delete: 'DELETE' }

/** After a Delete: only a person lists the row again; until then every Publish leaves it out. */
export const LIST_AGAIN_AFTER_DELETE = 'Only a person lists it again (its Status set to Active, then Publish, on the product page); '
  + 'until then publish-listing leaves it Not listed.'

/** Channels where the action does not exist, in Claude's words (the tool that does the nearest thing). */
const NOT_ON_CHANNEL: Readonly<Record<LifecycleAction, Partial<Record<string, string>>>> = {
  end: {
    AMAZON: 'Amazon has no End. close-listing pauses this market\'s offer; delete-listing removes the listing here.',
    ETSY: 'Etsy has no End here. close-listing sets the listing inactive.',
  },
  relist: {
    AMAZON: 'Amazon has no End or Relist. reopen-listing puts a paused offer back.',
    ETSY: 'Etsy has no End or Relist here. reopen-listing sets an inactive listing active again.',
  },
  delete: {
    ETSY: 'Deleting Etsy listings from Nexus is not available yet. close-listing sets it inactive, or delete it in Etsy.',
  },
}

export interface LifecycleRow {
  listingId: string
  productId: string
  sku: string
  /** What the engine does with it: the action, or 'skip' (a main product whose variations carry the change). */
  does: LifecycleAction | 'skip'
  /** Its selling state now, in the screen's words (Active, Inactive, Ended, Mixed, Unknown). */
  state: string
  /** The engine's sentence for this row. */
  note: string
  /** Not named by the caller: the change reaches it because it reaches the whole item or product. */
  reached?: true
}

export interface LifecyclePlan {
  action: LifecycleAction
  refusals: string[]
  rows: LifecycleRow[]
  family: { productId: string; sku: string } | null
  destination: ListingActionDestination | null
  /** "eBay · IT", "Shopify". */
  where: string | null
  model: ListingModel | null
  reach: ActionReach | null
  /** The engine's consequence: what happens, where, and how (or whether) it is put back. */
  consequence: string
  checkedAtSend: string | null
  /** The engine's per-row warnings on rows it sends (an FBA delete's unit count, Pan-European FBA). */
  rowWarnings: Array<{ sku: string; warning: string }>
  /** The products the caller named (the engine's `productIds`). */
  named: string[]
}

const LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, listingStatus: true, isPublished: true,
  externalListingId: true, product: { select: { sku: true, parentId: true } },
} as const

/** The engine's row sentence, pointed at Claude's own tools where it names a screen action. */
function sentenceFor(action: LifecycleAction, sentence: string): string {
  if (action === 'relist' && sentence === NOT_ENDED_USE_RESUME) return 'Not ended: it is Inactive — reopen-listing resumes it.'
  if (action === 'relist' && sentence === 'Not ended.') return 'Not ended: relist-listing relists only an Ended listing.'
  return sentence
}

/**
 * What an End, Relist or Delete of these listings would do, read-only: the engine's plan, nothing saved, no channel call
 * (an Amazon Delete reads Nexus's last FBA unit count for its warning).
 */
export async function planListingLifecycle(listingIds: readonly string[], action: LifecycleAction, confirmSku: string): Promise<LifecyclePlan> {
  const empty = (refusals: string[]): LifecyclePlan => ({ action, refusals, rows: [], family: null, destination: null, where: null, model: null,
    reach: null, consequence: '', checkedAtSend: null, rowWarnings: [], named: [] })
  const found = await prisma.channelListing.findMany({ where: { id: { in: [...listingIds] } }, select: LISTING_SELECT })
  const byId = new Map(found.map((l) => [l.id, l]))
  // A row Nexus deleted keeps the draft shape the delete left: it is named in the delete's own words, not as a draft.
  const deletions = await readListingDeletions(found)
  const refusals: string[] = []
  const named: typeof found = []
  for (const id of listingIds) {
    const l = byId.get(id)
    if (!l) { refusals.push(`Listing ${id} not found in this business.`); continue }
    const at = `${l.product.sku} ${channelLabel(l.channel)} ${l.marketplace}`
    const deletion = deletions.get(l.id)
    if (deletion) { refusals.push(`${at}: ${action === 'delete' ? ALREADY_DELETED(deletion.where) : `${deletedPublishSkip(deletion)} ${LIST_AGAIN_AFTER_DELETE}`}`); continue }
    if (isStillDraftListing(l)) { refusals.push(`${at}: a draft was never live, so there is nothing to ${action} — remove-draft-listings removes a draft.`); continue }
    if (!l.channelConnectionId) { refusals.push(`${at}: this listing has no account. Link it to its account first.`); continue }
    named.push(l)
  }
  if (refusals.length) return empty(refusals)
  if (!named.length) return empty(['Name at least one listing.'])
  if (new Set(named.map((l) => JSON.stringify([l.channel, l.marketplace, l.channelConnectionId, l.aliasKey]))).size > 1)
    return empty([`These listings are on more than one channel, market, account or alias: ${action} each one separately.`])
  const familyIds = new Set(named.map((l) => l.product.parentId ?? l.productId))
  if (familyIds.size > 1) return empty(['These listings belong to more than one product family: name one family per call (confirmSku is that family\'s SKU).'])
  const familyId = [...familyIds][0]
  const family = await prisma.product.findFirst({ where: { id: familyId, deletedAt: null }, select: { id: true, sku: true } })
  if (!family) return empty([`${named[0].product.sku}: its product family is unavailable.`])
  // The typed confirmation, as the product page asks for it (the family SKU, exactly, ignoring surrounding spaces).
  if (!confirmMatches(family.sku, confirmSku)) {
    return empty([`confirmSku does not match the family SKU of these listings. The person types the family SKU exactly (the main product's SKU, as listing-coordinates names it), as the product page asks before ${LIFECYCLE_VERB[action].ing}.`])
  }
  const first = named[0]
  const at = `${family.sku} ${channelLabel(first.channel)} ${first.marketplace}`
  const unavailable = NOT_ON_CHANNEL[action][first.channel]
  if (unavailable) return empty([`${at}: ${unavailable}`])
  // The channel's publish mode must be live, as the run requires: say so now rather than after the approval.
  const gate = listingActionGate(first.channel)
  if (gate) return empty([`${at}: ${gate}`])

  const scope = { channel: first.channel, marketplace: first.marketplace, accountId: first.channelConnectionId, aliasKey: first.aliasKey }
  const namedProducts = [...new Set(named.map((l) => l.productId))]
  let plan: Awaited<ReturnType<typeof planListingAction>>
  let states: Map<string, SellingState>
  try {
    plan = await planListingAction(familyId, action, { scope, productIds: namedProducts })
    states = new Map((await readListingActionState(familyId, scope)).rows.map((r) => [r.productId, r.state]))
  } catch (err) {
    return empty([`${at}: ${err instanceof Error ? err.message : String(err)}`])
  }
  const where = destinationLabel(plan.destination)
  const namedIds = new Set(named.map((l) => l.id))
  const rows: LifecycleRow[] = []
  for (const row of plan.rows) {
    if (!row.listingId) continue
    const isNamed = namedIds.has(row.listingId)
    const base = {
      listingId: row.listingId, productId: row.productId, sku: row.sku, state: SELLING_STATE_LABEL[states.get(row.productId) ?? 'unknown'],
      note: row.sentence, ...(isNamed ? {} : { reached: true as const }),
    }
    if (row.plan === 'send') { rows.push({ ...base, does: action }); continue }
    if (!isNamed) continue
    // A main product follows its variations: listed, not refused.
    if (row.plan === 'skip' && /follows its variations/.test(row.sentence)) { rows.push({ ...base, does: 'skip' }); continue }
    refusals.push(`${row.sku} ${where}: ${sentenceFor(action, row.sentence)}`)
  }
  if (refusals.length) return empty(refusals)
  if (!rows.some((r) => r.does !== 'skip')) return empty([`Nothing to change: no named listing can be ${LIFECYCLE_VERB[action].ed}.`])
  return {
    action, refusals: [], rows, family: { productId: family.id, sku: family.sku }, destination: plan.destination, where, model: plan.model,
    reach: plan.reach, consequence: plan.consequence, checkedAtSend: plan.checkedAtSend,
    rowWarnings: plan.rows.filter((r) => r.plan === 'send' && r.warning).map((r) => ({ sku: r.sku, warning: r.warning! })),
    named: namedProducts,
  }
}

export interface LifecycleOutcome { listingId: string; sku: string; done: boolean; detail?: string }

/**
 * End, relist or delete what `plan` sends, through the engine, as `actor`: the engine's preview of the same request,
 * then its run with the typed token (End: 'END', Delete: 'DELETE'). The engine re-reads the family and sends only rows
 * still planned as in its preview; its preview must send exactly the plan's rows, or nothing is sent. `reason` travels
 * to the engine's audit record.
 */
export async function runListingLifecycle(plan: LifecyclePlan, input: { actor: string; reason?: string | null }): Promise<{ outcomes: LifecycleOutcome[]; message: string | null }> {
  if (plan.refusals.length || !plan.family || !plan.destination) return { outcomes: [], message: null }
  const sending = plan.rows.filter((r) => r.does !== 'skip')
  const notDone = (detail: string) => sending.map((r) => ({ listingId: r.listingId, sku: r.sku, done: false, detail }))
  try {
    const preview = await previewListingAction(plan.family.productId, plan.action,
      { scope: plan.destination, productIds: plan.named, ...(input.reason ? { reason: input.reason } : {}) }, input.actor)
    const engineSends = preview.rows.filter((r) => r.plan === 'send' && r.listingId).map((r) => r.listingId!).sort()
    if (JSON.stringify(engineSends) !== JSON.stringify(sending.map((r) => r.listingId).sort())) {
      return { outcomes: notDone('Not sent: these listings changed while the change was being sent. Nothing changed; ask again.'), message: null }
    }
    const token = RUN_TOKEN[plan.action]
    const result = await runListingAction(plan.family.productId, plan.action, { previewId: preview.previewId, ...(token ? { confirm: token } : {}) }, input.actor)
    const outcomes = sending.map((r) => {
      const answer = result.rows.find((x) => x.listingId === r.listingId)
      const done = answer?.outcome === 'DONE'
      return { listingId: r.listingId, sku: r.sku, done, detail: answer ? (done ? answer.message : `${answer.outcome}: ${answer.message}`) : 'Not sent: it changed since it was approved.' }
    })
    return { outcomes, message: result.message }
  } catch (err) {
    return { outcomes: notDone(err instanceof Error ? err.message : String(err)), message: null }
  }
}

/** C2 — each listing's selling state now (the engine's read, no channel call), in the order given; null when unreadable. */
export async function lifecycleStates(listingIds: readonly string[]): Promise<Array<{ listingId: string; state: SellingState | null }>> {
  const found = await prisma.channelListing.findMany({ where: { id: { in: [...listingIds] } }, select: LISTING_SELECT })
  const state = new Map<string, SellingState>()
  const groups = new Map<string, typeof found>()
  for (const l of found) {
    if (!l.channelConnectionId) continue
    const key = JSON.stringify([l.product.parentId ?? l.productId, l.channel, l.marketplace, l.channelConnectionId, l.aliasKey])
    groups.set(key, [...(groups.get(key) ?? []), l])
  }
  for (const [key, members] of groups) {
    const [familyId, channel, market, accountId, aliasKey] = JSON.parse(key) as string[]
    try {
      const read = await readListingActionState(familyId, { channel, market, accountId, aliasKey })
      for (const l of members) {
        const row = read.rows.find((r) => r.listingId === l.id)
        if (row) state.set(l.id, row.state)
      }
    } catch { /* unreadable: no state */ }
  }
  return listingIds.map((id) => ({ listingId: id, state: state.get(id) ?? null }))
}

/** C2 — the family SKU of these listings now (the first one's main product), or null. */
export async function familySkuOf(listingIds: readonly string[]): Promise<string | null> {
  const first = await prisma.channelListing.findFirst({ where: { id: { in: [...listingIds] } }, select: { product: { select: { id: true, sku: true, parentId: true } } } })
  if (!first) return null
  if (!first.product.parentId) return first.product.sku
  return (await prisma.product.findFirst({ where: { id: first.product.parentId }, select: { sku: true } }))?.sku ?? null
}
