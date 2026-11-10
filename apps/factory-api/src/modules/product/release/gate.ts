import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PRODUCT_BOM_RELEASE } from '@nexus/factory-domain/product/bom/permissions'
import type { GateQuery, GateView } from '@nexus/factory-domain/product/release/contracts'
import { effectsOf, releaseGate, type GateFinding, type ReleaseGate } from '@nexus/factory-domain/product/release/gate'
import { isWhole, sameScope, scopeWords, waitingWords, type ReleaseScope, type ScopeStyle } from '@nexus/factory-domain/product/release/scope'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { contextOf, findRevision, readRevisionFor, STYLE_COLUMNS, type BomStyleRow, type RevisionRow } from '../bom/store'
import { mayWrite } from '../materials/store'
import { loadGate, type LoadedGate, type Reader } from './facts'

/**
 * The release gate through the API (B-W2b-231; PRD-190, PRD-191, PRD-197, PRD-232):
 *
 *   GET …/revisions/:revisionId/release-gate   the Release modal: the checklist with "Fix" per item, the completeness score,
 *                                              the scope planned and asked ("Release only some colourways or sizes": a
 *                                              preview), the suggested scope, what happens in words (product.bom.view)
 *   releaseGateInCommand                       inside W1's release (modules/product/bom revisions.ts releaseRevision, after
 *                                              its own checks and the change order's): every blocker refused at once in
 *                                              words (409), the score and the scope returned for the release's UPDATE and
 *                                              style.revision_released, and one audit row with what the person released over
 */

export const todayNow = (): BusinessDate => businessDate(serverClock.now())

const scopeViewOf = (scope: ReleaseScope, style: ScopeStyle) => ({ colourwayIds: [...scope.colourwayIds], sizes: [...scope.sizes], whole: isWhole(scope), words: scopeWords(scope, style) })

/** The gate view of a loaded revision for a reader (its effects and counts as the reader may see them). */
export function gateViewOf(loaded: LoadedGate, gate: ReleaseGate, style: BomStyleRow, revision: RevisionRow, context: RequestContext, today: BusinessDate): GateView {
  const { planned, asked, scopeStyle, facts } = loaded
  const frozen = revision.status !== 'DRAFT'
  const effects = frozen
    ? [
        `Revision ${revision.revision} is ${revision.status === 'RELEASED' ? 'released' : 'obsolete'} for ${scopeWords(planned, scopeStyle)}.`,
        ...(revision.status === 'RELEASED' && !sameScope(planned, asked) && facts.scope.problems.length === 0
          ? [`A later release of revision ${revision.revision} releases it for ${scopeWords(asked, scopeStyle)}: work orders of the cells it adds can then be released.`]
          : []),
      ]
    : effectsOf(facts)
  const may = context.audience === 'office' && mayWrite(actorOf(context), PRODUCT_BOM_RELEASE, style.companyId)
  return {
    revision: { id: revision.id, styleId: revision.styleId, revision: revision.revision, status: revision.status, version: revision.version },
    style: { id: style.id, code: style.code, name: style.name, status: style.status, companyId: style.companyId },
    date: today,
    checked: gate.checked,
    items: gate.items.map((item) => ({ ...item, findings: item.findings.map(findingView) })),
    blockers: gate.blockers.map(findingView),
    warnings: gate.warnings.map(findingView),
    completenessPct: gate.completenessPct,
    releasable: gate.releasable,
    heldBy: gate.heldBy,
    scope: {
      planned: scopeViewOf(planned, scopeStyle),
      asked: scopeViewOf(asked, scopeStyle),
      suggested: gate.suggestedScope ? scopeViewOf(gate.suggestedScope, scopeStyle) : null,
      waiting: waitingWords(asked, scopeStyle),
      colourways: loaded.colourways.map((colourway) => ({
        id: colourway.id,
        code: colourway.code,
        name: colourway.name,
        status: colourway.status,
        planned: planned.colourwayIds.length === 0 ? colourway.status === 'ACTIVE' : planned.colourwayIds.includes(colourway.id),
        asked: asked.colourwayIds.length === 0 ? colourway.status === 'ACTIVE' : asked.colourwayIds.includes(colourway.id),
      })),
      sizes: style.sizes.map((code) => ({
        code,
        label: loaded.sizeLabels.get(code) ?? code,
        planned: planned.sizes.length === 0 || planned.sizes.includes(code),
        asked: asked.sizes.length === 0 || asked.sizes.includes(code),
      })),
    },
    effects,
    mayRelease: may && (revision.status === 'DRAFT' || revision.status === 'RELEASED') && style.status !== 'ARCHIVED',
  }
}

