/**
 * MCP full control L3 — the studio's publication, read by Claude (plan section 02, step 3).
 *
 *   publish-review      the product studio's own review of one destination (`reviewStudioPublication`): what a publish
 *                       would send, what blocks it, what differs from the channel. It saves NOTHING — no review row, no
 *                       Shopify content save — so nothing can be selected or submitted from it; publishing stays a change
 *                       a person approves. It reads the channel live, as the studio's review does (through the gateway).
 *   publication-status  a publication's result as Nexus stores it, read in this business whoever submitted it. A pure
 *                       read: it never asks the channel and never settles (the settle sweep and the studio's own read do).
 *
 *   publish-listing     (L5) publishes one product family to one channel, market and account THROUGH the studio — the
 *                       studio's review, its exact selection and its submit, run as the person who approves it — and only
 *                       the field groups named (d4: a re-publish never sends stock, price or fulfilment; a first
 *                       publish creates the listing with them).
 *
 * All run in the caller's business (row-level security; no argument names a business), never take a channel's own id
 * (an ASIN, an eBay item number) as input, and resolve an account only among this business's own connections.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { channelLabel } from '@nexus/shared/channel-label'
import { blockingIssues, isPhotoChangeId, PUBLICATION_PHOTO_FIELDS, type StudioPublishChange, type StudioPublishResult, type StudioPublishReview, type StudioPublishValue } from '@nexus/shared/studio-publication'
import prisma from '../../../db.js'
import { connectionLabel } from '../../connection-label.js'
import { isOwnConnection } from '../../connection-resolver.service.js'
import { AMAZON_EU_SHARED_MARKETS } from '../../amazon-eu-quantity-guard.js'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { liveProduct, PRODUCT_NOT_FOUND } from './live-product.js'

/** The studio publication service loads lazily, as the studio routes load it: the registry (every tool file) stays light. */
const studio = () => import('../../pim/studio-publication.service.js')

const PUBLISH_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'] as const
const ISSUE_CAP = 30
const CHANGE_CAP = 60
const ROW_CAP = 60
const RESULT_CAP = 100
const TEXT_CAP = 240
const VALUE_CAP = 120

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const clip = (text: string | null | undefined, cap = TEXT_CAP) => (text == null ? null : text.length > cap ? `${text.slice(0, cap - 1)}…` : text)

/** A review value as one short line: the value, "(empty)", or why it is not known. */
function valueText(value: StudioPublishValue | undefined): string | null {
  if (!value) return null
  if (value.state === 'absent') return '(empty)'
  if (value.state === 'unknown') return clip(`(not known: ${value.reason})`, VALUE_CAP)
  return clip(typeof value.value === 'string' ? value.value : JSON.stringify(value.value) ?? '', VALUE_CAP)
}

/** An error the studio or the destination check gives a person (an HTTP 4xx sentence), as opposed to a fault. */
function personError(error: unknown): string | null {
  const status = (error as { statusCode?: unknown })?.statusCode
  const code = (error as { code?: unknown })?.code
  if ((typeof status === 'number' && status >= 400 && status < 500) || code === 'unknown_product') {
    return error instanceof Error ? error.message : String(error)
  }
  return null
}

type Account = { id: string; channelType: string; isActive: boolean; label: string }

/** This business's own accounts on one channel. */
async function accountsOn(channel: string): Promise<Account[]> {
  const rows = await prisma.channelConnection.findMany({
    where: { channelType: channel },
    select: { id: true, channelType: true, accountLabel: true, ebayStoreName: true, displayName: true, ebaySignInName: true, externalAccountId: true, isActive: true, isPrimary: true, workspaceId: true, sortOrder: true },
    orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  })
  return rows.filter(isOwnConnection).map((row) => ({ id: row.id, channelType: row.channelType, isActive: row.isActive, label: connectionLabel(row).label }))
}

/**
 * The account a review is for: the one named (it must be an active account of this business on this channel), else the
 * named listing's, else the business's one active account on the channel. Several and none named: the caller chooses.
 */
async function accountFor(channel: string, accountId: string | undefined, listingId: string | undefined): Promise<{ account: Account } | { error: string }> {
  const accounts = await accountsOn(channel)
  const name = channelLabel(channel)
  let wanted = accountId
  if (!wanted && listingId) {
    // A listing id, or an alias id (Owner 2026-10-05: an alias is named by its own id, as the Publish window names it).
    const listing = await prisma.channelListing.findFirst({ where: { id: listingId }, select: { channelConnectionId: true } })
      ?? await prisma.productListingAlias.findFirst({ where: { id: listingId, status: 'ACTIVE' }, select: { channelConnectionId: true } })
    if (!listing) return { error: 'Listing not found in this business: listing-coordinates lists the listings of a product.' }
    if (!listing.channelConnectionId) return { error: 'This listing has no account recorded: name the account (accountId).' }
    wanted = listing.channelConnectionId
  }
  if (wanted) {
    const account = accounts.find((a) => a.id === wanted)
    if (!account) return { error: `This business has no ${name} account with this id: listing-coordinates lists its accounts.` }
    if (!account.isActive) return { error: `The ${name} account "${account.label}" is not active. Reconnect it in Nexus first.` }
    return { account }
  }
  const active = accounts.filter((a) => a.isActive)
  if (active.length === 1) return { account: active[0] }
  if (!active.length) return { error: `This business has no active ${name} account. Connect one in Nexus first.` }
  return { error: `This business has ${active.length} active ${name} accounts (${active.map((a) => `${a.label}: ${a.id}`).join('; ')}). Name one as accountId.` }
}

