import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  archiveTemplateContract,
  createTemplateContract,
  fromQuoteContract,
  getTemplateContract,
  listTemplatesContract,
  replaceLinesContract,
  restoreTemplateContract,
  startQuoteContract,
  updateTemplateContract,
} from './contract'
import { manifest } from './manifest'
import { startFromTemplate } from './start'
import { createTemplate, getTemplate, listTemplates, replaceLines, setTemplateStatus, templateFromQuote, updateTemplate } from './templates'

/**
 * Quote templates (B-W2b-294; SAL-144 quote templates, SAL-252 per company or every company): the saved starts of quotes under
 * Sales settings › Quote templates, and a new quote started from one (New quote › Start from: Template).
 */
export default defineRoutes('sales.quoteTemplates', manifest, async (app) => {
  app.get('/sales/quote-templates', { schema: listTemplatesContract }, async (request) => listTemplates(request, request.query))

  app.get('/sales/quote-templates/:templateId', { schema: getTemplateContract }, async (request) => getTemplate(request, request.params.templateId))

  app.post('/sales/quote-templates', { schema: createTemplateContract }, async (request, reply) => reply.code(201).send(await createTemplate(request, request.body, idempotencyKeyFrom(request))))

  app.post('/sales/quote-templates/from-quote', { schema: fromQuoteContract }, async (request, reply) => reply.code(201).send(await templateFromQuote(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/sales/quote-templates/:templateId', { schema: updateTemplateContract }, async (request) => updateTemplate(request, request.params.templateId, request.body, idempotencyKeyFrom(request)))

  app.put('/sales/quote-templates/:templateId/lines', { schema: replaceLinesContract }, async (request) => replaceLines(request, request.params.templateId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/quote-templates/:templateId/archive', { schema: archiveTemplateContract }, async (request) => setTemplateStatus(request, request.params.templateId, 'ARCHIVED', request.body, idempotencyKeyFrom(request)))

  app.post('/sales/quote-templates/:templateId/restore', { schema: restoreTemplateContract }, async (request) => setTemplateStatus(request, request.params.templateId, 'ACTIVE', request.body, idempotencyKeyFrom(request)))

  app.post('/sales/quote-templates/:templateId/quote', { schema: startQuoteContract }, async (request, reply) => reply.code(201).send(await startFromTemplate(request, request.params.templateId, request.body, idempotencyKeyFrom(request))))
})
