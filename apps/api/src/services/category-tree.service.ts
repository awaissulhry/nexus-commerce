/**
 * PIM Category taxonomy service — closure-table operations.
 *
 * Backs the net-new internal category tree (Category + CategoryClosure +
 * ProductCategory). The closure table is maintained by hand here because
 * Prisma's query builder can't express the self-joins a closure table
 * needs; the create/move paths use parameterized raw SQL inside a single
 * transaction so the node row and its closure rows never diverge.
 *
 * Invariants this service guarantees:
 *   • Every node has a self-row (ancestorId = descendantId, depth 0).
 *   • For a node N under parent P, the closure holds (A, N, d+1) for every
 *     (A, P, d) — i.e. all of P's ancestors reach N one hop deeper.
 *   • Category.depth mirrors the longest (== only) root→node path length.
 *
 * Product assignment emits a PRODUCT_UPDATED ProductEvent so the existing
 * CDC fan-out (read-cache + search-index) recomputes the product's
 * category facets. We reuse the single enqueue point in
 * product-event.service.ts rather than touching the cache directly.
 */

import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { productEventService, type EventSource } from './product-event.service.js'

/** Thrown for operator-correctable conditions; routes map .status → HTTP. */
export class CategoryTreeError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'CategoryTreeError'
    this.status = status
  }
}

export interface CreateCategoryInput {
  parentId?: string | null
  slug: string
  code?: string | null
  name?: Prisma.InputJsonValue
  description?: Prisma.InputJsonValue
  attributes?: Prisma.InputJsonValue
  sortOrder?: number
  isActive?: boolean
}

export interface UpdateCategoryInput {
  slug?: string
  code?: string | null
  name?: Prisma.InputJsonValue
  description?: Prisma.InputJsonValue
  attributes?: Prisma.InputJsonValue
  sortOrder?: number
  isActive?: boolean
}

type CategoryNode = {
  id: string
  parentId: string | null
  slug: string
  code: string | null
  sortOrder: number
  isActive: boolean
  depth: number
  name: unknown
  children: CategoryNode[]
}

export class CategoryTreeService {
  // ── Reads ────────────────────────────────────────────────────────────

