import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import {
  getBookingContract,
  getInsuranceRuleContract,
  listCarrierServicesContract,
  setCarrierServicesContract,
  setInsuranceRuleContract,
  setParcelValueContract,
  setServicesContract,
  valuesByRuleContract,
} from './contract'
import { manifest } from './manifest'
import { listCarrierServices, setCarrierServices } from './plan'
import { getBooking, setServices } from './services'
import { getInsuranceRule, setInsuranceRule, setParcelValue, valuesByRule } from './values'

/**
 * Carrier services (B-W2b-400; LOG-041 express and international with duties and paperless trade, LOG-042 insurance and
 * declared value per parcel by the site's rule, shown in the booking; Owner answer Q20: a service not chosen for live use stays
 * on the fake). The label buy checks the same booking (modules/shipping/labels).
 */
export default defineRoutes('shipping.services', manifest, async (app) => {
  app.get('/shipping/shipments/:shipmentId/booking', { schema: getBookingContract }, async (request) => getBooking(request, request.params.shipmentId))

  app.put('/shipping/shipments/:shipmentId/services', { schema: setServicesContract }, async (request) => setServices(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.put('/shipping/shipments/:shipmentId/parcels/:parcelId/value', { schema: setParcelValueContract }, async (request) =>
    setParcelValue(request, request.params.shipmentId, request.params.parcelId, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/shipping/shipments/:shipmentId/parcel-values/by-rule', { schema: valuesByRuleContract }, async (request) => valuesByRule(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.get('/shipping/sites/:siteId/insurance', { schema: getInsuranceRuleContract }, async (request) => getInsuranceRule(request, request.params.siteId))

  app.put('/shipping/sites/:siteId/insurance', { schema: setInsuranceRuleContract }, async (request) => setInsuranceRule(request, request.params.siteId, request.body, idempotencyKeyFrom(request)))

  app.get('/shipping/carrier-services', { schema: listCarrierServicesContract }, async (request) => listCarrierServices(request, request.query))

  app.put('/shipping/carrier-services/:accountId', { schema: setCarrierServicesContract }, async (request) =>
    setCarrierServices(request, request.params.accountId, request.body, () => requireStepUp(officeAuthOf(app), request), idempotencyKeyFrom(request)),
  )
})
