/**
 * MCP full control P8 — the attribute dictionary's writes in one place: attribute groups, attributes and their
 * options. attributes.routes.ts (the Attributes settings pages) and Claude's `save-attribute`
 * (agents/tools/structure-change.tools.ts) both call these, so a change is checked and written the same way whoever
 * asks for it.
 *
 * Each write has a `check…` that reads but never writes and returns the data the write will store, or throws an
 * AttributeAdminError with the status and sentence the page answers with. Claude's dry run calls the check alone; the
 * write calls the check again and stores. Moved from the route without a change in behaviour
 * (attribute-admin.service.vitest.test.ts holds every write route's answers byte for byte).
 *
 * Not here: delete of an attribute (attribute-placement.service.ts `deleteAttribute`: only what nothing uses), its
 * placement, archive and restore, and the dictionary at scale (attribute-dictionary.service.ts).
 */

import prisma from '../../db.js'
import { CODE_NOT_LOCALIZABLE, CODE_TYPES, localizableRefusalFor } from './attribute-rules.js'
import { parseAttributeRules } from '@nexus/shared/attributes'
import { OPTION_TYPES, semanticKeyRefusal } from './attribute-dictionary.service.js'

/** A refusal the page shows as it is: its HTTP status and its sentence. */
export class AttributeAdminError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'AttributeAdminError'
  }
}

const refuse = (status: number, message: string): never => {
  throw new AttributeAdminError(status, message)
}

/** P3 — `validation` must satisfy the shared contract; the refusal names each problem. `null`/absent = no rules. */
function validationRefusal(validation: unknown): string | null {
  if (validation === undefined || validation === null) return null
  const rules = parseAttributeRules(validation)
  return rules.ok ? null : `validation is invalid: ${(rules as { errors: string[] }).errors.join('; ')}`
}

export const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const CODE_RULE = 'code is required and must be lowercase snake_case (matches /^[a-z][a-z0-9_]{0,63}$/)'

export const VALID_ATTRIBUTE_TYPES = new Set([
  'text',
  'textarea',
  'number',
  'boolean',
  'select',
  'multiselect',
  'date',
  'reference',
  'asset',
])

export const VALID_SCOPES = new Set(['global', 'per_variant'])

// ── AttributeGroup ─────────────────────────────────────────────

export interface GroupInput {
  code?: string
  label?: string
  description?: string | null
  sortOrder?: number
}

/** What a new group stores, or why not. Reads nothing. */
export function checkGroupCreate(body: GroupInput) {
  if (!body.code || !CODE_PATTERN.test(body.code)) refuse(400, CODE_RULE)
  if (!body.label?.trim()) refuse(400, 'label is required')
  return {
    code: body.code!,
    label: body.label!.trim(),
    description: body.description?.trim() || null,
    sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : 0,
  }
}

export async function createAttributeGroup(body: GroupInput) {
  const data = checkGroupCreate(body)
  try {
    return await prisma.attributeGroup.create({ data })
  } catch (err: any) {
    if (err?.code === 'P2002') refuse(409, `group code "${body.code}" already exists`)
    throw err
  }
}

/** The fields a group update stores, or why not. Reads nothing (a missing group is found by the write). */
export function checkGroupUpdate(body: Omit<GroupInput, 'code'>) {
  const data: Record<string, unknown> = {}
  if (body.label !== undefined) {
    if (!body.label.trim()) refuse(400, 'label cannot be empty')
    data.label = body.label.trim()
  }
  if (body.description !== undefined) data.description = body.description?.trim() || null
  if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
  if (Object.keys(data).length === 0) refuse(400, 'no mutable fields supplied')
  return data
}

export async function updateAttributeGroup(id: string, body: Omit<GroupInput, 'code'>) {
  const data = checkGroupUpdate(body)
  try {
    return await prisma.attributeGroup.update({ where: { id }, data })
  } catch (err: any) {
    if (err?.code === 'P2025') refuse(404, 'group not found')
    throw err
  }
}

