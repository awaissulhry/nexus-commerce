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
  const attributes = await prisma.customAttribute.findMany({
    where: { id: { in: [...requirements.keys()] } },
    include: { group: true, options: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] } },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  })
  return attributes.map(a => {
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
      required: requirements.get(a.id)?.everywhere,
      requiredChannels: [...(requirements.get(a.id)?.channels ?? [])].sort(),
      familyRules: familyRules.get(a.id),
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
  })
}
