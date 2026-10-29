import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { attachmentDisposition } from '../../../platform/files/rules'
import { assignLabel } from './assign'
import {
  activateTemplateContract,
  assignLabelContract,
  createTemplateContract,
  getTemplateContract,
  listTemplatesContract,
  previewContract,
  previewPdfContract,
  retireTemplateContract,
  reviseTemplateContract,
  testPrintContract,
  updateTemplateContract,
} from './contract'
import { manifest } from './manifest'
import { previewLabel, previewPdf, testPrint } from './preview'
import { activateTemplate, createTemplate, getTemplate, listTemplates, retireTemplate, reviseTemplate, updateTemplate } from './templates'

/**
 * The PPE garment label builder (B-W1-19; PRD-331; Reg. (EU) 2016/425 art. 8(5)(6), art. 10(3), art. 17; Reg. (EU)
 * 1007/2011 arts. 9, 12, 16; EN 17092 / EN ISO 13688 marking; ISO 3758): label templates typed once (maker, composition,
 * animal-origin phrase, care symbols, layout) as drafts, activated when their rule checks pass and frozen from then on
 * (a change is a new revision), retired; a draft style revision names its label; a label previewed for a style,
 * colourway and size with the source of every value, as JSON with its ZPL, as a PDF, or printed as a test label.
 */
export default defineRoutes('compliance.labels', manifest, async (app) => {
  app.get('/compliance/labels', { schema: listTemplatesContract }, async (request) => listTemplates(request, request.query))

  app.get('/compliance/labels/:templateId', { schema: getTemplateContract }, async (request) => ({ template: await getTemplate(request, request.params.templateId) }))

  app.get('/compliance/labels/:templateId/preview', { schema: previewContract }, async (request) => previewLabel(request, request.params.templateId, request.query))

  app.get('/compliance/labels/:templateId/preview/pdf', { schema: previewPdfContract }, async (request, reply) => {
    const { pdf, fileName } = await previewPdf(request, request.params.templateId, request.query)
    return reply.type('application/pdf').header('content-disposition', attachmentDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.post('/compliance/labels', { schema: createTemplateContract }, async (request, reply) => {
    return reply.code(201).send({ template: await createTemplate(request, request.body, idempotencyKeyFrom(request)) })
  })

  app.patch('/compliance/labels/:templateId', { schema: updateTemplateContract }, async (request) => ({
    template: await updateTemplate(request, request.params.templateId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/compliance/labels/:templateId/activate', { schema: activateTemplateContract }, async (request) => ({
    template: await activateTemplate(request, request.params.templateId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/compliance/labels/:templateId/retire', { schema: retireTemplateContract }, async (request) => ({
    template: await retireTemplate(request, request.params.templateId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/compliance/labels/:templateId/revisions', { schema: reviseTemplateContract }, async (request, reply) => {
    return reply.code(201).send({ template: await reviseTemplate(request, request.params.templateId, idempotencyKeyFrom(request)) })
  })

  app.post('/compliance/labels/:templateId/test-print', { schema: testPrintContract }, async (request, reply) => {
    return reply.code(201).send(await testPrint(request, request.params.templateId, request.body, idempotencyKeyFrom(request)))
  })

  app.put('/product/styles/:styleId/revisions/:revisionId/label', { schema: assignLabelContract }, async (request) =>
    assignLabel(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)),
  )
})