function trimmedReview(review: StudioPublishReview) {
  const errors = review.issues.filter((i) => i.severity === 'error')
  const changes = (review.changes ?? []) as StudioPublishChange[]
  const byStatus: Record<string, number> = {}
  for (const change of changes) byStatus[change.status] = (byStatus[change.status] ?? 0) + 1
  // What would be sent first: SEND and DIFFERS before CANNOT_COMPARE and SAME.
  const rank: Record<string, number> = { SEND: 0, DIFFERS: 1, CANNOT_COMPARE: 2, SAME: 3 }
  const shownChanges = [...changes].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9)).slice(0, CHANGE_CAP)
  const issues = [...review.issues].sort((a, b) => Number(a.severity !== 'error') - Number(b.severity !== 'error')).slice(0, ISSUE_CAP)
  return {
    mode: review.mode,
    action: review.action,
    accountLabel: review.accountLabel,
    aliasLabel: review.aliasLabel,
    // Ready: nothing blocks it. Only photos may be sent when every problem names a field other than the photos.
    ready: errors.length === 0,
    ...(review.photosOnly ? { photosOnly: true } : {}),
    ...(review.previousPublicationId ? { previousPublicationId: review.previousPublicationId } : {}),
    issueCounts: { errors: errors.length, warnings: review.issues.length - errors.length },
    issues: issues.map((i) => ({ severity: i.severity, ...(i.sku ? { sku: i.sku } : {}), ...(i.field ? { field: i.field } : {}), message: clip(i.message) })),
    ...(review.issues.length > issues.length ? { moreIssues: review.issues.length - issues.length } : {}),
    products: review.rows.slice(0, ROW_CAP).map((row) => ({ productId: row.productId, sku: row.sku, title: clip(row.title, VALUE_CAP), live: row.existing })),
    ...(review.rows.length > ROW_CAP ? { moreProducts: review.rows.length - ROW_CAP } : {}),
    ...(review.excluded ? { excludedFromThisListing: review.excluded } : {}),
    ...(review.skipped?.length ? { skipped: review.skipped.slice(0, ROW_CAP).map((s) => ({ sku: s.sku, reason: clip(s.reason) })) } : {}),
    ...(review.changes ? {
      changeCounts: byStatus,
      changes: shownChanges.map((c) => ({
        id: c.id, sku: c.sku, field: c.field, label: c.label, status: c.status,
        nexus: valueText(c.current), channel: valueText(c.channel), selectable: c.selectable, selectedByDefault: c.selectedByDefault, reason: clip(c.reason),
      })),
      ...(changes.length > shownChanges.length ? { moreChanges: changes.length - shownChanges.length } : {}),
    } : {}),
    ...(review.overwrite ? {
      overwrite: {
        requiresConfirmation: review.overwrite.requiresConfirmation,
        productsRead: review.overwrite.products.filter((p) => p.status === 'compared').length,
        fieldsDiffering: review.overwrite.products.reduce((sum, p) => sum + p.differing, 0),
      },
    } : {}),
    ...(review.locations ? { locations: review.locations } : {}),
    ...(review.visibility ? { visibility: review.visibility } : {}),
  }
}

const publishReview: AgentTool = {
  name: 'publish-review',
  title: 'Review a publish',
  input: z.object({
    productId: z.string().trim().min(1).max(64).describe('Nexus product id: the family (parent), one of its variations or a single product'),
    channel: z.preprocess(upper, z.enum(PUBLISH_CHANNELS)).describe('the channel: AMAZON, EBAY, SHOPIFY or ETSY'),
    market: z.string().trim().toUpperCase().min(2).max(20).describe('the marketplace code, e.g. IT or DE; GLOBAL for Shopify and Etsy'),
    accountId: z.string().trim().min(1).max(64).optional()
      .describe('the Nexus account id (listing-coordinates names it); optional when this business has one active account on the channel'),
    listingId: z.string().trim().min(1).max(64).optional()
      .describe('a Nexus listing id from listing-coordinates, to review a second listing (alias) of the family on this account and market'),
  }),
  requires: [F.listingsView, F.productsView],
  category: 'listings',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  description:
    'The Nexus product studio\'s review of publishing one product family to one channel, market and account: whether it '
    + 'would create or update the listing, what blocks it (issues with severity error), each field it would send and how '
    + 'it compares with what the channel shows now (changes: SEND, DIFFERS, CANNOT_COMPARE, SAME), and the live mode of the '
    + 'channel. It reads the channel live and saves nothing: it is a review only, nothing is sent and nothing can be '
    + 'submitted from it — publishing is a separate change a person approves in Nexus. previousPublicationId names a '
    + 'publication at this destination still waiting for its result (publication-status reads it). Amazon EU merchant '
    + 'quantity is one number for every EU market. eBay\'s own check of a new eBay listing is not run here: it runs when '
    + 'an approved publish-listing runs, and an eBay refusal there sends nothing.',
  async handler(args) {
    const productId = String(args.productId)
    const channel = String(args.channel)
    const market = String(args.market)
    const product = await prisma.product.findFirst({ where: liveProduct(productId), select: { sku: true } })
    if (!product) return { ok: false, error: PRODUCT_NOT_FOUND }
    const where = `${product.sku} on ${channelLabel(channel)} ${market}`
    const resolved = await accountFor(channel, args.accountId as string | undefined, args.listingId as string | undefined)
    if ('error' in resolved) return { ok: false, error: `${where}: ${resolved.error}` }
    const scope = { channel, marketplace: market, accountId: resolved.account.id, ...(args.listingId ? { listingId: String(args.listingId) } : {}) }
    let review: StudioPublishReview
    try {
      review = await (await studio()).reviewStudioPublication(productId, scope)
    } catch (error) {
      const sentence = personError(error)
      if (sentence === null) throw error
      return { ok: false, error: `${where}: ${sentence}` }
    }
    return {
      ok: true,
      data: {
        productId: review.productId,
        sku: product.sku,
        destination: { channel, market, accountId: resolved.account.id, accountLabel: resolved.account.label, ...(args.listingId ? { listingId: String(args.listingId) } : {}) },
        ...trimmedReview(review),
        note: 'A review only: nothing was saved or sent. Publishing is a separate change a person approves in Nexus.',
      },
    }
  },
}

