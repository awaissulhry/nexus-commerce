import { kindProfiles } from '@nexus/factory-domain/inventory/locations-depth/kinds'
import { idempotencyKeyFrom } from '../../../core/command'
import { LABELS_REFUSED_HEADER } from '../../../core/cors-expose'
import { defineRoutes } from '../../../core/manifest'
import { attachmentDisposition } from '../../../platform/files/rules'
import { blockedLocations, blockLocation, unblockLocation } from './blocks'
import {
  blockContract,
  blockedContract,
  defaultsContract,
  kindsContract,
  labelCodeContract,
  labelContract,
  labelsPdfContract,
  printLabelsContract,
  resolveDefaultContract,
  scanContract,
  setDefaultContract,
  unblockContract,
} from './contract'
import { listDefaults, resolveDefaultPlace, setDefault } from './defaults'
import { labelsPdf, locationLabel, printLabels, scanLocation, setLabelCode } from './labels'
import { manifest } from './manifest'

/**
 * Locations in depth (B-W2b-289; SCM-177 types, SCM-178 bin labels, SCM-179 default locations, SCM-181 blocks), beside
 * W1's locations (modules/inventory/locations: the tree, create, rename, move, archive, the import). Each file says its
 * rules: blocks.ts, labels.ts (+ platform/print/layouts/bin.ts), defaults.ts; the kinds are factory-domain's.
 */
export default defineRoutes('inventory.locations-depth', manifest, async (app) => {
  app.get('/inventory/locations/kinds', { schema: kindsContract }, async () => ({ kinds: kindProfiles().map((profile) => ({ ...profile, party: profile.party ? [...profile.party] : null, purposes: [...profile.purposes] })) }))

  app.get('/inventory/locations/blocked', { schema: blockedContract }, async (request) => blockedLocations(request, request.query))

  app.post('/inventory/locations/:locationId/block', { schema: blockContract }, async (request) => ({
    location: await blockLocation(request, request.params.locationId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/inventory/locations/:locationId/unblock', { schema: unblockContract }, async (request) => ({
    location: await unblockLocation(request, request.params.locationId, request.body, idempotencyKeyFrom(request)),
  }))

  app.put('/inventory/locations/:locationId/label-code', { schema: labelCodeContract }, async (request) => setLabelCode(request, request.params.locationId, request.body, idempotencyKeyFrom(request)))

  app.get('/inventory/locations/:locationId/label', { schema: labelContract }, async (request) => locationLabel(request, request.params.locationId, request.query))

  app.post('/inventory/locations/labels/print', { schema: printLabelsContract }, async (request, reply) => reply.code(201).send(await printLabels(request, request.body, idempotencyKeyFrom(request))))

  app.post('/inventory/locations/labels/pdf', { schema: labelsPdfContract }, async (request, reply) => {
    const { pdf, fileName, refused } = await labelsPdf(request, request.body, idempotencyKeyFrom(request))
    return reply.type('application/pdf').header('content-disposition', attachmentDisposition(fileName)).header('cache-control', 'no-store').header(LABELS_REFUSED_HEADER, String(refused)).send(pdf)
  })

  app.get('/inventory/locations/scan', { schema: scanContract }, async (request) => scanLocation(request, request.query))

  app.get('/inventory/locations/defaults', { schema: defaultsContract }, async (request) => listDefaults(request, request.query))

  app.put('/inventory/locations/defaults', { schema: setDefaultContract }, async (request) => setDefault(request, request.body, idempotencyKeyFrom(request)))

  app.get('/inventory/locations/defaults/resolve', { schema: resolveDefaultContract }, async (request) => resolveDefaultPlace(request, request.query))
})
