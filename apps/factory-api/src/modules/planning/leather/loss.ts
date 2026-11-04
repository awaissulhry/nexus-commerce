import { ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { dismissReasonProblem, lossProblem, proposalStands, wastageOfLoss, yieldOfLoss, type LossDecision } from '@nexus/factory-domain/planning/leather/loss'
import { PLANNING_LEATHER_MANAGE } from '@nexus/factory-domain/planning/leather/permissions'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { lockDraft, lockStyleRow, readLines, writeLine } from '../../product/bom/store'
import { officeContextOf, siteFor } from '../access'
import type { SiteRow } from '../store'
import { ACCEPT_ACTION, DISMISS_ACTION, lockStyleLoss, refuse } from './facts'
import { styleYields, windowStart } from './yield'

/**
 * Change cutting loss for style X, or dismiss the proposal (B-W2b-132; PLN-109; design planning.leather pop-up "Change cutting
 * loss for style X", "Dismiss with reason"). Office, planning.leather.manage at the site whose cuts the proposal rests on.
 * ONE command each: the style row locked (product's first lock of every BOM write), one decision about the style at a time,
 * the proposal read again under them — it must be the one the person saw (the same loss on the same number of cuts), else
 * 409 refusal/PROPOSAL_MOVED. A decision is an audit row on the Style (its history; the design's "with history") and the
 * event planning.cutting_loss_decided.
 *
 * Accept writes the loss where the plan reads it, and only there: the style's DRAFT revision (a released revision never
 * changes — the database refuses it — and neither does a work order made from one): its planned hide yield = 100 − loss and
 * each leather line's wastage = loss ÷ (100 − loss) × 100, under the draft's lock and version (product's lockDraft, the
 * BOM's one line writer), with product's own audit row on the revision and style.bom_changed. The plan run and new quotes use
 * it once that revision is released. A style without a draft: the decision is recorded and the answer says so (Products
 * starts revision N+1 to carry it; accepting again then carries it in).
 */

interface DecisionBody {
  readonly siteId: string
  readonly toPct: string
  readonly cuts: number
}

/** The proposal read again inside the command; refused unless it stands as the person saw it. */
async function standingProposal(tools: CommandTools, site: SiteRow, styleId: string, body: DecisionBody) {
  const facts = (await styleYields(tools.tx, site, windowStart(site, tools.now), [styleId])).get(styleId)
  if (!facts || !proposalStands(facts.proposal, body)) {
    refuse('PROPOSAL_MOVED', 'The proposal changed since it was read (new cuts, or another decision): read the yield again.')
  }
  return facts!
}

const decisionPayload = (styleId: string, site: SiteRow, decision: LossDecision, fromPct: string | null, toPct: string, cuts: number, revisionId: string | null) => ({ styleId, siteId: site.id, decision, fromPct, toPct, cuts, revisionId })

/** POST /planning/leather/styles/:styleId/loss/accept */
export async function acceptLoss(caller: CommandCaller, styleId: string, body: DecisionBody & { readonly draftVersion?: number | null | undefined }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const problem = lossProblem(body.toPct)
  if (problem) throw new ValidationError(problem, [{ path: 'body/toPct', message: problem }])
  const toPct = new Dec(body.toPct).toFixed(2)
  const { result } = await command(caller, { name: ACCEPT_ACTION, idempotencyKey, input: { styleId, ...body } }, async (tools) => {
    const { tx } = tools
    const site = await siteFor(caller, body.siteId, PLANNING_LEATHER_MANAGE, tx)
    const style = await lockStyleRow(tx, styleId)
    await lockStyleLoss(tx, context.tenantId, styleId)
    const facts = await standingProposal(tools, site, styleId, { ...body, toPct })
    const draft = await tx.styleRevision.findFirst({ where: { styleId, status: 'DRAFT' }, select: { id: true, revision: true, version: true, plannedHideYieldPct: true }, orderBy: { revision: 'desc' } })
    if (facts.proposal.state === 'ACCEPTED' && (!draft || (draft.plannedHideYieldPct !== null && new Dec(draft.plannedHideYieldPct.toString()).eq(yieldOfLoss(toPct))))) {
      refuse('ALREADY_ACCEPTED', draft ? `This loss is in revision ${draft.revision} already.` : 'This loss was accepted already; it waits for a draft revision of the style to carry it.')
    }
    let carriedIn: { revisionId: string; revision: number; plannedHideYieldPct: string; wastagePct: string; lines: number } | null = null
    if (draft) {
      if (body.draftVersion === undefined || body.draftVersion === null) {
        const message = `${style.code} has a draft revision ${draft.revision}: send its version, the change goes into it.`
        throw new ValidationError(message, [{ path: 'body/draftVersion', message }])
      }
      const locked = await lockDraft(tools, styleId, draft.id, body.draftVersion)
      const plannedHideYieldPct = yieldOfLoss(toPct)
      const wastagePct = wastageOfLoss(toPct)
      await tx.styleRevision.update({ where: { id: draft.id }, data: { plannedHideYieldPct }, select: { id: true } })
      const lines = await readLines(tx, draft.id)
      const leather = new Set((await tx.item.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.itemId))] }, tracking: 'HIDE' }, select: { id: true } })).map((row) => row.id))
      const changed = lines.filter((line) => leather.has(line.itemId) && !new Dec(line.wastagePct).eq(wastagePct))
      for (const line of changed) await writeLine(tools, { styleId, revisionId: draft.id, lineId: line.id }, { ...line, wastagePct }, line)
      tools.audit({
        recordType: 'StyleRevision',
        recordId: draft.id,
        companyId: locked.style.companyId,
        before: { plannedHideYieldPct: draft.plannedHideYieldPct?.toString() ?? null, wastage: changed.map((line) => ({ lineId: line.id, seq: line.seq, wastagePct: line.wastagePct })) },
        after: { plannedHideYieldPct, wastagePct, lineIds: changed.map((line) => line.id), version: locked.version, cuttingLoss: toPct },
      })
      tools.emit({
        type: 'style.bom_changed',
        subject: styleId,
        companyId: locked.style.companyId,
        payload: { styleId, code: locked.style.code, revisionId: draft.id, revision: draft.revision, lineIds: changed.map((line) => line.id) },
      })
      carriedIn = { revisionId: draft.id, revision: draft.revision, plannedHideYieldPct, wastagePct, lines: changed.length }
    }
    const fromPct = facts.proposal.fromPct
    tools.audit({
      action: ACCEPT_ACTION,
      recordType: 'Style',
      recordId: styleId,
      companyId: style.companyId ?? site.companyId,
      siteId: site.id,
      before: { lossPct: fromPct },
      after: { decision: 'ACCEPTED', fromPct, toPct, cuts: body.cuts, actualLossPct: facts.actualLossPct, carriedIn },
    })
    tools.emit({ type: 'planning.cutting_loss_decided', subject: styleId, companyId: site.companyId, siteId: site.id, payload: decisionPayload(styleId, site, 'ACCEPTED', fromPct, toPct, body.cuts, carriedIn?.revisionId ?? null) })
    return { styleId, siteId: site.id, decision: 'ACCEPTED' as const, fromPct, toPct, cuts: body.cuts, decidedAt: toUtcIso(tools.now), carriedIn }
  })
  return result
}

