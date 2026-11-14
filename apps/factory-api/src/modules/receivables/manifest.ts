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
  // B-W2b-402 (FIN-112, FIN-113, FIN-126, FIN-128): collections. Settling a Ri.Ba. item paid also needs payments.record (it
  // records the payment); a trusted level and turning a collections switch ON also ask a fresh step-up.
  'GET /receivables/riba/candidates': { audiences: ['office'], permission: 'receivables.view', scope: 'record' },
  'GET /receivables/riba/batches': { audiences: ['office'], permission: 'receivables.view', scope: 'record' },
  'POST /receivables/riba/batches': { audiences: ['office'], permission: 'receivables.riba.manage', scope: 'record' },
  'GET /receivables/riba/batches/:batchId': { audiences: ['office'], permission: 'receivables.view', scope: 'record' },
  'PUT /receivables/riba/batches/:batchId/items': { audiences: ['office'], permission: 'receivables.riba.manage', scope: 'record' },
  'POST /receivables/riba/batches/:batchId/issue': { audiences: ['office'], permission: 'receivables.riba.manage', scope: 'record' },
  'POST /receivables/riba/batches/:batchId/cancel': { audiences: ['office'], permission: 'receivables.riba.manage', scope: 'record' },
  'POST /receivables/riba/batches/:batchId/settle': { audiences: ['office'], permission: 'receivables.riba.manage', scope: 'record' },
  'GET /receivables/riba/unpaid': { audiences: ['office'], permission: 'receivables.view', scope: 'record' },
  'GET /receivables/stops': { audiences: ['office'], permission: 'receivables.view', scope: 'record' },
  'POST /receivables/stops': { audiences: ['office'], permission: 'receivables.reminders.manage', scope: 'record' },
  'PATCH /receivables/stops/:stopId': { audiences: ['office'], permission: 'receivables.reminders.manage', scope: 'record' },
  'POST /receivables/stops/:stopId/lift': { audiences: ['office'], permission: 'receivables.reminders.manage', scope: 'record' },
  'GET /receivables/customers/:partyId/trust': { audiences: ['office'], permission: 'receivables.view', scope: 'record' },
  'PUT /receivables/customers/:partyId/trust': { audiences: ['office'], permission: 'receivables.reminders.trust', scope: 'record' },
  'GET /receivables/collections/settings': { audiences: ['office'], permission: 'receivables.view', scope: 'record' },
  'PUT /receivables/collections/settings': { audiences: ['office'], permission: 'receivables.collections.switch', scope: 'record' },
})
