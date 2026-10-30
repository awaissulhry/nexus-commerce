import { defineManifest } from '../../core/manifest'

/**
 * Business calendars and shift patterns (B-W2a-08; PLT-103, PLN-001, PLN-002). Office only, scoped by record: the
 * handlers check each calendar with can() against its owner (company and site; a supplier's: company and party) and
 * filter lists with scopeWhere(). A calendar's writes are listed with calendars.view to reach them: the handler then
 * asks calendars.manage (a company's calendar: over every site of the company) or, for a supplier's calendar,
 * calendars.suppliers.manage. Patterns are calendars.manage over every site of their company (tenant-wide: every
 * company). Writes take an Idempotency-Key.
 */
export const manifest = defineManifest({
  'GET /calendars': { audiences: ['office'], permission: 'calendars.view', scope: 'record' },
  'POST /calendars': { audiences: ['office'], permission: 'calendars.view', scope: 'record' },
  'GET /calendars/working-time': { audiences: ['office'], permission: 'calendars.view', scope: 'record' },
  'GET /calendars/working-minutes': { audiences: ['office'], permission: 'calendars.view', scope: 'record' },
  'GET /calendars/next-working-day': { audiences: ['office'], permission: 'calendars.view', scope: 'record' },
  'GET /calendars/supplier-closed-days': { audiences: ['office'], permission: 'calendars.view', scope: 'record' },
  'GET /calendars/supplier-order-by': { audiences: ['office'], permission: 'calendars.view', scope: 'record' },
  'GET /calendars/:calendarId': { audiences: ['office'], permission: 'calendars.view', scope: 'record' },
  'PATCH /calendars/:calendarId': { audiences: ['office'], permission: 'calendars.view', scope: 'record' },
  'POST /calendars/:calendarId/archive': { audiences: ['office'], permission: 'calendars.view', scope: 'record' },
  'POST /calendars/:calendarId/days': { audiences: ['office'], permission: 'calendars.view', scope: 'record' },
  'POST /calendars/:calendarId/days/remove': { audiences: ['office'], permission: 'calendars.view', scope: 'record' },
  'POST /calendars/:calendarId/holidays': { audiences: ['office'], permission: 'calendars.view', scope: 'record' },
  'GET /shift-patterns': { audiences: ['office'], permission: 'calendars.view', scope: 'record' },
  'POST /shift-patterns': { audiences: ['office'], permission: 'calendars.manage', scope: 'record' },
  'GET /shift-patterns/:patternId': { audiences: ['office'], permission: 'calendars.view', scope: 'record' },
  'PATCH /shift-patterns/:patternId': { audiences: ['office'], permission: 'calendars.manage', scope: 'record' },
  'PUT /shift-patterns/:patternId/segments': { audiences: ['office'], permission: 'calendars.manage', scope: 'record' },
  'POST /shift-patterns/:patternId/archive': { audiences: ['office'], permission: 'calendars.manage', scope: 'record' },
})
