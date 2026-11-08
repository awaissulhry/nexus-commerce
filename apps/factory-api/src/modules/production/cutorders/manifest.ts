import { defineManifest } from '../../../core/manifest'

/**
 * Cut orders and cut tickets (B-W2b-112; MES-034, MES-037, MES-041, MES-043; design production.cutting, floor.fabriccut). The
 * office reads cut orders with the cutting room's production.cutting.view and plans, releases, sends back, cancels, allocates
 * rolls, prints and voids tickets with production.cutorders.manage; the table scans a ticket at the start and the end of cutting
 * and numbers a counted lay's plies with production.cut (a floor device: its own site; the office's holders too for the stickers).
 * Handlers check each cut order with can() and filter lists with scopeWhere() (`record`).
 */
export const manifest = defineManifest({
  'GET /production/cut-orders': { audiences: ['office'], permission: 'production.cutting.view', scope: 'record' },
  'GET /production/cut-orders/waiting': { audiences: ['office'], permission: 'production.cutting.view', scope: 'record' },
  'GET /production/cut-orders/:cutOrderId': { audiences: ['office'], permission: 'production.cutting.view', scope: 'record' },
  'POST /production/cut-orders': { audiences: ['office'], permission: 'production.cutorders.manage', scope: 'record' },
  'PUT /production/cut-orders/:cutOrderId': { audiences: ['office'], permission: 'production.cutorders.manage', scope: 'record' },
  'POST /production/cut-orders/:cutOrderId/release': { audiences: ['office'], permission: 'production.cutorders.manage', scope: 'record' },
  'POST /production/cut-orders/:cutOrderId/unrelease': { audiences: ['office'], permission: 'production.cutorders.manage', scope: 'record' },
  'POST /production/cut-orders/:cutOrderId/cancel': { audiences: ['office'], permission: 'production.cutorders.manage', scope: 'record' },
  'GET /production/cut-orders/:cutOrderId/rolls': { audiences: ['office'], permission: 'production.cutting.view', scope: 'record' },
  'POST /production/cut-orders/:cutOrderId/lays/:layId/rolls': { audiences: ['office'], permission: 'production.cutorders.manage', scope: 'record' },
  'POST /production/cut-orders/:cutOrderId/lays/:layId/rolls/:layRollId/remove': { audiences: ['office'], permission: 'production.cutorders.manage', scope: 'record' },
  'GET /production/cut-tickets/waiting': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'GET /production/cut-tickets/scan': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'POST /production/cut-tickets/start': { audiences: ['floor'], permission: 'production.cut', scope: 'record' },
  'POST /production/cut-tickets/finish': { audiences: ['floor'], permission: 'production.cut', scope: 'record' },
  'POST /production/cut-tickets/:ticketId/void': { audiences: ['office'], permission: 'production.cutorders.manage', scope: 'record' },
  'POST /production/cut-tickets/:ticketId/print': { audiences: ['office'], permission: 'production.cutorders.manage', scope: 'record' },
  'POST /production/lays/:layId/ply-runs': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'POST /production/ply-runs/:runId/print': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'POST /production/ply-runs/:runId/void': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'GET /production/ply-runs/:runId/stickers': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
})
