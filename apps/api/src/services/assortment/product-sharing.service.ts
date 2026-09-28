/**
 * Sharing studio step 2 — one product's sharing, for the product studio's "Other businesses" page, and the
 * products grid's Source column (plan docs/2026-09-28-sharing-review-and-plan.md §5, step 2).
 *
 * Both sides of the wall, each read through its own row security, never through the other business's products:
 *   following  this business's product follows a product of another business (its CatalogLink, read as the
 *              follower), with every followed field's state now (sync.service.ts catalogLinkState).
 *   sharedOut  this business offers the product: the assortments that hold it (a variation through its parent,
 *              as nexus_assortment_share_product_ids decides), the businesses they are offered to, and each
 *              business's copy — its link, read through the owner's read policy.
 *   stock      the stock the product sells from (its own, or a lent pool), and the businesses selling from this
 *              business's stock of it.
 */
import prisma from '../../db.js'
import { WorkspaceError, requireWorkspace } from '../../lib/workspace-context.js'
import { getSheetColumns } from '../pim/sheet-columns.service.js'
import { lentUsage, type LentUsage } from '../stock-pool/lent-usage.js'
import { loadPoolSources, summarizePoolSources } from '../stock-pool/pool-sources.js'
import { addMembers, removeMembers, type Selection } from './assortment.service.js'
import { OPEN_STATUSES } from './share-rules.js'
import { MEDIA_KEY, SKU_KEY, catalogLinkState, type LinkStateView } from './sync.service.js'

const MANAGED_LABELS: Record<string, string> = {
  'managed:productType': 'Product type', 'managed:basePrice': 'Price', 'managed:minPrice': 'Minimum price', 'managed:maxPrice': 'Maximum price',
  'managed:b2bPrice': 'B2B price', 'managed:b2bMinQty': 'B2B minimum quantity', 'managed:status': 'Status',
}

export interface SharedField {
  key: string
  label: string
  /** The field's group on the product sheet, or "Product" for the fields the sheet does not list. */
  group: string
  /** The language of a translated field, or null. */
  locale: string | null
  state: 'follow' | 'override'
}

export interface ShareCopy {
  shareId: string
  assortmentId: string
  assortmentName: string
  businessId: string
  businessName: string
  /** The share's state: pending (offered, not answered), active, paused. */
  shareStatus: string
  /**
   * The other business's copy of this product: `following` (a live link), `detached` (it followed, then stopped;
   * it keeps its copy as its own) or `not-copied` (offered, but no copy has linked it yet).
   */
  copy: 'following' | 'detached' | 'not-copied'
  heldSku: string | null
  heldReason: string | null
  lastSyncedAt: Date | null
  lastSyncError: string | null
  detachedReason: string | null
}

export interface AssortmentPlace {
  id: string
  name: string
  selection: Selection
  version: number
  /** Whether the assortment holds the product now (its main product, for a variation). */
  holds: boolean
  /** Open shares of the assortment: taking the product out stops those businesses following it. */
  openShares: number
}

export interface ProductSharingView {
  product: { id: string; sku: string; rootId: string; rootSku: string; isVariation: boolean }
  following: { link: NonNullable<LinkStateView['link']>; fields: SharedField[] } | null
  sharedOut: { assortments: AssortmentPlace[]; businesses: ShareCopy[] }
  stock: {
    source: { kind: 'own' } | { kind: 'pool'; lenderName: string; available: number; products: number }
    lentTo: LentUsage[]
  }
}

/** The product in this business and its main product (the one assortments hold). */
async function productOf(productId: string) {
  const { workspaceId } = requireWorkspace()
  const product = await prisma.product.findFirst({
    where: { id: productId, workspaceId, deletedAt: null },
    select: { id: true, sku: true, parentId: true, familyId: true, parent: { select: { id: true, sku: true, familyId: true } } },
  })
  if (!product) throw new WorkspaceError('product_not_found', 'This product is unavailable in this business profile.', 404)
  return product
}

