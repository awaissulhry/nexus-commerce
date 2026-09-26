/**
 * P3 (docs/attributes/PLAN.md §4.1) — the pure half of the concept dictionary: what a concept becomes as a business
 * attribute. No database import, so the business-creation transaction (`workspace.service.ts`) can use it.
 */
import { randomUUID } from 'node:crypto'
import { conceptOptionCode, customAttributeConcepts, type AttributeConcept, type ConceptGroup, type ValueLabels, type ValueLanguage } from '@nexus/shared/attribute-concepts'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'

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

/**
 * Open-text concepts whose value list still becomes the attribute's options (suggestions; the list stays open): the
 * variation axes. The Owner's "option A", 2026-09-26 — this lane owns them; the variation-theme lane links to them.
 */
export const SEEDED_OPTION_CONCEPTS = ['color', 'size'] as const

export interface ConceptOptionRow { code: string; label: string; synonyms: string[]; sortOrder: number; metadata?: { labels: ValueLabels } }

/** The primary content language as a concept label language (`it-IT` → `it`); English when the concepts have none. */
export function conceptLabelLanguage(locale: string = PRIMARY_CONTENT_LOCALE): ValueLanguage {
  const language = locale.split('-')[0]
  return (['en', 'it', 'de', 'fr', 'es'] as string[]).includes(language) ? language as ValueLanguage : 'en'
}

/**
 * One seeded option of a concept value: code = `conceptOptionCode`, label = the value's text in `language` (else its
 * first spelling), `metadata.labels` = every language (where the concept has them), synonyms = every other spelling.
 */
export function seededOption(concept: AttributeConcept, valueCode: string, sortOrder: number, language: ValueLanguage = conceptLabelLanguage()): ConceptOptionRow {
  const spellings = concept.valueSynonyms?.[valueCode] ?? []
  const labels = concept.valueLabels?.[valueCode]
  const label = labels?.[language] ?? spellings[0] ?? valueCode
  return { code: conceptOptionCode(valueCode), label, sortOrder,
    synonyms: [...new Set([...spellings, ...(labels ? Object.values(labels) : [])])].filter(text => text !== label),
    ...(labels ? { metadata: { labels } } : {}) }
}

/**
 * Options a concept brings when its attribute is created: a closed-list (`select`) concept's values (English label, as
 * since P3), and the seeded open-text concepts' values (`SEEDED_OPTION_CONCEPTS`, labelled in the primary content
 * language). Other open-text concepts get none; their dropdown comes from the channels (P6).
 */
export function optionsFor(concept: AttributeConcept, language: ValueLanguage = conceptLabelLanguage()): ConceptOptionRow[] {
  if (!concept.valueSynonyms) return []
  const values = Object.entries(concept.valueSynonyms)
  if (concept.kind === 'select') {
    return values.map(([code, spellings], sortOrder) => ({ code: conceptOptionCode(code), label: spellings[0] ?? code, synonyms: spellings.slice(1), sortOrder }))
  }
  if (!(SEEDED_OPTION_CONCEPTS as readonly string[]).includes(concept.key)) return []
  return values.map(([code], sortOrder) => seededOption(concept, code, sortOrder, language))
}

export interface StarterDictionary {
  groups: Array<{ id: string; code: string; label: string; sortOrder: number }>
  attributes: Array<{ id: string; code: string; label: string; groupId: string; type: string; validation: Record<string, unknown> | null; localizable: boolean; scope: string; sortOrder: number; semanticKey: string }>
  options: Array<{ id: string; attributeId: string } & ConceptOptionRow>
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