/** POST /planning/leather/styles/:styleId/loss/dismiss */
export async function dismissLoss(caller: CommandCaller, styleId: string, body: DecisionBody & { readonly reason: string }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const problem = lossProblem(body.toPct)
  if (problem) throw new ValidationError(problem, [{ path: 'body/toPct', message: problem }])
  const reasonProblem = dismissReasonProblem(body.reason)
  if (reasonProblem) throw new ValidationError(reasonProblem, [{ path: 'body/reason', message: reasonProblem }])
  const toPct = new Dec(body.toPct).toFixed(2)
  const reason = body.reason.trim()
  const { result } = await command(caller, { name: DISMISS_ACTION, idempotencyKey, input: { styleId, ...body } }, async (tools) => {
    const { tx } = tools
    const site = await siteFor(caller, body.siteId, PLANNING_LEATHER_MANAGE, tx)
    const style = await lockStyleRow(tx, styleId)
    await lockStyleLoss(tx, context.tenantId, styleId)
    const facts = await standingProposal(tools, site, styleId, { ...body, toPct })
    if (facts.proposal.state === 'DISMISSED') refuse('ALREADY_DISMISSED', 'This proposal was dismissed already; it comes back when it changes or more cuts came in.')
    const fromPct = facts.proposal.fromPct
    tools.audit({
      action: DISMISS_ACTION,
      recordType: 'Style',
      recordId: styleId,
      companyId: style.companyId ?? site.companyId,
      siteId: site.id,
      reason,
      after: { decision: 'DISMISSED', fromPct, toPct, cuts: body.cuts, actualLossPct: facts.actualLossPct, carriedIn: null },
    })
    tools.emit({ type: 'planning.cutting_loss_decided', subject: styleId, companyId: site.companyId, siteId: site.id, payload: decisionPayload(styleId, site, 'DISMISSED', fromPct, toPct, body.cuts, null) })
    return { styleId, siteId: site.id, decision: 'DISMISSED' as const, fromPct, toPct, cuts: body.cuts, decidedAt: toUtcIso(tools.now), carriedIn: null }
  })
  return result
}
