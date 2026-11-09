import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { ANIMAL_ORIGIN_PHRASES, animalOriginText } from '@nexus/factory-domain/compliance/labels/rules'
import { COMPONENT_WORDS, computeComposition } from '@nexus/factory-domain/compliance/textile-rules/composition'
import { officialName, readFibre } from '@nexus/factory-domain/compliance/textile-rules/fibres'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { labelOf, revisionLines } from '../../compliance/textile-rules/facts'
import { appClock } from '../../../platform/portal/tasks/clock'
import { portalReader } from '../portal-orders/access'
import { readCatalogue } from './catalogue'

/**
 * The fibres of a style in the customer's catalogue, before the order (B-W2b-208; PRD-341; Reg. (EU) 1007/2011 art. 16(1):
 * the composition is shown before purchase, also online; design portal.customer.catalogue). Served at
 * `GET /portal/catalogue/:styleId/composition?language=` (modules/compliance/textile-rules/routes.ts; portal.catalogue.view,
 * the session's party). Read in the tenant's scope as the person, only for a style this customer's catalogue offers today
 * (./catalogue readCatalogue; any other is the same 404 as a style that does not exist).
 *
 *   LABEL   the released revision names an ACTIVE label: its typed composition, each fibre in its official name in the
 *           language asked when it is an Annex I name (else as typed), and its animal-origin phrase
 *   BOM     else computed from the released revision's BOM in the base size, per group of the colourways on offer, with
 *           the official names and the phrase when a non-textile part of animal origin is in it
 *   null    no released revision yet
 *
 * No material code, supplier, quantity or weight leaves: parts, fibres and percents only.
 */

const fibreIn = (typed: string, language: string): string => {
  const reading = readFibre(typed)
  return reading.kind === 'ANNEX' ? (officialName(reading.fibre, language) ?? officialName(reading.fibre, 'en') ?? typed) : typed
}

export interface CompositionInput {
  readonly companyId: string
  readonly partyId: string
  readonly day: BusinessDate
  readonly styleId: string
  readonly language: string
}

/** The composition answer of one style for one customer on a day; null when its catalogue does not offer the style. */
export async function compositionFor(db: FactoryClient, input: CompositionInput) {
  const { styleId, language } = input
  const found = await (async () => {
    const catalogue = await readCatalogue(db, { companyId: input.companyId, partyId: input.partyId, day: input.day, styleIds: [styleId] })
    const style = catalogue.styles.get(styleId)
    if (!style) return null
    if (style.revisionNow === null) return { revision: null, label: null, lines: null }
    const revision = await db.styleRevision.findFirst({ where: { styleId, revision: style.revisionNow }, select: { id: true, labelTemplateId: true } })
    if (!revision) return { revision: null, label: null, lines: null }
    const label = await labelOf(db, revision.labelTemplateId)
    if (label && label.facts.status === 'ACTIVE') return { revision: style.revisionNow, label, lines: null }
    const offered = style.colourways.filter((colourway) => colourway.available).map((colourway) => colourway.id)
    const size = style.baseSize && style.range.includes(style.baseSize) ? style.baseSize : (style.range[0] ?? null)
    return { revision: style.revisionNow, label: null, lines: await revisionLines(db, { styleId, revisionId: revision.id, size, only: offered }) }
  })()
  if (!found) return null

  if (found.label) {
    const facts = found.label.facts
    return {
      styleId,
      revision: found.revision,
      source: 'LABEL' as const,
      language,
      groups: [{ colourways: [], parts: facts.composition.map((part) => ({ part: part.part, fibres: part.fibres.map((share) => ({ fibre: fibreIn(share.fibre, language), percent: share.percent })) })) }],
      animalOrigin: facts.animalOriginPhrase ? (animalOriginText(facts.layout, language)?.text ?? ANIMAL_ORIGIN_PHRASES.en ?? null) : null,
      words: `As on the garment's label (revision ${found.revision}).`,
    }
  }
  if (!found.lines) {
    return { styleId, revision: null, source: null, language, groups: [], animalOrigin: null, words: 'The fibres are given once the style is released.' }
  }
  const computed = found.lines.colourways.map((set) => ({ colourway: set.colourway, value: computeComposition(set.lines) }))
  const groups: { colourways: string[]; parts: { part: string; fibres: { fibre: string; percent: string }[] }[]; key: string }[] = []
  let incomplete = false
  for (const entry of computed) {
    const parts = entry.value.parts.flatMap((part) => {
      if (part.fibres === null) {
        incomplete = true
        return []
      }
      const words = COMPONENT_WORDS[part.component] as Record<string, unknown>
      return [{ part: typeof words[language] === 'string' ? (words[language] as string) : part.part, fibres: part.fibres.map((fibre) => ({ fibre: fibreIn(fibre.fibre, language), percent: fibre.percent })) }]
    })
    const key = JSON.stringify(parts)
    const group = groups.find((candidate) => candidate.key === key)
    if (group) {
      if (entry.colourway !== null) group.colourways.push(entry.colourway)
    } else groups.push({ colourways: entry.colourway === null ? [] : [entry.colourway], parts, key })
  }
  const animal = computed.some((entry) => entry.value.animalParts.length > 0)
  return {
    styleId,
    revision: found.revision,
    source: 'BOM' as const,
    language,
    groups: groups.map(({ colourways, parts }) => ({ colourways, parts })),
    animalOrigin: animal ? (ANIMAL_ORIGIN_PHRASES[language] ?? ANIMAL_ORIGIN_PHRASES.en ?? null) : null,
    words: `From the materials of revision ${found.revision}${incomplete ? '; the fibres of some parts are not known yet' : ''}.`,
  }
}

/** GET /portal/catalogue/:styleId/composition?language= (the customer's portal session; read as the person). */
export async function catalogueComposition(app: FastifyInstance, request: FastifyRequest, styleId: string, query: { readonly language?: string | undefined }) {
  const reader = portalReader(app, request)
  if (!isUuid(styleId)) throw new NotFoundError('Style not found.')
  const language = (query.language ?? reader.session.person.locale ?? 'it').slice(0, 2).toLowerCase()
  const day = businessDate(appClock(app).now())
  const answer = await reader.inTenant((db) => compositionFor(db, { companyId: reader.session.company.id, partyId: reader.session.partyId, day, styleId, language }))
  // Not in the customer's catalogue: the same answer as a style that does not exist.
  if (!answer) throw new NotFoundError('Style not found.')
  return answer
}