/** Still waiting for the channel: it settles elsewhere, never in this read. */
const PENDING = new Set(['PUBLISHING', 'SUBMITTED', 'UNVERIFIED'])
const PENDING_NOTE = 'Pending — Nexus checks it again by itself every 2 minutes (the publication sweep), or when someone opens '
  + 'its result in the Nexus studio. Read it again later.'

const publicationStatus: AgentTool = {
  name: 'publication-status',
  title: 'Publication status',
  input: z.object({
    publicationId: z.string().trim().min(1).max(64)
      .describe('the id of a publication: a publish returns it, and publish-review names one still waiting for its result'),
  }),
  requires: [F.listingsView],
  category: 'listings',
  riskTier: 'low',
  readOnly: true,
  description:
    'What became of a publication of a product to a channel, as Nexus has recorded it, read in this business whoever '
    + 'submitted it: SUBMITTED (an Amazon feed is processing), UNVERIFIED (eBay acknowledged the item; its live status is '
    + 'not confirmed yet), PUBLISHING, ACCEPTED, VERIFIED, PARTIAL (some products rejected), FAILED or NOT_SUBMITTED, with '
    + 'each product\'s result. It only reads: it never asks the channel and changes nothing. A pending publication '
    + 'settles by itself (Nexus checks it again every 2 minutes) or when someone opens its result in the Nexus '
    + 'studio; then this tool reports the settled result.',
  async handler(args): Promise<ToolResult> {
    const id = String(args.publicationId)
    const stored = await (await studio()).readStoredPublication(id)
    if (!stored) return { ok: false, error: 'Publication not found' }
    const product = await prisma.product.findFirst({ where: { id: stored.productId }, select: { sku: true } })
    const status = stored.status === 'PREVIEW' ? 'NOT_SUBMITTED' : stored.status
    const pending = PENDING.has(status)
    const result = stored.result
    const message = result?.message
      ?? (status === 'PUBLISHING' ? 'The channel is processing this publication.' : status === 'NOT_SUBMITTED' ? 'This review was never submitted: nothing was sent.' : null)
    return {
      ok: true,
      data: {
        publicationId: id,
        productId: stored.productId,
        sku: product?.sku ?? null,
        destination: { channel: stored.scope?.channel ?? null, market: stored.scope?.marketplace ?? null, accountId: stored.scope?.accountId ?? null },
        submittedAt: stored.startedAt,
        status,
        settled: !pending && status !== 'NOT_SUBMITTED',
        message: clip(message, 600),
        ...(result?.warnings?.length ? { warnings: result.warnings.slice(0, 10).map((w) => clip(w)) } : {}),
        results: (result?.results ?? []).slice(0, RESULT_CAP).map((r) => ({ sku: r.sku, status: r.status, message: clip(r.message), ...(r.reference ? { reference: r.reference } : {}) })),
        ...((result?.results.length ?? 0) > RESULT_CAP ? { moreResults: result!.results.length - RESULT_CAP } : {}),
        ...(pending ? { next: PENDING_NOTE } : {}),
      },
    }
  },
}

/**
 * N4 — a publish in words. The studio's review already knows, per row, whether a new listing starts active or inactive
 * and which rows are held (blocked, deleted and left Not listed, or Not listed): the preview used to drop all of it.
 */
