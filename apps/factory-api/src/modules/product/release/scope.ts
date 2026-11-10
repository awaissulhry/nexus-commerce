import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { PRODUCT_BOM_RELEASE } from '@nexus/factory-domain/product/bom/permissions'
import type { GateView, ReleasedScopeView, SetScopeBody } from '@nexus/factory-domain/product/release/contracts'
import { isWhole, orderedScope, sameScope, scopeCells, scopeWords, waitingWords, widenProblems, type ReleaseScope, type ScopeStyle } from '@nexus/factory-domain/product/release/scope'
import type { WorkOrderScope } from '@nexus/factory-domain/product/release/work-orders'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { assertMayWrite, bumpRevision, contextOf, findRevision, lockStyleRow, readColourways, readRevisionFor } from '../bom/store'
import { requireEditRule } from '../lifecycle/edit-rule'
import { problemsOf, readScopeRow, type Reader } from './facts'
import { gateInTx } from './gate'

/**
 * What a revision is released for (B-W2b-231; PRD-191 "Release by colourway and size", PRD-197 "Release event"):
 *
 *   PUT …/revisions/:revisionId/release-scope   product.bom.release. On a DRAFT: planned, and W1's release takes it as it is
 *                                               (the Release modal's "Release only some colourways or sizes"; the draft's
 *                                               edit rule). On a RELEASED revision: a later release of the same revision for
 *                                               more colourways or sizes (never fewer; the release's edit rule), said again
 *                                               with style.revision_released {widened: true}. OBSOLETE: never.
 *   GET /product/styles/:styleId/release-scope  product.styles.view: what the style's current revision is released for (the
 *                                               readers: planning, quotes, the tech pack)
 *   readScope / releasedScopeOf                 the same for another module's API code (the work-order release reads it)
 *
 * Every rule of the database's StyleRevision_w2b4_release_scope is said in words first (400); a database refusal that still
 * comes (a race) is a 409 in the database's words, never a 500.
 */

/** A revision's scope (empty lists: every colourway or size). */
export async function readScope(db: Reader, revisionId: string): Promise<ReleaseScope> {
  return (await readScopeRow(db, revisionId)).scope
}

