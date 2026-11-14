import { defineManifest, SIGNED_IN } from '../../core/manifest'

/**
 * Custom fields and picklists (B-W2b-421; PLT-111, PLT-115). The editor (Admin › Fields & lists) reads with fields.view and
 * writes with fields.manage — over every company for a field or list of every company, over its company otherwise (the
 * handler asks it). A record's custom values are read and written with the RECORD's own permissions (orders.view,
 * orders.manage …, platform/fields/records.ts), which the handler asks over the record (scope `record`); a partner reads
 * the fields shown in the portal on its own records. Writes take an Idempotency-Key and the version read.
 */
export const manifest = defineManifest({
  'GET /fields/editor': { audiences: ['office'], permission: 'fields.view', scope: 'tenant' },
  'POST /fields': { audiences: ['office'], permission: 'fields.manage', scope: 'tenant' },
  'PATCH /fields/:fieldId': { audiences: ['office'], permission: 'fields.manage', scope: 'tenant' },
  'POST /fields/order': { audiences: ['office'], permission: 'fields.manage', scope: 'tenant' },
  'POST /fields/picklists': { audiences: ['office'], permission: 'fields.manage', scope: 'tenant' },
  'PATCH /fields/picklists/:picklistId': { audiences: ['office'], permission: 'fields.manage', scope: 'tenant' },
  'POST /fields/picklists/:picklistId/values': { audiences: ['office'], permission: 'fields.manage', scope: 'tenant' },
  'PATCH /fields/picklists/:picklistId/values/:valueId': { audiences: ['office'], permission: 'fields.manage', scope: 'tenant' },
  'POST /fields/picklists/:picklistId/order': { audiences: ['office'], permission: 'fields.manage', scope: 'tenant' },
  'GET /fields': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'GET /fields/values/:recordType/:recordId': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'PUT /fields/values/:recordType/:recordId': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'POST /fields/rows/:recordType': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'GET /fields/portal/:recordType/:recordId': { audiences: ['partner'], permission: SIGNED_IN, scope: 'party' },
})
