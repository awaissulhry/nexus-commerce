import { defineManifest } from '../../../core/manifest'

/**
 * Production reports (B-W2a-38; MES-301, MES-160): office only. The daily production report and the e-mail settings with
 * production.reports.view (a person subscribes themselves; naming colleagues also needs production.reports.subscribe,
 * checked in the handler); the floor overview by line with workorders.view (Floor now's permission). Handlers check the
 * site with can() and filter with scopeWhere() (`record`).
 */
export const manifest = defineManifest({
  'GET /production/reports/daily': { audiences: ['office'], permission: 'production.reports.view', scope: 'record' },
  'GET /production/reports/lines': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'GET /production/reports/subscriptions': { audiences: ['office'], permission: 'production.reports.view', scope: 'record' },
  'GET /production/reports/recipients': { audiences: ['office'], permission: 'production.reports.subscribe', scope: 'record' },
  'POST /production/reports/subscriptions': { audiences: ['office'], permission: 'production.reports.view', scope: 'record' },
  'PATCH /production/reports/subscriptions/:subscriptionId': { audiences: ['office'], permission: 'production.reports.view', scope: 'record' },
})
