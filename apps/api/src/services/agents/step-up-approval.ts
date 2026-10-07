/**
 * ADS AUTONOMY W1-3 — a request a person approves only with their fresh authenticator code, alone or as a step of a
 * change plan: the ads "big doors" of the Owner's code rule (tools/ads-code-rule.ts, 2026-10-07) — a strategy raise, a
 * playbook change or START, a new structure going live, new product ads, someone else's pause lifted.
 *
 *   mark     the tool's dry run puts `stepUp` on its preview ({ what, raises, needs, how }); a change plan copies it onto
 *            its own preview (change-plan.service.ts). The Approvals page, the bulk approve and Claude read it there.
 *   approve  a person with settings.security.manage types their code in Nexus (approval-inbox.service.ts
 *            decideFleetApproval, decisionVia `nexus-step-up`), or the person who asked confirms it in Claude with theirs
 *            (claude-confirm.service.ts, decisionVia `claude-confirm`). A bulk approve leaves it out, and says why.
 *   run      the tool's `execute` asks `stepUpApproval`: a fresh dry run that still raises runs only when the request was
 *            approved with a code and the approver holds settings.security.manage now. Never by rule: no limit lets a
 *            raise run without a person (set-ads-strategy withinLimits), and a plain approve without a code is refused.
 */
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../db.js'
import { PLAN_TOOL, type ToolContext } from './tool-types.js'

/** The decisions taken with a fresh authenticator code: in Nexus (the Approvals page), or in Claude by the asker. */
export const STEP_UP_VIAS: readonly string[] = ['nexus-step-up', 'claude-confirm']

export const STEP_UP_NEEDS = "settings.security.manage and a fresh code from the approver's authenticator app"

/** What a preview carries when approving it needs the approver's code. */
export interface StepUp {
  /** What the change does, ending a sentence: "raises the ads strategy". */
  what: string
  /** What it raises, as a person reads it ("Highest bid", "Goal"). */
  raises: string[]
  needs: string
  /** How it can be approved, in one sentence. */
  how: string
}

/** The step-up a preview carries, or null when approving it needs no code. */
export function stepUpOf(preview: unknown): StepUp | null {
  const s = (preview as { stepUp?: unknown } | null | undefined)?.stepUp as Partial<StepUp> | null | undefined
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null
  return {
    what: typeof s.what === 'string' && s.what.trim() ? s.what : 'raises a limit',
    raises: Array.isArray(s.raises) ? s.raises.filter((r): r is string => typeof r === 'string') : [],
    needs: typeof s.needs === 'string' ? s.needs : STEP_UP_NEEDS,
    how: typeof s.how === 'string' ? s.how : '',
  }
}

/** The step-ups of several previews (a plan's steps, in order) as one, naming the steps; null when none needs a code. */
export function mergedStepUp(previews: readonly unknown[]): (StepUp & { steps: number[] }) | null {
  const found = previews.map((preview, index) => ({ step: index + 1, stepUp: stepUpOf(preview) })).filter((s) => s.stepUp)
  if (!found.length) return null
  const first = found[0].stepUp!
  const whats = [...new Set(found.map((s) => s.stepUp!.what))]
  return {
    what: whats.length === 1 ? first.what : whats.join(' and '),
    raises: [...new Set(found.flatMap((s) => s.stepUp!.raises))],
    needs: first.needs,
    how: `${found.length === 1 ? `Step ${found[0].step} raises` : `Steps ${found.map((s) => s.step).join(', ')} raise`}: a person with ${first.needs} approves the plan in Nexus, or the person who asked confirms it in Claude with their code.`,
    steps: found.map((s) => s.step),
  }
}

/** Does approving this request need the approver's code? Its own preview's step-up, or (a plan) any step's. */
export async function approvalStepUp(approvalId: string): Promise<StepUp | null> {
  const ap = await prisma.agentApproval.findUnique({ where: { id: approvalId }, select: { toolName: true, preview: true } })
  if (!ap) return null
  const own = stepUpOf(ap.preview)
  if (own || ap.toolName !== PLAN_TOOL) return own
  // A plan copies its steps' step-up onto its own preview; the steps are read too, so a plan stored without it is caught.
  const steps = await prisma.agentPlanStep.findMany({ where: { approvalId }, orderBy: { position: 'asc' }, select: { preview: true } })
  return mergedStepUp(steps.map((step) => step.preview))
}

/** The refusal `execute` answers with when a raise was not approved with a code. */
export const RAISE_NEEDS_CODE =
  "Not run: it raises, and a raise runs only when a person with settings.security.manage approved it with their authenticator code (in Nexus, or confirmed in Claude). Ask for it again; it waits for that person."

/**
 * `execute` of a change whose fresh dry run raises: was the request it carries out approved with a fresh code, by a
 * person who still holds settings.security.manage? `at` is when the code was typed (the decision's audit row; the
 * moment of this check when that row cannot be read), `by` the name shown.
 */
export async function stepUpApproval(ctx: Pick<ToolContext, 'approvalId' | 'can'>): Promise<{ ok: true; at: Date; by: string | null } | { ok: false; refusal: string }> {
  const approvalId = ctx.approvalId?.trim()
  if (!approvalId) return { ok: false, refusal: RAISE_NEEDS_CODE }
  const ap = await prisma.agentApproval.findUnique({ where: { id: approvalId }, select: { decisionVia: true, decidedBy: true } })
  if (!ap?.decisionVia || !STEP_UP_VIAS.includes(ap.decisionVia)) return { ok: false, refusal: RAISE_NEEDS_CODE }
  if (!ctx.can(F.settingsSecurityManage)) {
    return { ok: false, refusal: `Not run: it raises, and ${ap.decidedBy ?? 'the person who approved it'} no longer holds settings.security.manage, which a raise needs.` }
  }
  const decided = await prisma.agentControlAudit.findFirst({
    where: { action: 'approve_action', toValue: { path: ['approvalId'], equals: approvalId } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, toValue: true },
  }).catch(() => null)
  const coded = decided && STEP_UP_VIAS.includes(String((decided.toValue as { decisionVia?: unknown } | null)?.decisionVia ?? ''))
  return { ok: true, at: coded ? decided!.createdAt : new Date(), by: ap.decidedBy }
}
