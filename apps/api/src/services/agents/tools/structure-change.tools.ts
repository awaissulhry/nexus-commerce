/**
 * MCP full control P8 — catalog structure changes Claude may ask for: attributes (and their options and groups),
 * product families, and the business's own category tree (plan section 09 §4; Owner decision P-2).
 *
 * A structure change can silently change hundreds of products (09 §3 risk 1): a required attribute makes products
 * incomplete, a family's parent changes what every product under it must carry, a category move changes what sits
 * under a branch. So each change:
 *   · is approved by a person, at most "confirm" (the person confirms in Claude with their authenticator code), never
 *     auto: `maxClaudeTrust: 'confirm'`, no limits;
 *   · says in its preview how many products (and families, categories) it touches — `impact` — next to from → to
 *     (`changes`); both are material: if either moved before it runs, the approval is handed back (MATERIAL_PREVIEW_FIELDS);
 *   · is written through the same services the settings pages use (pim/attribute-admin.service.ts,
 *     pim/family-admin.service.ts, attribute-placement.service.ts `deleteAttribute`, taxonomy/category-workspace.ts),
 *     so it is checked the same way;
 *   · records what it replaced and is undone through the same tool (`undo`): a create by removing what it created, a
 *     delete by creating it again, an update by writing the old values; refused once the row changed since.
 * A delete is offered only for what nothing uses and what an undo can put back in full; anything else is refused with
 * the reason and stays a person's click in Nexus. None of these reach a marketplace: channel mappings and listing
 * templates are save-channel-mapping and save-listing-template (mapping-change.tools.ts), always asked.
 *
 * The dry run (`handler`) reads and never writes. `execute` plans the change again in its business, refuses when a
 * fact the person approved moved (`approvedPreview`), and only then writes.
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { inDatabaseTransaction } from '../../../lib/database-context.js'
import {
  AttributeAdminError, CODE_PATTERN, VALID_ATTRIBUTE_TYPES, VALID_SCOPES, checkAttributeCreate, checkAttributeUpdate, checkGroupCreate,
  checkGroupUpdate, checkOptionCreate, checkOptionUpdate, createAttributeGroup, createAttributeOption, createCustomAttribute,
  deleteAttributeGroup, deleteAttributeOption, updateAttributeGroup, updateAttributeOption, updateCustomAttribute,
} from '../../pim/attribute-admin.service.js'
import { OPTION_TYPES } from '../../pim/attribute-dictionary.service.js'
import { attributeUsage, deleteAttribute, PlacementError } from '../../pim/attribute-placement.service.js'
import { clearAttributeSchemaCaches } from '../../pim/attribute-schema-invalidation.js'
import {
  FamilyAdminError, checkFamilyCreate, checkFamilyUpdate, createFamilyAttribute, createProductFamily, deleteFamilyAttribute,
  deleteProductFamily, updateFamilyAttribute, updateProductFamily,
} from '../../pim/family-admin.service.js'
import { chainFromNodes, mergeFamilyAttributes, type EffectiveFamilyAttribute, type FamilyChainNode } from '../../family-hierarchy.service.js'
import { familyCompletenessService } from '../../family-completeness.service.js'
import { applyCategoryCommand, categoryChangeImpact, categoryDirectory, type CategoryCommand } from '../../taxonomy/category-workspace.js'
import { categoryName } from '../../pim/mapping/category-mapping.service.js'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const ID = z.string().trim().min(1).max(64)
const CODE = z.string().trim().regex(CODE_PATTERN, 'lowercase snake_case: a letter, then letters, digits or _')
const LABEL = z.string().trim().min(1).max(120)
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const FAMILY_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY', 'WOOCOMMERCE'] as const
/** A family change measures completeness product by product; above this many products it is not measured here. */
const IMPACT_PRODUCT_LIMIT = 5000

type Data = Record<string, any>
type Planned = { error: string } | { preview: Data; write: (ctx: ToolContext) => Promise<ToolResult> }

const plural = (n: number, word: string) => `${n} ${word === 'family' ? (n === 1 ? 'family' : 'families') : word === 'category' ? (n === 1 ? 'category' : 'categories') : `${word}${n === 1 ? '' : 's'}`}`
/** "1 product carries", "2 products carry". */
const carry = (n: number, word: string) => `${plural(n, word)} ${n === 1 ? 'carries' : 'carry'}`
/** One text per value whatever the order of its keys, to compare what the person approved with a fresh plan. */
const canonical = (value: unknown) => JSON.stringify(value ?? null, (_key, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v)
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)

/** A refusal of a settings service (status + sentence), as one sentence about the row it concerns. */
function refusalOf(error: unknown, about: string): string | null {
  if (error instanceof AttributeAdminError || error instanceof FamilyAdminError || error instanceof PlacementError) return `${about}: ${error.message}`
  const status = (error as { statusCode?: unknown; status?: unknown })?.statusCode ?? (error as { status?: unknown })?.status
  if (error instanceof Error && typeof status === 'number' && status < 500) return `${about}: ${error.message}`
  return null
}

/**
 * The dry run, and the run: one plan. `execute` plans again, refuses when what the person approved (from → to and the
 * impact) moved, and then writes.
 */
function planned(plan: (args: Data) => Promise<Planned>) {
  return {
    async handler(args: Data): Promise<ToolResult> {
      const p = await plan(args)
      return 'error' in p ? { ok: false, error: p.error } : { ok: true, preview: p.preview }
    },
    async execute(args: Data, ctx: ToolContext): Promise<ToolResult> {
      const p = await plan(args)
      if ('error' in p) return { ok: false, error: p.error }
      const approved = ctx.approvedPreview as Data | undefined
      if (approved && (!same(approved.changes, p.preview.changes) || !same(approved.impact, p.preview.impact))) {
        return { ok: false, error: 'Not changed: what this change touches moved since it was approved. Ask for it again to see the new preview.' }
      }
      try {
        return await p.write(ctx)
      } catch (error) {
        const refused = refusalOf(error, 'Not changed')
        if (refused) return { ok: false, error: refused }
        throw error
      }
    },
  }
}

/** The keys of a value that a caller set (present and not undefined). */
const given = (args: Data, keys: readonly string[]) => keys.filter((key) => args[key] !== undefined)

/** Each field that differs, as from → to. */
function diff(from: Data, to: Data, keys: readonly string[]): Data {
  const out: Data = {}
  for (const key of keys) if (key in to && !same(from[key], to[key])) out[key] = { from: from[key] ?? null, to: to[key] ?? null }
  return out
}

// ── save-attribute ────────────────────────────────────────────────────────────────────────────────────

const ATTRIBUTE_FIELDS = ['label', 'description', 'groupId', 'localizable', 'scope', 'sortOrder'] as const
const OPTION_FIELDS = ['label', 'sortOrder', 'synonyms', 'archived'] as const
const GROUP_FIELDS = ['label', 'description', 'sortOrder'] as const
/** Arguments each kind takes besides its own id, `remove` and `code`; anything else is refused (named). */
const KIND_ARGS: Record<string, readonly string[]> = {
  attribute: ['attributeId', 'groupId', 'code', 'type', 'options', 'remove', ...ATTRIBUTE_FIELDS],
  option: ['attributeId', 'optionId', 'code', 'remove', ...OPTION_FIELDS],
  group: ['groupId', 'code', 'remove', ...GROUP_FIELDS],
}
const ARG_NAMES = ['attributeId', 'optionId', 'groupId', 'remove', 'code', 'label', 'description', 'type', 'localizable', 'scope', 'sortOrder', 'synonyms', 'archived', 'options']

