import type { FastifyError, FastifyPluginAsync } from 'fastify'
import type {} from '@fastify/multipart'
import { shopifyFileIdSchema, shopifyFileQuerySchema, SHOPIFY_UPLOAD_MAX_BYTES } from '@nexus/shared/shopify-media'
import { mediaSources, listShopifyFiles, getShopifyFile, referenceShopifyFile, uploadShopifyFile, ShopifyMediaError } from '../services/shopify/media-library.service.js'
import { NoConnectionError } from '../services/connection-resolver.service.js'

const accountSchema = shopifyFileQuerySchema.pick({ accountId: true })
const fileSchema = accountSchema.extend({ id: shopifyFileIdSchema })

export const shopifyMediaRoutes: FastifyPluginAsync = async app => {
  // The global session, CSRF, workspace and assets.manage gates also cover these routes.
  app.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'private, no-store') })
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error instanceof ShopifyMediaError) return reply.code(error.statusCode).send({ error: error.message })
    if (error instanceof NoConnectionError) return reply.code(404).send({ error: 'This store is unavailable in the current business profile. Check Connections.' })
    if (error.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'The file exceeds the 200 MB upload limit.' })
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: error.message })
    request.log.error({ err: error }, 'Shopify media request failed')
    return reply.code(502).send({ error: request.method === 'GET'
      ? 'Shopify files could not be loaded. Check the store connection and retry.'
      : 'The result could not be confirmed. Refresh the Shopify library before retrying; your existing files are preserved.' })
  })
  app.get('/assets/media-sources', () => mediaSources())
  app.get('/assets/shopify/files', request => listShopifyFiles(request.query))
  app.get('/assets/shopify/file', request => {
    const parsed = fileSchema.safeParse(request.query)
    if (!parsed.success) throw new ShopifyMediaError('Choose a store and a valid Shopify file.', 400)
    return getShopifyFile(parsed.data.accountId, parsed.data.id)
  })
  app.post('/assets/shopify/reference', request => {
    const parsed = fileSchema.safeParse(request.body)
    if (!parsed.success) throw new ShopifyMediaError('Choose a store and a valid Shopify file.', 400)
    return referenceShopifyFile(parsed.data.accountId, parsed.data.id)
  })
  app.post('/assets/shopify/upload', async request => {
    const parsed = accountSchema.safeParse(request.query)
    if (!parsed.success) throw new ShopifyMediaError('Choose the destination Shopify store.', 400)
    const part = await request.file({ limits: { files: 1, fileSize: SHOPIFY_UPLOAD_MAX_BYTES } })
    if (!part) throw new ShopifyMediaError('Choose a file to upload.', 400)
    const buffer = await part.toBuffer()
    if (part.file.truncated) throw new ShopifyMediaError('The file exceeds the upload limit.', 413)
    return uploadShopifyFile(parsed.data.accountId, buffer, part.filename)
  })
}
