/**
 * MCP full control C7 (D1 = B) — confirm in Claude: the person who asked approves a change (or a plan) the business
 * set to `confirm` by typing their authenticator code in Claude.
 *
 *   prepare   when a change at `confirm` is queued, it gets a one-line summary and a planHash (sha256 of the tool and
 *             its arguments; a plan already has both) — what Claude shows and what the code is bound to
 *   confirm   confirm-change {approvalId, planHash, code}, checked in this order, nothing spent on a refusal before the
 *             code: the approval in this business; the connection's nexus.run; only the person who asked for it in
 *             Claude; still waiting and not expired; set to `confirm` (every step of a plan at confirm or auto) — W1-8:
 *             at the ads strategy's level where each change lands when that is lower, read now; the planHash,
 *             recomputed from what is stored; then the code, once (lib/auth/step-up.ts: lockout after wrong
 *             codes, a used code refused). Then scheduleApproval as that person (decisionVia claude-confirm): the normal
 *             undo window, the commit's re-check of the person and of the preview, the sweep.
 *
 * The code is never stored: confirm-change declares it a secret argument (the run keeps "[redacted]").
 */

import { createHash } from 'node:crypto'
import prisma from '../../db.js'
import { verifyStepUpCode } from '../../lib/auth/step-up.js'
import { recordControlChange } from '../agent-fleet/control-audit.service.js'
import { scheduleApproval } from '../agent-fleet/approval-inbox.service.js'
import type { GateOutcome } from './approval-gate.service.js'
import type { UserPrincipal } from './call-tool.js'
import { planHashOf } from './change-plan.service.js'
import { CLAUDE_CHARTER, claudeRuleForChange, claudeRulesForSteps, narrowedWhy } from './claude-trust.service.js'
import { getTool } from './tool-registry.js'
import { PLAN_TOOL } from './tool-types.js'

const NOTHING = 'Nothing was approved.'

function canonical(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v
  return JSON.stringify(sorted(JSON.parse(JSON.stringify(value ?? null))))
}

/** sha256 of one change: its tool and its arguments, whatever the order of their keys. */
export function changeHashOf(toolName: string, args: unknown): string {
  return createHash('sha256').update(canonical({ tool: toolName, args: args ?? {} })).digest('hex')
}

/** The hash of what an approval holds NOW: a plan's title and steps, or one change's tool and arguments. */
async function storedHash(ap: { id: string; toolName: string; args: unknown }): Promise<string> {
  if (ap.toolName !== PLAN_TOOL) return changeHashOf(ap.toolName, ap.args)
  const steps = await prisma.agentPlanStep.findMany({ where: { approvalId: ap.id }, orderBy: { position: 'asc' }, select: { toolName: true, args: true } })
  const title = String((ap.args as { title?: unknown } | null)?.title ?? '')
  return planHashOf({ title, steps: steps.map((step) => ({ tool: step.toolName, args: (step.args ?? {}) as Record<string, unknown> })) })
}

/**
 * A value as a person reads it: a list item by item ("summer, sale"; empty "(none)"), an object key by key
 * ("length: 10, unit: cm"; nested ones in brackets). Only a missing value is "—".
 */
function shownValue(value: unknown, nested = false): string {
  if (value == null) return '—'
  if (Array.isArray(value)) return value.length ? value.map((item) => shownValue(item, true)).join(', ') : '(none)'
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (!entries.length) return '(none)'
    const text = entries.map(([key, inner]) => `${key}: ${shownValue(inner, true)}`).join(', ')
    return nested ? `(${text})` : text
  }
  return String(value)
}

const SHOWN_CHANGES = 3

/** One plain line for a single change: its preview's summary or effect, else its title and what it changes. */
export function confirmSummaryOf(toolName: string, preview: unknown): string {
  const p = (preview ?? {}) as { summary?: unknown; effect?: unknown; changes?: Record<string, { from?: unknown; to?: unknown }>; sku?: unknown }
  if (typeof p.summary === 'string' && p.summary.trim()) return p.summary.trim()
  if (typeof p.effect === 'string' && p.effect.trim()) return p.effect.trim()
  const title = getTool(toolName)?.title ?? toolName
  const all = p.changes && typeof p.changes === 'object' ? Object.entries(p.changes) : []
  const parts = all.slice(0, SHOWN_CHANGES).map(([field, c]) => `${field}: ${shownValue(c?.from)} → ${shownValue(c?.to)}`)
  const more = all.length - SHOWN_CHANGES
  if (more > 0) parts.push(`and ${more} more change${more === 1 ? '' : 's'}`)
  const what = parts.join('; ')
  return `${title}${typeof p.sku === 'string' ? ` for ${p.sku}` : ''}${what ? `: ${what}` : ''}`
}

/**
 * A change queued at `confirm`: its summary and planHash, stored on the approval (a plan keeps the ones it has).
 * What Claude shows the person, and what their code is bound to.
 */
export async function prepareConfirm(approvalId: string): Promise<{ summary: string; planHash: string } | null> {
  const ap = await prisma.agentApproval.findUnique({ where: { id: approvalId }, select: { id: true, toolName: true, args: true, preview: true, summary: true, planHash: true } })
  if (!ap) return null
  if (ap.toolName === PLAN_TOOL) return ap.summary && ap.planHash ? { summary: ap.summary, planHash: ap.planHash } : null
  const summary = confirmSummaryOf(ap.toolName, ap.preview)
  const planHash = changeHashOf(ap.toolName, ap.args)
  await prisma.agentApproval.update({ where: { id: approvalId }, data: { summary, planHash } })
  return { summary, planHash }
}

