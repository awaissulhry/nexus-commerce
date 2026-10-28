import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { LocalFileError, type LocalFileStore } from '../../adapters/local-files/local'
import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import {
  completeUploadContract,
  deleteFileContract,
  downloadContract,
  getFileContract,
  listFilesContract,
  localDownloadContract,
  localUploadContract,
  requestUploadContract,
  setRetentionContract,
  setVisibilityContract,
} from './contract'
import { completeUpload, deleteFile, downloadFile, getFile, listFiles, requestUpload, setRetention, setVisibility, systemCallerOf } from './files'
import { manifest } from './manifest'
import { MAX_FILE_BYTES } from './rules'
import { processFiles } from './service'

/**
 * Files on R2 (platform part; plan A1 §3.6, features COL-045, COL-050): announce an upload, confirm it, list a record's
 * files, read one, get its download, share it, set its retention and legal hold, delete it. The file bytes never pass
 * through these routes, except on the local store's own two (`/local-files?token=…`, FAKE accounts in local and test
 * runs), which stand in for R2's presigned URLs.
 */

/** The local store, or 404: outside local and test runs these routes do not exist for anyone. */
function localStore(): LocalFileStore {
  const local = processFiles().local
  if (!local) throw new NotFoundError()
  return local
}

/** A refusal of the local store as the API's error. */
async function local<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (!(error instanceof LocalFileError)) throw error
    if (error.status === 400) throw new ValidationError(error.message)
    if (error.status === 403) throw new ForbiddenError(error.message)
    throw new NotFoundError(error.message)
  }
}

export default defineRoutes('files', manifest, async (app) => {
  app.post('/files', { schema: requestUploadContract }, async (request, reply) => {
    return reply.code(201).send(await requestUpload(processFiles(), request, request.body, idempotencyKeyFrom(request)))
  })

  app.post('/files/:fileId/complete', { schema: completeUploadContract }, async (request) => {
    return { file: await completeUpload(processFiles(), request, request.params.fileId, idempotencyKeyFrom(request)) }
  })

  app.get('/files', { schema: listFilesContract }, async (request) => {
    return { files: await listFiles(request, request.query) }
  })

  app.get('/files/:fileId', { schema: getFileContract }, async (request) => {
    return { file: await getFile(request, request.params.fileId) }
  })

  app.get('/files/:fileId/download', { schema: downloadContract }, async (request) => {
    return { download: await downloadFile(processFiles(), { caller: request, system: systemCallerOf(request) }, request.params.fileId) }
  })

  app.put('/files/:fileId/visibility', { schema: setVisibilityContract }, async (request) => {
    return { file: await setVisibility(request, request.params.fileId, request.body, idempotencyKeyFrom(request)) }
  })

  app.put('/files/:fileId/retention', { schema: setRetentionContract }, async (request) => {
    return { file: await setRetention(processFiles(), request, request.params.fileId, request.body, idempotencyKeyFrom(request)) }
  })

  app.delete('/files/:fileId', { schema: deleteFileContract }, async (request) => {
    return { file: await deleteFile(processFiles(), request, request.params.fileId, request.query, idempotencyKeyFrom(request)) }
  })

  // The local store's presigned requests: raw bytes of any type, up to the largest file, in this scope only.
  await app.register(async (instance) => {
    const routes = instance.withTypeProvider<ZodTypeProvider>()
    routes.removeAllContentTypeParsers()
    routes.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_FILE_BYTES }, (_request, body, done) => done(null, body))

    routes.put('/local-files', { schema: localUploadContract, bodyLimit: MAX_FILE_BYTES }, async (request) => {
      const store = localStore()
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0)
      const contentType = typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : undefined
      await local(() => store.acceptUpload(request.query.token, { body, contentType }, processFiles().clock.now()))
      return { status: 'stored' as const }
    })

    routes.get('/local-files', { schema: localDownloadContract }, async (request, reply) => {
      const store = localStore()
      const object = await local(() => store.openDownload(request.query.token, processFiles().clock.now()))
      return reply.type(object.contentType).header('content-disposition', object.disposition).send(object.body)
    })
  })
})