type AttributeRow = { id: string; code: string; label: string; description: string | null; groupId: string; type: string; localizable: boolean; scope: string; sortOrder: number }

const attributeSnapshot = (a: AttributeRow) => ({
  kind: 'attribute', id: a.id, code: a.code, label: a.label, description: a.description, groupId: a.groupId, type: a.type,
  localizable: a.localizable, scope: a.scope, sortOrder: a.sortOrder,
})
const optionSnapshot = (o: { id: string; attributeId: string; code: string; label: string; sortOrder: number; synonyms: string[]; archivedAt: Date | null }) => ({
  kind: 'option', id: o.id, attributeId: o.attributeId, code: o.code, label: o.label, sortOrder: o.sortOrder, synonyms: [...o.synonyms], archived: !!o.archivedAt,
})
const groupSnapshot = (g: { id: string; code: string; label: string; description: string | null; sortOrder: number }) => ({
  kind: 'group', id: g.id, code: g.code, label: g.label, description: g.description, sortOrder: g.sortOrder,
})
const removed = (kind: string, id: string | null) => ({ kind, id, removed: true })

/** An attribute in this business that is not archived. */
const liveAttribute = (id: string) => prisma.customAttribute.findFirst({ where: { id, archivedAt: null } })

/** What is stored now for a snapshot (the shape of `change.after`), or `removed`. */
async function attributeKindSnapshot(kind: string, id: string): Promise<Data> {
  if (kind === 'attribute') {
    const a = await prisma.customAttribute.findUnique({ where: { id } })
    return a ? attributeSnapshot(a) : removed(kind, id)
  }
  if (kind === 'option') {
    const o = await prisma.attributeOption.findUnique({ where: { id } })
    return o ? optionSnapshot(o) : removed(kind, id)
  }
  const g = await prisma.attributeGroup.findUnique({ where: { id } })
  return g ? groupSnapshot(g) : removed(kind, id)
}

