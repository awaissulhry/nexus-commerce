/**
 * Sharing studio step 3 — copy a shared product's listing LAYOUT into the business that follows it, as drafts
 * (plan docs/2026-09-28-sharing-review-and-plan.md §5, step 3; Owner R-SH-1: D-2 A, copy once as drafts).
 *
 * The layout is where the sharing business lists the product: per channel and market, per account of its own, the
 * main listing and each alias with its name. Its accounts, item ids and listing values never cross the wall: an
 * account is shown as its rank ("eBay account 1 of 2" — the sharing business's own order: primary first), the rest
 * is channel, market and alias names. The follower's owner then picks, per group, which of ITS accounts gets it.
 *
 * What is made is inert (`draftListingFields`): DRAFT, unpublished, sync paused. Nothing reaches a channel until
 * this business publishes. Made again, nothing is doubled: the main listing is `ensureDraftListings` (one row per
 * coordinate) and an alias with the same name on the same account and market is reused.
 *
 * Reading the sharing business: the database door (`nexus_assortment_sync_source`, via `linkSource`) answers only
 * the follower, for its own active link, and names the product; the rows are then read in the owner's context as
 * the system, and the context is checked back — the same path as the live sync (copy-source.service.ts).
 */
import { channelLabel } from '@nexus/shared/channel-label'
import prisma from '../../db.js'
import { WorkspaceError, requireWorkspace, withWorkspace } from '../../lib/workspace-context.js'
import { connectionLabel } from '../connection-label.js'
import { listSharedWithCurrent } from '../channel-account-grant.service.js'
import { listActiveConnections } from '../connection-resolver.service.js'
import { DraftListingError, ensureDraftListingsInTransaction } from '../pim/draft-listing.service.js'
import { createAlias } from '../pim/listing-alias.service.js'
import { ProductRelationshipError } from '../pim/product-relationship.service.js'
import { linkSource } from './copy-source.service.js'

const LIVE_OR_DRAFT = { notIn: ['ENDED', 'REMOVED'] }

export interface LayoutSlot {
  /** 0 = the main listing; 1… = an alias, in the sharing business's position order. */
  position: number
  /** The alias's name; null for the main listing. */
  label: string | null
}

export interface LayoutGroup {
  /** `${channel}|${marketplace}|${sourceAccount}` — the same across every product of the share. */
  key: string
  channel: string
  marketplace: string
  /** The sharing business's account, as its rank on the channel (1 = its primary). */
  sourceAccount: number
  /** How many accounts the sharing business lists this product with on the channel. */
  sourceAccounts: number
  slots: LayoutSlot[]
}

export interface FollowerAccount {
  id: string
  label: string
  /** This business's primary account on the channel (a shared account never is). */
  primary: boolean
  /** Another business's account shared with this one for publishing (BP.S3): its owner, else null. */
  sharedBy: string | null
  /** The markets a shared account may be used on; empty = every market. */
  markets: string[]
}

export interface LayoutHere {
  /** This business's account the group would be made on by default (its account of the same rank), or null. */
  suggestedAccountId: string | null
  /** Why the group cannot be made here, in words; null when it can. */
  blocked: string | null
  /** Per account of this business: which slots already exist there (main listing, aliases by name). */
  present: Record<string, { main: boolean; aliases: string[] }>
}

export interface ListingLayoutView {
  productId: string
  rootId: string
  sourceBusiness: string
  groups: Array<LayoutGroup & { here: LayoutHere }>
  /** This business's accounts per channel of the layout. */
  accounts: Record<string, FollowerAccount[]>
}

type SourceGroup = LayoutGroup

