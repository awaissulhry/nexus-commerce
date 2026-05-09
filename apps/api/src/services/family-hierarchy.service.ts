/**
 * W2.4 — FamilyHierarchyService.
 *
 * Resolves the *effective* set of FamilyAttribute rows for a given
 * ProductFamily, walking the parent-family chain and applying the
 * Akeneo-strict additive inheritance rule (user-confirmed in W2.3):
 *
 *   - A child family inherits ALL parent FamilyAttribute rows.
 *   - A child can ADD new attributes its parent did not declare.
 *   - A child cannot REMOVE or DOWNGRADE a parent attribute.
 *
 * Conflict policy (parent-wins, defensive read-time behaviour):
 *
 *   The W2.5+ API will reject a write that adds a duplicate
 *   (familyId, attributeId) inherited from an ancestor. This
 *   resolver is defensive — if a duplicate ever lands in the DB
 *   (e.g., an ancestor was added AFTER the child declared the
 *   attribute), the ancestor wins. The child's row is silently
 *   ignored at read time so an operator can never accidentally
 *   downgrade a parent-required attribute by re-declaring it as
 *   optional in a child.
 *
 * Cycle detection + depth bound:
 *
 *   parentFamilyId is technically a SET NULL self-FK so a cycle
 *   shouldn't be reachable through normal CRUD, but a paranoid bound
 *   protects against schema-level oversights and makes the failure
 *   mode loud (Error) instead of an infinite loop. MAX_DEPTH=8 is
 *   roughly 2× the deepest plausible Akeneo hierarchy (3-4 levels:
 *   apparel → motorcycle apparel → motorcycle jacket → racing jacket).
 *
 * Pure vs impure split:
 *
 *   `walkFamilyChain` hits the DB. `mergeFamilyAttributes` is a pure
 *   function exported separately so the merge logic can be unit-
 *   tested in isolation (see family-hierarchy.service.test.ts).
 *
 * Wave 2 follow-up:
 *   W2.5 — Family + FamilyAttribute CRUD API; the create/update
 *          handlers MUST refuse a row whose attributeId already
 *          appears in any ancestor's effective set.
 *   W2.7 — Bulk attach-family-to-products: this service is the
 *          source of truth for "which attributes does this product
 *          need" once a family is attached.
 *  W2.12 — /products grid completeness column: per-row resolver
 *          call (cached per family) to compute "how many required
 *          attributes are filled".
 */

import type { PrismaClient } from '@prisma/client'
import prisma from '../db.js'

/** Subset of FamilyAttribute returned by the resolver. Excludes id +
 *  timestamps because at read time we only care about the contract:
 *  which attribute, required-or-not, on which channels, in what
 *  display order. */
export interface EffectiveFamilyAttribute {
  attributeId: string
  required: boolean
  channels: string[]
  sortOrder: number
  /** Provenance: 'self' = directly attached to the resolved family;
   *  any other string = familyId of the ancestor that contributed
   *  this row. Useful for the UI to show inherited-vs-own. */
  source: 'self' | string
}

/** Shape returned by the impure DB walker — used internally and by
 *  the pure merge function (so tests can construct fixtures without
 *  Prisma). */
export interface FamilyChainNode {
  id: string
  parentFamilyId: string | null
  familyAttributes: Array<{
    attributeId: string
    required: boolean
    channels: string[]
    sortOrder: number
  }>
}

const MAX_DEPTH = 8

export class FamilyHierarchyService {
  constructor(private readonly client: PrismaClient = prisma) {}

  /**
   * Resolve the effective FamilyAttribute set for a family by
   * walking its parent chain and merging additively.
   *
   * Throws if the family doesn't exist, the chain exceeds
   * MAX_DEPTH, or a cycle is detected.
   */
  async resolveEffectiveAttributes(
    familyId: string,
  ): Promise<EffectiveFamilyAttribute[]> {
    const chain = await this.walkFamilyChain(familyId)
    if (chain.length === 0) {
      throw new Error(
        `FamilyHierarchyService: family ${familyId} not found`,
      )
    }
    return mergeFamilyAttributes(chain)
  }

  /** Walks parentFamilyId from leaf → root. chain[0] is `familyId`,
   *  chain[chain.length-1] is the topmost ancestor. Bounded by
   *  MAX_DEPTH and protected against cycles. */
  async walkFamilyChain(familyId: string): Promise<FamilyChainNode[]> {
    const chain: FamilyChainNode[] = []
    const visited = new Set<string>()
    let currentId: string | null = familyId
    let depth = 0

    while (currentId && depth < MAX_DEPTH) {
      if (visited.has(currentId)) {
        throw new Error(
          `FamilyHierarchyService: cycle detected at family ${currentId}`,
        )
      }
      visited.add(currentId)

      const family = await this.client.productFamily.findUnique({
        where: { id: currentId },
        select: {
          id: true,
          parentFamilyId: true,
          familyAttributes: {
            select: {
              attributeId: true,
              required: true,
              channels: true,
              sortOrder: true,
            },
          },
        },
      })
      if (!family) break

      chain.push(family)
      currentId = family.parentFamilyId
      depth++
    }

    if (depth >= MAX_DEPTH && currentId) {
      throw new Error(
        `FamilyHierarchyService: hierarchy depth exceeded ${MAX_DEPTH} starting from ${familyId}`,
      )
    }

    return chain
  }
}

/**
 * Pure merge function — takes a leaf-to-root chain and produces the
 * effective attribute set with parent-wins conflict resolution.
 *
 * Walk order is root → leaf (reverse of the input chain). For each
 * level, attributes are added only if their attributeId hasn't been
 * seen yet. That gives parent-wins semantics: a leaf re-declaration
 * of an ancestor's attribute is silently dropped.
 *
 * Result is sorted deterministically by sortOrder, then attributeId,
 * so the same input always yields the same output (helpful for
 * caching + diff-based UI).
 */
export function mergeFamilyAttributes(
  chain: FamilyChainNode[],
): EffectiveFamilyAttribute[] {
  const seen = new Set<string>()
  const effective: EffectiveFamilyAttribute[] = []

  // Walk root → leaf so ancestors get first claim on each attributeId.
  // chain[0] is leaf (self), chain[chain.length-1] is root.
  for (let i = chain.length - 1; i >= 0; i--) {
    const family = chain[i]
    const isSelf = i === 0
    for (const fa of family.familyAttributes) {
      if (seen.has(fa.attributeId)) continue
      seen.add(fa.attributeId)
      effective.push({
        attributeId: fa.attributeId,
        required: fa.required,
        channels: [...fa.channels],
        sortOrder: fa.sortOrder,
        source: isSelf ? 'self' : family.id,
      })
    }
  }

  effective.sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
    return a.attributeId.localeCompare(b.attributeId)
  })

  return effective
}

export const familyHierarchyService = new FamilyHierarchyService()