/**
 * Why this request may not be confirmed in Claude, or null: every change of it set to confirm (a plan: each step at
 * confirm or auto, one at confirm at least). W1-8 — each change at the ads strategy's level where it lands when that
 * is lower, read now: a strategy narrowed since it was asked for leaves it to a person, and says which row.
 */
async function notSetToConfirm(ap: { id: string; toolName: string; args: unknown; preview: unknown }): Promise<string | null> {
  const plain = `${ap.toolName} is not set to confirm in Claude in this business: a person approves it in Nexus.`
  if (ap.toolName !== PLAN_TOOL) {
    const rule = await claudeRuleForChange(ap.toolName, ap.args, ap.preview)
    if (rule?.level === 'confirm') return null
    return rule?.narrowedBy ? `Not confirmed here: ${narrowedWhy(rule.narrowedBy)}; a person approves it in Nexus.` : plain
  }
  const steps = await prisma.agentPlanStep.findMany({ where: { approvalId: ap.id }, orderBy: { position: 'asc' }, select: { position: true, toolName: true, args: true, preview: true } })
  const rules = await claudeRulesForSteps(steps)
  const levels = rules.map((rule) => rule?.level ?? 'ask')
  if (levels.length > 0 && levels.every((level) => level === 'confirm' || level === 'auto') && levels.includes('confirm')) return null
  const narrowed = rules.findIndex((rule, index) => rule?.narrowedBy && levels[index] !== 'confirm' && levels[index] !== 'auto')
  if (narrowed >= 0) return `Not confirmed here: step ${steps[narrowed].position} (${steps[narrowed].toolName}): ${narrowedWhy(rules[narrowed]!.narrowedBy!)}; a person approves it in Nexus.`
  return plain
}

const refuse = (error: string): GateOutcome => ({ ok: false, mode: 'error', error })

/** confirm-change, for the person behind this Claude connection. */
export async function confirmByCode(
  principal: UserPrincipal,
  input: { approvalId: string; planHash: string; code: string },
  opts: { runScope: boolean },
): Promise<GateOutcome> {
  const ap = await prisma.agentApproval.findUnique({
    where: { id: input.approvalId },
    select: { id: true, toolName: true, args: true, preview: true, status: true, expiresAt: true, planHash: true, agentRun: { select: { userId: true, via: true } } },
  })
  // Another business's approval is simply not there (row-level security), whatever else is wrong.
  if (!ap) return refuse(`Approval not found. ${NOTHING}`)
  if (!opts.runScope) {
    return refuse(`This Claude connection may not confirm changes: it was connected without nexus.run ("run the changes set to run by rule"). A person approves it in Nexus. ${NOTHING}`)
  }
  if (ap.agentRun?.via !== 'claude' || ap.agentRun.userId !== principal.userId) {
    return refuse(`Only the person who asked for it in Claude may confirm it here; anyone else approves it in Nexus. ${NOTHING}`)
  }
  if (ap.status !== 'pending') return refuse(`It is ${ap.status}: there is nothing to confirm. ${NOTHING}`)
  if (ap.expiresAt && ap.expiresAt.getTime() <= Date.now()) return refuse(`It expired before it was confirmed. Nothing changed; ask for it again. ${NOTHING}`)
  const notConfirm = await notSetToConfirm(ap)
  if (notConfirm) return refuse(`${notConfirm} ${NOTHING}`)
  const expected = await storedHash(ap)
  if (!ap.planHash || ap.planHash !== expected || input.planHash !== ap.planHash) {
    return refuse(`The planHash does not match this request: confirm exactly what was shown (approval-status shows it). ${NOTHING}`)
  }

  // Last: the code, once. Every refusal above left it unspent.
  const user = await prisma.userProfile.findUnique({ where: { id: principal.userId }, select: { twoFactorEnabledAt: true, twoFactorSecret: true } })
  if (!user?.twoFactorEnabledAt || !user.twoFactorSecret) {
    return refuse(`Confirming in Claude needs two-factor authentication on this account; a person approves it in Nexus. ${NOTHING}`)
  }
  const verdict = await verifyStepUpCode(principal.userId, user.twoFactorSecret, input.code)
  if (verdict === 'locked') return refuse(`Too many wrong codes: try again in 15 minutes, or approve it in Nexus. ${NOTHING}`)
  if (verdict === 'reused') return refuse(`That code was already used. Ask for the next one from the authenticator app. ${NOTHING}`)
  if (verdict !== 'ok') return refuse(`That code is not right. Ask the person to read it again from their authenticator app. ${NOTHING}`)

  const scheduled = await scheduleApproval({ id: ap.id, actor: principal, via: 'claude-confirm' })
  if (!scheduled.ok || !scheduled.executeAfter) return refuse(`${scheduled.error ?? 'It could not be approved'}. ${NOTHING}`)
  await recordControlChange({
    charterKey: CLAUDE_CHARTER,
    action: 'approve_action',
    to: { approvalId: ap.id, status: 'scheduled', decisionVia: 'claude-confirm' },
    note: 'confirmed in Claude with an authenticator code',
    actor: principal.label,
  })
  return {
    ok: true,
    mode: 'executed',
    data: {
      status: 'confirmed',
      approvalId: ap.id,
      runsAt: scheduled.executeAfter,
      next:
        'Confirmed. It runs at runsAt, after a short window in which anyone with permission can stop it in the Nexus ' +
        'Approvals page, and its facts are checked again first. Call approval-status with the approvalId to follow it.',
    },
  }
}
