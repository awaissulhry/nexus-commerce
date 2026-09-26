import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { familyHierarchyService } from '../family-hierarchy.service.js'
import { ALLOWED_MASTER_FIELDS, MASTER_FIELD_OPTIONS } from './master-field-gate.js'
import type { FieldDefinition } from './field-registry.service.js'
import { humanizeKey } from './channel-specs/types.js'

const INTERNAL_KEYS = new Set(['variations', 'ebayClusterParent', 'ebayFileExcluded'])

/** Historical values stay addressable when a family changes; they are never part of its template. */
export function savedAttributeFields(bags: unknown[]): FieldDefinition[] {
  const values = new Map<string, unknown[]>()
  for (const bag of bags) {
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) continue
    for (const [key, value] of Object.entries(bag)) {
      if (INTERNAL_KEYS.has(key) || key.startsWith('__') || value === null || value === '') continue
      values.set(key, [...(values.get(key) ?? []), value])
    }
  }
  return [...values].sort(([a], [b]) => a.localeCompare(b)).map(([key, entries]) => {
    const list = entries.every(Array.isArray)
    const structured = entries.some(value => list ? (value as unknown[]).some(v => v !== null && typeof v === 'object') : typeof value === 'object')
    return {
      id: `attr_${key}`, label: humanizeKey(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')), type: 'text', category: 'category',
      group: { key: 'master:legacy', label: 'Additional saved attributes' }, editable: !structured,
      shape: list && !structured ? 'list' : 'scalar', cardinality: list ? { min: 0, max: null } : undefined,
      helpText: 'Saved outside the selected family template. Changing family preserves this value.',
    }
  })
}

/** The existing family dictionary is the authority for shared product specifications. */
export async function familySheetFields(familyIds: string[], locale = 'it'): Promise<FieldDefinition[]> {
  const ids = [...new Set(familyIds)]
  // P3 — one query per hierarchy level for all families, not one per family per ancestor.
  const effectiveById = await familyHierarchyService.resolveEffectiveAttributesMany(ids)
  const effective = ids.map(id => effectiveById.get(id)!)
  /**
   * 🔴 PLAN Step 2.1 (A-14, approved). `schema.prisma:736-739`: `required = true` with an EMPTY
   * `channels` array means required everywhere; with `['AMAZON']` it means required on Amazon.
   * This file used to read
   *
   *     const required = a.required && (a.channels?.length ?? 0) === 0
   *
   * which keeps only the first case and DISCARDS the second. Measured on the scale fixture before
   * the change: five attributes marked `required = true` with a channel list came out of the
   * column build with `requiredBy: []` — indistinguishable from the ones marked optional.
   *
   * `everywhere` keeps its old meaning exactly, so `familyRules[...].required` — read by
   * `packages/shared/master-sheet.ts:90` for the Master coordinate — is unchanged. The channel
   * codes travel separately, because the Master coordinate is NOT the place an Amazon-only
   * requirement becomes a hard requirement; on Shared it is a marker, per the step's `Done when`.
   */
  const requirements = new Map<string, { everywhere: boolean; channels: Set<string> }>()
  const familyRules = new Map<string, NonNullable<FieldDefinition['familyRules']>>()
  for (const [index, attributes] of effective.entries()) for (const a of attributes) {
    const channels = a.required ? (a.channels ?? []).filter(Boolean) : []
    const everywhere = a.required && channels.length === 0
    const seen = requirements.get(a.attributeId) ?? { everywhere: false, channels: new Set<string>() }
    seen.everywhere ||= everywhere
    for (const channel of channels) seen.channels.add(String(channel).toUpperCase())
    requirements.set(a.attributeId, seen)
    const rules = familyRules.get(a.attributeId) ?? {}
    rules[ids[index]] = { required: everywhere, sortOrder: a.sortOrder }
    familyRules.set(a.attributeId, rules)
  }
  if (!requirements.size) return []
  // P3b S4 (docs/attributes/PLAN.md §10.9) — Shared shows `placement = 'shared'` and never an archived attribute. A
  // channel-placed attribute a family still REQUIRES stays (marked "required by <channel>"): a required attribute is
  // never hidden (plan rule 5), and a channel scope does not show family requirements.
  const required = [...requirements].filter(([, r]) => r.everywhere || r.channels.size).map(([id]) => id)
  const attributes = await prisma.customAttribute.findMany({
    where: { id: { in: [...requirements.keys()] }, archivedAt: null, OR: [{ placement: 'shared' }, { id: { in: required } }] },
    include: { group: true, options: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] } },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  })
  return attributes.map(a => toFieldDefinition(a, locale, requirements.get(a.id), familyRules.get(a.id)))
}

type DictionaryRow = Prisma.CustomAttributeGetPayload<{ include: { group: true; options: true } }>