  /** Full tree as nested nodes, sorted by (depth, sortOrder, slug). */
  async tree(opts: { activeOnly?: boolean } = {}): Promise<CategoryNode[]> {
    const rows = await prisma.category.findMany({
      where: opts.activeOnly ? { isActive: true } : undefined,
      orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { slug: 'asc' }],
      select: {
        id: true,
        parentId: true,
        slug: true,
        code: true,
        sortOrder: true,
        isActive: true,
        depth: true,
        name: true,
      },
    })
    const byId = new Map<string, CategoryNode>()
    const roots: CategoryNode[] = []
    for (const r of rows) byId.set(r.id, { ...r, children: [] })
    // rows are depth-asc, so every parent is seen before its children.
    for (const r of rows) {
      const node = byId.get(r.id)!
      if (r.parentId && byId.has(r.parentId)) {
        byId.get(r.parentId)!.children.push(node)
      } else {
        roots.push(node)
      }
    }
    return roots
  }

  /** Ancestor chain of a node, root→leaf (includes the node itself). */
  async breadcrumb(categoryId: string) {
    const rows = await prisma.categoryClosure.findMany({
      where: { descendantId: categoryId },
      orderBy: { depth: 'desc' },
      select: {
        depth: true,
        ancestor: {
          select: { id: true, slug: true, name: true, code: true },
        },
      },
    })
    return rows.map((r) => ({ ...r.ancestor, depthFromLeaf: r.depth }))
  }

  /** All descendant category ids (includes self). */
  async descendantIds(categoryId: string): Promise<string[]> {
    const rows = await prisma.categoryClosure.findMany({
      where: { ancestorId: categoryId },
      select: { descendantId: true },
    })
    return rows.map((r) => r.descendantId)
  }

  // ── Writes ───────────────────────────────────────────────────────────

  async create(input: CreateCategoryInput) {
    const parentId = input.parentId ?? null
    let parentDepth = -1
    if (parentId) {
      const parent = await prisma.category.findUnique({
        where: { id: parentId },
        select: { depth: true },
      })
      if (!parent) throw new CategoryTreeError('Parent category not found', 404)
      parentDepth = parent.depth
    }
    const depth = parentDepth + 1

    return prisma.$transaction(async (tx) => {
      const node = await tx.category.create({
        data: {
          parentId,
          slug: input.slug,
          code: input.code ?? null,
          name: input.name ?? { en: {}, it: {} },
          description: input.description ?? Prisma.JsonNull,
          attributes: input.attributes ?? Prisma.JsonNull,
          sortOrder: input.sortOrder ?? 0,
          isActive: input.isActive ?? true,
          depth,
        },
      })
      // Self-row + inherit parent's ancestor rows one hop deeper. If
      // parentId is null the SELECT matches nothing, leaving only self.
      await tx.$executeRaw`
        INSERT INTO "CategoryClosure" ("ancestorId", "descendantId", "depth")
        SELECT "ancestorId", ${node.id}, "depth" + 1
          FROM "CategoryClosure" WHERE "descendantId" = ${parentId}
        UNION ALL SELECT ${node.id}, ${node.id}, 0
      `
      return node
    })
  }

  async update(categoryId: string, patch: UpdateCategoryInput) {
    const exists = await prisma.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    })
    if (!exists) throw new CategoryTreeError('Category not found', 404)
    return prisma.category.update({
      where: { id: categoryId },
      data: {
        ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
        ...(patch.code !== undefined ? { code: patch.code } : {}),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description }
          : {}),
        ...(patch.attributes !== undefined
          ? { attributes: patch.attributes }
          : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
    })
  }

  /**
   * Re-parent a node (and its whole subtree). Standard closure-table move:
   *   1. Sever links from the node's OLD ancestors to its subtree.
   *   2. Graft links from the NEW ancestors (incl. the new parent) to the
   *      subtree, at the correct combined depth.
   *   3. Recompute depth on the moved subtree + update Category.parentId.
   */
  async move(categoryId: string, newParentId: string | null) {
    if (categoryId === newParentId) {
      throw new CategoryTreeError('A category cannot be its own parent')
    }
    const node = await prisma.category.findUnique({
      where: { id: categoryId },
      select: { id: true, parentId: true },
    })
    if (!node) throw new CategoryTreeError('Category not found', 404)

    let newParentDepth = -1
    if (newParentId) {
      const parent = await prisma.category.findUnique({
        where: { id: newParentId },
        select: { depth: true },
      })
      if (!parent) throw new CategoryTreeError('New parent not found', 404)
      // Cycle guard: new parent must not be the node or one of its descendants.
      const descendants = await this.descendantIds(categoryId)
      if (descendants.includes(newParentId)) {
        throw new CategoryTreeError(
          'Cannot move a category beneath its own descendant',
        )
      }
      newParentDepth = parent.depth
    }

    await prisma.$transaction(async (tx) => {
      // 1. Sever old cross-boundary links (old ancestors → subtree).
      await tx.$executeRaw`
        DELETE FROM "CategoryClosure"
        WHERE "descendantId" IN (
          SELECT "descendantId" FROM "CategoryClosure" WHERE "ancestorId" = ${categoryId}
        )
        AND "ancestorId" IN (
          SELECT "ancestorId" FROM "CategoryClosure"
          WHERE "descendantId" = ${categoryId} AND "ancestorId" <> ${categoryId}
        )
      `
      // 2. Graft new ancestor links (only when re-parenting under a node).
      if (newParentId) {
        await tx.$executeRaw`
          INSERT INTO "CategoryClosure" ("ancestorId", "descendantId", "depth")
          SELECT super."ancestorId", sub."descendantId", super."depth" + sub."depth" + 1
          FROM "CategoryClosure" super
          CROSS JOIN "CategoryClosure" sub
          WHERE super."descendantId" = ${newParentId}
            AND sub."ancestorId" = ${categoryId}
        `
      }
      // 3. Recompute depth across the moved subtree. Each subtree node's
      //    new depth = (newParentDepth + 1) + its depth relative to the
      //    moved node.
      const base = newParentDepth + 1
      await tx.$executeRaw`
        UPDATE "Category" c
        SET "depth" = ${base} + sub."depth"
        FROM "CategoryClosure" sub
        WHERE sub."ancestorId" = ${categoryId} AND sub."descendantId" = c."id"
      `
      await tx.category.update({
        where: { id: categoryId },
        data: { parentId: newParentId },
      })
    })
  }

  /**
   * Delete a category. Children are blocked by the parentId Restrict FK.
   * We additionally refuse if products are still assigned (their
   * ProductCategory rows would otherwise cascade-delete silently).
   */
  async remove(categoryId: string) {
    const node = await prisma.category.findUnique({
      where: { id: categoryId },
      select: {
        id: true,
        _count: { select: { children: true, products: true } },
      },
    })
    if (!node) throw new CategoryTreeError('Category not found', 404)
    if (node._count.children > 0) {
      throw new CategoryTreeError(
        'Category has child categories — move or delete them first',
        409,
      )
    }
    if (node._count.products > 0) {
      throw new CategoryTreeError(
        `Category has ${node._count.products} assigned product(s) — reassign them first`,
        409,
      )
    }
    // Closure rows (self + the single parent link) cascade on delete.
    await prisma.category.delete({ where: { id: categoryId } })
  }

  // ── Product membership ────────────────────────────────────────────────

  /**
   * Replace a product's category membership set. `primaryId` (if given)
   * must be one of `categoryIds`; otherwise the first id wins. Emits a
   * PRODUCT_UPDATED event so the CDC pipeline recomputes facets.
   */
  async assign(
    productId: string,
    categoryIds: string[],
    opts: { primaryId?: string | null; source?: EventSource; userId?: string | null } = {},
  ) {
    const unique = Array.from(new Set(categoryIds))
    if (unique.length === 0) {
      throw new CategoryTreeError('At least one categoryId is required')
    }
    const found = await prisma.category.count({
      where: { id: { in: unique } },
    })
    if (found !== unique.length) {
      throw new CategoryTreeError('One or more categories do not exist', 404)
    }
    const primaryId =
      opts.primaryId && unique.includes(opts.primaryId)
        ? opts.primaryId
        : unique[0]

    await prisma.$transaction(async (tx) => {
      await tx.productCategory.deleteMany({ where: { productId } })
      await tx.productCategory.createMany({
        data: unique.map((categoryId) => ({
          productId,
          categoryId,
          isPrimary: categoryId === primaryId,
        })),
      })
    })

    await productEventService.emit({
      aggregateId: productId,
      aggregateType: 'Product',
      eventType: 'PRODUCT_UPDATED',
      data: { categories: unique, primaryCategoryId: primaryId },
      metadata: { source: opts.source ?? 'OPERATOR', userId: opts.userId ?? null },
    })

    return { productId, categoryIds: unique, primaryCategoryId: primaryId }
  }

  /** Remove a single membership. Emits PRODUCT_UPDATED. */
  async unassign(
    productId: string,
    categoryId: string,
    opts: { source?: EventSource; userId?: string | null } = {},
  ) {
    const deleted = await prisma.productCategory.deleteMany({
      where: { productId, categoryId },
    })
    if (deleted.count === 0) return { productId, categoryId, removed: false }

    // If we removed the primary, promote the lowest-id remaining membership.
    const remaining = await prisma.productCategory.findMany({
      where: { productId },
      orderBy: { categoryId: 'asc' },
      select: { categoryId: true, isPrimary: true },
    })
    if (remaining.length > 0 && !remaining.some((r) => r.isPrimary)) {
      await prisma.productCategory.update({
        where: {
          productId_categoryId: { productId, categoryId: remaining[0].categoryId },
        },
        data: { isPrimary: true },
      })
    }

    await productEventService.emit({
      aggregateId: productId,
      aggregateType: 'Product',
      eventType: 'PRODUCT_UPDATED',
      data: { unassignedCategory: categoryId },
      metadata: { source: opts.source ?? 'OPERATOR', userId: opts.userId ?? null },
    })

    return { productId, categoryId, removed: true }
  }
}

export const categoryTreeService = new CategoryTreeService()