/** How many live products carry this option of this attribute (as the value, or in a list of values). */
async function optionUsage(attributeCode: string, optionCode: string): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "Product"
    WHERE "deletedAt" IS NULL AND jsonb_typeof("categoryAttributes") = 'object'
      AND ("categoryAttributes"->${attributeCode} = to_jsonb(${optionCode}::text)
        OR (jsonb_typeof("categoryAttributes"->${attributeCode}) = 'array' AND "categoryAttributes"->${attributeCode} @> jsonb_build_array(${optionCode}::text)))`
  return Number(row?.n ?? 0)
}

const attributeName = (a: { label: string; code: string }) => `Attribute "${a.label}" (${a.code})`

async function planAttribute(args: Data): Promise<Planned> {
  const kind = String(args.kind)
  let about = 'This change'
  try {
    // Resolve what the call names first: a row of another business, archived, or gone is simply not found.
    if (kind === 'attribute') {
      const attribute = args.attributeId ? await liveAttribute(args.attributeId) : null
      if (args.attributeId && !attribute) return { error: 'Attribute not found' }
      if (attribute) about = attributeName(attribute)
      const group = args.groupId ? await prisma.attributeGroup.findUnique({ where: { id: args.groupId } }) : null
      if (args.groupId && !group) return { error: 'Attribute group not found' }
      const stray = given(args, ARG_NAMES).filter((key) => !KIND_ARGS.attribute.includes(key))
      if (stray.length) return { error: `${about}: ${stray.join(', ')} ${stray.length === 1 ? 'is' : 'are'} not used with kind "attribute"; leave ${stray.length === 1 ? 'it' : 'them'} out.` }
      if (!attribute) return planCreateAttribute(args, group)
      return args.remove ? planRemoveAttribute(args, attribute) : planUpdateAttribute(args, attribute, group)
    }
    if (kind === 'option') {
      const option = args.optionId ? await prisma.attributeOption.findFirst({ where: { id: args.optionId, attribute: { archivedAt: null } }, include: { attribute: true } }) : null
      if (args.optionId && !option) return { error: 'Attribute option not found' }
      const attribute = args.attributeId ? await liveAttribute(args.attributeId) : null
      if (args.attributeId && !attribute) return { error: 'Attribute not found' }
      about = option ? `Option "${option.label}" (${option.code}) of ${attributeName(option.attribute)}` : attribute ? attributeName(attribute) : about
      const stray = given(args, ARG_NAMES).filter((key) => !KIND_ARGS.option.includes(key))
      if (stray.length) return { error: `${about}: ${stray.join(', ')} ${stray.length === 1 ? 'is' : 'are'} not used with kind "option"; leave ${stray.length === 1 ? 'it' : 'them'} out.` }
      if (option && attribute && attribute.id !== option.attributeId) return { error: `${about}: it belongs to another attribute than attributeId names.` }
      if (option) return args.remove ? planRemoveOption(args, option, about) : planUpdateOption(args, option, about)
      if (!attribute) return { error: 'A new option needs attributeId: the attribute it belongs to.' }
      return planCreateOption(args, attribute, about)
    }
    const group = args.groupId ? await prisma.attributeGroup.findUnique({ where: { id: args.groupId } }) : null
    if (args.groupId && !group) return { error: 'Attribute group not found' }
    if (group) about = `Attribute group "${group.label}" (${group.code})`
    const stray = given(args, ARG_NAMES).filter((key) => !KIND_ARGS.group.includes(key))
    if (stray.length) return { error: `${about}: ${stray.join(', ')} ${stray.length === 1 ? 'is' : 'are'} not used with kind "group"; leave ${stray.length === 1 ? 'it' : 'them'} out.` }
    if (!group) return planCreateGroup(args)
    return args.remove ? planRemoveGroup(args, group, about) : planUpdateGroup(args, group, about)
  } catch (error) {
    const refused = refusalOf(error, about)
    if (refused) return { error: refused }
    throw error
  }
}

const removeTakesNothing = (args: Data, about: string, keys: readonly string[]) => {
  const extra = given(args, keys)
  return extra.length ? `${about}: remove takes no other change (${extra.join(', ')}); ask for one change at a time.` : null
}

async function planCreateAttribute(args: Data, group: { id: string; label: string } | null): Promise<Planned> {
  const missing = ['code', 'label', 'groupId', 'type'].filter((key) => args[key] === undefined)
  if (missing.length) return { error: `A new attribute needs ${missing.join(', ')} (or attributeId to change an existing one).` }
  if (args.remove) return { error: 'There is nothing to remove: name the attribute with attributeId.' }
  const body = { code: args.code, label: args.label, description: args.description, groupId: args.groupId, type: args.type, localizable: args.localizable, scope: args.scope, sortOrder: args.sortOrder }
  const data = await checkAttributeCreate(body)
  if (await prisma.customAttribute.findFirst({ where: { code: data.code }, select: { id: true } })) {
    return { error: `An attribute with code "${data.code}" already exists. Change it with its attributeId.` }
  }
  const options = (args.options ?? []) as Array<{ code: string; label: string; sortOrder?: number; synonyms?: string[] }>
  if (options.length && !OPTION_TYPES.has(data.type)) return { error: `A ${data.type} attribute has no options (select, multiselect, text or textarea do).` }
  const codes = options.map((o) => o.code)
  const twice = codes.filter((code, i) => codes.indexOf(code) !== i)
  if (twice.length) return { error: `Option code ${twice[0]} is listed twice.` }
  const to = { code: data.code, label: data.label, type: data.type, group: group!.label, scope: data.scope, localizable: data.localizable, description: data.description }
  return {
    preview: {
      action: 'create-attribute',
      attribute: { code: data.code, label: data.label, type: data.type },
      changes: { attribute: { from: null, to }, ...(options.length ? { options: { from: null, to: options.map((o) => `${o.code}: ${o.label}`) } } : {}) },
      impact: { products: 0, families: 0, translations: 0 },
      note: 'Adds the attribute to the dictionary in Nexus. No product changes until someone fills it or a family declares it.',
    },
    async write() {
      const created = await inDatabaseTransaction(prisma as never, async () => {
        const attribute = await createCustomAttribute(body)
        for (const option of options) {
          const row = await createAttributeOption(attribute.id, { code: option.code, label: option.label, sortOrder: option.sortOrder })
          if (option.synonyms?.length) await updateAttributeOption(row.id, { synonyms: option.synonyms })
        }
        return attribute
      })
      await clearAttributeSchemaCaches()
      return {
        ok: true,
        data: { created: 'attribute', id: created.id, code: created.code, options: options.length },
        change: { before: removed('attribute', null), after: attributeSnapshot(created) },
      }
    },
  }
}

async function planUpdateAttribute(args: Data, attribute: AttributeRow, group: { id: string; label: string } | null): Promise<Planned> {
  const about = attributeName(attribute)
  if (args.code !== undefined || args.type !== undefined || args.options !== undefined) {
    return { error: `${about}: its code and type never change (product values are stored under them); options are added with kind "option".` }
  }
  const fields = given(args, ATTRIBUTE_FIELDS)
  if (!fields.length) return { error: `Nothing to change on ${about}: give label, description, groupId, localizable, scope or sortOrder.` }
  const body = Object.fromEntries(fields.map((key) => [key, args[key]]))
  const data = await checkAttributeUpdate(attribute.id, body)
  const changes = diff(attributeSnapshot(attribute), data, ATTRIBUTE_FIELDS)
  if (!Object.keys(changes).length) return { error: `Nothing to change on ${about}: it already has these values.` }
  if (changes.groupId) {
    const from = await prisma.attributeGroup.findUnique({ where: { id: attribute.groupId }, select: { label: true } })
    changes.group = { from: from?.label ?? null, to: group?.label ?? null }
    delete changes.groupId
  }
  const usage = await attributeUsage(attribute.code, attribute.id)
  return {
    preview: {
      action: 'update-attribute',
      attribute: { id: attribute.id, code: attribute.code, label: attribute.label, type: attribute.type },
      changes,
      impact: { products: usage.products, families: usage.families, translations: usage.translations },
      note: `Changes the attribute in Nexus. ${carry(usage.products, 'product')} a value for it and ${plural(usage.families, 'family')} declare it; their values stay as they are.`,
    },
    async write() {
      const before = attributeSnapshot(attribute)
      const updated = await updateCustomAttribute(attribute.id, body)
      await clearAttributeSchemaCaches()
      return { ok: true, data: { updated: 'attribute', id: updated.id, code: updated.code }, change: { before, after: attributeSnapshot(updated) } }
    },
  }
}

async function planRemoveAttribute(args: Data, attribute: AttributeRow & Data): Promise<Planned> {
  const about = attributeName(attribute)
  const extra = removeTakesNothing(args, about, [...ATTRIBUTE_FIELDS, 'code', 'type', 'options'])
  if (extra) return { error: extra }
  const usage = await attributeUsage(attribute.code, attribute.id)
  if (usage.products || usage.translations || usage.families) {
    return { error: `${about}: ${carry(usage.products, 'product')} a value, there ${usage.translations === 1 ? 'is' : 'are'} ${plural(usage.translations, 'translated value')}, and ${plural(usage.families, 'family')} declare it. Archive it in Nexus instead: nothing is lost and it can be restored.` }
  }
  const options = await prisma.attributeOption.findMany({ where: { attributeId: attribute.id }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] })
  const notRestorable = [
    attribute.validation != null && 'validation rules',
    attribute.defaultValue != null && 'a default value',
    attribute.semanticKey && 'a concept link',
    (attribute.placement !== 'shared' || attribute.placementChannels?.length) && 'a channel placement',
    options.some((o) => o.metadata != null || o.archivedAt) && 'option details',
    options.length > 250 && 'more than 250 options',
  ].filter(Boolean)
  if (notRestorable.length) return { error: `${about} has ${notRestorable.join(', ')} that an undo could not put back. Delete it in Nexus.` }
  const before = { ...attributeSnapshot(attribute), options: options.map((o) => ({ code: o.code, label: o.label, sortOrder: o.sortOrder, synonyms: [...o.synonyms] })) }
  return {
    preview: {
      action: 'remove-attribute',
      attribute: { id: attribute.id, code: attribute.code, label: attribute.label, type: attribute.type },
      changes: { attribute: { from: { code: attribute.code, label: attribute.label, type: attribute.type, options: options.length }, to: null } },
      impact: { products: 0, families: 0, translations: 0 },
      note: 'Deletes the attribute from the dictionary in Nexus. Nothing uses it; undo creates it again with its options.',
    },
    async write(ctx) {
      await deleteAttribute(attribute.id, { userId: ctx.userId ?? null })
      await clearAttributeSchemaCaches()
      return { ok: true, data: { removed: 'attribute', id: attribute.id, code: attribute.code }, change: { before, after: removed('attribute', attribute.id) } }
    },
  }
}

async function planCreateOption(args: Data, attribute: AttributeRow, about: string): Promise<Planned> {
  if (args.remove) return { error: `${about}: name the option to remove with optionId.` }
  const missing = ['code', 'label'].filter((key) => args[key] === undefined)
  if (missing.length) return { error: `${about}: a new option needs ${missing.join(' and ')}.` }
  const data = await checkOptionCreate(attribute.id, { code: args.code, label: args.label, sortOrder: args.sortOrder })
  if (await prisma.attributeOption.findFirst({ where: { attributeId: attribute.id, code: data.code }, select: { id: true } })) {
    return { error: `${about} already has an option "${data.code}". Change it with its optionId.` }
  }
  const to = { code: data.code, label: data.label, sortOrder: data.sortOrder, synonyms: args.synonyms ?? [], archived: args.archived ?? false }
  return {
    preview: {
      action: 'create-option',
      attribute: { id: attribute.id, code: attribute.code, label: attribute.label },
      changes: { option: { from: null, to } },
      impact: { products: 0 },
      note: 'Adds a choice to the attribute in Nexus.',
    },
    async write() {
      const option = await inDatabaseTransaction(prisma as never, async () => {
        const created = await createAttributeOption(attribute.id, { code: data.code, label: data.label, sortOrder: data.sortOrder })
        const extra: Data = {}
        if (args.synonyms?.length) extra.synonyms = args.synonyms
        if (args.archived) extra.archived = true
        return Object.keys(extra).length ? updateAttributeOption(created.id, extra) : created
      })
      await clearAttributeSchemaCaches()
      return { ok: true, data: { created: 'option', id: option.id, code: option.code }, change: { before: removed('option', null), after: optionSnapshot(option) } }
    },
  }
}

async function planUpdateOption(args: Data, option: Data, about: string): Promise<Planned> {
  if (args.code !== undefined) return { error: `${about}: an option's code never changes (product values store it).` }
  const fields = given(args, OPTION_FIELDS)
  if (!fields.length) return { error: `Nothing to change on ${about}: give label, sortOrder, synonyms or archived.` }
  const body = Object.fromEntries(fields.map((key) => [key, args[key]]))
  checkOptionUpdate(body)
  const current = optionSnapshot(option as never)
  const wanted: Data = { ...body }
  if (wanted.label !== undefined) wanted.label = String(wanted.label).trim()
  if (wanted.synonyms) wanted.synonyms = (wanted.synonyms as string[]).map((s) => s.trim())
  const changes = diff(current, wanted, OPTION_FIELDS)
  if (!Object.keys(changes).length) return { error: `Nothing to change on ${about}: it already has these values.` }
  const products = await optionUsage(option.attribute.code, option.code)
  return {
    preview: {
      action: 'update-option',
      option: { id: option.id, code: option.code, label: option.label, attribute: option.attribute.label },
      changes,
      impact: { products },
      note: changes.archived?.to === true
        ? `Retires the option: it is no longer offered; the ${plural(products, 'product')} that carry it keep it.`
        : `Changes the option in Nexus. ${carry(products, 'product')} it; their values stay as they are.`,
    },
    async write() {
      const updated = await updateAttributeOption(option.id, body)
      await clearAttributeSchemaCaches()
      return { ok: true, data: { updated: 'option', id: updated.id, code: updated.code }, change: { before: current, after: optionSnapshot(updated) } }
    },
  }
}

