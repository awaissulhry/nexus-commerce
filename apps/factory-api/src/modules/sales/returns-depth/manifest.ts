import { defineManifest } from '../../../core/manifest'

/**
 * Returns in depth (B-W2b-341; SAL-336, SAL-337, SAL-338, SAL-342, SAL-343, SAL-346; design sales.returns "Return (RMA)",
 * sales.settings "Return policy and reasons", floor.returnsin "Scan the return"). Handlers check each RMA with can() over
 * its company, site and customer (`record`), and the policies and fee rules over their company. The office reads the
 * depth of a return and binds it to its policy, names its garments, credits a line without the goods (within the approval
 * limit) and prints its papers; the policies and fee rules are kept with the sales settings' permission; the dock (office,
 * or the floor at its own site) scans a garment's serial to name it on its line.
 */
const view = { audiences: ['office'], permission: 'sales.returns.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'sales.returns.manage', scope: 'record' } as const
const decide = { audiences: ['office'], permission: 'sales.returns.decide', scope: 'record' } as const
const receive = { audiences: ['office', 'floor'], permission: 'sales.returns.receive', scope: 'record' } as const
const settings = { audiences: ['office'], permission: 'sales.settings.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/returns/policies': view,
  'POST /sales/returns/policies': settings,
  'PATCH /sales/returns/policies/:policyId': settings,
  'POST /sales/returns/policies/:policyId/retire': settings,
  'GET /sales/returns/fee-rules': view,
  'POST /sales/returns/fee-rules': settings,
  'PATCH /sales/returns/fee-rules/:ruleId': settings,
  'POST /sales/returns/policy-check': manage,
  'GET /sales/returns/arrived-late': view,
  'GET /sales/returns/:returnId/depth': view,
  'POST /sales/returns/:returnId/policy': manage,
  'POST /sales/returns/:returnId/fees/preview': decide,
  'GET /sales/returns/:returnId/lines/:lineId/garments': view,
  'PUT /sales/returns/:returnId/lines/:lineId/garment': manage,
  'POST /sales/returns/:returnId/garments/fill': manage,
  'POST /sales/returns/:returnId/garments/scan': receive,
  'POST /sales/returns/:returnId/lines/:lineId/credit-without-return/preview': decide,
  'POST /sales/returns/:returnId/lines/:lineId/credit-without-return': decide,
  'POST /sales/returns/:returnId/scan-code': manage,
  'GET /sales/returns/:returnId/papers': view,
})
