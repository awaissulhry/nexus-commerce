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
})