async function planRemoveOption(args: Data, option: Data, about: string): Promise<Planned> {
  const extra = removeTakesNothing(args, about, [...OPTION_FIELDS, 'code'])
  if (extra) return { error: extra }
  const products = await optionUsage(option.attribute.code, option.code)
  if (products) return { error: `${about}: ${carry(products, 'product')} it. Archive it instead (archived: true): it stays valid where it is used and is no longer offered.` }
  if (option.metadata != null) return { error: `${about} has details an undo could not put back. Delete it in Nexus.` }
  const before = optionSnapshot(option as never)
  return {
    preview: {
      action: 'remove-option',
      option: { id: option.id, code: option.code, label: option.label, attribute: option.attribute.label },
      changes: { option: { from: { code: option.code, label: option.label }, to: null } },
      impact: { products: 0 },
      note: 'Deletes the choice in Nexus. No product carries it; undo creates it again.',
    },
    async write() {
      await deleteAttributeOption(option.id)
      await clearAttributeSchemaCaches()
      return { ok: true, data: { removed: 'option', id: option.id, code: option.code }, change: { before, after: removed('option', option.id) } }
    },
  }
}

async function planCreateGroup(args: Data): Promise<Planned> {
  if (args.remove) return { error: 'There is nothing to remove: name the group with groupId.' }
  const data = checkGroupCreate({ code: args.code, label: args.label, description: args.description, sortOrder: args.sortOrder })
  if (await prisma.attributeGroup.findFirst({ where: { code: data.code }, select: { id: true } })) {
    return { error: `An attribute group with code "${data.code}" already exists. Change it with its groupId.` }
  }
  return {
    preview: {
      action: 'create-group',
      changes: { group: { from: null, to: data } },
      impact: { attributes: 0 },
      note: 'Adds an attribute group in Nexus (how attributes are sorted on the product page).',
    },
    async write() {
      const group = await createAttributeGroup(data)
      await clearAttributeSchemaCaches()
      return { ok: true, data: { created: 'group', id: group.id, code: group.code }, change: { before: removed('group', null), after: groupSnapshot(group) } }
    },
  }
}

async function planUpdateGroup(args: Data, group: Data, about: string): Promise<Planned> {
  if (args.code !== undefined) return { error: `${about}: a group's code never changes.` }
  const fields = given(args, GROUP_FIELDS)
  if (!fields.length) return { error: `Nothing to change on ${about}: give label, description or sortOrder.` }
  const body = Object.fromEntries(fields.map((key) => [key, args[key]]))
  const data = checkGroupUpdate(body)
  const current = groupSnapshot(group as never)
  const changes = diff(current, data, GROUP_FIELDS)
  if (!Object.keys(changes).length) return { error: `Nothing to change on ${about}: it already has these values.` }
  const attributes = await prisma.customAttribute.count({ where: { groupId: group.id } })
  return {
    preview: {
      action: 'update-group',
      group: { id: group.id, code: group.code, label: group.label },
      changes,
      impact: { attributes },
      note: `Changes the group in Nexus; its ${plural(attributes, 'attribute')} stay in it.`,
    },
    async write() {
      const updated = await updateAttributeGroup(group.id, body)
      await clearAttributeSchemaCaches()
      return { ok: true, data: { updated: 'group', id: updated.id, code: updated.code }, change: { before: current, after: groupSnapshot(updated) } }
    },
  }
}

async function planRemoveGroup(args: Data, group: Data, about: string): Promise<Planned> {
  const extra = removeTakesNothing(args, about, [...GROUP_FIELDS, 'code'])
  if (extra) return { error: extra }
  const attributes = await prisma.customAttribute.count({ where: { groupId: group.id } })
  if (attributes) return { error: `${about}: ${plural(attributes, 'attribute')} are in it. Move them to another group first.` }
  const before = groupSnapshot(group as never)
  return {
    preview: {
      action: 'remove-group',
      group: { id: group.id, code: group.code, label: group.label },
      changes: { group: { from: { code: group.code, label: group.label }, to: null } },
      impact: { attributes: 0 },
      note: 'Deletes the empty group in Nexus; undo creates it again.',
    },
    async write() {
      await deleteAttributeGroup(group.id)
      await clearAttributeSchemaCaches()
      return { ok: true, data: { removed: 'group', id: group.id, code: group.code }, change: { before, after: removed('group', group.id) } }
    },
  }
}

const ID_KEY: Record<string, string> = { attribute: 'attributeId', option: 'optionId', group: 'groupId' }

export const SAVE_ATTRIBUTE_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as Data
    return after.id ? attributeKindSnapshot(String(after.kind), String(after.id)) : null
  },
  request(change) {
    const before = (change.before ?? {}) as Data
    const after = (change.after ?? {}) as Data
    const kind = String(after.kind ?? before.kind ?? '')
    if (!ID_KEY[kind]) return { refusal: 'This change does not say what it changed.' }
    // A create: remove what it created (refused by the dry run if something uses it by then).
    if (before.removed) return { tool: 'save-attribute', args: { kind, [ID_KEY[kind]]: after.id, remove: true } }
    // A delete: create it again, with what it held.
    if (after.removed) {
      if (kind === 'attribute') {
        return {
          tool: 'save-attribute',
          args: {
            kind, code: before.code, label: before.label, description: before.description, groupId: before.groupId, type: before.type,
            localizable: before.localizable, scope: before.scope, sortOrder: before.sortOrder,
            ...(before.options?.length ? { options: before.options } : {}),
          },
        }
      }
      if (kind === 'option') {
        return { tool: 'save-attribute', args: { kind, attributeId: before.attributeId, code: before.code, label: before.label, sortOrder: before.sortOrder, ...(before.synonyms?.length ? { synonyms: before.synonyms } : {}), ...(before.archived ? { archived: true } : {}) } }
      }
      return { tool: 'save-attribute', args: { kind, code: before.code, label: before.label, description: before.description, sortOrder: before.sortOrder } }
    }
    // An update: the old value of each field it changed.
    const fields = kind === 'attribute' ? ATTRIBUTE_FIELDS : kind === 'option' ? OPTION_FIELDS : GROUP_FIELDS
    const back = Object.fromEntries(fields.filter((key) => !same(before[key], after[key])).map((key) => [key, before[key]]))
    if (!Object.keys(back).length) return { refusal: 'This change changed nothing that undo could put back.' }
    return { tool: 'save-attribute', args: { kind, [ID_KEY[kind]]: before.id, ...back } }
  },
}

