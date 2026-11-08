import { defineManifest } from '../../../core/manifest'

/**
 * Secondary processes after cutting and trolleys to sewing (B-W2b-117; MES-047, MES-048; design floor.fabriccut "Send to sewing",
 * production.cutting). The office reads both on the Cutting page with production.cutting.view; the office and the site's tablets
 * give bundles a process and move it with production.secondary, and load, send, receive and cancel trolleys with
 * production.trolleys (a floor device: its own site). Handlers check each record with can() and filter lists with scopeWhere()
 * (`record`). Recut tickets (MES-044) are the rework folder's (../rework/manifest.ts).
 */
export const manifest = defineManifest({
  'GET /production/secondary-processes': { audiences: ['office'], permission: 'production.cutting.view', scope: 'record' },
  'GET /production/secondary-processes/bundle': { audiences: ['office', 'floor'], permission: 'production.secondary', scope: 'record' },
  'POST /production/secondary-processes': { audiences: ['office', 'floor'], permission: 'production.secondary', scope: 'record' },
  'POST /production/secondary-processes/:processId/start': { audiences: ['office', 'floor'], permission: 'production.secondary', scope: 'record' },
  'POST /production/secondary-processes/:processId/done': { audiences: ['office', 'floor'], permission: 'production.secondary', scope: 'record' },
  'POST /production/secondary-processes/:processId/cancel': { audiences: ['office', 'floor'], permission: 'production.secondary', scope: 'record' },
  'GET /production/trolleys': { audiences: ['office'], permission: 'production.cutting.view', scope: 'record' },
  'GET /production/trolleys/open': { audiences: ['office', 'floor'], permission: 'production.trolleys', scope: 'record' },
  'GET /production/trolleys/scan': { audiences: ['office', 'floor'], permission: 'production.trolleys', scope: 'record' },
  'GET /production/trolleys/:issueId': { audiences: ['office'], permission: 'production.cutting.view', scope: 'record' },
  'POST /production/trolleys/load': { audiences: ['office', 'floor'], permission: 'production.trolleys', scope: 'record' },
  'POST /production/trolleys/unload': { audiences: ['office', 'floor'], permission: 'production.trolleys', scope: 'record' },
  'POST /production/trolleys/send': { audiences: ['office', 'floor'], permission: 'production.trolleys', scope: 'record' },
  'POST /production/trolleys/receive': { audiences: ['office', 'floor'], permission: 'production.trolleys', scope: 'record' },
  'POST /production/trolleys/:issueId/cancel': { audiences: ['office', 'floor'], permission: 'production.trolleys', scope: 'record' },
})
