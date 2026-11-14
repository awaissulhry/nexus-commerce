import { defineManifest } from '../../../core/manifest'

/**
 * One made-to-measure unit's cost (B-W2b-423; FIN-017). Office only: the floor, partner and link sessions never see a cost
 * (A1 §2.6). costing.view over the style's company (a tenant-wide style: the company asked for), checked in the handler
 * (`record`), plus what B-W2b-248's check asks (product.styles.view; sales.measurements.view over a profile's customer;
 * product.bom.view for the scaled lines). A read sent as POST: the measures travel in the body, never in a URL.
 */
export const manifest = defineManifest({
  'POST /costing/made-to-measure/cost': { audiences: ['office'], permission: 'costing.view', scope: 'record' },
})
