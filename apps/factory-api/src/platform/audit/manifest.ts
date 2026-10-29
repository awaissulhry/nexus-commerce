import { defineManifest } from '../../core/manifest'

/** The audit log's routes (plan A1 §3.2 step 2). Reading a record's history needs audit.read; its rows are scoped. */
export const manifest = defineManifest({
  'GET /audit': { audiences: ['office'], permission: 'audit.read', scope: 'record' },
  'GET /audit/:recordType/:recordId': { audiences: ['office'], permission: 'audit.read', scope: 'record' },
})