/** The database's refusal of a scope (StyleRevision_w2b4_release_scope) in its own words, as a 409; anything else unchanged. */
function scopeDatabaseRefusal(error: unknown): never {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (cause?.originalCode === '23514' && typeof cause.originalMessage === 'string' && /^product: (revision .* (released for|is OBSOLETE|is RELEASED; what)|the completeness score)/.test(cause.originalMessage)) {
    const words = cause.originalMessage.slice('product: '.length).replace(/revision [0-9a-f-]{36}/, 'the revision')
    throw new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}.`)
  }
  throw error
}

/** PUT /product/styles/:styleId/revisions/:revisionId/release-scope */
export async function setScope(caller: CommandCaller, styleId: string, revisionId: string, body: SetScopeBody, idempotencyKey?: string): Promise<GateView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_RELEASE, style.companyId)

  const { result } = await command(caller, { name: 'product.release.scope', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const locked = await lockStyleRow(tx, styleId)
    const row = await findRevision(tx, styleId, revisionId)
    if (locked.status === 'ARCHIVED') throw new InvalidStateError(`Style ${locked.code} is archived: reactivate it before a release.`)
    if (row.status === 'OBSOLETE') throw new InvalidStateError(`Revision ${row.revision} is obsolete: what it was released for never changes.`)
    const draft = row.status === 'DRAFT'
    // B-W2b-221: planning is a change of the draft (and so meets B-W2b-226's change order that holds it); a later release is a release.
    await requireEditRule(tx, styleId, draft ? 'DRAFT' : 'RELEASE')

    const held = await readScopeRow(tx, revisionId)
    const range = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { sizes: true } })
    const colourways = await readColourways(tx, styleId)
    const style: ScopeStyle = { colourways: colourways.map((colourway) => ({ id: colourway.id, code: colourway.code, status: colourway.status })), sizes: range.sizes }
    const before = orderedScope(held.scope, style)
    const next = orderedScope({ colourwayIds: body.colourwayIds, sizes: body.sizes }, style)
    // A later release that adds nothing is refused (the gate's preview of the same scope is not).
    const problems = !draft && sameScope(before, next) ? widenProblems(before, next, style, row.revision) : problemsOf(row, before, next, style)
    if (problems.length > 0) {
      throw new ValidationError(
        draft ? 'The release scope is not valid.' : `Revision ${row.revision} cannot be released for that.`,
        problems.map((problem) => ({ path: `body/${problem.path}`, message: problem.message })),
      )
    }

    const version = await bumpRevision(tx, revisionId, body.version, now, { releasedColourwayIds: [...next.colourwayIds], releasedSizes: [...next.sizes] }).catch(scopeDatabaseRefusal)
    const words = { before: scopeWords(before, style), after: scopeWords(next, style) }
    tools.audit({
      action: draft ? 'product.release.planScope' : 'product.release.widenScope',
      recordType: 'StyleRevision',
      recordId: revisionId,
      companyId: locked.companyId,
      before: { releasedColourwayIds: [...before.colourwayIds], releasedSizes: [...before.sizes], words: words.before },
      after: { releasedColourwayIds: [...next.colourwayIds], releasedSizes: [...next.sizes], words: words.after, version },
    })
    if (!draft) {
      // PRD-197: a later release of the same revision is a release for the readers (planning, quotes, the tech pack).
      tools.emit({
        type: 'style.revision_released',
        subject: styleId,
        companyId: locked.companyId,
        payload: {
          styleId,
          code: locked.code,
          revisionId,
          revision: row.revision,
          obsoletedRevisionId: null,
          releasedColourwayIds: [...next.colourwayIds],
          releasedSizes: [...next.sizes],
          completenessPct: held.completenessPct,
          widened: true,
        },
      })
    }
    return gateInTx(tools, styleId, revisionId)
  })
  return result
}

/** What the style's RELEASED revision is released for, with its cells (null revision: none released). */
export async function releasedScopeOf(db: Reader, styleId: string): Promise<ReleasedScopeView> {
  const style = await db.style.findUnique({ where: { id: styleId }, select: { id: true, code: true, sizes: true } })
  if (!style) throw new NotFoundError('Style not found.')
  const revision = await db.styleRevision.findFirst({ where: { styleId, status: 'RELEASED' }, select: { id: true, revision: true } })
  if (!revision) return { style: { id: style.id, code: style.code }, revision: null, scope: null, cells: [], waiting: null }
  const held = await readScopeRow(db, revision.id)
  const colourways = await readColourways(db, styleId)
  const scopeStyle: ScopeStyle = { colourways: colourways.map((colourway) => ({ id: colourway.id, code: colourway.code, status: colourway.status })), sizes: style.sizes }
  const scope = orderedScope(held.scope, scopeStyle)
  const cells = scopeCells(scope, scopeStyle)
  const codeOf = new Map(colourways.map((colourway) => [colourway.id, colourway.code]))
  return {
    style: { id: style.id, code: style.code },
    revision: { id: revision.id, revision: revision.revision, completenessPct: held.completenessPct },
    scope: { colourwayIds: [...scope.colourwayIds], sizes: [...scope.sizes], whole: isWhole(scope), words: scopeWords(scope, scopeStyle) },
    cells: cells.colourwayIds.flatMap((colourwayId) => cells.sizes.map((size) => ({ colourwayId, colourway: codeOf.get(colourwayId) ?? '', size }))),
    waiting: waitingWords(scope, scopeStyle),
  }
}

/** GET /product/styles/:styleId/release-scope: product.styles.view over the style's company. */
export async function releasedScopeFor(caller: CommandCaller, styleId: string): Promise<ReleasedScopeView> {
  const actor = actorOf(contextOf(caller))
  return caller.withClient(async (client) => {
    const style = await client.style.findUnique({ where: { id: styleId }, select: { companyId: true } })
    if (!style || !can(actor, PRODUCT_STYLES_VIEW, { companyId: style.companyId })) throw new NotFoundError('Style not found.')
    return releasedScopeOf(client, styleId)
  })
}

/**
 * The work-order release's read (production/work-orders facts.ts, B-W2b-231): what the work order's revision is released for,
 * with its words; null for a revision released for every colourway and size (or none).
 */
export async function workOrderScopeOf(db: Reader, revision: { readonly id: string; readonly revision: number; readonly styleId: string } | null, sizes: readonly string[]): Promise<WorkOrderScope | null> {
  if (!revision) return null
  const scope = await readScope(db, revision.id)
  if (isWhole(scope)) return null
  const colourways = await readColourways(db, revision.styleId)
  const style: ScopeStyle = { colourways: colourways.map((colourway) => ({ id: colourway.id, code: colourway.code, status: colourway.status })), sizes }
  return { revision: revision.revision, scope, words: scopeWords(orderedScope(scope, style), style) }
}