const attributePlan = planned(planAttribute)

const saveAttribute: AgentTool = {
  name: 'save-attribute',
  title: 'Save an attribute',
  category: 'catalog',
  description:
    'Create, change or delete an attribute of the catalog dictionary (kind attribute), one of its choices (kind option) or '
    + 'an attribute group (kind group). The preview says what changes from → to and how many products carry it or '
    + 'families declare it. Delete only what nothing uses (archive an option instead: archived true). Code and type never '
    + 'change. Nexus only, nothing is sent to a channel. A person approves it in Nexus (at most confirmed in Claude, never '
    + 'run alone); it can be undone.',
  input: z.object({
    kind: z.enum(['attribute', 'option', 'group']).describe('what to save: an attribute, one of its options, or an attribute group'),
    attributeId: ID.optional().describe('kind attribute: the attribute to change or delete (omit to create one); kind option: the attribute a new option belongs to'),
    optionId: ID.optional().describe('kind option: the option to change or delete (omit to create one)'),
    groupId: ID.optional().describe('kind group: the group to change or delete (omit to create one); kind attribute: the group a new attribute goes in, or the group to move it to'),
    remove: z.boolean().optional().describe('delete it: only an attribute or option nothing uses, or a group with no attributes'),
    code: CODE.optional().describe('creating only: the lowercase snake_case code (never changes afterwards)'),
    label: LABEL.optional().describe('the name people see'),
    description: z.string().trim().max(500).nullable().optional().describe('kind attribute or group: a description; null clears it'),
    type: z.enum([...VALID_ATTRIBUTE_TYPES] as [string, ...string[]]).optional().describe('kind attribute, creating only: the value type'),
    localizable: z.boolean().optional().describe('kind attribute: one value per language (not for choice lists)'),
    scope: z.enum([...VALID_SCOPES] as [string, ...string[]]).optional().describe('kind attribute: global (the product) or per_variant (each variation)'),
    sortOrder: z.coerce.number().int().min(0).max(100000).optional().describe('position in its list'),
    synonyms: z.array(z.string().trim().min(1).max(80)).max(50).optional().describe('kind option: other words that mean this choice'),
    archived: z.boolean().optional().describe('kind option: retire it (it stays valid where it is used, and is no longer offered) or bring it back'),
    options: z.array(z.object({
      code: CODE.describe('the option code'),
      label: LABEL.describe('the option name'),
      sortOrder: z.coerce.number().int().min(0).max(100000).optional().describe('its position'),
      synonyms: z.array(z.string().trim().min(1).max(80)).max(50).optional().describe('other words for it'),
    })).max(250).optional().describe('kind attribute, creating a choice list only: its options'),
  }),
  requires: [F.pimManage],
  riskTier: 'medium',
  readOnly: false,
  openWorld: false,
  requiresApprovalDefault: true,
  reversibility: 'full',
  maxClaudeTrust: 'confirm',
  undo: SAVE_ATTRIBUTE_UNDO,
  handler: attributePlan.handler,
  execute: attributePlan.execute,
}

// ── save-product-family ───────────────────────────────────────────────────────────────────────────────

type FamilyNode = Omit<FamilyChainNode, 'familyAttributes'> & {
  code: string
  label: string
  description: string | null
  workflowId: string | null
  familyAttributes: Array<{ id: string; attributeId: string; required: boolean; channels: string[]; sortOrder: number }>
}

/** Every family of the business, with its own attribute declarations (a business has tens of families, not thousands). */
async function familyNodes(): Promise<Map<string, FamilyNode>> {
  const rows = await prisma.productFamily.findMany({
    select: {
      id: true, code: true, label: true, description: true, parentFamilyId: true, workflowId: true,
      familyAttributes: { select: { id: true, attributeId: true, required: true, channels: true, sortOrder: true } },
    },
  })
  return new Map(rows.map((row) => [row.id, row as FamilyNode]))
}

const familyAttributeView = (fa: { attributeId: string; required: boolean; channels: string[]; sortOrder: number }) =>
  ({ attributeId: fa.attributeId, required: fa.required, channels: [...fa.channels].sort(), sortOrder: fa.sortOrder })

function familySnapshot(node: { id: string; code: string; label: string; description: string | null; parentFamilyId: string | null; familyAttributes: FamilyNode['familyAttributes'] }) {
  return {
    id: node.id, code: node.code, label: node.label, description: node.description, parentFamilyId: node.parentFamilyId,
    attributes: node.familyAttributes.map(familyAttributeView).sort((a, b) => a.attributeId.localeCompare(b.attributeId)),
  }
}

async function storedFamilySnapshot(id: string): Promise<Data> {
  const row = await prisma.productFamily.findUnique({
    where: { id },
    select: { id: true, code: true, label: true, description: true, parentFamilyId: true, familyAttributes: { select: { id: true, attributeId: true, required: true, channels: true, sortOrder: true } } },
  })
  return row ? familySnapshot(row) : { id, removed: true }
}

/** The family and every family under it. */
function subtreeOf(nodes: ReadonlyMap<string, FamilyNode>, id: string): Set<string> {
  const subtree = new Set([id])
  for (let grew = true; grew;) {
    grew = false
    for (const node of nodes.values()) {
      if (node.parentFamilyId && subtree.has(node.parentFamilyId) && !subtree.has(node.id)) { subtree.add(node.id); grew = true }
    }
  }
  return subtree
}

/** The family whose own declaration of an attribute a family inherits along this chain (not itself), or null. */
function declaringAncestor(chain: FamilyChainNode[], attributeId: string): FamilyNode | null {
  for (const node of chain.slice(1)) if (node.familyAttributes.some((fa) => fa.attributeId === attributeId)) return node as FamilyNode
  return null
}

/**
 * How many products the change touches, and how many become incomplete or complete: completeness of every live
 * product of the family and the families under it, before and after (FamilyCompletenessService, same scoring), with
 * the after-state built in memory. Nothing is written.
 */
async function familyImpact(nodes: Map<string, FamilyNode>, after: Map<string, FamilyNode>, familyId: string): Promise<{ error: string } | { impact: Data }> {
  const subtree = subtreeOf(after, familyId)
  const products = await prisma.product.findMany({ where: { familyId: { in: [...subtree] }, deletedAt: null }, select: { id: true }, take: IMPACT_PRODUCT_LIMIT + 1 })
  if (products.length > IMPACT_PRODUCT_LIMIT) {
    return { error: `More than ${IMPACT_PRODUCT_LIMIT} products sit in this family and the families under it: too many to measure what the change does to each. Make the change in Nexus.` }
  }
  const beforeMap = new Map<string, EffectiveFamilyAttribute[]>()
  const afterMap = new Map<string, EffectiveFamilyAttribute[]>()
  for (const id of subtree) {
    if (nodes.has(id)) beforeMap.set(id, mergeFamilyAttributes(chainFromNodes(id, nodes)))
    afterMap.set(id, mergeFamilyAttributes(chainFromNodes(id, after)))
  }
  const impact = { products: products.length, families: subtree.size, becomeIncomplete: 0, becomeComplete: 0 }
  if (!products.length || same([...beforeMap], [...afterMap])) return { impact }
  const ids = products.map((p) => p.id)
  const [was, will] = await Promise.all([familyCompletenessService.computeManyWith(ids, beforeMap), familyCompletenessService.computeManyWith(ids, afterMap)])
  for (const id of ids) {
    const before = (was.get(id)?.score ?? 100) === 100
    const now = (will.get(id)?.score ?? 100) === 100
    if (before && !now) impact.becomeIncomplete++
    if (!before && now) impact.becomeComplete++
  }
  return { impact }
}