/** The follower's root product and its active link. Call in the follower's context. */
async function followedRoot(productId: string) {
  const { workspaceId } = requireWorkspace()
  const product = await prisma.product.findFirst({ where: { id: productId, workspaceId, deletedAt: null }, select: { id: true, parentId: true } })
  if (!product) throw new WorkspaceError('product_not_found', 'This product is unavailable in this business profile.', 404)
  const rootId = product.parentId ?? product.id
  const link = await prisma.catalogLink.findFirst({ where: { targetWorkspaceId: workspaceId, targetProductId: rootId, status: 'active' }, select: { id: true, shareId: true } })
  if (!link) throw new WorkspaceError('not_following', 'This product does not follow a product of another business, so it has no shared listing layout.', 409)
  return { rootId, link }
}

/** The sharing business's layout of the product the link follows. Call in the FOLLOWER's context. */
async function sourceGroups(linkId: string): Promise<{ groups: SourceGroup[]; sourceBusiness: string }> {
  const follower = requireWorkspace()
  const door = await linkSource(linkId)
  if (!door.source || door.source.deleted) throw new WorkspaceError('source_gone', 'The shared product is no longer shared, so its listing layout cannot be read.', 409)
  const sourceId = door.source.id
  const read = await withWorkspace({ workspaceId: door.ownerWorkspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    const [listings, aliases, owner] = await Promise.all([
      prisma.channelListing.findMany({ where: { productId: sourceId, listingStatus: LIVE_OR_DRAFT }, select: { channel: true, marketplace: true, channelConnectionId: true, aliasKey: true } }),
      prisma.productListingAlias.findMany({ where: { productId: sourceId, status: 'ACTIVE' }, select: { id: true, channel: true, marketplace: true, channelConnectionId: true, label: true, position: true } }),
      prisma.workspace.findFirst({ where: { id: door.ownerWorkspaceId }, select: { name: true } }),
    ])
    const channels = [...new Set(listings.map((l) => l.channel))]
    const ranks = new Map<string, number>()
    for (const channel of channels) (await listActiveConnections(channel)).forEach((c, i) => ranks.set(c.id, i + 1))
    return { listings, aliases, ranks, name: owner?.name ?? 'the other business' }
  })
  // Back in the follower's context: nothing below may touch the owner's tables.
  if (requireWorkspace().workspaceId !== follower.workspaceId) throw new WorkspaceError('context_leak', 'The business context did not return to the follower.', 500)

  const byKey = new Map<string, SourceGroup>()
  const aliasIds = new Set(read.aliases.map((a) => a.id))
  for (const listing of read.listings) {
    const rank = listing.channelConnectionId ? read.ranks.get(listing.channelConnectionId) : undefined
    if (!rank) continue // an account the sharing business no longer has connected: nothing to copy from it
    if (listing.aliasKey && !aliasIds.has(listing.aliasKey)) continue // an archived alias: not part of the layout
    const key = `${listing.channel}|${listing.marketplace}|${rank}`
    const group = byKey.get(key) ?? { key, channel: listing.channel, marketplace: listing.marketplace, sourceAccount: rank, sourceAccounts: 0, slots: [] }
    byKey.set(key, group)
    if (listing.aliasKey === '' && !group.slots.some((s) => s.position === 0)) group.slots.push({ position: 0, label: null })
  }
  for (const alias of read.aliases) {
    const rank = alias.channelConnectionId ? read.ranks.get(alias.channelConnectionId) : undefined
    const group = rank ? byKey.get(`${alias.channel}|${alias.marketplace}|${rank}`) : undefined
    if (group && !group.slots.some((s) => s.position === alias.position)) group.slots.push({ position: alias.position, label: alias.label })
  }
  const groups = [...byKey.values()].filter((g) => g.slots.length > 0)
  for (const group of groups) {
    group.slots.sort((a, b) => a.position - b.position)
    group.sourceAccounts = new Set(groups.filter((g) => g.channel === group.channel).map((g) => g.sourceAccount)).size
  }
  groups.sort((a, b) => a.channel.localeCompare(b.channel) || a.marketplace.localeCompare(b.marketplace) || a.sourceAccount - b.sourceAccount)
  return { groups, sourceBusiness: read.name }
}

