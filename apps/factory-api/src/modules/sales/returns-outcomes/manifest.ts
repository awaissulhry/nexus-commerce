import { defineManifest } from '../../../core/manifest'

/**
 * Remakes, exchanges and closing a return (B-W2b-346; SAL-298, SAL-350, SAL-351, SAL-355, SAL-360; follow-ups RX2:01,
 * RX2:02; design sales.returns "Return (RMA)", returns.close, floor.returnsin, links.claim, portal.customer.returns). No new
 * permission: W2a's returns permissions and B-W2b-192's portal and link ones. Handlers check each RMA with can() over its
 * company, site and customer (`record`). The office reads a return's outcomes, sends goods back unchanged (with the return
 * DDT: shipping.ddt.issue as well, checked by the handler), closes with a finish reason and asks a remake on an RMA it made;
 * the dock (office, or the floor at its own site) splits a line of which only part arrived; the customer asks a remake in
 * the portal (portal.returns.request, checked by the handler as B-W2b-192's) or by a claim link (links.submit).
 */
const view = { audiences: ['office'], permission: 'sales.returns.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'sales.returns.manage', scope: 'record' } as const
const decide = { audiences: ['office'], permission: 'sales.returns.decide', scope: 'record' } as const
const receive = { audiences: ['office', 'floor'], permission: 'sales.returns.receive', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/returns/:returnId/outcomes': view,
  'POST /sales/returns/:returnId/lines/:lineId/split': receive,
  'POST /sales/returns/:returnId/send-back': decide,
  'POST /sales/returns/:returnId/finish': manage,
  'POST /sales/returns/:returnId/remake': manage,
  'POST /portal/returns/remake': { audiences: ['partner'], permission: 'portal.returns.view', scope: 'party' },
  'POST /link/claim/remake': { audiences: ['link'], permission: 'links.submit', scope: 'record' },
})