/** Delete a group. Refused while attributes are attached (RESTRICT at the database). */
export async function deleteAttributeGroup(id: string) {
  try {
    await prisma.attributeGroup.delete({ where: { id } })
    return { ok: true as const, id }
  } catch (err: any) {
    if (err?.code === 'P2025') refuse(404, 'group not found')
    // P2003 = FK constraint failed (RESTRICT — group still has
    // attributes). Surface a 409 so the UI can prompt the operator
    // to move/delete attributes first.
    if (err?.code === 'P2003') refuse(409, 'cannot delete group: attributes are still attached. Move or delete them first.')
    throw err
  }
}

// ── CustomAttribute ────────────────────────────────────────────

export interface AttributeCreateInput {
  code?: string
  label?: string
  description?: string | null
  groupId?: string
  type?: string
  validation?: unknown
  defaultValue?: unknown
  localizable?: boolean
  scope?: string
  sortOrder?: number
  semanticKey?: string | null
}

/** What a new attribute stores, or why not. Reads (the group), never writes. */
export async function checkAttributeCreate(body: AttributeCreateInput) {
  if (!body.code || !CODE_PATTERN.test(body.code)) refuse(400, CODE_RULE)
  if (!body.label?.trim()) refuse(400, 'label is required')
  if (!body.groupId) refuse(400, 'groupId is required')
  if (!body.type || !VALID_ATTRIBUTE_TYPES.has(body.type)) refuse(400, `type must be one of ${[...VALID_ATTRIBUTE_TYPES].join(', ')}`)
  if (body.scope && !VALID_SCOPES.has(body.scope)) refuse(400, `scope must be one of ${[...VALID_SCOPES].join(', ')}`)
  if (body.localizable && CODE_TYPES.has(body.type!)) refuse(400, CODE_NOT_LOCALIZABLE)
  const invalidRules = validationRefusal(body.validation)
  if (invalidRules) refuse(400, invalidRules)
  const conceptRefusal = semanticKeyRefusal(body.semanticKey)
  if (conceptRefusal) refuse(400, conceptRefusal)

  const groupExists = await prisma.attributeGroup.findUnique({
    where: { id: body.groupId! },
    select: { id: true },
  })
  if (!groupExists) refuse(400, 'groupId does not exist')

  return {
    code: body.code!,
    label: body.label!.trim(),
    description: body.description?.trim() || null,
    groupId: body.groupId!,
    type: body.type!,
    validation: (body.validation as never) ?? null,
    defaultValue: (body.defaultValue as never) ?? null,
    localizable: body.localizable ?? false,
    scope: body.scope ?? 'global',
    sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : 0,
    semanticKey: body.semanticKey ?? null,
  }
}

export async function createCustomAttribute(body: AttributeCreateInput) {
  const data = await checkAttributeCreate(body)
  try {
    return await prisma.customAttribute.create({ data })
  } catch (err: any) {
    if (err?.code === 'P2002') {
      refuse(409, String(err?.meta?.target ?? '').includes('semanticKey')
        ? `concept "${body.semanticKey}" is already linked to another attribute`
        : `attribute code "${body.code}" already exists`)
    }
    throw err
  }
}

export type AttributeUpdateInput = Omit<AttributeCreateInput, 'code' | 'type'>

/**
 * The fields an attribute update stores, or why not. Reads (the group, the stored values a per-language switch would
 * strand), never writes; a missing attribute is found by the write. `type` and `code` never change: a new type would
 * orphan stored values, and the code is the stable key families and product values use.
 */
export async function checkAttributeUpdate(id: string, body: AttributeUpdateInput) {
  const data: Record<string, unknown> = {}
  if (body.label !== undefined) {
    if (!body.label.trim()) refuse(400, 'label cannot be empty')
    data.label = body.label.trim()
  }
  if (body.description !== undefined) data.description = body.description?.trim() || null
  if (body.groupId !== undefined) {
    const exists = await prisma.attributeGroup.findUnique({
      where: { id: body.groupId },
      select: { id: true },
    })
    if (!exists) refuse(400, 'groupId does not exist')
    data.groupId = body.groupId
  }
  if (body.validation !== undefined) {
    const invalidRules = validationRefusal(body.validation)
    if (invalidRules) refuse(400, invalidRules)
    data.validation = (body.validation as never) ?? null
  }
  if (body.semanticKey !== undefined) {
    const conceptRefusal = semanticKeyRefusal(body.semanticKey)
    if (conceptRefusal) refuse(400, conceptRefusal)
    data.semanticKey = body.semanticKey
  }
  if (body.defaultValue !== undefined) data.defaultValue = (body.defaultValue as never) ?? null
  if (body.localizable === true) {
    const refusal = await localizableRefusalFor(id)
    if (refusal) refuse(400, refusal)
  }
  if (body.localizable !== undefined) data.localizable = body.localizable
  if (body.scope !== undefined) {
    if (!VALID_SCOPES.has(body.scope)) refuse(400, `scope must be one of ${[...VALID_SCOPES].join(', ')}`)
    data.scope = body.scope
  }
  if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
  if (Object.keys(data).length === 0) refuse(400, 'no mutable fields supplied')
  return data
}