/** This business's accounts, markets and existing listings for the layout's channels. */
async function followerSide(rootId: string, channels: string[]) {
  const accounts = await listableAccounts(channels)
  const [markets, listings, aliases] = await Promise.all([
    prisma.marketplace.findMany({ where: { channel: { in: channels }, isActive: true }, select: { channel: true, code: true } }),
    prisma.channelListing.findMany({ where: { productId: rootId, aliasKey: '', listingStatus: LIVE_OR_DRAFT }, select: { channel: true, marketplace: true, channelConnectionId: true } }),
    prisma.productListingAlias.findMany({ where: { productId: rootId, status: 'ACTIVE' }, select: { channel: true, marketplace: true, channelConnectionId: true, label: true } }),
  ])
  return { accounts, markets: new Set(markets.map((m) => `${m.channel}|${m.code}`)), listings, aliases }
}

/**
 * The accounts this business may make a listing on, per channel: its own, and another business's account shared with
 * it for PUBLISHING (BP.S3) — never one shared for reading only, which the database refuses a listing on. Its own
 * come first (primary first), so "the same rank" pairs its own accounts.
 */
async function listableAccounts(channels: string[]): Promise<Record<string, FollowerAccount[]>> {
  const grants = await listSharedWithCurrent()
  const out: Record<string, FollowerAccount[]> = {}
  for (const channel of channels) {
    const own: FollowerAccount[] = [], shared: FollowerAccount[] = []
    for (const c of await listActiveConnections(channel)) {
      const grant = grants.find((g) => g.connectionId === c.id)
      if (!grant) own.push({ id: c.id, label: connectionLabel(c).label, primary: c.isPrimary, sharedBy: null, markets: [] })
      else if (grant.mode === 'publish') shared.push({ id: c.id, label: connectionLabel(c).label, primary: false, sharedBy: grant.ownerWorkspaceName, markets: grant.marketplaces })
    }
    out[channel] = [...own, ...shared]
  }
  return out
}

/** A shared account may be limited to some markets. */
const allows = (account: FollowerAccount, market: string) => account.markets.length === 0 || account.markets.includes(market)

function hereFor(group: SourceGroup, side: Awaited<ReturnType<typeof followerSide>>): LayoutHere {
  const accounts = (side.accounts[group.channel] ?? []).filter((a) => allows(a, group.marketplace))
  const present: LayoutHere['present'] = {}
  for (const account of accounts) {
    const at = (c: { channel: string; marketplace: string; channelConnectionId: string | null }) =>
      c.channel === group.channel && c.marketplace === group.marketplace && c.channelConnectionId === account.id
    present[account.id] = { main: side.listings.some(at), aliases: side.aliases.filter(at).map((a) => a.label) }
  }
  const channelName = channelLabel(group.channel)
  const blocked = !accounts.length ? `This business has no ${channelName} account. Connect one in Settings › Channels.`
    : !side.markets.has(`${group.channel}|${group.marketplace}`) ? `${channelName} ${group.marketplace} is not a market of this business. Add it in Settings › Channels.`
    : null
  // Rank for rank among this business's OWN accounts: the sharing business's account 1 → this business's account 1 (its
  // primary), and so on. A shared account is never suggested: listing on another business's account is a choice.
  return { suggestedAccountId: blocked ? null : accounts.filter((a) => !a.sharedBy)[group.sourceAccount - 1]?.id ?? null, blocked, present }
}

/** The shared product's layout, and what this business has of it. `productId` may be a variation: its family's. */
export async function listingLayout(productId: string): Promise<ListingLayoutView> {
  const { rootId, link } = await followedRoot(productId)
  const { groups, sourceBusiness } = await sourceGroups(link.id)
  const side = await followerSide(rootId, [...new Set(groups.map((g) => g.channel))])
  return { productId, rootId, sourceBusiness, accounts: side.accounts, groups: groups.map((g) => ({ ...g, here: hereFor(g, side) })) }
}

export interface LayoutChoice { key: string; accountId: string | null }

