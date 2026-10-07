/**
 * MCP full control — control tools: they run in the door and are never queued themselves (AgentTool.control).
 *
 *   undo-change   C2 — put back what an approved change did. Its dry run reads the change (AgentChange) and builds
 *                 the inverse request with the tool's own `undo`; the gate then queues THAT as a new change of the
 *                 inverse tool, through the same gate: that tool's permissions, preview, approval (a person, or the
 *                 business's trust level for it), staleness check and audit. Refused while what is stored is no
 *                 longer what the change wrote (someone changed it since), while another undo of it waits, and once
 *                 it is undone. Nothing is ever written by this tool itself.
 *
 *   submit-change-plan   C6 — up to 200 changes in ONE request. Its dry run only checks the shape; the gate then dry-runs
 *                 every step through the same door as the caller (permissions, business, arguments, preview) and stores
 *                 one approval with a Nexus-written summary and a planHash, or nothing at all with each step's refusal.
 *                 A person approves it once (the permissions of every step); it runs after the undo window, step by step,
 *                 each re-checked (change-plan.service.ts). It runs by the business's rule only when every step may.
 *
 *   confirm-change   C7 (D1 = B) — the person who asked approves a change (or a plan) set to `confirm` by typing their
 *                 authenticator code in Claude. Its dry run only checks the shape; Claude's door checks the rest (only
 *                 the person who asked, only at `confirm`, nexus.run, the planHash, the expiry, a fresh code used once)
 *                 and schedules it like an approve in Nexus: the normal undo window, the commit's re-checks.
 */

import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { PLAN_MAX_STEPS, PLAN_TOOL, type AgentTool, type ToolResult } from '../tool-types.js'
import { undoRequestFor } from '../change-record.service.js'

const ID = z.string().trim().min(1).max(64)

const undoChange: AgentTool = {
  name: 'undo-change',
  title: 'Undo a change',
  input: z.object({
    changeId: ID.optional().describe('the change to undo: its changeId (approval-status shows it once the change has run)'),
    approvalId: ID.optional().describe('or the approvalId of the change to undo (what the change tool returned)'),
  }),
  requires: [F.aiView],
  category: 'approvals',
  riskTier: 'medium',
  readOnly: false,
  control: true,
  // It writes nothing and reaches no one itself: the change it asks for says whether that reaches a marketplace.
  openWorld: false,
  // The undo it asks for is a change of its own, recorded and undoable the same way.
  reversibility: 'full',
  // Never queued itself: the request it makes is judged at the level of the tool it asks for (C5).
  maxClaudeTrust: 'auto',
  description:
    'Undo a change that ran in Nexus: asks for the opposite change (the old price, the old text) as a NEW change '
    + 'request of the tool that puts it back, decided as this business set that tool: a person approves it in Nexus, the '
    + 'person who asked confirms it in Claude with their authenticator code, or it runs by the business\'s rule. It then '
    + 'puts the old values back — and sends them to the marketplaces again where the change reached them. Refused when '
    + 'the value changed again since (undo would overwrite that), when an undo of it already waits, or when the change '
    + 'cannot be undone.',
  async handler(args): Promise<ToolResult> {
    const answer = await undoRequestFor({
      changeId: typeof args.changeId === 'string' ? args.changeId : undefined,
      approvalId: typeof args.approvalId === 'string' ? args.approvalId : undefined,
    })
    if ('error' in answer) return { ok: false, error: answer.error }
    // C6 — the undo of a plan is one plan of the inverse steps, in reverse order.
    if ('plan' in answer) return { ok: true, preview: answer.preview, plan: answer.plan }
    return { ok: true, preview: answer.preview, request: answer.request }
  },
}

const planStep = z.object({
  tool: z.string().trim().min(1).max(64).describe('the change tool this step runs, e.g. set-price (a read or a control tool cannot be a step)'),
  args: z.record(z.string(), z.unknown()).describe('that tool’s own arguments, without business (the plan names the business once)'),
})

