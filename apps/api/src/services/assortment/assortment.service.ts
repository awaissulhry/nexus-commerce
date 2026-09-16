/**
 * AE.2 — assortments: named sets of products a business may offer to another business profile.
 *
 * Plan: docs/2026-09-16-assortment-engine-plan.md §14. Nothing here reads or writes another
 * business's data; sharing is assortment-share.service.ts.
 *
 * 🔴 VISIBLE IS NOT OWNED. While a share is open, the follower can READ the offered assortment's
 * row (policy nexus_assortment_follower_read). So every lookup here filters by the business in
 * context, and every write re-checks ownership — the BP.S1c lesson: a new read policy makes rows
 * newly reachable, not only newly visible.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { WorkspaceError, requireWorkspace } from '../../lib/workspace-context.js'
import { OPEN_STATUSES } from './share-rules.js'

export const SELECTIONS = ['list', 'all'] as const
export type Selection = (typeof SELECTIONS)[number]

/** Members per request. A larger set is several requests, so no transaction holds many locks. */
export const MAX_MEMBERS_PER_REQUEST = 500

export interface AssortmentRow {
  id: string
  name: string
  description: string | null
  selection: Selection
  version: number
  memberCount: number
  openShareCount: number
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface MemberRow {
  productId: string
  sku: string
  name: string
  mode: 'include' | 'exclude'
  addedAt: Date
}

function context() {
  const { workspaceId, actorUserId } = requireWorkspace()
  return { workspaceId, actorUserId: actorUserId ?? null }
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name.length < 2 || name.length > 80) throw new WorkspaceError('invalid_name', 'Use between 2 and 80 characters for the assortment name.', 400)
  return name
}

function cleanDescription(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 500) throw new WorkspaceError('invalid_description', 'Use at most 500 characters for the description.', 400)
  return value.trim() || null
}

function expectVersion(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new WorkspaceError('version_required', 'Reload the assortment and try again: this change needs the version you are editing.', 400)
  }
  return value as number
}

/** The assortment, owned by the business in context — or a refusal that says why not. */
async function ownedAssortment(id: string, workspaceId: string) {
  const row = await prisma.assortment.findUnique({ where: { id }, select: { id: true, workspaceId: true, selection: true, version: true, archivedAt: true, name: true } })
  if (!row) throw new WorkspaceError('assortment_not_found', 'This assortment is unavailable in this business profile.', 404)
  if (row.workspaceId !== workspaceId) {
    throw new WorkspaceError('assortment_not_owned', 'This assortment is shared with your business by another profile. Only its owner can change it.', 403)
  }
  return row as typeof row & { selection: Selection }
}

/** Compare-and-swap on version: 0 rows means someone else changed it first. */
async function bumpVersion(tx: Prisma.TransactionClient, id: string, workspaceId: string, expectedVersion: number, data: Prisma.AssortmentUpdateManyMutationInput = {}) {
  const updated = await tx.assortment.updateMany({ where: { id, workspaceId, version: expectedVersion }, data: { ...data, version: { increment: 1 } } })
  if (updated.count === 0) {
    throw new WorkspaceError('assortment_changed', 'This assortment changed since you loaded it. Reload it and try again.', 409)
  }
}

function uniqueNameRefusal(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new WorkspaceError('assortment_name_taken', 'Another assortment in this business profile already has this name.', 409)
  }
  throw error
}

export async function listAssortments(options: { includeArchived?: boolean } = {}): Promise<AssortmentRow[]> {
  const { workspaceId } = context()
  const rows = await prisma.assortment.findMany({
    // workspaceId explicitly: a follower can read offered assortments, which must not appear here.
    where: { workspaceId, ...(options.includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ archivedAt: { sort: 'desc', nulls: 'first' } }, { name: 'asc' }],
    select: {
      id: true, name: true, description: true, selection: true, version: true, archivedAt: true, createdAt: true, updatedAt: true,
      _count: { select: { members: true, shares: { where: { status: { in: [...OPEN_STATUSES] } } } } },
    },
  })
  return rows.map(({ _count, ...row }) => ({
    ...row, selection: row.selection as Selection, memberCount: _count.members, openShareCount: _count.shares,
  }))
}

