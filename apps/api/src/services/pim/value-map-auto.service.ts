/**
 * P5 (docs/attributes/PLAN.md §4.3) — match the values a business uses to a channel's closed lists, automatically.
 *
 * For every field of one (channel × market × category) whose rule reads the value maps (an automatic link into a
 * STRICT list, `master-default-rule.ts`), it takes the distinct values the business stores for that attribute and:
 *   · a value that already IS one of the channel's options needs nothing;
 *   · a value a value-map row already covers needs nothing;
 *   · otherwise the ladder (`matchConceptValue`): same text ignoring case/accents, then the concept's synonyms
 *     (`Nero` → `Black`). A match becomes a value-map row — one row fixes the value for every product;
 *   · a value nothing matches is RETURNED, never guessed: it is the list the operator maps by hand (P6's "Map it").
 *
 * Dry run unless told otherwise. Rows it writes say how they were made (`AUTO_EXACT` / `AUTO_SYNONYM`).
 */
import prisma from '../../db.js'
import { conceptForChannelField, conceptFieldToken, matchConceptValue, type AttributeConcept } from '@nexus/shared/attribute-concepts'
import type { AttributeChannel } from '@nexus/shared/attributes'
import { getFieldCatalogue } from './mapping/field-catalogue.service.js'
import { clearValueMapCaches } from './value-map.service.js'

export interface AutoMatchField {
  fieldKey: string
  label: string
  attribute: string
  concept: string | null
  matched: Array<{ from: string; to: string; how: 'exact' | 'synonym' }>
  unmatched: string[]
  alreadyValid: number
  alreadyMapped: number
}

export interface AutoMatchResult { applied: boolean; written: number; fields: AutoMatchField[] }

/** The distinct stored values of one master attribute: its own key, and a variation axis of the same name. */
export async function distinctAttributeValues(attribute: string, axisNames: string[] = []): Promise<string[]> {
  const direct = await prisma.$queryRaw<Array<{ value: string }>>`
    SELECT DISTINCT v AS value FROM "Product" p,
      LATERAL jsonb_array_elements_text(CASE jsonb_typeof(p."categoryAttributes" -> ${attribute})
        WHEN 'array' THEN p."categoryAttributes" -> ${attribute}
        WHEN 'string' THEN jsonb_build_array(p."categoryAttributes" -> ${attribute})
        ELSE '[]'::jsonb END) v
    WHERE p."deletedAt" IS NULL AND jsonb_exists(p."categoryAttributes", ${attribute})`
  const axes = await prisma.$queryRaw<Array<{ key: string; value: string }>>`
    SELECT DISTINCT e.key AS key, e.value #>> '{}' AS value FROM "Product" p,
      LATERAL jsonb_each(CASE WHEN jsonb_typeof(p."categoryAttributes" -> 'variations') = 'object' THEN p."categoryAttributes" -> 'variations' ELSE '{}'::jsonb END) e
    WHERE p."deletedAt" IS NULL AND jsonb_typeof(e.value) = 'string'`
  const wanted = new Set([attribute, ...axisNames].map(conceptFieldToken))
  const values = new Set(direct.map(row => row.value.trim()).filter(Boolean))
  for (const row of axes) if (wanted.has(conceptFieldToken(row.key)) && row.value.trim()) values.add(row.value.trim())
  return [...values].sort()
}

/** Axis names a variation store may use for a concept: its key, label and the channels' names for it. */
function axisNamesFor(concept: AttributeConcept | null): string[] {
  if (!concept) return []
  return [concept.key, concept.label, ...Object.values(concept.bindings).flat()]
}

export async function autoMatchValueMaps(input: { channel: string; marketplace: string; productType?: string | null; dryRun?: boolean }): Promise<AutoMatchResult> {
  const channel = input.channel.toUpperCase() as AttributeChannel
  const dryRun = input.dryRun ?? true
  const catalogue = await getFieldCatalogue({ channel, marketplace: input.marketplace, productType: input.productType ?? null })
  const fields: AutoMatchField[] = []
  const rows: Array<{ channel: string; marketplace: string; attribute: string; fromValue: string; toValue: string; confidence: string; reviewedAt: Date }> = []
  for (const field of catalogue.fields) {
    const valueMap = field.rule?.transforms?.find(t => t.type === 'valueMap') as { type: 'valueMap'; attribute: string } | undefined
    const options = field.options ?? []
    if (!valueMap || !field.selectionOnly || !options.length) continue
    const concept = conceptForChannelField(channel, field.fieldKey, field.label) ?? null
    const [values, existing] = await Promise.all([
      distinctAttributeValues(valueMap.attribute, axisNamesFor(concept)),
      prisma.fieldValueMap.findMany({ where: { channel, marketplace: { in: [input.marketplace, '*'] }, attribute: valueMap.attribute }, select: { fromValue: true } }),
    ])
    const mapped = new Set(existing.map(row => row.fromValue))
    const entry: AutoMatchField = { fieldKey: field.fieldKey, label: field.label, attribute: valueMap.attribute, concept: concept?.key ?? null,
      matched: [], unmatched: [], alreadyValid: 0, alreadyMapped: 0 }
    for (const value of values) {
      if (options.includes(value)) { entry.alreadyValid++; continue }
      if (mapped.has(value)) { entry.alreadyMapped++; continue }
      const match = matchConceptValue(concept ?? undefined, value, options, field.optionLabels)
      if (!match) { entry.unmatched.push(value); continue }
      entry.matched.push({ from: value, ...match })
      rows.push({ channel, marketplace: input.marketplace, attribute: valueMap.attribute, fromValue: value, toValue: match.to,
        confidence: match.how === 'exact' ? 'AUTO_EXACT' : 'AUTO_SYNONYM', reviewedAt: new Date() })
    }
    fields.push(entry)
  }
  if (dryRun || !rows.length) return { applied: false, written: 0, fields }
  // Two fields reading the same attribute propose the same row; the unique key keeps one.
  const { count } = await prisma.fieldValueMap.createMany({ data: rows, skipDuplicates: true })
  clearValueMapCaches()
  return { applied: true, written: count, fields }
}