type FamilyEntry = { attributeId: string; required?: boolean; channels?: string[]; sortOrder?: number; remove?: boolean }

async function planFamily(args: Data): Promise<Planned> {
  const nodes = await familyNodes()
  const family = args.familyId ? nodes.get(args.familyId) : undefined
  if (args.familyId && !family) return { error: 'Product family not found' }
  const about = family ? `Product family "${family.label}" (${family.code})` : 'The new family'
  if (args.parentFamilyId && !nodes.has(args.parentFamilyId)) return { error: 'Parent family not found' }
  try {
    if (family && args.remove) return await planRemoveFamily(args, family, nodes, about)
    if (!family && args.remove) return { error: 'There is nothing to remove: name the family with familyId.' }

    const entries = (args.attributes ?? []) as FamilyEntry[]
    const attributeIds = entries.map((e) => e.attributeId)
    const twice = attributeIds.filter((id, i) => attributeIds.indexOf(id) !== i)
    if (twice.length) return { error: `${about}: attribute ${twice[0]} is listed twice.` }
    const attributes = new Map((await prisma.customAttribute.findMany({ where: { id: { in: attributeIds }, archivedAt: null }, select: { id: true, code: true, label: true } })).map((a) => [a.id, a]))
    const unknown = attributeIds.find((id) => !attributes.has(id))
    if (unknown) return { error: 'Attribute not found' }

    if (!family) return await planCreateFamily(args, entries, attributes, nodes)
    return await planUpdateFamily(args, family, entries, attributes, nodes, about)
  } catch (error) {
    const refused = refusalOf(error, about)
    if (refused) return { error: refused }
    if (error instanceof Error && /cycle|depth exceeded/i.test(error.message)) return { error: `${about}: ${error.message}` }
    throw error
  }
}

async function planCreateFamily(args: Data, entries: FamilyEntry[], attributes: Map<string, { label: string }>, nodes: Map<string, FamilyNode>): Promise<Planned> {
  const missing = ['code', 'label'].filter((key) => args[key] === undefined)
  if (missing.length) return { error: `A new family needs ${missing.join(' and ')} (or familyId to change an existing one).` }
  const data = await checkFamilyCreate({ code: args.code, label: args.label, description: args.description, parentFamilyId: args.parentFamilyId ?? null })
  if (await prisma.productFamily.findFirst({ where: { code: data.code }, select: { id: true } })) {
    return { error: `A family with code "${data.code}" already exists. Change it with its familyId.` }
  }
  if (entries.some((e) => e.remove)) return { error: 'A new family has no attributes to remove.' }
  const parentChain = data.parentFamilyId ? chainFromNodes(data.parentFamilyId, nodes) : []
  for (const entry of entries) {
    const owner = parentChain.find((node) => node.familyAttributes.some((fa) => fa.attributeId === entry.attributeId)) as FamilyNode | undefined
    if (owner) return { error: `The new family: ${attributes.get(entry.attributeId)!.label} is inherited from ${owner.label}; a family never declares again what an ancestor declares.` }
  }
  const declared = entries.map((e) => ({ attribute: attributes.get(e.attributeId)!.label, required: e.required ?? false, channels: e.channels ?? [] }))
  return {
    preview: {
      action: 'create-family',
      changes: { family: { from: null, to: { code: data.code, label: data.label, description: data.description, parent: data.parentFamilyId ? nodes.get(data.parentFamilyId)!.label : null } }, ...(declared.length ? { attributes: { from: null, to: declared } } : {}) },
      impact: { products: 0, families: 0, becomeIncomplete: 0, becomeComplete: 0 },
      note: 'Adds a product family in Nexus. No product is in it until someone assigns one.',
    },
    async write() {
      const created = await inDatabaseTransaction(prisma as never, async () => {
        const row = await createProductFamily(data)
        for (const e of entries) await createFamilyAttribute(row.id, { attributeId: e.attributeId, required: e.required, channels: e.channels, sortOrder: e.sortOrder })
        return row
      })
      await clearAttributeSchemaCaches()
      return { ok: true, data: { created: 'family', id: created.id, code: created.code }, change: { before: { id: null, removed: true }, after: await storedFamilySnapshot(created.id) } }
    },
  }
}

async function planUpdateFamily(args: Data, family: FamilyNode, entries: FamilyEntry[], attributes: Map<string, { label: string }>, nodes: Map<string, FamilyNode>, about: string): Promise<Planned> {
  if (args.code !== undefined) return { error: `${about}: a family's code never changes.` }
  const fields = given(args, ['label', 'description', 'parentFamilyId'])
  if (!fields.length && !entries.length) return { error: `Nothing to change on ${about}: give label, description, parentFamilyId or attributes.` }
  const body = Object.fromEntries(fields.map((key) => [key, args[key]]))
  const data = fields.length ? await checkFamilyUpdate(family.id, body) : {}

  // The family as it would be, in memory: its fields, then each attribute declaration.
  const next: FamilyNode = { ...family, ...data, familyAttributes: family.familyAttributes.map((fa) => ({ ...fa })) } as FamilyNode
  const after = new Map(nodes)
  after.set(family.id, next)
  const chain = chainFromNodes(family.id, after)
  const ops: Array<{ op: 'attach' | 'update' | 'detach'; entry: FamilyEntry; faId?: string }> = []
  const attributeChanges: Data[] = []
  for (const entry of entries) {
    const label = attributes.get(entry.attributeId)!.label
    const direct = next.familyAttributes.find((fa) => fa.attributeId === entry.attributeId)
    const ancestor = declaringAncestor(chain, entry.attributeId)
    if (entry.remove) {
      if (!direct) {
        return { error: ancestor ? `${about}: ${label} is inherited from ${ancestor.label}; change it there.` : `${about}: ${label} is not declared by this family.` }
      }
      ops.push({ op: 'detach', entry, faId: direct.id })
      next.familyAttributes = next.familyAttributes.filter((fa) => fa !== direct)
      attributeChanges.push({ attribute: label, from: familyAttributeView(direct), to: null })
      continue
    }
    if (ancestor) return { error: `${about}: ${label} is inherited from ${ancestor.label}; a family never declares again what an ancestor declares.` }
    if (direct) {
      const wanted = { ...familyAttributeView(direct), ...(entry.required !== undefined ? { required: entry.required } : {}), ...(entry.channels !== undefined ? { channels: [...entry.channels].sort() } : {}), ...(entry.sortOrder !== undefined ? { sortOrder: entry.sortOrder } : {}) }
      if (same(wanted, familyAttributeView(direct))) continue
      ops.push({ op: 'update', entry, faId: direct.id })
      attributeChanges.push({ attribute: label, from: familyAttributeView(direct), to: wanted })
      Object.assign(direct, { required: wanted.required, channels: wanted.channels, sortOrder: wanted.sortOrder })
      continue
    }
    const added = { id: 'new', attributeId: entry.attributeId, required: entry.required ?? false, channels: entry.channels ?? [], sortOrder: entry.sortOrder ?? 0 }
    next.familyAttributes.push(added)
    ops.push({ op: 'attach', entry })
    attributeChanges.push({ attribute: label, from: null, to: familyAttributeView(added) })
  }

  const changes: Data = diff({ label: family.label, description: family.description }, data, ['label', 'description'])
  if ('parentFamilyId' in data && data.parentFamilyId !== family.parentFamilyId) {
    changes.parent = { from: family.parentFamilyId ? nodes.get(family.parentFamilyId)?.label ?? null : null, to: data.parentFamilyId ? nodes.get(data.parentFamilyId as string)?.label ?? null : null }
  }
  if (attributeChanges.length) changes.attributes = attributeChanges
  if (!Object.keys(changes).length) return { error: `Nothing to change on ${about}: it already has these values.` }

  const measured = await familyImpact(nodes, after, family.id)
  if ('error' in measured) return { error: `${about}: ${measured.error}` }
  const { impact } = measured
  return {
    preview: {
      action: 'update-family',
      family: { id: family.id, code: family.code, label: family.label },
      changes,
      impact,
      note: `${plural(impact.products, 'product')} in ${plural(impact.families, 'family')} follow this family: ${impact.becomeIncomplete} become incomplete, ${impact.becomeComplete} become complete. Values stay as they are; nothing is sent to a channel.`,
    },
    async write() {
      const before = familySnapshot(family)
      await inDatabaseTransaction(prisma as never, async () => {
        if (fields.length) await updateProductFamily(family.id, body)
        for (const { op, entry, faId } of ops) {
          if (op === 'detach') await deleteFamilyAttribute(faId!)
          else if (op === 'update') {
            await updateFamilyAttribute(faId!, {
              ...(entry.required !== undefined ? { required: entry.required } : {}),
              ...(entry.channels !== undefined ? { channels: entry.channels } : {}),
              ...(entry.sortOrder !== undefined ? { sortOrder: entry.sortOrder } : {}),
            })
          } else await createFamilyAttribute(family.id, { attributeId: entry.attributeId, required: entry.required, channels: entry.channels, sortOrder: entry.sortOrder })
        }
      })
      await clearAttributeSchemaCaches()
      return { ok: true, data: { updated: 'family', id: family.id, code: family.code }, change: { before, after: await storedFamilySnapshot(family.id) } }
    },
  }
}

