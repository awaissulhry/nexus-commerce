import { defineManifest } from '../../core/manifest'

/**
 * Templates (B-W2b-422; PLT-131, PLT-231, PLT-232, COL-016). Office only; every route is scoped by record: the handlers check
 * the company (or the party) with can() — documents.view to read a template, documents.templates.manage to write one (over
 * every company for every company's e-mail templates); email.send for a person's own saved replies and to use the shared
 * ones, email.replies.share to keep the shared ones; parties.view for a partner contact's language.
 */
export const manifest = defineManifest({
  'GET /templates/documents': { audiences: ['office'], permission: 'documents.view', scope: 'record' },
  'GET /templates/documents/kinds': { audiences: ['office'], permission: 'documents.view', scope: 'record' },
  'GET /templates/documents/:templateId': { audiences: ['office'], permission: 'documents.view', scope: 'record' },
  'GET /templates/documents/:templateId/preview': { audiences: ['office'], permission: 'documents.view', scope: 'record' },
  'POST /templates/documents': { audiences: ['office'], permission: 'documents.templates.manage', scope: 'record' },
  'PUT /templates/documents/:templateId': { audiences: ['office'], permission: 'documents.templates.manage', scope: 'record' },
  'POST /templates/documents/:templateId/publish': { audiences: ['office'], permission: 'documents.templates.manage', scope: 'record' },
  'POST /templates/documents/:templateId/retire': { audiences: ['office'], permission: 'documents.templates.manage', scope: 'record' },
  'DELETE /templates/documents/:templateId': { audiences: ['office'], permission: 'documents.templates.manage', scope: 'record' },

  'GET /templates/mail/events': { audiences: ['office'], permission: 'documents.view', scope: 'record' },
  'GET /templates/mail': { audiences: ['office'], permission: 'documents.view', scope: 'record' },
  'GET /templates/mail/:templateId': { audiences: ['office'], permission: 'documents.view', scope: 'record' },
  'POST /templates/mail/:templateId/preview': { audiences: ['office'], permission: 'documents.view', scope: 'record' },
  'POST /templates/mail': { audiences: ['office'], permission: 'documents.templates.manage', scope: 'record' },
  'PUT /templates/mail/:templateId': { audiences: ['office'], permission: 'documents.templates.manage', scope: 'record' },
  'POST /templates/mail/:templateId/publish': { audiences: ['office'], permission: 'documents.templates.manage', scope: 'record' },
  'POST /templates/mail/:templateId/retire': { audiences: ['office'], permission: 'documents.templates.manage', scope: 'record' },
  'DELETE /templates/mail/:templateId': { audiences: ['office'], permission: 'documents.templates.manage', scope: 'record' },

  'GET /templates/replies': { audiences: ['office'], permission: 'email.send', scope: 'record' },
  'POST /templates/replies': { audiences: ['office'], permission: 'email.send', scope: 'record' },
  'PUT /templates/replies/:replyId': { audiences: ['office'], permission: 'email.send', scope: 'record' },
  'DELETE /templates/replies/:replyId': { audiences: ['office'], permission: 'email.send', scope: 'record' },
  'POST /templates/replies/:replyId/fill': { audiences: ['office'], permission: 'email.send', scope: 'record' },

  'GET /templates/language': { audiences: ['office'], permission: 'parties.view', scope: 'record' },
  'GET /templates/languages/contacts': { audiences: ['office'], permission: 'parties.view', scope: 'record' },
})