export async function createAssortment(input: { name?: unknown; description?: unknown; selection?: unknown }): Promise<AssortmentRow> {
  // The business comes from the column default (the context); row security refuses any other.
  const { actorUserId } = context()
  const name = cleanName(input.name)
  const description = cleanDescription(input.description)
  const selection = input.selection ?? 'list'
  if (!(SELECTIONS as readonly unknown[]).includes(selection)) {
    throw new WorkspaceError('invalid_selection', 'Choose "list" (only the products you add) or "all" (every product except the ones you add).', 400)
  }
  const row = await prisma.assortment.create({
    data: { name, description, selection: selection as Selection, createdByUserId: actorUserId },
    select: { id: true, name: true, description: true, selection: true, version: true, archivedAt: true, createdAt: true, updatedAt: true },
  }).catch(uniqueNameRefusal)
  return { ...row, selection: row.selection as Selection, memberCount: 0, openShareCount: 0 }
}

export async function updateAssortment(id: string, input: { name?: unknown; description?: unknown; expectedVersion?: unknown }): Promise<AssortmentRow> {
  const { workspaceId } = context()
  const expectedVersion = expectVersion(input.expectedVersion)
  const current = await ownedAssortment(id, workspaceId)
  if (current.archivedAt) throw new WorkspaceError('assortment_archived', 'This assortment is archived. Archived assortments cannot be changed.', 409)
  const data: Prisma.AssortmentUpdateManyMutationInput = {}
  if (input.name !== undefined) data.name = cleanName(input.name)
  if (input.description !== undefined) data.description = cleanDescription(input.description)
  if (Object.keys(data).length === 0) throw new WorkspaceError('nothing_to_change', 'Change the name or the description.', 400)
  await prisma.$transaction((tx) => bumpVersion(tx, id, workspaceId, expectedVersion, data)).catch(uniqueNameRefusal)
  return (await listAssortments({ includeArchived: true })).find((row) => row.id === id) as AssortmentRow
}

export async function archiveAssortment(id: string, input: { expectedVersion?: unknown }): Promise<AssortmentRow> {
  const { workspaceId } = context()
  const expectedVersion = expectVersion(input.expectedVersion)
  const current = await ownedAssortment(id, workspaceId)
  if (current.archivedAt) throw new WorkspaceError('assortment_archived', 'This assortment is already archived.', 409)
  await prisma.$transaction(async (tx) => {
    // The version bump locks the row first; an offer takes the same row lock (assortment-share
    // service), so an offer and an archive cannot interleave and leave an archived assortment
    // with an open share. The count therefore runs AFTER the lock, inside the transaction.
    await bumpVersion(tx, id, workspaceId, expectedVersion, { archivedAt: new Date() })
    const open = await tx.assortmentShare.count({ where: { assortmentId: id, ownerWorkspaceId: workspaceId, status: { in: [...OPEN_STATUSES] } } })
    if (open > 0) {
      throw new WorkspaceError('assortment_shared', `This assortment is offered to ${open === 1 ? 'another business profile' : `${open} business profiles`}. Revoke ${open === 1 ? 'that share' : 'those shares'} before archiving it.`, 409)
    }
  })
  return (await listAssortments({ includeArchived: true })).find((row) => row.id === id) as AssortmentRow
}

