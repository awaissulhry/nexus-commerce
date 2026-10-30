import { defineManifest } from '../../../core/manifest'

/**
 * Customer returns (B-W2a-43; SAL-333, SAL-335, SAL-340, SAL-341, SAL-352, SAL-362, LOG-114, QHS-117; design
 * sales.returns and floor.returnsin). Handlers check each RMA with can() over its company, site and customer (`record`).
 * The office makes, reads and decides returns; the dock (office, or the floor at its own site) finds an RMA by its
 * number, receives the goods and grades them, with photos. The return policy is kept with the sales settings' permission.
 */
const view = { audiences: ['office'], permission: 'sales.returns.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'sales.returns.manage', scope: 'record' } as const
const receive = { audiences: ['office', 'floor'], permission: 'sales.returns.receive', scope: 'record' } as const
const inspect = { audiences: ['office', 'floor'], permission: 'sales.returns.inspect', scope: 'record' } as const
const decide = { audiences: ['office'], permission: 'sales.returns.decide', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/returns': view,
  'GET /sales/returns/counts': view,
  'GET /sales/returns/policy': view,
  'PUT /sales/returns/policy': { audiences: ['office'], permission: 'sales.settings.manage', scope: 'record' },
  'GET /sales/returns/returnable': manage,
  'POST /sales/returns/preview': manage,
  'POST /sales/returns': manage,
  'GET /sales/returns/dock': receive,
  'GET /sales/returns/:returnId': view,
  'PATCH /sales/returns/:returnId': manage,
  'POST /sales/returns/:returnId/lines': manage,
  'PATCH /sales/returns/:returnId/lines/:lineId': manage,
  'DELETE /sales/returns/:returnId/lines/:lineId': manage,
  'POST /sales/returns/:returnId/cancel': manage,
  'POST /sales/returns/:returnId/close': manage,
  'GET /sales/returns/:returnId/dock': receive,
  'POST /sales/returns/:returnId/receipts': receive,
  'POST /sales/returns/:returnId/receipts/:receiptId/photos': receive,
  'POST /sales/returns/:returnId/receipts/:receiptId/photos/:fileId/complete': receive,
  'POST /sales/returns/:returnId/grades': inspect,
  'POST /sales/returns/:returnId/lines/:lineId/photos': inspect,
  'POST /sales/returns/:returnId/lines/:lineId/photos/:fileId/complete': inspect,
  'POST /sales/returns/:returnId/decisions/preview': decide,
  'POST /sales/returns/:returnId/decisions': decide,
  'POST /sales/returns/:returnId/replacement-order': decide,
})