export interface LayoutGroupResult {
  key: string
  /** Draft listing rows made (the family's main listing, per product) and aliases made (each with its family rows). */
  listings: number
  aliases: number
  /** Why this group was not made, in words; null when it was (or already was). */
  refused: string | null
}

/**
 * Make the chosen groups here as drafts. Each group is its own write: one group refused (no market, a disconnected
 * account) does not stop the others, and says why. A group chosen with no account is left out.
 */
export async function applyListingLayout(productId: string, input: { choices?: unknown }, actorUserId: string | null = requireWorkspace().actorUserId ?? null): Promise<{ results: LayoutGroupResult[] }> {
  const choices = parseChoices(input.choices)
  const { rootId, link } = await followedRoot(productId)
  const { groups } = await sourceGroups(link.id)
  const side = await followerSide(rootId, [...new Set(groups.map((g) => g.channel))])
  const results: LayoutGroupResult[] = []
  for (const choice of choices) {
    if (!choice.accountId) continue
    const group = groups.find((g) => g.key === choice.key)
    if (!group) { results.push({ key: choice.key, listings: 0, aliases: 0, refused: 'The shared product is no longer listed like this. Reload the page.' }); continue }
    const here = hereFor(group, side)
    if (here.blocked) { results.push({ key: group.key, listings: 0, aliases: 0, refused: here.blocked }); continue }
    if (!(side.accounts[group.channel] ?? []).some((a) => a.id === choice.accountId && allows(a, group.marketplace))) {
      results.push({ key: group.key, listings: 0, aliases: 0, refused: 'That account is not connected in this business. Reload the page.' }); continue
    }
    results.push(await makeGroup(rootId, group, choice.accountId, here.present[choice.accountId] ?? { main: false, aliases: [] }, actorUserId))
  }
  return { results }
}

async function makeGroup(rootId: string, group: SourceGroup, accountId: string, present: { main: boolean; aliases: string[] }, actorUserId: string | null): Promise<LayoutGroupResult> {
  const result: LayoutGroupResult = { key: group.key, listings: 0, aliases: 0, refused: null }
  try {
    if (group.slots.some((s) => s.position === 0) && !present.main) {
      const rows = await ensureDraftListingsInTransaction({ channel: group.channel, market: group.marketplace, accountId, productIds: [rootId], family: true })
      result.listings = rows.filter((row) => row.created).length
    }
    const have = new Set(present.aliases.map((label) => label.trim().toLowerCase()))
    for (const slot of group.slots) {
      if (slot.position === 0 || !slot.label || have.has(slot.label.trim().toLowerCase())) continue
      await createAlias({ productId: rootId, channel: group.channel, marketplace: group.marketplace, accountId, label: slot.label, createdBy: actorUserId })
      have.add(slot.label.trim().toLowerCase())
      result.aliases++
    }
  } catch (error) {
    if (error instanceof DraftListingError || error instanceof ProductRelationshipError || ['AmbiguousConnectionError', 'AliasCreationBlockedError', 'NoConnectionError'].includes((error as { name?: string })?.name ?? '')) {
      result.refused = error instanceof Error ? error.message : String(error)
    } else throw error
  }
  return result
}

function parseChoices(value: unknown): LayoutChoice[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) throw new WorkspaceError('invalid_choices', 'Choose, for each listing group, an account of this business or none.', 400)
  return value.map((entry) => {
    const key = (entry as { key?: unknown })?.key
    const accountId = (entry as { accountId?: unknown })?.accountId
    if (typeof key !== 'string' || !key || (accountId !== null && (typeof accountId !== 'string' || !accountId))) {
      throw new WorkspaceError('invalid_choices', 'Choose, for each listing group, an account of this business or none.', 400)
    }
    return { key, accountId: accountId as string | null }
  })
}

// ── Every product of a share at once (Settings › Shared products) ────────────────────────────────

