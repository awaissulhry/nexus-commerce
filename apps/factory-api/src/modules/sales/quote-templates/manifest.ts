import { defineManifest } from '../../../core/manifest'

/**
 * Quote templates (B-W2b-294; SAL-144, SAL-252; design sales.settings ssettings.templates): office only. Reading needs quotes.view,
 * keeping one quotes.templates.manage, both checked with can() over the template's company inside (a template of every company:
 * a grant over every company to keep it); starting a quote from one is quotes.manage over the company and the customer.
 */
const view = { audiences: ['office'], permission: 'quotes.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'quotes.templates.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/quote-templates': view,
  'GET /sales/quote-templates/:templateId': view,
  'POST /sales/quote-templates': manage,
  'POST /sales/quote-templates/from-quote': manage,
  'PATCH /sales/quote-templates/:templateId': manage,
  'PUT /sales/quote-templates/:templateId/lines': manage,
  'POST /sales/quote-templates/:templateId/archive': manage,
  'POST /sales/quote-templates/:templateId/restore': manage,
  'POST /sales/quote-templates/:templateId/quote': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
})