export function publishStory(d: { product: { sku: string }; channel: string; market: string }, review: StudioPublishReview, plan: PublishPlan, euSiblings: boolean) {
  const where = `${channelLabel(d.channel)} ${d.market}`
  const creates = review.rows.filter((r) => r.startsAs).slice(0, 60).map((r) => ({ sku: r.sku, startsAs: r.startsAs!, ...(r.relist ? { relist: true } : {}) }))
  const held = review.rows.filter((r) => r.blocked || r.deleted || r.notListed).slice(0, 60)
    .map((r) => ({ sku: r.sku, why: clip(r.blocked ?? (r.deleted ? 'deleted from the channel and left Not listed' : 'its Status is Not listed')) }))
  const active = creates.filter((c) => c.startsAs === 'active').length
  const parts: string[] = []
  if (creates.length) {
    parts.push(`creates ${creates.length} listing${creates.length === 1 ? '' : 's'} on ${where} (${active} active, ${creates.length - active} inactive) `
      + 'with the price, quantity and fulfilment Nexus holds for them (listing-matrix shows them)')
  }
  const fieldsSent = plan.selected.filter((c) => groupOf(c.field) !== 'create').length
  if (fieldsSent) parts.push(`sends ${fieldsSent} changed field${fieldsSent === 1 ? '' : 's'} to ${where}`)
  if (held.length) parts.push(`leaves ${held.length} row${held.length === 1 ? '' : 's'} out (held)`)
  const summary = `${d.product.sku}: ${plan.publish} — ${parts.length ? parts.join('; ') : `nothing to send to ${where}`}.`
  const warning = d.channel === 'AMAZON' && AMAZON_EU_SHARED_MARKETS.has(d.market) && plan.publish === 'first publish' && !euSiblings
    ? `Amazon keeps ONE quantity per SKU for every EU market (${[...AMAZON_EU_SHARED_MARKETS].join(', ')}): this first publish in ${d.market} sets it for all of them.`
    : null
  return { summary, creates, held, warning }
}

// ── publish-listing (L5) ─────────────────────────────────────────────────────────────────────────────

/** The field groups a publish may name (d4). Stock, price and fulfilment are not among them: a re-publish never sends them;
 * a first publish creates the listing with them (inside its create message). */
export const FIELD_GROUPS = ['title', 'description', 'bullets', 'keywords', 'photos', 'attributes'] as const
type FieldGroup = (typeof FIELD_GROUPS)[number]
type Group = FieldGroup | 'create' | 'never'
const NEVER_SENT = 'A re-publish never sends stock, price or fulfilment: set-listing-stock and set-listing-price change them.'
const SENT_IN_CREATE = 'Sent inside the new listing: a first publish creates it with its price, quantity and (Amazon) fulfilment. '
  + 'After that, set-listing-stock and set-listing-price change them.'

/** The group of one reviewed field (Amazon roots and content coordinates, eBay Trading and Inventory fields). */
export function groupOf(field: string): Group {
  if (field === '$create' || field === '__create__') return 'create'
  if (/quantity|fulfil|purchasable_offer|price/i.test(field)) return 'never'
  if (PUBLICATION_PHOTO_FIELDS.has(field) || /image_locator/i.test(field)) return 'photos'
  const root = field.split(':')[0]
  if (root === 'item_name' || field === 'title') return 'title'
  if (root === 'product_description' || field === 'description') return 'description'
  if (root === 'bullet_point') return 'bullets'
  if (root === 'generic_keyword') return 'keywords'
  return 'attributes'
}

type Fields = 'all' | 'photos' | FieldGroup[]
const wantedGroups = (fields: Fields): Set<FieldGroup> =>
  new Set(fields === 'all' ? FIELD_GROUPS : fields === 'photos' ? ['photos'] : fields)

interface PublishPlan {
  publish: 'first publish' | 're-publish'
  selected: StudioPublishChange[]
  notSent: Array<{ sku: string; field: string; label: string; reason: string }>
  unchanged: number
  refusal: string | null
}

/**
 * What a publish of these field groups sends from one studio review: every selectable change of a named group that Nexus
 * would change (SEND) or that replaces a differing channel value (DIFFERS); a new listing is sent complete (its create
 * row); nothing the channel could not be compared on; never stock, price or fulfilment. Pure.
 */
export function planPublish(review: StudioPublishReview, channel: string, fields: Fields): PublishPlan {
  const first = review.action === 'create'
  if (channel === 'SHOPIFY') {
    // A Shopify family is published new and complete (the studio refuses change-only on an existing Shopify product).
    const blockers = review.issues.filter((i) => i.severity === 'error')
    return { publish: first ? 'first publish' : 're-publish', selected: [], notSent: [], unchanged: 0,
      refusal: fields !== 'all' ? 'A new Shopify product is sent complete: name fields "all".' : blockers.length ? blockers.map((i) => i.message).join(' ') : null }
  }
  const changes = review.changes
  if (!changes) {
    const blockers = review.issues.filter((i) => i.severity === 'error')
    return { publish: first ? 'first publish' : 're-publish', selected: [], notSent: [], unchanged: 0,
      refusal: blockers.length ? blockers.map((i) => i.message).join(' ') : 'The studio could not review the fields of this listing.' }
  }
  const wanted = wantedGroups(fields)
  const creates = changes.filter((c) => groupOf(c.field) === 'create')
  const plan: PublishPlan = { publish: creates.length ? 'first publish' : 're-publish', selected: [], notSent: [], unchanged: 0, refusal: null }
  if (creates.length && fields !== 'all') {
    plan.refusal = 'A first publish sends the complete listing: name fields "all".'
    return plan
  }
  for (const change of changes) {
    const group = groupOf(change.field)
    const skip = (reason: string) => plan.notSent.push({ sku: change.sku, field: change.field, label: change.label, reason })
    if (group === 'never') { if (change.status !== 'SAME') skip(plan.publish === 'first publish' ? SENT_IN_CREATE : NEVER_SENT); continue }
    if (group === 'create') { if (change.selectable) plan.selected.push(change); else skip(change.reason); continue }
    if (!wanted.has(group)) continue
    if (change.status === 'SAME') { plan.unchanged += 1; continue }
    if (change.selectable && (change.status === 'SEND' || change.status === 'DIFFERS')) plan.selected.push(change)
    else skip(change.reason)
  }
  const ids = plan.selected.map((c) => c.id)
  if (review.photosOnly && ids.some((id) => !isPhotoChangeId(id))) {
    plan.refusal = `Only photos may be sent from this review: ${review.issues.filter((i) => i.severity === 'error').map((i) => i.message).join(' ')}`
    return plan
  }
  const blockers = blockingIssues(review.issues, ids)
  if (blockers.length) plan.refusal = blockers.map((i) => i.message).join(' ')
  else if (!plan.selected.length) {
    plan.refusal = plan.notSent.length
      ? `Nothing can be sent for the fields named: ${plan.notSent.slice(0, 5).map((n) => `${n.sku} ${n.label}: ${n.reason}`).join(' · ')}`
      : 'Nothing to send: every field named already matches the channel.'
  }
  return plan
}