async function planRemoveFamily(args: Data, family: FamilyNode, nodes: Map<string, FamilyNode>, about: string): Promise<Planned> {
  const extra = removeTakesNothing(args, about, ['label', 'description', 'parentFamilyId', 'attributes', 'code'])
  if (extra) return { error: extra }
  // Every product that names it counts, deleted ones too: deleting the family would drop it from them silently.
  const products = await prisma.product.count({ where: { familyId: family.id } })
  if (products) return { error: `${about}: ${plural(products, 'product')} belong to it. Move them to another family first.` }
  const children = [...nodes.values()].filter((node) => node.parentFamilyId === family.id)
  if (children.length) return { error: `${about}: ${plural(children.length, 'family')} sit under it (${children.map((c) => c.label).join(', ')}). Move them first.` }
  if (family.workflowId) return { error: `${about} has a workflow an undo could not put back. Delete it in Nexus.` }
  const before = familySnapshot(family)
  return {
    preview: {
      action: 'remove-family',
      family: { id: family.id, code: family.code, label: family.label },
      changes: { family: { from: { code: family.code, label: family.label, attributes: family.familyAttributes.length }, to: null } },
      impact: { products: 0, families: 1, becomeIncomplete: 0, becomeComplete: 0 },
      note: 'Deletes the empty family in Nexus; undo creates it again with its attributes.',
    },
    async write() {
      await deleteProductFamily(family.id)
      await clearAttributeSchemaCaches()
      return { ok: true, data: { removed: 'family', id: family.id, code: family.code }, change: { before, after: { id: family.id, removed: true } } }
    },
  }
}

export const SAVE_FAMILY_UNDO: ToolUndo = {
  async current(change) {
    const id = (change.after as Data | null)?.id
    return id ? storedFamilySnapshot(String(id)) : null
  },
  request(change) {
    const before = (change.before ?? {}) as Data
    const after = (change.after ?? {}) as Data
    if (before.removed) return after.id ? { tool: 'save-product-family', args: { familyId: after.id, remove: true } } : { refusal: 'This change does not name the family it created.' }
    if (after.removed) {
      return {
        tool: 'save-product-family',
        args: {
          code: before.code, label: before.label, description: before.description, parentFamilyId: before.parentFamilyId,
          ...(before.attributes?.length ? { attributes: before.attributes } : {}),
        },
      }
    }
    const args: Data = { familyId: before.id }
    for (const key of ['label', 'description', 'parentFamilyId']) if (!same(before[key], after[key])) args[key] = before[key]
    const was = new Map<string, Data>((before.attributes ?? []).map((a: Data) => [a.attributeId, a]))
    const now = new Map<string, Data>((after.attributes ?? []).map((a: Data) => [a.attributeId, a]))
    const entries: Data[] = []
    for (const [attributeId, a] of was) if (!now.has(attributeId) || !same(a, now.get(attributeId))) entries.push({ attributeId, required: a.required, channels: a.channels, sortOrder: a.sortOrder })
    for (const attributeId of now.keys()) if (!was.has(attributeId)) entries.push({ attributeId, remove: true })
    if (entries.length) args.attributes = entries
    if (Object.keys(args).length === 1) return { refusal: 'This change changed nothing that undo could put back.' }
    return { tool: 'save-product-family', args }
  },
}

const familyPlan = planned(planFamily)

const saveProductFamily: AgentTool = {
  name: 'save-product-family',
  title: 'Save a product family',
  category: 'catalog',
  description:
    'Create, change or delete a product family: its label, description and parent, and the attributes it declares '
    + '(required or not, on which channels). The preview counts the products in the family and the families under it, '
    + 'and how many become incomplete or complete. A family never re-declares an attribute an ancestor declares; delete '
    + 'only a family with no products and no families under it. Nexus only. A person approves it in Nexus (at most '
    + 'confirmed in Claude, never run alone); it can be undone.',
  input: z.object({
    familyId: ID.optional().describe('the family to change or delete (omit to create one)'),
    remove: z.boolean().optional().describe('delete it: only a family with no products and no families under it'),
    code: CODE.optional().describe('creating only: the lowercase snake_case code (never changes afterwards)'),
    label: LABEL.optional().describe('the name people see'),
    description: z.string().trim().max(500).nullable().optional().describe('a description; null clears it'),
    parentFamilyId: ID.nullable().optional().describe('the parent family it inherits attributes from; null makes it a top family'),
    attributes: z.array(z.object({
      attributeId: ID.describe('the attribute'),
      required: z.boolean().optional().describe('products of the family must have a value'),
      channels: z.array(z.preprocess(upper, z.enum(FAMILY_CHANNELS))).max(10).optional().describe('required only for these channels (empty = every channel)'),
      sortOrder: z.coerce.number().int().min(0).max(100000).optional().describe('its position'),
      remove: z.boolean().optional().describe('stop declaring it (only one this family declares itself)'),
    })).max(100).optional().describe('attributes to declare, change or stop declaring'),
  }),
  requires: [F.pimManage],
  riskTier: 'medium',
  readOnly: false,
  openWorld: false,
  requiresApprovalDefault: true,
  reversibility: 'full',
  maxClaudeTrust: 'confirm',
  undo: SAVE_FAMILY_UNDO,
  handler: familyPlan.handler,
  execute: familyPlan.execute,
}

// ── save-category ─────────────────────────────────────────────────────────────────────────────────────

async function storedCategorySnapshot(id: string): Promise<Data> {
  const row = await prisma.category.findUnique({ where: { id }, select: { id: true, name: true, slug: true, code: true, parentId: true } })
  return row ? { id: row.id, name: categoryName(row.name) ?? row.slug, slug: row.slug, code: row.code, parentId: row.parentId } : { id, removed: true }
}

