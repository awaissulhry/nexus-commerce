import { defineManifest } from '../../core/manifest'

/**
 * Receivables (B-W2a-55; FIN-109 customer ledger and statement, FIN-110 ageing, FIN-111 the reminder ladder; design
 * finance.receivables, SCR-151): office only. Every row belongs to a company and a customer, so the handlers check each
 * with can() and filter the lists (`record`). Amounts travel only with the price grain. Switching reminders ON also asks
 * a fresh step-up (the Owner's switch).
 */
export const manifest = defineManifest({
  'GET /receivables/ageing': { audiences: ['office'], permission: 'receivables.view', scope: 'record' },
  'GET /receivables/customers/:partyId/statement': { audiences: ['office'], permission: 'receivables.view', scope: 'record' },
  'GET /receivables/customers/:partyId/statement/pdf': { audiences: ['office'], permission: 'receivables.view', scope: 'record' },
  'POST /receivables/customers/:partyId/statement/send': { audiences: ['office'], permission: 'receivables.statements.send', scope: 'record' },
  'GET /receivables/settings': { audiences: ['office'], permission: 'receivables.view', scope: 'record' },
  'PUT /receivables/settings': { audiences: ['office'], permission: 'receivables.settings.manage', scope: 'record' },
  'PUT /receivables/settings/switch': { audiences: ['office'], permission: 'receivables.reminders.switch', scope: 'record' },
  'GET /receivables/reminders': { audiences: ['office'], permission: 'receivables.view', scope: 'record' },
  'GET /receivables/reminders/counts': { audiences: ['office'], permission: 'receivables.view', scope: 'record' },
  'GET /receivables/reminders/:reminderId': { audiences: ['office'], permission: 'receivables.view', scope: 'record' },
  'GET /receivables/reminders/:reminderId/pdf': { audiences: ['office'], permission: 'receivables.view', scope: 'record' },
  'POST /receivables/reminders': { audiences: ['office'], permission: 'receivables.reminders.manage', scope: 'record' },
  'POST /receivables/reminders/approve': { audiences: ['office'], permission: 'receivables.reminders.approve', scope: 'record' },
  'PATCH /receivables/reminders/:reminderId': { audiences: ['office'], permission: 'receivables.reminders.manage', scope: 'record' },
  'POST /receivables/reminders/:reminderId/approve': { audiences: ['office'], permission: 'receivables.reminders.approve', scope: 'record' },
  'POST /receivables/reminders/:reminderId/send': { audiences: ['office'], permission: 'receivables.reminders.approve', scope: 'record' },
  'POST /receivables/reminders/:reminderId/skip': { audiences: ['office'], permission: 'receivables.reminders.manage', scope: 'record' },
  'POST /receivables/reminders/:reminderId/cancel': { audiences: ['office'], permission: 'receivables.reminders.manage', scope: 'record' },
  // B-W2b-21 (D.Lgs. 231/2002 art. 5; interest-rates.ts): the half-year reference rates of statutory interest, tenant-wide
  // (written only with receivables.settings.manage over every company, like the tenant settings row).
  'GET /receivables/interest-rates': { audiences: ['office'], permission: 'receivables.view', scope: 'record' },
  'POST /receivables/interest-rates': { audiences: ['office'], permission: 'receivables.settings.manage', scope: 'record' },
  'PATCH /receivables/interest-rates/:rateId': { audiences: ['office'], permission: 'receivables.settings.manage', scope: 'record' },
})
