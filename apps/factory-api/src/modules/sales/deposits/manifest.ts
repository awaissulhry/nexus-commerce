import { defineManifest } from '../../../core/manifest'

/**
 * A company's bank account (B-W1-24; Q12): office only, can() on the company in the handler (`record`). The write is
 * companies.bank.manage and a fresh step-up (A1 §3.10: bank details).
 */
export const manifest = defineManifest({
  'GET /companies/:companyId/bank-details': { audiences: ['office'], permission: 'companies.bank.view', scope: 'record' },
  'PUT /companies/:companyId/bank-details': { audiences: ['office'], permission: 'companies.bank.manage', scope: 'record' },
})
