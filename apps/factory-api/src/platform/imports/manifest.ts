import { defineManifest } from '../../core/manifest'

/**
 * The import routes (plan A1 §3.2 step 2; W0-22). Office only. Every job belongs to a company (or the whole tenant), so
 * the handlers check each job with can() against it and filter lists with scopeWhere() (`record`); each importer also
 * needs its own permissions (its adapter's `permission` to run and apply, `viewPermission` to see its plans).
 */
export const manifest = defineManifest({
  'GET /imports/importers': { audiences: ['office'], permission: 'imports.view', scope: 'record' },
  'POST /imports': { audiences: ['office'], permission: 'imports.run', scope: 'record' },
  'GET /imports': { audiences: ['office'], permission: 'imports.view', scope: 'record' },
  'GET /imports/:importId': { audiences: ['office'], permission: 'imports.view', scope: 'record' },
  'GET /imports/:importId/rows': { audiences: ['office'], permission: 'imports.view', scope: 'record' },
  'GET /imports/:importId/errors': { audiences: ['office'], permission: 'imports.view', scope: 'record' },
  'POST /imports/:importId/apply': { audiences: ['office'], permission: 'imports.apply', scope: 'record' },
  'POST /imports/:importId/cancel': { audiences: ['office'], permission: 'imports.run', scope: 'record' },
  // B-W2a-41: templates (the importer's own permissions checked like GET /imports/importers) and the guided first load.
  'GET /imports/importers/:importerKey/template': { audiences: ['office'], permission: 'imports.view', scope: 'tenant' },
  'GET /imports/first-load': { audiences: ['office'], permission: 'imports.view', scope: 'record' },
  'POST /imports/first-load/:step/done': { audiences: ['office'], permission: 'imports.apply', scope: 'record' },
})
