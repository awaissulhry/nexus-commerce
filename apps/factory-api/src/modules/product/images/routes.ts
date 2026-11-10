import { idempotencyKeyFrom } from '../../../core/command'
import { dispositionOf } from '@nexus/factory-domain/files/preview/rules'
import { defineRoutes } from '../../../core/manifest'
import {
  addPatternFileContract,
  addPictureContract,
  galleryLooksContract,
  pictureBytesContract,
  getPatternFilesContract,
  getPicturesContract,
  mainPictureContract,
  orderPicturesContract,
  patternDownloadContract,
  patternFileVersionContract,
  removePatternFilesContract,
  removePictureContract,
  updatePatternFileContract,
  updatePictureContract,
} from './contract'
import { pictureBytes } from './bytes'
import { galleryLooks } from './gallery'
import { manifest } from './manifest'
import { addPatternFile, downloadPatternFile, getPatternFiles, removePatternFiles, setPatternFileVersion, updatePatternFile } from './patterns'
import { addPicture, getPictures, orderPictures, removePicture, setMainPicture, updatePicture } from './pictures'

/**
 * Sketches, the gallery and pattern files (product module, B-W2b-236; PRD-016, PRD-218; design products.styles
 * sec:styles.gallery, rec:Style › Overview › "Sketches and pictures", › Files & patterns › pattern files per revision and
 * size range): a style's sketches, photos and image pages with numbered callouts per style, revision and colourway, its one
 * main picture (the list's thumbnail, the gallery's card, the public DoC page's picture: modules/compliance/public-doc/
 * picture.ts), and a revision's pattern, marker and CAD files with their format, sizes and versions. The tech pack
 * (B-W2b-230) reads the same rows; a copy of a style copies its pictures (../styles/duplicate-pictures.ts).
 */
export default defineRoutes('product.images', manifest, async (app) => {
  app.get('/product/styles/:styleId/pictures', { schema: getPicturesContract }, async (request) => ({ pictures: await getPictures(request, request.params.styleId) }))
  app.post('/product/styles/:styleId/pictures', { schema: addPictureContract }, async (request, reply) =>
    reply.code(201).send({ pictures: await addPicture(request, request.params.styleId, request.body, idempotencyKeyFrom(request)) }),
  )
  app.patch('/product/styles/:styleId/pictures/:pictureId', { schema: updatePictureContract }, async (request) => ({
    pictures: await updatePicture(request, request.params.styleId, request.params.pictureId, request.body, idempotencyKeyFrom(request)),
  }))
  app.post('/product/styles/:styleId/pictures/:pictureId/main', { schema: mainPictureContract }, async (request) => ({
    pictures: await setMainPicture(request, request.params.styleId, request.params.pictureId, request.body.version, idempotencyKeyFrom(request)),
  }))
  app.put('/product/styles/:styleId/pictures/order', { schema: orderPicturesContract }, async (request) => ({ pictures: await orderPictures(request, request.params.styleId, request.body, idempotencyKeyFrom(request)) }))
  app.delete('/product/styles/:styleId/pictures/:pictureId', { schema: removePictureContract }, async (request) => ({
    pictures: await removePicture(request, request.params.styleId, request.params.pictureId, request.query.version, idempotencyKeyFrom(request)),
  }))
  app.post('/product/pictures/looks', { schema: galleryLooksContract }, async (request) => galleryLooks(request, request.body.styleIds))
  app.get('/product/pictures/:fileId', { schema: pictureBytesContract }, async (request, reply) => {
    const picture = await pictureBytes(request, request.params.fileId)
    // A stored file never changes (a new picture is a new file): the browser keeps it.
    return reply.type(picture.contentType).header('cache-control', 'private, max-age=31536000, immutable').header('x-content-type-options', 'nosniff').header('content-disposition', dispositionOf('inline', picture.name)).send(picture.bytes)
  })

  app.get('/product/styles/:styleId/revisions/:revisionId/pattern-files', { schema: getPatternFilesContract }, async (request) => ({
    patternFiles: await getPatternFiles(request, request.params.styleId, request.params.revisionId),
  }))
  app.post('/product/styles/:styleId/revisions/:revisionId/pattern-files', { schema: addPatternFileContract }, async (request, reply) =>
    reply.code(201).send({ patternFiles: await addPatternFile(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }),
  )
  app.patch('/product/styles/:styleId/revisions/:revisionId/pattern-files/:patternFileId', { schema: updatePatternFileContract }, async (request) => ({
    patternFiles: await updatePatternFile(request, request.params.styleId, request.params.revisionId, request.params.patternFileId, request.body, idempotencyKeyFrom(request)),
  }))
  app.put('/product/styles/:styleId/revisions/:revisionId/pattern-files/:patternFileId/file', { schema: patternFileVersionContract }, async (request) => ({
    patternFiles: await setPatternFileVersion(request, request.params.styleId, request.params.revisionId, request.params.patternFileId, request.body, idempotencyKeyFrom(request)),
  }))
  app.post('/product/styles/:styleId/revisions/:revisionId/pattern-files/remove', { schema: removePatternFilesContract }, async (request) => ({
    patternFiles: await removePatternFiles(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)),
  }))
  app.get('/product/styles/:styleId/revisions/:revisionId/pattern-files/:patternFileId/download', { schema: patternDownloadContract }, async (request) =>
    downloadPatternFile(request, request.params.styleId, request.params.revisionId, request.params.patternFileId, request.query.fileId),
  )
})
