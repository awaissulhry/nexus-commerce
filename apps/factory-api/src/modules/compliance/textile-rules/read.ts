import type { FastifyRequest } from 'fastify'
import { ANIMAL_ORIGIN_PHRASES } from '@nexus/factory-domain/compliance/labels/rules'
import { careVocabulary } from '@nexus/factory-domain/compliance/textile-rules/care'
import { COMPONENT_WORDS, COMPONENTS, type ComputedPart } from '@nexus/factory-domain/compliance/textile-rules/composition'
import { ANNEX_I_FIBRES, readFibre } from '@nexus/factory-domain/compliance/textile-rules/fibres'
import { TEXTILE_RULES_VIEW } from '@nexus/factory-domain/compliance/textile-rules/permissions'
import { SWITCHABLE_RULES, textileChecks } from '@nexus/factory-domain/compliance/textile-rules/rules'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { actorOf } from '../../../core/context'
import { officeOf } from '../labels/store'
import { labelOf, plantsOf, revisionLines, routingSteps, type Reader } from './facts'
import { readSwitchStates, switchesOf, textileRulesClock } from './switches'

/**
 * The textile, leather and origin checks of a style revision, read side (B-W2b-208; PRD-338 … PRD-345; design
 * compliance.labels › Label builder "fibre composition per part computed from the BOM with official names · animal-origin
 * phrase (automatic) · care symbols · origin claim with check · leather naming check" and › Rule checks; the style's
 * composition computed from the BOM, B-W2b-270). Office only, compliance.certificates.view over the style's company; a
 * style the caller may not see is not found. Reads only: nothing is written, no audit row.
 *
 *   revision   the one asked (of this style), else the RELEASED one, else the newest draft, else the newest
 *   size       the one asked (of the style's range), else the base size, else the first of the range
 *   site       the one plant asked for the in-house steps of "Made in Italy" (a site of the style's company), else every
 *              ACTIVE plant of the company
 */

export interface ChecksQuery {
  readonly revisionId?: string | undefined
  readonly size?: string | undefined
  readonly siteId?: string | undefined
}

const STYLE_SELECT = { id: true, code: true, name: true, nameI18n: true, description: true, companyId: true, sizes: true, baseSize: true, originCountry: true, netMassKg: true } as const

const textRecord = (value: unknown): Record<string, string> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : null

/** A computed part with each fibre's official names (for the label's languages). */
const partView = (part: ComputedPart) => ({
  ...part,
  words: { ...part.words },
  materials: [...part.materials],
  fibres:
    part.fibres?.map((fibre) => {
      const reading = readFibre(fibre.fibre)
      return { ...fibre, names: reading.kind === 'ANNEX' ? { ...reading.fibre.names } : {} }
    }) ?? null,
})

async function readStyle(db: Reader, request: FastifyRequest, styleId: string) {
  if (!isUuid(styleId)) throw new NotFoundError('Style not found.')
  const style = await db.style.findUnique({ where: { id: styleId }, select: STYLE_SELECT })
  if (!style || !can(actorOf(officeOf(request)), TEXTILE_RULES_VIEW, { companyId: style.companyId })) throw new NotFoundError('Style not found.')
  return style
}