async function planCategory(args: Data): Promise<Planned> {
  const directory = await categoryDirectory()
  const live = (id: string | null | undefined) => (id ? directory.rows.find((row) => row.id === id && row.active) : undefined)
  const row = live(args.categoryId)
  if (args.categoryId && !row) return { error: 'Category not found' }
  const about = row ? `Category "${row.path}"` : 'The new category'
  if (args.parentCategoryId && !live(args.parentCategoryId)) return { error: 'Parent category not found' }
  const renaming = given(args, ['name', 'slug', 'code'])

  let command: CategoryCommand
  if (!row) {
    if (args.remove) return { error: 'There is nothing to remove: name the category with categoryId.' }
    if (args.name === undefined || args.slug === undefined) return { error: 'A new category needs name and slug (or categoryId to change an existing one).' }
    command = { action: 'create', name: args.name, slug: args.slug, code: args.code, parentId: args.parentCategoryId ?? null, expectedToken: directory.token }
  } else if (args.remove) {
    const extra = removeTakesNothing(args, about, ['name', 'slug', 'code', 'parentCategoryId'])
    if (extra) return { error: extra }
    command = { action: 'delete', id: row.id, expectedToken: directory.token }
  } else if (args.parentCategoryId !== undefined) {
    if (renaming.length) return { error: `${about}: a move and a rename are two changes; ask for one at a time.` }
    if ((args.parentCategoryId ?? null) === row.parentId) return { error: `Nothing to change on ${about}: it is already there.` }
    command = { action: 'move', id: row.id, parentId: args.parentCategoryId ?? null, expectedToken: directory.token }
  } else if (renaming.length) {
    command = { action: 'rename', id: row.id, name: args.name ?? row.name, slug: args.slug ?? row.slug, code: args.code ?? row.code ?? '', expectedToken: directory.token }
  } else {
    return { error: `Nothing to change on ${about}: give a name, slug or code, a parentCategoryId to move it, or remove.` }
  }

  let impact: Awaited<ReturnType<typeof categoryChangeImpact>>
  try {
    impact = await categoryChangeImpact(command)
  } catch (error) {
    const refused = refusalOf(error, about)
    if (refused) return { error: refused }
    throw error
  }
  if (impact.blocked) return { error: `${about}: ${impact.blocked}` }

  const parentName = (id: string | null | undefined) => (id ? directory.rows.find((r) => r.id === id)?.path ?? null : null)
  let changes: Data
  if (command.action === 'create') {
    changes = { category: { from: null, to: { name: String(command.name).trim(), slug: command.slug, code: command.code || null, parent: parentName(command.parentId) } } }
  } else if (command.action === 'delete') {
    const stored = await prisma.category.findUniqueOrThrow({ where: { id: row!.id } })
    const names = (stored.name ?? {}) as Data
    const onlyEnglishName = Object.keys(names).every((key) => key === 'en' || (names[key] && typeof names[key] === 'object' && !Object.keys(names[key]).length))
    if (!onlyEnglishName || stored.description != null || stored.attributes != null || stored.sortOrder !== 0) {
      return { error: `${about} has translations, a description or settings an undo could not put back. Delete it in Nexus.` }
    }
    changes = { category: { from: { name: row!.name, slug: row!.slug, code: row!.code, parent: parentName(row!.parentId) }, to: null } }
  } else if (command.action === 'move') {
    changes = { parent: { from: parentName(row!.parentId), to: parentName(command.parentId) } }
  } else {
    changes = diff({ name: row!.name, slug: row!.slug, code: row!.code ?? null }, { name: String(command.name).trim(), slug: command.slug, code: command.code || null }, ['name', 'slug', 'code'])
    if (!Object.keys(changes).length) return { error: `Nothing to change on ${about}: it already has these values.` }
  }

  const counted = { products: impact.productCount, childCategories: impact.descendantCount }
  return {
    preview: {
      action: command.action,
      category: row ? { id: row.id, name: row.name, path: row.path } : { name: String(command.name).trim() },
      changes,
      impact: counted,
      note: command.action === 'move'
        ? `Moves the category and the ${plural(counted.childCategories, 'category')} under it; ${plural(counted.products, 'product')} sit in them. Their channel categories do not change.`
        : `${plural(counted.products, 'product')} sit in this category and the ${plural(counted.childCategories, 'category')} under it. Nexus only.`,
    },
    async write(ctx) {
      const before = row ? await storedCategorySnapshot(row.id) : { id: null, removed: true }
      // The plan is fresh (its token is the directory now); the category workspace re-checks it under its lock.
      const applied = await applyCategoryCommand(command, ctx.userId ?? null)
      const id = applied.id ?? row?.id
      return {
        ok: true,
        data: { [command.action === 'delete' ? 'removed' : command.action === 'create' ? 'created' : 'updated']: 'category', id },
        change: { before, after: command.action === 'delete' ? { id: row!.id, removed: true } : await storedCategorySnapshot(String(id)) },
      }
    },
  }
}

export const SAVE_CATEGORY_UNDO: ToolUndo = {
  async current(change) {
    const id = (change.after as Data | null)?.id
    return id ? storedCategorySnapshot(String(id)) : null
  },
  request(change) {
    const before = (change.before ?? {}) as Data
    const after = (change.after ?? {}) as Data
    if (before.removed) return after.id ? { tool: 'save-category', args: { categoryId: after.id, remove: true } } : { refusal: 'This change does not name the category it created.' }
    if (after.removed) {
      return { tool: 'save-category', args: { name: before.name, slug: before.slug, ...(before.code ? { code: before.code } : {}), parentCategoryId: before.parentId ?? null } }
    }
    if (!same(before.parentId, after.parentId)) return { tool: 'save-category', args: { categoryId: before.id, parentCategoryId: before.parentId ?? null } }
    if (same([before.name, before.slug, before.code], [after.name, after.slug, after.code])) return { refusal: 'This change changed nothing that undo could put back.' }
    return { tool: 'save-category', args: { categoryId: before.id, name: before.name, slug: before.slug, code: before.code ?? '' } }
  },
}

const categoryPlan = planned(planCategory)

const saveCategory: AgentTool = {
  name: 'save-category',
  title: 'Save a category',
  category: 'catalog',
  description:
    'Create, rename, move or delete a category of the business\'s own category tree (one change at a time). The preview '
    + 'counts the products in the category and the categories under it. A move that would change the channel '
    + 'categories products inherit is refused (review those in Channel assignments first); delete only an empty '
    + 'category. Nexus only. A person approves it in Nexus (at most confirmed in Claude, never run alone); it can be undone.',
  input: z.object({
    categoryId: ID.optional().describe('the category to rename, move or delete (omit to create one)'),
    remove: z.boolean().optional().describe('delete it: only an empty category without categories under it or channel assignments'),
    name: z.string().trim().min(1).max(160).optional().describe('its name (English)'),
    slug: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/, 'lowercase letters, digits, - or _').optional().describe('its URL key'),
    code: z.string().trim().max(100).optional().describe('a reference code; empty clears it'),
    parentCategoryId: ID.nullable().optional().describe('move it under this category (null: to the top); for a new category, where it goes'),
  }),
  requires: [F.pimManage],
  riskTier: 'medium',
  readOnly: false,
  openWorld: false,
  requiresApprovalDefault: true,
  reversibility: 'full',
  maxClaudeTrust: 'confirm',
  undo: SAVE_CATEGORY_UNDO,
  handler: categoryPlan.handler,
  execute: categoryPlan.execute,
}

export const STRUCTURE_CHANGE_TOOLS: AgentTool[] = [saveAttribute, saveProductFamily, saveCategory]
