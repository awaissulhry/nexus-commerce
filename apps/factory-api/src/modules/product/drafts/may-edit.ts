import type { FactoryClient } from '@nexus/factory-db'
import { DomainError, ForbiddenError } from '@nexus/factory-domain/core/errors'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { PRODUCT_DRAFTS_EDIT } from '@nexus/factory-domain/product/drafts/permissions'
import { designerMayWrite, DRAFT_EDIT_REFUSALS, type DraftEditRefusal, type DraftState } from '@nexus/factory-domain/product/drafts/refusals'
import { PRODUCT_STYLES_MANAGE } from '@nexus/factory-domain/product/styles/permissions'
import type { CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { mayWrite } from '../materials/store'

/**
 * The designer's right (owb-pd1 1.4; S4 settle 6; base settle 5): the ONE check of every write route a designer may use on a
 * product draft. The route's manifest asks the READ right (product.styles.view or product.bom.view, which every holder of the
 * manage right holds too); this check asks the write:
 *
 *   manage    the route's manage right (product.styles.manage or product.bom.manage) over the style's company: as before, the
 *             revision's own state is the route's business (a released revision refuses its own way, the database too).
 *   designer  else product.drafts.edit over the style's company, while the revision written is DRAFT (a style-level write: the
 *             style's newest revision is DRAFT, or it has none yet) — else 409 `refusal/DRAFT_ONLY` in words.
 *   neither   403 (a style of every company: the words of the style library's own check).
 *
 * Used by: styles (create, patch, start a revision), bom (lines, sizes, colours, copy into the next draft), measures (the spec of a
 * DRAFT revision; a point's how-to words: ./points.ts asks `mayManageOrDesign`), protectors, images (pictures and callouts).
 */

export type { DraftState }

/** A refusal of the designer's right in words (DRAFT_ONLY: 409; the others: 403). */
export function draftRefusal(code: DraftEditRefusal): DomainError {
  const message = DRAFT_EDIT_REFUSALS[code].en
  return new DomainError(code === 'DRAFT_ONLY' ? 'conflict' : 'forbidden', message, [{ path: `refusal/${code}`, message }])
}

/** The person holds the route's manage right over the company (the designer's limits do not apply). */
export const mayManage = (context: RequestContext, companyId: string | null, manage: Permission = PRODUCT_STYLES_MANAGE): boolean => mayWrite(actorOf(context), manage, companyId)

/** The person holds product.drafts.edit over the company. */
export const mayDesign = (context: RequestContext, companyId: string | null): boolean => mayWrite(actorOf(context), PRODUCT_DRAFTS_EDIT, companyId)

/** The check (see the header): manage, or the designer on a DRAFT; else 409 DRAFT_ONLY or 403. */
export function assertMayEditDraft(context: RequestContext, companyId: string | null, revisionStatus: DraftState, manage: Permission = PRODUCT_STYLES_MANAGE): void {
  if (mayManage(context, companyId, manage)) return
  if (mayDesign(context, companyId)) {
    if (designerMayWrite(revisionStatus)) return
    throw draftRefusal('DRAFT_ONLY')
  }
  throw new ForbiddenError(companyId === null ? 'A style for every company is changed only by a role over every company.' : undefined)
}

/** The style's newest revision's status (a style-level write follows it), or null: none yet. */
export async function newestRevisionStatus(client: FactoryClient | CommandTx, styleId: string): Promise<DraftState> {
  const newest = await client.styleRevision.findFirst({ where: { styleId }, select: { status: true }, orderBy: { revision: 'desc' } })
  return newest?.status ?? null
}