const findingView = (finding: GateFinding) => ({ ...finding, cell: { ...finding.cell } })

/** GET /product/styles/:styleId/revisions/:revisionId/release-gate */
export async function gateFor(caller: CommandCaller, styleId: string, revisionId: string, query: GateQuery): Promise<GateView> {
  const { style, revision } = await readRevisionFor(caller, styleId, revisionId)
  const context = contextOf(caller)
  const today = todayNow()
  const asked = query.colourwayIds === undefined && query.sizes === undefined ? undefined : { colourwayIds: query.colourwayIds ?? [], sizes: query.sizes ?? [] }
  return caller.withClient(async (client) => {
    const loaded = await loadGate(client, style, revision, { asked, today, actor: actorOf(context) })
    return gateViewOf(loaded, releaseGate(loaded.facts), style, revision, context, today)
  })
}

/** The gate view as a command left the revision (the scope route's answer), read with its transaction. */
export async function gateInTx(tools: CommandTools, styleId: string, revisionId: string): Promise<GateView> {
  const style = await tools.tx.style.findUnique({ where: { id: styleId }, select: STYLE_COLUMNS })
  if (!style) throw new NotFoundError('Style not found.')
  const revision = await findRevision(tools.tx, styleId, revisionId)
  const today = businessDate(tools.now)
  const loaded = await loadGate(tools.tx, style, revision, { today, actor: actorOf(tools.context) })
  return gateViewOf(loaded, releaseGate(loaded.facts), style, revision, tools.context, today)
}

/** Where a gate finding points, as an issue path of the release's refusal. */
function pathOf(finding: GateFinding): string {
  const { cell } = finding
  if (finding.code.startsWith('SCOPE_')) return `scope/${cell.field ?? 'scope'}`
  if (finding.code.startsWith('CHANGE_ORDER_')) return `changeOrders/${cell.recordId ?? finding.code}`
  if (cell.lineId !== null) return `lines/${cell.lineId}${cell.column ? `/${cell.column}` : ''}`
  if (cell.stepId !== null) return `routing/steps/${cell.stepId}`
  return `gate/${finding.code}`
}

/** The release's refusal: every blocker of the gate at once, each in words with where it points (409). */
export function gateRefusal(revision: number, blockers: readonly GateFinding[]): DomainError {
  return new DomainError(
    'invalid_state',
    `Revision ${revision} is not ready to release: ${blockers.length} problem(s) to fix first.`,
    blockers.map((finding) => ({ path: pathOf(finding), message: finding.message })),
  )
}

/** What the release writes and says from the gate. */
export interface GatedRelease {
  readonly completenessPct: string | null
  readonly scope: ReleaseScope
}

/**
 * Inside W1's release command (product/bom revisions.ts releaseRevision), after the style's lock, the edit rule, the change
 * order's check, W1's check and the structure's: the whole gate on the rows as they are now. A blocker left (the scope: a
 * colourway archived or a size dropped from the range since it was planned, nothing left to make) refuses the release in
 * words; otherwise the score and the scope go into the release's UPDATE and its event, and one audit row keeps the score,
 * the scope and every warning the person released over ("the product release gate is a person").
 */
export async function releaseGateInCommand(tools: CommandTools, target: { readonly styleId: string; readonly revisionId: string; readonly companyId: string | null }): Promise<GatedRelease> {
  const { tx } = tools
  const style = await tx.style.findUniqueOrThrow({ where: { id: target.styleId }, select: STYLE_COLUMNS })
  const revision = await findRevision(tx, target.styleId, target.revisionId)
  const loaded = await loadGate(tx as Reader, style, revision, { today: businessDate(tools.now), actor: null })
  const gate = releaseGate(loaded.facts)
  if (gate.blockers.length > 0) throw gateRefusal(revision.revision, gate.blockers)
  tools.audit({
    action: 'product.release.gate',
    recordType: 'StyleRevision',
    recordId: revision.id,
    companyId: target.companyId,
    after: {
      styleId: style.id,
      revision: revision.revision,
      completenessPct: gate.completenessPct,
      releasedColourwayIds: [...loaded.asked.colourwayIds],
      releasedSizes: [...loaded.asked.sizes],
      items: gate.items.filter((item) => item.state !== 'OK').map((item) => ({ code: item.code, state: item.state })),
      warnings: gate.warnings.map((finding) => ({ code: finding.code, message: finding.message })),
    },
  })
  return { completenessPct: gate.completenessPct, scope: loaded.asked }
}
