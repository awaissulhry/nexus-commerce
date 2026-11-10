import { dispositionOf } from '@nexus/factory-domain/files/preview/rules'
import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createColour, setColourStatus, updateColour } from './colours'
import { colourStatusContract, countsContract, createColourContract, libraryPictureContract, listLibraryContract, updateColourContract } from './contract'
import { libraryCounts, listLibrary } from './library'
import { manifest } from './manifest'
import { libraryPictureBytes } from './pictures'

/**
 * Products › Colours & artwork, the colour library (product module, B-W2b-247; PRD-041; design products.colours
 * sec:colours.grid, sec:colours.tiles, sec:colours.notices): one list of the company's colours for leather, textile and
 * thread — code, names, Pantone / RAL / NCS reference, family, hex, photo — each with what names it (material colours,
 * colourways, branding sets). The brands' branding sets are ../branding-sets. W1's GET /product/colours (the colourway
 * picker) is ../styles/colours.ts.
 */
export default defineRoutes('product.colours', manifest, async (app) => {
  app.get('/product/colours/library', { schema: listLibraryContract }, async (request) => listLibrary(request, request.query))
  app.get('/product/colours/counts', { schema: countsContract }, async (request) => libraryCounts(request, request.query))
  app.post('/product/colours', { schema: createColourContract }, async (request, reply) => reply.code(201).send({ colour: await createColour(request, request.body, idempotencyKeyFrom(request)) }))
  app.patch('/product/colours/:colourId', { schema: updateColourContract }, async (request) => ({ colour: await updateColour(request, request.params.colourId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/colours/:colourId/archive', { schema: colourStatusContract }, async (request) => ({
    colour: await setColourStatus(request, request.params.colourId, 'ARCHIVED', request.body, idempotencyKeyFrom(request)),
  }))
  app.post('/product/colours/:colourId/restore', { schema: colourStatusContract }, async (request) => ({
    colour: await setColourStatus(request, request.params.colourId, 'ACTIVE', request.body, idempotencyKeyFrom(request)),
  }))
  app.get('/product/colours/pictures/:fileId', { schema: libraryPictureContract }, async (request, reply) => {
    const picture = await libraryPictureBytes(request, request.params.fileId)
    // A stored file never changes (a new photo is a new file): the browser keeps it.
    return reply.type(picture.contentType).header('cache-control', 'private, max-age=31536000, immutable').header('x-content-type-options', 'nosniff').header('content-disposition', dispositionOf('inline', picture.name)).send(picture.bytes)
  })
})