/** An Amazon create message's fulfilment rows. */
const fulfilmentOf = (change: StudioPublishChange): Array<Record<string, unknown>> => {
  const message = change.current.state === 'value' ? change.current.value as { attributes?: Record<string, unknown> } : null
  const rows = message?.attributes?.fulfillment_availability
  return Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object') : []
}
const isFbaRow = (row: Record<string, unknown>) => typeof row.fulfillment_channel_code === 'string' && row.fulfillment_channel_code.startsWith('AMAZON_')

interface EuQuantity { sku: string; sends: number; otherMarkets: Array<{ market: string; holds: number | null }> }

/**
 * The Amazon guards of a first publish. FBA: a create that would send a quantity on an Amazon-fulfilled row is refused —
 * FBA quantity is Amazon's. EU: Amazon keeps ONE merchant quantity per SKU for every EU market, so a first publish in one
 * sets it in all; refused when the live EU listings of the same SKU hold another number. A re-publish never carries a
 * quantity (the studio's change rows leave stock out), so it has nothing to guard.
 */
async function amazonGuards(plan: PublishPlan, market: string, accountId: string, aliasKey = ''): Promise<{ refusal: string | null; euQuantity: EuQuantity[] }> {
  const creates = plan.selected.filter((c) => groupOf(c.field) === 'create')
  for (const change of creates) {
    if (fulfilmentOf(change).some((row) => isFbaRow(row) && row.quantity !== undefined)) {
      return { refusal: `${change.sku} is fulfilled by Amazon (FBA): its quantity is Amazon's, and this first publish would send one. Publish it from the Nexus studio.`, euQuantity: [] }
    }
  }
  if (!AMAZON_EU_SHARED_MARKETS.has(market)) return { refusal: null, euQuantity: [] }
  const euQuantity: EuQuantity[] = []
  const { CHANNEL_SKU_LISTING_SELECT } = await import('../../listings/channel-sku.js')
  const { liveChannelSku } = await import('../../listings/channel-sku.pure.js')
  for (const change of creates) {
    const row = fulfilmentOf(change).find((r) => !isFbaRow(r) && typeof r.quantity === 'number')
    if (!row) continue
    // Amazon's one EU quantity is per seller SKU and account (as the batch's `batchEuQuantityConflicts`): the live EU
    // listings holding the SKU this create sends — not every listing of the product, so an alias with its own seller SKU
    // and the main listing are never mixed (Owner 2026-10-05). A listing whose SKU cannot be read counts when it is the
    // same product's main listing and this create is too (the guard refuses rather than guess).
    const message = change.current.state === 'value' ? change.current.value as { sku?: unknown } | null : null
    const sku = typeof message?.sku === 'string' && message.sku ? message.sku : change.sku
    const others = await prisma.channelListing.findMany({
      where: { channel: 'AMAZON', channelConnectionId: accountId, isPublished: true, offerClosedAt: null,
        marketplace: { in: [...AMAZON_EU_SHARED_MARKETS].filter((m) => m !== market) },
        OR: [{ productId: change.productId }, { channelSku: sku }, { liveChannelSku: sku }] },
      select: { ...CHANNEL_SKU_LISTING_SELECT, quantity: true, fulfillmentMethod: true },
      orderBy: [{ marketplace: 'asc' }, { id: 'asc' }],
    })
    const holdsSku = (o: (typeof others)[number]) => {
      const held = liveChannelSku(o, o.product?.sku)
      return held?.sku ? held.sku === sku : o.productId === change.productId && !o.aliasKey && !aliasKey
    }
    const live = others.filter((o) => o.fulfillmentMethod !== 'FBA' && holdsSku(o))
    if (!live.length) continue
    const entry = { sku, sends: row.quantity as number, otherMarkets: live.map((o) => ({ market: o.marketplace, holds: o.quantity })) }
    euQuantity.push(entry)
    const differs = entry.otherMarkets.filter((o) => o.holds !== entry.sends)
    if (differs.length) {
      return { euQuantity, refusal: `${sku}: this first publish in ${market} would set Amazon's one EU quantity to ${entry.sends}, but its live EU listings hold `
        + `${differs.map((o) => `${o.holds ?? 'no number'} (${o.market})`).join(', ')}. Amazon EU merchant quantity is one number for every EU market: `
        + 'align the quantity first, then publish.' }
    }
  }
  return { refusal: null, euQuantity }
}

