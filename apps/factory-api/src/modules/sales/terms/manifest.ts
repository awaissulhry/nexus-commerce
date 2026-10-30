import { defineManifest } from '../../../core/manifest'

/**
 * The payment terms library (B-W2a-19; FIN-075; design finance.settings "Payment terms"): office only. Terms belong to a
 * company or to every company, so each handler checks the entry with can() and filters the list with scopeWhere()
 * (`record`). Reading is paymentterms.view (the quotes and the customer's commercial terms pick from it); changing
 * paymentterms.manage.
 */
export const manifest = defineManifest({
  'GET /sales/payment-terms': { audiences: ['office'], permission: 'paymentterms.view', scope: 'record' },
  'GET /sales/payment-terms/:termsId': { audiences: ['office'], permission: 'paymentterms.view', scope: 'record' },
  'POST /sales/payment-terms': { audiences: ['office'], permission: 'paymentterms.manage', scope: 'record' },
  'PATCH /sales/payment-terms/:termsId': { audiences: ['office'], permission: 'paymentterms.manage', scope: 'record' },
  'POST /sales/payment-terms/:termsId/archive': { audiences: ['office'], permission: 'paymentterms.manage', scope: 'record' },
  'POST /sales/payment-terms/:termsId/reactivate': { audiences: ['office'], permission: 'paymentterms.manage', scope: 'record' },
})
