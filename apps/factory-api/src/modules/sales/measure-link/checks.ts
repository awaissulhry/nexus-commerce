import type { Issue } from '@nexus/factory-domain/core/errors'
import { checkRules, wordsIn, type Measures } from '@nexus/factory-domain/product/mtm-rules/rules'
import { readTemplate, ruleFieldsOf, templatePointsOf, type Reader } from '../../product/mtm-rules/store'

/**
 * The made-to-measure rules on measures sent by link (B-W2b-248 calls the rules only; PRD-201): the plausibility rules of
 * the profile's garment type's template (MeasurementTemplate.code = garmentType), read as the tenant's system, and only
 * while the template's rules are on (GATE-MTM: built off; while off the link behaves as before). A broken BLOCK rule
 * refuses the send at the point it checks (`body/values/<code>`: the page sends the rider back to that point), in the
 * rider's language; a broken WARN rule goes with the revision (its audit row) and the send's answer. The base size and the
 * alteration limits need a style: they are the office's check (modules/product/mtm-rules), not the rider's.
 */

export interface LinkRuleWarning {
  readonly code: string
  readonly pointCode: string
  readonly message: string
}

export interface LinkRuleChecks {
  /** The template's rules are on (else nothing was checked). */
  readonly on: boolean
  readonly blocks: Issue[]
  readonly warnings: LinkRuleWarning[]
}

export async function linkRuleChecks(db: Reader, garmentType: string, measures: Measures, locale: string): Promise<LinkRuleChecks> {
  const record = await readTemplate(db, { code: garmentType })
  if (!record || !record.template.rulesOn) return { on: false, blocks: [], warnings: [] }
  const results = checkRules(ruleFieldsOf(record.rules, record.points), templatePointsOf(record.points), measures).filter((result) => result.outcome === 'BROKEN')
  const words = (result: (typeof results)[number]): string => wordsIn(result.words, locale) ?? result.detail
  return {
    on: true,
    blocks: results.filter((result) => result.severity === 'BLOCK').map((result) => ({ path: `body/values/${result.pointCode}`, message: words(result) })),
    warnings: results.filter((result) => result.severity === 'WARN').map((result) => ({ code: result.code, pointCode: result.pointCode, message: words(result) })),
  }
}