export async function listMembers(id: string, options: { cursor?: string; take?: number } = {}): Promise<{ members: MemberRow[]; nextCursor: string | null }> {
  const { workspaceId } = context()
  await ownedAssortment(id, workspaceId)
  const take = Math.min(Math.max(Number(options.take) || 100, 1), 200)
  const rows = await prisma.assortmentMember.findMany({
    where: { assortmentId: id, workspaceId },
    orderBy: { id: 'asc' },
    take: take + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: { id: true, productId: true, mode: true, createdAt: true, product: { select: { sku: true, name: true } } },
  })
  const page = rows.slice(0, take)
  return {
    members: page.map((row) => ({ productId: row.productId, sku: row.product.sku, name: row.product.name, mode: row.mode as MemberRow['mode'], addedAt: row.createdAt })),
    nextCursor: rows.length > take ? page[page.length - 1].id : null,
  }
}

function productIdList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 64)) {
    throw new WorkspaceError('invalid_products', 'Choose one or more products.', 400)
  }
  const ids = [...new Set(value as string[])]
  if (ids.length > MAX_MEMBERS_PER_REQUEST) {
    throw new WorkspaceError('too_many_products', `Add or remove at most ${MAX_MEMBERS_PER_REQUEST} products at a time.`, 400)
  }
  return ids
}

/**
 * All or nothing: if any product cannot join, nothing is added and every refused product is named
 * with its reason. A partial add would leave the operator guessing which rows landed.
 */
export async function addMembers(id: string, input: { productIds?: unknown; expectedVersion?: unknown }): Promise<{ added: number; alreadyMembers: number; version: number }> {
  const { workspaceId, actorUserId } = context()
  const productIds = productIdList(input.productIds)
  const expectedVersion = expectVersion(input.expectedVersion)
  const assortment = await ownedAssortment(id, workspaceId)
  if (assortment.archivedAt) throw new WorkspaceError('assortment_archived', 'This assortment is archived. Archived assortments cannot be changed.', 409)

  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, workspaceId },
    select: { id: true, sku: true, parentId: true, deletedAt: true },
  })
  const found = new Map(products.map((product) => [product.id, product]))
  const refused: Array<{ productId: string; reason: string }> = []
  for (const productId of productIds) {
    const product = found.get(productId)
    if (!product) refused.push({ productId, reason: 'not a product in this business profile' })
    else if (product.deletedAt) refused.push({ productId, reason: `${product.sku} is deleted` })
    else if (product.parentId) refused.push({ productId, reason: `${product.sku} is a variation; add its parent product and the variations follow it` })
  }
  if (refused.length > 0) {
    const error = new WorkspaceError('products_refused', `${refused.length} of ${productIds.length} products cannot be added: ${refused.slice(0, 5).map((r) => r.reason).join('; ')}${refused.length > 5 ? '; …' : ''}.`, 400)
    Object.assign(error, { refused })
    throw error
  }

  const mode = assortment.selection === 'list' ? 'include' : 'exclude'
  return prisma.$transaction(async (tx) => {
    await bumpVersion(tx, id, workspaceId, expectedVersion)
    const created = await tx.assortmentMember.createMany({
      data: productIds.map((productId) => ({ assortmentId: id, productId, mode, addedByUserId: actorUserId })),
      skipDuplicates: true,
    })
    return { added: created.count, alreadyMembers: productIds.length - created.count, version: expectedVersion + 1 }
  })
}

export async function removeMembers(id: string, input: { productIds?: unknown; expectedVersion?: unknown }): Promise<{ removed: number; version: number }> {
  const { workspaceId } = context()
  const productIds = productIdList(input.productIds)
  const expectedVersion = expectVersion(input.expectedVersion)
  const assortment = await ownedAssortment(id, workspaceId)
  if (assortment.archivedAt) throw new WorkspaceError('assortment_archived', 'This assortment is archived. Archived assortments cannot be changed.', 409)
  return prisma.$transaction(async (tx) => {
    await bumpVersion(tx, id, workspaceId, expectedVersion)
    const removed = await tx.assortmentMember.deleteMany({ where: { assortmentId: id, workspaceId, productId: { in: productIds } } })
    return { removed: removed.count, version: expectedVersion + 1 }
  })
}