export interface ShareLayoutGroup {
  /** `${channel}|${sourceAccount}`: one choice covers every market and product of that account. */
  key: string
  channel: string
  sourceAccount: number
  sourceAccounts: number
  products: number
  markets: string[]
  aliases: number
  suggestedAccountId: string | null
}

async function linkedRoots(shareId: string) {
  const { workspaceId } = requireWorkspace()
  const links = await prisma.catalogLink.findMany({ where: { shareId, targetWorkspaceId: workspaceId, status: 'active' }, select: { id: true, targetProductId: true } })
  const roots = new Set((await prisma.product.findMany({ where: { id: { in: links.map((l) => l.targetProductId) }, parentId: null, deletedAt: null }, select: { id: true } })).map((p) => p.id))
  return links.filter((l) => roots.has(l.targetProductId))
}

/** Per channel and account of the sharing business: how many followed products it lists, where, with how many aliases. */
export async function shareLayout(shareId: string): Promise<{ groups: ShareLayoutGroup[]; accounts: Record<string, FollowerAccount[]> }> {
  const roots = await linkedRoots(shareId)
  const byKey = new Map<string, ShareLayoutGroup & { marketSet: Set<string>; productSet: Set<string> }>()
  for (const root of roots) {
    const { groups } = await sourceGroups(root.id)
    for (const g of groups) {
      const key = `${g.channel}|${g.sourceAccount}`
      const entry = byKey.get(key) ?? { key, channel: g.channel, sourceAccount: g.sourceAccount, sourceAccounts: 0, products: 0, markets: [], aliases: 0, suggestedAccountId: null, marketSet: new Set<string>(), productSet: new Set<string>() }
      byKey.set(key, entry)
      entry.sourceAccounts = Math.max(entry.sourceAccounts, g.sourceAccounts)
      entry.marketSet.add(g.marketplace)
      entry.productSet.add(root.targetProductId)
      entry.aliases += g.slots.filter((s) => s.position > 0).length
    }
  }
  const channels = [...new Set([...byKey.values()].map((g) => g.channel))]
  const accounts = await listableAccounts(channels)
  const groups = [...byKey.values()].map(({ marketSet, productSet, ...g }) => ({
    ...g, markets: [...marketSet].sort(), products: productSet.size, suggestedAccountId: (accounts[g.channel] ?? []).filter((a) => !a.sharedBy)[g.sourceAccount - 1]?.id ?? null,
  })).sort((a, b) => a.channel.localeCompare(b.channel) || a.sourceAccount - b.sourceAccount)
  return { groups, accounts }
}

/** Make the layout of every followed product of the share, one choice per channel and account of the sharing business. */
export async function applyShareLayout(shareId: string, input: { choices?: unknown }): Promise<{ products: number; listings: number; aliases: number; refused: Array<{ productId: string; sku: string; reason: string }> }> {
  const choices = parseChoices(input.choices)
  const pick = new Map(choices.map((c) => [c.key, c.accountId]))
  const roots = await linkedRoots(shareId)
  const skus = new Map((await prisma.product.findMany({ where: { id: { in: roots.map((r) => r.targetProductId) } }, select: { id: true, sku: true } })).map((p) => [p.id, p.sku]))
  const out = { products: 0, listings: 0, aliases: 0, refused: [] as Array<{ productId: string; sku: string; reason: string }> }
  for (const root of roots) {
    const { groups } = await sourceGroups(root.id)
    const mine = groups.map((g) => ({ key: g.key, accountId: pick.get(`${g.channel}|${g.sourceAccount}`) ?? null })).filter((c) => c.accountId)
    if (!mine.length) continue
    const { results } = await applyListingLayout(root.targetProductId, { choices: mine })
    out.products++
    for (const r of results) {
      out.listings += r.listings
      out.aliases += r.aliases
      if (r.refused) out.refused.push({ productId: root.targetProductId, sku: skus.get(root.targetProductId) ?? root.targetProductId, reason: r.refused })
    }
  }
  return out
}
