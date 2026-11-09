import { z } from 'zod'
import { commerceImportView, startedStylesView, type CommerceImportView, type StartedStylesView } from '@nexus/factory-domain/product/commerce-import/source'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * The Commerce import's two reads (B-W2b-209; apps/factory-api modules/product/commerce-import). The export file itself
 * goes through the imports routes (admin/import/api: uploadSheet with importer `product.commerceStyles`).
 */

const info = z.object({ commerceImport: commerceImportView })

/** Where a style can start from: the export file (on) and the live read of Commerce (OFF, with its reason). */
export function readCommerceImport(api: ApiClient): Promise<CommerceImportView> {
  return api.get('/product/commerce-import', { schema: info }).then((answer) => answer.commerceImport)
}

/** The styles an import job of Commerce families started or added to (each as far as the person may see it). */
export function readStartedStyles(api: ApiClient, jobId: string): Promise<StartedStylesView> {
  return api.get(`/product/commerce-import/jobs/${encodeURIComponent(jobId)}`, { schema: startedStylesView })
}