export async function productSharing(productId: string): Promise<ProductSharingView> {
  const { workspaceId } = requireWorkspace()
  const product = await productOf(productId)
  const root = product.parent ?? { id: product.id, sku: product.sku, familyId: product.familyId }
  const family = [root.id, ...(await prisma.product.findMany({ where: { parentId: root.id, deletedAt: null }, select: { id: true } })).map((p) => p.id)]

  const [state, assortments, members, pools, lent] = await Promise.all([
    catalogLinkState(product.id),
    prisma.assortment.findMany({
      where: { workspaceId, archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, selection: true, version: true, shares: { where: { status: { in: [...OPEN_STATUSES] } }, select: { id: true, status: true, workspaceId: true, workspace: { select: { name: true } } } } },
    }),
    prisma.assortmentMember.findMany({ where: { workspaceId, productId: root.id }, select: { assortmentId: true, mode: true } }),
    loadPoolSources(prisma, family),
    lentUsage(prisma, product.parentId ? [product.id] : family),
  ])

  // ── following ──
  const following = state.link ? { link: state.link, fields: await labelled(state.fields, product.familyId ?? root.familyId, state.link) } : null

  // ── shared out ──
  const modeOf = new Map(members.map((m) => [m.assortmentId, m.mode]))
  const places: AssortmentPlace[] = assortments.map((a) => ({
    id: a.id, name: a.name, selection: a.selection as Selection, version: a.version,
    holds: a.selection === 'list' ? modeOf.get(a.id) === 'include' : modeOf.get(a.id) !== 'exclude',
    openShares: a.shares.length,
  }))
  const offered = assortments.filter((a) => places.find((p) => p.id === a.id)!.holds).flatMap((a) => a.shares.map((share) => ({ share, assortment: a })))
  const links = offered.length ? await prisma.catalogLink.findMany({
    where: { sourceWorkspaceId: workspaceId, sourceProductId: product.id, shareId: { in: offered.map((o) => o.share.id) } },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    select: { shareId: true, status: true, heldSku: true, heldReason: true, lastSyncedAt: true, lastSyncError: true, detachedReason: true },
  }) : []
  const businesses: ShareCopy[] = offered.map(({ share, assortment }): ShareCopy => {
    // 'active' sorts before 'detached': the first link of a share is its live one, when there is one.
    const link = links.find((l) => l.shareId === share.id)
    return {
      shareId: share.id, assortmentId: assortment.id, assortmentName: assortment.name, businessId: share.workspaceId, businessName: share.workspace.name,
      shareStatus: share.status,
      copy: !link ? 'not-copied' : link.status === 'active' ? 'following' : 'detached',
      heldSku: link?.heldSku ?? null, heldReason: link?.heldReason ?? null, lastSyncedAt: link?.lastSyncedAt ?? null,
      lastSyncError: link?.lastSyncError ?? null, detachedReason: link?.status === 'active' ? null : link?.detachedReason ?? null,
    }
  }).sort((a, b) => a.businessName.localeCompare(b.businessName) || a.assortmentName.localeCompare(b.assortmentName))

  // ── stock ──
  const own = pools.get(product.id)
  const summary = own ? { ...own, products: 1 } : product.parentId ? null : summarizePoolSources(family.filter((id) => id !== root.id), pools)
  return {
    product: { id: product.id, sku: product.sku, rootId: root.id, rootSku: root.sku, isVariation: !!product.parentId },
    following,
    sharedOut: { assortments: places, businesses },
    stock: {
      source: summary ? { kind: 'pool', lenderName: summary.lenderName, available: summary.available, products: summary.products ?? 1 } : { kind: 'own' },
      lentTo: lent.usage,
    },
  }
}

/** Each followed field in words: the product sheet's own label and group, and the language of a translated field. */
async function labelled(fields: LinkStateView['fields'], familyId: string | null, link: { id: string }): Promise<SharedField[]> {
  const syncMarket = (await prisma.catalogLink.findFirst({ where: { id: link.id }, select: { syncMarket: true } }))?.syncMarket ?? 'GLOBAL'
  const columns = fields.length
    ? await getSheetColumns({ market: syncMarket, allowUnknownMarket: true, familyIds: familyId ? [familyId] : [], productTypes: [], scopeKind: 'master', includeEmptyChannels: true })
      .then((set) => set.columns, () => [])
    : []
  const byKey = new Map(columns.map((column) => [column.key, column]))
  return fields.map(({ key, state }) => {
    const [base, locale] = key.split('@') as [string, string | undefined]
    const column = byKey.get(base)
    const label = key === SKU_KEY ? 'SKU' : key === MEDIA_KEY ? 'Photos' : MANAGED_LABELS[key] ?? column?.label ?? words(base)
    const group = key === SKU_KEY || key.startsWith('managed:') ? 'Product' : key === MEDIA_KEY ? 'Media' : column?.group ?? 'Product'
    return { key, label, group, locale: locale ?? null, state }
  }).sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label) || (a.locale ?? '').localeCompare(b.locale ?? ''))
}

