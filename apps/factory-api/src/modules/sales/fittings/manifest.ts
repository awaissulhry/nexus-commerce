import { defineManifest } from '../../../core/manifest'

/**
 * Fittings, alterations and remakes (B-W2b-360; SAL-054, SAL-297, SAL-353; design sales.mtm › Fittings, SCR-036, drawn by
 * B-W2b-362). Office only. Reading appointments and fitting results is sales.measurements.view (the rider's personal data); booking,
 * moving, closing and recording sales.fittings.manage (the alteration also sales.repairs.manage, in the handler); the remake order
 * is the return's decision (sales.returns.decide; orders.manage and sales.measurements.view in the handler), its read the return's
 * (sales.returns.view). Each handler checks the record's company and customer with can() (`record`).
 */
const view = { audiences: ['office'], permission: 'sales.measurements.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'sales.fittings.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/fittings/appointments': view,
  'POST /sales/fittings/appointments': manage,
  'GET /sales/fittings/appointments/:appointmentId': view,
  'PATCH /sales/fittings/appointments/:appointmentId': manage,
  'POST /sales/fittings/appointments/:appointmentId/close': manage,
  'POST /sales/fittings/appointments/:appointmentId/cancel': manage,
  'POST /sales/fittings/appointments/:appointmentId/invite': manage,
  'POST /sales/fittings/appointments/:appointmentId/led-to': manage,
  'POST /sales/fittings/results': manage,
  'GET /sales/fittings/results/:resultId': view,
  'POST /sales/fittings/results/:resultId/alteration': manage,
  'POST /sales/fittings/results/:resultId/revision': manage,
  'GET /sales/mtm/profiles/:profileId/fittings': view,
  'GET /sales/returns/:returnId/remake-order': { audiences: ['office'], permission: 'sales.returns.view', scope: 'record' },
  'POST /sales/returns/:returnId/remake-order': { audiences: ['office'], permission: 'sales.returns.decide', scope: 'record' },
})
