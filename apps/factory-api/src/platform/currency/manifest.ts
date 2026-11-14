import { defineManifest } from '../../core/manifest'

/**
 * Currencies and exchange rates (B-W2b-389; PLT-132, PLT-133; design finance.settings "Currencies & rates"). Office only,
 * scoped by record: a company's currencies are checked with can() against the company (read currencies.view, write
 * currencies.manage); the rates are the tenant's, read with currencies.view and written (a manual rate, the daily ECB
 * switch, reading the ECB file now) only with currencies.manage over every company — the handlers check it. Writes take an
 * Idempotency-Key.
 */
export const manifest = defineManifest({
  'GET /currencies': { audiences: ['office'], permission: 'currencies.view', scope: 'record' },
  'POST /currencies': { audiences: ['office'], permission: 'currencies.manage', scope: 'record' },
  'POST /currencies/:currencyId/switch': { audiences: ['office'], permission: 'currencies.manage', scope: 'record' },
  'GET /exchange-rates': { audiences: ['office'], permission: 'currencies.view', scope: 'record' },
  'GET /exchange-rates/day': { audiences: ['office'], permission: 'currencies.view', scope: 'record' },
  'PUT /exchange-rates/manual': { audiences: ['office'], permission: 'currencies.manage', scope: 'record' },
  'DELETE /exchange-rates/manual/:rateId': { audiences: ['office'], permission: 'currencies.manage', scope: 'record' },
  'PUT /exchange-rates/feed': { audiences: ['office'], permission: 'currencies.manage', scope: 'record' },
  'POST /exchange-rates/fetch': { audiences: ['office'], permission: 'currencies.manage', scope: 'record' },
})
