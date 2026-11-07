import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { PORTAL_CATALOGUE_VIEW, PORTAL_ORDER_REQUESTS_MANAGE } from '@nexus/factory-domain/sales/portal-ordering/permissions'
import { portalOrderLinesImporter } from '@nexus/factory-domain/sales/portal-ordering/upload'
import type { ImportAdapter } from '../../../platform/imports/registry'

/**
 * The order upload's entry in the imports registry (B-W2b-190, SAL-073; platform/imports IMPORTERS): the importer
 * `sales.portalOrderLines` (factory-domain sales/portal-ordering/upload) whose columns, header names and cell rules read
 * the customer's sheet. It is run by the portal, never as an office import job: its permissions are the customer's
 * (portal.orderRequests.manage, portal.catalogue.view: partner permissions no office role holds, so the office's import
 * screen never lists it), and `authorize` refuses a job in words should one be started. The portal's dry run
 * (./upload.ts) reads the sheet with the engine's own reader and parser and checks each row against the customer's
 * catalogue; nothing is written before the customer adds the ready rows to its draft.
 *
 * Imports only the registry's types (the registry lists this adapter: no load-order cycle).
 */
export const portalOrderLinesImportAdapter: ImportAdapter = Object.freeze({
  importer: portalOrderLinesImporter,
  permission: PORTAL_ORDER_REQUESTS_MANAGE,
  viewPermission: PORTAL_CATALOGUE_VIEW,
  authorize: () => [{ path: 'importerKey', message: 'Order sheets are uploaded by the customer in the portal, on its order request: there is no office import of them.' }],
  load: async () => [],
  write: async () => {
    throw new InvalidStateError('Order sheets are added to an order request in the customer portal.')
  },
})
