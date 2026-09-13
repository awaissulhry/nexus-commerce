/**
 * VT.1b item 4 — the SERVER-SIDE narrowing for the catalogue's `Variation mapping` filter (VX §11.4, VT.4's dimension).
 *
 * The wire parameter is `?variationMapping=derived|rule|overridden|unset|collides` — the same pipe-separated words the
 * page's `?filter=variation-mapping:…` term carries, so there is no translation table between the URL an operator
 * pastes and the predicate the database runs.
 *
 * Two sources, because one fact has one home:
 *  - `derived` / `rule` / `overridden` come from `ReadinessIndex.variationSource` (VT.1b's column). They are invisible
 *    to any other predicate: a CORRECT mapping raises no readiness item, so without a column there is nothing to match.
 *  - `unset` / `collides` come from `ReadinessIndex.missing[].kind` (`theme-unset` / `collision`) — LX.F's P2-14 field,
 *    the FACT beside the sentence, so the filter never matches prose that is free to change.
 *
 * 🔴 `variationSource IS NULL` means NOT COMPUTED — a row written before the column existed, or a child row, which has
 * no projection of its own. It is matched by NO value, and in particular never by `derived`: an index that has not been
 * rebuilt must not answer a provenance question at all. That is R-LX-9's lesson, one table over.
 */

import { Prisma } from '@prisma/client'
import prisma from '../../db.js'

export const VARIATION_MAPPING_VALUES = ['derived', 'rule', 'overridden', 'unset', 'collides'] as const
export type VariationMappingValue = (typeof VARIATION_MAPPING_VALUES)[number]

/** The provenance values that live in the column; the other two are `missing[].kind` questions. */
const PROVENANCE: ReadonlySet<string> = new Set(['derived', 'rule', 'overridden'])
const KIND_OF: Record<string, string> = { unset: 'theme-unset', collides: 'collision' }

/**
 * Parse the wire term. Unknown words are DROPPED and returned separately so the caller can name them — a filter that
 * silently ignores a value an operator typed is a filter that lies about what it applied.
 */
export function parseVariationMappingFilter(raw: string | undefined | null): { values: VariationMappingValue[]; unsupported: string[] } {
  const parts = String(raw ?? '').split(/[|,]/).map((s) => s.trim().toLowerCase()).filter(Boolean)
  const values: VariationMappingValue[] = []
  const unsupported: string[] = []
  for (const part of parts) {
    if ((VARIATION_MAPPING_VALUES as readonly string[]).includes(part)) {
      if (!values.includes(part as VariationMappingValue)) values.push(part as VariationMappingValue)
    } else if (!unsupported.includes(part)) unsupported.push(part)
  }
  return { values, unsupported }
}

/**
 * The product ids that match, or `null` when the filter is not active at all (the caller then narrows nothing).
 *
 * An ACTIVE filter with no matching value — every word unsupported — returns `[]` rather than `null`: "you asked for
 * something I cannot answer" must narrow to nothing visibly, not widen to everything silently (LX.F's P2-16 rule for
 * the sibling filter, followed here).
 *
 * The scan is bounded by the ids the rest of the scope already admits, exactly as `restrictCatalogLanguage` does.
 */
export async function restrictVariationMapping(
  raw: string | undefined | null,
  candidateIds: string[],
): Promise<string[] | null> {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  const { values } = parseVariationMappingFilter(raw)
  if (values.length === 0) return []
  if (candidateIds.length === 0) return []

  const provenance = values.filter((v) => PROVENANCE.has(v))
  const kinds = values.map((v) => KIND_OF[v]).filter(Boolean)

  const terms: Prisma.Sql[] = []
  if (provenance.length > 0) terms.push(Prisma.sql`r."variationSource" IN (${Prisma.join(provenance)})`)
  for (const kind of kinds) {
    // `missing` is a JSON array of objects; the containment operator uses the column's own index-friendly form.
    terms.push(Prisma.sql`r.missing @> ${JSON.stringify([{ kind }])}::jsonb`)
  }
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT p.id FROM "Product" p
      JOIN "ReadinessIndex" r ON r."productId" = p.id AND r."workspaceId" = p."workspaceId"
    WHERE p.id IN (${Prisma.join(candidateIds)}) AND (${Prisma.join(terms, ' OR ')})`)
  return rows.map((row) => row.id)
}