/** One dictionary attribute as a Master field. `requirement` / `rules` come from the families that carry it (none for the core list). */
function toFieldDefinition(a: DictionaryRow, locale: string, requirement?: { everywhere: boolean; channels: Set<string> }, rules?: NonNullable<FieldDefinition['familyRules']>): FieldDefinition {
    const native = ALLOWED_MASTER_FIELDS.has(a.code)
    const validation = a.validation && typeof a.validation === 'object' ? a.validation as Record<string, unknown> : {}
    const labels = validation.labels
    const labelFor = (labels: unknown, fallback: string) => {
      const selected = labels && typeof labels === 'object' ? (labels as Record<string, unknown>)[locale] ?? (labels as Record<string, unknown>)[locale.split('-')[0]] : undefined
      return typeof selected === 'string' && selected.trim() ? selected : fallback
    }
    return {
      id: native ? a.code : `attr_${a.code}`,
      label: labelFor(labels, a.label),
      type: MASTER_FIELD_OPTIONS[a.code] ? 'select' : ['number', 'boolean', 'date'].includes(a.type) ? a.type as 'number' | 'boolean' | 'date'
        : a.type === 'select' || a.type === 'multiselect' ? 'select' : 'text',
      category: 'category', editable: !['asset', 'reference'].includes(a.type),
      required: requirement?.everywhere,
      requiredChannels: [...(requirement?.channels ?? [])].sort(),
      familyRules: rules,
      validation,
      group: { key: `master:${a.group.code}`, label: a.group.label },
      scope: a.scope === 'per_variant' ? 'per_variant' : 'global',
      // P3/P6 — a retired option is no longer OFFERED; its label stays below, so a value saved with it still reads well.
      options: MASTER_FIELD_OPTIONS[a.code] ?? a.options.filter(o => !(o as { archivedAt?: Date | null }).archivedAt).map(o => o.code),
      optionLabels: Object.fromEntries(a.options.map(o => [o.code, labelFor((o.metadata as any)?.labels, o.label)])),
      unitOptions: Array.isArray(validation.unitOptions) ? validation.unitOptions.filter((unit): unit is string => typeof unit === 'string') : undefined,
      shape: validation.shape === 'measure' ? 'measure' : a.type === 'multiselect' || validation.shape === 'list' ? 'list' : 'scalar',
      cardinality: a.type === 'multiselect' || validation.shape === 'list' ? { min: 0, max: null } : undefined,
      maxLength: typeof validation.maxLength === 'number' ? validation.maxLength : undefined,
      longText: a.type === 'textarea',
      localizable: a.localizable,
      helpText: ['asset', 'reference'].includes(a.type) ? `${a.description ?? a.label}. This dictionary reference has no Information picker configured; its saved value is preserved.` : a.description ?? undefined,
    } satisfies FieldDefinition
}

/**
 * P3b S4 — the business's CORE, for a product with no family (plan: "a product with no family shows the business's
 * core"). Core = the attributes linked to a shared concept (`semanticKey`, P3), placed on Shared and not archived: the
 * starter dictionary for a new business, the adopted concepts for an older one. Before S4 such a product saw none of the
 * dictionary on Shared.
 */
export async function coreSheetFields(locale = 'it'): Promise<FieldDefinition[]> {
  const attributes = await prisma.customAttribute.findMany({
    where: { semanticKey: { not: null }, placement: 'shared', archivedAt: null },
    include: { group: true, options: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] } },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  })
  return attributes.map(a => toFieldDefinition(a, locale))
}

/** Top-level Amazon attribute names of the business's cached schemas, per business, refreshed when a schema changes. */
const amazonKeyCache = new Map<string, { stamp: string; keys: Set<string> }>()
export async function amazonSchemaKeys(): Promise<Set<string>> {
  const [stamp] = await prisma.$queryRaw<Array<{ s: string; w: string }>>`
    SELECT concat(count(*), ':', coalesce(max("fetchedAt")::text, '')) AS s, coalesce(max("workspaceId"), '') AS w
    FROM "CategorySchema" WHERE channel = 'AMAZON' AND "isActive" = true`
  const key = stamp?.w ?? ''
  const hit = amazonKeyCache.get(key)
  if (hit && hit.stamp === stamp?.s) return hit.keys
  const rows = await prisma.$queryRaw<Array<{ k: string }>>`
    SELECT DISTINCT k FROM "CategorySchema",
      jsonb_object_keys(CASE WHEN jsonb_typeof("schemaDefinition"->'properties') = 'object' THEN "schemaDefinition"->'properties' ELSE '{}'::jsonb END) AS k
    WHERE channel = 'AMAZON' AND "isActive" = true`
  const keys = new Set(rows.map(r => r.k))
  if (amazonKeyCache.size > 64) amazonKeyCache.clear()
  amazonKeyCache.set(key, { stamp: stamp?.s ?? '', keys })
  return keys
}

/**
 * P3b S4 — the saved keys Shared may show. `savedAttributeFields` turns every stored key that is not a registry or
 * family field into an "Additional saved attributes" column; this drops the ones that do not belong on Shared:
 *   · a dictionary attribute placed on a channel, or archived;
 *   · a key the dictionary does not have that IS an Amazon attribute of the business's cached schemas (an Amazon-scope
 *     save of a field with no listing store writes the shared bag; the Amazon scope reads it there, Shared must not).
 * A real old key (not in the dictionary, not a channel attribute — e.g. `waterproofRating`) stays. The value is never
 * touched. The column builder applies it only when the caller asks (`savedFieldsFor: 'shared'`); the EXPORT does not ask
 * (every key travels in a file).
 */
export async function sharedSavedFields(saved: FieldDefinition[]): Promise<FieldDefinition[]> {
  if (!saved.length) return saved
  const keys = saved.map(f => f.id.replace(/^attr_/, ''))
  const [dictionary, amazon] = await Promise.all([
    prisma.customAttribute.findMany({ where: { code: { in: keys } }, select: { code: true, placement: true, archivedAt: true } }),
    amazonSchemaKeys(),
  ])
  const inDictionary = new Map(dictionary.map(a => [a.code, a]))
  return saved.filter(f => {
    const key = f.id.replace(/^attr_/, '')
    const own = inDictionary.get(key)
    if (own) return own.placement === 'shared' && !own.archivedAt
    return !amazon.has(key)
  })
}
