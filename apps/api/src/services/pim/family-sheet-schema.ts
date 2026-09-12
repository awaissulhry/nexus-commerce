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
  const effective = await Promise.all(ids.map(id => familyHierarchyService.resolveEffectiveAttributes(id)))
  const requirements = new Map<string, boolean>()
  const familyRules = new Map<string, NonNullable<FieldDefinition['familyRules']>>()
  for (const [index, attributes] of effective.entries()) for (const a of attributes) {
    const required = a.required && (a.channels?.length ?? 0) === 0
    requirements.set(a.attributeId, requirements.get(a.attributeId) === true || required)
    const rules = familyRules.get(a.attributeId) ?? {}
    rules[ids[index]] = { required, sortOrder: a.sortOrder }
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
      required: requirements.get(a.id),
      familyRules: familyRules.get(a.id),
      validation,
      group: { key: `master:${a.group.code}`, label: a.group.label },
      scope: a.scope === 'per_variant' ? 'per_variant' : 'global',
      options: MASTER_FIELD_OPTIONS[a.code] ?? a.options.map(o => o.code),
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