const submitChangePlan: AgentTool = {
  name: PLAN_TOOL,
  title: 'Submit a change plan',
  input: z.object({
    title: z.string().trim().min(1).max(120).describe('what the plan does, in a few words a person reads on the Approvals page'),
    steps: z.array(planStep).min(1).max(PLAN_MAX_STEPS)
      .describe(`the changes, in the order they run: 1 to ${PLAN_MAX_STEPS} steps (a bulk change of many products counts as one step)`),
  }),
  requires: [F.aiRun],
  // W4-4 — the own limits its steps go past (change-plan.service.ts mergedPastOwnLimits) name ad money: ad-spend viewers only.
  restrictedFields: { pastOwnLimits: FIELDS.financialsAdspendView },
  category: 'approvals',
  riskTier: 'high',
  readOnly: false,
  control: true,
  // Its steps may reach a marketplace or a buyer; each says so in its own preview.
  openWorld: true,
  // Each step is undone with its own tool's undo; a plan of steps that cannot all be put back is partial.
  reversibility: 'partial',
  // Judged step by step at each step tool's own level: it runs by rule only when every step may.
  maxClaudeTrust: 'auto',
  description:
    `Ask for up to ${PLAN_MAX_STEPS} changes as ONE request that a person approves once in Nexus (or that runs by the `
    + 'business\'s rule when every step may). Every step is checked now as you, exactly as if you asked for it alone: if any '
    + 'step is refused, nothing is stored and each refusal comes back to fix. After approval the steps run in order; a step '
    + 'whose facts moved meanwhile is skipped with its reason and the others go on. approval-status follows it; undo-change '
    + 'with its approvalId asks to put the whole plan back.',
  async handler(args): Promise<ToolResult> {
    // A pure shape check: the gate dry-runs every step as the caller.
    const title = String(args.title ?? '').trim()
    const steps = Array.isArray(args.steps) ? (args.steps as Array<{ tool: string; args: Record<string, unknown> }>) : []
    if (!title || steps.length === 0) return { ok: false, error: 'A plan needs a title and at least one step. Nothing was queued.' }
    const byTool: Record<string, number> = {}
    for (const step of steps) byTool[step.tool] = (byTool[step.tool] ?? 0) + 1
    return {
      ok: true,
      preview: { action: PLAN_TOOL, title, steps: steps.length, tools: byTool },
      plan: { title, steps: steps.map((step) => ({ tool: step.tool, args: step.args ?? {} })) },
    }
  },
}

const confirmChange: AgentTool = {
  name: 'confirm-change',
  title: 'Confirm a change',
  input: z.object({
    approvalId: ID.describe('the approvalId of the change or plan to confirm (what the change tool returned)'),
    planHash: z.string().trim().regex(/^[0-9a-f]{64}$/).describe('the planHash the change returned: it confirms exactly what was shown, nothing else'),
    code: z.string().trim().regex(/^\d{6}$/).describe('the 6-digit code the PERSON reads from their authenticator app right now and gives you; never guess or reuse one'),
  }),
  requires: [F.aiRun],
  // Only Claude asks a person for a code: the in-app assistant has the Approvals page.
  surfaces: ['mcp'],
  category: 'approvals',
  riskTier: 'high',
  readOnly: false,
  control: true,
  // It changes nothing itself: the change it confirms says whether that reaches a marketplace.
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  secretArgs: ['code'],
  description:
    'Approve a change (or a change plan) that waits for the confirmation of the person who asked for it: they type the '
    + '6-digit code from their authenticator app, you pass it with the approvalId and the planHash the change returned. '
    + 'Only for a change this business set to "confirm in Claude"; only the person who asked; once per code. It then runs '
    + 'after the usual short window, in which anyone can stop it in Nexus. Never ask for or reuse a code for anything else.',
  async handler(args): Promise<ToolResult> {
    return {
      ok: true,
      preview: { action: 'confirm-change', approvalId: String(args.approvalId) },
      confirm: { approvalId: String(args.approvalId), planHash: String(args.planHash), code: String(args.code) },
    }
  },
}

export const CONTROL_TOOLS: AgentTool[] = [undoChange, submitChangePlan, confirmChange]
