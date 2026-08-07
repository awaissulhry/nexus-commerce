/**
 * NAF.AC.7 — every control change, attributable. Dial moves, revision
 * activations, policy edits, pauses, eval overrides. The EU AI Act posture
 * the spec commits to is only real if this table is complete, so the
 * writer is deliberately trivial to call and never throws: an audit
 * failure must not block the control change it is recording (the change
 * already happened), but it is logged loudly.
 */
import type { Prisma } from '@nexus/database'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export type ControlAction =
  | 'dial'
  | 'enable'
  | 'activate_revision'
  | 'revert_to_code'
  | 'policy'
  | 'pause'
  | 'resume'
  | 'eval_override'
  | 'tools'
  | 'scope'
  | 'run_now'
  | 'cancel_run'
  // NAF.AP.1 — approval decisions are control changes too: they are the
  // moment a human authorises an agent to touch Amazon, and until now no
  // record named who did it.
  | 'approve_action'
  | 'reject_action'

export async function recordControlChange(input: {
  charterKey: string
  action: ControlAction
  from?: unknown
  to?: unknown
  note?: string | null
  actor?: string | null
}): Promise<void> {
  try {
    await prisma.agentControlAudit.create({
      data: {
        charterKey: input.charterKey,
        action: input.action,
        fromValue: (input.from ?? undefined) as Prisma.InputJsonValue | undefined,
        toValue: (input.to ?? undefined) as Prisma.InputJsonValue | undefined,
        note: input.note ?? null,
        actor: input.actor ?? 'operator',
      },
    })
  } catch (err) {
    logger.error('[naf-audit] failed to record a control change', {
      charterKey: input.charterKey,
      action: input.action,
      error: String(err),
    })
  }
}

export async function listControlAudit(
  charterKey: string,
  limit = 50,
): Promise<
  Array<{
    id: string
    action: string
    fromValue: unknown
    toValue: unknown
    note: string | null
    actor: string | null
    createdAt: Date
  }>
> {
  return prisma.agentControlAudit.findMany({
    where: { charterKey },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
  })
}
