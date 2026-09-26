/**
 * P3 (docs/attributes/PLAN.md §4.1) — the pure half of the concept dictionary: what a concept becomes as a business
 * attribute. No database import, so the business-creation transaction (`workspace.service.ts`) can use it.
 */
import { randomUUID } from 'node:crypto'
import { customAttributeConcepts, type AttributeConcept, type ConceptGroup } from '@nexus/shared/attribute-concepts'

/** The group a concept's attribute is created in, by group code. Existing groups with the code are reused. */
export const GROUP_LABELS: Record<ConceptGroup, string> = {
  content: 'Content', identity: 'Identity', identifiers: 'Identifiers', variation: 'Variation',
  specifications: 'Specifications', dimensions: 'Dimensions and weight', compliance: 'Compliance and traceability',
}
export const GROUP_ORDER: ConceptGroup[] = ['identity', 'content', 'variation', 'specifications', 'identifiers', 'dimensions', 'compliance']

/** The stored attribute type and rules for a concept (the inverse of `attributeShapeOf` in `@nexus/shared/attributes`). */
export function attributeDefinitionFor(concept: AttributeConcept): { type: string; validation: Record<string, unknown> | null } {
  if (concept.shape === 'measure') return { type: 'number', validation: { shape: 'measure', ...(concept.unitOptions ? { unitOptions: concept.unitOptions } : {}) } }
  if (concept.kind === 'select') return concept.shape === 'list' ? { type: 'multiselect', validation: null } : { type: 'select', validation: null }
  const type = concept.kind === 'longtext' ? 'textarea' : concept.kind === 'number' || concept.kind === 'boolean' || concept.kind === 'date' ? concept.kind : 'text'
  return { type, validation: concept.shape === 'list' ? { shape: 'list' } : null }
}

/** Options a concept brings: only for a closed-list (`select`) concept; the rest stay open text until P6. */
export function optionsFor(concept: AttributeConcept): Array<{ code: string; label: string; synonyms: string[]; sortOrder: number }> {
  if (concept.kind !== 'select' || !concept.valueSynonyms) return []
  return Object.entries(concept.valueSynonyms).map(([code, spellings], sortOrder) => ({
    code: code.toLowerCase().replace(/[^a-z0-9_]+/g, '_'), label: spellings[0] ?? code, synonyms: spellings.slice(1), sortOrder,
  }))
}

export interface StarterDictionary {
  groups: Array<{ id: string; code: string; label: string; sortOrder: number }>
  attributes: Array<{ id: string; code: string; label: string; groupId: string; type: string; validation: Record<string, unknown> | null; localizable: boolean; scope: string; sortOrder: number; semanticKey: string }>
  options: Array<{ id: string; attributeId: string; code: string; label: string; synonyms: string[]; sortOrder: number }>
}

/** The dictionary a new business starts with. Pure: ids are generated here so one `createMany` per table suffices. */
export function starterDictionaryRows(newId: () => string = randomUUID): StarterDictionary {
  const concepts = customAttributeConcepts()
  const groups = GROUP_ORDER.filter(group => concepts.some(c => c.group === group))
    .map((code, sortOrder) => ({ id: newId(), code, label: GROUP_LABELS[code], sortOrder }))
  const groupId = new Map(groups.map(g => [g.code, g.id]))
  const attributes: StarterDictionary['attributes'] = []
  const options: StarterDictionary['options'] = []
  concepts.forEach((concept, sortOrder) => {
    const id = newId()
    attributes.push({ id, code: concept.key, label: concept.label, groupId: groupId.get(concept.group)!, ...attributeDefinitionFor(concept),
      localizable: concept.localizable, scope: concept.scope, sortOrder, semanticKey: concept.key })
    for (const option of optionsFor(concept)) options.push({ id: newId(), attributeId: id, ...option })
  })
  return { groups, attributes, options }
}
