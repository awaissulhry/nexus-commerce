import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  changeDefaultContract,
  changeTemplateContract,
  changeTypeContract,
  createDefaultContract,
  createTemplateContract,
  createTypeContract,
  listDefaultsContract,
  listTemplatesContract,
  listTypesContract,
} from './contract'
import { manifest } from './manifest'
import { changeDefault, changeTemplate, changeType, createDefault, createTemplate, createType, listDefaults, listTemplates, listTypes } from './packaging'

/**
 * Packaging and carton marks (B-W2b-384; LOG-008, LOG-013): a company's carton, box, pallet, polybag and hanger types, its
 * default packaging per style or size run, and its carton shipping-mark templates per customer.
 */
export default defineRoutes('shipping.packaging', manifest, async (app) => {
  app.get('/shipping/packaging/types', { schema: listTypesContract }, async (request) => listTypes(request, request.query))
  app.post('/shipping/packaging/types', { schema: createTypeContract }, async (request, reply) => reply.code(201).send(await createType(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/shipping/packaging/types/:typeId', { schema: changeTypeContract }, async (request) => changeType(request, request.params.typeId, request.body, idempotencyKeyFrom(request)))

  app.get('/shipping/packaging/defaults', { schema: listDefaultsContract }, async (request) => listDefaults(request, request.query))
  app.post('/shipping/packaging/defaults', { schema: createDefaultContract }, async (request, reply) => reply.code(201).send(await createDefault(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/shipping/packaging/defaults/:defaultId', { schema: changeDefaultContract }, async (request) => changeDefault(request, request.params.defaultId, request.body, idempotencyKeyFrom(request)))

  app.get('/shipping/packaging/mark-templates', { schema: listTemplatesContract }, async (request) => listTemplates(request, request.query))
  app.post('/shipping/packaging/mark-templates', { schema: createTemplateContract }, async (request, reply) => reply.code(201).send(await createTemplate(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/shipping/packaging/mark-templates/:templateId', { schema: changeTemplateContract }, async (request) => changeTemplate(request, request.params.templateId, request.body, idempotencyKeyFrom(request)))
})