export async function updateCustomAttribute(id: string, body: AttributeUpdateInput) {
  const data = await checkAttributeUpdate(id, body)
  try {
    return await prisma.customAttribute.update({ where: { id }, data })
  } catch (err: any) {
    if (err?.code === 'P2025') refuse(404, 'attribute not found')
    if (err?.code === 'P2002') refuse(409, `concept "${body.semanticKey}" is already linked to another attribute`)
    throw err
  }
}

// ── AttributeOption ────────────────────────────────────────────

export interface OptionCreateInput {
  code?: string
  label?: string
  metadata?: unknown
  sortOrder?: number
}

/** What a new option stores, or why not. Reads (the attribute), never writes. */
export async function checkOptionCreate(attrId: string, body: OptionCreateInput) {
  if (!body.code || !CODE_PATTERN.test(body.code)) refuse(400, CODE_RULE)
  if (!body.label?.trim()) refuse(400, 'label is required')
  const attr = await prisma.customAttribute.findUnique({
    where: { id: attrId },
    select: { id: true, type: true },
  })
  if (!attr) refuse(404, 'attribute not found')
  // P6 — a text attribute's options are suggestions for the open dropdown.
  if (!OPTION_TYPES.has(attr!.type)) {
    refuse(400, `attribute type "${attr!.type}" does not accept options (select, multiselect, text or textarea)`)
  }
  return {
    attributeId: attrId,
    code: body.code!,
    label: body.label!.trim(),
    metadata: (body.metadata as never) ?? null,
    sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : 0,
  }
}

export async function createAttributeOption(attrId: string, body: OptionCreateInput) {
  const data = await checkOptionCreate(attrId, body)
  try {
    return await prisma.attributeOption.create({ data })
  } catch (err: any) {
    if (err?.code === 'P2002') refuse(409, `option code "${body.code}" already exists on this attribute`)
    throw err
  }
}

export interface OptionUpdateInput {
  label?: string
  metadata?: unknown
  sortOrder?: number
  synonyms?: string[]
  archived?: boolean
}

/** The fields an option update stores, or why not. Reads nothing (a missing option is found by the write). */
export function checkOptionUpdate(body: OptionUpdateInput) {
  const data: Record<string, unknown> = {}
  if (body.label !== undefined) {
    if (!body.label.trim()) refuse(400, 'label cannot be empty')
    data.label = body.label.trim()
  }
  if (body.metadata !== undefined) data.metadata = (body.metadata as never) ?? null
  if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
  if (body.synonyms !== undefined) {
    if (!Array.isArray(body.synonyms) || body.synonyms.some(s => typeof s !== 'string' || !s.trim())) {
      refuse(400, 'synonyms must be a list of non-empty text')
    }
    data.synonyms = body.synonyms.map(s => s.trim())
  }
  // P3 — retiring keeps every stored value valid; it only stops offering the option.
  if (body.archived !== undefined) data.archivedAt = body.archived ? new Date() : null
  if (Object.keys(data).length === 0) refuse(400, 'no mutable fields supplied')
  return data
}

export async function updateAttributeOption(id: string, body: OptionUpdateInput) {
  const data = checkOptionUpdate(body)
  try {
    return await prisma.attributeOption.update({ where: { id }, data })
  } catch (err: any) {
    if (err?.code === 'P2025') refuse(404, 'option not found')
    throw err
  }
}

export async function deleteAttributeOption(id: string) {
  try {
    await prisma.attributeOption.delete({ where: { id } })
    return { ok: true as const, id }
  } catch (err: any) {
    if (err?.code === 'P2025') refuse(404, 'option not found')
    throw err
  }
}
