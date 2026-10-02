/**
 * MCP full control P8 — the product families' writes in one place: a family (code, label, description, parent) and the
 * attributes it declares. families.routes.ts (Settings › Families) and Claude's `save-product-family`
 * (agents/tools/structure-change.tools.ts) both call these, so a change is checked and written the same way whoever
 * asks for it.
 *
 * Each write has a `check…` that reads but never writes and returns what the write will store, or throws a
 * FamilyAdminError with the status, sentence (and extra fields) the page answers with. Moved from the route without a
 * change in behaviour (family-admin.service.vitest.test.ts holds every write route's answers byte for byte).
 *
 * The rules: a code is lowercase snake_case and never changes; a parent must exist, must not be the family itself and
 * must not make a cycle or a chain deeper than MAX_DEPTH; an attribute is declared once along a chain (Akeneo-strict
 * additive: a child never re-declares what an ancestor declares).
 */

import prisma from '../../db.js'
import { familyHierarchyService } from '../family-hierarchy.service.js'

export const FAMILY_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
export const FAMILY_MAX_DEPTH = 8

/** A refusal the page shows as it is: its HTTP status, its sentence and any extra fields. */
export class FamilyAdminError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'FamilyAdminError'
  }
}

const refuse = (status: number, message: string, extra: Record<string, unknown> = {}): never => {
  throw new FamilyAdminError(status, message, extra)
}

// ── ProductFamily ──────────────────────────────────────────────

export interface FamilyCreateInput {
  code?: string
  label?: string
  description?: string | null
  parentFamilyId?: string | null
}

/** What a new family stores, or why not. Reads (the parent), never writes. */
export async function checkFamilyCreate(body: FamilyCreateInput) {
  if (!body.code || !FAMILY_CODE_PATTERN.test(body.code)) {
    refuse(400, 'code is required and must be lowercase snake_case (matches /^[a-z][a-z0-9_]{0,63}$/)')
  }
  if (!body.label || !body.label.trim()) refuse(400, 'label is required')
  if (body.parentFamilyId) {
    const parent = await prisma.productFamily.findUnique({ where: { id: body.parentFamilyId }, select: { id: true } })
    if (!parent) refuse(400, 'parentFamilyId does not exist')
  }
  return {
    code: body.code!,
    label: body.label!.trim(),
    description: body.description?.trim() || null,
    parentFamilyId: body.parentFamilyId ?? null,
  }
}

export async function createProductFamily(body: FamilyCreateInput) {
  const data = await checkFamilyCreate(body)
  try {
    return await prisma.productFamily.create({ data })
  } catch (err: any) {
    if (err?.code === 'P2002') refuse(409, `family code "${body.code}" already exists`)
    throw err
  }
}

export type FamilyUpdateInput = Omit<FamilyCreateInput, 'code'>

/**
 * The fields a family update stores, or why not. Reads (the family, the candidate parent's chain), never writes.
 * Cycle-detect on parentFamilyId changes by walking the candidate's chain.
 */
export async function checkFamilyUpdate(id: string, body: FamilyUpdateInput) {
  const current = await prisma.productFamily.findUnique({ where: { id }, select: { id: true, parentFamilyId: true } })
  if (!current) refuse(404, 'family not found')

  const data: Record<string, unknown> = {}
  if (body.label !== undefined) {
    if (!body.label!.trim()) refuse(400, 'label cannot be empty')
    data.label = body.label!.trim()
  }
  if (body.description !== undefined) {
    data.description = body.description?.trim() || null
  }
  if (body.parentFamilyId !== undefined) {
    // Self-parent guard.
    if (body.parentFamilyId === id) refuse(400, 'family cannot be its own parent')
    if (body.parentFamilyId !== null) {
      // Verify candidate exists.
      const candidate = await prisma.productFamily.findUnique({ where: { id: body.parentFamilyId }, select: { id: true } })
      if (!candidate) refuse(400, 'parentFamilyId does not exist')

      // Cycle detection: walk candidate's chain; if we hit `id`, the
      // proposed reparent would create a loop.
      let cursor: string | null = body.parentFamilyId
      let depth = 0
      while (cursor && depth < FAMILY_MAX_DEPTH) {
        if (cursor === id) refuse(409, 'reparent rejected: would create a cycle in the family hierarchy')
        const next: { parentFamilyId: string | null } | null = await prisma.productFamily.findUnique({
          where: { id: cursor },
          select: { parentFamilyId: true },
        })
        cursor = next?.parentFamilyId ?? null
        depth++
      }
      if (depth >= FAMILY_MAX_DEPTH && cursor) {
        refuse(409, `reparent rejected: hierarchy depth would exceed ${FAMILY_MAX_DEPTH}`)
      }
    }
    data.parentFamilyId = body.parentFamilyId
  }

  if (Object.keys(data).length === 0) refuse(400, 'no mutable fields supplied')
  return data
}

