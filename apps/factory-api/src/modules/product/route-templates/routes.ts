import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createTemplateContract, listTemplatesContract, moveTemplateContract, updateTemplateContract } from './contract'
import { manifest } from './manifest'
import { createTemplate, listTemplates, moveTemplate, updateTemplate } from './templates'

/** owb-pd2 2.3 (S4 products): the factory's ready-made routes — listed, saved, changed, closed and opened again (./templates.ts). */
export default defineRoutes('product.route-templates', manifest, async (app) => {
  app.get('/product/route-templates', { schema: listTemplatesContract }, async (request) => ({ templates: await listTemplates(request, request.query.status) }))

  app.post('/product/route-templates', { schema: createTemplateContract }, async (request, reply) =>
    reply.code(201).send({ template: await createTemplate(request, request.body, idempotencyKeyFrom(request)) }),
  )

  app.patch('/product/route-templates/:templateId', { schema: updateTemplateContract }, async (request) => ({
    template: await updateTemplate(request, request.params.templateId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/route-templates/:templateId/close', { schema: moveTemplateContract }, async (request) => ({
    template: await moveTemplate(request, request.params.templateId, 'CLOSED', request.body.version, idempotencyKeyFrom(request)),
  }))

  app.post('/product/route-templates/:templateId/open', { schema: moveTemplateContract }, async (request) => ({
    template: await moveTemplate(request, request.params.templateId, 'OPEN', request.body.version, idempotencyKeyFrom(request)),
  }))
})
