import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  addPatternFileBody,
  addPictureBody,
  downloadView,
  galleryLooksBody,
  galleryLooksView,
  orderPicturesBody,
  patternDownloadQuery,
  patternFilesView,
  patternFileVersionBody,
  pictureVersionBody,
  pictureVersionQuery,
  removePatternFilesBody,
  stylePicturesView,
  updatePatternFileBody,
  updatePictureBody,
} from '@nexus/factory-domain/product/images/contracts'

/** The pictures' and pattern files' routes' contracts: the bodies and answers are factory-domain's product/images/contracts. No money. */

const style = input({ styleId: id() })
const picture = input({ styleId: id(), pictureId: id() })
const revision = input({ styleId: id(), revisionId: id() })
const patternFile = input({ styleId: id(), revisionId: id(), patternFileId: id() })
const pictures = { 200: output({ pictures: stylePicturesView }) }
const patterns = { 200: output({ patternFiles: patternFilesView }) }

export const getPicturesContract = defineContract({ params: style, response: pictures })
export const addPictureContract = defineContract({ params: style, body: addPictureBody, response: { 201: output({ pictures: stylePicturesView }) } })
export const updatePictureContract = defineContract({ params: picture, body: updatePictureBody, response: pictures })
export const mainPictureContract = defineContract({ params: picture, body: pictureVersionBody, response: pictures })
export const orderPicturesContract = defineContract({ params: style, body: orderPicturesBody, response: pictures })
export const removePictureContract = defineContract({ params: picture, querystring: pictureVersionQuery, response: pictures })
export const galleryLooksContract = defineContract({ body: galleryLooksBody, response: { 200: galleryLooksView } })
/** A picture's bytes (its own type), inline. */
export const pictureBytesContract = defineContract({ params: input({ fileId: id() }), response: {} })

export const getPatternFilesContract = defineContract({ params: revision, response: patterns })
export const addPatternFileContract = defineContract({ params: revision, body: addPatternFileBody, response: { 201: output({ patternFiles: patternFilesView }) } })
export const updatePatternFileContract = defineContract({ params: patternFile, body: updatePatternFileBody, response: patterns })
export const patternFileVersionContract = defineContract({ params: patternFile, body: patternFileVersionBody, response: patterns })
export const removePatternFilesContract = defineContract({ params: revision, body: removePatternFilesBody, response: patterns })
export const patternDownloadContract = defineContract({ params: patternFile, querystring: patternDownloadQuery, response: { 200: downloadView } })

