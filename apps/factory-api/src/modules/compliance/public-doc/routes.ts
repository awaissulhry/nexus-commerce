import { defineRoutes } from '../../../core/manifest'
import { addressContract, fileContract, lookupContract, pictureContract } from './contract'
import { manifest } from './manifest'
import { dispositionOf } from '@nexus/factory-domain/files/preview/rules'
import { lookupPublicDoc, officeAddress, pagesUnder, publicDocFile } from './public-doc'
// B-W2b-236 (SY3:03): the page's picture, the stripped copy of the style's main picture.
import { publicDocPicture } from './picture'

/**
 * The public DoC (B-W2b-166; public-doc.ts): the page's lookup by code, its PDFs, and the office's address of a style or a
 * batch. The lookup counts in the abuse guard (per network; a challenge after many lookups or misses); the PDFs are
 * rate-limited per address and answer only the files the code's page lists.
 */

/** Lookups a minute per address on top of the abuse guard (a page is one lookup; typing codes is a few). */
const LOOKUP_RATE = { max: 30, timeWindow: 60_000 } as const
/** PDFs a minute per address (a page reads one or two; a language or an older version one more each). */
const FILE_RATE = { max: 40, timeWindow: 60_000 } as const
/** A PDF answer may be kept a short while: the file never changes, the page's choice of files may. */
const FILE_CACHE = 'public, max-age=300'

export default defineRoutes('compliance.public-doc', manifest, async (app) => {
  app.post('/public/doc/lookup', { schema: lookupContract, config: { rateLimit: LOOKUP_RATE } }, async (request, reply) => lookupPublicDoc(app, request, reply, request.body))

  app.get('/public/doc/:code/files/:fileId', { schema: fileContract, config: { rateLimit: FILE_RATE } }, async (request, reply) => {
    const file = await publicDocFile(app, request, request.params.code, request.params.fileId)
    return reply
      .type('application/pdf')
      .header('cache-control', FILE_CACHE)
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', dispositionOf(request.query.download === '1' ? 'download' : 'inline', file.name))
      .send(file.bytes)
  })

  // B-W2b-236 (SY3:03): only the picture the code's page names, as its stripped copy (no camera or location data).
  app.get('/public/doc/:code/picture/:fileId', { schema: pictureContract, config: { rateLimit: FILE_RATE } }, async (request, reply) => {
    const picture = await publicDocPicture(app, request, request.params.code, request.params.fileId, pagesUnder)
    return reply.type(picture.contentType).header('cache-control', FILE_CACHE).header('x-content-type-options', 'nosniff').header('content-disposition', 'inline').send(picture.bytes)
  })

  app.get('/compliance/public-doc/address', { schema: addressContract }, async (request) => officeAddress(request, request.query))
})
