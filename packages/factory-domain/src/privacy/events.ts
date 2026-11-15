import { z } from 'zod'
import { defineEvent } from '../events/define'
import { NOTICE_KINDS } from './notices'
// B-W2b-405: data requests, erasure and retention (the lists are the factory-db enums).
import { DATA_REQUEST_KINDS, DATA_REQUEST_STATUSES, DATA_SUBJECT_KINDS } from './retention/requests'
import { RETENTION_ACTIONS, SWEEP_MODES, SWEEP_STATUSES } from './retention/retention'

/**
 * The privacy pack's events (B-W1-36; A2 SCR-086 "Live: worker_notice.acknowledged → counts"), emitted by
 * apps/factory-api's platform/privacy in the commands that make the change. Ids, kinds, numbers and labels only: no
 * person's name, no text of a notice, nothing a person signed.
 *
 *   privacy.notice_published     a notice version came into force; the one it replaced (if any) is superseded. A new
 *                                worker notice holds every worker's scans until they acknowledge it (next sign-in).
 *   privacy.notice_acknowledged  a worker (on the tablet, or a signed paper copy the office recorded) or an office person
 *                                acknowledged a version: the counts on Admin › Privacy & notices.
 *   privacy.dpia_stored          a company's signed DPIA was stored (the floor gate reads it); the earlier one is
 *                                superseded.
 * B-W2b-405 (data protection in depth; design admin.privacy live "privacy_request.* → requests"):
 *   privacy.request_changed      a person's data request moved (received, identity checked, extended, its package ready or
 *                                failed, the person erased, done, refused, withdrawn): the Data requests list
 *   privacy.request_collect_asked  an access request's package asked for: the worker's handler collects it
 *   privacy.person_erased        an erasure ran on its request: how many records were anonymised, deleted and kept (counts)
 *   privacy.retention_rule_changed  a retention rule added, changed, switched off, or switched on to apply (GATE-PRIVACY)
 *   privacy.retention_swept      one sweep of one rule ended: due, applied, held and failed counts
 *   privacy.safety_report_form_switched  a company's outside doors of product-safety reports switched on or off
 */
export const REQUEST_CHANGES = ['RECEIVED', 'IDENTITY_CHECKED', 'EXTENDED', 'PACKAGE_READY', 'PACKAGE_FAILED', 'ERASED', 'DONE', 'REFUSED', 'WITHDRAWN'] as const
export const RULE_CHANGES = ['ADDED', 'CHANGED', 'SWITCHED_OFF', 'APPLY_ON', 'APPLY_OFF'] as const
export const ACK_CHANNELS = ['DEVICE', 'PAPER', 'OFFICE'] as const

const kind = z.enum(NOTICE_KINDS)

export const events = [
  defineEvent({
    type: 'privacy.notice_published',
    context: 'privacy',
    description: "A version of a company's privacy notice came into force; the version it replaces is superseded.",
    payload: z.strictObject({ noticeId: z.uuid(), companyId: z.uuid(), kind, versionNo: z.number().int().min(1), label: z.string(), supersededId: z.uuid().nullable() }),
    live: { permission: 'privacy.view', fields: ['noticeId', 'kind', 'versionNo'] },
  }),
  defineEvent({
    type: 'privacy.notice_acknowledged',
    context: 'privacy',
    description: 'A worker or an office person acknowledged the version of a privacy notice in force.',
    payload: z.strictObject({ noticeId: z.uuid(), kind, channel: z.enum(ACK_CHANNELS) }),
    live: { permission: 'privacy.view', fields: ['noticeId', 'kind'] },
  }),
  defineEvent({
    type: 'privacy.dpia_stored',
    context: 'privacy',
    description: "A company's signed DPIA was stored; the earlier one is superseded.",
    payload: z.strictObject({ dpiaId: z.uuid(), companyId: z.uuid(), versionNo: z.number().int().min(1), supersededId: z.uuid().nullable() }),
    live: { permission: 'privacy.view', fields: ['dpiaId', 'versionNo'] },
  }),
  // B-W2b-405
  defineEvent({
    type: 'privacy.request_changed',
    context: 'privacy',
    description: "A person's data request moved on: received, identity checked, extended, its package ready or failed, the person erased, done, refused or withdrawn.",
    payload: z.strictObject({ requestId: z.uuid(), companyId: z.uuid(), kind: z.enum(DATA_REQUEST_KINDS), personKind: z.enum(DATA_SUBJECT_KINDS), status: z.enum(DATA_REQUEST_STATUSES), change: z.enum(REQUEST_CHANGES) }),
    live: { permission: 'privacy.requests.view', fields: ['requestId', 'status', 'change'] },
  }),
  defineEvent({
    type: 'privacy.request_collect_asked',
    context: 'privacy',
    description: "An access request's package was asked for: the person's records and files are collected in the background.",
    payload: z.strictObject({ requestId: z.uuid(), companyId: z.uuid() }),
    live: { permission: 'privacy.requests.view', fields: ['requestId'] },
  }),
  defineEvent({
    type: 'privacy.person_erased',
    context: 'privacy',
    description: 'A person was erased or anonymised on their request: how many records were anonymised, deleted and kept by law.',
    payload: z.strictObject({ requestId: z.uuid(), companyId: z.uuid(), personKind: z.enum(DATA_SUBJECT_KINDS), anonymised: z.number().int().min(0), deleted: z.number().int().min(0), kept: z.number().int().min(0) }),
    live: { permission: 'privacy.requests.view', fields: ['requestId'] },
  }),
  defineEvent({
    type: 'privacy.retention_rule_changed',
    context: 'privacy',
    description: 'A retention rule was added, changed, switched off, or switched on to apply (until then its sweep only reports).',
    payload: z.strictObject({ ruleId: z.uuid(), companyId: z.uuid().nullable(), recordType: z.string(), keepMonths: z.number().int().min(1), thenAction: z.enum(RETENTION_ACTIONS), change: z.enum(RULE_CHANGES) }),
    live: { permission: 'privacy.view', fields: ['ruleId', 'recordType', 'change'] },
  }),
  defineEvent({
    type: 'privacy.retention_swept',
    context: 'privacy',
    description: 'One sweep of a retention rule ended: what was due, applied, held and failed.',
    payload: z.strictObject({
      sweepId: z.uuid(),
      ruleId: z.uuid(),
      recordType: z.string(),
      mode: z.enum(SWEEP_MODES),
      status: z.enum(SWEEP_STATUSES),
      due: z.number().int().min(0),
      applied: z.number().int().min(0),
      held: z.number().int().min(0),
      failed: z.number().int().min(0),
    }),
    live: { permission: 'privacy.view', fields: ['sweepId', 'ruleId', 'status'] },
  }),
  defineEvent({
    type: 'privacy.safety_report_form_switched',
    context: 'privacy',
    description: "A company's outside doors of product-safety reports (the public DoC page and the portal) were switched on or off.",
    payload: z.strictObject({ companyId: z.uuid(), on: z.boolean() }),
    live: { permission: 'privacy.view', fields: ['companyId', 'on'] },
  }),
] as const
