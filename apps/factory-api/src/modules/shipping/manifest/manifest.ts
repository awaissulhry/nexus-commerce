import { defineManifest } from '../../../core/manifest'

/**
 * The day's close (B-W2b-395; LOG-049): office only. A day sheet belongs to a site of a company, so the handlers check it with
 * can() (`record`). Reading (End of day, the preview, one sheet, its PDF) needs shipping.view; closing shipping.manage (the
 * print job also print.documents at the printer's site, checked by the print module).
 */
export const manifest = defineManifest({
  'GET /shipping/end-of-day': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /shipping/end-of-day/preview': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/end-of-day/close': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'GET /shipping/manifests/:manifestId': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /shipping/manifests/:manifestId/pdf': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
})