export async function updateProductFamily(id: string, body: FamilyUpdateInput) {
  const data = await checkFamilyUpdate(id, body)
  return prisma.productFamily.update({ where: { id }, data })
}

/**
 * Drop a family. FK cascades:
 *   childFamilies.parentFamilyId → SET NULL (children become roots)
 *   Product.familyId → SET NULL (products keep their data; family detached)
 *   FamilyAttribute → CASCADE (rows deleted alongside the family)
 */
export async function deleteProductFamily(id: string) {
  try {
    await prisma.productFamily.delete({ where: { id } })
    return { ok: true as const, id }
  } catch (err: any) {
    if (err?.code === 'P2025') refuse(404, 'family not found')
    throw err
  }
}

// ── FamilyAttribute ────────────────────────────────────────────

export interface FamilyAttributeCreateInput {
  attributeId?: string
  required?: boolean
  channels?: string[]
  sortOrder?: number
}

/**
 * What attaching an attribute to a family stores, or why not. Reads (the attribute, the family's chain), never
 * writes. Refused when the attribute is already declared by this family OR by any ancestor: a child can never
 * re-declare (and thereby attempt to override) what a parent has already locked in.
 */
export async function checkFamilyAttributeCreate(familyId: string, body: FamilyAttributeCreateInput) {
  if (!body.attributeId) refuse(400, 'attributeId is required')

  const attribute = await prisma.customAttribute.findUnique({ where: { id: body.attributeId! }, select: { id: true } })
  if (!attribute) refuse(400, 'attributeId does not exist')

  let chain
  try {
    chain = await familyHierarchyService.walkFamilyChain(familyId)
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    if (/cycle|depth exceeded/i.test(msg)) refuse(409, msg)
    throw err
  }
  if (chain.length === 0) refuse(404, 'family not found')

  // Akeneo-strict additive: refuse if any ancestor (or self) already has this attributeId.
  for (const node of chain) {
    const conflict = node.familyAttributes.find((fa) => fa.attributeId === body.attributeId)
    if (conflict) {
      const isSelf = node.id === familyId
      refuse(409, isSelf
        ? 'attribute already attached to this family'
        : `attribute already inherited from ancestor family ${node.id}; child cannot redeclare it (Akeneo-strict additive invariant)`,
      { conflictFamilyId: node.id, isInherited: !isSelf })
    }
  }

  return {
    familyId,
    attributeId: body.attributeId!,
    required: body.required ?? false,
    channels: Array.isArray(body.channels) ? body.channels : [],
    sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : 0,
  }
}

export async function createFamilyAttribute(familyId: string, body: FamilyAttributeCreateInput) {
  const data = await checkFamilyAttributeCreate(familyId, body)
  return prisma.familyAttribute.create({ data })
}

export type FamilyAttributeUpdateInput = Omit<FamilyAttributeCreateInput, 'attributeId'>

/** The fields a family-attribute update stores, or why not. attributeId and familyId never change. Reads nothing. */
export function checkFamilyAttributeUpdate(body: FamilyAttributeUpdateInput) {
  const data: Record<string, unknown> = {}
  if (body.required !== undefined) data.required = body.required
  if (body.channels !== undefined) {
    if (!Array.isArray(body.channels)) refuse(400, 'channels must be an array')
    data.channels = body.channels
  }
  if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
  if (Object.keys(data).length === 0) refuse(400, 'no mutable fields supplied')
  return data
}

export async function updateFamilyAttribute(id: string, body: FamilyAttributeUpdateInput) {
  const data = checkFamilyAttributeUpdate(body)
  try {
    return await prisma.familyAttribute.update({ where: { id }, data })
  } catch (err: any) {
    if (err?.code === 'P2025') refuse(404, 'family-attribute not found')
    throw err
  }
}

/**
 * Detach an attribute from a family. Removing a parent's attribute means children stop inheriting it. Stored values on
 * products are NOT touched (the attribute itself still exists; only the family→attribute link breaks).
 */
export async function deleteFamilyAttribute(id: string) {
  try {
    await prisma.familyAttribute.delete({ where: { id } })
    return { ok: true as const, id }
  } catch (err: any) {
    if (err?.code === 'P2025') refuse(404, 'family-attribute not found')
    throw err
  }
}
