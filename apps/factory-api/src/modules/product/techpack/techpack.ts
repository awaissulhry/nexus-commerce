import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import type { StyleComplianceView } from '@nexus/factory-domain/product/compliance/contracts'
import type { TechPackQuery, TechPackView } from '@nexus/factory-domain/product/techpack/contracts'
import { orderedSections, SECTION_WORDS, type TechPackAudience, type TechPackLanguage, type TechPackSection } from '@nexus/factory-domain/product/techpack/rules'
import { techPackViewOf, type TechPackFacts } from '@nexus/factory-domain/product/techpack/view'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { contextOf, readRevisionFor, type RevisionRow } from '../bom/store'
import { styleCompliance } from '../compliance/read'
import { loadTechPack, readTechPackStyle, type TechPackStyleRow } from './facts'

/**
 * The live tech pack through the API (B-W2b-230; PRD-130, PRD-133, PRD-134, PRD-136, PRD-147; design products.styles
 * `style.techpack`):
 *
 *   GET /product/styles/:styleId/revisions/:revisionId/tech-pack?audience&language&sections&companyId
 *       product.bom.view over the style's company: the view by section for an audience (the screen's preview of a partner
 *       copy is the copy itself: what the audience never gets is left out here, on the server). The construction section
 *       also needs product.routing.view, the protection and compliance sections compliance.certificates.view (each section
 *       says `allowed` and why not). A BOM line's standard cost and its cost at the base size: the INTERNAL audience and the
 *       cost grain only (marked money.cost; the serializer drops them for anyone else).
 */

/** The sections the caller may not see over a company, with why (its permissions). */
export function notAllowedFor(actor: Actor, companyId: string | null): Partial<Record<TechPackSection, string>> {
  const scope = companyId === null ? {} : { companyId }
  const out: Partial<Record<TechPackSection, string>> = {}
  if (!can(actor, 'product.routing.view', scope)) out.CONSTRUCTION = `The ${SECTION_WORDS.CONSTRUCTION.toLowerCase()} section shows the routing: it needs product.routing.view.`
  if (!can(actor, 'compliance.certificates.view', scope)) {
    out.PROTECTION = `The ${SECTION_WORDS.PROTECTION.toLowerCase()} section shows the certificates: it needs compliance.certificates.view.`
    out.COMPLIANCE = `The ${SECTION_WORDS.COMPLIANCE.toLowerCase()} section shows the certificates: it needs compliance.certificates.view.`
  }
  return out
}

/** The company whose instructions, packing rules and tests a copy reads: the style's; a tenant-wide style's: the one named or the screen's. */
export function companyOfCopy(context: RequestContext, style: { readonly code: string; readonly companyId: string | null }, named: string | undefined, at: string): string | null {
  if (style.companyId !== null) {
    if (named !== undefined && named !== style.companyId) throw new ValidationError('The company is not valid.', [{ path: `${at}/companyId`, message: `Style ${style.code} is one company's: its tech pack is that company's.` }])
    return style.companyId
  }
  const company = named ?? (context.audience === 'office' ? context.companyId : undefined) ?? null
  if (company !== null && !can(actorOf(context), 'product.bom.view', { companyId: company })) throw new ValidationError('The company is not valid.', [{ path: `${at}/companyId`, message: 'Not a company you work in.' }])
  return company
}

/** The style and revision as the caller may read their BOM (else not found), with the columns the tech pack reads. */
export async function readTechPackTarget(caller: CommandCaller, styleId: string, revisionId: string): Promise<{ style: TechPackStyleRow; revision: RevisionRow }> {
  const { revision } = await readRevisionFor(caller, styleId, revisionId)
  const style = await caller.withClient((client) => readTechPackStyle(client, styleId))
  if (!style) throw new NotFoundError('Style not found.')
  return { style, revision }
}

export interface Composed {
  readonly facts: TechPackFacts
  readonly view: TechPackView
}

/** The facts and the audience's view of one revision, read as the caller. */
export async function composeTechPack(
  caller: CommandCaller,
  target: { readonly style: TechPackStyleRow; readonly revision: RevisionRow },
  ask: { readonly audience: TechPackAudience; readonly language: TechPackLanguage; readonly sections: readonly TechPackSection[]; readonly companyId: string | null; readonly costs: boolean },
): Promise<Composed> {
  const context = contextOf(caller)
  const actor = actorOf(context)
  const { style, revision } = target
  const notAllowed = notAllowedFor(actor, style.companyId)
  const wanted = new Set(ask.sections)
  const needsCompliance = (wanted.has('PROTECTION') || wanted.has('COMPLIANCE')) && notAllowed.PROTECTION === undefined
  const compliance: StyleComplianceView | null = needsCompliance ? await styleCompliance(caller, style.id, { revisionId: revision.id }) : null
  const facts = await caller.withClient((client) =>
    loadTechPack(client, style, revision, {
      language: ask.language,
      construction: wanted.has('CONSTRUCTION') && notAllowed.CONSTRUCTION === undefined,
      compliance,
      companyId: ask.companyId,
      costs: ask.costs,
      seesTestsOf: (companyId) => can(actor, 'compliance.certificates.view', { companyId }),
    }),
  )
  return { facts, view: techPackViewOf(facts, { audience: ask.audience, language: ask.language, sections: ask.sections, notAllowed }) }
}

/** GET /product/styles/:styleId/revisions/:revisionId/tech-pack */
export async function techPackFor(caller: CommandCaller, styleId: string, revisionId: string, query: TechPackQuery): Promise<TechPackView> {
  const context = contextOf(caller)
  const target = await readTechPackTarget(caller, styleId, revisionId)
  const companyId = companyOfCopy(context, target.style, query.companyId, 'querystring')
  const costs = query.audience === 'INTERNAL' && heldGrains(actorOf(context)).has('cost')
  const { view } = await composeTechPack(caller, target, { audience: query.audience, language: query.language, sections: orderedSections(query.sections), companyId, costs })
  return view
}