/** GET /compliance/textile-rules/styles/:styleId */
export async function styleChecks(request: FastifyRequest, styleId: string, query: ChecksQuery) {
  const context = officeOf(request)
  return request.withClient(async (db) => {
    const style = await readStyle(db, request, styleId)
    const revisions = await db.styleRevision.findMany({ where: { styleId }, select: { id: true, revision: true, status: true, labelTemplateId: true }, orderBy: { revision: 'desc' } })
    let revision = revisions.find((row) => row.status === 'RELEASED') ?? revisions.find((row) => row.status === 'DRAFT') ?? revisions[0] ?? null
    if (query.revisionId !== undefined) {
      revision = revisions.find((row) => row.id === query.revisionId) ?? null
      if (!revision) throw new ValidationError('The revision is not valid.', [{ path: 'querystring/revisionId', message: 'Not a revision of the style.' }])
    }
    if (!revision) throw new NotFoundError(`Style ${style.code} has no revision yet: its BOM and routing are where the checks read.`)
    if (query.size !== undefined && !style.sizes.includes(query.size)) {
      throw new ValidationError('The size is not valid.', [{ path: 'querystring/size', message: `Not a size of style ${style.code} (${style.sizes.join(', ')}).` }])
    }
    const size = query.size ?? (style.baseSize && style.sizes.includes(style.baseSize) ? style.baseSize : (style.sizes[0] ?? null))
    let site: { id: string; code: string } | null = null
    if (query.siteId !== undefined) {
      const row = isUuid(query.siteId) ? await db.site.findUnique({ where: { id: query.siteId }, select: { id: true, code: true, companyId: true } }) : null
      if (!row || (style.companyId !== null && row.companyId !== style.companyId)) {
        throw new ValidationError('The site is not valid.', [{ path: 'querystring/siteId', message: `Not a site of the company that makes style ${style.code}.` }])
      }
      site = { id: row.id, code: row.code }
    }

    const lines = await revisionLines(db, { styleId, revisionId: revision.id, size })
    const label = await labelOf(db, revision.labelTemplateId)
    const steps = await routingSteps(db, revision.id)
    const plants = await plantsOf(db, style.companyId, site?.id ?? null)
    const states = await readSwitchStates(db, context.tenantId)
    const report = textileChecks(
      {
        style: { code: style.code, name: style.name, nameI18n: textRecord(style.nameI18n), description: style.description, originCountry: style.originCountry, netMassKg: style.netMassKg?.toFixed() ?? null },
        revision: revision.revision,
        label: label?.facts ?? null,
        colourways: lines.colourways,
        materials: lines.materials,
        steps,
        plants,
      },
      switchesOf(states),
    )
    return {
      style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, originCountry: style.originCountry, netMassKg: style.netMassKg?.toFixed() ?? null },
      revision: { id: revision.id, revision: revision.revision, status: revision.status },
      size,
      site,
      label: label ? { id: label.id, code: label.facts.code, revision: label.facts.revision, status: label.facts.status, languages: [...label.facts.languages] } : null,
      switches: SWITCHABLE_RULES.map((rule) => ({ rule, on: states[rule].on })),
      composition: report.composition.map((group) => ({ colourways: [...group.colourways], parts: group.value.parts.map(partView), findings: [...group.value.findings] })),
      textileShare: report.textileShare.map((group) => ({ colourways: [...group.colourways], ...group.value, missing: [...group.value.missing], findings: [...group.value.findings] })),
      animalOrigin: { needed: report.animalOrigin.needed, materials: [...report.animalOrigin.materials], phrases: [...report.animalOrigin.phrases] },
      care: { entries: report.care.entries.map((entry) => ({ ...entry, words: [...entry.words] })), missingGroups: [...report.care.missingGroups] },
      origin: { ...report.origin, steps: report.origin.steps.map((step) => ({ ...step, places: [...step.places] })), findings: [...report.origin.findings] },
      results: report.results.map((result) => ({ ...result, law: [...result.law], findings: [...result.findings] })),
      asOf: toUtcIso(textileRulesClock().now()),
    }
  })
}

/** GET /compliance/textile-rules/vocabulary: what the label builder offers (official fibre names, care words, phrases, parts). */
export function vocabulary(request: FastifyRequest) {
  officeOf(request)
  return {
    fibres: ANNEX_I_FIBRES.map((fibre) => ({ key: fibre.key, names: { ...fibre.names }, aliases: [...fibre.aliases], brands: [...(fibre.brands ?? [])] })),
    care: careVocabulary(),
    animalOrigin: Object.entries(ANIMAL_ORIGIN_PHRASES).map(([language, text]) => ({ language, text })),
    components: COMPONENTS.map((component) => ({ component, words: { en: COMPONENT_WORDS[component].en, it: COMPONENT_WORDS[component].it } })),
    weight: 'A material\'s weight is read from its attribute "weight": "180 g/m2", "45 g/m", "120 g/pcs" ("120 g" is per one of its base unit).',
  }
}
