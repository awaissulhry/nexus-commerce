import { defineManifest } from '../../core/manifest'

/**
 * Email in's routes (plan A1 §3.2 step 2, §3.7; A2 SCR-019 "Mail to sort"). A received mail belongs to its SES account's
 * company, so the handlers check each one with can() and filter the list with scopeWhere() (`record`); writing it into a
 * record's thread also needs threads.post over the record. Office only: a party reads what it sent as its thread's
 * INBOUND message (platform/threads). SES's notifications arrive through platform/inbound, never here.
 */
export const manifest = defineManifest({
  'GET /email/inbound': { audiences: ['office'], permission: 'email.triage', scope: 'record' },
  'GET /email/inbound/:inboundEmailId': { audiences: ['office'], permission: 'email.triage', scope: 'record' },
  'POST /email/inbound/:inboundEmailId/assign': { audiences: ['office'], permission: 'email.triage', scope: 'record' },
  'POST /email/inbound/:inboundEmailId/release': { audiences: ['office'], permission: 'email.triage', scope: 'record' },
  'POST /email/inbound/:inboundEmailId/reject': { audiences: ['office'], permission: 'email.triage', scope: 'record' },
  // B-W2b-394 (COL-021): the capture address — read by whoever writes mail (email.send), set up by email.inboxes.manage; each
  // checked with can() over its company.
  'GET /email/capture': { audiences: ['office'], permission: 'email.send', scope: 'record' },
  'POST /email/capture': { audiences: ['office'], permission: 'email.inboxes.manage', scope: 'record' },
  'PUT /email/capture/:captureAddressId': { audiences: ['office'], permission: 'email.inboxes.manage', scope: 'record' },
  'POST /email/capture/:captureAddressId/turn-off': { audiences: ['office'], permission: 'email.inboxes.manage', scope: 'record' },
  // B-W2b-394 (COL-027): team inboxes — worked with email.triage by their members (the handlers check membership and the
  // mail's company), set up with email.inboxes.manage.
  'GET /email/team-inboxes': { audiences: ['office'], permission: 'email.triage', scope: 'record' },
  'POST /email/team-inboxes': { audiences: ['office'], permission: 'email.inboxes.manage', scope: 'record' },
  'GET /email/team-inboxes/people': { audiences: ['office'], permission: 'email.triage', scope: 'record' },
  'PUT /email/team-inboxes/:teamInboxId': { audiences: ['office'], permission: 'email.inboxes.manage', scope: 'record' },
  'GET /email/team-inboxes/:teamInboxId/mail': { audiences: ['office'], permission: 'email.triage', scope: 'record' },
  'POST /email/inbound/:inboundEmailId/assignee': { audiences: ['office'], permission: 'email.triage', scope: 'record' },
  'POST /email/inbound/:inboundEmailId/close': { audiences: ['office'], permission: 'email.triage', scope: 'record' },
  'POST /email/inbound/:inboundEmailId/reopen': { audiences: ['office'], permission: 'email.triage', scope: 'record' },
  'POST /email/inbound/:inboundEmailId/snooze': { audiences: ['office'], permission: 'email.triage', scope: 'record' },
  'POST /email/inbound/:inboundEmailId/follow-up': { audiences: ['office'], permission: 'email.triage', scope: 'record' },
  'POST /email/inbound/:inboundEmailId/team-inbox': { audiences: ['office'], permission: 'email.triage', scope: 'record' },
})
