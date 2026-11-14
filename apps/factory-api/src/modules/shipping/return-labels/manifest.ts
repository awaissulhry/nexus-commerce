import { defineManifest } from '../../../core/manifest'

/**
 * Return labels (B-W2b-398; LOG-112). Office: the return's company, site and customer are checked with can() in the handlers
 * (`record`): reading is sales.returns.view, making and withdrawing one (a carrier booking, a link to the customer)
 * sales.returns.manage. Link: a RETURN_LABEL link of a ReturnAuthorisation reads its page (links.open), books its label
 * (links.confirm) and downloads it (links.download); any other link is the one 404.
 */
export const manifest = defineManifest({
  'GET /sales/returns/:returnId/return-labels': { audiences: ['office'], permission: 'sales.returns.view', scope: 'record' },
  'POST /sales/returns/:returnId/return-labels': { audiences: ['office'], permission: 'sales.returns.manage', scope: 'record' },
  'POST /sales/returns/:returnId/return-labels/:labelId/cancel': { audiences: ['office'], permission: 'sales.returns.manage', scope: 'record' },
  'GET /sales/returns/:returnId/return-labels/:labelId/pdf': { audiences: ['office'], permission: 'sales.returns.view', scope: 'record' },
  'GET /link/return-label': { audiences: ['link'], permission: 'links.open', scope: 'record' },
  'POST /link/return-label/book': { audiences: ['link'], permission: 'links.confirm', scope: 'record' },
  'POST /link/return-label/download': { audiences: ['link'], permission: 'links.download', scope: 'record' },
})