/** A key the sheet does not list, in words: `categoryIds` → "Category ids", `attr_fabric` → "Fabric". */
function words(key: string): string {
  const plain = key.replace(/^attr_/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase()
  return plain ? plain.charAt(0).toUpperCase() + plain.slice(1) : key
}

/**
 * Put the product into an assortment, or take it out. The assortment's own rule decides the write: a list holds the
 * products it includes; "every product" holds every product it does not exclude. A variation is shared with its main
 * product, so the main product is the one written.
 */
export async function setProductInAssortment(assortmentId: string, input: { productId?: unknown; holds?: unknown; expectedVersion?: unknown }): Promise<{ holds: boolean; version: number }> {
  if (typeof input.productId !== 'string' || !input.productId) throw new WorkspaceError('invalid_product', 'Name the product.', 400)
  if (typeof input.holds !== 'boolean') throw new WorkspaceError('invalid_choice', 'Say whether the assortment holds the product.', 400)
  const { workspaceId } = requireWorkspace()
  const product = await productOf(input.productId)
  const rootId = product.parent?.id ?? product.id
  const assortment = await prisma.assortment.findFirst({ where: { id: assortmentId, workspaceId }, select: { selection: true } })
  if (!assortment) throw new WorkspaceError('assortment_not_found', 'This assortment is unavailable in this business profile.', 404)
  // "list": a member is an include. "all": a member is an exclude — so holding the product removes its member.
  const addMember = assortment.selection === 'list' ? input.holds : !input.holds
  const written = addMember
    ? await addMembers(assortmentId, { productIds: [rootId], expectedVersion: input.expectedVersion })
    : await removeMembers(assortmentId, { productIds: [rootId], expectedVersion: input.expectedVersion })
  return { holds: input.holds, version: written.version }
}

// ── The products grid ─────────────────────────────────────────────────────────────────────────

export interface ProductSharingSummary {
  /** The business this product follows, when it follows one. */
  following: { businessName: string } | null
  /** Businesses whose copy follows this product now. */
  sharedWith: string[]
}

/** Per product on a grid page: the business it follows, and the businesses that follow it. Two queries, no loop. */
export async function sharingByProducts(productIds: string[]): Promise<Map<string, ProductSharingSummary>> {
  const out = new Map<string, ProductSharingSummary>()
  const ids = [...new Set(productIds.filter(Boolean))]
  if (!ids.length) return out
  const { workspaceId } = requireWorkspace()
  const [incoming, outgoing] = await Promise.all([
    prisma.catalogLink.findMany({ where: { targetWorkspaceId: workspaceId, targetProductId: { in: ids }, status: 'active' }, select: { targetProductId: true, sourceWorkspaceId: true } }),
    prisma.catalogLink.findMany({ where: { sourceWorkspaceId: workspaceId, sourceProductId: { in: ids }, status: 'active' }, select: { sourceProductId: true, targetWorkspaceId: true } }),
  ])
  if (!incoming.length && !outgoing.length) return out
  const businessIds = [...new Set([...incoming.map((l) => l.sourceWorkspaceId), ...outgoing.map((l) => l.targetWorkspaceId)])]
  const names = new Map((await prisma.workspace.findMany({ where: { id: { in: businessIds } }, select: { id: true, name: true } })).map((w) => [w.id, w.name]))
  const entry = (id: string) => {
    let summary = out.get(id)
    if (!summary) out.set(id, summary = { following: null, sharedWith: [] })
    return summary
  }
  for (const link of incoming) entry(link.targetProductId).following = { businessName: names.get(link.sourceWorkspaceId) ?? 'another business' }
  for (const link of outgoing) {
    const summary = entry(link.sourceProductId)
    const name = names.get(link.targetWorkspaceId) ?? 'another business'
    if (!summary.sharedWith.includes(name)) summary.sharedWith.push(name)
  }
  for (const summary of out.values()) summary.sharedWith.sort((a, b) => a.localeCompare(b))
  return out
}

export const SHARING_SOURCES = ['own', 'following', 'shared'] as const
export type SharingSource = (typeof SHARING_SOURCES)[number]

/**
 * The grid's Source filter as an id condition: `following` = products that follow another business, `shared` =
 * products another business follows, `own` = products that follow no one. Several choices are a union. Null when
 * nothing is chosen (no condition).
 */
export async function sharingSourceCondition(sources: string[]): Promise<{ id: { in: string[] } } | { id: { notIn: string[] } } | { OR: Array<Record<string, unknown>> } | null> {
  const chosen = new Set(sources.filter((s): s is SharingSource => (SHARING_SOURCES as readonly string[]).includes(s)))
  if (!chosen.size || chosen.size === SHARING_SOURCES.length) return null
  const { workspaceId } = requireWorkspace()
  const [followingIds, sharedIds] = await Promise.all([
    chosen.has('following') || chosen.has('own')
      ? prisma.catalogLink.findMany({ where: { targetWorkspaceId: workspaceId, status: 'active' }, select: { targetProductId: true } }).then((rows) => [...new Set(rows.map((r) => r.targetProductId))])
      : Promise.resolve([] as string[]),
    chosen.has('shared')
      ? prisma.catalogLink.findMany({ where: { sourceWorkspaceId: workspaceId, status: 'active' }, select: { sourceProductId: true } }).then((rows) => [...new Set(rows.map((r) => r.sourceProductId))])
      : Promise.resolve([] as string[]),
  ])
  const parts: Array<Record<string, unknown>> = []
  if (chosen.has('following')) parts.push({ id: { in: followingIds } })
  if (chosen.has('shared')) parts.push({ id: { in: sharedIds } })
  if (chosen.has('own')) parts.push({ id: { notIn: followingIds } })
  return parts.length === 1 ? parts[0] as { id: { in: string[] } } : { OR: parts }
}
