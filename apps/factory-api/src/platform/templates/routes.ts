import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { serverClock } from '../../core/time'
import { attachmentDisposition } from '../files/rules'
import {
  contactLanguagesContract,
  createDocumentTemplateContract,
  createEmailTemplateContract,
  createReplyContract,
  deleteDocumentTemplateContract,
  deleteEmailTemplateContract,
  deleteReplyContract,
  documentKindsContract,
  fillReplyContract,
  getDocumentTemplateContract,
  getEmailTemplateContract,
  listDocumentTemplatesContract,
  listEmailTemplatesContract,
  listRepliesContract,
  mailEventsContract,
  previewDocumentTemplateContract,
  previewEmailTemplateContract,
  publishDocumentTemplateContract,
  publishEmailTemplateContract,
  recipientLanguageContract,
  retireDocumentTemplateContract,
  retireEmailTemplateContract,
  updateDocumentTemplateContract,
  updateEmailTemplateContract,
  updateReplyContract,
} from './contract'
import {
  createDocumentTemplate,
  deleteDocumentTemplate,
  documentKinds,
  getDocumentTemplate,
  listDocumentTemplates,
  previewDocumentTemplate,
  publishDocumentTemplate,
  retireDocumentTemplate,
  updateDocumentTemplate,
} from './documents'
import { contactLanguages, recipientLanguage } from './language'
import { createEmailTemplate, deleteEmailTemplate, getEmailTemplate, listEmailTemplates, mailEvents, previewEmailTemplate, publishEmailTemplate, retireEmailTemplate, updateEmailTemplate } from './mail'
import { manifest } from './manifest'
import { officeOf } from './store'
import { createReply, deleteReply, fillReply, listReplies, updateReply } from './replies'

/**
 * Templates (B-W2b-422; PLT-131, PLT-231, PLT-232, COL-016): document templates per company, kind and language with their
 * preview, e-mail templates per event and language, saved replies, and the partner contact's language. See documents.ts,
 * mail.ts, replies.ts and language.ts; the code that prints and mails reads the versions in use through active.ts.
 */
export default defineRoutes('templates', manifest, async (app) => {
  app.get('/templates/documents', { schema: listDocumentTemplatesContract }, async (request) => listDocumentTemplates(request, request.query))
  app.get('/templates/documents/kinds', { schema: documentKindsContract }, async (request) => {
    officeOf(request)
    return documentKinds()
  })
  app.get('/templates/documents/:templateId', { schema: getDocumentTemplateContract }, async (request) => getDocumentTemplate(request, request.params.templateId))
  app.get('/templates/documents/:templateId/preview', { schema: previewDocumentTemplateContract }, async (request, reply) => {
    const { pdf, fileName } = await previewDocumentTemplate(request, request.params.templateId, serverClock)
    return reply.type('application/pdf').header('content-disposition', attachmentDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
  app.post('/templates/documents', { schema: createDocumentTemplateContract }, async (request, reply) => reply.code(201).send(await createDocumentTemplate(request, request.body, idempotencyKeyFrom(request))))
  app.put('/templates/documents/:templateId', { schema: updateDocumentTemplateContract }, async (request) => updateDocumentTemplate(request, request.params.templateId, request.body, idempotencyKeyFrom(request)))
  app.post('/templates/documents/:templateId/publish', { schema: publishDocumentTemplateContract }, async (request) => publishDocumentTemplate(request, request.params.templateId, request.body, idempotencyKeyFrom(request)))
  app.post('/templates/documents/:templateId/retire', { schema: retireDocumentTemplateContract }, async (request) => retireDocumentTemplate(request, request.params.templateId, request.body, idempotencyKeyFrom(request)))
  app.delete('/templates/documents/:templateId', { schema: deleteDocumentTemplateContract }, async (request) => deleteDocumentTemplate(request, request.params.templateId, request.query.version, idempotencyKeyFrom(request)))

  app.get('/templates/mail/events', { schema: mailEventsContract }, async (request) => {
    officeOf(request)
    return mailEvents()
  })
  app.get('/templates/mail', { schema: listEmailTemplatesContract }, async (request) => listEmailTemplates(request, request.query))
  app.get('/templates/mail/:templateId', { schema: getEmailTemplateContract }, async (request) => getEmailTemplate(request, request.params.templateId))
  app.post('/templates/mail/:templateId/preview', { schema: previewEmailTemplateContract }, async (request) => previewEmailTemplate(request, request.params.templateId, request.body))
  app.post('/templates/mail', { schema: createEmailTemplateContract }, async (request, reply) => reply.code(201).send(await createEmailTemplate(request, request.body, idempotencyKeyFrom(request))))
  app.put('/templates/mail/:templateId', { schema: updateEmailTemplateContract }, async (request) => updateEmailTemplate(request, request.params.templateId, request.body, idempotencyKeyFrom(request)))
  app.post('/templates/mail/:templateId/publish', { schema: publishEmailTemplateContract }, async (request) => publishEmailTemplate(request, request.params.templateId, request.body, idempotencyKeyFrom(request)))
  app.post('/templates/mail/:templateId/retire', { schema: retireEmailTemplateContract }, async (request) => retireEmailTemplate(request, request.params.templateId, request.body, idempotencyKeyFrom(request)))
  app.delete('/templates/mail/:templateId', { schema: deleteEmailTemplateContract }, async (request) => deleteEmailTemplate(request, request.params.templateId, request.query.version, idempotencyKeyFrom(request)))

  app.get('/templates/replies', { schema: listRepliesContract }, async (request) => listReplies(request, request.query))
  app.post('/templates/replies', { schema: createReplyContract }, async (request, reply) => reply.code(201).send(await createReply(request, request.body, idempotencyKeyFrom(request))))
  app.put('/templates/replies/:replyId', { schema: updateReplyContract }, async (request) => updateReply(request, request.params.replyId, request.body, idempotencyKeyFrom(request)))
  app.delete('/templates/replies/:replyId', { schema: deleteReplyContract }, async (request) => deleteReply(request, request.params.replyId, request.query.version, idempotencyKeyFrom(request)))
  app.post('/templates/replies/:replyId/fill', { schema: fillReplyContract }, async (request) => fillReply(request, request.params.replyId, request.body))

  app.get('/templates/language', { schema: recipientLanguageContract }, async (request) => recipientLanguage(request, request.query))
  app.get('/templates/languages/contacts', { schema: contactLanguagesContract }, async (request) => contactLanguages(request, request.query))
})
