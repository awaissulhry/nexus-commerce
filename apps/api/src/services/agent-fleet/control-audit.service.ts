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
  | 'undo_approval'
  // NAF.AP.6 — an approved action refused at run time because the facts it
  // described had moved. Recorded because a silent non-execution is worse
  // than a failure nobody can explain.
  | 'stale_refused'
  // NAF.AQ-S9 — an approved action that was attempted and FAILED. Distinct
  // from `stale_refused`, which never ran: this one reached the tool and the
  // tool said no. Added because the commit path used to return early on
  // failure and write no audit at all, so nothing anywhere recorded that a
  // human had authorised the attempt.
  | 'execution_failed'
  // NAF.AQ.8 — the operator edited a proposal before approving it. Its own
  // action rather than an approve, because the interesting fact is that the
  // worker's number was WRONG and a human corrected it: that is the highest
  // quality signal the fleet ever gets, and folding it into `approve_action`
  // would lose it.
  | 'amend_action'
  // NAF.SB.AS — the two human endings of an assignment. Starting one reuses
  // `run_now` above rather than minting a synonym: it is the same event —
  // a person deliberately spending money on a worker — and two words for it
  // would split the trail Controls reads.
  | 'assignment_closed'
  | 'assignment_cancelled'

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
