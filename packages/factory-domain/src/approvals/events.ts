import { z } from 'zod'
import { defineEvent } from '../events/define'
import { APPROVAL_MEANINGS, APPROVAL_TASK_KINDS } from './rules'

/**
 * One approval engine (B-W2b-282; PLT-086, PLT-091, PLT-093, PLT-105; the code is factory-domain approvals). apps/factory-api's
 * platform/approvals emits them in the command that makes the change; live for approvals.view (design home.approvals "live":
 * "approval.requested → '1 new · Show'", "approval.decided → the row leaves with a receipt"; admin.automation "approval rule
 * changes → home.approvals rules"). Ids, kinds and states only: no money, no words. The people ids are for the
 * notification rules (the approver named, the person who asked); they never travel on a live screen.
 *
 *   approval.requested      a request for a yes was asked (its approver: a role or one person; its due time)
 *   approval.decided        it was approved (signed with its meaning, where the rule asked) or rejected
 *   approval.withdrawn      it was taken back before a decision (by the person who asked, or by the system)
 *   approval.stale          its record changed after it was asked: the yes was refused, a new request is needed
 *   approval.rule_changed   an approval rule was written, changed, switched on or switched off
 */
export const RULE_CHANGES = ['CREATED', 'UPDATED', 'SWITCHED_ON', 'SWITCHED_OFF'] as const

const live = { permission: 'approvals.view' } as const
const subject = { taskId: z.uuid(), kind: z.enum(APPROVAL_TASK_KINDS), recordType: z.string().min(1).max(80), recordId: z.uuid() }

export const events = [
  defineEvent({
    type: 'approval.requested',
    context: 'approvals',
    description: 'A request for a yes was asked: the first matching approval rule named its approver (a role or one person), the meaning of the signature and the time to decide.',
    payload: z.strictObject({ ...subject, requestedById: z.uuid().nullable(), approverRoleId: z.uuid().nullable(), approverUserId: z.uuid().nullable(), dueAt: z.iso.datetime().nullable() }),
    live: { ...live, fields: ['taskId', 'kind', 'recordType', 'recordId'] },
  }),
  defineEvent({
    type: 'approval.decided',
    context: 'approvals',
    description: 'A request for a yes was approved (signed with its meaning where the rule asked) or rejected with a reason, by a person who did not ask for it.',
    payload: z.strictObject({ ...subject, status: z.enum(['APPROVED', 'REJECTED']), meaning: z.enum(APPROVAL_MEANINGS).nullable(), requestedById: z.uuid().nullable(), decidedById: z.uuid() }),
    live: { ...live, fields: ['taskId', 'kind', 'recordType', 'recordId', 'status'] },
  }),
  defineEvent({
    type: 'approval.withdrawn',
    context: 'approvals',
    description: 'A request for a yes was taken back before a decision, by the person who asked or by the system.',
    payload: z.strictObject({ ...subject }),
    live: { ...live, fields: ['taskId', 'kind', 'recordType', 'recordId'] },
  }),
  defineEvent({
    type: 'approval.stale',
    context: 'approvals',
    description: 'The record of a request for a yes changed after it was asked: the yes was refused and a new request is needed.',
    payload: z.strictObject({ ...subject, requestedById: z.uuid().nullable() }),
    live: { ...live, fields: ['taskId', 'kind', 'recordType', 'recordId'] },
  }),
  defineEvent({
    type: 'approval.rule_changed',
    context: 'approvals',
    description: 'An approval rule was written, changed, switched on or switched off.',
    payload: z.strictObject({ ruleId: z.uuid(), kind: z.enum(APPROVAL_TASK_KINDS), change: z.enum(RULE_CHANGES), active: z.boolean() }),
    live: { ...live, fields: ['ruleId', 'kind', 'change', 'active'] },
  }),
] as const