const canonical = (value: unknown) => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry)

/** What a person approves, as one hash: the destination, what is sent and what it replaces. A difference refuses the run. */
function fingerprintOf(destination: Record<string, unknown>, review: StudioPublishReview, plan: PublishPlan, euQuantity: EuQuantity[], location: string | null) {
  return createHash('sha256').update(canonical({
    destination, publish: plan.publish, mode: review.mode,
    send: plan.selected.map((c) => [c.id, c.status, c.current, c.channel]),
    ...(review.changes ? {} : { products: review.rows.map((r) => [r.productId, r.sku, r.title, r.existing]), visibility: review.visibility ?? null, location,
      overwrite: review.overwrite?.requiresConfirmation ?? false }),
    euQuantity,
  })).digest('hex')
}

const publishInput = z.object({
  productId: z.string().trim().min(1).max(64).describe('Nexus product id: the family (parent), one of its variations or a single product'),
  channel: z.preprocess(upper, z.enum(PUBLISH_CHANNELS)).describe('AMAZON, EBAY, SHOPIFY or ETSY'),
  marketplace: z.string().trim().toUpperCase().min(2).max(20).optional()
    .describe('the market, e.g. DE or IT (GLOBAL for Shopify); optional when the product\'s listings on this channel are in one market'),
  accountId: z.string().trim().min(1).max(64).optional()
    .describe('the Nexus account id (listing-coordinates names it); optional when the destination has one account'),
  listingId: z.string().trim().min(1).max(64).optional()
    .describe('a Nexus listing id from listing-coordinates, to publish a second listing (alias) of the family on this account and market'),
  fields: z.union([z.enum(['all', 'photos']), z.array(z.enum(FIELD_GROUPS)).min(1).max(FIELD_GROUPS.length)]).optional()
    .describe('what to send: "all" (default; every content field, and a new listing complete), "photos", or field groups: title, '
      + 'description, bullets, keywords, photos, attributes. A re-publish never sends stock, price or fulfilment; a first publish '
      + 'creates the listing with them. Amazon: a live listing\'s photos usually go through the photo review in Nexus (Images or '
      + 'Media page), so "photos" may have nothing to send'),
  location: z.string().trim().min(1).max(200).optional()
    .describe('Shopify only: the inventory location (an id from publish-review\'s locations); optional when the store has one'),
})

/** The destination a publish names: the product, its market and its account, resolved in this business. */
async function publishDestination(args: Record<string, unknown>) {
  const productId = String(args.productId)
  const channel = String(args.channel)
  const product = await prisma.product.findFirst({ where: liveProduct(productId), select: { id: true, sku: true, parentId: true } })
  if (!product) return { error: PRODUCT_NOT_FOUND }
  const name = channelLabel(channel)
  if (channel === 'ETSY') return { error: `${product.sku}: publishing to Etsy from Nexus is not available yet; nothing can be sent there.` }
  const rootId = product.parentId ?? product.id
  const family = await prisma.channelListing.findMany({
    where: { channel, product: { deletedAt: null, OR: [{ id: rootId }, { parentId: rootId }] } },
    select: { marketplace: true, channelConnectionId: true },
  })
  let market = args.marketplace as string | undefined
  if (!market) {
    const markets = [...new Set(family.map((l) => l.marketplace))].sort()
    if (markets.length !== 1) {
      return { error: markets.length
        ? `${product.sku} has ${name} listings in ${markets.join(', ')}: name the market (marketplace).`
        : `${product.sku} has no ${name} listing yet: name the market (marketplace).` }
    }
    market = markets[0]
  }
  // The destination's own account when its listings name one, else the business's one active account on the channel.
  const attributed = [...new Set(family.filter((l) => l.marketplace === market && l.channelConnectionId).map((l) => l.channelConnectionId!))]
  const accountId = (args.accountId as string | undefined) ?? (!args.listingId && attributed.length === 1 ? attributed[0] : undefined)
  const resolved = await accountFor(channel, accountId, args.listingId as string | undefined)
  if ('error' in resolved) return { error: `${product.sku} on ${name} ${market}: ${resolved.error}` }
  // The listing a publish is about, resolved as the studio resolves it: '' = the main listing, else the alias id (a listing
  // id or an alias id may name it). Its undo closes that listing's rows, never the main listing's (Owner 2026-10-05).
  let aliasKey = ''
  if (args.listingId) {
    try {
      const { resolveWorkspaceDestination } = await import('../../pim/workspace-destination.js')
      aliasKey = (await resolveWorkspaceDestination({ productId: product.id, channel, marketplace: market, accountId: resolved.account.id, listingId: String(args.listingId) })).aliasKey ?? ''
    } catch (error) {
      const sentence = personError(error)
      if (sentence === null) throw error
      return { error: `${product.sku} on ${name} ${market}: ${sentence}` }
    }
  }
  return { product, channel, market, account: resolved.account, aliasKey,
    scope: { channel, marketplace: market, accountId: resolved.account.id, ...(args.listingId ? { listingId: String(args.listingId) } : {}) } }
}
type Destination = Exclude<Awaited<ReturnType<typeof publishDestination>>, { error: string }>

/** The Shopify location a publish uses: the one named (it must be the store's), else the store's only one. */
function locationFor(review: StudioPublishReview, named: string | undefined): { location: string | null; error?: string } {
  const locations = review.locations ?? []
  if (named) return locations.some((l) => l.id === named) ? { location: named } : { location: null, error: 'This Shopify store has no such location: publish-review lists its locations.' }
  if (locations.length === 1) return { location: locations[0].id }
  return { location: null, error: locations.length ? `This Shopify store has ${locations.length} locations: name one (location).` : 'This Shopify store has no active inventory location.' }
}

/** The full plan of a publish from one review: what is sent, the guards, the Shopify location and the fingerprint. */
async function publishPlanFor(d: Destination, review: StudioPublishReview, fields: Fields, named: string | undefined) {
  const plan = planPublish(review, d.channel, fields)
  const guards = !plan.refusal && d.channel === 'AMAZON' ? await amazonGuards(plan, d.market, d.account.id, d.aliasKey) : { refusal: null, euQuantity: [] as EuQuantity[] }
  const shop = d.channel === 'SHOPIFY' && !plan.refusal ? locationFor(review, named) : { location: null }
  const refusal = plan.refusal ?? guards.refusal ?? shop.error ?? null
  const destination = { channel: d.channel, marketplace: d.market, accountId: d.account.id, accountLabel: d.account.label, ...(d.scope.listingId ? { listingId: d.scope.listingId } : {}) }
  return { plan, refusal, euQuantity: guards.euQuantity, location: shop.location, destination,
    fingerprint: fingerprintOf(destination, review, plan, guards.euQuantity, shop.location) }
}

const publishListing: AgentTool = {
  name: 'publish-listing',
  title: 'Publish a listing',
  input: publishInput,
  requires: [F.productsPublish, F.listingsPublish],
  category: 'listings',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // C1 — partly: a first publish is closed again (close-listing), but the channel showed it meanwhile; a re-publish is put
  // back by publishing the previous values, not by an undo.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: {
    async current(change) {
      const after = (change.after ?? {}) as { listingIds?: string[] } & Record<string, unknown>
      const { closedState } = await import('../../listings/listing-close.service.js')
      const states = await closedState(after.listingIds ?? [])
      return { ...after, closed: states.some((s) => s.closed) }
    },
    request(change) {
      const after = (change.after ?? {}) as { publish?: string; listingIds?: string[] }
      if (after.publish !== 'first publish') return { refusal: 'A re-publish is put back by publishing the previous values (they are in this change), not by closing the listing.' }
      if (!after.listingIds?.length) return { refusal: 'This publish names no listing to close.' }
      return { tool: 'close-listing', args: { listingIds: after.listingIds, reason: 'undo of a publish' } }
    },
  },
  description:
    'Publish one product family to one channel, market and account through the Nexus product studio, as the person who '
    + 'approves it: a draft\'s first publish (the complete listing) or a re-publish of the field groups named (fields: '
    + '"all", "photos" or title, description, bullets, keywords, photos, attributes). A first publish creates the listing with '
    + 'its price, quantity and (Amazon) fulfilment method from what Nexus holds: set them first. A re-publish never sends '
    + 'stock, price or fulfilment (set-listing-stock, set-listing-price). Amazon: a live listing\'s photos usually go through '
    + 'the photo review in Nexus (Images or Media page). Its preview is the studio\'s review: what is sent, what it replaces on the channel, what is not '
    + 'sent and why. Refused: Etsy (no publisher yet), an existing Shopify product (its store fields go through set-shopify-content, '
    + 'and a person sends them with Review and synchronize in Nexus), anything the review blocks, an FBA '
    + 'quantity, and an Amazon EU first publish whose quantity differs from the SKU\'s other live EU markets (Amazon '
    + 'keeps one EU quantity). Waits for a person to approve it in Nexus; if the review changed since, nothing is sent.',
  async handler(args) {
    const d = await publishDestination(args)
    if ('error' in d) return { ok: false, error: d.error! }
    let review: StudioPublishReview
    try {
      review = await (await studio()).reviewStudioPublication(d.product.id, d.scope)
    } catch (error) {
      const sentence = personError(error)
      if (sentence === null) throw error
      return { ok: false, error: `${d.product.sku} on ${channelLabel(d.channel)} ${d.market}: ${sentence}` }
    }
    const fields = (args.fields ?? 'all') as Fields
    const built = await publishPlanFor(d, review, fields, args.location as string | undefined)
    if (built.refusal) return { ok: false, error: `${d.product.sku} on ${channelLabel(d.channel)} ${d.market}: ${built.refusal} Nothing was queued.` }
    const { plan } = built
    const story = publishStory(d, review, plan, built.euQuantity.length > 0)
    return {
      ok: true,
      preview: {
        action: 'publish-listing',
        productId: d.product.id,
        sku: d.product.sku,
        destination: built.destination,
        // N4 — in words, for Claude and the approver: what this creates or sends, how new listings start, what stays.
        summary: story.summary,
        ...(story.creates.length ? { creates: story.creates } : {}),
        ...(story.held.length ? { held: story.held } : {}),
        ...(story.warning ? { warning: story.warning } : {}),
        publish: plan.publish,
        publishMode: review.mode,
        fields,
        sendCount: plan.selected.length,
        send: plan.selected.slice(0, 40).map((c) => ({ sku: c.sku, field: c.field, label: c.label, status: c.status, nexus: valueText(c.current), channel: valueText(c.channel) })),
        ...(plan.selected.length > 40 ? { moreSent: plan.selected.length - 40 } : {}),
        ...(plan.notSent.length ? { notSent: plan.notSent.slice(0, 20).map((n) => ({ ...n, reason: clip(n.reason) })), notSentCount: plan.notSent.length } : {}),
        ...(plan.unchanged ? { unchanged: plan.unchanged } : {}),
        ...(d.channel === 'SHOPIFY' ? { products: review.rows.map((r) => r.sku).slice(0, 60), visibility: review.visibility ?? null, location: built.location } : {}),
        ...(built.euQuantity.length ? { euQuantity: built.euQuantity } : {}),
        ...(review.issues.some((i) => i.severity === 'warning') ? { warnings: review.issues.filter((i) => i.severity === 'warning').slice(0, 10).map((i) => clip(i.message)) } : {}),
        fingerprint: built.fingerprint,
        note: 'Runs the studio publish as the person who approves it. If the studio\'s review differs from this one by then, nothing is sent.'
          + (d.channel === 'EBAY' && review.action === 'create' ? ' eBay checks a new listing itself first; if eBay refuses it, nothing is sent and eBay\'s reason is given.' : ''),
      },
    }
  },
  async execute(args, ctx) {
    const d = await publishDestination(args)
    if ('error' in d) return { ok: false, error: d.error! }
    const approved = ctx.approvedPreview as { fingerprint?: unknown } | undefined
    if (typeof approved?.fingerprint !== 'string') return { ok: false, error: 'A publish runs only after a person approved its preview. Nothing was sent.' }
    const where = `${d.product.sku} on ${channelLabel(d.channel)} ${d.market}`
    const userId = ctx.userId ?? null
    const fields = (args.fields ?? 'all') as Fields
    try {
      // The studio's own durable review, as the approver: what the selection and the submit are bound to. It runs eBay's
      // own check of a new eBay listing (VerifyAddFixedPriceItem, creates nothing) exactly as the studio's Review does; an
      // error there blocks the plan below, so the run refuses with eBay's words and nothing is sent. The read tools and
      // this tool's preview never make that live call.
      const review = await (await studio()).previewStudioPublication(d.product.id, d.scope, userId)
      const built = await publishPlanFor(d, review, fields, args.location as string | undefined)
      if (built.refusal) return { ok: false, error: `${where}: ${built.refusal} Nothing was sent.` }
      if (!review.id) return { ok: false, error: `${where}: the studio would not keep this review. Nothing was sent.` }
      if (built.fingerprint !== approved.fingerprint) {
        return { ok: false, error: `${where}: the studio's review changed since it was approved (the channel or Nexus moved). Nothing was sent; ask Claude for a fresh publish.` }
      }
      const sparse = d.channel === 'AMAZON' || d.channel === 'EBAY'
      const selection = sparse
        ? await (await studio()).previewStudioPublicationSelection(d.product.id, review.id, { selectedIds: built.plan.selected.map((c) => c.id) }, userId)
        : null
      const result: StudioPublishResult = await (await studio()).submitStudioPublication(d.product.id, review.id, {
        ...(selection ? { selectionToken: selection.token } : {}),
        ...(built.location ? { locationId: built.location } : {}),
        ...(!sparse && review.overwrite?.requiresConfirmation ? { confirmOverwrite: true } : {}),
      }, userId)
      // Refused before anything was sent (a preflight the studio stopped): the approval waits again, with the reason.
      if (result.status === 'FAILED' && result.message.startsWith('Nothing was submitted')) return { ok: false, error: `${where}: ${result.message}` }
      const fieldsSent = built.plan.selected.map((c) => ({ id: c.id, sku: c.sku, field: c.field }))
      // The listings this publication is about, at its destination (the resolved listing: the main one or that alias): what
      // close-listing would close (its undo).
      const listingIds = (await prisma.channelListing.findMany({ where: { productId: { in: review.rows.map((r) => r.productId) }, channel: d.channel, marketplace: d.market,
        channelConnectionId: d.account.id, aliasKey: d.aliasKey }, select: { id: true }, orderBy: { id: 'asc' } })).map((l) => l.id)
      return {
        ok: true,
        data: { publicationId: review.id, status: result.status, message: clip(result.message, 600), publish: built.plan.publish, destination: built.destination,
          results: result.results.slice(0, RESULT_CAP).map((r) => ({ sku: r.sku, status: r.status, message: clip(r.message) })) },
        // C1 — what it published: the channel's values it replaced and the Nexus values it sent, per field, and the
        // publication that carries it (publication-status reads it; close-listing will be its inverse).
        change: {
          before: { productId: d.product.id, sku: d.product.sku, destination: built.destination, publish: built.plan.publish, status: result.status,
            fields: built.plan.selected.map((c, i) => ({ ...fieldsSent[i], channel: valueText(c.channel), nexus: valueText(c.current) })) },
          after: { productId: d.product.id, destination: built.destination, publicationId: review.id, publish: built.plan.publish, listingIds, closed: false },
        },
      }
    } catch (error) {
      const sentence = personError(error)
      if (sentence === null) throw error
      return { ok: false, error: `${where}: ${sentence}` }
    }
  },
}

export const PUBLISH_TOOLS: AgentTool[] = [publishReview, publicationStatus, publishListing]
